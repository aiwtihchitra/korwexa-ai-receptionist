# Korwexa AI Receptionist — Voice Server

Production-ready Node.js voice server that bridges **Twilio Media Streams**
with the **OpenAI Realtime API** (`gpt-realtime-1`) to power the Korwexa AI
Receptionist. No frontend is included by design — this is a backend service.

## Features

- Express + `ws` (native Node.js WebSocket).
- **OpenAI Realtime GA** API (`/v1/realtime`, no `OpenAI-Beta` header).
- Bi-directional audio streaming between Twilio (μ-law 8 kHz) and OpenAI
  Realtime — no local transcoding, sub-second latency.
- Server-side VAD with barge-in handling (the assistant stops talking the
  moment the caller starts).
- Exponential-backoff reconnect for the OpenAI socket.
- Structured logging (timestamped, level-based, JSON meta) suitable for
  Railway / Render / Fly log viewers.
- Graceful shutdown on `SIGINT` / `SIGTERM`.

## Project Structure

```
.
├── server.js              # Express app + HTTP server + WS upgrade routing
├── config/
│   └── index.js           # Env-var loading, system prompt, session config
├── routes/
│   └── index.js           # GET /, GET /health, POST/GET /twiml
├── services/
│   └── openaiRealtime.js  # OpenAI Realtime WebSocket client
├── websocket/
│   └── mediaStream.js     # Twilio <-> OpenAI audio bridge
├── utils/
│   ├── logger.js          # Zero-dep structured logger
│   └── helpers.js         # buildStreamUrl / escapeXml / ids
├── .env.example
└── package.json
```

## HTTP Endpoints

| Method | Path            | Purpose                                                        |
| ------ | --------------- | -------------------------------------------------------------- |
| GET    | `/`             | Service banner (JSON)                                          |
| GET    | `/health`       | Liveness probe                                                 |
| GET/POST | `/twiml`      | Returns TwiML pointing Twilio to `wss://<host>/media-stream`   |

## WebSocket Endpoint

| Path            | Protocol | Purpose                                        |
| --------------- | -------- | ---------------------------------------------- |
| `/media-stream` | Twilio Media Streams | Real-time μ-law audio bridge to OpenAI |

## Environment Variables

Copy `.env.example` → `.env` and fill in:

| Variable              | Required | Description                                        |
| --------------------- | -------- | -------------------------------------------------- |
| `OPENAI_API_KEY`      | yes      | OpenAI key with Realtime API access                |
| `TWILIO_ACCOUNT_SID`  | yes      | Twilio Account SID                                 |
| `TWILIO_AUTH_TOKEN`   | yes      | Twilio Auth Token                                  |
| `PORT`                | no       | HTTP port (default `8001`)                         |
| `OPENAI_REALTIME_MODEL` | no     | Default `gpt-realtime-1`                           |
| `OPENAI_REALTIME_VOICE` | no     | Default `alloy` (alloy / echo / shimmer / …)       |
| `LOG_LEVEL`           | no       | `debug` / `info` / `warn` / `error`                |
| `PUBLIC_HOSTNAME`     | no       | Overrides `Host` header when building TwiML URL    |

## Local Development

```bash
yarn install
cp .env.example .env    # then edit
node server.js
```

Then:

```bash
curl http://localhost:8001/
curl http://localhost:8001/health
```

## Twilio Setup

1. Buy or configure a Twilio phone number.
2. Set its **A CALL COMES IN** webhook to your public URL. **Both prefixes work**:
   - Emergent / Kubernetes-ingress deploys: `https://<your-host>/api/twiml`
   - Direct deploys (Railway / Render / VPS): `https://<your-host>/twiml`
3. Twilio fetches the TwiML, then opens a WebSocket to the matching
   `/media-stream` (or `/api/media-stream`) and streams audio in real time.

The TwiML URL is auto-derived from `X-Forwarded-Host` / `Host`, so no code
change is needed. If your ingress strips those headers, set
`PUBLIC_HOSTNAME=your-domain.com` in the env.

## Deploying to Railway

1. Create a new Railway project and connect this repo.
2. Add environment variables from `.env.example`.
3. Railway auto-detects Node and runs `yarn start`.
   The server binds to `0.0.0.0:$PORT` — no extra config needed.
4. Copy the generated public domain into your Twilio webhook.

The same build runs unchanged on Render, Fly.io, or any VPS.

## Latency Notes

- μ-law is used end-to-end, so no CPU-heavy transcoding takes place.
- The OpenAI socket is opened on Twilio's `connected` event, before the
  first audio frame arrives — this warms the handshake and typically shaves
  100–300 ms off the first assistant word.
- `perMessageDeflate` is disabled on the OpenAI socket for lowest per-frame
  overhead.

## OpenAI Realtime GA Migration

This project targets the **GA** Realtime interface. If you are upgrading
from an older Beta build:

- The `OpenAI-Beta: realtime=v1` request header is **removed**.
- `session.update` now uses the GA schema:
  - `session.type = "realtime"`
  - `output_modalities` replaces `modalities`
  - Audio config moved under `audio.input` / `audio.output`
  - `format: { type: "audio/pcmu" }` for μ-law (the shorthand
    `g711_ulaw` in config is auto-converted by the client).
  - `turn_detection` and `transcription` now live inside `audio.input`.
  - `voice` now lives inside `audio.output`.
- Server events now use GA names (handled by this client):
  - `response.output_audio.delta`
  - `response.output_audio.done`
  - `response.output_audio_transcript.delta`
  - `response.output_audio_transcript.done`
- Initial greeting now uses `conversation.item.create` + `response.create`
  with `response.output_modalities`.

Twilio Media Streams, `g711_ulaw` end-to-end, server VAD, barge-in,
input transcription, reconnect logic, and Railway compatibility are all
preserved.
