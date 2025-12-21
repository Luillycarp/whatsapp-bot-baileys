const express = require('express');
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState, Browsers } = require('@whiskeysockets/baileys');
const P = require('pino');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
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
const AUTH_PATH = './auth_info_baileys';

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
