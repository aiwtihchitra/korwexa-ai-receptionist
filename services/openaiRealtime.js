'use strict';

/**
 * OpenAI Realtime API (GA) client for the Korwexa voice bridge.
 *
 * Migrated from the legacy Beta interface (`OpenAI-Beta: realtime=v1`) which
 * was removed by OpenAI. The GA interface differs in three important ways:
 *
 *   1. No `OpenAI-Beta` header — the plain `wss://api.openai.com/v1/realtime`
 *      endpoint now serves the GA schema by default.
 *
 *   2. `session.update` moved audio config under a nested `audio.input` /
 *      `audio.output` object, replaced `modalities` with `output_modalities`,
 *      added `session.type: "realtime"`, and now expects
 *      `format: { type: "audio/pcmu" }` (equivalent to the old μ-law
 *      shorthand `g711_ulaw`) for Twilio telephony audio.
 *
 *   3. Server events: GA uses the following event names:
 *        response.output_audio.delta
 *        response.output_audio.done
 *        response.output_audio_transcript.delta
 *        response.output_audio_transcript.done
 *
 * Everything else (Twilio μ-law bridging, server-side VAD, barge-in via
 * response.cancel + Twilio clear, whisper input transcription, exponential
 * backoff reconnect) is preserved.
 *
 * Events emitted by this class (unchanged public API):
 *   'open'           - session is ready (after session.updated / session.created)
 *   'audio'          - (base64 μ-law) chunk of assistant speech ready to play
 *   'audio.done'     - assistant finished the current audio response
 *   'speech.started' - user started speaking (barge-in cue)
 *   'transcript'     - ({ role, text, partial }) for logging
 *   'error'          - (err)
 *   'close'          - (code, reason)
 */

const { EventEmitter } = require('events');
const WebSocket = require('ws');

const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';

// Map the legacy shorthand ("g711_ulaw" / "g711_alaw" / "pcm16") to the GA
// nested audio format object. Anything else is passed through unchanged so
// operators can already supply a GA-shaped value from config if they want.
function toGaAudioFormat(fmt) {
  if (fmt && typeof fmt === 'object') return fmt;
  switch (fmt) {
    case 'g711_ulaw':
      return { type: 'audio/pcmu' };
    case 'g711_alaw':
      return { type: 'audio/pcma' };
    case 'pcm16':
      return { type: 'audio/pcm', rate: 24000 };
    default:
      return { type: 'audio/pcmu' };
  }
}

class OpenAIRealtimeClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.config - openai config block from /config
   * @param {object} opts.logger - child logger with connection context
   */
  constructor({ config, logger }) {
    super();
    this.config = config;
    this.logger = logger;
    this.ws = null;
    this.isReady = false;
    this.isClosed = false;
    this.reconnectAttempts = 0;
    this.pendingAudioChunks = [];
  }

  connect() {
    if (!this.config.apiKey) {
      const err = new Error('OPENAI_API_KEY is not configured');
      this.emit('error', err);
      return;
    }

    const url = `${OPENAI_REALTIME_URL}?model=${encodeURIComponent(this.config.model)}`;
    this.logger.info('Connecting to OpenAI Realtime (GA)', {
      model: this.config.model,
    });

    // GA interface: no OpenAI-Beta header. Authorization + optional
    // safety identifier are all that's needed.
    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      // Disable per-message deflate for lowest per-frame overhead on the
      // small (~20ms) μ-law chunks streamed from Twilio.
      perMessageDeflate: false,
    });

    this.ws.on('open', () => this._onOpen());
    this.ws.on('message', (data) => this._onMessage(data));
    this.ws.on('error', (err) => this._onError(err));
    this.ws.on('close', (code, reason) => this._onClose(code, reason));
  }

  _onOpen() {
    this.logger.info('OpenAI Realtime socket open — sending GA session.update');
    this.reconnectAttempts = 0;

    const inputFormat = toGaAudioFormat(this.config.inputAudioFormat);
    const outputFormat = toGaAudioFormat(this.config.outputAudioFormat);

    // GA session.update shape. Keys that changed vs Beta:
    //   - session.type: "realtime" (required)
    //   - output_modalities (was: modalities)
    //   - audio.input.format / audio.output.format (was: input_audio_format /
    //     output_audio_format at top level)
    //   - audio.input.turn_detection (was: session.turn_detection)
    //   - audio.input.transcription (was: session.input_audio_transcription)
    //   - audio.output.voice (was: session.voice)
    const sessionUpdate = {
      type: 'session.update',
      session: {
        type: 'realtime',
        model: this.config.model,
        instructions: this.config.systemPrompt,
        output_modalities: ['audio'],
        audio: {
          input: {
            format: inputFormat,
            turn_detection: this.config.turnDetection,
            transcription: { model: 'whisper-1' },
          },
          output: {
            format: outputFormat,
            voice: this.config.voice,
          },
        },
      },
    };
    this._send(sessionUpdate);
  }

  _onMessage(raw) {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch (err) {
      this.logger.error('Failed to parse OpenAI event', { error: err.message });
      return;
    }

    switch (event.type) {
      // GA emits `session.created` on connect and `session.updated` after our
      // `session.update`. Either signals the session is ready to accept audio.
      case 'session.updated':
      case 'session.created':
        if (!this.isReady) {
          this.isReady = true;
          this.emit('open');
          if (this.pendingAudioChunks.length) {
            this.logger.debug('Flushing buffered audio chunks', {
              count: this.pendingAudioChunks.length,
            });
            for (const chunk of this.pendingAudioChunks) {
              this._send({ type: 'input_audio_buffer.append', audio: chunk });
            }
            this.pendingAudioChunks = [];
          }
        }
        break;

      // GA audio delta / done events.
      case 'response.output_audio.delta':
        if (event.delta) this.emit('audio', event.delta);
        break;

      case 'response.output_audio.done':
        this.emit('audio.done');
        break;

      case 'input_audio_buffer.speech_started':
        this.emit('speech.started');
        break;

      // GA assistant transcript events.
      case 'response.output_audio_transcript.delta':
        if (event.delta) {
          this.emit('transcript', {
            role: 'assistant',
            text: event.delta,
            partial: true,
          });
        }
        break;

      case 'response.output_audio_transcript.done':
        if (event.transcript) {
          this.emit('transcript', {
            role: 'assistant',
            text: event.transcript,
            partial: false,
          });
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) {
          this.emit('transcript', {
            role: 'user',
            text: event.transcript,
            partial: false,
          });
        }
        break;

      case 'error':
        this.logger.error('OpenAI Realtime error event', { error: event.error });
        this.emit('error', new Error(event.error?.message || 'OpenAI Realtime error'));
        break;

      default:
        this.logger.debug('OpenAI event', { type: event.type });
    }
  }

  _onError(err) {
    this.logger.error('OpenAI Realtime socket error', { error: err.message });
    this.emit('error', err);
  }

  _onClose(code, reason) {
    const reasonStr = reason ? reason.toString() : '';
    this.logger.warn('OpenAI Realtime socket closed', { code, reason: reasonStr });
    this.isReady = false;
    this.ws = null;
    this.emit('close', code, reasonStr);

    if (!this.isClosed && this.config.reconnect?.enabled) {
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    const { maxAttempts, initialDelayMs, maxDelayMs } = this.config.reconnect;
    if (this.reconnectAttempts >= maxAttempts) {
      this.logger.error('OpenAI reconnect attempts exhausted', {
        attempts: this.reconnectAttempts,
      });
      this.emit('error', new Error('OpenAI reconnect attempts exhausted'));
      return;
    }
    this.reconnectAttempts += 1;
    const delay = Math.min(
      initialDelayMs * 2 ** (this.reconnectAttempts - 1),
      maxDelayMs
    );
    this.logger.info('Scheduling OpenAI reconnect', {
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });
    setTimeout(() => {
      if (!this.isClosed) this.connect();
    }, delay);
  }

  _send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      this.logger.error('Failed to send to OpenAI', { error: err.message });
      return false;
    }
  }

  /**
   * Forward a base64-encoded μ-law audio chunk from Twilio to OpenAI.
   * Event name (input_audio_buffer.append) is unchanged in GA.
   */
  appendAudio(base64Ulaw) {
    if (!base64Ulaw) return;
    if (!this.isReady) {
      if (this.pendingAudioChunks.length < 200) {
        this.pendingAudioChunks.push(base64Ulaw);
      }
      return;
    }
    this._send({ type: 'input_audio_buffer.append', audio: base64Ulaw });
  }

  /**
   * Cancel any in-flight response — used when the caller barges in so the
   * assistant stops talking immediately. Event name is unchanged in GA.
   */
  cancelResponse() {
    this._send({ type: 'response.cancel' });
  }

  /**
   * Ask the assistant to greet proactively when the call connects.
   *
   * Sends an explicit greeting string derived from config (business name is
   * injected server-side so a single deployment can serve many tenants).
   * Sara reads it aloud verbatim as the first spoken line of the call.
   *
   * GA change: `response.modalities` was replaced with
   * `response.output_modalities`.
   */
  triggerInitialGreeting() {
    const greeting = this.config.greeting;
    this._send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `Please open the call by saying exactly, in a warm natural tone: "${greeting}". Do not add anything else on this first turn.`,
          },
        ],
      },
    });
    this._send({
      type: 'response.create',
      response: {
        output_modalities: ['audio'],
      },
    });
  }

  sendTextInstruction(text) {
    if (!text) return false;
    this._send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text,
          },
        ],
      },
    });
    this._send({
      type: 'response.create',
      response: {
        output_modalities: ['audio'],
      },
    });
    return true;
  }

  close() {
    this.isClosed = true;
    if (this.ws) {
      try {
        this.ws.close(1000, 'client closing');
      } catch {
        /* noop */
      }
      this.ws = null;
    }
  }
}

module.exports = { OpenAIRealtimeClient, toGaAudioFormat };
