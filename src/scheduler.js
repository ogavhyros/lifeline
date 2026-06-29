require('dotenv').config();
const { generateMorningBriefing, generateEODReview } = require('./ai');
const { sendMessage, sendNudgeDigest, sendRecurringConfirmation } = require('./telegram');
const gcal = require('./google-calendar');
const {
  getTasksByDate, populateRecurring, watToday,
  getPendingNudges, getSetting,
  getTaskByEventId, updateTaskFromCalendar,
  getTodayTasksIncludingPending, getPendingRecurring,
  insertCarriedTask,
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

// ── job table ─────────────────────────────────────────────────────────────────
// noQuiet: true — job runs even during quiet hours (silent jobs only)

const JOBS = [
  // midnight — carry incomplete tasks + seed pending recurring for new day
  { time: '00:01', label: 'midnight',         action: midnightCarry,                                                         noQuiet: true },
  // renew Google Calendar watch channel if it's 6+ days old
  { time: '03:00', label: 'renew-cal-watch',  action: renewCalWatch,                                                         noQuiet: true },

  // anchor blocks
  { time: '05:25', label: 'prayer-5min',    action: () => notifEnabled('block_reminders') && sendMessage('Prayer block in 5 minutes')                                        },
  { time: '05:40', label: 'journaling-now', action: () => sendMessage('Journaling block starting now')                                     },
  { time: '06:25', label: 'orient-now',     action: () => sendMessage('Orient and daily priority starting now [BLOK]')                     },
  { time: '06:25', label: 'pre-day-5min',   action: () => sendMessage('Pre-day setup block in 5 minutes [APHL]')                          },

  // daily briefing
  { time: '06:20', label: 'pre-day',        action: () => sendMessage('Pre-day setup: depot price, brief Candy [APHL]')                    },
  { time: '06:30', label: 'briefing',       action: morningBriefing                                                                        },
  { time: '06:50', label: 'morning-cmd',    action: () => sendMessage('Morning command: floor price, driver call [APHL]')                  },

  // work blocks
  { time: '07:20', label: 'raise',          action: () => sendMessage('Raise: investor relations — one genuine touchpoint today [BLOK]')  },
  { time: '08:50', label: 'product',        action: () => sendMessage('Product: PM review, product user flow [BLOK]')                   },
  { time: '09:50', label: 'operations',     action: () => sendMessage('Operations: payments, loading, tracking [APHL]')                    },
  { time: '10:20', label: 'comms',          action: () => sendMessage('Comms: Slack, async check-ins [BLOK]')                              },
  { time: '11:20', label: 'brand',          action: () => sendMessage('Brand: creative review, social metrics [BLOK]')                     },
  { time: '12:50', label: 'md-strategic',   action: () => sendMessage('MD strategic hour [APHL]')                                          },
  { time: '13:50', label: 'strategy',       action: () => sendMessage('Strategy: priorities, decision log [BLOK]')                         },
  { time: '15:50', label: 'day-close',      action: () => sendMessage('Unified day close [BLOK + APHL]')                                   },

  // personal blocks
  { time: '17:50', label: 'personal',       action: () => sendMessage('Pottery or reading [PERSONAL]')                                     },
  { time: '19:00', label: 'physical',       action: () => sendMessage('Physical activity [PERSONAL]')                                      },

  // EOD review
  { time: '21:00', label: 'eod',            action: eodReview                                                                              },
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
  console.log('[scheduler] started — tick every 60s, nudge every 30m, cal-poll every 15m (WAT UTC+1)');
}

module.exports = { initScheduler };
