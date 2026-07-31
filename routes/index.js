'use strict';

/**
 * HTTP routes for the Korwexa voice server.
 *
 *   GET  /          -> service banner (json)
 *   GET  /health    -> liveness probe
 *   POST /twiml     -> returns TwiML that instructs Twilio to open a
 *                      bi-directional Media Stream to /media-stream
 *   GET  /twiml     -> same as POST (convenience for browser testing)
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
        health: 'GET /health',
        twiml: 'POST /twiml',
        mediaStream: 'WSS /media-stream',
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
  const twimlHandler = (req, res) => {
    const streamUrl = buildStreamUrl(req, config.publicHostname);
    logger.info('Serving TwiML', { streamUrl });
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
