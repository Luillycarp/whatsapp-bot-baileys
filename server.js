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

// ========== HELPER HTML PARA QR ==========
const html = (content) => `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="refresh" content="20">
    <title>WhatsApp Bot - QR</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
      .card { background: white; padding: 40px; border-radius: 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); text-align: center; max-width: 400px; }
      h2 { margin: 0 0 10px 0; color: #1f2937; }
      p { color: #6b7280; margin: 10px 0; }
      img { border-radius: 12px; margin: 20px 0; }
      .status { padding: 8px 16px; border-radius: 20px; display: inline-block; font-weight: 600; }
      .waiting { background: #fef3c7; color: #92400e; }
      .ready { background: #d1fae5; color: #065f46; }
    </style>
  </head>
  <body>
    <div class="card">${content}</div>
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
    return res.send(html(`
      <h2>⏳ Esperando QR...</h2>
      <p class="status waiting">Iniciando conexión</p>
      <p>La página se actualizará automáticamente</p>
    `));
  }

  try {
    const qrImageUrl = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 });
    res.send(html(`
      <h2>📱 Escanea con WhatsApp</h2>
      <img src="${qrImageUrl}" alt="QR Code" width="300" height="300"/>
      <p class="status ready">QR listo para escanear</p>
      <p>Abre WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
    `));
  } catch (err) {
    res.status(500).send(html(`
      <h2>❌ Error</h2>
      <p>${err.message}</p>
    `));
  }
});

// ========== FAKE ANTHROPIC API (Para burlar bloqueos n8n) ==========

app.post('/v1/messages', async (req, res) => {
  // 1. Extraer datos (n8n envía el prompt en 'messages')
  const { messages } = req.body;

  // El número debe venir en un HEADER personalizado desde n8n
  // En el nodo Anthropic en n8n -> Headers -> Add Header: 'x-whatsapp-to' = {{numero}}
  const number = req.headers['x-whatsapp-to'];

  const textContent = messages?.find(m => m.role === 'user')?.content;

  if (!number || !textContent) {
    pino.error('❌ Anthropic/WA: Falta número (header x-whatsapp-to) o mensaje');
    return res.status(400).json({ error: { type: 'invalid_request_error', message: 'Missing x-whatsapp-to header or message content' } });
  }

  // 2. Enviar a WhatsApp (FIRE AND FORGET - ULTRA FAST)
  try {
    const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;

    pino.info(`🎭 Anthropic/WA: Enviando a ${jid}`);

    sock.sendMessage(jid, { text: textContent })
      .then(r => pino.info(`✅ Anthropic/WA Sent: ${r.key.id}`))
      .catch(e => pino.error(`❌ Anthropic/WA Error: ${e.message}`));

  } catch (e) {
    pino.error(`Error interno: ${e.message}`);
  }

  // 3. Responder a n8n como si fuéramos Claude (Inmediatamente)
  res.json({
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Mensaje enviado correctamente vía WhatsApp."
      }
    ],
    model: "claude-3-haiku-20240307",
    stop_reason: "end_turn",
    usage: {
      input_tokens: 10,
      output_tokens: 10
    }
  });
});

// ========== LEGACY ENDPOINT (Compatibilidad) ==========

app.post('/send-message', async (req, res) => {
  const { number, message } = req.body;

  if (!sock?.user?.id) {
    return res.status(503).json({ error: 'WhatsApp desconectado' });
  }

  try {
    // Modo Fire and Forget también aquí para uniformidad
    const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;

    sock.sendMessage(jid, { text: message })
      .then(r => pino.info(`✅ Standard/WA Sent: ${r.key.id}`))
      .catch(e => pino.error(`❌ Standard/WA Error: ${e.message}`));

    res.json({ success: true, status: 'queued' });
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

        // Fire and forget para no bloquear
        axios.post(n8nWebhook, {
          from,
          text,
          timestamp: msg.messageTimestamp,
          messageId: msg.key.id
        }, { timeout: 10000 })
          .catch(e => pino.error(`⚠️ Webhook error: ${e.message}`));

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
  pino.info(`🎭 Fake Anthropic API en /v1/messages`);
  startBaileys();
});

process.on('SIGTERM', () => {
  pino.info('Cerrando...');
  process.exit(0);
});
