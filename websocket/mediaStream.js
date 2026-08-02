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
  let disconnectScheduled = false;
  let autoContinueTimer = null;
  let awaitingAutoContinue = false;
  let autoContinueSent = false;
  let availableSlots = [];
  let selectedSlot = null;
  let eventId = null;
  let bookingConfirmed = false;
  let bookingSummaryAnnounced = false;
  let appointmentDetailsCollected = false;
  let bookingFlowStarted = false;
  let bookingCompleted = false;
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

    scheduleDisconnectIfNeeded();
  });

  openai.on('transcript', ({ role, text, partial }) => {
    if (!partial) {
      logger.info('transcript', { role, text });

      if (role === 'assistant') {
        if (!autoContinueSent && /please allow me a moment while I check/i.test(text)) {
          awaitingAutoContinue = true;
          scheduleAutoContinue();
        }

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

    logger.info('Booking function entered', { function: 'offerAvailableSlots' });
    logger.info('Business identified', { business });
    logger.info('BOOKING_STARTED', { business, name: currentAppointmentDetails.name, email: currentAppointmentDetails.email, phone: currentAppointmentDetails.phone });
    logger.info('CALENDAR_CHECK_STARTED', {
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
        logger,
      });
      logger.info('Google Calendar API response received', {
        business,
        requestedStart: start.toISO(),
        requestedEnd: end.toISO(),
        slotCount: slots.length,
      });
      logger.info('CALENDAR_AVAILABLE', { business, slotCount: slots.length });
    } catch (err) {
      logger.error('Google Calendar availability request failed', { error: err.message, business });
      openai.sendTextInstruction(
        'I\'m sorry, I am having trouble checking the calendar right now. Can I try again in a moment or would you like a different time?'
      );
      return;
    }

    availableSlots = slots;
    logger.info('Available slots', { availableSlots: availableSlots.map((slot) => slot.label) });

    if (!availableSlots.length) {
      logger.warn('No available slots were found after calendar check', {
        business,
        start: start.toISO(),
        end: end.toISO(),
      });
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
    const selected = parseSelectedSlot(normalized) || parseRequestedSlot(normalized);
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
    if (!appointmentDetailsCollected && currentAppointmentDetails.name && currentAppointmentDetails.email && currentAppointmentDetails.phone) {
      appointmentDetailsCollected = true;
      logger.info('Appointment details collected', {
        name: currentAppointmentDetails.name,
        email: currentAppointmentDetails.email,
        phone: currentAppointmentDetails.phone,
        reason: currentAppointmentDetails.reason || 'not provided',
      });
      maybeStartBookingFlow();
    }
    if (selected) {
      if (!selectedSlot || selectedSlot.label !== selected.label) {
        selectedSlot = selected;
        bookingSummaryAnnounced = false;
        bookingConfirmed = false;
        logger.info('Caller selected an available slot', { slot: selectedSlot.label });
        maybeAnnounceSummary();
        maybeStartBookingFlow();
      }
    }
    if (confirmation && selectedSlot && !bookingConfirmed) {
      bookingConfirmed = true;
      confirmAppointment();
    }
    if (eventId) {
      updateExistingAppointment();
    }

    // Re-check booking flow after processing the latest transcript
    maybeStartBookingFlow().catch((err) => logger.error('maybeStartBookingFlow failed', { error: err.message }));
  }

  function parseName(text) {
    const match = text.match(/(?:my name is|this is|i\'m|i am)\s+([A-Za-z][A-Za-z]+(?:[ '\-][A-Za-z]+){0,3})/i);
    return match ? match[1].trim() : null;
  }

  function parseEmail(text) {
    const match = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/i);
    return match ? match[0].trim() : null;
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
    return match ? match[1].trim() : null;
  }

  function parseSelectedSlot(text) {
    if (!availableSlots.length) return null;
    const match = text.match(/(\d{1,2}(?::\d{2})?)\s*(am|pm)/i);
    if (!match) return null;
    const normalized = match[0].toLowerCase();
    return availableSlots.find((slot) => slot.label.toLowerCase().includes(normalized)) || null;
  }

  function parseRequestedSlot(text) {
    const timeMatch = text.match(/(\d{1,2}(?::\d{2})?)\s*(am|pm)/i);
    if (!timeMatch) return null;

    const dateMatch = text.match(/\b(today|tomorrow|day after tomorrow|next\s+\w+|\w+\s+\d{1,2}(?:st|nd|rd|th)?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i);
    const timeText = timeMatch[0];
    let dateTime;

    if (dateMatch) {
      const dateText = dateMatch[0];
      const parsed = DateTime.fromFormat(`${dateText} ${timeText}`, 'MMMM d yyyy h:mm a', { zone: config.businessTimeZone });
      if (parsed.isValid) {
        dateTime = parsed;
      }
    }

    if (!dateTime) {
      const today = DateTime.now().setZone(config.businessTimeZone);
      const timeParsed = DateTime.fromFormat(timeText, 'h:mm a', { zone: config.businessTimeZone });
      if (timeParsed.isValid) {
        dateTime = today.set({ hour: timeParsed.hour, minute: timeParsed.minute, second: 0, millisecond: 0 });
        if (dateTime < today) {
          dateTime = dateTime.plus({ days: 1 });
        }
      }
    }

    if (!dateTime || !dateTime.isValid) return null;

    const start = dateTime.toJSDate();
    const end = dateTime.plus({ minutes: config.booking.slotMinutes }).toJSDate();
    const label = dateTime.setLocale('en-US').toLocaleString(DateTime.DATETIME_MED);
    return { label, start, end };
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
    return hasCustomerContactDetails() && Boolean(selectedSlot);
  }

  async function maybeStartBookingFlow() {
    if (bookingCompleted) return;

    if (hasRequiredBookingInfo()) {
      if (!bookingFlowStarted) {
        bookingFlowStarted = true;
        logger.info('BOOKING_STARTED', {
          name: currentAppointmentDetails.name,
          email: currentAppointmentDetails.email,
          phone: currentAppointmentDetails.phone,
          slot: selectedSlot.label,
        });
      }
      bookingConfirmed = true;
      await confirmAppointment();
      return;
    }

    if (hasCustomerContactDetails() && !selectedSlot && !availableSlots.length && !bookingFlowStarted) {
      bookingFlowStarted = true;
      logger.info('BOOKING_STARTED', {
        name: currentAppointmentDetails.name,
        email: currentAppointmentDetails.email,
        phone: currentAppointmentDetails.phone,
      });
      await offerAvailableSlots();
    }
  }

  async function maybeAnnounceSummary() {
    if (!selectedSlot || bookingSummaryAnnounced) return;
    bookingSummaryAnnounced = true;

    const missingFields = [];
    if (!currentAppointmentDetails.name) missingFields.push('your full name');
    if (!currentAppointmentDetails.phone) missingFields.push('your phone number');
    if (!currentAppointmentDetails.email) missingFields.push('your email address');

    if (missingFields.length) {
      openai.sendTextInstruction(
        `I have your appointment time as ${selectedSlot.label}. Could you please provide ${missingFields.join(' and ')}?`
      );
      return;
    }

    openai.sendTextInstruction(
      `I have the following details: ${currentAppointmentDetails.name}, for ${selectedSlot.label}, phone number ${formatPhoneForSpeech(currentAppointmentDetails.phone)}, email ${currentAppointmentDetails.email}, and reason ${currentAppointmentDetails.reason || 'not provided'}. Shall I confirm your appointment?`
    );
  }

  async function confirmAppointment() {
    if (!selectedSlot) {
      logger.warn('confirmAppointment exited early', { reason: 'no selected slot' });
      return;
    }
    if (!bookingConfirmed) {
      logger.warn('confirmAppointment exited early', { reason: 'booking not confirmed' });
      return;
    }
    if (eventId) {
      logger.warn('confirmAppointment exited early', { reason: 'appointment already created', eventId });
      return;
    }

    logger.info('Booking function entered', { function: 'confirmAppointment', slot: selectedSlot.label });

    const missingFields = [];
    if (!currentAppointmentDetails.name) missingFields.push('name');
    if (!currentAppointmentDetails.phone) missingFields.push('phone number');
    if (!currentAppointmentDetails.email) missingFields.push('email address');

    if (missingFields.length) {
      bookingConfirmed = false;
      logger.warn('confirmAppointment missing required appointment details', { missingFields });
      openai.sendTextInstruction(
        `Before I book the appointment, I need ${missingFields.join(' and ')}. Could you provide that information?`
      );
      return;
    }

    const redirectUri = getGoogleRedirectUri();
    const business = config.openai.businessName;

    try {
      logger.info('CALENDAR_CHECK_STARTED', {
        business,
        slot: selectedSlot.label,
        timeMin: selectedSlot.start.toISOString(),
        timeMax: selectedSlot.end.toISOString(),
      });
      const slotStatus = await checkAvailability({
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        redirectUri,
        business,
        calendarId: 'primary',
        timeMin: selectedSlot.start.toISOString(),
        timeMax: selectedSlot.end.toISOString(),
        logger,
      });

      logger.info('Checking selected slot availability', {
        business,
        slot: selectedSlot.label,
        status: slotStatus,
      });
      logger.info('Google Calendar availability response received', {
        business,
        slot: selectedSlot.label,
        status: slotStatus,
      });
      if (slotStatus === 'available') {
        logger.info('CALENDAR_AVAILABLE', { business, slot: selectedSlot.label });
      }

      if (slotStatus === 'busy') {
        logger.warn('Selected slot is no longer available', { slot: selectedSlot.label, business });
        await offerNextAvailableSlots('selected slot busy');
        return;
      }
    } catch (err) {
      logger.error('Failed to verify slot availability', { error: err.message, business });
      openai.sendTextInstruction('I am having trouble checking that time with the calendar right now. Can I try a different time?');
      return;
    }

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
        logger,
      });
      eventId = event.id;
      logger.info('Calendar event created', {
        eventId,
        slot: selectedSlot.label,
        business,
      });
      logger.info('CALENDAR_EVENT_CREATED', { eventId, slot: selectedSlot.label, business });

      if (currentAppointmentDetails.email) {
        await sendEmailConfirmation();
      } else {
        bookingCompleted = true;
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
        logger.info('BOOKING_COMPLETED', { eventId, slot: selectedSlot.label, date, time });
        logger.info('Goodbye initiated', { reason: 'booking completed', eventId });
        openai.sendTextInstruction(
          `Your appointment has been successfully booked for ${date} at ${time}. Thank you for choosing our clinic. We look forward to seeing you. Have a wonderful day. Goodbye.`
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
      eventId = eventId || null;
      bookingCompleted = true;
      logger.info('Confirmation email sent', { emailResult, eventId });
      logger.info('EMAIL_SENT', { eventId, emailResult });
      logger.info('BOOKING_COMPLETED', { eventId, slot: selectedSlot.label, date, time });
      logger.info('Goodbye initiated', { reason: 'booking completed', eventId });
      openai.sendTextInstruction(
        `Your appointment has been successfully booked for ${date} at ${time}. A confirmation email has been sent to ${currentAppointmentDetails.email}. We look forward to seeing you. Have a wonderful day. Goodbye.`
      );
    } catch (err) {
      logger.error('Confirmation email failed', { error: err.message, eventId });
      logger.info('Goodbye initiated', { reason: 'booking completed without email', eventId });
      openai.sendTextInstruction(
        `Your appointment has been successfully booked for ${date} at ${time}. I was unable to send the confirmation email, but your booking is complete. We look forward to seeing you. Have a wonderful day. Goodbye.`
      );
    }
  }

  function formatPhoneForSpeech(phone) {
    return phone.replace(/(\d)/g, '$1 ').trim();
  }

  async function offerNextAvailableSlots(reason) {
    const redirectUri = getGoogleRedirectUri();
    const business = config.openai.businessName;
    const now = DateTime.now().setZone(config.businessTimeZone);
    const start = DateTime.fromJSDate(selectedSlot.end, { zone: config.businessTimeZone });
    const end = start.plus({ days: config.booking.daysAhead || 3 });

    logger.info('Requesting next available slots after busy selection', {
      business,
      start: start.toISO(),
      end: end.toISO(),
      reason,
    });

    selectedSlot = null;
    bookingSummaryAnnounced = false;
    bookingConfirmed = false;

    try {
      const slots = await getAvailabilitySlots({
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        redirectUri,
        business,
        calendarId: 'primary',
        start: start.toJSDate(),
        end: end.toJSDate(),
        slotMinutes: config.booking.slotMinutes,
        dayStartHour: config.booking.dayStartHour,
        dayEndHour: config.booking.dayEndHour,
        timeZone: config.businessTimeZone,
        logger,
      });

      availableSlots = slots;
      logger.info('Google Calendar API response received for next available slots', {
        business,
        slotCount: availableSlots.length,
        reason,
      });
    } catch (err) {
      logger.error('Failed to retrieve next available slots', { error: err.message, business });
      openai.sendTextInstruction('I am having trouble checking additional availability right now. Can I try a different time?');
    }
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
