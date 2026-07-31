'use strict';

/**
 * HTTP routes for the Korwexa voice server.
 *
 *   GET  /          -> service banner (json)
 *   GET  /health    -> liveness probe
 *   POST /twiml     -> returns TwiML that instructs Twilio to open a
 *                      bi-directional Media Stream to /media-stream
 *   GET  /twiml     -> same as POST (convenience for browser testing)
 *
 * All routes are also mounted under /api/* in server.js so the service
 * works on hosting platforms whose ingress reserves /api for backend
 * traffic (e.g. Emergent hosting) while still serving root paths for
 * direct-deploy hosts like Railway / Render / VPS.
 */

const express = require('express');
const { buildStreamUrl, escapeXml } = require('../utils/helpers');

function createRouter({ config, logger }) {
  const router = express.Router();

  router.get('/', (_req, res) => {
    res.json({
      service: 'Korwexa AI Receptionist',
      status: 'ok',
      version: '1.0.0',
      endpoints: {
        health: 'GET /health (also /api/health)',
        twiml: 'POST /twiml (also /api/twiml)',
        mediaStream: 'WSS /media-stream (also /api/media-stream)',
      },
    });
  });

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // Twilio hits this URL when a call comes in. It must return TwiML that
  // opens a <Stream> to our WebSocket endpoint.
  //
  // We build the wss:// path so it matches whichever prefix Twilio hit
  // this endpoint on — i.e. /twiml -> /media-stream, /api/twiml ->
  // /api/media-stream. This lets a single deployment work on both
  // Emergent-style ingress (/api required) and Railway-style (root).
  const twimlHandler = (req, res) => {
    // baseUrl is '' when mounted at root, '/api' when mounted at /api
    const wsPath = `${req.baseUrl || ''}/media-stream`;
    const streamUrl = buildStreamUrl(req, config.publicHostname, wsPath);
    logger.info('Serving TwiML', { streamUrl, mount: req.baseUrl || '/' });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(streamUrl)}" />
  </Connect>
</Response>`;
    res.type('text/xml').send(xml);
  };
  router.post('/twiml', twimlHandler);
  router.get('/twiml', twimlHandler);

  return router;
}

module.exports = { createRouter };
