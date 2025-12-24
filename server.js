const express = require('express');
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState, Browsers } = require('@whiskeysockets/baileys');
const P = require('pino');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const QRCode = require('qrcode');
require('dotenv').config();

const app = express();
app.use(express.json());

const pino = P({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true }
  }
});

let sock;
let currentQR = null;
const AUTH_PATH = './auth_info_baileys';

// ========== HTML HELPER ==========
const getHtml = (content) => `
  <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>WhatsApp Bot Panel</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f0f2f5; display: flex; flex-direction: column; align-items: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
        .card { background: white; padding: 24px; border-radius: 12px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); text-align: center; max-width: 400px; width: 100%; margin-bottom: 20px; }
        h2 { margin-top: 0; color: #1f2937; margin-bottom: 10px; }
        img { border-radius: 8px; margin: 15px 0; max-width: 100%; }
        input { width: 100%; padding: 10px; margin: 15px 0; border: 1px solid #ddd; border-radius: 6px; box-sizing: border-box; font-size: 16px; }
        button { background: #25D366; color: white; border: none; padding: 12px 20px; border-radius: 6px; cursor: pointer; font-weight: bold; width: 100%; font-size: 16px; transition: background 0.2s; }
        button:hover { background: #128C7E; }
        button:disabled { background: #ccc; cursor: not-allowed; }
        #status { margin-top: 15px; font-size: 14px; min-height: 20px; word-break: break-word; }
        .success { color: green; font-weight: 500; }
        .error { color: #d32f2f; font-weight: 500; }
        .meta { font-size: 12px; color: #666; margin-top: 5px; }
      </style>
    </head>
    <body onload="checkReload()">
       ${content}
       
       <div class="card">
         <h2 style="font-size: 18px;">🛠️ Tester de Conexión</h2>
         <p style="font-size:13px; color:#666; margin-bottom: 15px;">Prueba la conexión con n8n enviando un mensaje simulado.</p>
         
         <input type="text" id="testMsg" placeholder="Escribe un mensaje de prueba..." value="Hola n8n, esto es un test!">
         <button onclick="sendTest()" id="btnTest">🚀 Enviar Prueba a n8n</button>
         
         <div id="status"></div>
       </div>

       <script>
         function checkReload() {
           const meta = document.querySelector('meta[data-refresh]');
           if (meta) setTimeout(() => location.reload(), parseInt(meta.dataset.refresh) * 1000);
         }

         async function sendTest() {
           const msg = document.getElementById('testMsg').value;
           const status = document.getElementById('status');
           const btn = document.getElementById('btnTest');
           
           if(!msg) {
             status.innerText = '⚠️ Por favor escribe un mensaje';
             status.className = 'error';
             return;
           }
           
           btn.disabled = true;
           btn.innerText = 'Enviando...';
           status.innerText = '';
           status.className = '';

           try {
             // Enviamos al backend de Render, que reenviará a n8n
             const res = await fetch('/test-webhook', {
               method: 'POST',
               headers: {'Content-Type': 'application/json'},
               body: JSON.stringify({ message: msg })
             });
             
             const data = await res.json();
             
             if(res.ok) {
               status.innerHTML = '✅ <b>Éxito:</b> n8n recibió el mensaje.<br><small>Respuesta: ' + (typeof data.n8nResponse === 'object' ? JSON.stringify(data.n8nResponse) : data.n8nResponse) + '</small>';
               status.className = 'success';
             } else {
               throw new Error(data.error || 'Error desconocido');
             }
           } catch (e) {
             status.innerText = '❌ Error: ' + e.message;
             status.className = 'error';
           } finally {
             btn.disabled = false;
             btn.innerText = '🚀 Enviar Prueba a n8n';
           }
         }
       </script>
    </body>
  </html>
`;

// ========== ENDPOINTS ==========

app.get('/health', (req, res) => {
  const status = sock?.user?.id ? 'connected' : 'disconnected';
  res.json({ status, user: sock?.user?.id || null, timestamp: new Date().toISOString() });
});

app.get('/status', (req, res) => {
  if (!sock?.user?.id) {
    return res.status(503).json({ error: 'WhatsApp no conectado' });
  }
  res.json({ connected: true, user: sock.user.id, jid: sock.user.id });
});

