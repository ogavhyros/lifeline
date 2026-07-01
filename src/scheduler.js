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

// ── notification preferences ──────────────────────────────────────────────────

function notifEnabled(key) {
  const row = getSetting.get('notification_prefs');
  if (!row) return true; // default all on
  try {
    const prefs = JSON.parse(row.value);
    return prefs[key] !== false;
  } catch { return true; }
}

// ── task helper ───────────────────────────────────────────────────────────────

function getTodayTasks() {
  try {
    return getTasksByDate.all(watToday());
  } catch {
    return [];
  }
}

// ── block reminder helper ─────────────────────────────────────────────────────

function buildBlockMessage(time, blockName, biz) {
  const today   = watToday();
  const tasks   = getTasksByDate.all(today);
  const pending = tasks.filter(t => !t.done && t.business === biz);

  if (!pending.length) return `${time} — ${blockName}`;

  const taskLines = pending.map(t => t.name).join('\n');
  return `${time} — ${blockName}\n\n${taskLines}\n\n/done <n> when complete`;
}

// ── job actions ───────────────────────────────────────────────────────────────

async function renewCalWatch() {
  const row = getSetting.get('google_watch_channel');
  if (!row) return;
  const channel = JSON.parse(row.value);
  const age     = Date.now() - (channel.created_at || 0);
  if (age < 6 * 24 * 60 * 60 * 1000) return; // not old enough yet
  const serverUrl = process.env.SERVER_URL;
  if (!serverUrl || serverUrl.includes('localhost')) return;
  await gcal.renewCalendarWatch(serverUrl);
  console.log('[scheduler] Calendar watch channel renewed');
}

async function morningBriefing() {
  if (!notifEnabled('briefing')) return;
  const today   = watToday();
  const tasks   = getTodayTasksIncludingPending(today);
  const briefing = await generateMorningBriefing(tasks, today);
  await sendMessage(briefing);
  // Follow-up: send recurring tasks confirmation prompt
  const pending = getPendingRecurring.all(today);
  if (pending.length) {
    await sendRecurringConfirmation(today);
  }
}

async function eodReview() {
  if (!notifEnabled('eod')) return;
  const tasks  = getTodayTasks();
  const review = await generateEODReview(tasks, watToday());
  await sendMessage(review);
}

async function midnightCarry() {
  const today     = watToday();
  const yesterday = new Date(Date.now() + 60 * 60 * 1000 - 86400000).toISOString().slice(0, 10);

  // Clean up any duplicate tasks from yesterday (Google Calendar sync loop)
  // before carrying incomplete ones forward — otherwise duplicates get carried too.
  const removedYesterday = deduplicateTasks(yesterday);
  if (removedYesterday > 0) {
    console.log(`[scheduler] midnight — cleaned ${removedYesterday} duplicate task(s) for ${yesterday}`);
  }

  // Carry incomplete non-recurring tasks from yesterday
  const yesterdayTasks = getTasksByDate.all(yesterday);
  const todayTasks     = getTasksByDate.all(today);
  const todayNames     = new Set(todayTasks.map(t => t.name));

  const toCarry = yesterdayTasks.filter(t =>
    !t.done &&
    t.source !== 'recurring' &&
    t.business !== 'anchor'
  );

  let carried = 0;
  for (const t of toCarry) {
    if (todayNames.has(t.name)) continue;
    insertCarriedTask.run(today, t.name, t.business, t.time || null, t.priority || 'normal');
    todayNames.add(t.name);
    carried++;
  }

  // Queue recurring tasks for today's confirmation
  populateRecurring(today);
  db.prepare('INSERT OR IGNORE INTO day_log (date) VALUES (?)').run(today);

  sentReminders.clear();
  console.log(`[scheduler] midnight — carried ${carried} task(s) from ${yesterday}`);

  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const dayLabel = DAYS[new Date(today + 'T12:00:00Z').getUTCDay()];

  if (carried > 0) {
    await sendMessage(
      `New day started — ${dayLabel}, ${today}\n\n` +
      `Carried forward from yesterday:\n${carried} incomplete task${carried !== 1 ? 's' : ''}\n\n` +
      `Recurring tasks will be confirmed at morning briefing.\n\n` +
      `Rest well.`
    );
  } else {
    await sendMessage(
      `New day — ${dayLabel}, ${today}\n\n` +
      `Yesterday was clean. Well done.\n` +
      `Recurring tasks confirmed at morning briefing.`
    );
  }
}

