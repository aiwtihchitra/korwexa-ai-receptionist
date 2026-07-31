'use strict';

/**
 * Korwexa AI Receptionist — voice server entrypoint.
 *
 * Architecture:
 *   Twilio (PSTN caller)
 *      │  wss:// (μ-law 8kHz, 20ms frames)
 *      ▼
 *   Express + ws  (this server)  ── /media-stream ──►  OpenAI Realtime API
 *      ▲                                                     │
 *      └──────────── streamed assistant audio ◄──────────────┘
 *
 * See /websocket/mediaStream.js for the bridge implementation and
 * /services/openaiRealtime.js for the OpenAI Realtime client.
 */

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const { config, reportMissingEnv } = require('./config');
const logger = require('./utils/logger');
const { createRouter } = require('./routes');
const { handleTwilioConnection } = require('./websocket/mediaStream');

logger.setLevel(config.logLevel);
reportMissingEnv(logger);

const app = express();
app.disable('x-powered-by');
// Behind a TLS-terminating reverse proxy (Emergent ingress, Cloudflare,
// Railway, Render, etc.). Needed so req.ip / req.hostname reflect the
// original client / public host rather than the internal cluster hop.
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// Request access log (info level) — kept minimal so it does not spam.
app.use((req, _res, next) => {
  logger.debug('http', { method: req.method, path: req.path });
  next();
});

// Mount routes at both root (for Railway/Render/VPS deploys) and under
// /api (required by Emergent hosting ingress which routes /api/* to the
// backend service). Both mounts serve identical handlers.
const apiRouter = createRouter({ config, logger });
app.use('/api', apiRouter);
app.use('/', createRouter({ config, logger }));

// Not-found + error handlers
app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error('Unhandled HTTP error', { error: err.message });
  res.status(500).json({ error: 'internal_error' });
});

const server = http.createServer(app);

/**
 * WebSocket server for Twilio Media Streams.
 * `noServer: true` lets us route only /media-stream upgrades and reject
 * everything else with a proper 404 close.
 */
const wss = new WebSocketServer({ noServer: true });

// Accept /media-stream and /api/media-stream so Twilio can reach us on
// both Emergent-style ingress and direct deploys.
const WS_PATHS = ['/media-stream', '/api/media-stream'];
server.on('upgrade', (req, socket, head) => {
  const url = req.url || '';
  const pathOnly = url.split('?')[0];
  if (WS_PATHS.includes(pathOnly)) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    logger.warn('Rejecting WS upgrade for unknown path', { url });
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  handleTwilioConnection(ws, req, { config, logger });
});

// --- Graceful shutdown ------------------------------------------------------
function shutdown(signal) {
  logger.info(`Received ${signal} — shutting down`);
  wss.clients.forEach((client) => {
    try {
      client.close(1001, 'server shutting down');
    } catch {
      /* noop */
    }
  });
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  // Force exit if not closed in 10s
  setTimeout(() => {
    logger.warn('Force-exiting after shutdown timeout');
    process.exit(1);
  }, 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { error: err.message, stack: err.stack });
});

server.listen(config.port, config.host, () => {
  logger.info('Korwexa voice server listening', {
    host: config.host,
    port: config.port,
    model: config.openai.model,
  });
});

module.exports = { app, server };
