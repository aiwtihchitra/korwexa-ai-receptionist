'use strict';

/**
 * Twilio <-> OpenAI Realtime audio bridge.
 *
 * Twilio Media Streams protocol reference:
 *   https://www.twilio.com/docs/voice/twiml/stream#message-format
 *
 * Message types Twilio sends over the WebSocket:
 *   - connected  : first message, protocol handshake
 *   - start      : includes streamSid + call metadata
 *   - media      : { payload: base64(mulaw 8kHz, 20ms frames) }
 *   - mark       : playback marker echoed back
 *   - stop       : end of the media stream
 *
 * Frames we send back to Twilio:
 *   - { event: 'media', streamSid, media: { payload } }
 *   - { event: 'mark',  streamSid, mark: { name } }
 *   - { event: 'clear', streamSid }  // flush buffered playback (barge-in)
 */

const { OpenAIRealtimeClient } = require('../services/openaiRealtime');
const { generateConnectionId } = require('../utils/helpers');

function handleTwilioConnection(twilioWs, req, { config, logger: rootLogger }) {
  const connectionId = generateConnectionId();
  const logger = rootLogger.child({ connId: connectionId });
  logger.info('Twilio Media Stream connected', {
    remoteAddress: req.socket?.remoteAddress,
  });

  let streamSid = null;
  let callSid = null;
  let closed = false;
  let markCounter = 0;
  let finalGoodbyeDetected = false;
  let disconnectScheduled = false;
  let bookingConfirmed = false;
  let bookingSummaryAnnounced = false;
  let appointmentDetailsCollected = false;
  let bookingFlowStarted = false;
  let bookingCompleted = false;
  let lastStructuredSyncAt = null;
  let lastStructuredSyncCallId = null;
  let lastStructuredSyncPayload = null;
  const bookingWebhookUrl = 'https://aiwithchitra.app.n8n.cloud/webhook/sara-booking';
  let currentAppointmentDetails = {
    name: null,
    email: null,
    phone: null,
    appointmentDate: null,
    appointmentTime: null,
    reason: null,
  };
  const bookingFieldSources = {
    name: null,
    email: null,
    phone: null,
    appointmentDate: null,
    appointmentTime: null,
    reason: null,
  };

  const openai = new OpenAIRealtimeClient({
    config: config.openai,
    logger,
  });

  // --- OpenAI -> Twilio ---------------------------------------------------
  openai.on('open', () => {
    logger.info('OpenAI session ready');
    // Kick off the greeting once we have both sides connected
    if (streamSid) openai.triggerInitialGreeting();
  });

  openai.on('audio', (base64Ulaw) => {
    if (!streamSid || closed) return;
    twilioSend({
      event: 'media',
      streamSid,
      media: { payload: base64Ulaw },
    });
  });

  openai.on('audio.done', () => {
    if (!streamSid || closed) return;
    markCounter += 1;
    twilioSend({
      event: 'mark',
      streamSid,
      mark: { name: `assistant-turn-${markCounter}` },
    });

    scheduleDisconnectIfNeeded();
  });

  openai.on('transcript', ({ role, text, partial }) => {
    if (!partial) {
      logger.info('transcript', { role, text });

      if (role === 'assistant') {
        if (!finalGoodbyeDetected && /thank you for choosing our clinic[\s,\.]*we look forward to seeing you[\s,\.]*have a wonderful day[\s,\.]*goodbye/i.test(text)) {
          if (bookingCompleted) {
            finalGoodbyeDetected = true;
          } else {
            logger.warn('Premature final goodbye received before booking completed');
          }
        }
      }

      if (role === 'user') {
        handleUserTranscript(text);
      }
    }
  });

  openai.on('error', (err) => {
    logger.error('OpenAI error', { error: err.message });
  });

  openai.on('close', (code, reason) => {
    logger.warn('OpenAI closed', { code, reason });
  });

  openai.on('tool_call', ({ name, arguments: toolArgs, callId }) => {
    if (name !== 'sync_booking_state') return;

    const appliedFields = applyStructuredBookingState({
      payload: toolArgs,
      callId,
      sourceObjectName: 'openaiTool.sync_booking_state.arguments',
    });

    if (callId) {
      openai.submitToolResult(callId, {
        ok: true,
        appliedFields,
        bookingState: { ...currentAppointmentDetails },
      });
    }
  });

  // --- Twilio -> OpenAI ---------------------------------------------------
  twilioWs.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      logger.warn('Non-JSON message from Twilio', { error: err.message });
      return;
    }

    switch (msg.event) {
      case 'connected':
        logger.debug('Twilio connected event', { protocol: msg.protocol });
        // Start OpenAI connection immediately so it is warm by the time
        // 'start' arrives (saves ~100-300ms of first-response latency).
        openai.connect();
        break;

      case 'start': {
        streamSid = msg.start?.streamSid || msg.streamSid;
        callSid = msg.start?.callSid;
        logger.info('Twilio stream started', { streamSid, callSid });
        // If OpenAI is already ready, greet now. Otherwise the 'open'
        // handler above will trigger the greeting.
        if (openai.isReady) openai.triggerInitialGreeting();
        break;
      }

      case 'media': {
        const payload = msg.media?.payload;
        if (payload) openai.appendAudio(payload);
        break;
      }

      case 'mark':
        logger.debug('Twilio mark received', { name: msg.mark?.name });
        break;

      case 'stop':
        logger.info('Twilio stream stopped', { streamSid });
        cleanup(1000, 'twilio stop');
        break;

      default:
        logger.debug('Twilio event', { event: msg.event });
    }
  });

  twilioWs.on('close', (code, reason) => {
    logger.info('Twilio WS closed', {
      code,
      reason: reason ? reason.toString() : '',
    });
    cleanup(code, 'twilio close');
  });

  twilioWs.on('error', (err) => {
    logger.error('Twilio WS error', { error: err.message });
    cleanup(1011, 'twilio error');
  });

  function twilioSend(payload) {
    if (twilioWs.readyState !== twilioWs.OPEN) return;
    try {
      twilioWs.send(JSON.stringify(payload));
    } catch (err) {
      logger.error('Failed to send to Twilio', { error: err.message });
    }
  }

  function cleanup(code, reason) {
    if (closed) return;
    closed = true;
    logger.info('Twilio disconnect initiated', { code, reason });
    try {
      openai.close();
    } catch {
      /* noop */
    }
    try {
      if (twilioWs.readyState === twilioWs.OPEN) twilioWs.close(code, reason);
    } catch {
      /* noop */
    }
  }

  function handleUserTranscript(text) {
    const normalized = text.trim();
    const name = parseName(normalized);
    const email = parseEmail(normalized);
    const phoneFragment = parsePhoneFragment(normalized);
    const reason = parseReason(normalized);
    const appointmentDate = parseAppointmentDate(normalized);
    const appointmentTime = parseAppointmentTime(normalized);
    const confirmation = parseConfirmation(normalized);
    let detailsUpdated = false;

    if (name) {
      detailsUpdated = setBookingField('name', name, 'user_transcript') || detailsUpdated;
      logger.debug('Captured name from user transcript', { name });
    }
    if (email) {
      detailsUpdated = setBookingField('email', email, 'user_transcript') || detailsUpdated;
      logger.debug('Captured email from user transcript', { email });
    }
    if (phoneFragment) {
      const cleaned = phoneFragment.replace(/[^\d]/g, '');
      detailsUpdated = setBookingField('phone', cleaned, 'user_transcript') || detailsUpdated;
      logger.debug('Captured phone fragment from user transcript', { phone: currentAppointmentDetails.phone });
    }
    if (appointmentDate) {
      detailsUpdated = setBookingField('appointmentDate', appointmentDate, 'user_transcript') || detailsUpdated;
      logger.debug('Captured appointment date from user transcript', { appointmentDate });
    }
    if (appointmentTime) {
      detailsUpdated = setBookingField('appointmentTime', appointmentTime, 'user_transcript') || detailsUpdated;
      logger.debug('Captured appointment time from user transcript', { appointmentTime });
    }
    if (reason) {
      detailsUpdated = setBookingField('reason', reason, 'user_transcript') || detailsUpdated;
      logger.debug('Captured reason for visit from user transcript', { reason });
    }

    if (detailsUpdated) {
      bookingSummaryAnnounced = false;
    }

    if (!appointmentDetailsCollected && hasRequiredBookingInfo()) {
      appointmentDetailsCollected = true;
      logger.info('Appointment details collected', {
        name: currentAppointmentDetails.name,
        email: currentAppointmentDetails.email,
        phone: currentAppointmentDetails.phone,
        appointmentDate: currentAppointmentDetails.appointmentDate,
        appointmentTime: currentAppointmentDetails.appointmentTime,
        reason: currentAppointmentDetails.reason || 'not provided',
      });
    }

    if (hasRequiredBookingInfo()) {
      maybeAnnounceSummary();
    }

    logger.info('BOOKING_CONFIRMATION_CHECKPOINT', {
      transcript: normalized,
      confirmationDetected: confirmation,
      hasRequiredBookingInfo: hasRequiredBookingInfo(),
      bookingConfirmed,
      bookingFlowStarted,
      bookingCompleted,
      missingFields: getMissingBookingFields(),
    });

    handleBookingConfirmation({ confirmation, transcript: normalized }).catch((err) =>
      logger.error('handleBookingConfirmation failed', { error: err.message })
    );

    // Re-check booking flow after processing the latest transcript
    maybeStartBookingFlow().catch((err) => logger.error('maybeStartBookingFlow failed', { error: err.message }));
  }

  function parseName(text) {
    const match = text.match(/(?:my name is|this is|i\'m|i am)\s+([A-Za-z][A-Za-z]+(?:[ '\-][A-Za-z]+){0,3})/i);
    return match ? match[1].trim() : null;
  }

  function parseEmail(text) {
    const match = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/i);
    if (match) return match[0].trim();

    const spokenNormalized = text
      .toLowerCase()
      .replace(/\s+at\s+/g, '@')
      .replace(/\s+dot\s+/g, '.')
      .replace(/\s+underscore\s+/g, '_')
      .replace(/\s+dash\s+/g, '-')
      .replace(/\s+/g, '');

    const spokenMatch = spokenNormalized.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/i);
    return spokenMatch ? spokenMatch[0].trim() : null;
  }

  function parsePhoneFragment(text) {
    const match = text.match(/(?:phone number is|my number is|call me at|number is|phone is)\s*(\+?[\d][\d\s().-]{7,}\d)/i);
    if (!match) return null;
    const cleaned = match[1].replace(/[^\d]/g, '');
    if (cleaned.length < 10 || cleaned.length > 15) return null;
    return cleaned;
  }

  function parseReason(text) {
    const match = text.match(/reason(?: for visit)? is\s+([A-Za-z0-9\s,'\-]+)/i);
    if (match) return match[1].trim();

    const fallback = text.match(/(?:appointment|visit|consultation)\s+(?:for|about|regarding)\s+([A-Za-z0-9\s,'\-]+)/i);
    return fallback ? fallback[1].trim() : null;
  }

  function parseAppointmentDate(text) {
    const directIso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/i);
    if (directIso) return directIso[1];

    const slashDate = text.match(/\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i);
    if (slashDate) return slashDate[1];

    const relativeDate = text.match(/\b(today|tomorrow|day after tomorrow)\b/i);
    if (relativeDate) return relativeDate[1].toLowerCase();

    const monthDate = text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{2,4})?\b/i);
    if (monthDate) return monthDate[0].trim();

    return null;
  }

  function parseAppointmentTime(text) {
    const timeMatch = text.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);
    if (timeMatch) return timeMatch[1].replace(/\s+/g, ' ').trim().toLowerCase();
    return null;
  }

  function parseConfirmation(text) {
    return /\b(yes|confirm|sure|please do|that sounds good|that works|sounds good|go ahead)\b/i.test(text);
  }

  function hasCustomerContactDetails() {
    return Boolean(
      currentAppointmentDetails.name &&
      currentAppointmentDetails.email &&
      currentAppointmentDetails.phone
    );
  }

  function hasRequiredBookingInfo() {
    return Boolean(
      currentAppointmentDetails.name &&
      currentAppointmentDetails.phone &&
      currentAppointmentDetails.email &&
      currentAppointmentDetails.appointmentDate &&
      currentAppointmentDetails.appointmentTime &&
      currentAppointmentDetails.reason
    );
  }

  async function maybeStartBookingFlow() {
    if (bookingCompleted || bookingFlowStarted) return;
    if (!hasRequiredBookingInfo() || !bookingConfirmed) return;

    bookingFlowStarted = true;
    logger.info('BOOKING_STARTED', {
      name: currentAppointmentDetails.name,
      email: currentAppointmentDetails.email,
      phone: currentAppointmentDetails.phone,
      appointmentDate: currentAppointmentDetails.appointmentDate,
      appointmentTime: currentAppointmentDetails.appointmentTime,
      reason: currentAppointmentDetails.reason,
    });

    await submitBookingWebhook();
  }

  async function handleBookingConfirmation({ confirmation, transcript }) {
    const stateSnapshot = buildBookingStateSnapshot();
    const missingFieldsInput = { ...currentAppointmentDetails };
    const missingFields = getMissingBookingFieldsFor(missingFieldsInput);

    logger.info('BOOKING_CONFIRMATION_STATE_TRACE', {
      transcript,
      bookingState: stateSnapshot.bookingState,
      sessionState: stateSnapshot.sessionState,
      fieldSources: stateSnapshot.fieldSources,
      lastStructuredSyncAt: stateSnapshot.sessionState.lastStructuredSyncAt,
      lastStructuredSyncCallId: stateSnapshot.sessionState.lastStructuredSyncCallId,
      lastStructuredSyncPayload: stateSnapshot.sessionState.lastStructuredSyncPayload,
      missingFieldsInput,
      expectedStateObject: 'currentAppointmentDetails',
      objectsWithRequiredFields: listObjectsContainingRequiredFields(stateSnapshot),
    });

    logger.info('Entering booking confirmation handler', {
      transcript,
      confirmationDetected: confirmation,
      hasRequiredBookingInfo: hasRequiredBookingInfo(),
      bookingConfirmed,
      missingFields,
    });

    if (!confirmation) return;

    if (!hasRequiredBookingInfo()) {
      logger.warn('Confirmation received but required booking info is missing', {
        missingFields,
        bookingState: stateSnapshot.bookingState,
        sessionState: stateSnapshot.sessionState,
        fieldSources: stateSnapshot.fieldSources,
        expectedStateObject: 'currentAppointmentDetails',
          rootCauseHint: 'Structured booking sync payload did not provide all required fields.',
      });
      return;
    }

    if (bookingConfirmed) return;

    bookingConfirmed = true;
    logger.info('Booking details confirmed by caller');
    await maybeStartBookingFlow();
  }

  function maybeAnnounceSummary() {
    if (!hasRequiredBookingInfo() || bookingSummaryAnnounced) return;
    bookingSummaryAnnounced = true;

    openai.sendTextInstruction(
      `I have the following details: ${currentAppointmentDetails.name}, phone number ${formatPhoneForSpeech(currentAppointmentDetails.phone)}, email ${currentAppointmentDetails.email}, appointment date ${currentAppointmentDetails.appointmentDate}, appointment time ${currentAppointmentDetails.appointmentTime}, and reason ${currentAppointmentDetails.reason}. Shall I confirm your appointment?`
    );
  }

  async function submitBookingWebhook() {
    const payload = {
      name: currentAppointmentDetails.name,
      phone: currentAppointmentDetails.phone,
      email: currentAppointmentDetails.email,
      appointment_date: currentAppointmentDetails.appointmentDate,
      appointment_time: currentAppointmentDetails.appointmentTime,
      reason: currentAppointmentDetails.reason,
    };

    logger.info('BOOKING_WEBHOOK_REQUEST', { url: bookingWebhookUrl, payload });

    try {
      logger.info(`Calling n8n booking webhook: ${bookingWebhookUrl}`);
      logger.info('BOOKING_WEBHOOK_PRE_POST', {
        url: bookingWebhookUrl,
        payload,
      });
      const response = await fetch(bookingWebhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      logger.info(`Webhook response status: ${response.status}`);

      const contentType = response.headers.get('content-type') || '';
      const responseBody = contentType.includes('application/json')
        ? await response.json()
        : await response.text();

      if (!response.ok) {
        const message = extractWebhookError(responseBody) || `HTTP ${response.status}`;
        throw new Error(message);
      }

      if (typeof responseBody === 'object' && responseBody && responseBody.success === false) {
        throw new Error(responseBody.error || responseBody.message || 'Webhook returned unsuccessful response');
      }

      bookingCompleted = true;
      logger.info('BOOKING_COMPLETED', { responseStatus: response.status });
      logger.info('Goodbye initiated', { reason: 'booking completed via webhook' });
      openai.sendTextInstruction(
        'Your appointment has been confirmed. You\'ll receive your confirmation shortly.'
      );
    } catch (err) {
      bookingFlowStarted = false;
      bookingConfirmed = false;
      logger.error(`Webhook error: ${err.message}`);
      logger.error('BOOKING_WEBHOOK_FAILED', { error: err.message });
      openai.sendTextInstruction(
        `I\'m sorry, I couldn\'t confirm the appointment just now. ${err.message}. Please try again in a moment.`
      );
    }
  }

  function formatPhoneForSpeech(phone) {
    return phone.replace(/(\d)/g, '$1 ').trim();
  }

  function extractWebhookError(responseBody) {
    if (!responseBody) return null;
    if (typeof responseBody === 'string') return responseBody.trim() || null;
    if (typeof responseBody.error === 'string' && responseBody.error.trim()) return responseBody.error.trim();
    if (typeof responseBody.message === 'string' && responseBody.message.trim()) return responseBody.message.trim();
    return null;
  }

  function getMissingBookingFields() {
    return getMissingBookingFieldsFor(currentAppointmentDetails);
  }

  function getMissingBookingFieldsFor(details) {
    const missing = [];
    if (!details.name) missing.push('name');
    if (!details.phone) missing.push('phone');
    if (!details.email) missing.push('email');
    if (!details.appointmentDate) missing.push('appointmentDate');
    if (!details.appointmentTime) missing.push('appointmentTime');
    if (!details.reason) missing.push('reason');
    return missing;
  }

  function setBookingField(field, value, source) {
    if (value == null) return false;
    const normalized = typeof value === 'string' ? value.trim() : value;
    if (!normalized) return false;
    if (currentAppointmentDetails[field] === normalized) return false;
    currentAppointmentDetails[field] = normalized;
    bookingFieldSources[field] = source;
    return true;
  }

  function applyStructuredBookingState({ payload, callId, sourceObjectName }) {
    const normalizedPayload = normalizeStructuredBookingPayload(payload || {});
    const destinationBefore = { ...currentAppointmentDetails };
    const appliedFields = [];

    if (setBookingField('name', normalizedPayload.name, 'assistant_tool')) appliedFields.push('name');
    if (setBookingField('phone', normalizedPayload.phone, 'assistant_tool')) appliedFields.push('phone');
    if (setBookingField('email', normalizedPayload.email, 'assistant_tool')) appliedFields.push('email');
    if (setBookingField('appointmentDate', normalizedPayload.appointmentDate, 'assistant_tool')) appliedFields.push('appointmentDate');
    if (setBookingField('appointmentTime', normalizedPayload.appointmentTime, 'assistant_tool')) appliedFields.push('appointmentTime');
    if (setBookingField('reason', normalizedPayload.reason, 'assistant_tool')) appliedFields.push('reason');

    if (appliedFields.length) {
      bookingSummaryAnnounced = false;
    }

    lastStructuredSyncAt = new Date().toISOString();
    lastStructuredSyncCallId = callId || null;
    lastStructuredSyncPayload = normalizedPayload;

    logFieldMapping({
      sourceObjectName,
      source: normalizedPayload,
      destinationBefore,
      destinationAfter: { ...currentAppointmentDetails },
    });

    logger.info('STRUCTURED_BOOKING_SYNC_APPLIED', {
      callId,
      appliedFields,
      hasRequiredBookingInfo: hasRequiredBookingInfo(),
      bookingState: currentAppointmentDetails,
      missingFields: getMissingBookingFields(),
    });

    return appliedFields;
  }

  function normalizeStructuredBookingPayload(payload) {
    return {
      name: normalizeBookingString(payload.name),
      phone: normalizePhone(payload.phone),
      email: normalizeEmail(payload.email),
      appointmentDate: normalizeBookingString(payload.appointmentDate),
      appointmentTime: normalizeBookingString(payload.appointmentTime),
      reason: normalizeBookingString(payload.reason),
    };
  }

  function normalizeBookingString(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
  }

  function normalizePhone(value) {
    if (typeof value !== 'string') return null;
    const cleaned = value.replace(/[^\d]/g, '');
    return cleaned || null;
  }

  function normalizeEmail(value) {
    if (typeof value !== 'string') return null;
    return value.trim().toLowerCase() || null;
  }

  function logFieldMapping({ sourceObjectName, source, destinationBefore, destinationAfter }) {
    logger.info('FIELD_MAPPING', {
      stage: 'ai_extraction_to_booking_state',
      extractionSourceObject: sourceObjectName,
      synchronizationReadObject: sourceObjectName,
      confirmationValidationObject: 'currentAppointmentDetails',
      name: {
        source: source.name,
        destinationBefore: destinationBefore.name,
        destination: destinationAfter.name,
      },
      phone: {
        source: source.phone,
        destinationBefore: destinationBefore.phone,
        destination: destinationAfter.phone,
      },
      email: {
        source: source.email,
        destinationBefore: destinationBefore.email,
        destination: destinationAfter.email,
      },
      appointmentDate: {
        source: source.appointmentDate,
        destinationBefore: destinationBefore.appointmentDate,
        destination: destinationAfter.appointmentDate,
      },
      appointmentTime: {
        source: source.appointmentTime,
        destinationBefore: destinationBefore.appointmentTime,
        destination: destinationAfter.appointmentTime,
      },
      reason: {
        source: source.reason,
        destinationBefore: destinationBefore.reason,
        destination: destinationAfter.reason,
      },
    });
  }

  function buildBookingStateSnapshot() {
    return {
      bookingState: {
        ...currentAppointmentDetails,
      },
      sessionState: {
        connectionId,
        streamSid,
        callSid,
        closed,
        bookingSummaryAnnounced,
        appointmentDetailsCollected,
        bookingConfirmed,
        bookingFlowStarted,
        bookingCompleted,
        lastStructuredSyncAt,
        lastStructuredSyncCallId,
        lastStructuredSyncPayload,
      },
      fieldSources: {
        ...bookingFieldSources,
      },
    };
  }

  function listObjectsContainingRequiredFields(stateSnapshot) {
    const objects = [];
    if (getMissingBookingFieldsFor(stateSnapshot.bookingState).length === 0) {
      objects.push('currentAppointmentDetails');
    }
    return objects;
  }

  function scheduleDisconnectIfNeeded() {
    if (disconnectScheduled || !streamSid || !finalGoodbyeDetected || !bookingCompleted) return;
    disconnectScheduled = true;
    setTimeout(() => {
      if (closed) return;
      logger.info('Twilio disconnect initiated after final goodbye');
      cleanup(1000, 'assistant goodbye');
    }, 1500);
  }
}

module.exports = { handleTwilioConnection };