async function morningCalendarSync() {
  const tokenRow = getSetting.get('google_tokens');
  if (!tokenRow) return;

  const today   = watToday();
  const tasks   = getTasksByDate.all(today);
  const unsynced = tasks.filter(t => !t.calendar_event_id);

  let synced = 0;
  for (const task of unsynced) {
    try {
      await gcal.syncTaskToCalendar(task);
      synced++;
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error('[calendar] morning sync failed:', err.message);
    }
  }
  if (synced > 0) console.log(`[calendar] morning sync — ${synced} tasks pushed`);

  // Pull any new Google Calendar events not yet tracked in LIFELINE.
  // gcal.getEventsForDate() already filters out DAYWAN-created events (tagged
  // or legacy "[BUSINESS] name" titles) — see google-calendar.js sync rules —
  // so this can't re-import a task DAYWAN just pushed above.
  let calEvents;
  try { calEvents = await gcal.getEventsForDate(today); }
  catch { return; }

  const taskEventIds = new Set(getTasksByDate.all(today).map(t => t.calendar_event_id).filter(Boolean));
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
      await gcal.processCalendarEvent(rawEv);
      pulledItems.push(`${ev.title}${ev.start ? ' — ' + ev.start : ''}`);
    } catch { }
  }

  if (pulledItems.length) {
    await sendMessage(
      `Pulled ${pulledItems.length} event${pulledItems.length !== 1 ? 's' : ''} from Google Calendar into today:\n` +
      pulledItems.map(item => `• ${item}`).join('\n')
    );
  }
}

// ── task due reminder ─────────────────────────────────────────────────────────

const sentReminders = new Set();

