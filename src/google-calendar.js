// SYNC RULES:
// LIFELINE → Google Calendar: ALL tasks sync outward
// Google Calendar → LIFELINE: ONLY externally created events
// Events created by LIFELINE are tagged with extendedProperties.private.daywan_source = 'daywan'
// (key name kept stable from the pre-rename DAYWAN era — see note near
// isLifelineTaggedEvent below for why it isn't renamed).
// These are never re-imported back into LIFELINE — that's what caused the
// duplicate-task loop (LIFELINE pushes a task out, then reads it back in as new).
//
// MULTI-USER: every function here takes userId as its first argument. Tokens,
// calendar id, sync token, and watch channel are all stored per-user under
// the (user_id, key) settings table — there is no more "the one connected
// account", each user has their own.

require('dotenv').config();
const { google } = require('googleapis');
const {
  db, getSetting, upsertSetting, deleteSetting, updateTaskEventId,
  getTaskByEventId, insertCalendarTask, updateTaskFromCalendar, deleteTaskByEventId,
  getTasksByDate, syncDayLog, getFounderProfile, logTaskInsert,
} = require('./db');

// Injected by server.js after both modules load — avoids circular dependency
// (telegram.js requires this module too). Signature: (userId, text) => Promise.
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

function getAuthUrl(userId) {
  // `state` carries the userId through Google's redirect as a defense-in-depth
  // CSRF check — the callback (server.js) already gets the real userId from
  // the session cookie riding along on the same browser round trip, but
  // cross-checking state against that catches a stale/replayed auth link
  // being completed under a different logged-in session.
  return makeOAuth2Client().generateAuthUrl({
    access_type: 'offline',
    scope:       SCOPES,
    prompt:      'consent',
    state:       String(userId),
  });
}

async function exchangeCode(userId, code) {
  const client = makeOAuth2Client();
  const { tokens } = await client.getToken(code);
  upsertSetting(userId, 'google_tokens', JSON.stringify(tokens));
  return tokens;
}

