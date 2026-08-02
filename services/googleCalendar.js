'use strict';

const { google } = require('googleapis');
const { DateTime } = require('luxon');
const { getToken, saveToken } = require('./googleTokenStore');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
];

function createOAuthClient({ clientId, clientSecret, redirectUri }) {
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function getAuthUrl({ clientId, clientSecret, redirectUri, business }) {
  const oauth2Client = createOAuthClient({ clientId, clientSecret, redirectUri });
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: business,
  });
}

async function exchangeCode({ clientId, clientSecret, redirectUri, code, business }) {
  const oauth2Client = createOAuthClient({ clientId, clientSecret, redirectUri });
  const { tokens } = await oauth2Client.getToken(code);
  saveToken(business, tokens, clientSecret);
  return tokens;
}

function getOAuthClientForBusiness({ clientId, clientSecret, redirectUri, business }) {
  const oauth2Client = createOAuthClient({ clientId, clientSecret, redirectUri });
  const token = getToken(business, clientSecret);
  if (!token) return null;
  oauth2Client.setCredentials(token);
  oauth2Client.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
      saveToken(business, { ...token, ...tokens }, clientSecret);
    }
  });
  return oauth2Client;
}

async function ensureCalendarClient({ clientId, clientSecret, redirectUri, business }) {
  const oauth2Client = getOAuthClientForBusiness({ clientId, clientSecret, redirectUri, business });
  if (!oauth2Client) {
    throw new Error(`No Google Calendar credentials found for business ${business}`);
  }
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  return calendar;
}

function hasBusinessCalendarConnection({ clientId, clientSecret, redirectUri, business }) {
  return Boolean(getOAuthClientForBusiness({ clientId, clientSecret, redirectUri, business }));
}

async function checkAvailability({ clientId, clientSecret, redirectUri, business, calendarId = 'primary', timeMin, timeMax, logger }) {
  const calendar = await ensureCalendarClient({ clientId, clientSecret, redirectUri, business });
  if (logger) logger.info('Google OAuth credentials loaded', { business });
  if (logger) logger.info('Google freebusy query started', { business, timeMin, timeMax, calendarId });
  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      items: [{ id: calendarId }],
    },
  });
  const busy = response.data.calendars[calendarId]?.busy || [];
  if (logger) logger.info('Google freebusy query response received', { business, busyCount: busy.length, calendarId });
  return busy.length === 0 ? 'available' : 'busy';
}

async function getAvailabilitySlots({ clientId, clientSecret, redirectUri, business, calendarId = 'primary', start, end, slotMinutes, dayStartHour = 9, dayEndHour = 17, timeZone, logger }) {
  const calendar = await ensureCalendarClient({ clientId, clientSecret, redirectUri, business });
  if (logger) logger.info('Google OAuth credentials loaded', { business });
  const startDt = start instanceof Date ? DateTime.fromJSDate(start, { zone: timeZone }) : DateTime.fromISO(start, { zone: timeZone });
  const endDt = end instanceof Date ? DateTime.fromJSDate(end, { zone: timeZone }) : DateTime.fromISO(end, { zone: timeZone });
  const now = DateTime.now().setZone(timeZone);

  if (logger) logger.info('Google freebusy query started', { business, start: startDt.toISO(), end: endDt.toISO(), calendarId });
  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin: startDt.toISO(),
      timeMax: endDt.toISO(),
      items: [{ id: calendarId }],
    },
  });
  const busy = response.data.calendars[calendarId]?.busy || [];
  if (logger) logger.info('Google freebusy query response received', { business, busyCount: busy.length, calendarId });

  const slots = [];
  let dayCursor = startDt.startOf('day');

  while (dayCursor <= endDt.startOf('day')) {
    const workStart = dayCursor.set({ hour: dayStartHour, minute: 0, second: 0, millisecond: 0 });
    const workEnd = dayCursor.set({ hour: dayEndHour, minute: 0, second: 0, millisecond: 0 });
    const windowStart = startDt > workStart ? startDt : workStart;
    const windowEnd = endDt < workEnd ? endDt : workEnd;

    let cursor = windowStart;
    while (cursor.plus({ minutes: slotMinutes }) <= windowEnd) {
      const slotEnd = cursor.plus({ minutes: slotMinutes });
      if (slotEnd <= now) {
        cursor = slotEnd;
        continue;
      }

      const overlapping = busy.some((busyInterval) => {
        const busyStart = DateTime.fromISO(busyInterval.start).setZone(timeZone);
        const busyEnd = DateTime.fromISO(busyInterval.end).setZone(timeZone);
        return cursor < busyEnd && slotEnd > busyStart;
      });

      if (!overlapping) {
        const timeLabel = cursor.setLocale('en-US').toLocaleString(DateTime.TIME_SIMPLE);
        const dateLabel = cursor.hasSame(now, 'day') ? '' : `${cursor.toLocaleString(DateTime.DATE_MED)} at `;
        const label = `${dateLabel}${timeLabel}`.trim();
        slots.push({ start: cursor.toJSDate(), end: slotEnd.toJSDate(), label });
      }

      cursor = slotEnd;
    }

    dayCursor = dayCursor.plus({ days: 1 });
  }

  return slots;
}

async function createAppointment({ clientId, clientSecret, redirectUri, business, calendarId = 'primary', summary, description, start, end, guests = [], timeZone }) {
  const calendar = await ensureCalendarClient({ clientId, clientSecret, redirectUri, business });
  const event = {
    summary,
    description,
    start: { dateTime: start.toISOString(), timeZone },
    end: { dateTime: end.toISOString(), timeZone },
    attendees: guests.map((email) => ({ email })),
    reminders: {
      useDefault: true,
    },
  };
  const response = await calendar.events.insert({
    calendarId,
    requestBody: event,
  });
  return response.data;
}

async function updateAppointment({ clientId, clientSecret, redirectUri, business, calendarId = 'primary', eventId, updates }) {
  const calendar = await ensureCalendarClient({ clientId, clientSecret, redirectUri, business });
  const response = await calendar.events.patch({
    calendarId,
    eventId,
    requestBody: updates,
  });
  return response.data;
}

async function cancelAppointment({ clientId, clientSecret, redirectUri, business, calendarId = 'primary', eventId }) {
  const calendar = await ensureCalendarClient({ clientId, clientSecret, redirectUri, business });
  await calendar.events.delete({ calendarId, eventId });
  return { success: true };
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  checkAvailability,
  getAvailabilitySlots,
  createAppointment,
  updateAppointment,
  cancelAppointment,
  hasBusinessCalendarConnection,
};
