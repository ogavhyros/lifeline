require('dotenv').config();
const { generateMorningBriefing, generateEODReview } = require('./ai');
const { sendMessage, sendNudgeDigest, sendRecurringConfirmation } = require('./telegram');
const gcal = require('./google-calendar');
const {
  getTasksByDate, populateRecurring, watToday,
  getPendingNudges, getSetting,
  getTaskByEventId, updateTaskFromCalendar,
  getTodayTasksIncludingPending, getPendingRecurring,
  insertCarriedTask, deduplicateTasks,
  db,
} = require('./db');

// ── WAT helpers (UTC+1) ───────────────────────────────────────────────────────

function watNow() {
  return new Date(Date.now() + 60 * 60 * 1000);
}

function watHHMM(d) {
  return (
    String(d.getUTCHours()).padStart(2, '0') + ':' +
    String(d.getUTCMinutes()).padStart(2, '0')
  );
}

function watNowDatetime() {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

// Quiet hours: 20:30–05:20 WAT — no notifications sent during this window
function isQuietHours() {
  const now  = watNow();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return mins < 320 || mins >= 1230; // before 05:20 or from 20:30 onwards
}

// ── multi-user iteration helpers ──────────────────────────────────────────────
// Every job used to assume "the one user" — now each either loops every user
// (data maintenance: carry-forward, calendar push/pull — these should happen
// for everyone regardless of whether Telegram is linked) or every user with a
// linked telegram_chat_id (anything that's purely a message — sendMessage
// already no-ops gracefully for an unlinked user, but there's no point
// looping and logging for accounts that can't receive it).

function getAllUserIds() {
  return db.prepare('SELECT id FROM users').all();
}

function getUsersWithTelegram() {
  return db.prepare('SELECT id FROM users WHERE telegram_chat_id IS NOT NULL').all();
}

function forEachUser(fn) {
  return async () => {
    for (const u of getAllUserIds()) {
      try { await fn(u.id); } catch (err) { console.error(`[scheduler] job failed for user ${u.id}:`, err.message); }
    }
  };
}

function forEachTelegramUser(fn) {
  return async () => {
    for (const u of getUsersWithTelegram()) {
      try { await fn(u.id); } catch (err) { console.error(`[scheduler] job failed for user ${u.id}:`, err.message); }
    }
  };
}

// ── notification preferences ──────────────────────────────────────────────────

function notifEnabled(userId, key) {
  const row = getSetting(userId, 'notification_prefs');
  if (!row) return true; // default all on
  try {
    const prefs = JSON.parse(row.value);
    return prefs[key] !== false;
  } catch { return true; }
}

// ── task helper ───────────────────────────────────────────────────────────────

function getTodayTasks(userId) {
  try {
    return getTasksByDate(userId, watToday());
  } catch {
    return [];
  }
}

// ── block reminder helper ─────────────────────────────────────────────────────

function buildBlockMessage(userId, time, blockName, biz) {
  const today   = watToday();
  const tasks   = getTasksByDate(userId, today);
  const pending = tasks.filter(t => !t.done && t.business === biz);

  if (!pending.length) return `${time} — ${blockName}`;

  const taskLines = pending.map(t => t.name).join('\n');
  return `${time} — ${blockName}\n\n${taskLines}\n\n/done <n> when complete`;
}

// ── job actions ───────────────────────────────────────────────────────────────

const renewCalWatch = forEachUser(async (userId) => {
  const row = getSetting(userId, 'google_watch_channel');
  if (!row) return;
  const channel = JSON.parse(row.value);
  const age     = Date.now() - (channel.created_at || 0);
  if (age < 6 * 24 * 60 * 60 * 1000) return; // not old enough yet
  const baseUrl = gcal.getBaseUrl();
  if (!baseUrl || baseUrl.includes('localhost')) return;
  await gcal.renewCalendarWatch(userId, baseUrl);
  console.log(`[scheduler] Calendar watch channel renewed for user ${userId}`);
});

const morningBriefing = forEachTelegramUser(async (userId) => {
  if (!notifEnabled(userId, 'briefing')) return;
  const today    = watToday();
  const tasks    = getTodayTasksIncludingPending(userId, today);
  const briefing = await generateMorningBriefing(tasks, today);
  await sendMessage(userId, briefing);
  // Follow-up: send recurring tasks confirmation prompt
  const pending = getPendingRecurring(userId, today);
  if (pending.length) {
    await sendRecurringConfirmation(userId, today);
  }
});

const eodReview = forEachTelegramUser(async (userId) => {
  if (!notifEnabled(userId, 'eod')) return;
  const tasks  = getTodayTasks(userId);
  if (!tasks.length) return;
  const review = await generateEODReview(tasks, watToday());
  await sendMessage(userId, review);
});

async function midnightCarry() {
  const today     = watToday();
  const yesterday = new Date(Date.now() + 60 * 60 * 1000 - 86400000).toISOString().slice(0, 10);

  for (const u of getAllUserIds()) {
    const userId = u.id;
    try {
      // Clean up any duplicate tasks from yesterday (Google Calendar sync
      // loop) before carrying incomplete ones forward — otherwise duplicates
      // get carried too.
      const removedYesterday = deduplicateTasks(userId, yesterday);
      if (removedYesterday > 0) {
        console.log(`[scheduler] midnight — cleaned ${removedYesterday} duplicate task(s) for user ${userId} on ${yesterday}`);
      }

      // Carry incomplete non-recurring tasks from yesterday
      const yesterdayTasks = getTasksByDate(userId, yesterday);
      const todayTasks     = getTasksByDate(userId, today);
      const todayNames     = new Set(todayTasks.map(t => t.name));

      const toCarry = yesterdayTasks.filter(t =>
        !t.done &&
        t.source !== 'recurring' &&
        t.business !== 'anchor'
      );

      let carried = 0;
      for (const t of toCarry) {
        if (todayNames.has(t.name)) continue;
        insertCarriedTask(userId, today, t.name, t.business, t.time || null, t.priority || 'normal');
        todayNames.add(t.name);
        carried++;
      }

      // Queue recurring tasks for today's confirmation
      populateRecurring(userId, today);
      db.prepare('INSERT OR IGNORE INTO day_log (user_id, date) VALUES (?, ?)').run(userId, today);

      console.log(`[scheduler] midnight — carried ${carried} task(s) from ${yesterday} for user ${userId}`);

      const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const dayLabel = DAYS[new Date(today + 'T12:00:00Z').getUTCDay()];

      if (carried > 0) {
        await sendMessage(userId,
          `New day started — ${dayLabel}, ${today}\n\n` +
          `Carried forward from yesterday:\n${carried} incomplete task${carried !== 1 ? 's' : ''}\n\n` +
          `Recurring tasks will be confirmed at morning briefing.\n\n` +
          `Rest well.`
        );
      } else {
        await sendMessage(userId,
          `New day — ${dayLabel}, ${today}\n\n` +
          `Yesterday was clean. Well done.\n` +
          `Recurring tasks confirmed at morning briefing.`
        );
      }
    } catch (err) {
      console.error(`[scheduler] midnightCarry failed for user ${userId}:`, err.message);
    }
  }

  // Global, not per-user — shared dedup Set for taskDueTick, reset once a day.
  sentReminders.clear();
}

async function morningCalendarSyncForUser(userId) {
  const tokenRow = getSetting(userId, 'google_tokens');
  if (!tokenRow) return;

  const today    = watToday();
  const tasks    = getTasksByDate(userId, today);
  const unsynced = tasks.filter(t => !t.calendar_event_id);

  let synced = 0;
  for (const task of unsynced) {
    try {
      await gcal.syncTaskToCalendar(userId, task);
      synced++;
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error(`[calendar] morning sync failed for user ${userId}:`, err.message);
    }
  }
  if (synced > 0) console.log(`[calendar] morning sync — ${synced} tasks pushed for user ${userId}`);

  // Pull any new Google Calendar events not yet tracked in LIFELINE.
  // gcal.getEventsForDate() already filters out LIFELINE-created events (tagged
  // or legacy "[BUSINESS] name" titles) — see google-calendar.js sync rules —
  // so this can't re-import a task LIFELINE just pushed above.
  console.log(`[calendar-sync] RUN START caller=morningCalendarSync userId=${userId} pid=${process.pid} time=${new Date().toISOString()}`);
  let calEvents;
  try { calEvents = await gcal.getEventsForDate(userId, today); }
  catch (err) {
    console.log(`[calendar-sync] RUN END caller=morningCalendarSync userId=${userId} ABORTED err=${err.message} pid=${process.pid}`);
    return;
  }
  console.log(`[calendar-sync] caller=morningCalendarSync userId=${userId} fetched=${calEvents.length} event(s): ${calEvents.map(e => e.id).join(',')} pid=${process.pid}`);

  const taskEventIds = new Set(getTasksByDate(userId, today).map(t => t.calendar_event_id).filter(Boolean));
  const newEvents    = calEvents.filter(ev => !taskEventIds.has(ev.id));

  const pulledItems = [];
  for (const ev of newEvents) {
    try {
      const rawEv = {
        id:          ev.id,
        summary:     ev.title,
        description: ev.description || '',
        status:      'confirmed',
        start:       ev.allDay ? { date: ev.startRaw } : { dateTime: ev.startRaw },
        end:         ev.allDay ? { date: ev.endRaw }   : { dateTime: ev.endRaw },
      };
      await gcal.processCalendarEvent(userId, rawEv, 'morningCalendarSync');
      pulledItems.push(`${ev.title}${ev.start ? ' — ' + ev.start : ''}`);
    } catch { }
  }

  console.log(`[calendar-sync] RUN END caller=morningCalendarSync userId=${userId} pushed=${synced} pulled=${pulledItems.length} pid=${process.pid} time=${new Date().toISOString()}`);

  if (pulledItems.length) {
    await sendMessage(userId,
      `Pulled ${pulledItems.length} event${pulledItems.length !== 1 ? 's' : ''} from Google Calendar into today:\n` +
      pulledItems.map(item => `• ${item}`).join('\n')
    );
  }
}

const morningCalendarSync = forEachUser(morningCalendarSyncForUser);

// ── task due reminder ─────────────────────────────────────────────────────────

const sentReminders = new Set();

async function taskDueTick() {
  const now  = watNow();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  // Only between 05:30 and 20:30 WAT
  if (mins < 330 || mins >= 1230) return;

  const hhmm  = watHHMM(now);
  const today = now.toISOString().slice(0, 10);

  for (const u of getUsersWithTelegram()) {
    const userId = u.id;
    const tasks  = getTasksByDate(userId, today);

    for (const task of tasks) {
      if (task.done || !task.time || task.time !== hhmm) continue;
      const key = `${task.id}:${today}`; // task.id is globally unique — safe without userId in the key
      if (sentReminders.has(key)) continue;
      sentReminders.add(key);

      const taskNum = tasks.findIndex(t => t.id === task.id) + 1;
      try {
        await sendMessage(userId,
          `Due now: [${task.business.toUpperCase()}] ${task.name}\n` +
          `/done ${taskNum} to mark complete`
        );
      } catch (err) {
        console.error(`[scheduler] taskDue send failed for user ${userId}:`, err.message);
      }
    }
  }
}

// ── job table ─────────────────────────────────────────────────────────────────
// noQuiet: true — job runs even during quiet hours (silent jobs only)

const JOBS = [
  // midnight — carry incomplete tasks + seed pending recurring for new day
  { time: '00:01', label: 'midnight',         action: midnightCarry,  noQuiet: true },
  // renew Google Calendar watch channel if it's 6+ days old
  { time: '03:00', label: 'renew-cal-watch',  action: renewCalWatch,  noQuiet: true },

  // morning calendar sync — push today's tasks to Google Calendar
  { time: '05:25', label: 'morning-cal-sync', action: morningCalendarSync, noQuiet: true },

  // anchor blocks
  { time: '05:25', label: 'prayer-5min',    action: forEachTelegramUser(userId => notifEnabled(userId, 'block_reminders') && sendMessage(userId, 'Prayer block in 5 minutes')) },
  { time: '05:40', label: 'journaling-now', action: forEachTelegramUser(userId => sendMessage(userId, buildBlockMessage(userId, '05:45', 'Journaling', 'anchor'))) },
  { time: '06:25', label: 'orient-now',     action: forEachTelegramUser(userId => sendMessage(userId, buildBlockMessage(userId, '06:00', 'Orient and daily priority', 'blok'))) },
  { time: '06:25', label: 'pre-day-5min',   action: forEachTelegramUser(userId => sendMessage(userId, buildBlockMessage(userId, '06:30', 'Pre-day setup', 'aphl'))) },

  // daily briefing
  { time: '06:30', label: 'briefing',       action: morningBriefing },
  { time: '06:50', label: 'morning-cmd',    action: forEachTelegramUser(userId => sendMessage(userId, buildBlockMessage(userId, '07:00', 'Morning command', 'aphl'))) },

  // work blocks
  { time: '07:20', label: 'raise',        action: forEachTelegramUser(userId => sendMessage(userId, buildBlockMessage(userId, '07:30', 'Raise — investor relations', 'blok'))) },
  { time: '08:50', label: 'product',      action: forEachTelegramUser(userId => sendMessage(userId, buildBlockMessage(userId, '09:00', 'Product block', 'blok'))) },
  { time: '09:50', label: 'operations',   action: forEachTelegramUser(userId => sendMessage(userId, buildBlockMessage(userId, '10:00', 'Operations block', 'aphl'))) },
  { time: '10:20', label: 'comms',        action: forEachTelegramUser(userId => sendMessage(userId, buildBlockMessage(userId, '10:30', 'Comms block', 'blok'))) },
  { time: '11:20', label: 'brand',        action: forEachTelegramUser(userId => sendMessage(userId, buildBlockMessage(userId, '11:30', 'Brand block', 'blok'))) },
  { time: '12:50', label: 'md-strategic', action: forEachTelegramUser(userId => sendMessage(userId, buildBlockMessage(userId, '13:00', 'MD strategic hour', 'aphl'))) },
  { time: '13:50', label: 'strategy',     action: forEachTelegramUser(userId => sendMessage(userId, buildBlockMessage(userId, '14:00', 'Strategy block', 'blok'))) },
  { time: '15:50', label: 'day-close',    action: forEachTelegramUser(userId => sendMessage(userId, buildBlockMessage(userId, '16:00', 'Day close', 'blok'))) },

  // personal blocks
  { time: '17:50', label: 'personal',     action: forEachTelegramUser(userId => sendMessage(userId, buildBlockMessage(userId, '18:00', 'Personal block', 'personal'))) },
  { time: '19:00', label: 'physical',     action: forEachTelegramUser(userId => sendMessage(userId, buildBlockMessage(userId, '19:00', 'Physical activity', 'personal'))) },

  // EOD review
  { time: '21:00', label: 'eod', action: eodReview },
];

// ── scheduler loop ────────────────────────────────────────────────────────────

const fired = new Set(); // "YYYY-MM-DD HH:MM label" — prevents double-fire within same minute

async function runJob(job, date, hhmm) {
  const key = `${date} ${hhmm} ${job.label}`;
  console.log(`[scheduler] JOB FIRING label=${job.label} key="${key}" alreadyFiredInThisProcess=${fired.has(key)} pid=${process.pid} time=${new Date().toISOString()}`);
  if (fired.has(key)) return;
  fired.add(key);

  if (!job.noQuiet && isQuietHours()) {
    console.log(`[scheduler] ${job.label} skipped (quiet hours)`);
    return;
  }

  try {
    await job.action();
    console.log(`[scheduler] JOB DONE label=${job.label} pid=${process.pid}`);
  } catch (err) {
    console.error(`[scheduler] ${job.label} failed:`, err.message);
  }
}

function tick() {
  const now  = watNow();
  const date = now.toISOString().slice(0, 10);
  const hhmm = watHHMM(now);

  // Purge keys from previous days to keep the Set small
  for (const key of fired) {
    if (!key.startsWith(date)) fired.delete(key);
  }

  for (const job of JOBS) {
    if (job.time === hhmm) runJob(job, date, hhmm);
  }
}

// ── nudge loop (every 30 minutes) ─────────────────────────────────────────────

const nudgeTick = forEachTelegramUser(async (userId) => {
  if (isQuietHours()) return;

  const now  = watNow();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();

  // Only nudge during working hours: 06:00–20:30
  if (mins < 360 || mins >= 1230) return;
  if (!notifEnabled(userId, 'nudges')) return;

  const date = now.toISOString().slice(0, 10);

  let pending;
  try {
    pending = getPendingNudges(userId, date);
  } catch (err) {
    console.error(`[scheduler] nudgeTick getPendingNudges failed for user ${userId}:`, err.message);
    return;
  }

  const allTasks = getTasksByDate(userId, date);

  await sendNudgeDigest(userId, date, pending, allTasks);
  if (pending.length) {
    console.log(`[scheduler] nudge digest sent — user ${userId} — ${pending.length} overdue task(s)`);
  }
});

// ── Google Calendar polling fallback (every 15 min) ──────────────────────────
// gcal.getEventsForDate() filters out LIFELINE-created events before returning
// them, so this loop only ever sees externally created events — it can't
// re-import a task LIFELINE itself pushed to Calendar as a duplicate.

async function calendarPollForUser(userId) {
  const tokenRow = getSetting(userId, 'google_tokens');
  if (!tokenRow) return; // not connected

  console.log(`[calendar-sync] RUN START caller=calendarPoll userId=${userId} pid=${process.pid} time=${new Date().toISOString()}`);

  const today = watToday();
  let events;
  try {
    events = await gcal.getEventsForDate(userId, today);
  } catch (err) {
    if (err.message !== 'Not authenticated') {
      console.error(`[calendar] poll error for user ${userId}:`, err.message);
    }
    console.log(`[calendar-sync] RUN END caller=calendarPoll userId=${userId} ABORTED err=${err.message} pid=${process.pid}`);
    return;
  }
  console.log(`[calendar-sync] caller=calendarPoll userId=${userId} fetched=${events.length} event(s): ${events.map(e => e.id).join(',')} pid=${process.pid}`);

  let checked = 0;
  for (const ev of events) {
    const existing = getTaskByEventId(userId, ev.id);
    console.log(`[calendar-sync] caller=calendarPoll userId=${userId} eventId=${ev.id} title=${JSON.stringify(ev.title)} existingMatch=${existing ? `YES(taskId=${existing.id})` : 'NO'} pid=${process.pid}`);
    if (!existing) {
      // Reconstruct raw-format event that processCalendarEvent expects
      const rawEv = {
        id:          ev.id,
        summary:     ev.title,
        description: ev.description || '',
        status:      'confirmed',
        start:       ev.allDay ? { date: ev.startRaw } : { dateTime: ev.startRaw },
        end:         ev.allDay ? { date: ev.endRaw }   : { dateTime: ev.endRaw },
      };
      await gcal.processCalendarEvent(userId, rawEv, 'calendarPoll').catch(err =>
        console.error(`[calendar] processCalendarEvent failed for user ${userId}:`, err.message)
      );
    } else if (existing.name !== ev.title) {
      // Silent update — event was renamed in Google Calendar
      updateTaskFromCalendar(userId, ev.title, ev.start || null, today, ev.id);
    }
    checked++;
  }

  console.log(`[calendar-sync] RUN END caller=calendarPoll userId=${userId} checked=${checked} pid=${process.pid} time=${new Date().toISOString()}`);
  console.log(`[calendar] polled — ${checked} event${checked !== 1 ? 's' : ''} checked for user ${userId}`);
}

async function calendarPoll() {
  if (isQuietHours()) return; // includes stop-after-20:30 — same for everyone, single WAT clock
  for (const u of getAllUserIds()) {
    await calendarPollForUser(u.id);
  }
}

// ── init ──────────────────────────────────────────────────────────────────────

// DEBUG: guards against initScheduler() being invoked more than once inside
// the same process — if this ever logs a re-registration, that alone would
// double every job's setInterval within a single process (distinct from the
// separate, more likely cause: two whole process instances alive at once).
let _schedulerInitialized = false;

function initScheduler() {
  if (_schedulerInitialized) {
    console.error(`[scheduler] WARNING — initScheduler() called AGAIN in the same process (pid=${process.pid}). Jobs are being re-registered without cleanup — this would double-fire every scheduled job.`);
  }
  _schedulerInitialized = true;

  console.log(`[scheduler] initScheduler() starting — pid=${process.pid} time=${new Date().toISOString()}`);

  tick();
  const tickId = setInterval(tick, 60 * 1000);
  console.log(`[scheduler] job registered: name=tick intervalMs=60000 pid=${process.pid}`);

  const nudgeId = setInterval(
    () => nudgeTick().catch(err => console.error('[scheduler] nudgeTick error:', err.message)),
    30 * 60 * 1000
  );
  console.log(`[scheduler] job registered: name=nudgeTick intervalMs=1800000 pid=${process.pid}`);

  const calPollId = setInterval(
    () => calendarPoll().catch(err => console.error('[scheduler] calendarPoll error:', err.message)),
    15 * 60 * 1000
  );
  console.log(`[scheduler] job registered: name=calendarPoll intervalMs=900000 pid=${process.pid}`);

  const taskDueId = setInterval(
    () => taskDueTick().catch(err => console.error('[scheduler] taskDueTick error:', err.message)),
    5 * 60 * 1000
  );
  console.log(`[scheduler] job registered: name=taskDueTick intervalMs=300000 pid=${process.pid}`);

  console.log(`[scheduler] JOBS table has ${JOBS.length} time-based entries (checked every tick): ${JOBS.map(j => `${j.label}@${j.time}`).join(', ')}`);
  console.log('[scheduler] started — tick every 60s, nudge every 30m, cal-poll every 15m, due-reminder every 5m (WAT UTC+1)');
}

module.exports = { initScheduler };