async function taskDueTick() {
  const now  = watNow();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  // Only between 05:30 and 20:30 WAT
  if (mins < 330 || mins >= 1230) return;

  const hhmm  = watHHMM(now);
  const today = now.toISOString().slice(0, 10);
  const tasks = getTasksByDate.all(today);

  for (const task of tasks) {
    if (task.done || !task.time || task.time !== hhmm) continue;
    const key = `${task.id}:${today}`;
    if (sentReminders.has(key)) continue;
    sentReminders.add(key);

    const taskNum = tasks.findIndex(t => t.id === task.id) + 1;
    try {
      await sendMessage(
        `Due now: [${task.business.toUpperCase()}] ${task.name}\n` +
        `/done ${taskNum} to mark complete`
      );
    } catch (err) {
      console.error('[scheduler] taskDue send failed:', err.message);
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
  { time: '05:25', label: 'prayer-5min',    action: () => notifEnabled('block_reminders') && sendMessage('Prayer block in 5 minutes') },
  { time: '05:40', label: 'journaling-now', action: () => sendMessage(buildBlockMessage('05:45', 'Journaling', 'anchor'))             },
  { time: '06:25', label: 'orient-now',     action: () => sendMessage(buildBlockMessage('06:00', 'Orient and daily priority', 'blok'))  },
  { time: '06:25', label: 'pre-day-5min',   action: () => sendMessage(buildBlockMessage('06:30', 'Pre-day setup', 'aphl'))            },

  // daily briefing
  { time: '06:30', label: 'briefing',       action: morningBriefing },
  { time: '06:50', label: 'morning-cmd',    action: () => sendMessage(buildBlockMessage('07:00', 'Morning command', 'aphl'))          },

  // work blocks
  { time: '07:20', label: 'raise',        action: () => sendMessage(buildBlockMessage('07:30', 'Raise — investor relations', 'blok'))  },
  { time: '08:50', label: 'product',      action: () => sendMessage(buildBlockMessage('09:00', 'Product block', 'blok'))              },
  { time: '09:50', label: 'operations',   action: () => sendMessage(buildBlockMessage('10:00', 'Operations block', 'aphl'))           },
  { time: '10:20', label: 'comms',        action: () => sendMessage(buildBlockMessage('10:30', 'Comms block', 'blok'))                },
  { time: '11:20', label: 'brand',        action: () => sendMessage(buildBlockMessage('11:30', 'Brand block', 'blok'))                },
  { time: '12:50', label: 'md-strategic', action: () => sendMessage(buildBlockMessage('13:00', 'MD strategic hour', 'aphl'))          },
  { time: '13:50', label: 'strategy',     action: () => sendMessage(buildBlockMessage('14:00', 'Strategy block', 'blok'))             },
  { time: '15:50', label: 'day-close',    action: () => sendMessage(buildBlockMessage('16:00', 'Day close', 'blok'))                  },

  // personal blocks
  { time: '17:50', label: 'personal',     action: () => sendMessage(buildBlockMessage('18:00', 'Personal block', 'personal'))        },
  { time: '19:00', label: 'physical',     action: () => sendMessage(buildBlockMessage('19:00', 'Physical activity', 'personal'))     },

  // EOD review
  { time: '21:00', label: 'eod', action: eodReview },
];

// ── scheduler loop ────────────────────────────────────────────────────────────

const fired = new Set(); // "YYYY-MM-DD HH:MM label" — prevents double-fire within same minute

async function runJob(job, date, hhmm) {
  const key = `${date} ${hhmm} ${job.label}`;
  if (fired.has(key)) return;
  fired.add(key);

  if (!job.noQuiet && isQuietHours()) {
    console.log(`[scheduler] ${job.label} skipped (quiet hours)`);
    return;
  }

  try {
    await job.action();
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

async function nudgeTick() {
  if (isQuietHours()) return;

  const now  = watNow();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();

  // Only nudge during working hours: 06:00–20:30
  if (mins < 360 || mins >= 1230) return;

  const date = now.toISOString().slice(0, 10);

  let pending;
  try {
    pending = getPendingNudges(date);
  } catch (err) {
    console.error('[scheduler] nudgeTick getPendingNudges failed:', err.message);
    return;
  }

  const allTasks = getTasksByDate.all(date);

  if (!notifEnabled('nudges')) return;

  try {
    await sendNudgeDigest(date, pending, allTasks);
    if (pending.length) {
      console.log(`[scheduler] nudge digest sent — ${pending.length} overdue task(s)`);
    }
  } catch (err) {
    console.error('[scheduler] nudge digest failed:', err.message);
  }
}

// ── Google Calendar polling fallback (every 15 min) ──────────────────────────
// gcal.getEventsForDate() filters out DAYWAN-created events before returning
// them, so this loop only ever sees externally created events — it can't
// re-import a task DAYWAN itself pushed to Calendar as a duplicate.

async function calendarPoll() {
  const tokenRow = getSetting.get('google_tokens');
  if (!tokenRow) return; // not connected

  if (isQuietHours()) return; // includes stop-after-20:30

  const today = watToday();
  let events;
  try {
    events = await gcal.getEventsForDate(today);
  } catch (err) {
    if (err.message !== 'Not authenticated') {
      console.error('[calendar] poll error:', err.message);
    }
    return;
  }

  let checked = 0;
  for (const ev of events) {
    const existing = getTaskByEventId.get(ev.id);
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
      await gcal.processCalendarEvent(rawEv).catch(err =>
        console.error('[calendar] processCalendarEvent failed:', err.message)
      );
    } else if (existing.name !== ev.title) {
      // Silent update — event was renamed in Google Calendar
      updateTaskFromCalendar.run(ev.title, ev.start || null, today, ev.id);
    }
    checked++;
  }

  console.log(`[calendar] polled — ${checked} event${checked !== 1 ? 's' : ''} checked`);
}

// ── init ──────────────────────────────────────────────────────────────────────

function initScheduler() {
  tick();
  setInterval(tick, 60 * 1000);
  setInterval(
    () => nudgeTick().catch(err => console.error('[scheduler] nudgeTick error:', err.message)),
    30 * 60 * 1000
  );
  setInterval(
    () => calendarPoll().catch(err => console.error('[scheduler] calendarPoll error:', err.message)),
    15 * 60 * 1000
  );
  setInterval(
    () => taskDueTick().catch(err => console.error('[scheduler] taskDueTick error:', err.message)),
    5 * 60 * 1000
  );
  console.log('[scheduler] started — tick every 60s, nudge every 30m, cal-poll every 15m, due-reminder every 5m (WAT UTC+1)');
}

module.exports = { initScheduler };
