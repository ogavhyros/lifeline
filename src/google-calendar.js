require('dotenv').config();
const { google }          = require('googleapis');
const { getSetting, upsertSetting, updateTaskEventId } = require('./db');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
];

// ── OAuth2 helpers ────────────────────────────────────────────────────────────

function makeOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback'
  );
}

function getAuthUrl() {
  return makeOAuth2Client().generateAuthUrl({
    access_type: 'offline',
    scope:       SCOPES,
    prompt:      'consent',
  });
}

async function exchangeCode(code) {
  const client = makeOAuth2Client();
  const { tokens } = await client.getToken(code);
  upsertSetting.run('google_tokens', JSON.stringify(tokens));
  return tokens;
}

function getClient() {
  const row = getSetting.get('google_tokens');
  if (!row) throw new Error('Not authenticated');
  const stored = JSON.parse(row.value);
  const client = makeOAuth2Client();
  client.setCredentials(stored);
  client.on('tokens', (fresh) => {
    upsertSetting.run('google_tokens', JSON.stringify({ ...stored, ...fresh }));
  });
  return client;
}

// ── WAT time helpers ──────────────────────────────────────────────────────────

function watMidnight(dateStr) {
  // dateStr is YYYY-MM-DD in WAT (UTC+1)
  return {
    start: new Date(`${dateStr}T00:00:00+01:00`).toISOString(),
    end:   new Date(`${dateStr}T23:59:59+01:00`).toISOString(),
  };
}

function watHHMM(isoStr) {
  if (!isoStr || isoStr.length === 10) return '';
  const d = new Date(isoStr);
  const wat = new Date(d.getTime() + 60 * 60 * 1000);
  return String(wat.getUTCHours()).padStart(2, '0') + ':' +
         String(wat.getUTCMinutes()).padStart(2, '0');
}

function mapEvent(e) {
  const startRaw = e.start?.dateTime || e.start?.date || '';
  const endRaw   = e.end?.dateTime   || e.end?.date   || '';
  return {
    id:          e.id,
    title:       e.summary || '(no title)',
    start:       watHHMM(startRaw) || startRaw,
    end:         watHHMM(endRaw)   || endRaw,
    startRaw,
    endRaw,
    description: e.description || '',
    allDay:      !e.start?.dateTime,
  };
}

// ── calendar list ─────────────────────────────────────────────────────────────

async function listCalendars() {
  const cal = google.calendar({ version: 'v3', auth: getClient() });
  const res = await cal.calendarList.list();
  return (res.data.items || []).map(c => ({
    id:      c.id,
    name:    c.summary,
    primary: !!c.primary,
  }));
}

// ── event fetching ────────────────────────────────────────────────────────────

async function getEventsForDate(dateStr) {
  const cal             = google.calendar({ version: 'v3', auth: getClient() });
  const { start, end }  = watMidnight(dateStr);
  const calRow          = getSetting.get('google_calendar_id');
  const calendarId      = calRow ? calRow.value : 'primary';
  const res = await cal.events.list({
    calendarId,
    timeMin:      start,
    timeMax:      end,
    singleEvents: true,
    orderBy:      'startTime',
  });
  return (res.data.items || []).map(mapEvent);
}

async function getTodayEvents() {
  const today = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
  return getEventsForDate(today);
}

async function getEventsForMonth(year, month) {
  const cal         = google.calendar({ version: 'v3', auth: getClient() });
  const calRow      = getSetting.get('google_calendar_id');
  const calendarId  = calRow ? calRow.value : 'primary';
  const mm          = String(month).padStart(2, '0');
  const lastDay     = new Date(year, month, 0).getDate(); // day 0 of next month = last day of this month
  const timeMin     = new Date(`${year}-${mm}-01T00:00:00+01:00`).toISOString();
  const timeMax     = new Date(`${year}-${mm}-${lastDay}T23:59:59+01:00`).toISOString();
  const res = await cal.events.list({
    calendarId,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy:      'startTime',
    maxResults:   500,
  });
  return (res.data.items || []).map(e => ({
    ...mapEvent(e),
    date: (e.start?.dateTime || e.start?.date || '').slice(0, 10),
  }));
}

// ── event creation / update / delete ─────────────────────────────────────────

