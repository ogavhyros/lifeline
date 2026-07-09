require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const {
  db, watToday, watTomorrow, watCutoff, weekStart,
  getTasksByDate, getTaskById, insertTask, toggleTask, markTaskDone, updatePriority, deleteTask,
  deduplicateTasks, updateTaskStatus, updateTaskDate, getBoardTasks, logTaskInsert,
  getHistory, getKpis, upsertKpi,
  getRecurring, getFutureRecurring, getRecurringGrouped, addRecurring, deactivateRecurring, activateRecurring, populateRecurring,
  toggleRecurringActive, updateRecurringTime,
  getPendingRecurring, confirmRecurring, confirmAllRecurring, rejectRecurring, rejectAllPendingRecurring,
  carryTask, addIdea, getIdeas, addNote, getNotes, syncDayLog,
  getGoals, getAllGoals, getGoalById, addGoal, updateGoalStatus, updateGoalTitle,
  getCycles, getCyclesByGoal, getCycleById, addCycle, updateCycleCommitment, updateCycleReflection,
  addGoalProgress, getGoalProgress,
  getSetting, upsertSetting, deleteSetting,
  saveDocumentAnalysis, getDocumentAnalyses,
  saveUploadedDocument, getUploadedDocument, getAllUploadedDocuments, getUploadedDocumentsByBusiness,
  updateUploadedDocumentStatus, linkDocumentToAnalysis, archiveUploadedDocument, searchUploadedDocuments,
  getTeamMembers, getMembersByBusiness,
  updateTaskTime,
  getBusinesses, addBusiness, deactivateBusiness,
  getFounderProfile, saveFounderProfile,
  getInvestorTouchesThisWeek, getQuarterlyGoalPct,
  getAnchorsForDate, toggleAnchor,
  insertConnectToken, getConnectToken, deleteConnectToken, clearUserChatId,
} = require('./db');
const { parseDocument, cleanDocumentText } = require('./document-parser');
const gcal = require('./google-calendar');
const { structureDump, transcribeAudio, parseStrategicDocument } = require('./ai');
const { initBot, handleUpdate, registerWebhook, POLLING, sendMessage } = require('./telegram');
const { initScheduler } = require('./scheduler');
const { sessionMiddleware, requireAuth, registerAuthRoutes } = require('./auth');

// Wire sendMessage into gcal so processCalendarEvent can notify via Telegram.
// Injected here (not required directly by google-calendar.js) to avoid a
// circular require — telegram.js already requires google-calendar.js.
gcal.setMessageSender(sendMessage);

// ── app setup ─────────────────────────────────────────────────────────────────

const app         = express();
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const UPLOAD_DIR = process.env.NODE_ENV === 'production'
  ? '/app/data/uploads'
  : path.join(__dirname, '..', 'uploads', 'documents');
const TEMP_DIR = path.join(__dirname, '..', 'uploads', 'temp');

try {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
} catch (err) {
  if (err.code !== 'EEXIST') console.error('Upload dir error:', err);
}
try {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
} catch (err) {
  if (err.code !== 'EEXIST') console.error('Upload dir error:', err);
}

const ALLOWED_DOC_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain',
  'text/markdown',
]);
const ALLOWED_DOC_EXTS = new Set(['.pdf', '.docx', '.doc', '.txt', '.md']);

const docStorage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  },
});
const docUpload = multer({
  storage: docStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_DOC_MIMES.has(file.mimetype) || ALLOWED_DOC_EXTS.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, Word documents, and text files are supported'));
    }
  },
});

app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, '..', 'public')));

registerAuthRoutes(app); // POST /api/auth/signup, /login, /logout, GET /api/auth/me — all public, no requireAuth

// ── startup: verify task persistence ─────────────────────────────────────────
{
  const today = watToday();
  const count = getTasksByDate(1, today).length;
  console.log(`[db] ${count} task${count !== 1 ? 's' : ''} found for today (${today}, user 1)`);

  // DEBUG (duplication investigation): raw duplicate-group query across the
  // WHOLE table, run BEFORE any cleanup below so it reflects the true
  // pre-cleanup state. Adapted from the requested
  // "SELECT title, date, time, source, google_event_id, COUNT(*) ..." query
  // to this schema's actual column names (name / calendar_event_id).
  // Intentionally cross-user (no user_id filter) — it's a diagnostic query,
  // not a data-access path, and duplication so far is only reported for OGV.
  try {
    const dupGroups = db.prepare(`
      SELECT user_id, name, date, COUNT(*) as cnt,
             GROUP_CONCAT(id) as ids,
             GROUP_CONCAT(time) as times,
             GROUP_CONCAT(source) as sources,
             GROUP_CONCAT(calendar_event_id) as calendar_event_ids
      FROM tasks
      GROUP BY user_id, name, date
      HAVING COUNT(*) > 1
      ORDER BY cnt DESC
    `).all();
    console.log(`[DUP-CHECK] found ${dupGroups.length} duplicate group(s) in tasks table (pre-cleanup, all users/dates)`);
    for (const g of dupGroups) {
      console.log(`[DUP-CHECK] userId=${g.user_id} name=${JSON.stringify(g.name)} date=${g.date} count=${g.cnt} ids=[${g.ids}] times=[${g.times}] sources=[${g.sources}] calendar_event_ids=[${g.calendar_event_ids}]`);
    }
  } catch (err) {
    console.error('[DUP-CHECK] query failed:', err.message);
  }

  // One-time cleanup of duplicates left over from the Google Calendar sync
  // loop bug (a synced task getting pulled back in as a "new" task). Loops
  // every user, not just OGV — cheap no-op for users with no tasks yet.
  const allUsers = db.prepare('SELECT id FROM users').all();
  for (const u of allUsers) {
    const removed = deduplicateTasks(u.id, today);
    if (removed > 0) console.log(`[startup] cleaned ${removed} duplicate task${removed !== 1 ? 's' : ''} for user ${u.id} today`);
  }
}

