const Database = require('better-sqlite3');
const path     = require('path');

// ── open ──────────────────────────────────────────────────────────────────────

const db = new Database(
  process.env.DB_PATH || path.join(__dirname, '..', 'tasks.db')
);

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
`);

// Add priority column to tasks if it was created without it
try {
  db.exec(`ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'`);
} catch {
  // Column already exists — safe to ignore
}

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

const getRecurring        = db.prepare('SELECT * FROM recurring_tasks WHERE active = 1 ORDER BY scheduled_time, id');
const addRecurring        = db.prepare(
  `INSERT INTO recurring_tasks (name, business, scheduled_time, active)
   VALUES (?, ?, ?, 1)`
);
const deleteRecurring     = db.prepare('DELETE FROM recurring_tasks WHERE id = ?');
const deactivateRecurring = db.prepare('UPDATE recurring_tasks SET active = 0 WHERE id = ?');
const checkTaskExists = db.prepare('SELECT id FROM tasks WHERE date = ? AND name = ?');

function populateRecurring(date) {
  const recurring = getRecurring.all();
  const insert    = db.transaction((tasks) => {
    for (const t of tasks) {
      const exists = checkTaskExists.get(date, t.name);
      if (!exists) {
        insertTask.run(date, t.name, t.business, t.scheduled_time || null, 'normal');
      }
    }
  });
  insert(recurring);
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

// ── prepared statements — settings ───────────────────────────────────────────

const getSetting    = db.prepare('SELECT value FROM settings WHERE key = ?');
const upsertSetting = db.prepare(`
  INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
`);

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
  addRecurring,
  deleteRecurring,
  deactivateRecurring,
  populateRecurring,

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

  // settings
  getSetting,
  upsertSetting,

  // day log
  syncDayLog,
};