async function createEvent(title, dateStr, startTime, endTime, description, calendarId) {
  const cal     = google.calendar({ version: 'v3', auth: getClient() });
  const calId   = calendarId || getSetting.get('google_calendar_id')?.value || 'primary';
  const start   = `${dateStr}T${startTime}:00+01:00`;
  const end     = `${dateStr}T${endTime}:00+01:00`;
  const res = await cal.events.insert({
    calendarId: calId,
    requestBody: {
      summary:     title,
      description: description || '',
      start:       { dateTime: start, timeZone: 'Africa/Lagos' },
      end:         { dateTime: end,   timeZone: 'Africa/Lagos' },
    },
  });
  return res.data;
}

async function updateEvent(eventId, updates, calendarId) {
  const cal   = google.calendar({ version: 'v3', auth: getClient() });
  const calId = calendarId || getSetting.get('google_calendar_id')?.value || 'primary';
  const res   = await cal.events.patch({
    calendarId: calId,
    eventId,
    requestBody: updates,
  });
  return res.data;
}

async function deleteEvent(eventId, calendarId) {
  const cal   = google.calendar({ version: 'v3', auth: getClient() });
  const calId = calendarId || getSetting.get('google_calendar_id')?.value || 'primary';
  await cal.events.delete({ calendarId: calId, eventId });
}

// ── task sync ─────────────────────────────────────────────────────────────────

async function syncTaskToCalendar(task) {
  if (!task.time) throw new Error('Task has no scheduled_time');
  const calRow     = getSetting.get('google_calendar_id');
  const calendarId = calRow ? calRow.value : 'primary';

  // Compute end time: 30-minute default
  const [h, m]  = task.time.split(':').map(Number);
  const endMins = h * 60 + m + 30;
  const endTime = String(Math.floor(endMins / 60)).padStart(2, '0') + ':' + String(endMins % 60).padStart(2, '0');

  const title       = `[${task.business.toUpperCase()}] ${task.name}`;
  const description = `DAYWAN task — ${task.business}`;
  const event       = await createEvent(title, task.date, task.time, endTime, description, calendarId);

  updateTaskEventId.run(event.id, task.id);
  return event.id;
}

// ── schedule blocks sync ──────────────────────────────────────────────────────

async function syncBlocksToCalendar(blocks) {
  const cal     = google.calendar({ version: 'v3', auth: getClient() });
  const today   = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);

  // Find or create the DAYWAN Schedule calendar
  let calId = getSetting.get('daywan_calendar_id')?.value;
  if (!calId) {
    const listRes = await cal.calendarList.list();
    const existing = (listRes.data.items || []).find(c => c.summary === 'DAYWAN Schedule');
    if (existing) {
      calId = existing.id;
    } else {
      const created = await cal.calendars.insert({
        requestBody: { summary: 'DAYWAN Schedule', timeZone: 'Africa/Lagos' },
      });
      calId = created.data.id;
    }
    upsertSetting.run('daywan_calendar_id', calId);
  }

  // Delete today's existing events on this calendar to avoid duplicates
  const { start, end } = watMidnight(today);
  const existing = await cal.events.list({
    calendarId: calId, timeMin: start, timeMax: end, singleEvents: true,
  });
  await Promise.all((existing.data.items || []).map(e =>
    cal.events.delete({ calendarId: calId, eventId: e.id }).catch(() => {})
  ));

  // Create one event per block
  let count = 0;
  for (const b of blocks) {
    if (!b.time || !b.end) continue;
    try {
      await cal.events.insert({
        calendarId: calId,
        requestBody: {
          summary:   b.name,
          start:     { dateTime: `${today}T${b.time}:00+01:00`, timeZone: 'Africa/Lagos' },
          end:       { dateTime: `${today}T${b.end}:00+01:00`,  timeZone: 'Africa/Lagos' },
          colorId:   b.biz === 'blok' ? '9' : b.biz === 'aphl' ? '2' : b.biz === 'trade' ? '6' : '1',
        },
      });
      count++;
    } catch { /* skip individual block errors */ }
  }
  return count;
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  getClient,
  listCalendars,
  getTodayEvents,
  getEventsForDate,
  getEventsForMonth,
  createEvent,
  updateEvent,
  deleteEvent,
  syncTaskToCalendar,
  syncBlocksToCalendar,
};