// ── tasks ─────────────────────────────────────────────────────────────────────

app.get('/api/tasks', requireAuth, (req, res) => {
  const date  = req.query.date || watToday();
  syncDayLog(req.user.id, date);
  const tasks = getTasksByDate(req.user.id, date);

  // Safety net against the Google Calendar sync loop: a calendar-derived task
  // whose title is just a business-prefixed rewrite of a non-calendar task's
  // name is the same task read back in — filter it out without deleting it
  // (deduplicateTasks handles the destructive cleanup).
  const cleanTasks = tasks.filter(task => {
    if (task.calendar_source === 'google') {
      const stripped = task.name.replace(/^✓\s*/, '').replace(/^\[[^\]]+\]\s*/, '');
      const isDuplicate = tasks.some(t =>
        t.id !== task.id &&
        t.calendar_source !== 'google' &&
        t.name === stripped
      );
      if (isDuplicate) return false;
    }
    return true;
  });

  res.json(cleanTasks);
});

app.post('/api/tasks/deduplicate', requireAuth, (req, res) => {
  const date    = req.query.date || watToday();
  const removed = deduplicateTasks(req.user.id, date);
  res.json({ ok: true, removed });
});

app.post('/api/tasks', requireAuth, (req, res) => {
  const { name, business, scheduled_time, priority } = req.body;
  if (!name || !business) return res.status(400).json({ error: 'name and business are required' });
  const info = insertTask(req.user.id, watToday(), name, business, scheduled_time || null, priority || 'normal');
  const task = getTaskById(req.user.id, info.lastInsertRowid);
  logTaskInsert('manual-web', name, { date: task.date, business, taskId: task.id, userId: req.user.id });
  gcal.syncTaskToCalendar(req.user.id, task).catch(err => console.error('[calendar] sync failed:', err.message));
  res.status(201).json(task);
});

