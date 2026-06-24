require('dotenv').config();
const { google } = require('googleapis');
const {
  getSetting, upsertSetting, deleteSetting, updateTaskEventId,
  getTaskByEventId, insertCalendarTask, updateTaskFromCalendar, deleteTaskByEventId,
  getTasksByDate, syncDayLog,
} = require('./db');

// Injected by server.js after both modules load — avoids circular dependency
let _sendMessage = () => Promise.resolve();
function setMessageSender(fn) { _sendMessage = fn; }

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

// ── webhook watch management ──────────────────────────────────────────────────

async function setupCalendarWatch(serverUrl) {
  if (!serverUrl || serverUrl.includes('localhost')) {
    console.log('[calendar] Skipping webhook setup — no public URL');
    return null;
  }
  const cal        = google.calendar({ version: 'v3', auth: getClient() });
  const calRow     = getSetting.get('google_calendar_id');
  const calendarId = calRow ? calRow.value : 'primary';

  // Stop existing channel first
  await stopCalendarWatch().catch(() => {});

  const res = await cal.events.watch({
    calendarId,
    requestBody: {
      id:         `daywan-channel-${Date.now()}`,
      type:       'web_hook',
      address:    `${serverUrl}/api/calendar/webhook`,
      token:      process.env.GOOGLE_WEBHOOK_TOKEN || 'daywan-secret',
      expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  const channel = {
    id:         res.data.id,
    resourceId: res.data.resourceId,
    expiration: res.data.expiration,
    created_at: Date.now(),
  };
  upsertSetting.run('google_watch_channel', JSON.stringify(channel));
  console.log(`[calendar] Watch channel registered: ${channel.id}`);
  return channel;
}

async function stopCalendarWatch() {
  const row = getSetting.get('google_watch_channel');
  if (!row) return;
  const channel = JSON.parse(row.value);
  try {
    const cal = google.calendar({ version: 'v3', auth: getClient() });
    await cal.channels.stop({
      requestBody: { id: channel.id, resourceId: channel.resourceId },
    });
  } catch (err) {
    console.warn('[calendar] Stop watch warning:', err.message);
  }
  deleteSetting.run('google_watch_channel');
}

async function renewCalendarWatch(serverUrl) {
  console.log('[calendar] Renewing watch channel');
  await stopCalendarWatch().catch(() => {});
  return setupCalendarWatch(serverUrl);
}

// ── incremental sync ──────────────────────────────────────────────────────────

async function getChangedEvents(syncToken) {
  const cal        = google.calendar({ version: 'v3', auth: getClient() });
  const calRow     = getSetting.get('google_calendar_id');
  const calendarId = calRow ? calRow.value : 'primary';

  const params = {
    calendarId,
    singleEvents: true,
    showDeleted:  true,
  };

  if (syncToken) {
    params.syncToken = syncToken;
  } else {
    const today = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
    params.timeMin = `${today}T00:00:00+01:00`;
    params.orderBy = 'startTime';
  }

  try {
    const res = await cal.events.list(params);
    if (res.data.nextSyncToken) {
      upsertSetting.run('google_sync_token', res.data.nextSyncToken);
    }
    return res.data.items || [];
  } catch (err) {
    if (err.code === 410) {
      // Sync token expired — full re-sync
      deleteSetting.run('google_sync_token');
      return getChangedEvents(null);
    }
    throw err;
  }
}

// ── event → task processing ───────────────────────────────────────────────────

function _detectBusiness(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  if (/blok|arkad|investor|pitch|fundrais/.test(text))          return 'blok';
  if (/aphl|depot|candy|haulage|petroleum|loading/.test(text))  return 'aphl';
  if (/tradesol|trade|agent|commerce/.test(text))               return 'trade';
  return 'personal';
}

async function processCalendarEvent(event) {
  if (event.status === 'cancelled') {
    const task = getTaskByEventId.get(event.id);
    if (task && task.calendar_source === 'google') {
      deleteTaskByEventId.run(event.id);
      syncDayLog(task.date);
      _sendMessage(
        `Calendar event deleted — task removed:\n[${task.business.toUpperCase()}] ${task.name}`
      ).catch(() => {});
    }
    return;
  }

  const title     = event.summary || '(no title)';
  const dateRaw   = event.start?.dateTime || event.start?.date || '';
  const date      = dateRaw.slice(0, 10);
  if (!date) return;

  const startTime = watHHMM(event.start?.dateTime) || null;
  const business  = _detectBusiness(title, event.description || '');
  const existing  = getTaskByEventId.get(event.id);

  if (existing) {
    updateTaskFromCalendar.run(title, startTime, date, event.id);
    syncDayLog(date);
    _sendMessage(
      `Calendar event updated — task updated:\n` +
      `[${business.toUpperCase()}] ${title}` +
      (startTime ? ` — ${date} at ${startTime}` : '')
    ).catch(() => {});
  } else {
    insertCalendarTask.run(date, title, business, startTime, event.id);
    syncDayLog(date);
    const allTasks = getTasksByDate.all(date);
    const taskNum  = allTasks.findIndex(t => t.calendar_event_id === event.id) + 1;
    _sendMessage(
      `New calendar event — task added:\n` +
      `[${business.toUpperCase()}] ${title}` +
      (startTime ? ` — ${date} at ${startTime}` : '') +
      (taskNum > 0 ? `\n\n/done ${taskNum} to mark complete when done.` : '')
    ).catch(() => {});
  }
}

module.exports = {
  setMessageSender,
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
  setupCalendarWatch,
  stopCalendarWatch,
  renewCalendarWatch,
  getChangedEvents,
  processCalendarEvent,
};