app.get('/qr', async (req, res) => {
  if (!currentQR) {
    return res.send(getHtml(`
      <meta data-refresh="5">
      <div class="card">
        <h2>⏳ Iniciando Bot...</h2>
        <div style="margin: 20px 0;">
           <div style="display:inline-block; width:30px; height:30px; border:3px solid #ddd; border-top-color:#25D366; border-radius:50%; animation: spin 1s linear infinite;"></div>
        </div>
        <p style="color:#666; font-size:14px;">Generando código QR...</p>
        <style>@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }</style>
      </div>
    `));
  }

  try {
    const url = await QRCode.toDataURL(currentQR);
    res.send(getHtml(`
      <meta data-refresh="20">
      <div class="card">
        <h2>📱 Vincula tu WhatsApp</h2>
        <img src="${url}" alt="QR Code"/>
        <p class="meta">El código cambia cada 20 segundos</p>
      </div>
    `));
  } catch (err) {
    res.status(500).send('Error generando QR visual');
  }
});

// Endpoint EXCLUSIVO para testing manual desde la web
app.post('/test-webhook', async (req, res) => {
  const { message } = req.body;
  const n8nWebhook = process.env.N8N_WEBHOOK_URL;

  if (!n8nWebhook) {
    return res.status(400).json({ error: 'La variable N8N_WEBHOOK_URL no está configurada en Render' });
  }

  try {
    // Payload simulado idéntico al real
    const payload = {
      from: 'TESTER_WEB',     // Identificador especial para que sepas que es test
      text: message || 'Test automático',
      timestamp: Math.floor(Date.now() / 1000),
      messageId: 'TEST-' + Date.now(),
      senderName: 'Usuario Web'
    };

    // Enviamos a n8n
    const response = await axios.post(n8nWebhook, payload, { timeout: 8000 });

    // Éxito
    res.json({
      success: true,
      n8nStatus: response.status,
      n8nResponse: response.data
    });

  } catch (error) {
    pino.error('Test Webhook Failed:', error.message);
    res.status(502).json({
      error: 'Fallo al conectar con n8n',
      details: error.message
    });
  }
});

app.post('/send-message', async (req, res) => {
  const { number, message } = req.body;

  if (!sock?.user?.id) {
    return res.status(503).json({ error: 'WhatsApp desconectado' });
  }

  try {
    const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
    const response = await sock.sendMessage(jid, { text: message });
    res.json({ success: true, messageId: response.key.id });
  } catch (error) {
    pino.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== BAILEYS SETUP ==========

const startBaileys = async () => {
  try {
    if (!fs.existsSync(AUTH_PATH)) {
      fs.mkdirSync(AUTH_PATH, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    pino.info(`Baileys version: ${version.join('.')}`);

    sock = makeWASocket({
      version,
      logger: pino,
      printQRInTerminal: true,
      auth: state,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: true,
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if (update.qr) currentQR = update.qr;
      if (update.qr) pino.info('📱 QR generado! Accede a /qr para obtenerlo');
      if (connection === 'open') {
        pino.info(`✅ CONECTADO! Usuario: ${sock.user.id}`);
      }
      if (connection === 'close') {
        const reason = new (require('@hapi/boom')).Boom(lastDisconnect?.error)?.output?.statusCode;
        if (reason !== DisconnectReason.loggedOut) {
          pino.info('🔄 Reintentando...');
          setTimeout(() => startBaileys(), 3000);
        }
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages[0];
      if (msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '[Media]';

      pino.info(`📨 De ${from}: ${text}`);

      try {
        const n8nWebhook = process.env.N8N_WEBHOOK_URL;
        if (!n8nWebhook) return;

        await axios.post(n8nWebhook, {
          from,
          text,
          timestamp: msg.messageTimestamp,
          messageId: msg.key.id
        }, { timeout: 10000 });

        pino.info(`✅ Enviado a n8n`);
      } catch (error) {
        pino.error(`❌ Error n8n: ${error.message}`);
      }
    });

    sock.ev.on('creds.update', saveCreds);
  } catch (error) {
    pino.error('Error:', error);
    setTimeout(() => startBaileys(), 5000);
  }
};

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  pino.info(`🚀 Servidor en puerto ${PORT}`);
  startBaileys();
});

process.on('SIGTERM', () => {
  pino.info('Cerrando...');
  process.exit(0);
});
