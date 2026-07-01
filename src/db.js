const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

// On Render: disk must be mounted at /app/data
// On local: data/ directory in project root
// Never store the database in the project directory
// on production as it gets wiped on every deploy.

const DATA_DIR = process.env.DATA_DIR ||
  (process.env.NODE_ENV === 'production'
    ? '/app/data'
    : path.join(__dirname, '..', 'data'));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = process.env.DB_PATH || path.join(DATA_DIR, 'ogv.db');
console.log(`[db] database at ${dbPath}`);

// ── open ──────────────────────────────────────────────────────────────────────

const db = new Database(dbPath);

// ── schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    date     TEXT    NOT NULL,
    name     TEXT    NOT NULL,
    business TEXT    NOT NULL,
    time     TEXT,
    done     INTEGER NOT NULL DEFAULT 0,
    priority TEXT    NOT NULL DEFAULT 'normal'
  );

  CREATE TABLE IF NOT EXISTS day_log (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT    NOT NULL UNIQUE,
    note TEXT
  );

  CREATE TABLE IF NOT EXISTS kpis (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    date     TEXT    NOT NULL,
    business TEXT    NOT NULL,
    metric   TEXT    NOT NULL,
    value    REAL    NOT NULL,
    target   REAL,
    UNIQUE(date, business, metric)
  );

  CREATE TABLE IF NOT EXISTS recurring_tasks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL,
    business       TEXT    NOT NULL,
    scheduled_time TEXT,
    active         INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS task_carry (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    original_task_id INTEGER NOT NULL,
    from_date        TEXT    NOT NULL,
    to_date          TEXT    NOT NULL,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ideas (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    business   TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    business   TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS task_nudges (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id        INTEGER NOT NULL,
    date           TEXT    NOT NULL,
    nudge_count    INTEGER NOT NULL DEFAULT 0,
    last_nudged_at TEXT,
    snoozed_until  TEXT,
    UNIQUE(task_id, date)
  );

  CREATE TABLE IF NOT EXISTS goals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    business    TEXT    NOT NULL,
    dimension   TEXT    NOT NULL CHECK(dimension IN ('growth','finance','operations')),
    title       TEXT    NOT NULL,
    description TEXT,
    target_date TEXT,
    year        INTEGER NOT NULL DEFAULT 2026,
    status      TEXT    DEFAULT 'active' CHECK(status IN ('active','achieved','paused')),
    created_at  TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS monthly_cycles (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    business     TEXT    NOT NULL,
    goal_id      INTEGER REFERENCES goals(id),
    month        TEXT    NOT NULL,
    title        TEXT    NOT NULL,
    commitment_1 TEXT    NOT NULL,
    commitment_2 TEXT    NOT NULL,
    commitment_3 TEXT,
    status_1     TEXT    DEFAULT 'pending' CHECK(status_1 IN ('pending','done')),
    status_2     TEXT    DEFAULT 'pending' CHECK(status_2 IN ('pending','done')),
    status_3     TEXT    DEFAULT 'pending' CHECK(status_3 IN ('pending','done')),
    reflection   TEXT,
    created_at   TEXT    DEFAULT (datetime('now')),
    UNIQUE(business, goal_id, month)
  );

  CREATE TABLE IF NOT EXISTS goal_progress (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id   INTEGER REFERENCES goals(id),
    note      TEXT    NOT NULL,
    logged_at TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS document_analyses (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    business         TEXT,
    document_excerpt TEXT,
    summary          TEXT,
    key_insight      TEXT,
    risk             TEXT,
    tasks_json       TEXT,
    created_at       TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS uploaded_documents (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    filename      TEXT    NOT NULL,
    original_name TEXT    NOT NULL,
    file_type     TEXT    NOT NULL,
    file_size     INTEGER,
    business      TEXT,
    upload_date   TEXT    DEFAULT (datetime('now')),
    parsed_text   TEXT,
    analysis_id   INTEGER REFERENCES document_analyses(id),
    status        TEXT    DEFAULT 'uploaded'
      CHECK(status IN ('uploaded','parsed','analyzed','archived')),
    assigned_to   TEXT,
    tags          TEXT
  );

  CREATE TABLE IF NOT EXISTS team_members (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT    NOT NULL,
    role     TEXT    NOT NULL,
    business TEXT    NOT NULL,
    contact  TEXT,
    active   INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS businesses (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    slug       TEXT    NOT NULL UNIQUE,
    color_bg   TEXT    DEFAULT '#f0f0ee',
    color_text TEXT    DEFAULT '#333333',
    active     INTEGER DEFAULT 1,
    created_at TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pending_recurring (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    date              TEXT    NOT NULL,
    recurring_task_id INTEGER REFERENCES recurring_tasks(id),
    name              TEXT    NOT NULL,
    business          TEXT    NOT NULL,
    scheduled_time    TEXT,
    status            TEXT    DEFAULT 'pending'
      CHECK(status IN ('pending','confirmed','rejected')),
    created_at        TEXT    DEFAULT (datetime('now')),
    UNIQUE(date, recurring_task_id)
  );
`);

// Add columns that may not exist yet (safe to run every startup)
try { db.exec(`ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'`); } catch {}
try { db.exec(`ALTER TABLE recurring_tasks ADD COLUMN days TEXT DEFAULT 'daily'`); } catch {}
try { db.exec(`ALTER TABLE recurring_tasks ADD COLUMN time_block TEXT`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN source TEXT`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN event_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN calendar_event_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN calendar_source TEXT`); } catch {}
try { db.exec(`ALTER TABLE recurring_tasks ADD COLUMN category TEXT DEFAULT 'work'`); } catch {}
try { db.exec(`ALTER TABLE recurring_tasks ADD COLUMN notes TEXT`); } catch {}

// ── WAT helpers ───────────────────────────────────────────────────────────────

function watToday() {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
}

function watTomorrow() {
  return new Date(Date.now() + 60 * 60 * 1000 + 86400000).toISOString().slice(0, 10);
}

function watCutoff(days) {
  return new Date(Date.now() + 60 * 60 * 1000 - days * 86400000).toISOString().slice(0, 10);
}

function weekStart() {
  const now       = new Date(Date.now() + 60 * 60 * 1000);
  const dayOfWeek = now.getUTCDay();
  const toMonday  = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  return new Date(now.getTime() + toMonday * 86400000).toISOString().slice(0, 10);
}

// ── prepared statements — tasks ───────────────────────────────────────────────

const getTasksByDate  = db.prepare('SELECT * FROM tasks WHERE date = ? ORDER BY time, id');
const getTaskById     = db.prepare('SELECT * FROM tasks WHERE id = ?');
const getMostRecentTaskDate = db.prepare(
  'SELECT date, COUNT(*) AS count FROM tasks GROUP BY date ORDER BY date DESC LIMIT 1'
);
const insertTask      = db.prepare(
  `INSERT INTO tasks (date, name, business, time, done, priority)
   VALUES (?, ?, ?, ?, 0, ?)`
);
const toggleTask      = db.prepare('UPDATE tasks SET done = ? WHERE id = ?');
const markTaskDone    = db.prepare('UPDATE tasks SET done = 1 WHERE id = ?');
const updatePriority  = db.prepare('UPDATE tasks SET priority = ? WHERE id = ?');
const deleteTask      = db.prepare('DELETE FROM tasks WHERE id = ?');

// ── prepared statements — history ─────────────────────────────────────────────

const getHistory = (days) =>
  db.prepare(
    `SELECT date,
            COUNT(*)                                AS total,
            SUM(done)                               AS done,
            ROUND(SUM(done) * 100.0 / COUNT(*), 1) AS rate
     FROM tasks
     WHERE date >= ?
     GROUP BY date
     ORDER BY date DESC`
  ).all(watCutoff(days));

// ── prepared statements — KPIs ────────────────────────────────────────────────

const getKpis  = db.prepare('SELECT * FROM kpis WHERE date >= ? ORDER BY date DESC, business, metric');
const upsertKpi = db.prepare(
  `INSERT INTO kpis (date, business, metric, value, target)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(date, business, metric)
   DO UPDATE SET value = excluded.value, target = excluded.target`
);

// ── prepared statements — recurring tasks ────────────────────────────────────

const getRecurring        = db.prepare('SELECT * FROM recurring_tasks WHERE active = 1 ORDER BY business, scheduled_time, id');
const getFutureRecurring  = db.prepare('SELECT * FROM recurring_tasks WHERE active = 0 ORDER BY business, scheduled_time, id');
const addRecurring        = db.prepare(
  `INSERT INTO recurring_tasks (name, business, scheduled_time, days, time_block, category, active)
   VALUES (?, ?, ?, ?, ?, ?, 1)`
);
const deleteRecurring     = db.prepare('DELETE FROM recurring_tasks WHERE id = ?');
const deactivateRecurring = db.prepare('UPDATE recurring_tasks SET active = 0 WHERE id = ?');
const activateRecurring   = db.prepare('UPDATE recurring_tasks SET active = 1 WHERE id = ?');
const getCategoryRecurring = db.prepare('SELECT * FROM recurring_tasks WHERE category = ? AND active = 1 ORDER BY scheduled_time, id');
const checkRecurringExists = db.prepare('SELECT id FROM recurring_tasks WHERE name = ? AND business = ? AND active = 1');
const checkTaskExists      = db.prepare('SELECT id FROM tasks WHERE date = ? AND name = ?');
const insertRecurringTask  = db.prepare(
  `INSERT INTO tasks (date, name, business, time, done, priority, source)
   VALUES (?, ?, ?, ?, 0, 'normal', 'recurring')`
);
const insertCarriedTask = db.prepare(
  `INSERT INTO tasks (date, name, business, time, done, priority, source)
   VALUES (?, ?, ?, ?, 0, ?, 'carried')`
);

function insertTaskSafe(date, name, business, time, priority) {
  const exists = checkTaskExists.get(date, name);
  if (exists) return getTaskById.get(exists.id);
  const info = insertTask.run(date, name, business, time || null, priority || 'normal');
  return getTaskById.get(info.lastInsertRowid);
}

// ── prepared statements — pending recurring ───────────────────────────────────

const insertPendingRecurring = db.prepare(`
  INSERT OR IGNORE INTO pending_recurring (date, recurring_task_id, name, business, scheduled_time)
  VALUES (?, ?, ?, ?, ?)
`);
const getPendingRecurring = db.prepare(`
  SELECT pr.*, rt.days, rt.time_block
  FROM   pending_recurring pr
  LEFT JOIN recurring_tasks rt ON rt.id = pr.recurring_task_id
  WHERE  pr.date = ? AND pr.status = 'pending'
  ORDER  BY pr.scheduled_time, pr.id
`);
const getConfirmedRecurring = db.prepare(
  `SELECT * FROM pending_recurring WHERE date = ? AND status = 'confirmed'`
);
const rejectRecurring = db.prepare(
  `UPDATE pending_recurring SET status = 'rejected' WHERE id = ?`
);
const rejectAllPendingRecurring = db.prepare(
  `UPDATE pending_recurring SET status = 'rejected' WHERE date = ? AND status = 'pending'`
);
const confirmPendingById = db.prepare(
  `UPDATE pending_recurring SET status = 'confirmed' WHERE id = ?`
);
const getPendingRecurringById = db.prepare(
  `SELECT * FROM pending_recurring WHERE id = ?`
);

function confirmRecurring(id) {
  const row = getPendingRecurringById.get(id);
  if (!row) return null;
  const existing = checkTaskExists.get(row.date, row.name);
  if (!existing) {
    insertRecurringTask.run(row.date, row.name, row.business, row.scheduled_time || null);
  }
  confirmPendingById.run(id);
  return getTasksByDate.all(row.date).find(t => t.name === row.name) || null;
}

function confirmAllRecurring(date) {
  const pending = getPendingRecurring.all(date);
  db.transaction((tasks) => {
    for (const t of tasks) {
      const existing = checkTaskExists.get(t.date, t.name);
      if (!existing) {
        insertRecurringTask.run(t.date, t.name, t.business, t.scheduled_time || null);
      }
      confirmPendingById.run(t.id);
    }
  })(pending);
  return getTasksByDate.all(date);
}

function populateRecurring(date) {
  const dayOfWeek = new Date(date + 'T12:00:00Z').getUTCDay(); // 0=Sun … 6=Sat
  const recurring  = getRecurring.all();
  db.transaction((tasks) => {
    for (const t of tasks) {
      const days = t.days || 'daily';
      if (days !== 'daily') {
        const allowed = days.split(',').map(d => parseInt(d.trim(), 10));
        if (!allowed.includes(dayOfWeek)) continue;
      }
      insertPendingRecurring.run(date, t.id, t.name, t.business, t.scheduled_time || null);
    }
  })(recurring);
}

function getTodayTasksIncludingPending(date) {
  const tasks    = getTasksByDate.all(date);
  const pending  = getPendingRecurring.all(date);
  const taskNames = new Set(tasks.map(t => t.name));
  const pendingAsTasks = pending
    .filter(p => !taskNames.has(p.name))
    .map(p => ({
      id:       null,
      date,
      name:     p.name,
      business: p.business,
      time:     p.scheduled_time,
      done:     0,
      source:   'recurring',
      priority: 'normal',
    }));
  return [...tasks, ...pendingAsTasks];
}

function getRecurringGrouped() {
  const all    = getRecurring.all();
  const groups = { blok: [], aphl: [], trade: [], personal: [] };
  for (const t of all) {
    if (groups[t.business]) groups[t.business].push(t);
  }
  return groups;
}

// ── prepared statements — carry forward ──────────────────────────────────────

const insertCarry = db.prepare(
  `INSERT INTO task_carry (original_task_id, from_date, to_date)
   VALUES (?, ?, ?)`
);

function carryTask(taskId, fromDate, toDate) {
  const original = getTaskById.get(taskId);
  if (!original) throw new Error(`Task ${taskId} not found`);

  const info = insertTask.run(
    toDate,
    original.name,
    original.business,
    original.time || null,
    original.priority || 'normal'
  );
  insertCarry.run(taskId, fromDate, toDate);
  return getTaskById.get(info.lastInsertRowid);
}

// ── prepared statements — ideas ───────────────────────────────────────────────

const addIdea  = db.prepare('INSERT INTO ideas (business, content) VALUES (?, ?)');
const getIdeas = db.prepare('SELECT * FROM ideas ORDER BY created_at DESC LIMIT 20');

// ── prepared statements — notes ───────────────────────────────────────────────

const addNote  = db.prepare('INSERT INTO notes (business, content) VALUES (?, ?)');
const getNotes = db.prepare('SELECT * FROM notes ORDER BY created_at DESC LIMIT 20');

// ── prepared statements — nudges ─────────────────────────────────────────────

const getNudgeRecord = db.prepare(
  'SELECT * FROM task_nudges WHERE task_id = ? AND date = ?'
);

const upsertNudge = db.prepare(`
  INSERT INTO task_nudges (task_id, date, nudge_count, last_nudged_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(task_id, date)
  DO UPDATE SET nudge_count = excluded.nudge_count, last_nudged_at = excluded.last_nudged_at
`);

const snoozeTask = db.prepare(`
  INSERT INTO task_nudges (task_id, date, nudge_count, snoozed_until)
  VALUES (?, ?, 0, ?)
  ON CONFLICT(task_id, date)
  DO UPDATE SET snoozed_until = excluded.snoozed_until
`);

function getPendingNudges(date) {
  const now         = new Date(Date.now() + 60 * 60 * 1000);
  const hhmm        = String(now.getUTCHours()).padStart(2, '0') + ':' +
                      String(now.getUTCMinutes()).padStart(2, '0');
  const nowDatetime = now.toISOString().replace('T', ' ').slice(0, 19);

  return db.prepare(`
    SELECT t.*,
           COALESCE(n.nudge_count, 0) AS nudge_count,
           n.snoozed_until
    FROM   tasks t
    LEFT JOIN task_nudges n ON n.task_id = t.id AND n.date = ?
    WHERE  t.date = ?
      AND  t.done = 0
      AND  t.business != 'anchor'
      AND  t.time IS NOT NULL
      AND  t.time <= ?
      AND  COALESCE(n.nudge_count, 0) < 3
      AND  (n.snoozed_until IS NULL OR n.snoozed_until <= ?)
    ORDER BY t.time, t.id
  `).all(date, date, hhmm, nowDatetime);
}

// ── prepared statements — goals ───────────────────────────────────────────────

const getGoals         = db.prepare('SELECT * FROM goals WHERE business = ? ORDER BY dimension');
const getAllGoals       = db.prepare('SELECT * FROM goals ORDER BY business, dimension');
const addGoal          = db.prepare(`
  INSERT INTO goals (business, dimension, title, description, target_date, year)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const updateGoalStatus = db.prepare('UPDATE goals SET status = ? WHERE id = ?');
const updateGoalTitle  = db.prepare('UPDATE goals SET title = ? WHERE id = ?');

// ── prepared statements — monthly cycles ─────────────────────────────────────

const getCycles = db.prepare(`
  SELECT mc.*, g.title AS goal_title, g.dimension
  FROM   monthly_cycles mc
  LEFT JOIN goals g ON g.id = mc.goal_id
  WHERE  mc.month = ?
  ORDER  BY mc.business, mc.id
`);
const getCyclesByGoal = db.prepare(
  'SELECT * FROM monthly_cycles WHERE goal_id = ? ORDER BY month DESC'
);
const getCycleById = db.prepare('SELECT * FROM monthly_cycles WHERE id = ?');
const addCycle     = db.prepare(`
  INSERT INTO monthly_cycles (business, goal_id, month, title, commitment_1, commitment_2, commitment_3)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const updateCycleReflection = db.prepare(
  'UPDATE monthly_cycles SET reflection = ? WHERE id = ?'
);

function updateCycleCommitment(id, which, status) {
  const n = Number(which);
  if (![1, 2, 3].includes(n)) throw new Error('which must be 1, 2, or 3');
  db.prepare(`UPDATE monthly_cycles SET status_${n} = ? WHERE id = ?`).run(status, id);
  return getCycleById.get(id);
}

// ── prepared statements — goal progress ──────────────────────────────────────

const addGoalProgress = db.prepare('INSERT INTO goal_progress (goal_id, note) VALUES (?, ?)');
const getGoalProgress = db.prepare(
  'SELECT * FROM goal_progress WHERE goal_id = ? ORDER BY logged_at DESC LIMIT 10'
);

// ── prepared statements — event sync ─────────────────────────────────────────

const updateTaskEventId = db.prepare('UPDATE tasks SET event_id = ? WHERE id = ?');

// ── prepared statements — Google Calendar import ──────────────────────────────

const getTaskByEventId = db.prepare(
  'SELECT * FROM tasks WHERE calendar_event_id = ? LIMIT 1'
);
const insertCalendarTask = db.prepare(
  `INSERT INTO tasks (date, name, business, time, done, priority, calendar_source, calendar_event_id)
   VALUES (?, ?, ?, ?, 0, 'normal', 'google', ?)`
);
const updateTaskFromCalendar = db.prepare(
  'UPDATE tasks SET name = ?, time = ?, date = ? WHERE calendar_event_id = ?'
);
const deleteTaskByEventId = db.prepare(
  'DELETE FROM tasks WHERE calendar_event_id = ?'
);

// ── prepared statements — task/recurring time update ─────────────────────────

const updateTaskTime      = db.prepare('UPDATE tasks SET time = ? WHERE id = ?');
const updateRecurringTime = db.prepare('UPDATE recurring_tasks SET scheduled_time = ? WHERE id = ?');

// ── prepared statements — businesses ─────────────────────────────────────────

const getBusinesses    = db.prepare('SELECT * FROM businesses WHERE active = 1 ORDER BY id');
const addBusiness      = db.prepare(
  `INSERT INTO businesses (name, slug, color_bg, color_text) VALUES (?, ?, ?, ?)`
);
const deactivateBusiness = db.prepare('UPDATE businesses SET active = 0 WHERE id = ?');
const getBusinessBySlug  = db.prepare('SELECT * FROM businesses WHERE slug = ?');

// ── prepared statements — toggle recurring active ─────────────────────────────

function toggleRecurringActive(id) {
  const row = db.prepare('SELECT active FROM recurring_tasks WHERE id = ?').get(id);
  if (!row) throw new Error(`Recurring task ${id} not found`);
  if (row.active) {
    deactivateRecurring.run(id);
  } else {
    activateRecurring.run(id);
  }
  return { id: Number(id), active: row.active ? 0 : 1 };
}

// ── prepared statements — settings ───────────────────────────────────────────

const getSetting    = db.prepare('SELECT value FROM settings WHERE key = ?');
const upsertSetting = db.prepare(`
  INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
`);
const deleteSetting = db.prepare('DELETE FROM settings WHERE key = ?');

// ── founder profile ───────────────────────────────────────────────────────────
// Everything that used to be hardcoded into AI prompts and schedule defaults
// (name, ventures, routines, investor cadence, brand) lives here instead, so
// this codebase can serve any founder, not just the one it was written for.
// Stored as a JSON blob under settings.founder_profile; DEFAULT_FOUNDER_PROFILE
// is the seed for this instance and also the fallback shape for new ones.

const DEFAULT_FOUNDER_PROFILE = {
  name:       'OGV',
  brandName:  'LIFELINE',
  identity:   'An Igbo entrepreneur running multiple ventures while building his personal foundation.',

  // Order matters — this is the order sections appear in AI-generated briefings/reviews.
  ventures: [
    {
      slug:           'aphl',
      name:           'APHL Africa',
      description:    'Petroleum haulage company based in Port Harcourt. Candy Opusunju runs day-to-day ops and sales.',
      lead:           'Candy Opusunju',
      leadRole:       'Operations and Sales',
      investorFocus:  false,
      activeDays:     'daily',
      status:         'active',
    },
    {
      slug:           'blok',
      name:           'Blok AI',
      description:    'Pre-seed AI wealthtech platform targeting African consumers and diaspora. Currently fundraising. Has a product manager building the product.',
      lead:           'Product Manager',
      leadRole:       'Product Manager',
      investorFocus:  true,
      activeDays:     'weekdays',
      status:         'active',
    },
    {
      slug:           'trade',
      name:           'TradeSol',
      description:    'Youth commerce training. Not an active focus right now.',
      lead:           null,
      leadRole:       null,
      investorFocus:  false,
      activeDays:     'daily',
      status:         'dormant',
    },
  ],

  personalPillars: ['Spiritual', 'Mental', 'Physical', 'Grooming', 'Family'],
  personalLabel:   'TAKE CARE OF YOURSELF FIRST',
  closingLabel:    'CLOSE THE DAY WELL',

  currentGoals: [
    'Get APHL Africa structured and stable',
    'Move Blok AI fundraise forward through real investor relationships',
    'Take care of himself: prayer, journaling, training, family',
  ],

  nonNegotiables: 'Family call is non-negotiable — name it directly if skipped. No flattery. Direct, unsparing accountability.',

  investorCadence: [
    "Monday: Research a new target investor today — know their thesis before you reach out.",
    'Tuesday: Find one warm intro path — who in your network can connect you to a target?',
    'Wednesday: Research an investor deeply — portfolio, thesis, recent posts, mutual connections.',
    'Thursday: Identify another warm intro path and send the ask today.',
    "Friday: Follow up on this week's conversations — update your pipeline while it's fresh.",
    'Saturday: Rest from investor work. Relationships need breathing room.',
    'Sunday: Rest from investor work. Relationships need breathing room.',
  ],

  scheduleBlocks: [
    { time: '05:30', end: '05:45', name: 'Prayer',                                   biz: 'anchor'   },
    { time: '05:45', end: '06:00', name: 'Journaling',                               biz: 'anchor'   },
    { time: '06:00', end: '06:30', name: 'Orient and daily priority',                biz: 'blok'     },
    { time: '06:30', end: '07:00', name: 'Pre-day setup: depot price, brief Candy',  biz: 'aphl'     },
    { time: '07:00', end: '07:30', name: 'Morning command: floor price, driver call',biz: 'aphl'     },
    { time: '07:30', end: '09:00', name: 'Raise: investor relations',                 biz: 'blok'     },
    { time: '08:00', end: '10:00', name: 'Sales push: Candy runs outbound',          biz: 'aphl'     },
    { time: '09:00', end: '10:30', name: 'Product: PM review, product user flow',     biz: 'blok'     },
    { time: '10:00', end: '13:00', name: 'Operations: payments, loading, tracking',  biz: 'aphl'     },
    { time: '10:30', end: '11:30', name: 'Comms: Slack, async check-ins',            biz: 'blok'     },
    { time: '11:30', end: '12:30', name: 'Brand: creative review, social metrics',   biz: 'blok'     },
    { time: '13:00', end: '14:00', name: 'MD strategic hour: depot, pricing',        biz: 'aphl'     },
    { time: '14:00', end: '15:30', name: 'Strategy: priorities, decision log',       biz: 'blok'     },
    { time: '16:00', end: '17:30', name: 'Unified day close: ops sync, revenue log', biz: 'blok'     },
    { time: '17:30', end: '18:00', name: 'Calls to loved ones and family',           biz: 'anchor'   },
    { time: '18:00', end: '19:00', name: 'Pottery or reading',                       biz: 'personal' },
    { time: '19:00', end: '20:00', name: 'Physical activity',                        biz: 'personal' },
    { time: '20:30', end: '21:00', name: 'Evening wind-down and next day planning',  biz: 'anchor'   },
  ],
};

function getFounderProfile() {
  const row = getSetting.get('founder_profile');
  if (!row) return DEFAULT_FOUNDER_PROFILE;
  try {
    const stored = JSON.parse(row.value);
    return { ...DEFAULT_FOUNDER_PROFILE, ...stored };
  } catch {
    return DEFAULT_FOUNDER_PROFILE;
  }
}

function saveFounderProfile(partial) {
  const updated = { ...getFounderProfile(), ...partial };
  upsertSetting.run('founder_profile', JSON.stringify(updated));
  return updated;
}

// ── prepared statements — document analyses ───────────────────────────────────

const saveDocumentAnalysis = db.prepare(
  `INSERT INTO document_analyses (business, document_excerpt, summary, key_insight, risk, tasks_json)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const getDocumentAnalyses = db.prepare(
  'SELECT * FROM document_analyses ORDER BY created_at DESC LIMIT 10'
);

// ── prepared statements — uploaded documents ──────────────────────────────────

const saveUploadedDocument = db.prepare(
  `INSERT INTO uploaded_documents (filename, original_name, file_type, file_size, business, parsed_text)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const getUploadedDocument = db.prepare(
  'SELECT * FROM uploaded_documents WHERE id = ?'
);
const getAllUploadedDocuments = db.prepare(
  `SELECT d.id, d.filename, d.original_name, d.file_type, d.file_size, d.business,
          d.upload_date, d.status, d.analysis_id, d.assigned_to, d.tags,
          a.summary, a.key_insight, a.risk, a.tasks_json
   FROM uploaded_documents d
   LEFT JOIN document_analyses a ON a.id = d.analysis_id
   WHERE d.status != 'archived'
   ORDER BY d.upload_date DESC
   LIMIT 50`
);
const getUploadedDocumentsByBusiness = db.prepare(
  `SELECT d.id, d.filename, d.original_name, d.file_type, d.file_size, d.business,
          d.upload_date, d.status, d.analysis_id, d.assigned_to,
          a.summary
   FROM uploaded_documents d
   LEFT JOIN document_analyses a ON a.id = d.analysis_id
   WHERE d.business = ? AND d.status != 'archived'
   ORDER BY d.upload_date DESC`
);
const updateUploadedDocumentStatus = db.prepare(
  'UPDATE uploaded_documents SET status = ? WHERE id = ?'
);
const linkDocumentToAnalysis = db.prepare(
  'UPDATE uploaded_documents SET analysis_id = ?, status = ? WHERE id = ?'
);
const archiveUploadedDocument = db.prepare(
  "UPDATE uploaded_documents SET status = 'archived' WHERE id = ?"
);
const searchUploadedDocuments = db.prepare(
  `SELECT id, filename, original_name, file_type, business, upload_date, status,
          substr(parsed_text, 1, 200) AS excerpt
   FROM uploaded_documents
   WHERE status != 'archived'
     AND (original_name LIKE ? OR parsed_text LIKE ?)
   ORDER BY upload_date DESC
   LIMIT 20`
);

// ── prepared statements — team members ───────────────────────────────────────

const getTeamMembers = db.prepare(
  'SELECT * FROM team_members WHERE active = 1 ORDER BY business, name'
);
const getMembersByBusiness = db.prepare(
  'SELECT * FROM team_members WHERE (business = ? OR business = ?) AND active = 1 ORDER BY name'
);

// ── team members seed (runs once if table is empty) ──────────────────────────

{
  const count = db.prepare('SELECT COUNT(*) AS n FROM team_members').get();
  if (!count || count.n === 0) {
    const stmt = db.prepare(
      'INSERT INTO team_members (name, role, business, contact) VALUES (?, ?, ?, ?)'
    );
    db.transaction(() => {
      for (const v of DEFAULT_FOUNDER_PROFILE.ventures) {
        if (v.lead) stmt.run(v.lead, v.leadRole || 'Lead', v.slug, '');
      }
      stmt.run(DEFAULT_FOUNDER_PROFILE.name, 'CEO', 'all', '');
    })();
    console.log('[db] Team members seeded');
  }
}

// ── businesses seed (runs once if table is empty) ─────────────────────────────

{
  const count = db.prepare('SELECT COUNT(*) AS n FROM businesses').get();
  if (!count || count.n === 0) {
    const stmt = db.prepare(
      'INSERT INTO businesses (name, slug, color_bg, color_text) VALUES (?, ?, ?, ?)'
    );
    db.transaction(() => {
      stmt.run('Blok AI',     'blok',     '#f0effe', '#4a3fa0');
      stmt.run('APHL Africa', 'aphl',     '#edf7f2', '#1a6646');
      stmt.run('TradeSol',    'trade',    '#fef8ec', '#7a4a0a');
      stmt.run('Personal',    'personal', '#fdf0f4', '#8a2a4a');
    })();
    console.log('[db] Businesses seeded');
  }
}

// ── startup seeds (v4 — runs once, resets previous seeds) ────────────────────

{
  const alreadySeeded = getSetting.get('recurring_seeded_v4');
  if (!alreadySeeded) {
    const SEEDS_V4 = [
      // BLOK AI — INVESTOR RELATIONSHIP BUILDING
      { name: 'Investor relationship touchpoint',        business: 'blok',     category: 'work',     scheduled_time: '07:30', days: '1,2,3,4,5', time_block: 'Raise: investor relations', active: 1, notes: 'One meaningful touchpoint per day. Could be a WhatsApp check-in, sharing a relevant article, updating an investor on a milestone, requesting a warm intro, or following up on a conversation. Not mass email. One person, one genuine interaction.' },
      { name: 'Update investor pipeline and notes',      business: 'blok',     category: 'work',     scheduled_time: '07:50', days: '1,2,3,4,5', time_block: 'Raise: investor relations', active: 1, notes: 'Log what happened with each investor contact today. Record conversation notes, next steps, relationship stage. Track relationship warmth not just email status.' },
      { name: 'Research one target investor',            business: 'blok',     category: 'work',     scheduled_time: '08:05', days: '1,3,5',      time_block: 'Raise: investor relations', active: 1, notes: 'Monday, Wednesday, Friday only. Deep research on one investor or fund. Their portfolio, thesis, recent posts, mutual connections. Know them before you approach them.' },
      { name: 'Identify one warm intro path',            business: 'blok',     category: 'work',     scheduled_time: '08:20', days: '2,4',        time_block: 'Raise: investor relations', active: 1, notes: 'Tuesday and Thursday. Look through your network for one connection who can introduce you to a target investor. Warm intros convert 10x better than cold outreach.' },
      // BLOK AI — PRODUCT & PM
      { name: 'Daily PM check-in with product manager',  business: 'blok',     category: 'work',     scheduled_time: '09:00', days: 'daily',      time_block: 'Product: PM check-in',      active: 1, notes: 'Quick sync — blockers, progress, priorities for today' },
      { name: 'Review PM end of day update',             business: 'blok',     category: 'work',     scheduled_time: '16:00', days: '1,2,3,4,5', time_block: 'Unified day close: ops sync, revenue log', active: 1, notes: 'What shipped or moved today on the product side' },
      { name: 'Weekly product roadmap review with PM',   business: 'blok',     category: 'work',     scheduled_time: '10:00', days: '1',          time_block: 'Product: PM review',        active: 1, notes: 'Monday — full roadmap review, set week priorities' },
      { name: 'Weekly sprint check with PM',             business: 'blok',     category: 'work',     scheduled_time: '10:00', days: '5',          time_block: 'Product: PM review',        active: 1, notes: 'Friday — what shipped, what carries to next week' },
      { name: 'Mid-week product decision sync with PM',  business: 'blok',     category: 'work',     scheduled_time: '10:00', days: '3',          time_block: 'Product: PM review',        active: 1, notes: 'Wednesday — unblock decisions, review user feedback' },
      { name: 'Check and respond to Blok AI comms',      business: 'blok',     category: 'work',     scheduled_time: '10:30', days: 'daily',      time_block: 'Comms: Slack, async check-ins', active: 1, notes: null },
      // APHL AFRICA
      { name: 'Get daily depot price from Yinusi',       business: 'aphl',     category: 'work',     scheduled_time: '06:30', days: 'daily',      time_block: 'Pre-day setup: depot price, brief Candy',   active: 1, notes: null },
      { name: 'Brief Candy on daily sales targets',      business: 'aphl',     category: 'work',     scheduled_time: '06:40', days: 'daily',      time_block: 'Pre-day setup: depot price, brief Candy',   active: 1, notes: null },
      { name: 'Confirm floor price and driver briefing', business: 'aphl',     category: 'work',     scheduled_time: '07:00', days: 'daily',      time_block: 'Morning command: floor price, driver call',  active: 1, notes: null },
      { name: 'Track loading progress and trip status',  business: 'aphl',     category: 'work',     scheduled_time: '10:00', days: 'daily',      time_block: 'Operations: payments, loading, tracking',   active: 1, notes: null },
      { name: 'Log daily revenue and close ops',         business: 'aphl',     category: 'work',     scheduled_time: '16:30', days: 'daily',      time_block: 'Unified day close: ops sync, revenue log',  active: 1, notes: null },
      { name: 'Review Candy daily sales report',         business: 'aphl',     category: 'work',     scheduled_time: '16:45', days: 'daily',      time_block: 'Unified day close: ops sync, revenue log',  active: 1, notes: null },
      // PERSONAL — SPIRITUAL
      { name: 'Morning prayer',                          business: 'personal', category: 'spiritual', scheduled_time: '05:30', days: 'daily',      time_block: 'Prayer',                                    active: 1, notes: null },
      { name: 'Evening gratitude and reflection',        business: 'personal', category: 'spiritual', scheduled_time: '20:30', days: 'daily',      time_block: 'Evening wind-down and next day planning',   active: 1, notes: null },
      // PERSONAL — MENTAL
      { name: 'Morning journaling — brain and intention', business: 'personal', category: 'mental',   scheduled_time: '05:45', days: 'daily',      time_block: 'Journaling',                                active: 1, notes: null },
      { name: 'Midday mindfulness check-in (5 minutes)', business: 'personal', category: 'mental',   scheduled_time: '13:00', days: 'daily',      time_block: 'MD strategic hour: depot, pricing',         active: 1, notes: null },
      { name: 'Evening wind-down and plan tomorrow',     business: 'personal', category: 'mental',    scheduled_time: '20:30', days: 'daily',      time_block: 'Evening wind-down and next day planning',   active: 1, notes: null },
      // PERSONAL — PHYSICAL
      { name: 'Physical training session',               business: 'personal', category: 'physical',  scheduled_time: '19:00', days: 'daily',      time_block: 'Physical activity',                         active: 1, notes: null },
      { name: 'Read for 20 minutes',                     business: 'personal', category: 'physical',  scheduled_time: '18:00', days: 'daily',      time_block: 'Pottery or reading',                        active: 1, notes: null },
      // PERSONAL — GROOMING
      { name: 'Morning hygiene and grooming routine',    business: 'personal', category: 'grooming',  scheduled_time: '06:00', days: 'daily',      time_block: 'Orient and daily priority',                 active: 1, notes: null },
      // PERSONAL — FAMILY
      { name: 'Calls to loved ones and family',          business: 'personal', category: 'family',    scheduled_time: '17:30', days: 'daily',      time_block: 'Calls to loved ones and family',            active: 1, notes: 'Family first. Then close friends. Be present in the conversation.' },
      { name: 'Family check-in call',                    business: 'personal', category: 'family',    scheduled_time: '17:30', days: 'daily',      time_block: 'Calls to loved ones and family',            active: 1, notes: 'Call at least one family member today. Parents, siblings, close relatives. Not WhatsApp. A real call.' },
      { name: 'Weekly family time (longer call or visit)', business: 'personal', category: 'family',  scheduled_time: '17:30', days: '6',          time_block: 'Calls to loved ones and family',            active: 1, notes: 'Saturday. Longer call or in-person time with family. No business talk.' },
      // FUTURE (not yet active)
      { name: 'Pottery session',                         business: 'personal', category: 'physical',  scheduled_time: '18:00', days: '1,3,5',      time_block: 'Pottery or reading',                        active: 0, notes: null },
    ];

    const seedStmt = db.prepare(
      `INSERT INTO recurring_tasks (name, business, scheduled_time, days, time_block, category, notes, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    db.prepare('DELETE FROM recurring_tasks').run();
    db.transaction(() => {
      for (const s of SEEDS_V4) {
        seedStmt.run(
          s.name, s.business, s.scheduled_time || null, s.days || 'daily',
          s.time_block || null, s.category || 'work', s.notes || null,
          s.active !== undefined ? s.active : 1
        );
      }
    })();
    upsertSetting.run('recurring_seeded_v4', '1');
    console.log('[db] Recurring tasks reset to v4');
  }
}

// ── anchors migration (v2) — renames schedule blocks in stored settings ───────

{
  const alreadyMigrated = getSetting.get('anchors_seeded_v2');
  if (!alreadyMigrated) {
    const stored = getSetting.get('schedule_blocks');
    if (stored) {
      try {
        let blocks = JSON.parse(stored.value);
        blocks = blocks.map(b => {
          if (b.name === 'Calls to loved ones') return { ...b, name: 'Calls to loved ones and family' };
          if (b.name === 'Raise: 5 investor emails, CRM update') return { ...b, name: 'Raise: investor relations' };
          return b;
        });
        upsertSetting.run('schedule_blocks', JSON.stringify(blocks));
      } catch {}
    }
    upsertSetting.run('anchors_seeded_v2', '1');
    console.log('[db] Anchor blocks migrated to v2');
  }
}

// ── day log + recurring population ───────────────────────────────────────────

function syncDayLog(date) {
  populateRecurring(date);
  db.prepare('INSERT OR IGNORE INTO day_log (date) VALUES (?)').run(date);
}

// ── exports ───────────────────────────────────────────────────────────────────

module.exports = {
  db,

  // helpers
  watToday,
  watTomorrow,
  watCutoff,
  weekStart,

  // tasks
  getTasksByDate,
  getTaskById,
  insertTask,
  insertCarriedTask,
  insertTaskSafe,
  getMostRecentTaskDate,
  toggleTask,
  markTaskDone,
  updatePriority,
  deleteTask,

  // history
  getHistory,

  // KPIs
  getKpis,
  upsertKpi,

  // recurring
  getRecurring,
  getFutureRecurring,
  getRecurringGrouped,
  addRecurring,
  deleteRecurring,
  deactivateRecurring,
  activateRecurring,
  getCategoryRecurring,
  populateRecurring,
  toggleRecurringActive,
  updateRecurringTime,

  // pending recurring
  getPendingRecurring,
  getConfirmedRecurring,
  rejectRecurring,
  rejectAllPendingRecurring,
  confirmRecurring,
  confirmAllRecurring,
  getTodayTasksIncludingPending,

  // carry
  carryTask,

  // ideas
  addIdea,
  getIdeas,

  // notes
  addNote,
  getNotes,

  // nudges
  getNudgeRecord,
  upsertNudge,
  snoozeTask,
  getPendingNudges,

  // goals
  getGoals,
  getAllGoals,
  addGoal,
  updateGoalStatus,
  updateGoalTitle,

  // monthly cycles
  getCycles,
  getCyclesByGoal,
  getCycleById,
  addCycle,
  updateCycleCommitment,
  updateCycleReflection,

  // goal progress
  addGoalProgress,
  getGoalProgress,

  // event sync
  updateTaskEventId,

  // task time update
  updateTaskTime,

  // businesses
  getBusinesses,
  addBusiness,
  deactivateBusiness,
  getBusinessBySlug,

  // calendar import
  getTaskByEventId,
  insertCalendarTask,
  updateTaskFromCalendar,
  deleteTaskByEventId,

  // settings
  getSetting,
  upsertSetting,
  deleteSetting,

  // founder profile
  getFounderProfile,
  saveFounderProfile,
  DEFAULT_FOUNDER_PROFILE,

  // document analyses
  saveDocumentAnalysis,
  getDocumentAnalyses,

  // uploaded documents
  saveUploadedDocument,
  getUploadedDocument,
  getAllUploadedDocuments,
  getUploadedDocumentsByBusiness,
  updateUploadedDocumentStatus,
  linkDocumentToAnalysis,
  archiveUploadedDocument,
  searchUploadedDocuments,

  // team members
  getTeamMembers,
  getMembersByBusiness,

  // day log
  syncDayLog,
};
