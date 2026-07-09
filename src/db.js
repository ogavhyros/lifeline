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

// ── DEBUG: task-insert tracing (duplication investigation) ──────────────────
// Temporary instrumentation — logs every task insert with its source, the
// process PID (so overlapping process instances show up as distinct pids in
// the same log window), and a timestamp. Remove once the duplication bug is
// root-caused and fixed.
function logTaskInsert(source, title, meta = {}) {
  const parts = [`source=${source}`, `title=${JSON.stringify(title)}`, `pid=${process.pid}`, `time=${new Date().toISOString()}`];
  for (const [k, v] of Object.entries(meta)) parts.push(`${k}=${v ?? 'n/a'}`);
  console.log(`[TASK-INSERT] ${parts.join(' ')}`);
}

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
    date TEXT    NOT NULL,
    note TEXT
  );

  CREATE TABLE IF NOT EXISTS kpis (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    date     TEXT    NOT NULL,
    business TEXT    NOT NULL,
    metric   TEXT    NOT NULL,
    value    REAL    NOT NULL,
    target   REAL
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
    created_at   TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS goal_progress (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id   INTEGER REFERENCES goals(id),
    note      TEXT    NOT NULL,
    logged_at TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT NOT NULL,
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
    slug       TEXT    NOT NULL,
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
    created_at        TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS anchor_log (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT    NOT NULL,
    key  TEXT    NOT NULL,
    done INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS users (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    email                TEXT UNIQUE NOT NULL,
    password_hash        TEXT,
    name                 TEXT,
    onboarding_completed INTEGER NOT NULL DEFAULT 0,
    telegram_chat_id     TEXT UNIQUE,
    created_at           TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS telegram_connect_tokens (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT PRIMARY KEY,
    sess    TEXT NOT NULL,
    expires INTEGER NOT NULL
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
try { db.exec(`ALTER TABLE tasks ADD COLUMN status TEXT`); } catch {}

// ── multi-tenancy: user_id column on every previously-global table ───────────
// Nullable on add (existing rows get backfilled to user 1 in the one-time
// migration further down); NOT NULL is enforced at the application layer
// (every query below always supplies it), not via a SQL constraint, so this
// ALTER stays a cheap no-op re-run on every boot like the others above.
// (goal_progress is deliberately excluded — it's always reached through an
// already-owned goal_id, checked explicitly at the route layer via
// getGoalById, rather than carrying its own redundant user_id column.)
for (const t of [
  'tasks', 'recurring_tasks', 'task_carry', 'ideas', 'notes', 'task_nudges',
  'goals', 'monthly_cycles', 'document_analyses',
  'uploaded_documents', 'team_members', 'businesses', 'pending_recurring',
  'anchor_log', 'day_log', 'kpis', 'settings',
]) {
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN user_id INTEGER`); } catch {}
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_tasks_user_id             ON tasks(user_id);
  CREATE INDEX IF NOT EXISTS idx_recurring_tasks_user_id    ON recurring_tasks(user_id);
  CREATE INDEX IF NOT EXISTS idx_goals_user_id              ON goals(user_id);
  CREATE INDEX IF NOT EXISTS idx_monthly_cycles_user_id     ON monthly_cycles(user_id);
  CREATE INDEX IF NOT EXISTS idx_businesses_user_id         ON businesses(user_id);
  CREATE INDEX IF NOT EXISTS idx_anchor_log_user_id         ON anchor_log(user_id);
  CREATE INDEX IF NOT EXISTS idx_settings_user_key          ON settings(user_id, key);
  CREATE INDEX IF NOT EXISTS idx_uploaded_documents_user_id ON uploaded_documents(user_id);
  CREATE INDEX IF NOT EXISTS idx_pending_recurring_user_id  ON pending_recurring(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires           ON sessions(expires);
`);

// ── kanban board status — keeps tasks.status in sync with done/date ──────────
// Column values: 'backlog' | 'today' | 'in_progress' | 'done'. Rather than
// touching every INSERT call site (insertTask, insertRecurringTask,
// insertCarriedTask, insertCalendarTask …) to pass a status explicitly, these
// triggers derive it from the row's own done/date whenever a caller leaves
// status NULL (on insert) or flips done (via toggleTask/markTaskDone/Telegram/
// calendar sync) — so the Board stays correct no matter which existing code
// path touched the task. date('now','+1 hours') mirrors watToday()'s WAT
// (UTC+1) offset so "today" lines up with what the rest of the app considers
// today. PATCH /api/tasks/:id/status (server.js) always writes status last,
// after any done/date side effects, so an explicit board move always wins.
db.exec(`
  CREATE TRIGGER IF NOT EXISTS trg_tasks_status_on_insert
  AFTER INSERT ON tasks
  WHEN NEW.status IS NULL
  BEGIN
    UPDATE tasks SET status = CASE
      WHEN NEW.done = 1 THEN 'done'
      WHEN NEW.date = date('now','+1 hours') THEN 'today'
      ELSE 'backlog'
    END
    WHERE id = NEW.id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_tasks_status_on_done_change
  AFTER UPDATE OF done ON tasks
  WHEN NEW.done != OLD.done
  BEGIN
    UPDATE tasks SET status = CASE
      WHEN NEW.done = 1 THEN 'done'
      WHEN NEW.date = date('now','+1 hours') THEN 'today'
      ELSE 'backlog'
    END
    WHERE id = NEW.id;
  END;
`);

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

// ── settings table UNIQUE(user_id, key) rebuild (v1) ─────────────────────────
// SQLite can't alter a UNIQUE constraint in place; the original table had a
// plain UNIQUE(key). Must run before any statement below prepares an
// `ON CONFLICT(user_id, key)` clause against this table.

{
  const hasUserIdUnique = db.prepare(`PRAGMA index_list(settings)`).all()
    .some(ix => ix.unique && db.prepare(`PRAGMA index_info(${ix.name})`).all().some(c => c.name === 'user_id'));
  if (!hasUserIdUnique) {
    db.exec(`
      CREATE TABLE settings_new (
        user_id    INTEGER NOT NULL DEFAULT 0,
        key        TEXT NOT NULL,
        value      TEXT,
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, key)
      );
      INSERT INTO settings_new (user_id, key, value, updated_at)
        SELECT
          CASE WHEN key IN ('recurring_seeded_v4', 'anchors_seeded_v2', 'kanban_status_seeded_v1')
               THEN 0 ELSE COALESCE(user_id, 1) END,
          key, value, updated_at
        FROM settings;
      DROP TABLE settings;
      ALTER TABLE settings_new RENAME TO settings;
      CREATE INDEX IF NOT EXISTS idx_settings_user_key ON settings(user_id, key);
    `);
    console.log('[db] settings table rebuilt with UNIQUE(user_id, key)');
  }
}

// ── fixup (v1): the settings rebuild above originally routed ALL pre-existing
// rows to user 1, including system migration-guard flags that need to live
// under SYSTEM_USER_ID (0) — this crashed production (recurring_seeded_v4
// looked "never run" against 6 months of real data, and re-running that
// reset hit a FOREIGN KEY violation deleting recurring_tasks still
// referenced by pending_recurring). This one-time fixup relocates any of
// those flags that already landed under user 1 back to user 0, for
// databases where the (now-corrected) rebuild above already ran once with
// the bug. Safe/no-op on a database that never had the bug.
{
  const misplacedFlagStmt = db.prepare(
    `UPDATE settings SET user_id = 0
     WHERE user_id = 1 AND key IN ('recurring_seeded_v4', 'anchors_seeded_v2', 'kanban_status_seeded_v1')`
  );
  const info = misplacedFlagStmt.run();
  if (info.changes > 0) {
    console.log(`[db] relocated ${info.changes} misplaced system migration flag(s) from user 1 to the system user`);
  }
}

// ── anchor_log UNIQUE(user_id, date, key) rebuild (v1) ────────────────────────
// Same rebuild-in-place technique as settings above, for the same reason
// (SQLite can't ALTER a UNIQUE constraint). Also must run before any
// statement below prepares an `ON CONFLICT(user_id, date, key)` clause.

{
  const hasUserIdUnique = db.prepare(`PRAGMA index_list(anchor_log)`).all()
    .some(ix => ix.unique && db.prepare(`PRAGMA index_info(${ix.name})`).all().some(c => c.name === 'user_id'));
  if (!hasUserIdUnique) {
    db.exec(`
      CREATE TABLE anchor_log_new (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL DEFAULT 1,
        date    TEXT    NOT NULL,
        key     TEXT    NOT NULL,
        done    INTEGER NOT NULL DEFAULT 0,
        UNIQUE(user_id, date, key)
      );
      INSERT INTO anchor_log_new (id, user_id, date, key, done)
        SELECT id, COALESCE(user_id, 1), date, key, done FROM anchor_log;
      DROP TABLE anchor_log;
      ALTER TABLE anchor_log_new RENAME TO anchor_log;
      CREATE INDEX IF NOT EXISTS idx_anchor_log_user_id ON anchor_log(user_id);
    `);
    console.log('[db] anchor_log table rebuilt with UNIQUE(user_id, date, key)');
  }
}

// ── kpis / monthly_cycles / pending_recurring / businesses rebuilds (v1) ─────
// Same rebuild-in-place technique as settings/anchor_log above: each of these
// had a UNIQUE constraint that needs user_id folded into it (kpis and
// monthly_cycles are read via ON CONFLICT upserts; pending_recurring relies
// on its UNIQUE constraint for INSERT OR IGNORE to actually dedupe; businesses
// went from a globally-unique slug to one unique per user, since two
// different users must each be able to have e.g. a "personal" business).

function _hasUserIdInUniqueIndex(table) {
  return db.prepare(`PRAGMA index_list(${table})`).all()
    .some(ix => ix.unique && db.prepare(`PRAGMA index_info(${ix.name})`).all().some(c => c.name === 'user_id'));
}

if (!_hasUserIdInUniqueIndex('day_log')) {
  db.exec(`
    CREATE TABLE day_log_new (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      date    TEXT    NOT NULL,
      note    TEXT,
      UNIQUE(user_id, date)
    );
    INSERT INTO day_log_new (id, user_id, date, note)
      SELECT id, COALESCE(user_id, 1), date, note FROM day_log;
    DROP TABLE day_log;
    ALTER TABLE day_log_new RENAME TO day_log;
    CREATE INDEX IF NOT EXISTS idx_day_log_user_id ON day_log(user_id);
  `);
  console.log('[db] day_log table rebuilt with UNIQUE(user_id, date)');
}

if (!_hasUserIdInUniqueIndex('kpis')) {
  db.exec(`
    CREATE TABLE kpis_new (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id  INTEGER NOT NULL DEFAULT 1,
      date     TEXT    NOT NULL,
      business TEXT    NOT NULL,
      metric   TEXT    NOT NULL,
      value    REAL    NOT NULL,
      target   REAL,
      UNIQUE(user_id, date, business, metric)
    );
    INSERT INTO kpis_new (id, user_id, date, business, metric, value, target)
      SELECT id, COALESCE(user_id, 1), date, business, metric, value, target FROM kpis;
    DROP TABLE kpis;
    ALTER TABLE kpis_new RENAME TO kpis;
    CREATE INDEX IF NOT EXISTS idx_kpis_user_id ON kpis(user_id);
  `);
  console.log('[db] kpis table rebuilt with UNIQUE(user_id, date, business, metric)');
}

if (!_hasUserIdInUniqueIndex('monthly_cycles')) {
  db.exec(`
    CREATE TABLE monthly_cycles_new (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL DEFAULT 1,
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
      UNIQUE(user_id, business, goal_id, month)
    );
    INSERT INTO monthly_cycles_new (id, user_id, business, goal_id, month, title, commitment_1, commitment_2, commitment_3, status_1, status_2, status_3, reflection, created_at)
      SELECT id, COALESCE(user_id, 1), business, goal_id, month, title, commitment_1, commitment_2, commitment_3, status_1, status_2, status_3, reflection, created_at FROM monthly_cycles;
    DROP TABLE monthly_cycles;
    ALTER TABLE monthly_cycles_new RENAME TO monthly_cycles;
    CREATE INDEX IF NOT EXISTS idx_monthly_cycles_user_id ON monthly_cycles(user_id);
  `);
  console.log('[db] monthly_cycles table rebuilt with UNIQUE(user_id, business, goal_id, month)');
}

if (!_hasUserIdInUniqueIndex('pending_recurring')) {
  db.exec(`
    CREATE TABLE pending_recurring_new (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id           INTEGER NOT NULL DEFAULT 1,
      date              TEXT    NOT NULL,
      recurring_task_id INTEGER REFERENCES recurring_tasks(id),
      name              TEXT    NOT NULL,
      business          TEXT    NOT NULL,
      scheduled_time    TEXT,
      status            TEXT    DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected')),
      created_at        TEXT    DEFAULT (datetime('now')),
      UNIQUE(user_id, date, recurring_task_id)
    );
    INSERT INTO pending_recurring_new (id, user_id, date, recurring_task_id, name, business, scheduled_time, status, created_at)
      SELECT id, COALESCE(user_id, 1), date, recurring_task_id, name, business, scheduled_time, status, created_at FROM pending_recurring;
    DROP TABLE pending_recurring;
    ALTER TABLE pending_recurring_new RENAME TO pending_recurring;
    CREATE INDEX IF NOT EXISTS idx_pending_recurring_user_id ON pending_recurring(user_id);
  `);
  console.log('[db] pending_recurring table rebuilt with UNIQUE(user_id, date, recurring_task_id)');
}

if (!_hasUserIdInUniqueIndex('businesses')) {
  db.exec(`
    CREATE TABLE businesses_new (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL DEFAULT 1,
      name       TEXT    NOT NULL,
      slug       TEXT    NOT NULL,
      color_bg   TEXT    DEFAULT '#f0f0ee',
      color_text TEXT    DEFAULT '#333333',
      active     INTEGER DEFAULT 1,
      created_at TEXT    DEFAULT (datetime('now')),
      UNIQUE(user_id, slug)
    );
    INSERT INTO businesses_new (id, user_id, name, slug, color_bg, color_text, active, created_at)
      SELECT id, COALESCE(user_id, 1), name, slug, color_bg, color_text, active, created_at FROM businesses;
    DROP TABLE businesses;
    ALTER TABLE businesses_new RENAME TO businesses;
    CREATE INDEX IF NOT EXISTS idx_businesses_user_id ON businesses(user_id);
  `);
  console.log('[db] businesses table rebuilt with UNIQUE(user_id, slug)');
}

// ── prepared statements — settings ───────────────────────────────────────────
// Keyed by (user_id, key). Migration/system guard flags (recurring_seeded_v4,
// anchors_seeded_v2, etc.) are not owned by any real user — they use the
// reserved SYSTEM_USER_ID (0), which AUTOINCREMENT can never assign to a real
// user, rather than a second table just for one-time migration flags.

const SYSTEM_USER_ID = 0;

const getSettingStmt    = db.prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?');
const upsertSettingStmt = db.prepare(`
  INSERT INTO settings (user_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
`);
const deleteSettingStmt = db.prepare('DELETE FROM settings WHERE user_id = ? AND key = ?');

function getSetting(userId, key) {
  return getSettingStmt.get(userId, key);
}
function upsertSetting(userId, key, value) {
  return upsertSettingStmt.run(userId, key, value);
}
function deleteSetting(userId, key) {
  return deleteSettingStmt.run(userId, key);
}
function getSystemFlag(key) { return getSettingStmt.get(SYSTEM_USER_ID, key); }
function setSystemFlag(key, value) { return upsertSettingStmt.run(SYSTEM_USER_ID, key, value); }

// ── users / auth ───────────────────────────────────────────────────────────────

const getUserById       = db.prepare('SELECT * FROM users WHERE id = ?');
const getUserByEmail    = db.prepare('SELECT * FROM users WHERE email = ?');
const getUserByChatId   = db.prepare('SELECT * FROM users WHERE telegram_chat_id = ?');
const insertUser        = db.prepare(`
  INSERT INTO users (email, password_hash, name, onboarding_completed)
  VALUES (?, ?, ?, ?)
`);
const setUserPassword   = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
const setOnboardingDone = db.prepare('UPDATE users SET onboarding_completed = 1 WHERE id = ?');
const setUserChatId     = db.prepare('UPDATE users SET telegram_chat_id = ? WHERE id = ?');
const clearUserChatId   = db.prepare('UPDATE users SET telegram_chat_id = NULL WHERE id = ?');
const getAllUsersWithChat = db.prepare('SELECT * FROM users WHERE telegram_chat_id IS NOT NULL');

const insertConnectToken = db.prepare(`
  INSERT INTO telegram_connect_tokens (token, user_id, expires_at) VALUES (?, ?, ?)
`);
const getConnectToken    = db.prepare(`
  SELECT * FROM telegram_connect_tokens WHERE token = ? AND expires_at > datetime('now')
`);
const deleteConnectToken = db.prepare('DELETE FROM telegram_connect_tokens WHERE token = ?');

// ── anchors — daily habit toggles (Prayer, Journaling, family time, etc.) ─────
// The set of anchors is NOT hardcoded here — it's derived from whichever
// schedule blocks are tagged biz: 'anchor' in the founder's schedule (editable
// via the Schedule tab, or the founder_profile default), so renaming/adding/
// removing an anchor block there is automatically reflected without a second
// list to keep in sync. done/not-done state itself is tracked per day in
// anchor_log, since these blocks are display-only schedule entries, not real
// rows in the `tasks` table.

function slugifyAnchorKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function getAnchorDefs(userId) {
  const override = getSetting(userId, 'schedule_blocks');
  let blocks;
  try { blocks = override ? JSON.parse(override.value) : getFounderProfile(userId).scheduleBlocks; }
  catch { blocks = getFounderProfile(userId).scheduleBlocks; }
  return (blocks || [])
    .filter(b => b.biz === 'anchor')
    .map(b => ({ key: slugifyAnchorKey(b.name), label: b.name, time: b.time }));
}

const getAnchorLogForDate = db.prepare('SELECT key, done FROM anchor_log WHERE user_id = ? AND date = ?');
const toggleAnchorLogStmt = db.prepare(`
  INSERT INTO anchor_log (user_id, date, key, done) VALUES (?, ?, ?, 1)
  ON CONFLICT(user_id, date, key) DO UPDATE SET done = 1 - done
`);
const getAnchorDoneStmt = db.prepare('SELECT done FROM anchor_log WHERE user_id = ? AND date = ? AND key = ?');

function getAnchorsForDate(userId, date) {
  const defs    = getAnchorDefs(userId);
  const doneMap = {};
  for (const r of getAnchorLogForDate.all(userId, date)) doneMap[r.key] = !!r.done;
  return defs.map(a => ({ id: a.key, key: a.key, label: a.label, time: a.time, done: doneMap[a.key] ?? false }));
}

function toggleAnchor(userId, date, key) {
  if (!getAnchorDefs(userId).some(a => a.key === key)) return null;
  toggleAnchorLogStmt.run(userId, date, key);
  return !!getAnchorDoneStmt.get(userId, date, key).done;
}

// ── scorecard metrics ─────────────────────────────────────────────────────────

// Counts distinct days this week (Mon–today) with at least one completed task
// whose name mentions "investor" — matches the recurring "Investor relationship
// touchpoint" task and similar. One touchpoint per day is the target, so
// distinct days (not raw task count) is what "investor touches" means here.
const getInvestorTouchesStmt = db.prepare(`
  SELECT COUNT(DISTINCT date) AS cnt FROM tasks
  WHERE user_id = ? AND done = 1 AND date >= ? AND date <= ? AND LOWER(name) LIKE '%investor%'
`);

function getInvestorTouchesThisWeek(userId) {
  return getInvestorTouchesStmt.get(userId, weekStart(), watToday()).cnt;
}

// % of goals with a target_date inside the current calendar quarter that are
// marked 'achieved'. Returns null (not 0) when no goals fall in this quarter,
// so the frontend can show "—" instead of a misleading 0%.
const getGoalsInRangeStmt = db.prepare(
  'SELECT status FROM goals WHERE user_id = ? AND target_date IS NOT NULL AND target_date BETWEEN ? AND ?'
);

function quarterRange() {
  const today       = new Date(watToday() + 'T00:00:00Z');
  const startMonth  = Math.floor(today.getUTCMonth() / 3) * 3;
  const start       = new Date(Date.UTC(today.getUTCFullYear(), startMonth, 1));
  const end         = new Date(Date.UTC(today.getUTCFullYear(), startMonth + 3, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function getQuarterlyGoalPct(userId) {
  const { start, end } = quarterRange();
  const rows = getGoalsInRangeStmt.all(userId, start, end);
  if (rows.length === 0) return null;
  const achieved = rows.filter(r => r.status === 'achieved').length;
  return Math.round((achieved / rows.length) * 100);
}

// ── prepared statements — tasks ───────────────────────────────────────────────

const getTasksByDateStmt  = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND date = ? ORDER BY time, id');
const getTaskByIdStmt     = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND id = ?');
const getMostRecentTaskDateStmt = db.prepare(
  'SELECT date, COUNT(*) AS count FROM tasks WHERE user_id = ? GROUP BY date ORDER BY date DESC LIMIT 1'
);
const insertTaskStmt = db.prepare(
  `INSERT INTO tasks (user_id, date, name, business, time, done, priority)
   VALUES (?, ?, ?, ?, ?, 0, ?)`
);
const toggleTaskStmt      = db.prepare('UPDATE tasks SET done = ? WHERE user_id = ? AND id = ?');
const markTaskDoneStmt    = db.prepare('UPDATE tasks SET done = 1 WHERE user_id = ? AND id = ?');
const updatePriorityStmt  = db.prepare('UPDATE tasks SET priority = ? WHERE user_id = ? AND id = ?');
const deleteTaskStmt      = db.prepare('DELETE FROM tasks WHERE user_id = ? AND id = ?');
const updateTaskStatusStmt = db.prepare('UPDATE tasks SET status = ? WHERE user_id = ? AND id = ?');
const updateTaskDateStmt   = db.prepare('UPDATE tasks SET date = ? WHERE user_id = ? AND id = ?');

const getTasksByDate  = (userId, date) => getTasksByDateStmt.all(userId, date);
const getTaskById     = (userId, id)   => getTaskByIdStmt.get(userId, id);
const getMostRecentTaskDate = (userId) => getMostRecentTaskDateStmt.get(userId);
const insertTask      = (userId, date, name, business, time, priority) =>
  insertTaskStmt.run(userId, date, name, business, time || null, priority || 'normal');
const toggleTask       = (userId, done, id) => toggleTaskStmt.run(done, userId, id);
const markTaskDone     = (userId, id)       => markTaskDoneStmt.run(userId, id);
const updatePriority   = (userId, priority, id) => updatePriorityStmt.run(priority, userId, id);
const deleteTask        = (userId, id) => deleteTaskStmt.run(userId, id);
const updateTaskStatus  = (userId, status, id) => updateTaskStatusStmt.run(status, userId, id);
const updateTaskDate    = (userId, date, id)   => updateTaskDateStmt.run(date, userId, id);

// ── prepared statements — kanban board ────────────────────────────────────────
// Bounded to the last 60 days (like getHistory's watCutoff pattern) so the
// Board doesn't turn into an unbounded dump of every daily recurring-task row
// this app has ever generated — only recently-relevant tasks are board items.
const getBoardTasksStmt = db.prepare(`
  SELECT * FROM tasks
  WHERE user_id = ? AND date >= ?
  ORDER BY
    CASE status WHEN 'today' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'backlog' THEN 2 ELSE 3 END,
    CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
    date, id
`);
function getBoardTasks(userId) {
  return getBoardTasksStmt.all(userId, watCutoff(60));
}

// ── deduplication ─────────────────────────────────────────────────────────────
// Guards against the Google Calendar sync loop: a task pushed to Calendar
// that gets pulled back in reads as "[BUSINESS] task name" (or "✓ [BUSINESS]
// task name" if done), which is the same task under a different name.

function _stripCalendarPrefix(name) {
  return String(name || '').replace(/^✓\s*/, '').replace(/^\[[^\]]+\]\s*/, '').trim();
}

function deduplicateTasks(userId, date) {
  const tasks    = getTasksByDate(userId, date);
  const toDelete = new Set();

  // Exact-name duplicates: keep a done one over a not-done one, else lowest id.
  const byName = new Map();
  for (const t of tasks) {
    if (!byName.has(t.name)) byName.set(t.name, []);
    byName.get(t.name).push(t);
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const done   = group.filter(t => t.done);
    const keeper = (done.length ? done : group).slice().sort((a, b) => a.id - b.id)[0];
    for (const t of group) {
      if (t.id !== keeper.id) toDelete.add(t.id);
    }
  }

  // Calendar-derived tasks whose title is a business-prefixed rewrite of a
  // non-calendar task's name — same task re-imported from its own synced event.
  const remaining     = tasks.filter(t => !toDelete.has(t.id));
  const originalNames = new Set(
    remaining.filter(t => t.calendar_source !== 'google').map(t => t.name)
  );
  for (const t of remaining) {
    if (t.calendar_source !== 'google') continue;
    const stripped = _stripCalendarPrefix(t.name);
    if (stripped !== t.name && originalNames.has(stripped)) {
      toDelete.add(t.id);
    }
  }

  if (!toDelete.size) return 0;
  db.transaction((ids) => {
    for (const id of ids) deleteTask(userId, id);
  })([...toDelete]);
  return toDelete.size;
}

// ── prepared statements — history ─────────────────────────────────────────────

const getHistory = (userId, days) =>
  db.prepare(
    `SELECT date,
            COUNT(*)                                AS total,
            SUM(done)                               AS done,
            ROUND(SUM(done) * 100.0 / COUNT(*), 1) AS rate
     FROM tasks
     WHERE user_id = ? AND date >= ?
     GROUP BY date
     ORDER BY date DESC`
  ).all(userId, watCutoff(days));

// ── prepared statements — KPIs ────────────────────────────────────────────────

const getKpisStmt  = db.prepare('SELECT * FROM kpis WHERE user_id = ? AND date >= ? ORDER BY date DESC, business, metric');
const upsertKpiStmt = db.prepare(`
  INSERT INTO kpis (user_id, date, business, metric, value, target)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, date, business, metric)
  DO UPDATE SET value = excluded.value, target = excluded.target
`);
const getKpis  = (userId, date) => getKpisStmt.all(userId, date);
const upsertKpi = (userId, date, business, metric, value, target) =>
  upsertKpiStmt.run(userId, date, business, metric, value, target);

// ── prepared statements — recurring tasks ────────────────────────────────────

const getRecurringStmt        = db.prepare('SELECT * FROM recurring_tasks WHERE user_id = ? AND active = 1 ORDER BY business, scheduled_time, id');
const getFutureRecurringStmt  = db.prepare('SELECT * FROM recurring_tasks WHERE user_id = ? AND active = 0 ORDER BY business, scheduled_time, id');
const addRecurringStmt        = db.prepare(
  `INSERT INTO recurring_tasks (user_id, name, business, scheduled_time, days, time_block, category, active)
   VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
);
const deleteRecurringStmt     = db.prepare('DELETE FROM recurring_tasks WHERE user_id = ? AND id = ?');
const deactivateRecurringStmt = db.prepare('UPDATE recurring_tasks SET active = 0 WHERE user_id = ? AND id = ?');
const activateRecurringStmt   = db.prepare('UPDATE recurring_tasks SET active = 1 WHERE user_id = ? AND id = ?');
const getCategoryRecurringStmt = db.prepare('SELECT * FROM recurring_tasks WHERE user_id = ? AND category = ? AND active = 1 ORDER BY scheduled_time, id');
const checkRecurringExistsStmt = db.prepare('SELECT id FROM recurring_tasks WHERE user_id = ? AND name = ? AND business = ? AND active = 1');
const checkTaskExistsStmt      = db.prepare('SELECT id FROM tasks WHERE user_id = ? AND date = ? AND name = ?');
const insertRecurringTaskStmt  = db.prepare(
  `INSERT INTO tasks (user_id, date, name, business, time, done, priority, source)
   VALUES (?, ?, ?, ?, ?, 0, 'normal', 'recurring')`
);
const insertCarriedTaskStmt = db.prepare(
  `INSERT INTO tasks (user_id, date, name, business, time, done, priority, source)
   VALUES (?, ?, ?, ?, ?, 0, ?, 'carried')`
);

const getRecurring        = (userId) => getRecurringStmt.all(userId);
const getFutureRecurring  = (userId) => getFutureRecurringStmt.all(userId);
const addRecurring        = (userId, name, business, scheduled_time, days, time_block, category) =>
  addRecurringStmt.run(userId, name, business, scheduled_time || null, days || 'daily', time_block || null, category || 'work');
const deleteRecurring     = (userId, id) => deleteRecurringStmt.run(userId, id);
const deactivateRecurring = (userId, id) => deactivateRecurringStmt.run(userId, id);
const activateRecurring   = (userId, id) => activateRecurringStmt.run(userId, id);
const getCategoryRecurring = (userId, category) => getCategoryRecurringStmt.all(userId, category);
const checkTaskExists      = (userId, date, name) => checkTaskExistsStmt.get(userId, date, name);
const insertCarriedTask    = (userId, date, name, business, time, priority) =>
  insertCarriedTaskStmt.run(userId, date, name, business, time || null, priority || 'normal');

function insertTaskSafe(userId, date, name, business, time, priority) {
  const exists = checkTaskExists(userId, date, name);
  if (exists) return getTaskById(userId, exists.id);
  const info = insertTask(userId, date, name, business, time, priority);
  return getTaskById(userId, info.lastInsertRowid);
}

// ── prepared statements — pending recurring ───────────────────────────────────

const insertPendingRecurringStmt = db.prepare(`
  INSERT OR IGNORE INTO pending_recurring (user_id, date, recurring_task_id, name, business, scheduled_time)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const getPendingRecurringStmt = db.prepare(`
  SELECT pr.*, rt.days, rt.time_block
  FROM   pending_recurring pr
  LEFT JOIN recurring_tasks rt ON rt.id = pr.recurring_task_id
  WHERE  pr.user_id = ? AND pr.date = ? AND pr.status = 'pending'
  ORDER  BY pr.scheduled_time, pr.id
`);
const getConfirmedRecurringStmt = db.prepare(
  `SELECT * FROM pending_recurring WHERE user_id = ? AND date = ? AND status = 'confirmed'`
);
const rejectRecurringStmt = db.prepare(
  `UPDATE pending_recurring SET status = 'rejected' WHERE user_id = ? AND id = ?`
);
const rejectAllPendingRecurringStmt = db.prepare(
  `UPDATE pending_recurring SET status = 'rejected' WHERE user_id = ? AND date = ? AND status = 'pending'`
);
const confirmPendingByIdStmt = db.prepare(
  `UPDATE pending_recurring SET status = 'confirmed' WHERE user_id = ? AND id = ?`
);
const getPendingRecurringByIdStmt = db.prepare(
  `SELECT * FROM pending_recurring WHERE user_id = ? AND id = ?`
);

const getPendingRecurring = (userId, date) => getPendingRecurringStmt.all(userId, date);
const getConfirmedRecurring = (userId, date) => getConfirmedRecurringStmt.all(userId, date);
const rejectRecurring = (userId, id) => rejectRecurringStmt.run(userId, id);
const rejectAllPendingRecurring = (userId, date) => rejectAllPendingRecurringStmt.run(userId, date);

function confirmRecurring(userId, id) {
  const row = getPendingRecurringByIdStmt.get(userId, id);
  if (!row) return null;
  const existing = checkTaskExists(userId, row.date, row.name);
  if (!existing) {
    insertRecurringTaskStmt.run(userId, row.date, row.name, row.business, row.scheduled_time || null);
    logTaskInsert('recurring-confirm', row.name, { date: row.date, business: row.business, userId });
  } else {
    console.log(`[TASK-INSERT] source=recurring-confirm title=${JSON.stringify(row.name)} SKIPPED (already exists, task id=${existing.id}) userId=${userId} pid=${process.pid} time=${new Date().toISOString()}`);
  }
  confirmPendingByIdStmt.run(userId, id);
  return getTasksByDate(userId, row.date).find(t => t.name === row.name) || null;
}

function confirmAllRecurring(userId, date) {
  const pending = getPendingRecurring(userId, date);
  db.transaction((tasks) => {
    for (const t of tasks) {
      const existing = checkTaskExists(userId, t.date, t.name);
      if (!existing) {
        insertRecurringTaskStmt.run(userId, t.date, t.name, t.business, t.scheduled_time || null);
        logTaskInsert('recurring-confirm-all', t.name, { date: t.date, business: t.business, userId });
      } else {
        console.log(`[TASK-INSERT] source=recurring-confirm-all title=${JSON.stringify(t.name)} SKIPPED (already exists, task id=${existing.id}) userId=${userId} pid=${process.pid} time=${new Date().toISOString()}`);
      }
      confirmPendingByIdStmt.run(userId, t.id);
    }
  })(pending);
  return getTasksByDate(userId, date);
}

function populateRecurring(userId, date) {
  const dayOfWeek = new Date(date + 'T12:00:00Z').getUTCDay(); // 0=Sun … 6=Sat
  const recurring  = getRecurring(userId);
  db.transaction((tasks) => {
    for (const t of tasks) {
      const days = t.days || 'daily';
      if (days !== 'daily') {
        const allowed = days.split(',').map(d => parseInt(d.trim(), 10));
        if (!allowed.includes(dayOfWeek)) continue;
      }
      insertPendingRecurringStmt.run(userId, date, t.id, t.name, t.business, t.scheduled_time || null);
    }
  })(recurring);
}

function getTodayTasksIncludingPending(userId, date) {
  const tasks    = getTasksByDate(userId, date);
  const pending  = getPendingRecurring(userId, date);
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

function getRecurringGrouped(userId) {
  const all    = getRecurring(userId);
  const groups = { blok: [], aphl: [], trade: [], personal: [] };
  for (const t of all) {
    if (groups[t.business]) groups[t.business].push(t);
  }
  return groups;
}

// ── prepared statements — carry forward ──────────────────────────────────────

const insertCarryStmt = db.prepare(
  `INSERT INTO task_carry (user_id, original_task_id, from_date, to_date)
   VALUES (?, ?, ?, ?)`
);

function carryTask(userId, taskId, fromDate, toDate) {
  const original = getTaskById(userId, taskId);
  if (!original) throw new Error(`Task ${taskId} not found`);

  const info = insertTask(
    userId,
    toDate,
    original.name,
    original.business,
    original.time || null,
    original.priority || 'normal'
  );
  logTaskInsert('carry-forward', original.name, { date: toDate, business: original.business, fromTaskId: taskId, userId });
  insertCarryStmt.run(userId, taskId, fromDate, toDate);
  return getTaskById(userId, info.lastInsertRowid);
}

// ── prepared statements — ideas ───────────────────────────────────────────────

const addIdeaStmt  = db.prepare('INSERT INTO ideas (user_id, business, content) VALUES (?, ?, ?)');
const getIdeasStmt = db.prepare('SELECT * FROM ideas WHERE user_id = ? ORDER BY created_at DESC LIMIT 20');
const addIdea  = (userId, business, content) => addIdeaStmt.run(userId, business, content);
const getIdeas = (userId) => getIdeasStmt.all(userId);

// ── prepared statements — notes ───────────────────────────────────────────────

const addNoteStmt  = db.prepare('INSERT INTO notes (user_id, business, content) VALUES (?, ?, ?)');
const getNotesStmt = db.prepare('SELECT * FROM notes WHERE user_id = ? ORDER BY created_at DESC LIMIT 20');
const addNote  = (userId, business, content) => addNoteStmt.run(userId, business, content);
const getNotes = (userId) => getNotesStmt.all(userId);

// ── prepared statements — nudges ─────────────────────────────────────────────

const getNudgeRecordStmt = db.prepare(
  'SELECT * FROM task_nudges WHERE task_id = ? AND date = ?'
);
const getNudgeRecord = (taskId, date) => getNudgeRecordStmt.get(taskId, date);

const upsertNudgeStmt = db.prepare(`
  INSERT INTO task_nudges (task_id, date, nudge_count, last_nudged_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(task_id, date)
  DO UPDATE SET nudge_count = excluded.nudge_count, last_nudged_at = excluded.last_nudged_at
`);
const upsertNudge = (taskId, date, count, lastNudgedAt) => upsertNudgeStmt.run(taskId, date, count, lastNudgedAt);

const snoozeTaskStmt = db.prepare(`
  INSERT INTO task_nudges (task_id, date, nudge_count, snoozed_until)
  VALUES (?, ?, 0, ?)
  ON CONFLICT(task_id, date)
  DO UPDATE SET snoozed_until = excluded.snoozed_until
`);
const snoozeTask = (taskId, date, snoozedUntil) => snoozeTaskStmt.run(taskId, date, snoozedUntil);

function getPendingNudges(userId, date) {
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
    WHERE  t.user_id = ? AND t.date = ?
      AND  t.done = 0
      AND  t.business != 'anchor'
      AND  t.time IS NOT NULL
      AND  t.time <= ?
      AND  COALESCE(n.nudge_count, 0) < 3
      AND  (n.snoozed_until IS NULL OR n.snoozed_until <= ?)
    ORDER BY t.time, t.id
  `).all(date, userId, date, hhmm, nowDatetime);
}

// ── prepared statements — goals ───────────────────────────────────────────────

const getGoalsStmt      = db.prepare('SELECT * FROM goals WHERE user_id = ? AND business = ? ORDER BY dimension');
const getAllGoalsStmt   = db.prepare('SELECT * FROM goals WHERE user_id = ? ORDER BY business, dimension');
const getGoalByIdStmt   = db.prepare('SELECT * FROM goals WHERE user_id = ? AND id = ?');
const addGoalStmt       = db.prepare(`
  INSERT INTO goals (user_id, business, dimension, title, description, target_date, year)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const updateGoalStatusStmt = db.prepare('UPDATE goals SET status = ? WHERE user_id = ? AND id = ?');
const updateGoalTitleStmt  = db.prepare('UPDATE goals SET title = ? WHERE user_id = ? AND id = ?');

const getGoals    = (userId, business) => getGoalsStmt.all(userId, business);
const getAllGoals = (userId) => getAllGoalsStmt.all(userId);
// Ownership check for routes that take a bare goal :id (e.g. progress notes)
// where the id doesn't come from an already user-scoped list — goal_progress
// itself carries no user_id, so this is the only thing standing between one
// user and writing/reading another user's goal progress notes.
const getGoalById = (userId, id) => getGoalByIdStmt.get(userId, id);
const addGoal     = (userId, business, dimension, title, description, target_date, year) =>
  addGoalStmt.run(userId, business, dimension, title, description || null, target_date || null, year);
const updateGoalStatus = (userId, status, id) => updateGoalStatusStmt.run(status, userId, id);
const updateGoalTitle  = (userId, title, id)  => updateGoalTitleStmt.run(title, userId, id);

// ── prepared statements — monthly cycles ─────────────────────────────────────

const getCyclesStmt = db.prepare(`
  SELECT mc.*, g.title AS goal_title, g.dimension
  FROM   monthly_cycles mc
  LEFT JOIN goals g ON g.id = mc.goal_id
  WHERE  mc.user_id = ? AND mc.month = ?
  ORDER  BY mc.business, mc.id
`);
const getCyclesByGoalStmt = db.prepare(
  'SELECT * FROM monthly_cycles WHERE user_id = ? AND goal_id = ? ORDER BY month DESC'
);
const getCycleByIdStmt = db.prepare('SELECT * FROM monthly_cycles WHERE user_id = ? AND id = ?');
const addCycleStmt     = db.prepare(`
  INSERT INTO monthly_cycles (user_id, business, goal_id, month, title, commitment_1, commitment_2, commitment_3)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateCycleReflectionStmt = db.prepare(
  'UPDATE monthly_cycles SET reflection = ? WHERE user_id = ? AND id = ?'
);

const getCycles       = (userId, month) => getCyclesStmt.all(userId, month);
const getCyclesByGoal = (userId, goalId) => getCyclesByGoalStmt.all(userId, goalId);
const getCycleById    = (userId, id) => getCycleByIdStmt.get(userId, id);
const addCycle         = (userId, business, goal_id, month, title, c1, c2, c3) =>
  addCycleStmt.run(userId, business, goal_id || null, month, title, c1, c2, c3 || null);
const updateCycleReflection = (userId, reflection, id) => updateCycleReflectionStmt.run(reflection, userId, id);

function updateCycleCommitment(userId, id, which, status) {
  const n = Number(which);
  if (![1, 2, 3].includes(n)) throw new Error('which must be 1, 2, or 3');
  db.prepare(`UPDATE monthly_cycles SET status_${n} = ? WHERE user_id = ? AND id = ?`).run(status, userId, id);
  return getCycleById(userId, id);
}

// ── prepared statements — goal progress ──────────────────────────────────────

const addGoalProgressStmt = db.prepare('INSERT INTO goal_progress (goal_id, note) VALUES (?, ?)');
const getGoalProgressStmt = db.prepare(
  'SELECT * FROM goal_progress WHERE goal_id = ? ORDER BY logged_at DESC LIMIT 10'
);
const addGoalProgress = (goalId, note) => addGoalProgressStmt.run(goalId, note);
const getGoalProgress = (goalId) => getGoalProgressStmt.all(goalId);

// ── prepared statements — event sync ─────────────────────────────────────────

// NOTE: writes calendar_event_id (not the unused event_id column) — this is
// the column getTaskByEventId/updateTaskFromCalendar/deleteTaskByEventId all
// read, so a task LIFELINE pushes to Google Calendar is recognized as already-
// linked on the next poll instead of being re-imported as a duplicate.
const updateTaskEventIdStmt = db.prepare('UPDATE tasks SET calendar_event_id = ? WHERE user_id = ? AND id = ?');
const updateTaskEventId = (userId, eventId, id) => updateTaskEventIdStmt.run(eventId, userId, id);

// ── prepared statements — Google Calendar import ──────────────────────────────

const getTaskByEventIdStmt = db.prepare(
  'SELECT * FROM tasks WHERE user_id = ? AND calendar_event_id = ? LIMIT 1'
);
const insertCalendarTaskStmt = db.prepare(
  `INSERT INTO tasks (user_id, date, name, business, time, done, priority, calendar_source, calendar_event_id)
   VALUES (?, ?, ?, ?, ?, 0, 'normal', 'google', ?)`
);
const updateTaskFromCalendarStmt = db.prepare(
  'UPDATE tasks SET name = ?, time = ?, date = ? WHERE user_id = ? AND calendar_event_id = ?'
);
const deleteTaskByEventIdStmt = db.prepare(
  'DELETE FROM tasks WHERE user_id = ? AND calendar_event_id = ?'
);

const getTaskByEventId = (userId, eventId) => getTaskByEventIdStmt.get(userId, eventId);
const insertCalendarTask = (userId, date, name, business, time, eventId) =>
  insertCalendarTaskStmt.run(userId, date, name, business, time || null, eventId);
const updateTaskFromCalendar = (userId, name, time, date, eventId) =>
  updateTaskFromCalendarStmt.run(name, time, date, userId, eventId);
const deleteTaskByEventId = (userId, eventId) => deleteTaskByEventIdStmt.run(userId, eventId);

// ── prepared statements — task/recurring time update ─────────────────────────

const updateTaskTimeStmt      = db.prepare('UPDATE tasks SET time = ? WHERE user_id = ? AND id = ?');
const updateRecurringTimeStmt = db.prepare('UPDATE recurring_tasks SET scheduled_time = ? WHERE user_id = ? AND id = ?');
const updateTaskTime      = (userId, time, id) => updateTaskTimeStmt.run(time, userId, id);
const updateRecurringTime = (userId, time, id) => updateRecurringTimeStmt.run(time, userId, id);

// ── prepared statements — businesses ─────────────────────────────────────────

const getBusinessesStmt    = db.prepare('SELECT * FROM businesses WHERE user_id = ? AND active = 1 ORDER BY id');
const addBusinessStmt      = db.prepare(
  `INSERT INTO businesses (user_id, name, slug, color_bg, color_text) VALUES (?, ?, ?, ?, ?)`
);
const deactivateBusinessStmt = db.prepare('UPDATE businesses SET active = 0 WHERE user_id = ? AND id = ?');
const getBusinessBySlugStmt  = db.prepare('SELECT * FROM businesses WHERE user_id = ? AND slug = ?');

const getBusinesses = (userId) => getBusinessesStmt.all(userId);
const addBusiness    = (userId, name, slug, color_bg, color_text) =>
  addBusinessStmt.run(userId, name, slug, color_bg, color_text);
const deactivateBusiness = (userId, id) => deactivateBusinessStmt.run(userId, id);
const getBusinessBySlug  = (userId, slug) => getBusinessBySlugStmt.get(userId, slug);

// ── prepared statements — toggle recurring active ─────────────────────────────

function toggleRecurringActive(userId, id) {
  const row = db.prepare('SELECT active FROM recurring_tasks WHERE user_id = ? AND id = ?').get(userId, id);
  if (!row) throw new Error(`Recurring task ${id} not found`);
  if (row.active) {
    deactivateRecurring(userId, id);
  } else {
    activateRecurring(userId, id);
  }
  return { id: Number(id), active: row.active ? 0 : 1 };
}

// ── founder profile ───────────────────────────────────────────────────────────
// Everything that used to be hardcoded into AI prompts and schedule defaults
// (name, ventures, routines, investor cadence, brand) lives here instead, so
// this codebase can serve any founder, not just the one it was written for.
// Stored as a JSON blob under settings.founder_profile; DEFAULT_FOUNDER_PROFILE
// is the seed for this instance and also the fallback shape for new ones.
// New (non-OGV) users get a genuinely blank-slate variant of this default —
// see BLANK_FOUNDER_PROFILE below — filled in by the onboarding wizard.

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

// Blank-slate default for newly signed-up (non-OGV) users — no OGV-specific
// names/businesses/schedule leak in; the onboarding wizard (Phase B) fills
// this in per-user. Suggested anchor defaults kept (prayer/journaling/family
// time/wind-down) since the task spec calls for them as editable suggestions,
// not because they're OGV-specific.
const BLANK_FOUNDER_PROFILE = {
  name:       '',
  brandName:  '',
  identity:   '',
  ventures:   [],
  personalPillars: ['Spiritual', 'Mental', 'Physical', 'Family'],
  personalLabel:   'TAKE CARE OF YOURSELF FIRST',
  closingLabel:    'CLOSE THE DAY WELL',
  currentGoals:    [],
  nonNegotiables:  '',
  investorCadence: [],
  scheduleBlocks: [
    { time: '05:30', end: '05:45', name: 'Prayer',                                  biz: 'anchor' },
    { time: '05:45', end: '06:00', name: 'Journaling',                              biz: 'anchor' },
    { time: '17:30', end: '18:00', name: 'Calls to loved ones and family',          biz: 'anchor' },
    { time: '20:30', end: '21:00', name: 'Evening wind-down and next day planning', biz: 'anchor' },
  ],
};

function getFounderProfile(userId) {
  const row = getSetting(userId, 'founder_profile');
  const fallback = userId === 1 ? DEFAULT_FOUNDER_PROFILE : BLANK_FOUNDER_PROFILE;
  if (!row) return fallback;
  try {
    const stored = JSON.parse(row.value);
    return { ...fallback, ...stored };
  } catch {
    return fallback;
  }
}

function saveFounderProfile(userId, partial) {
  const updated = { ...getFounderProfile(userId), ...partial };
  upsertSetting(userId, 'founder_profile', JSON.stringify(updated));
  return updated;
}

// ── prepared statements — document analyses ───────────────────────────────────
// Scoped directly by user_id — the standalone paste-and-analyze flow
// (/api/documents/analyze) creates a document_analyses row with no
// corresponding uploaded_documents row at all, so it can't be scoped
// transitively the way the upload-library flow can.

const saveDocumentAnalysisStmt = db.prepare(
  `INSERT INTO document_analyses (user_id, business, document_excerpt, summary, key_insight, risk, tasks_json)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const getDocumentAnalysesStmt = db.prepare(
  'SELECT * FROM document_analyses WHERE user_id = ? ORDER BY created_at DESC LIMIT 10'
);
const saveDocumentAnalysis = (userId, business, excerpt, summary, keyInsight, risk, tasksJson) =>
  saveDocumentAnalysisStmt.run(userId, business, excerpt, summary, keyInsight, risk, tasksJson);
const getDocumentAnalyses = (userId) => getDocumentAnalysesStmt.all(userId);

// ── prepared statements — uploaded documents ──────────────────────────────────

const saveUploadedDocumentStmt = db.prepare(
  `INSERT INTO uploaded_documents (user_id, filename, original_name, file_type, file_size, business, parsed_text)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const getUploadedDocumentStmt = db.prepare(
  'SELECT * FROM uploaded_documents WHERE user_id = ? AND id = ?'
);
const getAllUploadedDocumentsStmt = db.prepare(
  `SELECT d.id, d.filename, d.original_name, d.file_type, d.file_size, d.business,
          d.upload_date, d.status, d.analysis_id, d.assigned_to, d.tags,
          a.summary, a.key_insight, a.risk, a.tasks_json
   FROM uploaded_documents d
   LEFT JOIN document_analyses a ON a.id = d.analysis_id
   WHERE d.user_id = ? AND d.status != 'archived'
   ORDER BY d.upload_date DESC
   LIMIT 50`
);
const getUploadedDocumentsByBusinessStmt = db.prepare(
  `SELECT d.id, d.filename, d.original_name, d.file_type, d.file_size, d.business,
          d.upload_date, d.status, d.analysis_id, d.assigned_to,
          a.summary
   FROM uploaded_documents d
   LEFT JOIN document_analyses a ON a.id = d.analysis_id
   WHERE d.user_id = ? AND d.business = ? AND d.status != 'archived'
   ORDER BY d.upload_date DESC`
);
const updateUploadedDocumentStatusStmt = db.prepare(
  'UPDATE uploaded_documents SET status = ? WHERE user_id = ? AND id = ?'
);
const linkDocumentToAnalysisStmt = db.prepare(
  'UPDATE uploaded_documents SET analysis_id = ?, status = ? WHERE user_id = ? AND id = ?'
);
const archiveUploadedDocumentStmt = db.prepare(
  "UPDATE uploaded_documents SET status = 'archived' WHERE user_id = ? AND id = ?"
);
const searchUploadedDocumentsStmt = db.prepare(
  `SELECT id, filename, original_name, file_type, business, upload_date, status,
          substr(parsed_text, 1, 200) AS excerpt
   FROM uploaded_documents
   WHERE user_id = ? AND status != 'archived'
     AND (original_name LIKE ? OR parsed_text LIKE ?)
   ORDER BY upload_date DESC
   LIMIT 20`
);

const saveUploadedDocument = (userId, filename, originalName, fileType, fileSize, business, parsedText) =>
  saveUploadedDocumentStmt.run(userId, filename, originalName, fileType, fileSize, business, parsedText);
const getUploadedDocument = (userId, id) => getUploadedDocumentStmt.get(userId, id);
const getAllUploadedDocuments = (userId) => getAllUploadedDocumentsStmt.all(userId);
const getUploadedDocumentsByBusiness = (userId, business) => getUploadedDocumentsByBusinessStmt.all(userId, business);
const updateUploadedDocumentStatus = (userId, status, id) => updateUploadedDocumentStatusStmt.run(status, userId, id);
const linkDocumentToAnalysis = (userId, analysisId, status, id) => linkDocumentToAnalysisStmt.run(analysisId, status, userId, id);
const archiveUploadedDocument = (userId, id) => archiveUploadedDocumentStmt.run(userId, id);
const searchUploadedDocuments = (userId, q1, q2) => searchUploadedDocumentsStmt.all(userId, q1, q2);

// ── prepared statements — team members ───────────────────────────────────────

const getTeamMembersStmt = db.prepare(
  'SELECT * FROM team_members WHERE user_id = ? AND active = 1 ORDER BY business, name'
);
const getMembersByBusinessStmt = db.prepare(
  'SELECT * FROM team_members WHERE user_id = ? AND (business = ? OR business = ?) AND active = 1 ORDER BY name'
);
const getTeamMembers = (userId) => getTeamMembersStmt.all(userId);
const getMembersByBusiness = (userId, b1, b2) => getMembersByBusinessStmt.all(userId, b1, b2);

// ── per-user default data seed (businesses + team members) ───────────────────
// Runs once per user the first time their data is touched with nothing seeded
// yet. For user 1 (OGV) this reproduces the original hardcoded defaults he's
// always had. For any other user this is a no-op — Phase B's onboarding
// wizard is what actually populates their businesses/ventures, not this.

function seedDefaultsForUser(userId) {
  if (userId !== 1) return; // non-OGV users are seeded by the onboarding wizard, not here
  const bizCount = db.prepare('SELECT COUNT(*) AS n FROM businesses WHERE user_id = ?').get(userId);
  if (!bizCount || bizCount.n === 0) {
    db.transaction(() => {
      addBusiness(userId, 'Blok AI',     'blok',     '#f0effe', '#4a3fa0');
      addBusiness(userId, 'APHL Africa', 'aphl',     '#edf7f2', '#1a6646');
      addBusiness(userId, 'TradeSol',    'trade',    '#fef8ec', '#7a4a0a');
      addBusiness(userId, 'Personal',    'personal', '#fdf0f4', '#8a2a4a');
    })();
    console.log(`[db] Businesses seeded for user ${userId}`);
  }
  const teamCount = db.prepare('SELECT COUNT(*) AS n FROM team_members WHERE user_id = ?').get(userId);
  if (!teamCount || teamCount.n === 0) {
    const stmt = db.prepare(
      'INSERT INTO team_members (user_id, name, role, business, contact) VALUES (?, ?, ?, ?, ?)'
    );
    db.transaction(() => {
      for (const v of DEFAULT_FOUNDER_PROFILE.ventures) {
        if (v.lead) stmt.run(userId, v.lead, v.leadRole || 'Lead', v.slug, '');
      }
      stmt.run(userId, DEFAULT_FOUNDER_PROFILE.name, 'CEO', 'all', '');
    })();
    console.log(`[db] Team members seeded for user ${userId}`);
  }
}

// ── one-time migrations (global, run once across the whole DB) ───────────────
// Guarded by settings rows under the reserved SYSTEM_USER_ID (see above) —
// same guard-flag pattern this file has always used (recurring_seeded_v4,
// anchors_seeded_v2, kanban_status_seeded_v1), just now explicitly scoped to
// the system pseudo-user instead of implicitly global.

// v5 — multi-tenancy: create user 1 (OGV), backfill every previously-global
// table's user_id to 1, seed his businesses/team the same way seedDefaultsForUser
// does for consistency (idempotent — only runs if nothing's there yet).
{
  const alreadyMigrated = getSystemFlag('multiuser_migrated_v1');
  if (!alreadyMigrated) {
    const OGV_EMAIL = 'chijiokechinonso@gmail.com';
    let ogv = getUserByEmail.get(OGV_EMAIL);
    if (!ogv) {
      const info = insertUser.run(OGV_EMAIL, null, 'OGV', 1); // password_hash NULL — set on first login (see auth.js)
      ogv = getUserById.get(info.lastInsertRowid);
      console.log(`[db] created user 1 (OGV) — password will be set on first login`);
    }
    const ogvId = ogv.id;

    if (process.env.TELEGRAM_CHAT_ID && !ogv.telegram_chat_id) {
      try { setUserChatId.run(process.env.TELEGRAM_CHAT_ID, ogvId); }
      catch (err) { console.error('[db] failed to auto-link OGV telegram_chat_id:', err.message); }
    }

    const backfillTables = [
      'tasks', 'recurring_tasks', 'task_carry', 'ideas', 'notes', 'task_nudges',
      'goals', 'monthly_cycles', 'document_analyses', 'uploaded_documents',
      'team_members', 'businesses', 'pending_recurring', 'anchor_log', 'day_log', 'kpis',
    ];
    db.transaction(() => {
      for (const t of backfillTables) {
        db.prepare(`UPDATE ${t} SET user_id = ? WHERE user_id IS NULL`).run(ogvId);
      }
      // settings rows that predate multi-tenancy: everything that isn't a
      // system migration-guard flag belongs to OGV.
      db.prepare(`UPDATE settings SET user_id = ? WHERE user_id IS NULL OR user_id = 1`).run(ogvId);
    })();

    setSystemFlag('multiuser_migrated_v1', '1');
    console.log(`[db] multi-tenancy migration complete — existing data backfilled to user ${ogvId}`);
  }
}

// ── team members seed (legacy path, now routed through seedDefaultsForUser) ──

seedDefaultsForUser(1);

// ── startup seeds (v4 — runs once, resets previous seeds) ────────────────────
// Recurring-task seed data is OGV-specific (his actual daily routine) — only
// ever seeded for user 1, same as before this migration.

{
  const alreadySeeded = getSystemFlag('recurring_seeded_v4');
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
      `INSERT INTO recurring_tasks (user_id, name, business, scheduled_time, days, time_block, category, notes, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    // pending_recurring.recurring_task_id references recurring_tasks(id) with
    // no ON DELETE clause — clear those first so the reset below can't hit a
    // foreign-key violation against months of accumulated confirmation-prompt
    // rows pointing at the definitions being replaced.
    db.prepare('DELETE FROM pending_recurring WHERE user_id = 1').run();
    db.prepare('DELETE FROM recurring_tasks WHERE user_id = 1').run();
    db.transaction(() => {
      for (const s of SEEDS_V4) {
        seedStmt.run(
          1, s.name, s.business, s.scheduled_time || null, s.days || 'daily',
          s.time_block || null, s.category || 'work', s.notes || null,
          s.active !== undefined ? s.active : 1
        );
      }
    })();
    setSystemFlag('recurring_seeded_v4', '1');
    console.log('[db] Recurring tasks reset to v4');
  }
}

// ── anchors migration (v2) — renames schedule blocks in stored settings ───────

{
  const alreadyMigrated = getSystemFlag('anchors_seeded_v2');
  if (!alreadyMigrated) {
    const stored = getSetting(1, 'schedule_blocks');
    if (stored) {
      try {
        let blocks = JSON.parse(stored.value);
        blocks = blocks.map(b => {
          if (b.name === 'Calls to loved ones') return { ...b, name: 'Calls to loved ones and family' };
          if (b.name === 'Raise: 5 investor emails, CRM update') return { ...b, name: 'Raise: investor relations' };
          return b;
        });
        upsertSetting(1, 'schedule_blocks', JSON.stringify(blocks));
      } catch {}
    }
    setSystemFlag('anchors_seeded_v2', '1');
    console.log('[db] Anchor blocks migrated to v2');
  }
}

// ── kanban status backfill (v1) — one-time, for tasks that predate the status
// column (which defaulted to NULL on ALTER TABLE and are never touched again
// unless done flips) ───────────────────────────────────────────────────────

{
  const alreadySeeded = getSystemFlag('kanban_status_seeded_v1');
  if (!alreadySeeded) {
    db.exec(`
      UPDATE tasks SET status = CASE
        WHEN done = 1 THEN 'done'
        WHEN date = date('now','+1 hours') THEN 'today'
        ELSE 'backlog'
      END
      WHERE status IS NULL;
    `);
    setSystemFlag('kanban_status_seeded_v1', '1');
    console.log('[db] Task status backfilled for kanban board');
  }
}

// ── day log + recurring population ───────────────────────────────────────────

function syncDayLog(userId, date) {
  populateRecurring(userId, date);
  db.prepare('INSERT OR IGNORE INTO day_log (user_id, date) VALUES (?, ?)').run(userId, date);
}

// ── exports ───────────────────────────────────────────────────────────────────

module.exports = {
  db,

  // debug
  logTaskInsert,

  // helpers
  watToday,
  watTomorrow,
  watCutoff,
  weekStart,

  // users / auth
  SYSTEM_USER_ID,
  getUserById,
  getUserByEmail,
  getUserByChatId,
  insertUser,
  setUserPassword,
  setOnboardingDone,
  setUserChatId,
  clearUserChatId,
  getAllUsersWithChat,
  insertConnectToken,
  getConnectToken,
  deleteConnectToken,
  seedDefaultsForUser,

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
  deduplicateTasks,
  updateTaskStatus,
  updateTaskDate,
  getBoardTasks,

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
  getGoalById,
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
  BLANK_FOUNDER_PROFILE,

  // scorecard
  getInvestorTouchesThisWeek,
  getQuarterlyGoalPct,

  // anchors
  getAnchorsForDate,
  toggleAnchor,

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
