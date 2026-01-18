const express = require('express');
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState, Browsers } = require('@whiskeysockets/baileys');
const P = require('pino');
const fs = require('fs');
const axios = require('axios');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
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

// ========== CONFIGURACIÓN SUPABASE ==========
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ljeqtbkjdycdrhtozvxu.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY; // DEBE ESTAR EN VARIABLES DE ENTORNO

let supabase;
if (SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  pino.info('✅ Cliente Supabase inicializado');
} else {
  pino.warn('⚠️ FALTA SUPABASE_KEY. La funcionalidad Realtime no funcionará.');
}

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
        p { color: #666; font-size: 14px; }
      </style>
    </head>
    <body>
       ${content}
    </body>
  </html>
`;

// ========== ENDPOINTS ==========

app.get('/qr', async (req, res) => {
  if (!currentQR) {
    return res.send(getHtml(`
      <meta http-equiv="refresh" content="5">
      <div class="card">
        <h2>⏳ Iniciando Bot...</h2>
        <p>Generando código QR...</p>
      </div>
    `));
  }
  try {
    const url = await QRCode.toDataURL(currentQR);
    res.send(getHtml(`
      <meta http-equiv="refresh" content="20">
      <div class="card">
        <h2>📱 Vincula tu WhatsApp</h2>
        <img src="${url}" alt="QR Code"/>
        <p>El código cambia cada 20 segundos</p>
      </div>
    `));
  } catch (err) {
    res.status(500).send('Error generando QR visual');
  }
});

// ========== SUBSCRIPCIÓN A SUPABASE (OUTBOX) ==========
const subscribeToOutbox = () => {
  if (!supabase) return;

  pino.info('🔌 Conectando a Supabase Realtime (outbox_whatsapp)...');

  supabase
    .channel('outbox-listener')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'outbox_whatsapp' },
      async (payload) => {
        const newRow = payload.new;
        pino.info(`🔔 Nuevo mensaje en Outbox! ID: ${newRow.id} -> Para: ${newRow.to_number}`);

        if (!sock?.user?.id) {
          pino.error('❌ WhatsApp no está conectado. No se puede enviar.');
          return;
        }

        try {
          // Enviar mensaje a WhatsApp
          const jid = newRow.to_number.includes('@') ? newRow.to_number : `${newRow.to_number}@s.whatsapp.net`;
          await sock.sendMessage(jid, { text: newRow.reply_body });
          pino.info('✅ Mensaje enviado a WhatsApp exitosamente');

          // Actualizar estado en Supabase
          await supabase
            .from('outbox_whatsapp')
            .update({ status: 'sent' })
            .eq('id', newRow.id);

        } catch (err) {
          pino.error(`❌ Error enviando mensaje: ${err.message}`);
          await supabase
            .from('outbox_whatsapp')
            .update({ status: 'error: ' + err.message })
            .eq('id', newRow.id);
        }
      }
    )
    .subscribe((status) => {
      pino.info(`📡 Estado Supabase: ${status}`);
    });
};

// ========== BAILEYS SETUP ==========

const startBaileys = async () => {
  try {
    if (!fs.existsSync(AUTH_PATH)) {
      fs.mkdirSync(AUTH_PATH, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const { version } = await fetchLatestBaileysVersion();

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

      if (connection === 'open') {
        pino.info(`✅ CONECTADO! Usuario: ${sock.user.id}`);
        // Iniciar escucha de Supabase al conectar
        subscribeToOutbox();
      }

      if (connection === 'close') {
        const reason = new (require('@hapi/boom')).Boom(lastDisconnect?.error)?.output?.statusCode;
        if (reason !== DisconnectReason.loggedOut) {
          pino.info('🔄 Reintentando conexión...');
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

      // 1. Enviar a n8n (WEBHOOK) - Solo para despertar/procesar
      // MANTENEMOS ESTO PARA ALERTAR A N8N
      try {
        const n8nWebhook = process.env.N8N_WEBHOOK_URL;
        const hfToken = process.env.HF_ACCESS_TOKEN;

        if (n8nWebhook) {
          const config = { headers: {} };
          if (hfToken) config.headers['Authorization'] = `Bearer ${hfToken}`;

          // No esperamos respuesta (fire and forget) o timeout corto
          axios.post(n8nWebhook, {
            from,
            text,
            timestamp: msg.messageTimestamp,
            messageId: msg.key.id
          }, config).catch(e => pino.error(`⚠️ n8n Webhook Warning: ${e.message}`));
        }
      } catch (e) {
        // Ignoramos errores de n8n para no bloquear
      }

      // 2. OPCIONAL: Guardar en 'inbox_whatsapp' también
      if (supabase) {
        await supabase.from('inbox_whatsapp').insert({
          from_number: from,
          text_body: text,
          sender_name: msg.pushName || 'Unknown'
        });
      }
    });

    sock.ev.on('creds.update', saveCreds);
  } catch (error) {
    pino.error('Error Baileys:', error);
    setTimeout(() => startBaileys(), 5000);
  }
};

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  pino.info(`🚀 Servidor en puerto ${PORT}`);
  startBaileys();
});
