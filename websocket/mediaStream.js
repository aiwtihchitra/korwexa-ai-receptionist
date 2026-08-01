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
const { DateTime } = require('luxon');
const {
  checkAvailability,
  createAppointment,
  getAvailabilitySlots,
  updateAppointment,
} = require('../services/googleCalendar');
const { sendConfirmationEmail } = require('../services/emailService');
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
  let goodbyeAudioFinished = false;
  let disconnectScheduled = false;
  let autoContinueTimer = null;
  let awaitingAutoContinue = false;
  let autoContinueSent = false;
  let availableSlots = [];
  let selectedSlot = null;
  let eventId = null;
  let bookingConfirmed = false;
  let bookingSummaryAnnounced = false;
  let currentAppointmentDetails = {
    name: null,
    email: null,
    phone: null,
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

    if (finalGoodbyeDetected && !disconnectScheduled) {
      disconnectScheduled = true;
      setTimeout(() => {
        if (closed) return;
        logger.info('Final goodbye audio finished, closing Twilio call');
        cleanup(1000, 'assistant goodbye');
      }, 1000);
    }
  });

  openai.on('speech.started', () => {
    // Barge-in: user started talking while assistant was speaking.
    // Cancel the model response and clear any queued audio at Twilio.
    logger.debug('User speech detected — cancelling assistant response');
    openai.cancelResponse();
    if (streamSid) twilioSend({ event: 'clear', streamSid });
  });

  openai.on('transcript', ({ role, text, partial }) => {
    if (!partial) {
      logger.info('transcript', { role, text });

      if (role === 'assistant') {
        if (!autoContinueSent && /please allow me a moment while I check/i.test(text)) {
          awaitingAutoContinue = true;
          scheduleAutoContinue();
        }

        if (!finalGoodbyeDetected && /have a wonderful day\. goodbye\.|we look forward to seeing you\.?\s*goodbye\./i.test(text)) {
          finalGoodbyeDetected = true;
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

  function scheduleAutoContinue() {
    if (autoContinueTimer || !awaitingAutoContinue || autoContinueSent) return;
    autoContinueTimer = setTimeout(async () => {
      autoContinueTimer = null;
      if (closed || !streamSid || !awaitingAutoContinue) return;
      awaitingAutoContinue = false;
      autoContinueSent = true;
      logger.info('Auto-continuing after moment pause');
      await offerAvailableSlots();
    }, 1500);
  }

  async function offerAvailableSlots() {
    selectedSlot = null;
    bookingSummaryAnnounced = false;
    bookingConfirmed = false;
    eventId = null;

    const redirectUri = getGoogleRedirectUri();
    const business = config.openai.businessName;
    const now = DateTime.now().setZone(config.businessTimeZone);
    const dayStart = now
      .startOf('day')
      .set({ hour: config.booking.dayStartHour, minute: 0, second: 0, millisecond: 0 });
    const start = now > dayStart ? now : dayStart;
    const end = dayStart
      .plus({ days: config.booking.daysAhead })
      .set({ hour: config.booking.dayEndHour, minute: 0, second: 0, millisecond: 0 });

    logger.info('Requesting Google Calendar availability', {
      business,
      start: start.toISO(),
      end: end.toISO(),
      timeZone: config.businessTimeZone,
    });

    let slots;
    try {
      slots = await getAvailabilitySlots({
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        redirectUri,
        business,
        calendarId: 'primary',
        start: start.toJSDate(),
        end: end.toJSDate(),
        slotMinutes: config.booking.slotMinutes,
        timeZone: config.businessTimeZone,
      });
    } catch (err) {
      logger.error('Google Calendar availability request failed', { error: err.message, business });
      openai.sendTextInstruction(
        'I\'m sorry, I can\'t access the calendar right now. Please let me know the date and time you need, and I will follow up once the calendar connection is restored.'
      );
      return;
    }

    availableSlots = slots;
    logger.info('Available slots', { availableSlots: availableSlots.map((slot) => slot.label) });

    if (!availableSlots.length) {
      openai.sendTextInstruction(
        'Thank you for waiting. I checked the calendar and it looks like there are no available slots in the next few days. Would another day work for you?'
      );
      return;
    }

    const slotText = availableSlots.slice(0, 3).map((slot) => slot.label).join(' and ');
    openai.sendTextInstruction(
      `Thank you for waiting. I checked the doctor's availability, and these times are open: ${slotText}. Which time works best for you?`
    );
  }

  function getCandidateSlots() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    const buildSlot = (hour, minute) => {
      const start = new Date(tomorrow);
      start.setHours(hour, minute, 0, 0);
      const end = new Date(start.getTime() + 30 * 60 * 1000);
      return {
        label: start.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }).replace(/\u202F/g, ' '),
        start,
        end,
      };
    };

    return [buildSlot(10, 30), buildSlot(15, 0)];
  }

  function getGoogleRedirectUri() {
    const basePath = getRequestBasePath();
    if (config.publicHostname && config.publicHostname.trim()) {
      return `https://${config.publicHostname}${basePath}/auth/google/callback`;
    }
    return `http://localhost:${config.port}${basePath}/auth/google/callback`;
  }

  function getRequestBasePath() {
    const path = (req.url || '').split('?')[0];
    return path.startsWith('/api/') ? '/api' : '';
  }

  function handleUserTranscript(text) {
    const normalized = text.trim();
    const name = parseName(normalized);
    const email = parseEmail(normalized);
    const phoneFragment = parsePhoneFragment(normalized);
    const reason = parseReason(normalized);
    const selected = parseSelectedSlot(normalized);
    const confirmation = parseConfirmation(normalized);

    if (name) {
      currentAppointmentDetails.name = name;
      logger.debug('Captured name from user transcript', { name });
    }
    if (email) {
      currentAppointmentDetails.email = email;
      logger.debug('Captured email from user transcript', { email });
    }
    if (phoneFragment) {
      const cleaned = phoneFragment.replace(/[^\d]/g, '');
      currentAppointmentDetails.phone = cleaned;
      logger.debug('Captured phone fragment from user transcript', { phone: currentAppointmentDetails.phone });
    }
    if (reason) {
      currentAppointmentDetails.reason = reason;
      logger.debug('Captured reason for visit from user transcript', { reason });
    }
    if (selected && !selectedSlot) {
      selectedSlot = selected;
      logger.info('Caller selected an available slot', { slot: selectedSlot.label });
      maybeAnnounceSummary();
    }
    if (confirmation && selectedSlot && !bookingConfirmed) {
      bookingConfirmed = true;
      confirmAppointment();
    }
    if (eventId) {
      updateExistingAppointment();
    }
  }

  function parseName(text) {
    const match = text.match(/(?:my name is|this is|I am|I'm|it\'s)\s+([A-Za-z][A-Za-z\s'-]{1,60})/i);
    return match ? match[1].trim() : null;
  }

  function parseEmail(text) {
    const match = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/i);
    return match ? match[0].trim() : null;
  }

  function parsePhoneFragment(text) {
    const match = text.match(/(\+?\d[\d\s().-]{7,}\d)/);
    return match ? match[0].trim() : null;
  }

  function parseReason(text) {
    const match = text.match(/reason(?: for visit)? is\s+([A-Za-z0-9\s,'-]+)/i);
    if (match) return match[1].trim();
    return null;
  }

  function parseSelectedSlot(text) {
    if (!availableSlots.length) return null;
    const match = text.match(/(\d{1,2}(?::\d{2})?)\s*(am|pm)/i);
    if (!match) return null;
    const normalized = match[0].toLowerCase();
    return availableSlots.find((slot) => slot.label.toLowerCase().includes(normalized)) || null;
  }

  function parseConfirmation(text) {
    return /\b(yes|confirm|sure|please do|that sounds good)\b/i.test(text);
  }

  async function maybeAnnounceSummary() {
    if (!selectedSlot || bookingSummaryAnnounced) return;
    bookingSummaryAnnounced = true;

    openai.sendTextInstruction(
      `I have the following details: ${currentAppointmentDetails.name || 'no name yet'}, for ${selectedSlot.label}, phone number ${formatPhoneForSpeech(currentAppointmentDetails.phone || 'not provided')}, email ${currentAppointmentDetails.email || 'not provided'}, and reason ${currentAppointmentDetails.reason || 'not provided'}. Shall I confirm your appointment?`
    );
  }

  async function confirmAppointment() {
    if (!selectedSlot || !bookingConfirmed || eventId) return;
    const redirectUri = getGoogleRedirectUri();
    const business = config.openai.businessName;
    const summary = `Appointment - ${currentAppointmentDetails.name || 'Patient'}`;
    const description = [`Patient Name: ${currentAppointmentDetails.name || 'N/A'}`];
    description.push(`Phone Number: ${currentAppointmentDetails.phone || 'N/A'}`);
    description.push(`Email Address: ${currentAppointmentDetails.email || 'N/A'}`);
    description.push(`Reason for Visit: ${currentAppointmentDetails.reason || 'N/A'}`);
    description.push('Booked via Korwexa AI Receptionist');

    try {
      const event = await createAppointment({
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        redirectUri,
        business,
        calendarId: 'primary',
        summary,
        description: description.join('\n'),
        start: selectedSlot.start,
        end: selectedSlot.end,
        guests: currentAppointmentDetails.email ? [currentAppointmentDetails.email] : [],
        timeZone: config.businessTimeZone,
      });
      eventId = event.id;
      logger.info('Appointment created', {
        eventId,
        slot: selectedSlot.label,
        business,
      });

      if (currentAppointmentDetails.email) {
        await sendEmailConfirmation();
      } else {
        const patientName = currentAppointmentDetails.name || 'Patient';
        const date = selectedSlot.start.toLocaleDateString('en-US', {
          timeZone: config.businessTimeZone,
        });
        const time = selectedSlot.start.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          timeZone: config.businessTimeZone,
        });

        logger.info('Appointment confirmed without email address', { eventId, patientName, date, time });
        openai.sendTextInstruction(
          `Your appointment has been confirmed for ${date} at ${time}. I do not have an email address to send confirmation to yet. If you would like a confirmation email, please provide your email address now.`
        );
      }
    } catch (err) {
      logger.error('Failed to create calendar appointment', { error: err.message, business });
      openai.sendTextInstruction(
        'I\'m sorry, I couldn\'t book that appointment at the moment. Can I try again or would you like a different time?'
      );
    }
  }

  async function sendEmailConfirmation() {
    const patientName = currentAppointmentDetails.name || 'Patient';
    const date = selectedSlot.start.toLocaleDateString('en-US', {
      timeZone: config.businessTimeZone,
    });
    const time = selectedSlot.start.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: config.businessTimeZone,
    });
    const reason = currentAppointmentDetails.reason || 'N/A';

    try {
      const emailResult = await sendConfirmationEmail({
        to: currentAppointmentDetails.email,
        patientName,
        date,
        time,
        reason,
      });
      logger.info('Confirmation email sent', { emailResult, eventId });
      openai.sendTextInstruction(
        `Your appointment has been confirmed for ${date} at ${time}. A confirmation email has been sent to ${currentAppointmentDetails.email}. We look forward to seeing you. Have a wonderful day. Goodbye.`
      );
    } catch (err) {
      logger.error('Confirmation email failed', { error: err.message, eventId });
      openai.sendTextInstruction(
        `Your appointment has been confirmed for ${date} at ${time}. I was unable to send the confirmation email, but your booking is complete. We look forward to seeing you. Have a wonderful day. Goodbye.`
      );
    }
  }

  function formatPhoneForSpeech(phone) {
    return phone.replace(/(\d)/g, '$1 ').trim();
  }

  async function updateExistingAppointment() {
    if (!eventId) return;
    const redirectUri = getGoogleRedirectUri();
    const business = config.openai.businessName;
    const updates = {};

    if (currentAppointmentDetails.email) {
      updates.attendees = [{ email: currentAppointmentDetails.email }];
    }
    if (currentAppointmentDetails.name || currentAppointmentDetails.phone || currentAppointmentDetails.email || currentAppointmentDetails.reason) {
      const description = [`Patient Name: ${currentAppointmentDetails.name || 'N/A'}`];
      description.push(`Phone Number: ${currentAppointmentDetails.phone || 'N/A'}`);
      description.push(`Email Address: ${currentAppointmentDetails.email || 'N/A'}`);
      description.push(`Reason for Visit: ${currentAppointmentDetails.reason || 'N/A'}`);
      description.push('Booked via Korwexa AI Receptionist');
      updates.description = description.join('\n');
    }

    if (!Object.keys(updates).length) return;

    try {
      await updateAppointment({
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        redirectUri,
        business,
        calendarId: 'primary',
        eventId,
        updates,
      });
      logger.info('Updated existing calendar appointment', { eventId });
    } catch (err) {
      logger.error('Failed to update calendar appointment', { error: err.message, business });
    }
  }

  function scheduleDisconnectIfNeeded() {
    if (disconnectScheduled || !streamSid || !finalGoodbyeDetected) return;
    disconnectScheduled = true;
    setTimeout(() => {
      if (closed) return;
      logger.info('Final goodbye detected, closing Twilio call automatically');
      cleanup(1000, 'assistant goodbye');
    }, 1200);
  }
}

module.exports = { handleTwilioConnection };
