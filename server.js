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

// ========== MCP PROTOCOL IMPLEMENTATION ==========

// Definición de herramientas MCP disponibles
const MCP_TOOLS = [
  {
    name: 'send_whatsapp_message',
    description: 'Envía un mensaje de WhatsApp a un número específico. Usa esta herramienta para responder mensajes de usuarios.',
    inputSchema: {
      type: 'object',
      properties: {
        number: {
          type: 'string',
          description: 'Número de WhatsApp del destinatario (puede incluir @s.whatsapp.net o @lid, o solo el número)'
        },
        message: {
          type: 'string',
          description: 'Texto del mensaje a enviar'
        }
      },
      required: ['number', 'message']
    }
  },
  {
    name: 'get_whatsapp_status',
    description: 'Obtiene el estado de conexión de WhatsApp',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  }
];

// Ejecutar herramienta MCP
async function executeTool(toolName, args) {
  switch (toolName) {
    case 'send_whatsapp_message': {
      const { number, message } = args;

      if (!sock?.user?.id) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Error: WhatsApp no está conectado' }]
        };
      }

      try {
        // Normalizar JID
        let jid = number;
        if (!number.includes('@')) {
          jid = `${number}@s.whatsapp.net`;
        }

        // MODO ULTRA RÁPIDO: Fire and Forget
        // Disparamos el envío pero NO esperamos a que termine para responder a n8n
        sock.sendMessage(jid, { text: message })
          .then(res => pino.info(`📤 MCP Async: Mensaje enviado a ${jid} ID: ${res.key.id}`))
          .catch(err => pino.error(`❌ MCP Async Error: ${err.message}`));

        // Respondemos a n8n en 1ms
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ success: true, status: "queued_async" })
          }]
        };
      } catch (error) {
        pino.error(`❌ MCP Error: ${error.message}`);
        return {
          isError: true,
          content: [{ type: 'text', text: `Error enviando mensaje: ${error.message}` }]
        };
      }
    }

    case 'get_whatsapp_status': {
      const connected = !!sock?.user?.id;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            connected,
            user: sock?.user?.id || null,
            hasQR: !!currentQR,
            timestamp: new Date().toISOString()
          })
        }]
      };
    }

    default:
      return {
        isError: true,
        content: [{ type: 'text', text: `Herramienta desconocida: ${toolName}` }]
      };
  }
}

// ========== MCP ENDPOINTS (HTTP/SSE) ==========

// Endpoint principal MCP (JSON-RPC over HTTP)
app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body;

  pino.info(`🔧 MCP Request: ${method}`);

  try {
    let result;

    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'whatsapp-baileys-mcp',
            version: '1.0.0'
          }
        };
        break;

      case 'tools/list':
        result = { tools: MCP_TOOLS };
        break;

      case 'tools/call':
        const { name, arguments: args } = params;
        result = await executeTool(name, args || {});
        break;

      case 'ping':
        result = {};
        break;

      default:
        return res.json({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` }
        });
    }

    res.json({ jsonrpc: '2.0', id, result });

  } catch (error) {
    pino.error(`MCP Error: ${error.message}`);
    res.json({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: error.message }
    });
  }
});

// SSE endpoint para streaming (opcional, algunos clientes lo usan)
app.get('/mcp/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Enviar evento de conexión
  res.write(`data: ${JSON.stringify({ type: 'connected', serverInfo: { name: 'whatsapp-baileys-mcp' } })}\n\n`);

  // Keep-alive cada 30s
  const keepAlive = setInterval(() => {
    res.write(`: keep-alive\n\n`);
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
  });
});

// ========== ENDPOINTS LEGACY (Para compatibilidad) ==========

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
  // Página HTML con QR visual escaneable
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

// Mantener endpoint legacy para backwards compatibility
app.post('/send-message', async (req, res) => {
  const { number, message } = req.body;
  const result = await executeTool('send_whatsapp_message', { number, message });

  if (result.isError) {
    return res.status(500).json({ error: result.content[0].text });
  }
  res.json(JSON.parse(result.content[0].text));
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
        pino.info(`🔧 MCP Server listo en /mcp`);
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

      // Enviar a n8n webhook (si está configurado)
      try {
        const n8nWebhook = process.env.N8N_WEBHOOK_URL;
        if (!n8nWebhook) return;

        // Fire and forget: No esperamos respuesta para no bloquear
        axios.post(n8nWebhook, {
          from,
          text,
          timestamp: msg.messageTimestamp,
          messageId: msg.key.id
        }, { timeout: 5000 })
          .then(() => pino.info('✅ Webhook disparado (Async)'))
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
  pino.info(`🔧 MCP Endpoint: POST /mcp`);
  pino.info(`📡 MCP SSE: GET /mcp/sse`);
  startBaileys();
});

process.on('SIGTERM', () => {
  pino.info('Cerrando...');
  process.exit(0);
});
