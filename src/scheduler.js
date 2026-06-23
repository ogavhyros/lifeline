require('dotenv').config();
const { generateMorningBriefing, generateEODReview } = require('./ai');
const { sendMessage } = require('./telegram');
const {
  getTasksByDate, populateRecurring, watToday,
  getPendingNudges, upsertNudge,
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

// ── task helper ───────────────────────────────────────────────────────────────

function getTodayTasks() {
  try {
    return getTasksByDate.all(watToday());
  } catch {
    return [];
  }
}

// ── job actions ───────────────────────────────────────────────────────────────

async function morningBriefing() {
  const tasks    = getTodayTasks();
  const briefing = await generateMorningBriefing(tasks, watToday());
  await sendMessage(briefing);
}

async function eodReview() {
  const tasks  = getTodayTasks();
  const review = await generateEODReview(tasks, watToday());
  await sendMessage(review);
}

function midnight() {
  populateRecurring(watToday());
}

// ── job table ─────────────────────────────────────────────────────────────────
// noQuiet: true — job runs even during quiet hours (silent jobs only)

const JOBS = [
  // midnight — seed recurring tasks before morning briefing (silent, bypasses quiet hours)
  { time: '00:01', label: 'midnight',       action: midnight,                                                                noQuiet: true },

  // anchor blocks
  { time: '05:25', label: 'prayer-5min',    action: () => sendMessage('Prayer block in 5 minutes')                                        },
  { time: '05:40', label: 'journaling-now', action: () => sendMessage('Journaling block starting now')                                     },
  { time: '06:25', label: 'orient-now',     action: () => sendMessage('Orient and daily priority starting now [BLOK]')                     },
  { time: '06:25', label: 'pre-day-5min',   action: () => sendMessage('Pre-day setup block in 5 minutes [APHL]')                          },

  // daily briefing
  { time: '06:20', label: 'pre-day',        action: () => sendMessage('Pre-day setup: depot price, brief Candy [APHL]')                    },
  { time: '06:30', label: 'briefing',       action: morningBriefing                                                                        },
  { time: '06:50', label: 'morning-cmd',    action: () => sendMessage('Morning command: floor price, driver call [APHL]')                  },

  // work blocks
  { time: '07:20', label: 'raise',          action: () => sendMessage('Raise: investor emails, CRM update [BLOK]')                         },
  { time: '08:50', label: 'product',        action: () => sendMessage('Product: PM review, Arkad flow [BLOK]')                             },
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

  const date        = now.toISOString().slice(0, 10);
  const nowDatetime = watNowDatetime();

  let pending;
  try {
    pending = getPendingNudges(date);
  } catch (err) {
    console.error('[scheduler] nudgeTick getPendingNudges failed:', err.message);
    return;
  }

  if (!pending.length) return;

  // Get full sorted task list so nudge numbers match /today output
  const allTasks = getTasksByDate.all(date);

  for (const task of pending) {
    const count   = task.nudge_count || 0;
    const taskNum = allTasks.findIndex(t => t.id === task.id) + 1;
    const biz     = task.business.toUpperCase();

    let msg;
    if (count === 0) {
      msg =
        `Still pending: [${biz}] ${task.name}\n` +
        `Scheduled for ${task.time}\n` +
        `/done ${taskNum} to mark complete or /snooze ${taskNum} to push 30 mins`;
    } else if (count === 1) {
      msg =
        `Still not done: [${biz}] ${task.name}\n` +
        `This is your second reminder.\n` +
        `/done ${taskNum} or /snooze ${taskNum}`;
    } else if (count === 2) {
      msg =
        `Last reminder: [${biz}] ${task.name}\n` +
        `This will be logged as missed if not completed.\n` +
        `/done ${taskNum}`;
    }

    if (msg) {
      try {
        await sendMessage(msg);
        upsertNudge.run(task.id, date, count + 1, nowDatetime);
        console.log(`[scheduler] nudged task ${task.id} (count ${count + 1})`);
      } catch (err) {
        console.error(`[scheduler] nudge for task ${task.id} failed:`, err.message);
      }
    }
  }
}

// ── init ──────────────────────────────────────────────────────────────────────

function initScheduler() {
  tick();
  setInterval(tick, 60 * 1000);
  setInterval(
    () => nudgeTick().catch(err => console.error('[scheduler] nudgeTick error:', err.message)),
    30 * 60 * 1000
  );
  console.log('[scheduler] started — tick every 60s, nudge every 30m (WAT UTC+1)');
}

module.exports = { initScheduler };
