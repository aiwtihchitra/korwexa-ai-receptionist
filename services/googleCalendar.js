'use strict';

const { google } = require('googleapis');
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

async function checkAvailability({ clientId, clientSecret, redirectUri, business, calendarId = 'primary', timeMin, timeMax }) {
  const calendar = await ensureCalendarClient({ clientId, clientSecret, redirectUri, business });
  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      items: [{ id: calendarId }],
    },
  });
  const busy = response.data.calendars[calendarId]?.busy || [];
  return busy.length === 0 ? 'available' : 'busy';
}

async function createAppointment({ clientId, clientSecret, redirectUri, business, calendarId = 'primary', summary, description, start, end, guests = [] }) {
  const calendar = await ensureCalendarClient({ clientId, clientSecret, redirectUri, business });
  const event = {
    summary,
    description,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
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
  createAppointment,
  updateAppointment,
  cancelAppointment,
};
