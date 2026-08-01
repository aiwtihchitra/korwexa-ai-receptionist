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
const { DateTime } = require('luxon');
const { buildStreamUrl, escapeXml } = require('../utils/helpers');
const {
  getAuthUrl,
  exchangeCode,
  getAvailabilitySlots,
  createAppointment,
  cancelAppointment,
} = require('../services/googleCalendar');
const { sendConfirmationEmail } = require('../services/emailService');

function createRouter({ config, logger }) {
  const router = express.Router();

  router.get('/', (_req, res) => {
    res.json({
      service: 'Korwexa AI Receptionist',
      status: 'ok',
      version: '1.0.0',
      endpoints: {
        health: 'GET /health (also /api/health)',
        smokeTest: 'GET /smoke-test (also /api/smoke-test)',
        twiml: 'POST /twiml (also /api/twiml)',
        mediaStream: 'WSS /media-stream (also /api/media-stream)',
        googleAuth: 'GET /auth/google (also /api/auth/google)',
        googleCallback: 'GET /auth/google/callback (also /api/auth/google/callback)',
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

  router.get('/auth/google', (req, res) => {
    try {
      const business = (req.query.business || req.query.biz || '').trim();
      if (!business) {
        return res.status(400).json({ error: 'business query parameter is required' });
      }
      const host = req.get('host');
      const protocol = req.protocol;
      const redirectUri = `${protocol}://${host}${req.baseUrl || ''}/auth/google/callback`;
      const authUrl = getAuthUrl({
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        redirectUri,
        business,
      });
      res.redirect(authUrl);
    } catch (err) {
      logger.error('Google auth redirect failed', { error: err.message });
      res.status(500).json({ error: 'Failed to start Google OAuth flow' });
    }
  });

  router.get('/auth/google/callback', async (req, res) => {
    const { code, state: business } = req.query;
    if (!code || !business) {
      return res.status(400).json({ error: 'Missing code or state (business)' });
    }
    try {
      const host = req.get('host');
      const protocol = req.protocol;
      const redirectUri = `${protocol}://${host}${req.baseUrl || ''}/auth/google/callback`;
      await exchangeCode({
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        redirectUri,
        code,
        business,
      });
      res.send(`Google Calendar connected for ${business}. You may now return to the receptionist dashboard.`);
    } catch (err) {
      logger.error('Google OAuth callback failed', { error: err.message, business });
      res.status(500).json({ error: 'Failed to complete Google OAuth callback' });
    }
  });

  router.get('/smoke-test', async (req, res) => {
    if (config.env !== 'development' && !config.smokeTestEnabled) {
      return res.status(404).json({ error: 'not_found' });
    }

    const result = {
      googleAuth: { pass: false, error: null },
      availability: { pass: false, error: null, slots: 0 },
      appointment: { pass: false, error: null },
      email: { pass: false, error: null },
    };

    const host = req.get('host');
    const protocol = req.protocol;
    const redirectUri = `${protocol}://${host}${req.baseUrl || ''}/auth/google/callback`;
    const business = config.openai.businessName;
    const now = DateTime.now().setZone(config.businessTimeZone);
    const smokeWindowStart = now.plus({ minutes: 10 });
    const smokeWindowEnd = smokeWindowStart.plus({ days: 1 });

    let availableSlots = [];
    try {
      availableSlots = await getAvailabilitySlots({
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        redirectUri,
        business,
        calendarId: 'primary',
        start: smokeWindowStart.toJSDate(),
        end: smokeWindowEnd.toJSDate(),
        slotMinutes: config.booking.slotMinutes,
        dayStartHour: config.booking.dayStartHour,
        dayEndHour: config.booking.dayEndHour,
        timeZone: config.businessTimeZone,
      });
      result.googleAuth.pass = true;
      result.availability.pass = true;
      result.availability.slots = availableSlots.length;
    } catch (err) {
      const message = err?.message || 'Google Calendar request failed';
      result.googleAuth.error = message;
      result.availability.error = message;
      return res.status(200).json(result);
    }

    if (!availableSlots.length) {
      result.appointment.error = 'No available slots were found for a temporary test booking.';
    } else {
      const testSlot = availableSlots[0];
      try {
        const event = await createAppointment({
          clientId: config.google.clientId,
          clientSecret: config.google.clientSecret,
          redirectUri,
          business,
          calendarId: 'primary',
          summary: `Smoke Test Appointment - ${Date.now()}`,
          description: 'Temporary smoke test event created by the secure smoke-test endpoint.',
          start: testSlot.start,
          end: testSlot.end,
          guests: [],
          timeZone: config.businessTimeZone,
        });
        result.appointment.pass = true;
        await cancelAppointment({
          clientId: config.google.clientId,
          clientSecret: config.google.clientSecret,
          redirectUri,
          business,
          calendarId: 'primary',
          eventId: event.id,
        });
      } catch (err) {
        result.appointment.error = err?.message || 'Failed to create or delete temporary appointment.';
      }
    }

    if (!config.email.smokeRecipient) {
      result.email.error = 'EMAIL_SMOKE_RECIPIENT environment variable is required for email test.';
    } else {
      try {
        await sendConfirmationEmail({
          to: config.email.smokeRecipient,
          patientName: 'Smoke Test',
          date: now.toLocaleString(DateTime.DATE_MED),
          time: now.toLocaleString(DateTime.TIME_SIMPLE),
          reason: 'Secure smoke test email from the Korwexa voice server.',
        });
        result.email.pass = true;
      } catch (err) {
        result.email.error = err?.message || 'Email service failed to send smoke test email.';
      }
    }

    res.status(200).json(result);
  });

  return router;
}

module.exports = { createRouter };
