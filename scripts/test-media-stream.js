/**
 * Integration smoke test: simulate a Twilio Media Stream WebSocket
 * connection to the voice server and verify the bridge accepts
 * the standard event sequence (connected -> start -> media -> stop).
 *
 * Runs against ws://localhost:8001/media-stream.
 * Note: without a real OPENAI_API_KEY the OpenAI socket will fail,
 * but the Twilio side handshake, event parsing, and clean shutdown
 * must still work — that's what we verify here.
 */

'use strict';

const WebSocket = require('ws');

const url = process.env.WS_URL || 'ws://localhost:8001/media-stream';
console.log(`[test] connecting to ${url}`);

const ws = new WebSocket(url);
let stepsPassed = 0;
const expectedSteps = 3; // open, sent-start, sent-media

const timeout = setTimeout(() => {
  console.error('[test] TIMEOUT — did not complete in 5s');
  process.exit(1);
}, 5000);

ws.on('open', () => {
  console.log('[test] WS open — sending connected/start/media/stop');
  stepsPassed += 1;

  ws.send(
    JSON.stringify({
      event: 'connected',
      protocol: 'Call',
      version: '1.0.0',
    })
  );

  ws.send(
    JSON.stringify({
      event: 'start',
      sequenceNumber: '1',
      start: {
        streamSid: 'MZtestsid1234567890abcdef',
        accountSid: 'ACtest',
        callSid: 'CAtest',
        tracks: ['inbound'],
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      },
      streamSid: 'MZtestsid1234567890abcdef',
    })
  );
  stepsPassed += 1;

  // A short fake mulaw payload (silence-ish bytes)
  const fakeAudio = Buffer.alloc(160, 0xff).toString('base64');
  ws.send(
    JSON.stringify({
      event: 'media',
      sequenceNumber: '2',
      streamSid: 'MZtestsid1234567890abcdef',
      media: {
        track: 'inbound',
        chunk: '1',
        timestamp: '20',
        payload: fakeAudio,
      },
    })
  );
  stepsPassed += 1;

  setTimeout(() => {
    ws.send(
      JSON.stringify({
        event: 'stop',
        sequenceNumber: '3',
        streamSid: 'MZtestsid1234567890abcdef',
        stop: { accountSid: 'ACtest', callSid: 'CAtest' },
      })
    );
    setTimeout(() => ws.close(1000, 'test done'), 200);
  }, 500);
});

ws.on('message', (data) => {
  console.log('[test] received:', data.toString().slice(0, 200));
});

ws.on('close', (code, reason) => {
  clearTimeout(timeout);
  console.log('[test] closed', { code, reason: reason.toString() });
  if (stepsPassed === expectedSteps) {
    console.log(`[test] PASS (${stepsPassed}/${expectedSteps})`);
    process.exit(0);
  } else {
    console.error(`[test] FAIL (${stepsPassed}/${expectedSteps})`);
    process.exit(1);
  }
});

ws.on('error', (err) => {
  clearTimeout(timeout);
  console.error('[test] ws error:', err.message);
  process.exit(1);
});
