# Korwexa AI Receptionist — Voice Server

## Original Problem Statement
Build a production-ready Node.js voice server for Korwexa AI Receptionist.
- Node.js + Express + `ws`
- Twilio Media Streams over WebSocket
- OpenAI Realtime API (gpt-realtime)
- Real-time bi-directional audio, <1s latency
- Clean modular structure: `/routes`, `/services`, `/websocket`, `/config`, `/utils`
- Env vars: `OPENAI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `PORT`
- Logging, reconnect logic
- Endpoints: `GET /`, `GET /health`, WebSocket `/media-stream`
- Backend only (no frontend)

## Architecture
```
Twilio caller ──wss──► Express+ws (/media-stream) ──wss──► OpenAI Realtime API
                          │                                        │
                          └──── streamed assistant audio ◄─────────┘
```
- μ-law 8kHz used end-to-end (no transcoding) for lowest latency
- Server-side VAD + barge-in (assistant cancel + Twilio `clear`)
- Exponential-backoff reconnect for OpenAI socket
- `noServer:true` WSS upgrade routing (only `/media-stream` accepted)

## File Layout
```
/app
├── server.js                  Express + HTTP server + WS upgrade
├── config/index.js            Env, system prompt, session settings
├── routes/index.js            GET /, GET /health, POST/GET /twiml
├── services/openaiRealtime.js OpenAI Realtime client (reconnect, events)
├── websocket/mediaStream.js   Twilio ↔ OpenAI bridge
├── utils/logger.js            Structured logger (zero-dep)
├── utils/helpers.js           URL builder, xml escape, ids
├── scripts/test-media-stream.js  Smoke test for WS bridge
├── package.json / .env / .env.example / README.md
```

## What's Implemented (2026-07-31)
- ✅ `GET /` and `GET /api/` service banner
- ✅ `GET /health` and `GET /api/health` liveness probe
- ✅ `POST/GET /twiml` and `POST/GET /api/twiml` returning valid TwiML `<Connect><Stream>`
- ✅ `WSS /media-stream` and `WSS /api/media-stream` accept Twilio Media Streams
- ✅ Dual-mount so the same build runs on Emergent ingress (/api required) AND Railway/Render/VPS (root)
- ✅ TwiML respects `X-Forwarded-Host` so the wss:// URL points at the public host, not the internal cluster hop
- ✅ `trust proxy` enabled on Express
- ✅ OpenAI Realtime WebSocket client with session.update, streamed audio deltas, barge-in cancel, exponential-backoff reconnect
- ✅ Korwexa receptionist system prompt loaded verbatim
- ✅ Zero-dep structured logger, graceful SIGINT/SIGTERM
- ✅ Supervisor entry `voice-server` on `0.0.0.0:8001`
- ✅ Testing agent regression PASSED — all 11 checkpoints green

## Verified
- `curl localhost:8001/` → banner JSON ✓
- `curl localhost:8001/health` → uptime JSON ✓
- `curl -X POST localhost:8001/twiml` → valid TwiML with wss URL ✓
- WS `/media-stream` accepts Twilio event sequence and shuts down cleanly ✓
- Unknown paths → 404 (HTTP) / 404 close (WS) ✓

## Required Credentials to Go Live
User must fill in `/app/.env`:
- `OPENAI_API_KEY` (must have Realtime API access — Emergent LLM key NOT supported)
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
Optional: `PUBLIC_HOSTNAME` (else derived from request Host header)

## Backlog / Next Actions
- P1: Twilio request-signature validation on `/twiml` (`X-Twilio-Signature` HMAC-SHA1) once creds are supplied
- P1: Persist call transcripts + basic call analytics (Mongo/Postgres)
- P2: Function-calling tools for appointment booking / calendar integration
- P2: Multi-language voice detection + voice switching
- P2: Redis-backed session store for horizontal scaling