function getClient(userId) {
  const row = getSetting(userId, 'google_tokens');
  if (!row) throw new Error('Not authenticated');
  const stored = JSON.parse(row.value);
  const client = makeOAuth2Client();
  client.setCredentials(stored);
  client.on('tokens', (fresh) => {
    upsertSetting(userId, 'google_tokens', JSON.stringify({ ...stored, ...fresh }));
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

async function listCalendars(userId) {
  const cal = google.calendar({ version: 'v3', auth: getClient(userId) });
  const res = await cal.calendarList.list();
  return (res.data.items || []).map(c => ({
    id:      c.id,
    name:    c.summary,
    primary: !!c.primary,
  }));
}

// ── LIFELINE-created event detection ──────────────────────────────────────────
// Two ways to recognize an event LIFELINE created: the extendedProperties tag
// (added going forward by syncTaskToCalendar) and, for events created before
// that tag existed, the "[BUSINESS] name" / "✓ [BUSINESS] name" title shape
// syncTaskToCalendar has always used.
//
// The extendedProperties key itself ('daywan_source') is left unrenamed on
// purpose — it's already stored on real Google Calendar events from before
// this app was renamed, and this check has to keep matching those.

function isLifelineTaggedEvent(event) {
  return event?.extendedProperties?.private?.daywan_source === 'daywan';
}

function looksLifelineCreatedTitle(title) {
  return /^(✓\s*)?\[[^\]]+\]\s*/.test(title || '');
}

function isLifelineCreatedEvent(event) {
  return isLifelineTaggedEvent(event) || looksLifelineCreatedTitle(event?.summary);
}

// ── event fetching ────────────────────────────────────────────────────────────

async function getEventsForDate(userId, dateStr) {
  const cal             = google.calendar({ version: 'v3', auth: getClient(userId) });
  const { start, end }  = watMidnight(dateStr);
  const calRow          = getSetting(userId, 'google_calendar_id');
  const calendarId      = calRow ? calRow.value : 'primary';
  const res = await cal.events.list({
    calendarId,
    timeMin:      start,
    timeMax:      end,
    singleEvents: true,
    orderBy:      'startTime',
  });
  return (res.data.items || []).filter(e => !isLifelineCreatedEvent(e)).map(mapEvent);
}

async function getTodayEvents(userId) {
  const today = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
  return getEventsForDate(userId, today);
}

async function getEventsForMonth(userId, year, month) {
  const cal         = google.calendar({ version: 'v3', auth: getClient(userId) });
  const calRow      = getSetting(userId, 'google_calendar_id');
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
  return (res.data.items || [])
    .filter(e => !isLifelineCreatedEvent(e))
    .map(e => ({
      ...mapEvent(e),
      date: (e.start?.dateTime || e.start?.date || '').slice(0, 10),
    }));
}

// ── event creation / update / delete ─────────────────────────────────────────

async function createEvent(userId, title, dateStr, startTime, endTime, description, calendarId) {
  const cal     = google.calendar({ version: 'v3', auth: getClient(userId) });
  const calId   = calendarId || getSetting(userId, 'google_calendar_id')?.value || 'primary';
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

async function updateEvent(userId, eventId, updates, calendarId) {
  const cal   = google.calendar({ version: 'v3', auth: getClient(userId) });
  const calId = calendarId || getSetting(userId, 'google_calendar_id')?.value || 'primary';
  const res   = await cal.events.patch({
    calendarId: calId,
    eventId,
    requestBody: updates,
  });
  return res.data;
}

async function deleteEvent(userId, eventId, calendarId) {
  const cal   = google.calendar({ version: 'v3', auth: getClient(userId) });
  const calId = calendarId || getSetting(userId, 'google_calendar_id')?.value || 'primary';
  await cal.events.delete({ calendarId: calId, eventId });
}

// ── task sync ─────────────────────────────────────────────────────────────────

const BIZ_LABEL_CAL = {
  blok: 'Blok AI', aphl: 'APHL Africa', trade: 'TradeSol',
  personal: 'Personal', anchor: 'Anchor',
};
const BIZ_COLOR_CAL = { blok: '9', aphl: '2', trade: '5', personal: '4', anchor: '8' };

async function syncTaskToCalendar(userId, task) {
  if (!process.env.GOOGLE_CLIENT_ID) return null;
  const tokenRow = getSetting(userId, 'google_tokens');
  if (!tokenRow) return null;

  const cal        = google.calendar({ version: 'v3', auth: getClient(userId) });
  const calRow     = getSetting(userId, 'google_calendar_id');
  const calendarId = calRow ? calRow.value : 'primary';

  const biz      = task.business || 'personal';
  const bizLabel = BIZ_LABEL_CAL[biz] || biz;
  const isDone   = !!task.done;
  const summary  = `${isDone ? '✓ ' : ''}[${biz.toUpperCase()}] ${task.name}`;
  const colorId  = isDone ? '8' : (BIZ_COLOR_CAL[biz] || '4');

  const description =
    (getFounderProfile(userId).brandName || 'LIFELINE') + ' task\n' +
    'Business: ' + bizLabel + '\n' +
    'Priority: ' + (task.priority || 'normal') + '\n' +
    'Source: '   + (task.source   || 'manual');

  const today   = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
  const dateStr = task.date || today;

  let startObj, endObj;
  if (task.time) {
    const [h, m]  = task.time.split(':').map(Number);
    const endMins = h * 60 + m + 30;
    const endTime = String(Math.floor(endMins / 60)).padStart(2, '0') + ':' +
                    String(endMins % 60).padStart(2, '0');
    startObj = { dateTime: `${dateStr}T${task.time}:00+01:00`, timeZone: 'Africa/Lagos' };
    endObj   = { dateTime: `${dateStr}T${endTime}:00+01:00`,   timeZone: 'Africa/Lagos' };
  } else {
    startObj = { date: dateStr };
    endObj   = { date: dateStr };
  }

  let reminderOverrides;
  if (biz === 'anchor') {
    reminderOverrides = [{ method: 'popup', minutes: 0 }];
  } else if (task.priority === 'high') {
    reminderOverrides = [
      { method: 'popup', minutes: 30 },
      { method: 'popup', minutes: 10 },
      { method: 'popup', minutes: 0 },
    ];
  } else {
    reminderOverrides = task.time
      ? [{ method: 'popup', minutes: 10 }, { method: 'popup', minutes: 0 }]
      : [{ method: 'popup', minutes: 0 }];
  }

  const requestBody = {
    summary,
    description,
    colorId,
    start:     startObj,
    end:       endObj,
    reminders: { useDefault: false, overrides: reminderOverrides },
    extendedProperties: {
      private: {
        daywan_task_id: task.id.toString(),
        daywan_source:  'daywan',
      },
    },
  };

  let event;
  if (task.calendar_event_id) {
    try {
      const res = await cal.events.patch({ calendarId, eventId: task.calendar_event_id, requestBody });
      event = res.data;
    } catch (err) {
      if (err.code === 404 || err.code === 410) {
        const res = await cal.events.insert({ calendarId, requestBody });
        event = res.data;
        updateTaskEventId(userId, event.id, task.id);
      } else {
        throw err;
      }
    }
  } else {
    const res = await cal.events.insert({ calendarId, requestBody });
    event = res.data;
    updateTaskEventId(userId, event.id, task.id);
  }

  return event;
}

// ── schedule blocks sync ──────────────────────────────────────────────────────

async function syncBlocksToCalendar(userId, blocks) {
  const cal     = google.calendar({ version: 'v3', auth: getClient(userId) });
  const today   = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);

  // Find or create the schedule calendar. Setting key is kept stable across
  // the rename so an already-connected calendar doesn't get duplicated.
  const brand = getFounderProfile(userId).brandName || 'LIFELINE';
  let calId = getSetting(userId, 'daywan_calendar_id')?.value;
  if (!calId) {
    const listRes = await cal.calendarList.list();
    const existing = (listRes.data.items || []).find(c => c.summary === `${brand} Schedule` || c.summary === 'DAYWAN Schedule');
    if (existing) {
      calId = existing.id;
    } else {
      const created = await cal.calendars.insert({
        requestBody: { summary: `${brand} Schedule`, timeZone: 'Africa/Lagos' },
      });
      calId = created.data.id;
    }
    upsertSetting(userId, 'daywan_calendar_id', calId);
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

async function setupCalendarWatch(userId, serverUrl) {
  if (!serverUrl || serverUrl.includes('localhost')) {
    console.log('[calendar] Skipping webhook setup — no public URL');
    return null;
  }
  const cal        = google.calendar({ version: 'v3', auth: getClient(userId) });
  const calRow     = getSetting(userId, 'google_calendar_id');
  const calendarId = calRow ? calRow.value : 'primary';

  // Stop existing channel first
  await stopCalendarWatch(userId).catch(() => {});

  const res = await cal.events.watch({
    calendarId,
    requestBody: {
      id:         `lifeline-channel-${userId}-${Date.now()}`,
      type:       'web_hook',
      address:    `${serverUrl}/api/calendar/webhook`,
      token:      process.env.GOOGLE_WEBHOOK_TOKEN || 'lifeline-secret',
      expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  const channel = {
    id:         res.data.id,
    resourceId: res.data.resourceId,
    expiration: res.data.expiration,
    created_at: Date.now(),
  };
  upsertSetting(userId, 'google_watch_channel', JSON.stringify(channel));
  console.log(`[calendar] Watch channel registered for user ${userId}: ${channel.id}`);
  return channel;
}

async function stopCalendarWatch(userId) {
  const row = getSetting(userId, 'google_watch_channel');
  if (!row) return;
  const channel = JSON.parse(row.value);
  try {
    const cal = google.calendar({ version: 'v3', auth: getClient(userId) });
    await cal.channels.stop({
      requestBody: { id: channel.id, resourceId: channel.resourceId },
    });
  } catch (err) {
    console.warn('[calendar] Stop watch warning:', err.message);
  }
  deleteSetting(userId, 'google_watch_channel');
}

async function renewCalendarWatch(userId, serverUrl) {
  console.log(`[calendar] Renewing watch channel for user ${userId}`);
  await stopCalendarWatch(userId).catch(() => {});
  return setupCalendarWatch(userId, serverUrl);
}

// Given a Google push-notification channel id (from the webhook's
// x-goog-channel-id header), finds which user it belongs to. Needed because
// the webhook endpoint is a single shared URL for every user's watch channel
// — there's no session/userId on that request, only whatever Google's push
// tells us. Scans everyone's stored google_watch_channel setting; cheap at
// this app's user scale (a handful of users, not thousands).
async function resolveUserIdForWatchChannel(channelId) {
  if (!channelId) return null;
  const rows = db.prepare(`SELECT user_id, value FROM settings WHERE key = 'google_watch_channel'`).all();
  for (const row of rows) {
    try {
      const channel = JSON.parse(row.value);
      if (channel.id === channelId) return row.user_id;
    } catch { /* skip malformed rows */ }
  }
  return null;
}

// ── incremental sync ──────────────────────────────────────────────────────────

async function getChangedEvents(userId, syncToken) {
  const cal        = google.calendar({ version: 'v3', auth: getClient(userId) });
  const calRow     = getSetting(userId, 'google_calendar_id');
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
      upsertSetting(userId, 'google_sync_token', res.data.nextSyncToken);
    }
    return res.data.items || [];
  } catch (err) {
    if (err.code === 410) {
      // Sync token expired — full re-sync
      deleteSetting(userId, 'google_sync_token');
      return getChangedEvents(userId, null);
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

async function processCalendarEvent(userId, event, caller = 'unknown') {
  console.log(`[calendar] processCalendarEvent ENTER caller=${caller} userId=${userId} eventId=${event.id} summary=${JSON.stringify(event.summary)} status=${event.status} pid=${process.pid} time=${new Date().toISOString()}`);

  if (event.status === 'cancelled') {
    const task = getTaskByEventId(userId, event.id);
    if (task && task.calendar_source === 'google') {
      deleteTaskByEventId(userId, event.id);
      syncDayLog(userId, task.date);
      _sendMessage(userId,
        `Calendar event deleted — task removed:\n[${task.business.toUpperCase()}] ${task.name}`
      ).catch(() => {});
    }
    return;
  }

  // Event was created by LIFELINE itself — never re-import it as a new/updated
  // task. Without this check, every task LIFELINE pushes to Calendar gets read
  // back in as a "new" event and duplicated indefinitely.
  if (isLifelineCreatedEvent(event)) {
    console.log(`[calendar] skipping LIFELINE-created event: ${event.summary}`);
    return null;
  }

  const title     = event.summary || '(no title)';
  const dateRaw   = event.start?.dateTime || event.start?.date || '';
  const date      = dateRaw.slice(0, 10);
  if (!date) return;

  const startTime = watHHMM(event.start?.dateTime) || null;
  const business  = _detectBusiness(title, event.description || '');
  const existing  = getTaskByEventId(userId, event.id);

  console.log(`[calendar] processCalendarEvent caller=${caller} userId=${userId} eventId=${event.id} existingMatch=${existing ? `YES(taskId=${existing.id})` : 'NO'} pid=${process.pid}`);

  if (existing) {
    updateTaskFromCalendar(userId, title, startTime, date, event.id);
    syncDayLog(userId, date);
    _sendMessage(userId,
      `Calendar event updated — task updated:\n` +
      `[${business.toUpperCase()}] ${title}` +
      (startTime ? ` — ${date} at ${startTime}` : '')
    ).catch(() => {});
  } else {
    insertCalendarTask(userId, date, title, business, startTime, event.id);
    logTaskInsert('calendar', title, { date, business, eventId: event.id, caller, userId });
    syncDayLog(userId, date);
    const allTasks = getTasksByDate(userId, date);
    const taskNum  = allTasks.findIndex(t => t.calendar_event_id === event.id) + 1;
    _sendMessage(userId,
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
  resolveUserIdForWatchChannel,
  getChangedEvents,
  processCalendarEvent,
  isLifelineCreatedEvent,
};
