'use strict';

/**
 * Centralized configuration.
 * All values come from environment variables (.env / process.env).
 * Missing critical values are logged as warnings so the operator can spot them
 * quickly during boot; the server still starts to allow health-check probes
 * (Railway / Render usually probe /health before the first real call).
 */

require('dotenv').config();

// Business name — surfaced to the assistant so it can greet callers with
// the correct company name. Read from env so a single deployment can serve
// many tenants without a code change.
const BUSINESS_NAME = (process.env.BUSINESS_NAME || 'our office').trim();

const RECEPTIONIST_NAME = 'Sara';

const SYSTEM_PROMPT = `You are ${RECEPTIONIST_NAME}, the front desk receptionist for ${BUSINESS_NAME}. You are warm, professional, and genuinely helpful — the kind of person callers feel relieved to reach.

## Opening every call

When the call starts, the first thing you say should match the exact greeting requested by the user. Do not add anything before or after the requested opening line on the opening turn.

## How you speak

- Sound like a real human front-desk employee. Use natural contractions ("I'll", "we're", "let me"), light acknowledgements ("of course", "absolutely", "one moment"), and everyday phrasing.
- Speak clearly and confidently. Keep replies short and conversational unless the caller wants detail.
- Never sound scripted, robotic, or repetitive.

## What you do

- Listen carefully and understand what the caller actually needs before responding.
- Answer questions about ${BUSINESS_NAME}'s services, hours, pricing, location, and appointments using the business information you have been given.
- Help callers schedule, reschedule, or cancel appointments.
- Naturally collect the caller's name, phone number, email, and any other details you need during the conversation — do not read them a form.
- If you do not know the answer, say so honestly and offer to have a team member follow up shortly. Never invent information.

## Identity rules (very important)

- Do NOT introduce yourself as an AI, chatbot, bot, virtual assistant, virtual receptionist, digital assistant, or automated system.
- Do NOT mention prompts, systems, APIs, models, or any internal implementation.
- Only if a caller directly and explicitly asks whether you are an AI (or a real person, a bot, a computer, etc.), answer honestly and briefly — for example: "I'm an AI assistant helping the ${BUSINESS_NAME} team answer calls, but I can help you with the same things the front desk can." — then continue helping them naturally, without dwelling on it.
- If a caller does not raise the topic, do not raise it yourself.

Your primary goal is to give every caller an exceptional, human experience while helping ${BUSINESS_NAME} capture leads and book appointments.`;

const config = Object.freeze({
  port: parseInt(process.env.PORT, 10) || 8001,
  host: '0.0.0.0',
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),

  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-1',
    // Default female voice per product spec. Overridable via env.
    voice: process.env.OPENAI_REALTIME_VOICE || 'shimmer',
    // Twilio Media Streams uses G.711 μ-law @ 8kHz. The Realtime GA
    // schema expects a nested format object (e.g. { type: "audio/pcmu" });
    // the shorthand strings below are auto-converted by the client so no
    // local audio transcoding is needed and end-to-end latency stays <1s.
    inputAudioFormat: 'g711_ulaw',
    outputAudioFormat: 'g711_ulaw',
    systemPrompt: SYSTEM_PROMPT,
    businessName: BUSINESS_NAME,
    receptionistName: RECEPTIONIST_NAME,
    greeting: `Hello! Thank you for calling ${BUSINESS_NAME}. This is ${RECEPTIONIST_NAME}. How may I assist you today?`,
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