app.patch('/api/tasks/:id/toggle', requireAuth, (req, res) => {
  const task = getTaskById(req.user.id, req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  toggleTask(req.user.id, task.done ? 0 : 1, task.id);
  const updated = getTaskById(req.user.id, task.id);
  gcal.syncTaskToCalendar(req.user.id, updated).catch(err => console.error('[calendar] sync failed:', err.message));
  res.json(updated);
});

app.patch('/api/tasks/:id/priority', requireAuth, (req, res) => {
  const { priority } = req.body;
  if (!['high', 'normal', 'low'].includes(priority)) {
    return res.status(400).json({ error: 'priority must be high, normal, or low' });
  }
  const task = getTaskById(req.user.id, req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  updatePriority(req.user.id, priority, task.id);
  res.json(getTasksByDate(req.user.id, watToday()));
});

app.patch('/api/tasks/:id/time', requireAuth, (req, res) => {
  const task = getTaskById(req.user.id, req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  const { scheduled_time } = req.body;
  updateTaskTime(req.user.id, scheduled_time || null, task.id);
  res.json(getTasksByDate(req.user.id, task.date || watToday()));
});

// ── kanban board ──────────────────────────────────────────────────────────────

const TASK_STATUSES = ['backlog', 'today', 'in_progress', 'done'];

app.get('/api/tasks/board', requireAuth, (req, res) => {
  res.json(getBoardTasks(req.user.id));
});

app.patch('/api/tasks/:id/status', requireAuth, (req, res) => {
  const { status } = req.body;
  if (!TASK_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${TASK_STATUSES.join(', ')}` });
  }
  const task = getTaskById(req.user.id, req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });

  // Moving to Done marks the task complete; moving out of Done un-completes
  // it. Moving to Today reschedules it for today. The done-change trigger in
  // db.js will re-derive status from done/date as a side effect of these two
  // writes, so the explicit status write below always runs last and wins.
  const wantDone = status === 'done';
  if (!!task.done !== wantDone) {
    toggleTask(req.user.id, wantDone ? 1 : 0, task.id);
  }
  if (status === 'today' && task.date !== watToday()) {
    updateTaskDate(req.user.id, watToday(), task.id);
  }
  updateTaskStatus(req.user.id, status, task.id);

  const updated = getTaskById(req.user.id, task.id);
  gcal.syncTaskToCalendar(req.user.id, updated).catch(err => console.error('[calendar] sync failed:', err.message));
  res.json(updated);
});

app.delete('/api/tasks/:id', requireAuth, (req, res) => {
  const task = getTaskById(req.user.id, req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (task.calendar_event_id) {
    gcal.deleteEvent(req.user.id, task.calendar_event_id).catch(err =>
      console.error('[calendar] delete failed:', err.message)
    );
  }
  deleteTask(req.user.id, req.params.id);
  res.status(204).end();
});

// ── batch complete ────────────────────────────────────────────────────────────

app.post('/api/tasks/complete-batch', requireAuth, (req, res) => {
  const { task_ids } = req.body;
  if (!Array.isArray(task_ids) || !task_ids.length) {
    return res.status(400).json({ error: 'task_ids array required' });
  }
  const date = watToday();
  db.transaction((ids) => {
    for (const id of ids) markTaskDone(req.user.id, id);
  })(task_ids);
  syncDayLog(req.user.id, date);
  const tasks = getTasksByDate(req.user.id, date);
  const total = tasks.length;
  const done  = tasks.filter(t => t.done).length;
  const rate  = total ? Math.round(done / total * 100) : 0;
  res.json({ tasks, done, total, rate });
});

// ── carry forward ─────────────────────────────────────────────────────────────

app.post('/api/tasks/:id/carry', requireAuth, (req, res) => {
  const toDate = req.body?.toDate || watTomorrow();
  try {
    const task = getTaskById(req.user.id, req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    const carried = carryTask(req.user.id, task.id, task.date, toDate);
    res.status(201).json({ ok: true, newTaskId: carried.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── recurring tasks ───────────────────────────────────────────────────────────

app.get('/api/recurring', requireAuth, (req, res) => {
  res.json(getRecurringGrouped(req.user.id));
});

app.post('/api/recurring', requireAuth, (req, res) => {
  const { name, business, scheduled_time, days, time_block, category } = req.body;
  if (!name || !business) return res.status(400).json({ error: 'name and business are required' });
  addRecurring(req.user.id, name, business, scheduled_time, days, time_block, category);
  res.status(201).json(getRecurringGrouped(req.user.id));
});

app.delete('/api/recurring/:id', requireAuth, (req, res) => {
  const info = deactivateRecurring(req.user.id, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json(getRecurring(req.user.id));
});

app.get('/api/recurring/future', requireAuth, (req, res) => {
  res.json(getFutureRecurring(req.user.id));
});

app.post('/api/recurring/future', requireAuth, (req, res) => {
  const { name, business, scheduled_time, days, time_block, category } = req.body;
  if (!name || !business) return res.status(400).json({ error: 'name and business are required' });
  db.prepare(
    `INSERT INTO recurring_tasks (user_id, name, business, scheduled_time, days, time_block, category, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(req.user.id, name, business, scheduled_time || null, days || 'daily', time_block || null, category || 'work');
  res.status(201).json(getFutureRecurring(req.user.id));
});

app.patch('/api/recurring/:id/activate', requireAuth, (req, res) => {
  const info = activateRecurring(req.user.id, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.patch('/api/recurring/:id/time', requireAuth, (req, res) => {
  const { scheduled_time } = req.body;
  const info = updateRecurringTime(req.user.id, scheduled_time || null, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.patch('/api/recurring/:id/toggle-active', requireAuth, (req, res) => {
  try {
    const result = toggleRecurringActive(req.user.id, req.params.id);
    res.json(result);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// ── pending recurring confirmation ────────────────────────────────────────────

app.get('/api/recurring/pending/:date', requireAuth, (req, res) => {
  const date = req.params.date === 'today' ? watToday() : req.params.date;
  res.json(getPendingRecurring(req.user.id, date));
});

app.post('/api/recurring/confirm/:id', requireAuth, (req, res) => {
  try {
    const task = confirmRecurring(req.user.id, req.params.id);
    res.json({ ok: true, task });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/recurring/confirm-all/:date', requireAuth, (req, res) => {
  const date = req.params.date === 'today' ? watToday() : req.params.date;
  try {
    const tasks = confirmAllRecurring(req.user.id, date);
    tasks.forEach(t => gcal.syncTaskToCalendar(req.user.id, t).catch(err =>
      console.error('[calendar] sync failed:', err.message)
    ));
    res.json(tasks);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/recurring/reject/:id', requireAuth, (req, res) => {
  const info = rejectRecurring(req.user.id, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.post('/api/recurring/skip/:date', requireAuth, (req, res) => {
  const date = req.params.date === 'today' ? watToday() : req.params.date;
  rejectAllPendingRecurring(req.user.id, date);
  res.json({ ok: true });
});

// ── businesses ────────────────────────────────────────────────────────────────

app.get('/api/businesses', requireAuth, (req, res) => {
  res.json(getBusinesses(req.user.id));
});

app.post('/api/businesses', requireAuth, (req, res) => {
  const { name, color_bg, color_text } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 30);
  if (!slug) return res.status(400).json({ error: 'invalid name — no valid slug characters' });
  try {
    addBusiness(req.user.id, name, slug, color_bg || '#f0f0ee', color_text || '#333333');
    res.status(201).json(getBusinesses(req.user.id));
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: `Business slug '${slug}' already exists` });
    }
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/businesses/:id', requireAuth, (req, res) => {
  const info = deactivateBusiness(req.user.id, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json(getBusinesses(req.user.id));
});

// ── document analyses ─────────────────────────────────────────────────────────

app.post('/api/documents/analyze', requireAuth, async (req, res) => {
  const { text, business } = req.body;
  if (!text || text.length < 100) {
    return res.status(400).json({ error: 'Document too short. Paste the full document content.' });
  }
  try {
    const goals    = getAllGoals(req.user.id);
    const tasks    = getTasksByDate(req.user.id, watToday());
    const analysis = await parseStrategicDocument(text, business || 'blok', goals, tasks);
    const info     = saveDocumentAnalysis(
      req.user.id,
      business || 'blok',
      text.slice(0, 200),
      analysis.summary,
      analysis.key_insight,
      analysis.risk,
      JSON.stringify(analysis.tasks)
    );
    res.json({ ok: true, id: info.lastInsertRowid, analysis });
  } catch (err) {
    console.error('[documents/analyze]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/documents/analyze/import', requireAuth, (req, res) => {
  const { tasks } = req.body;
  if (!Array.isArray(tasks) || !tasks.length) {
    return res.status(400).json({ error: 'tasks array required' });
  }
  const today = watToday();
  const stmt  = db.prepare(
    `INSERT INTO tasks (user_id, date, name, business, time, done, priority, source)
     VALUES (?, ?, ?, ?, ?, 0, ?, 'document')`
  );
  db.transaction((ts) => {
    for (const t of ts) {
      stmt.run(req.user.id, today, t.name, t.business || 'blok', t.time || null, t.priority || 'normal');
    }
  })(tasks);
  syncDayLog(req.user.id, today);
  res.json(getTasksByDate(req.user.id, today));
});

app.get('/api/documents', requireAuth, (req, res) => {
  res.json(getDocumentAnalyses(req.user.id));
});

// ── uploaded document library ─────────────────────────────────────────────────

app.get('/api/documents/library', requireAuth, (req, res) => {
  const { biz } = req.query;
  if (biz && biz !== 'all') {
    res.json(getUploadedDocumentsByBusiness(req.user.id, biz));
  } else {
    res.json(getAllUploadedDocuments(req.user.id));
  }
});

app.get('/api/documents/library/search', requireAuth, (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json([]);
  const like = `%${q}%`;
  res.json(searchUploadedDocuments(req.user.id, like, like));
});

app.get('/api/documents/library/:id', requireAuth, (req, res) => {
  const doc = getUploadedDocument(req.user.id, req.params.id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  res.json(doc);
});

app.post('/api/documents/upload', requireAuth, docUpload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { business, tags, assigned_to } = req.body;
  try {
    const parsed   = await parseDocument(req.file.path, req.file.mimetype);
    const cleaned  = cleanDocumentText(parsed.text);
    const words    = cleaned.split(/\s+/).filter(Boolean).length;
    const info     = saveUploadedDocument(
      req.user.id,
      req.file.filename,
      req.file.originalname,
      parsed.type,
      req.file.size,
      business || null,
      cleaned
    );
    const docId = info.lastInsertRowid;
    db.prepare('UPDATE uploaded_documents SET tags = ?, assigned_to = ? WHERE user_id = ? AND id = ?')
      .run(tags || null, assigned_to || getFounderProfile(req.user.id).name, req.user.id, docId);
    updateUploadedDocumentStatus(req.user.id, 'parsed', docId);
    fs.unlink(req.file.path, () => {});
    res.json({
      ok: true,
      documentId: docId,
      preview: cleaned.slice(0, 200),
      wordCount: words,
      type: parsed.type,
    });
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/documents/upload/analyze', requireAuth, docUpload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { business, tags, assigned_to } = req.body;
  const biz = business || 'blok';
  try {
    const parsed  = await parseDocument(req.file.path, req.file.mimetype);
    const cleaned = cleanDocumentText(parsed.text);
    const words   = cleaned.split(/\s+/).filter(Boolean).length;

    const docInfo = saveUploadedDocument(
      req.user.id, req.file.filename, req.file.originalname, parsed.type,
      req.file.size, biz, cleaned
    );
    const docId = docInfo.lastInsertRowid;
    db.prepare('UPDATE uploaded_documents SET tags = ?, assigned_to = ? WHERE user_id = ? AND id = ?')
      .run(tags || null, assigned_to || getFounderProfile(req.user.id).name, req.user.id, docId);
    updateUploadedDocumentStatus(req.user.id, 'parsed', docId);
    fs.unlink(req.file.path, () => {});

    const goals    = getAllGoals(req.user.id);
    const tasks    = getTasksByDate(req.user.id, watToday());
    const analysis = await parseStrategicDocument(cleaned, biz, goals, tasks);
    const anaInfo  = saveDocumentAnalysis(
      req.user.id, biz, cleaned.slice(0, 200),
      analysis.summary, analysis.key_insight, analysis.risk,
      JSON.stringify(analysis.tasks)
    );
    linkDocumentToAnalysis(req.user.id, anaInfo.lastInsertRowid, 'analyzed', docId);

    res.json({
      ok: true,
      documentId: docId,
      analysisId: anaInfo.lastInsertRowid,
      wordCount: words,
      type: parsed.type,
      analysis,
    });
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/documents/library/:id/analyze', requireAuth, async (req, res) => {
  const doc = getUploadedDocument(req.user.id, req.params.id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  if (!doc.parsed_text) return res.status(400).json({ error: 'No parsed text available' });
  try {
    const goals    = getAllGoals(req.user.id);
    const tasks    = getTasksByDate(req.user.id, watToday());
    const analysis = await parseStrategicDocument(doc.parsed_text, doc.business || 'blok', goals, tasks);
    const anaInfo  = saveDocumentAnalysis(
      req.user.id, doc.business || 'blok', doc.parsed_text.slice(0, 200),
      analysis.summary, analysis.key_insight, analysis.risk,
      JSON.stringify(analysis.tasks)
    );
    linkDocumentToAnalysis(req.user.id, anaInfo.lastInsertRowid, 'analyzed', doc.id);
    res.json({ ok: true, analysisId: anaInfo.lastInsertRowid, analysis });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/documents/library/:id/assign', requireAuth, (req, res) => {
  const doc = getUploadedDocument(req.user.id, req.params.id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  const { tasks, assignee, date } = req.body;
  if (!Array.isArray(tasks) || !tasks.length) {
    return res.status(400).json({ error: 'tasks array required' });
  }
  const targetDate = date || watToday();
  const stmt = db.prepare(
    `INSERT INTO tasks (user_id, date, name, business, time, done, priority, source)
     VALUES (?, ?, ?, ?, ?, 0, ?, 'document')`
  );
  db.transaction((ts) => {
    for (const t of ts) {
      stmt.run(req.user.id, targetDate, t.name, t.business || doc.business || 'blok', t.time || null, t.priority || 'normal');
    }
  })(tasks);
  if (assignee) {
    db.prepare('UPDATE uploaded_documents SET assigned_to = ? WHERE user_id = ? AND id = ?').run(assignee, req.user.id, doc.id);
  }
  syncDayLog(req.user.id, targetDate);
  res.json({ ok: true, tasksAdded: tasks.length });
});

app.delete('/api/documents/library/:id', requireAuth, (req, res) => {
  const info = archiveUploadedDocument(req.user.id, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.get('/api/team', requireAuth, (req, res) => {
  res.json(getTeamMembers(req.user.id));
});

app.get('/api/team/:business', requireAuth, (req, res) => {
  res.json(getMembersByBusiness(req.user.id, req.params.business, 'all'));
});

// ── history ───────────────────────────────────────────────────────────────────

app.get('/api/history', requireAuth, (req, res) => {
  const { from, to } = req.query;
  if (from && to) {
    const rows = db.prepare(
      `SELECT date,
              COUNT(*)                                AS total,
              SUM(done)                               AS done,
              ROUND(SUM(done) * 100.0 / COUNT(*), 1) AS rate
       FROM tasks WHERE user_id = ? AND date >= ? AND date <= ?
       GROUP BY date ORDER BY date ASC`
    ).all(req.user.id, from, to);
    return res.json(rows);
  }
  const days = Math.min(parseInt(req.query.days, 10) || 30, 90);
  res.json(getHistory(req.user.id, days));
});

app.get('/api/tasks/range', requireAuth, (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  const rows = db.prepare(
    'SELECT * FROM tasks WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date, time, id'
  ).all(req.user.id, from, to);
  const byDate = {};
  for (const t of rows) {
    if (!byDate[t.date]) byDate[t.date] = [];
    byDate[t.date].push(t);
  }
  res.json(byDate);
});

// ── brain dump ────────────────────────────────────────────────────────────────

app.post('/api/brain-dump/text', requireAuth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });
    const structured = await structureDump(text);
    res.json({ structured, tasks: getTasksByDate(req.user.id, watToday()) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/brain-dump/voice', requireAuth, audioUpload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'audio file required' });
    const mimeType   = req.file.mimetype || 'audio/webm';
    const transcript = await transcribeAudio(req.file.buffer, mimeType);
    const structured = await structureDump(transcript);
    res.json({ transcript, structured });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/brain-dump/import', requireAuth, (req, res) => {
  const { tasks } = req.body;
  if (!Array.isArray(tasks) || !tasks.length) return res.status(400).json({ error: 'tasks array required' });
  const today = watToday();
  const newIds = [];
  db.transaction((list) => {
    for (const t of list) {
      const info = insertTask(req.user.id, today, t.name, t.business || 'personal', t.time || null, t.priority || 'normal');
      newIds.push(info.lastInsertRowid);
      logTaskInsert('brain-dump-web', t.name, { date: today, business: t.business || 'personal', taskId: info.lastInsertRowid, userId: req.user.id });
    }
  })(tasks);
  for (const id of newIds) {
    const task = getTaskById(req.user.id, id);
    if (task) gcal.syncTaskToCalendar(req.user.id, task).catch(err => console.error('[calendar] sync failed:', err.message));
  }
  res.json(getTasksByDate(req.user.id, today));
});

// ── KPIs ──────────────────────────────────────────────────────────────────────

app.get('/api/kpis', requireAuth, (req, res) => {
  res.json(getKpis(req.user.id, weekStart()));
});

app.post('/api/kpis', requireAuth, (req, res) => {
  const { business, metric, value, target } = req.body;
  if (!business || !metric || value === undefined) {
    return res.status(400).json({ error: 'business, metric, and value are required' });
  }
  const date = watToday();
  upsertKpi(req.user.id, date, business, metric, value, target ?? null);
  res.json(db.prepare('SELECT * FROM kpis WHERE user_id = ? AND date = ? AND business = ? AND metric = ?').get(req.user.id, date, business, metric));
});

// ── ideas ─────────────────────────────────────────────────────────────────────

app.get('/api/ideas', requireAuth, (req, res) => {
  res.json(getIdeas(req.user.id));
});

app.post('/api/ideas', requireAuth, (req, res) => {
  const { business, content } = req.body;
  if (!business || !content) return res.status(400).json({ error: 'business and content are required' });
  const info = addIdea(req.user.id, business, content);
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

// ── notes ─────────────────────────────────────────────────────────────────────

app.get('/api/notes', requireAuth, (req, res) => {
  res.json(getNotes(req.user.id));
});

app.post('/api/notes', requireAuth, (req, res) => {
  const { business, content } = req.body;
  if (!business || !content) return res.status(400).json({ error: 'business and content are required' });
  const info = addNote(req.user.id, business, content);
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

// ── analytics ─────────────────────────────────────────────────────────────────

app.get('/api/analytics/by-business', requireAuth, (req, res) => {
  const { month } = req.query; // YYYY-MM
  let rows;
  if (month) {
    rows = db.prepare(
      `SELECT business,
              COUNT(*)                                AS total,
              SUM(done)                               AS completed,
              ROUND(SUM(done) * 100.0 / COUNT(*), 1) AS rate
       FROM tasks WHERE user_id = ? AND date LIKE ?
       GROUP BY business ORDER BY business`
    ).all(req.user.id, `${month}-%`);
  } else {
    const since = watCutoff(30);
    rows = db.prepare(
      `SELECT business,
              COUNT(*)                                AS total,
              SUM(done)                               AS completed,
              ROUND(SUM(done) * 100.0 / COUNT(*), 1) AS rate
       FROM tasks WHERE user_id = ? AND date >= ?
       GROUP BY business ORDER BY business`
    ).all(req.user.id, since);
  }
  res.json(rows);
});

app.get('/api/analytics/missed', requireAuth, (req, res) => {
  const today = watToday();
  const rows  = db.prepare(
    `SELECT name, business, COUNT(*) AS frequency
     FROM tasks
     WHERE user_id = ? AND done = 0
       AND date < ?
     GROUP BY name
     ORDER BY frequency DESC
     LIMIT 10`
  ).all(req.user.id, today);
  res.json(rows);
});

// ── scorecard ─────────────────────────────────────────────────────────────────

app.get('/api/scorecard/week', requireAuth, (req, res) => {
  res.json({
    investorTouches: getInvestorTouchesThisWeek(req.user.id),
    quarterlyPct:    getQuarterlyGoalPct(req.user.id),
  });
});

// ── anchors ───────────────────────────────────────────────────────────────────

app.get('/api/anchors/today', requireAuth, (req, res) => {
  res.json(getAnchorsForDate(req.user.id, watToday()));
});

app.patch('/api/anchors/:key/toggle', requireAuth, (req, res) => {
  const done = toggleAnchor(req.user.id, watToday(), req.params.key);
  if (done === null) return res.status(404).json({ error: 'Unknown anchor key' });
  res.json({ key: req.params.key, done });
});

// ── goals ─────────────────────────────────────────────────────────────────────

app.get('/api/goals', requireAuth, (req, res) => {
  const goals = getAllGoals(req.user.id);
  for (const goal of goals) {
    goal.progress = getGoalProgress(goal.id).slice(0, 3);
  }
  res.json(goals);
});

app.get('/api/goals/:business', requireAuth, (req, res) => {
  const goals = getGoals(req.user.id, req.params.business);
  for (const goal of goals) {
    goal.progress = getGoalProgress(goal.id).slice(0, 3);
  }
  res.json(goals);
});

app.post('/api/goals', requireAuth, (req, res) => {
  const { business, dimension, title, description, target_date, year } = req.body;
  if (!business || !dimension || !title) {
    return res.status(400).json({ error: 'business, dimension, and title are required' });
  }
  if (!['growth', 'finance', 'operations'].includes(dimension)) {
    return res.status(400).json({ error: 'dimension must be growth, finance, or operations' });
  }
  addGoal(req.user.id, business, dimension, title, description || null, target_date || null, year || 2026);
  const goals = getAllGoals(req.user.id);
  for (const g of goals) g.progress = getGoalProgress(g.id).slice(0, 3);
  res.status(201).json(goals);
});

app.patch('/api/goals/:id', requireAuth, (req, res) => {
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  const info = updateGoalTitle(req.user.id, title, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  const goals = getAllGoals(req.user.id);
  for (const g of goals) g.progress = getGoalProgress(g.id).slice(0, 3);
  res.json(goals);
});

app.patch('/api/goals/:id/status', requireAuth, (req, res) => {
  const { status } = req.body;
  if (!['active', 'achieved', 'paused'].includes(status)) {
    return res.status(400).json({ error: 'status must be active, achieved, or paused' });
  }
  const info = updateGoalStatus(req.user.id, status, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  const goals = getAllGoals(req.user.id);
  for (const g of goals) g.progress = getGoalProgress(g.id).slice(0, 3);
  res.json(goals);
});

app.post('/api/goals/:id/progress', requireAuth, (req, res) => {
  const { note } = req.body;
  if (!note) return res.status(400).json({ error: 'note is required' });
  // goal_progress carries no user_id of its own — ownership is enforced here,
  // by checking the referenced goal actually belongs to the caller, before
  // ever touching goal_progress. See getGoalById's doc comment in db.js.
  const goal = getGoalById(req.user.id, req.params.id);
  if (!goal) return res.status(404).json({ error: 'not found' });
  addGoalProgress(req.params.id, note);
  res.json({ ok: true });
});

// ── monthly cycles ────────────────────────────────────────────────────────────

// must come before /api/cycles/:month to avoid routing conflict
app.get('/api/cycles/:month/summary', requireAuth, (req, res) => {
  const { month } = req.params;
  const cycles = getCycles(req.user.id, month);
  const summary = cycles.map(c => {
    const total = c.commitment_3 ? 3 : 2;
    const done  = (c.status_1 === 'done' ? 1 : 0) +
                  (c.status_2 === 'done' ? 1 : 0) +
                  (c.commitment_3 && c.status_3 === 'done' ? 1 : 0);
    return {
      business:   c.business,
      title:      c.title,
      goal_title: c.goal_title,
      done,
      total,
      pct:        Math.round(done / total * 100),
      reflection: c.reflection || null,
    };
  });
  res.json(summary);
});

app.get('/api/cycles/:month', requireAuth, (req, res) => {
  res.json(getCycles(req.user.id, req.params.month));
});

app.post('/api/cycles', requireAuth, (req, res) => {
  const { business, goal_id, month, title, commitment_1, commitment_2, commitment_3 } = req.body;
  if (!business || !month || !title || !commitment_1 || !commitment_2) {
    return res.status(400).json({ error: 'business, month, title, commitment_1, and commitment_2 are required' });
  }
  try {
    addCycle(req.user.id, business, goal_id || null, month, title, commitment_1, commitment_2, commitment_3 || null);
    res.status(201).json(getCycles(req.user.id, month));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Cycle already exists for this business/goal/month' });
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/cycles/:id/commitment', requireAuth, (req, res) => {
  const { which, status } = req.body;
  if (!['pending', 'done'].includes(status)) {
    return res.status(400).json({ error: 'status must be pending or done' });
  }
  try {
    const updated = updateCycleCommitment(req.user.id, req.params.id, which, status);
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/cycles/:id/reflection', requireAuth, (req, res) => {
  const { reflection } = req.body;
  if (!reflection) return res.status(400).json({ error: 'reflection is required' });
  const info = updateCycleReflection(req.user.id, reflection, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// ── schedule ──────────────────────────────────────────────────────────────────

app.get('/api/schedule', requireAuth, (req, res) => {
  const row = getSetting(req.user.id, 'schedule_blocks');
  if (row) {
    try { return res.json(JSON.parse(row.value)); } catch { }
  }
  res.json(getFounderProfile(req.user.id).scheduleBlocks);
});

// ── founder profile ───────────────────────────────────────────────────────────

app.get('/api/profile', requireAuth, (req, res) => {
  res.json(getFounderProfile(req.user.id));
});

app.patch('/api/profile', requireAuth, (req, res) => {
  res.json(saveFounderProfile(req.user.id, req.body || {}));
});

app.post('/api/schedule/order', requireAuth, (req, res) => {
  const { blocks } = req.body;
  if (!Array.isArray(blocks) || !blocks.length) {
    return res.status(400).json({ error: 'blocks array required' });
  }
  upsertSetting(req.user.id, 'schedule_blocks', JSON.stringify(blocks));
  res.json({ ok: true });
});

// ── Google OAuth ──────────────────────────────────────────────────────────────

app.get('/auth/google', requireAuth, (req, res) => {
  try {
    // userId threaded through the OAuth `state` param so the callback (a
    // fresh request from Google, but with the same browser session cookie
    // riding along) knows which account to attach tokens to without relying
    // on session state surviving the round trip through Google's servers.
    res.redirect(gcal.getAuthUrl(req.user.id));
  } catch (err) {
    res.status(500).send('Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
  }
});

app.get('/auth/google/callback', requireAuth, async (req, res) => {
  try {
    await gcal.exchangeCode(req.user.id, req.query.code);
    gcal.setupCalendarWatch(req.user.id, process.env.SERVER_URL).catch(err =>
      console.error('[calendar] watch setup after auth failed:', err.message)
    );
    // Sync today's existing tasks to Google Calendar
    const today = watToday();
    const tasks = getTasksByDate(req.user.id, today);
    let synced  = 0;
    for (const task of tasks) {
      if (!task.calendar_event_id) {
        try {
          await gcal.syncTaskToCalendar(req.user.id, task);
          synced++;
          await new Promise(r => setTimeout(r, 200));
        } catch (err) {
          console.error('[calendar] initial sync failed:', err.message);
        }
      }
    }
    console.log(`[calendar] initial sync: ${synced} tasks`);
    res.redirect(`/?connected=google&synced=${synced}`);
  } catch (err) {
    console.error('[google] callback error:', err.message);
    res.redirect('/?error=google_auth');
  }
});

// ── Google Calendar API ───────────────────────────────────────────────────────

app.get('/api/calendar/status', requireAuth, (req, res) => {
  const row = getSetting(req.user.id, 'google_tokens');
  res.json({ connected: !!row });
});

app.get('/api/calendar/today', requireAuth, async (req, res) => {
  try { res.json(await gcal.getTodayEvents(req.user.id)); }
  catch (err) { res.status(err.message === 'Not authenticated' ? 401 : 500).json({ error: err.message }); }
});

app.get('/api/calendar/month/:year/:month', requireAuth, async (req, res) => {
  try {
    const events = await gcal.getEventsForMonth(
      req.user.id,
      parseInt(req.params.year, 10),
      parseInt(req.params.month, 10)
    );
    res.json(events);
  } catch (err) {
    res.status(err.message === 'Not authenticated' ? 401 : 500).json({ error: err.message });
  }
});

app.get('/api/calendar/calendars', requireAuth, async (req, res) => {
  try { res.json(await gcal.listCalendars(req.user.id)); }
  catch (err) { res.status(err.message === 'Not authenticated' ? 401 : 500).json({ error: err.message }); }
});

app.post('/api/calendar/sync-task/:id', requireAuth, async (req, res) => {
  try {
    const task = getTaskById(req.user.id, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const eventId = await gcal.syncTaskToCalendar(req.user.id, task);
    res.json({ ok: true, eventId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/calendar/sync-blocks', requireAuth, async (req, res) => {
  try {
    const row    = getSetting(req.user.id, 'schedule_blocks');
    const blocks = row ? JSON.parse(row.value) : [];
    const count  = await gcal.syncBlocksToCalendar(req.user.id, blocks);
    res.json({ ok: true, count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/calendar/events', requireAuth, async (req, res) => {
  try {
    const { title, date, startTime, endTime, description, calendarId } = req.body;
    if (!title || !date || !startTime || !endTime) {
      return res.status(400).json({ error: 'title, date, startTime, endTime required' });
    }
    const event = await gcal.createEvent(req.user.id, title, date, startTime, endTime, description, calendarId);
    res.json(event);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/calendar/events/:eventId', requireAuth, async (req, res) => {
  try {
    await gcal.deleteEvent(req.user.id, req.params.eventId, req.query.calendarId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── settings ──────────────────────────────────────────────────────────────────

app.get('/api/settings', requireAuth, (req, res) => {
  const rows = db.prepare("SELECT key, value, updated_at FROM settings WHERE user_id = ? AND key != 'google_tokens'").all(req.user.id);
  const out  = {};
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  res.json(out);
});

app.patch('/api/settings/calendar', requireAuth, (req, res) => {
  const { calendarId } = req.body;
  if (!calendarId) return res.status(400).json({ error: 'calendarId required' });
  upsertSetting(req.user.id, 'google_calendar_id', calendarId);
  res.json({ ok: true });
});

app.delete('/api/settings/google', requireAuth, (req, res) => {
  deleteSetting(req.user.id, 'google_tokens');
  deleteSetting(req.user.id, 'google_calendar_id');
  deleteSetting(req.user.id, 'daywan_calendar_id');
  res.json({ ok: true });
});

app.patch('/api/settings/notifications', requireAuth, (req, res) => {
  const prefs = req.body;
  upsertSetting(req.user.id, 'notification_prefs', JSON.stringify(prefs));
  res.json({ ok: true });
});

// ── Telegram connect ──────────────────────────────────────────────────────────

app.post('/api/telegram/connect-token', requireAuth, (req, res) => {
  const token     = require('crypto').randomBytes(20).toString('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  insertConnectToken.run(token, req.user.id, expiresAt);
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'your_bot';
  res.json({ token, deepLink: `https://t.me/${botUsername}?start=${token}` });
});

app.delete('/api/telegram/connect', requireAuth, (req, res) => {
  clearUserChatId.run(req.user.id);
  res.json({ ok: true });
});

// ── Google Calendar push webhook ──────────────────────────────────────────────
// External caller (Google's servers), not a browser session — no requireAuth.
// Authenticated instead by the channel token header set at watch-registration
// time. userId comes from the row it looks up by event id, not from a session.

app.post('/api/calendar/webhook', (req, res) => {
  const token = req.headers['x-goog-channel-token'];
  if (token !== (process.env.GOOGLE_WEBHOOK_TOKEN || 'lifeline-secret')) {
    return res.sendStatus(403);
  }

  const channelId = req.headers['x-goog-channel-id'];
  const state      = req.headers['x-goog-resource-state'];
  res.sendStatus(200); // respond fast — Google requires < 2 s

  console.log(`[calendar-sync] RUN START caller=webhook state=${state} channelId=${channelId} pid=${process.pid} time=${new Date().toISOString()}`);

  gcal.resolveUserIdForWatchChannel(channelId).then(userId => {
    if (!userId) {
      console.error(`[calendar-sync] webhook: no user found for channelId=${channelId}`);
      return;
    }
    if (state === 'sync') {
      // Initial handshake — fetch events to get a sync token baseline
      gcal.getChangedEvents(userId, null)
        .then(events => console.log(`[calendar-sync] RUN END caller=webhook state=sync userId=${userId} fetched=${events.length} pid=${process.pid}`))
        .catch(err => console.error('[calendar] initial sync error:', err.message));
      return;
    }

    if (state === 'exists') {
      const tokenRow  = getSetting(userId, 'google_sync_token');
      const syncToken = tokenRow ? tokenRow.value : null;
      gcal.getChangedEvents(userId, syncToken)
        .then(events => {
          console.log(`[calendar-sync] caller=webhook userId=${userId} fetched=${events.length} event(s): ${events.map(e => e.id).join(',')} pid=${process.pid}`);
          return Promise.all(events.map(e => gcal.processCalendarEvent(userId, e, 'webhook')));
        })
        .then(() => console.log(`[calendar-sync] RUN END caller=webhook userId=${userId} pid=${process.pid} time=${new Date().toISOString()}`))
        .catch(err => console.error('[calendar] webhook processing error:', err.message));
    }
  }).catch(err => console.error('[calendar] webhook channel resolution error:', err.message));
});

app.post('/api/calendar/sync-today', requireAuth, async (req, res) => {
  try {
    const today = watToday();
    const tasks = getTasksByDate(req.user.id, today).filter(t => !t.calendar_event_id);
    let synced  = 0;
    for (const task of tasks) {
      try {
        await gcal.syncTaskToCalendar(req.user.id, task);
        synced++;
      } catch (err) {
        console.error('[calendar] sync-today failed:', err.message);
      }
    }
    res.json({ ok: true, synced });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/calendar/sync-week', requireAuth, async (req, res) => {
  try {
    const today = watToday();
    const from  = new Date(Date.now() + 60 * 60 * 1000 - 7 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const tasks = db.prepare(
      'SELECT * FROM tasks WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date, id'
    ).all(req.user.id, from, today).filter(t => !t.calendar_event_id);
    let synced = 0;
    for (const task of tasks) {
      try {
        await gcal.syncTaskToCalendar(req.user.id, task);
        synced++;
        await new Promise(r => setTimeout(r, 100));
      } catch (err) {
        console.error('[calendar] sync-week failed:', err.message);
      }
    }
    res.json({ ok: true, synced });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/calendar/sync-test', requireAuth, async (req, res) => {
  try {
    const now       = new Date(Date.now() + 60 * 60 * 1000);
    const today     = now.toISOString().slice(0, 10);
    const startH    = String(now.getUTCHours() + 1).padStart(2, '0');
    const startTime = `${startH}:00`;
    const endTime   = `${startH}:30`;
    const event = await gcal.createEvent(
      req.user.id, `${getFounderProfile(req.user.id).brandName} Sync Test`, today, startTime, endTime, 'Webhook sync test event'
    );
    res.json({
      ok: true,
      eventId: event.id,
      message: 'Test event created. Check your tasks in a few seconds.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── telegram webhook ──────────────────────────────────────────────────────────
// External caller (Telegram's servers) — no requireAuth. handleUpdate resolves
// the right user internally from the incoming message's chat_id.

app.post('/telegram-webhook', (req, res) => {
  res.sendStatus(200);
  handleUpdate(req.body).catch((err) => console.error('[telegram] update error:', err.message));
});

// ── health ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true }));

// ── startup ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

console.log(`[BOOT] pid=${process.pid} time=${new Date().toISOString()} NODE_ENV=${process.env.NODE_ENV} starting LIFELINE server — if two BOOT lines with different pids appear close together, two process instances are alive concurrently`);

initBot();
initScheduler();

if (!POLLING && process.env.SERVER_URL) {
  registerWebhook(process.env.SERVER_URL).catch((err) =>
    console.error('[telegram] webhook registration failed:', err.message)
  );
}

app.listen(PORT, () => console.log(`[server] listening on port ${PORT}`));
