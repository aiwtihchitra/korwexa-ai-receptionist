'use strict';

/**
 * OpenAI Realtime API client for the Korwexa voice bridge.
 *
 * Responsibilities:
 *  - Open a WebSocket to wss://api.openai.com/v1/realtime?model=<model>
 *  - Authenticate via Bearer token + OpenAI-Beta: realtime=v1 header
 *  - Send session.update (system prompt, voice, μ-law audio, server VAD)
 *  - Expose helpers to forward Twilio audio in and stream audio out
 *  - Handle reconnect with exponential backoff (bounded)
 *
 * This class is intentionally small — the audio bridging logic lives in
 * /websocket/mediaStream.js so this file stays framework/transport-agnostic.
 *
 * Events emitted:
 *   'open'        - session is ready (after session.update ack)
 *   'audio'       - (base64Ulaw) chunk of assistant speech ready to play out
 *   'audio.done'  - assistant finished speaking a response
 *   'speech.started' - user started speaking (barge-in cue)
 *   'transcript' - ({ role, text }) partial/final transcript for logging
 *   'error'       - (err)
 *   'close'       - (code, reason)
 */

const { EventEmitter } = require('events');
const WebSocket = require('ws');

const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';

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
    this.logger.info('Connecting to OpenAI Realtime', { model: this.config.model });

    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
      // ws will use default handshake timeout; keep small perMessageDeflate off
      // for lowest latency on small μ-law frames.
      perMessageDeflate: false,
    });

    this.ws.on('open', () => this._onOpen());
    this.ws.on('message', (data) => this._onMessage(data));
    this.ws.on('error', (err) => this._onError(err));
    this.ws.on('close', (code, reason) => this._onClose(code, reason));
  }

  _onOpen() {
    this.logger.info('OpenAI Realtime socket open — sending session.update');
    this.reconnectAttempts = 0;

    const sessionUpdate = {
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: this.config.systemPrompt,
        voice: this.config.voice,
        input_audio_format: this.config.inputAudioFormat,
        output_audio_format: this.config.outputAudioFormat,
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: this.config.turnDetection,
        temperature: this.config.temperature,
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
      case 'session.updated':
      case 'session.created':
        if (!this.isReady) {
          this.isReady = true;
          this.emit('open');
          // Flush any audio buffered while the session was still initializing
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

      case 'response.audio.delta':
      case 'response.output_audio.delta':
        if (event.delta) this.emit('audio', event.delta);
        break;

      case 'response.audio.done':
      case 'response.output_audio.done':
        this.emit('audio.done');
        break;

      case 'input_audio_buffer.speech_started':
        this.emit('speech.started');
        break;

      case 'response.audio_transcript.delta':
      case 'response.output_audio_transcript.delta':
        if (event.delta) {
          this.emit('transcript', { role: 'assistant', text: event.delta, partial: true });
        }
        break;

      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done':
        if (event.transcript) {
          this.emit('transcript', { role: 'assistant', text: event.transcript, partial: false });
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) {
          this.emit('transcript', { role: 'user', text: event.transcript, partial: false });
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
   * If the session is not yet ready, we buffer briefly.
   */
  appendAudio(base64Ulaw) {
    if (!base64Ulaw) return;
    if (!this.isReady) {
      // Buffer up to a reasonable amount to avoid unbounded memory use.
      if (this.pendingAudioChunks.length < 200) {
        this.pendingAudioChunks.push(base64Ulaw);
      }
      return;
    }
    this._send({ type: 'input_audio_buffer.append', audio: base64Ulaw });
  }

  /**
   * Cancel any in-flight response — used when the caller barges in
   * so the assistant stops talking immediately.
   */
  cancelResponse() {
    this._send({ type: 'response.cancel' });
  }

  /**
   * Ask the assistant to greet proactively when the call connects.
   */
  triggerInitialGreeting() {
    this._send({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        instructions:
          'Greet the caller warmly as the Korwexa AI Receptionist and ask how you can help today.',
      },
    });
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

module.exports = { OpenAIRealtimeClient };
