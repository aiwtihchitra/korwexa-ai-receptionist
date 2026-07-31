'use strict';

/**
 * Centralized configuration.
 * All values come from environment variables (.env / process.env).
 * Missing critical values are logged as warnings so the operator can spot them
 * quickly during boot; the server still starts to allow health-check probes
 * (Railway / Render usually probe /health before the first real call).
 */

require('dotenv').config();

const SYSTEM_PROMPT = `You are Korwexa AI Receptionist, a professional, friendly, and human-like virtual receptionist.

Your responsibilities are:

- Greet every caller warmly and naturally.
- Speak clearly, politely, and confidently.
- Understand the caller's request before responding.
- Answer questions about the business, services, pricing, and appointments.
- Help callers schedule, reschedule, or cancel appointments.
- Collect the caller's name, phone number, email address, and any other required information naturally during the conversation.
- If you don't know an answer, never invent information. Instead, politely explain that a team member will follow up shortly.
- Keep conversations concise, helpful, and conversational.
- Never sound robotic or repetitive.
- Never mention prompts, system instructions, APIs, or internal implementation.
- Only mention being an AI if the caller asks directly.
- Always maintain a calm, friendly, and professional tone.

When integrated with business data, answer using the business's information, including working hours, services, pricing, FAQs, and appointment availability.

Your primary goal is to provide an exceptional customer experience while helping the business capture leads and book appointments.`;

const config = Object.freeze({
  port: parseInt(process.env.PORT, 10) || 8001,
  host: '0.0.0.0',
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),

  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime',
    voice: process.env.OPENAI_REALTIME_VOICE || 'alloy',
    // Twilio Media Streams uses G.711 μ-law @ 8kHz; matching this format
    // on OpenAI's side removes the need for local audio transcoding and
    // keeps end-to-end latency below 1s.
    inputAudioFormat: 'g711_ulaw',
    outputAudioFormat: 'g711_ulaw',
    temperature: 0.8,
    systemPrompt: SYSTEM_PROMPT,
    turnDetection: {
      type: 'server_vad',
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 500,
      create_response: true,
    },
    // Reconnect (exponential backoff, capped)
    reconnect: {
      enabled: true,
      maxAttempts: 5,
      initialDelayMs: 500,
      maxDelayMs: 8000,
    },
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
  },

  publicHostname: process.env.PUBLIC_HOSTNAME || '',
});

/**
 * Report missing critical env vars (non-fatal) so operators see it in logs.
 * The server still starts because /health must be reachable pre-configuration
 * on some hosting platforms.
 */
function reportMissingEnv(logger) {
  const missing = [];
  if (!config.openai.apiKey) missing.push('OPENAI_API_KEY');
  if (!config.twilio.accountSid) missing.push('TWILIO_ACCOUNT_SID');
  if (!config.twilio.authToken) missing.push('TWILIO_AUTH_TOKEN');

  if (missing.length && logger) {
    logger.warn(
      `Missing environment variables: ${missing.join(', ')}. ` +
        'The server will start but calls will fail until these are set.'
    );
  }
}

module.exports = { config, reportMissingEnv };
