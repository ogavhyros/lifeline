require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const {
  db, watToday, watTomorrow, watCutoff, weekStart,
  getTasksByDate, getTaskById, insertTask, toggleTask, markTaskDone, updatePriority, deleteTask,
  deduplicateTasks, updateTaskStatus, updateTaskDate, getBoardTasks,
  getHistory, getKpis, upsertKpi,
  getRecurring, getFutureRecurring, getRecurringGrouped, addRecurring, deactivateRecurring, activateRecurring, populateRecurring,
  toggleRecurringActive, updateRecurringTime,
  getPendingRecurring, confirmRecurring, confirmAllRecurring, rejectRecurring, rejectAllPendingRecurring,
  carryTask, addIdea, getIdeas, addNote, getNotes, syncDayLog,
  getGoals, getAllGoals, addGoal, updateGoalStatus, updateGoalTitle,
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
} = require('./db');
const { parseDocument, cleanDocumentText } = require('./document-parser');
const gcal = require('./google-calendar');
const { structureDump, transcribeAudio, parseStrategicDocument } = require('./ai');
const { initBot, handleUpdate, registerWebhook, POLLING, sendMessage } = require('./telegram');
const { initScheduler } = require('./scheduler');

// Wire sendMessage into gcal so processCalendarEvent can notify via Telegram
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
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── startup: verify task persistence ─────────────────────────────────────────
{
  const today = watToday();
  const count = getTasksByDate.all(today).length;
  console.log(`[db] ${count} task${count !== 1 ? 's' : ''} found for today (${today})`);

  // One-time cleanup of duplicates left over from the Google Calendar sync
  // loop bug (a synced task getting pulled back in as a "new" task).
  const removed = deduplicateTasks(today);
  if (removed > 0) console.log(`[startup] cleaned ${removed} duplicate task${removed !== 1 ? 's' : ''} for today`);
}

// ── tasks ─────────────────────────────────────────────────────────────────────

app.get('/api/tasks', (req, res) => {
  const date  = req.query.date || watToday();
  syncDayLog(date);
  const tasks = getTasksByDate.all(date);

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

app.post('/api/tasks/deduplicate', (req, res) => {
  const date    = req.query.date || watToday();
  const removed = deduplicateTasks(date);
  res.json({ ok: true, removed });
});

app.post('/api/tasks', (req, res) => {
  const { name, business, scheduled_time, priority } = req.body;
  if (!name || !business) return res.status(400).json({ error: 'name and business are required' });
  const info = insertTask.run(watToday(), name, business, scheduled_time || null, priority || 'normal');
  const task = getTaskById.get(info.lastInsertRowid);
  gcal.syncTaskToCalendar(task).catch(err => console.error('[calendar] sync failed:', err.message));
  res.status(201).json(task);
});

app.patch('/api/tasks/:id/toggle', (req, res) => {
  const task = getTaskById.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  toggleTask.run(task.done ? 0 : 1, task.id);
  const updated = getTaskById.get(task.id);
  gcal.syncTaskToCalendar(updated).catch(err => console.error('[calendar] sync failed:', err.message));
  res.json(updated);
});

app.patch('/api/tasks/:id/priority', (req, res) => {
  const { priority } = req.body;
  if (!['high', 'normal', 'low'].includes(priority)) {
    return res.status(400).json({ error: 'priority must be high, normal, or low' });
  }
  const task = getTaskById.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  updatePriority.run(priority, task.id);
  res.json(getTasksByDate.all(watToday()));
});

app.patch('/api/tasks/:id/time', (req, res) => {
  const task = getTaskById.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  const { scheduled_time } = req.body;
  updateTaskTime.run(scheduled_time || null, task.id);
  res.json(getTasksByDate.all(task.date || watToday()));
});

// ── kanban board ──────────────────────────────────────────────────────────────

const TASK_STATUSES = ['backlog', 'today', 'in_progress', 'done'];

app.get('/api/tasks/board', (_req, res) => {
  res.json(getBoardTasks());
});

app.patch('/api/tasks/:id/status', (req, res) => {
  const { status } = req.body;
  if (!TASK_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${TASK_STATUSES.join(', ')}` });
  }
  const task = getTaskById.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });

  // Moving to Done marks the task complete; moving out of Done un-completes
  // it. Moving to Today reschedules it for today. The done-change trigger in
  // db.js will re-derive status from done/date as a side effect of these two
  // writes, so the explicit status write below always runs last and wins.
  const wantDone = status === 'done';
  if (!!task.done !== wantDone) {
    toggleTask.run(wantDone ? 1 : 0, task.id);
  }
  if (status === 'today' && task.date !== watToday()) {
    updateTaskDate.run(watToday(), task.id);
  }
  updateTaskStatus.run(status, task.id);

  const updated = getTaskById.get(task.id);
  gcal.syncTaskToCalendar(updated).catch(err => console.error('[calendar] sync failed:', err.message));
  res.json(updated);
});

app.delete('/api/tasks/:id', (req, res) => {
  const task = getTaskById.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (task.calendar_event_id) {
    gcal.deleteEvent(task.calendar_event_id).catch(err =>
      console.error('[calendar] delete failed:', err.message)
    );
  }
  deleteTask.run(req.params.id);
  res.status(204).end();
});

// ── batch complete ────────────────────────────────────────────────────────────

app.post('/api/tasks/complete-batch', (req, res) => {
  const { task_ids } = req.body;
  if (!Array.isArray(task_ids) || !task_ids.length) {
    return res.status(400).json({ error: 'task_ids array required' });
  }
  const date = watToday();
  db.transaction((ids) => {
    for (const id of ids) markTaskDone.run(id);
  })(task_ids);
  syncDayLog(date);
  const tasks = getTasksByDate.all(date);
  const total = tasks.length;
  const done  = tasks.filter(t => t.done).length;
  const rate  = total ? Math.round(done / total * 100) : 0;
  res.json({ tasks, done, total, rate });
});

// ── carry forward ─────────────────────────────────────────────────────────────

app.post('/api/tasks/:id/carry', (req, res) => {
  const toDate = req.body?.toDate || watTomorrow();
  try {
    const task = getTaskById.get(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    const carried = carryTask(task.id, task.date, toDate);
    res.status(201).json({ ok: true, newTaskId: carried.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── recurring tasks ───────────────────────────────────────────────────────────

app.get('/api/recurring', (_req, res) => {
  res.json(getRecurringGrouped());
});

app.post('/api/recurring', (req, res) => {
  const { name, business, scheduled_time, days, time_block, category } = req.body;
  if (!name || !business) return res.status(400).json({ error: 'name and business are required' });
  addRecurring.run(name, business, scheduled_time || null, days || 'daily', time_block || null, category || 'work');
  res.status(201).json(getRecurringGrouped());
});

app.delete('/api/recurring/:id', (req, res) => {
  const info = deactivateRecurring.run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json(getRecurring.all());
});

app.get('/api/recurring/future', (_req, res) => {
  res.json(getFutureRecurring.all());
});

app.post('/api/recurring/future', (req, res) => {
  const { name, business, scheduled_time, days, time_block, category } = req.body;
  if (!name || !business) return res.status(400).json({ error: 'name and business are required' });
  db.prepare(
    `INSERT INTO recurring_tasks (name, business, scheduled_time, days, time_block, category, active)
     VALUES (?, ?, ?, ?, ?, ?, 0)`
  ).run(name, business, scheduled_time || null, days || 'daily', time_block || null, category || 'work');
  res.status(201).json(getFutureRecurring.all());
});

app.patch('/api/recurring/:id/activate', (req, res) => {
  const info = activateRecurring.run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.patch('/api/recurring/:id/time', (req, res) => {
  const { scheduled_time } = req.body;
  const info = updateRecurringTime.run(scheduled_time || null, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.patch('/api/recurring/:id/toggle-active', (req, res) => {
  try {
    const result = toggleRecurringActive(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// ── pending recurring confirmation ────────────────────────────────────────────

app.get('/api/recurring/pending/:date', (req, res) => {
  const date = req.params.date === 'today' ? watToday() : req.params.date;
  res.json(getPendingRecurring.all(date));
});

app.post('/api/recurring/confirm/:id', (req, res) => {
  try {
    const task = confirmRecurring(req.params.id);
    res.json({ ok: true, task });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/recurring/confirm-all/:date', (req, res) => {
  const date = req.params.date === 'today' ? watToday() : req.params.date;
  try {
    const tasks = confirmAllRecurring(date);
    tasks.forEach(t => gcal.syncTaskToCalendar(t).catch(err =>
      console.error('[calendar] sync failed:', err.message)
    ));
    res.json(tasks);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/recurring/reject/:id', (req, res) => {
  const info = rejectRecurring.run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.post('/api/recurring/skip/:date', (req, res) => {
  const date = req.params.date === 'today' ? watToday() : req.params.date;
  rejectAllPendingRecurring.run(date);
  res.json({ ok: true });
});

// ── businesses ────────────────────────────────────────────────────────────────

app.get('/api/businesses', (_req, res) => {
  res.json(getBusinesses.all());
});

app.post('/api/businesses', (req, res) => {
  const { name, color_bg, color_text } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 30);
  if (!slug) return res.status(400).json({ error: 'invalid name — no valid slug characters' });
  try {
    addBusiness.run(name, slug, color_bg || '#f0f0ee', color_text || '#333333');
    res.status(201).json(getBusinesses.all());
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: `Business slug '${slug}' already exists` });
    }
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/businesses/:id', (req, res) => {
  const info = deactivateBusiness.run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json(getBusinesses.all());
});

// ── document analyses ─────────────────────────────────────────────────────────

app.post('/api/documents/analyze', async (req, res) => {
  const { text, business } = req.body;
  if (!text || text.length < 100) {
    return res.status(400).json({ error: 'Document too short. Paste the full document content.' });
  }
  try {
    const goals   = getAllGoals.all();
    const tasks   = getTasksByDate.all(watToday());
    const analysis = await parseStrategicDocument(text, business || 'blok', goals, tasks);
    const info     = saveDocumentAnalysis.run(
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

app.post('/api/documents/analyze/import', (req, res) => {
  const { tasks } = req.body;
  if (!Array.isArray(tasks) || !tasks.length) {
    return res.status(400).json({ error: 'tasks array required' });
  }
  const today = watToday();
  const stmt  = db.prepare(
    `INSERT INTO tasks (date, name, business, time, done, priority, source)
     VALUES (?, ?, ?, ?, 0, ?, 'document')`
  );
  db.transaction((ts) => {
    for (const t of ts) {
      stmt.run(today, t.name, t.business || 'blok', t.time || null, t.priority || 'normal');
    }
  })(tasks);
  syncDayLog(today);
  res.json(getTasksByDate.all(today));
});

app.get('/api/documents', (_req, res) => {
  res.json(getDocumentAnalyses.all());
});

// ── uploaded document library ─────────────────────────────────────────────────

app.get('/api/documents/library', (req, res) => {
  const { biz } = req.query;
  if (biz && biz !== 'all') {
    res.json(getUploadedDocumentsByBusiness.all(biz));
  } else {
    res.json(getAllUploadedDocuments.all());
  }
});

app.get('/api/documents/library/search', (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json([]);
  const like = `%${q}%`;
  res.json(searchUploadedDocuments.all(like, like));
});

app.get('/api/documents/library/:id', (req, res) => {
  const doc = getUploadedDocument.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  res.json(doc);
});

app.post('/api/documents/upload', docUpload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { business, tags, assigned_to } = req.body;
  try {
    const parsed   = await parseDocument(req.file.path, req.file.mimetype);
    const cleaned  = cleanDocumentText(parsed.text);
    const words    = cleaned.split(/\s+/).filter(Boolean).length;
    const info     = saveUploadedDocument.run(
      req.file.filename,
      req.file.originalname,
      parsed.type,
      req.file.size,
      business || null,
      cleaned
    );
    const docId = info.lastInsertRowid;
    db.prepare('UPDATE uploaded_documents SET tags = ?, assigned_to = ? WHERE id = ?')
      .run(tags || null, assigned_to || getFounderProfile().name, docId);
    updateUploadedDocumentStatus.run('parsed', docId);
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

app.post('/api/documents/upload/analyze', docUpload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { business, tags, assigned_to } = req.body;
  const biz = business || 'blok';
  try {
    const parsed  = await parseDocument(req.file.path, req.file.mimetype);
    const cleaned = cleanDocumentText(parsed.text);
    const words   = cleaned.split(/\s+/).filter(Boolean).length;

    const docInfo = saveUploadedDocument.run(
      req.file.filename, req.file.originalname, parsed.type,
      req.file.size, biz, cleaned
    );
    const docId = docInfo.lastInsertRowid;
    db.prepare('UPDATE uploaded_documents SET tags = ?, assigned_to = ? WHERE id = ?')
      .run(tags || null, assigned_to || getFounderProfile().name, docId);
    updateUploadedDocumentStatus.run('parsed', docId);
    fs.unlink(req.file.path, () => {});

    const goals    = getAllGoals.all();
    const tasks    = getTasksByDate.all(watToday());
    const analysis = await parseStrategicDocument(cleaned, biz, goals, tasks);
    const anaInfo  = saveDocumentAnalysis.run(
      biz, cleaned.slice(0, 200),
      analysis.summary, analysis.key_insight, analysis.risk,
      JSON.stringify(analysis.tasks)
    );
    linkDocumentToAnalysis.run(anaInfo.lastInsertRowid, 'analyzed', docId);

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

app.post('/api/documents/library/:id/analyze', async (req, res) => {
  const doc = getUploadedDocument.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  if (!doc.parsed_text) return res.status(400).json({ error: 'No parsed text available' });
  try {
    const goals    = getAllGoals.all();
    const tasks    = getTasksByDate.all(watToday());
    const analysis = await parseStrategicDocument(doc.parsed_text, doc.business || 'blok', goals, tasks);
    const anaInfo  = saveDocumentAnalysis.run(
      doc.business || 'blok', doc.parsed_text.slice(0, 200),
      analysis.summary, analysis.key_insight, analysis.risk,
      JSON.stringify(analysis.tasks)
    );
    linkDocumentToAnalysis.run(anaInfo.lastInsertRowid, 'analyzed', doc.id);
    res.json({ ok: true, analysisId: anaInfo.lastInsertRowid, analysis });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/documents/library/:id/assign', (req, res) => {
  const doc = getUploadedDocument.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  const { tasks, assignee, date } = req.body;
  if (!Array.isArray(tasks) || !tasks.length) {
    return res.status(400).json({ error: 'tasks array required' });
  }
  const targetDate = date || watToday();
  const stmt = db.prepare(
    `INSERT INTO tasks (date, name, business, time, done, priority, source)
     VALUES (?, ?, ?, ?, 0, ?, 'document')`
  );
  db.transaction((ts) => {
    for (const t of ts) {
      stmt.run(targetDate, t.name, t.business || doc.business || 'blok', t.time || null, t.priority || 'normal');
    }
  })(tasks);
  if (assignee) {
    db.prepare('UPDATE uploaded_documents SET assigned_to = ? WHERE id = ?').run(assignee, doc.id);
  }
  syncDayLog(targetDate);
  res.json({ ok: true, tasksAdded: tasks.length });
});

app.delete('/api/documents/library/:id', (req, res) => {
  const info = archiveUploadedDocument.run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.get('/api/team', (_req, res) => {
  res.json(getTeamMembers.all());
});

app.get('/api/team/:business', (req, res) => {
  res.json(getMembersByBusiness.all(req.params.business, 'all'));
});

// ── history ───────────────────────────────────────────────────────────────────

app.get('/api/history', (req, res) => {
  const { from, to } = req.query;
  if (from && to) {
    const rows = db.prepare(
      `SELECT date,
              COUNT(*)                                AS total,
              SUM(done)                               AS done,
              ROUND(SUM(done) * 100.0 / COUNT(*), 1) AS rate
       FROM tasks WHERE date >= ? AND date <= ?
       GROUP BY date ORDER BY date ASC`
    ).all(from, to);
    return res.json(rows);
  }
  const days = Math.min(parseInt(req.query.days, 10) || 30, 90);
  res.json(getHistory(days));
});

app.get('/api/tasks/range', (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  const rows = db.prepare(
    'SELECT * FROM tasks WHERE date >= ? AND date <= ? ORDER BY date, time, id'
  ).all(from, to);
  const byDate = {};
  for (const t of rows) {
    if (!byDate[t.date]) byDate[t.date] = [];
    byDate[t.date].push(t);
  }
  res.json(byDate);
});

// ── brain dump ────────────────────────────────────────────────────────────────

app.post('/api/brain-dump/text', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });
    const structured = await structureDump(text);
    res.json({ structured, tasks: getTasksByDate.all(watToday()) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/brain-dump/voice', audioUpload.single('audio'), async (req, res) => {
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

app.post('/api/brain-dump/import', (req, res) => {
  const { tasks } = req.body;
  if (!Array.isArray(tasks) || !tasks.length) return res.status(400).json({ error: 'tasks array required' });
  const today = watToday();
  const newIds = [];
  db.transaction((list) => {
    for (const t of list) {
      const info = insertTask.run(today, t.name, t.business || 'personal', t.time || null, t.priority || 'normal');
      newIds.push(info.lastInsertRowid);
    }
  })(tasks);
  for (const id of newIds) {
    const task = getTaskById.get(id);
    if (task) gcal.syncTaskToCalendar(task).catch(err => console.error('[calendar] sync failed:', err.message));
  }
  res.json(getTasksByDate.all(today));
});

// ── KPIs ──────────────────────────────────────────────────────────────────────

app.get('/api/kpis', (_req, res) => {
  res.json(getKpis.all(weekStart()));
});

app.post('/api/kpis', (req, res) => {
  const { business, metric, value, target } = req.body;
  if (!business || !metric || value === undefined) {
    return res.status(400).json({ error: 'business, metric, and value are required' });
  }
  const date = watToday();
  upsertKpi.run(date, business, metric, value, target ?? null);
  res.json(db.prepare('SELECT * FROM kpis WHERE date = ? AND business = ? AND metric = ?').get(date, business, metric));
});

// ── ideas ─────────────────────────────────────────────────────────────────────

app.get('/api/ideas', (_req, res) => {
  res.json(getIdeas.all());
});

app.post('/api/ideas', (req, res) => {
  const { business, content } = req.body;
  if (!business || !content) return res.status(400).json({ error: 'business and content are required' });
  const info = addIdea.run(business, content);
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

// ── notes ─────────────────────────────────────────────────────────────────────

app.get('/api/notes', (_req, res) => {
  res.json(getNotes.all());
});

app.post('/api/notes', (req, res) => {
  const { business, content } = req.body;
  if (!business || !content) return res.status(400).json({ error: 'business and content are required' });
  const info = addNote.run(business, content);
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

// ── analytics ─────────────────────────────────────────────────────────────────

app.get('/api/analytics/by-business', (req, res) => {
  const { month } = req.query; // YYYY-MM
  let rows;
  if (month) {
    rows = db.prepare(
      `SELECT business,
              COUNT(*)                                AS total,
              SUM(done)                               AS completed,
              ROUND(SUM(done) * 100.0 / COUNT(*), 1) AS rate
       FROM tasks WHERE date LIKE ?
       GROUP BY business ORDER BY business`
    ).all(`${month}-%`);
  } else {
    const since = watCutoff(30);
    rows = db.prepare(
      `SELECT business,
              COUNT(*)                                AS total,
              SUM(done)                               AS completed,
              ROUND(SUM(done) * 100.0 / COUNT(*), 1) AS rate
       FROM tasks WHERE date >= ?
       GROUP BY business ORDER BY business`
    ).all(since);
  }
  res.json(rows);
});

app.get('/api/analytics/missed', (_req, res) => {
  const today = watToday();
  const rows  = db.prepare(
    `SELECT name, business, COUNT(*) AS frequency
     FROM tasks
     WHERE done = 0
       AND date < ?
     GROUP BY name
     ORDER BY frequency DESC
     LIMIT 10`
  ).all(today);
  res.json(rows);
});

// ── scorecard ─────────────────────────────────────────────────────────────────

app.get('/api/scorecard/week', (_req, res) => {
  res.json({
    investorTouches: getInvestorTouchesThisWeek(),
    quarterlyPct:    getQuarterlyGoalPct(),
  });
});

// ── anchors ───────────────────────────────────────────────────────────────────

app.get('/api/anchors/today', (_req, res) => {
  res.json(getAnchorsForDate(watToday()));
});

app.patch('/api/anchors/:key/toggle', (req, res) => {
  const done = toggleAnchor(watToday(), req.params.key);
  if (done === null) return res.status(404).json({ error: 'Unknown anchor key' });
  res.json({ key: req.params.key, done });
});

// ── goals ─────────────────────────────────────────────────────────────────────

app.get('/api/goals', (_req, res) => {
  const goals = getAllGoals.all();
  for (const goal of goals) {
    goal.progress = getGoalProgress.all(goal.id).slice(0, 3);
  }
  res.json(goals);
});

app.get('/api/goals/:business', (req, res) => {
  const goals = getGoals.all(req.params.business);
  for (const goal of goals) {
    goal.progress = getGoalProgress.all(goal.id).slice(0, 3);
  }
  res.json(goals);
});

app.post('/api/goals', (req, res) => {
  const { business, dimension, title, description, target_date, year } = req.body;
  if (!business || !dimension || !title) {
    return res.status(400).json({ error: 'business, dimension, and title are required' });
  }
  if (!['growth', 'finance', 'operations'].includes(dimension)) {
    return res.status(400).json({ error: 'dimension must be growth, finance, or operations' });
  }
  addGoal.run(business, dimension, title, description || null, target_date || null, year || 2026);
  const goals = getAllGoals.all();
  for (const g of goals) g.progress = getGoalProgress.all(g.id).slice(0, 3);
  res.status(201).json(goals);
});

app.patch('/api/goals/:id', (req, res) => {
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  const info = updateGoalTitle.run(title, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  const goals = getAllGoals.all();
  for (const g of goals) g.progress = getGoalProgress.all(g.id).slice(0, 3);
  res.json(goals);
});

app.patch('/api/goals/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['active', 'achieved', 'paused'].includes(status)) {
    return res.status(400).json({ error: 'status must be active, achieved, or paused' });
  }
  const info = updateGoalStatus.run(status, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  const goals = getAllGoals.all();
  for (const g of goals) g.progress = getGoalProgress.all(g.id).slice(0, 3);
  res.json(goals);
});

app.post('/api/goals/:id/progress', (req, res) => {
  const { note } = req.body;
  if (!note) return res.status(400).json({ error: 'note is required' });
  addGoalProgress.run(req.params.id, note);
  res.json({ ok: true });
});

// ── monthly cycles ────────────────────────────────────────────────────────────

// must come before /api/cycles/:month to avoid routing conflict
app.get('/api/cycles/:month/summary', (req, res) => {
  const { month } = req.params;
  const cycles = getCycles.all(month);
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

app.get('/api/cycles/:month', (req, res) => {
  res.json(getCycles.all(req.params.month));
});

app.post('/api/cycles', (req, res) => {
  const { business, goal_id, month, title, commitment_1, commitment_2, commitment_3 } = req.body;
  if (!business || !month || !title || !commitment_1 || !commitment_2) {
    return res.status(400).json({ error: 'business, month, title, commitment_1, and commitment_2 are required' });
  }
  try {
    addCycle.run(business, goal_id || null, month, title, commitment_1, commitment_2, commitment_3 || null);
    res.status(201).json(getCycles.all(month));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Cycle already exists for this business/goal/month' });
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/cycles/:id/commitment', (req, res) => {
  const { which, status } = req.body;
  if (!['pending', 'done'].includes(status)) {
    return res.status(400).json({ error: 'status must be pending or done' });
  }
  try {
    const updated = updateCycleCommitment(req.params.id, which, status);
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/cycles/:id/reflection', (req, res) => {
  const { reflection } = req.body;
  if (!reflection) return res.status(400).json({ error: 'reflection is required' });
  const info = updateCycleReflection.run(reflection, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// ── schedule ──────────────────────────────────────────────────────────────────

app.get('/api/schedule', (_req, res) => {
  const row = getSetting.get('schedule_blocks');
  if (row) {
    try { return res.json(JSON.parse(row.value)); } catch { }
  }
  res.json(getFounderProfile().scheduleBlocks);
});

// ── founder profile ───────────────────────────────────────────────────────────

app.get('/api/profile', (_req, res) => {
  res.json(getFounderProfile());
});

app.patch('/api/profile', (req, res) => {
  res.json(saveFounderProfile(req.body || {}));
});

app.post('/api/schedule/order', (req, res) => {
  const { blocks } = req.body;
  if (!Array.isArray(blocks) || !blocks.length) {
    return res.status(400).json({ error: 'blocks array required' });
  }
  upsertSetting.run('schedule_blocks', JSON.stringify(blocks));
  res.json({ ok: true });
});

// ── Google OAuth ──────────────────────────────────────────────────────────────

app.get('/auth/google', (_req, res) => {
  try {
    res.redirect(gcal.getAuthUrl());
  } catch (err) {
    res.status(500).send('Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
  }
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    await gcal.exchangeCode(req.query.code);
    gcal.setupCalendarWatch(process.env.SERVER_URL).catch(err =>
      console.error('[calendar] watch setup after auth failed:', err.message)
    );
    // Sync today's existing tasks to Google Calendar
    const today = watToday();
    const tasks = getTasksByDate.all(today);
    let synced  = 0;
    for (const task of tasks) {
      if (!task.calendar_event_id) {
        try {
          await gcal.syncTaskToCalendar(task);
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

app.get('/api/calendar/status', (_req, res) => {
  const row = getSetting.get('google_tokens');
  res.json({ connected: !!row });
});

app.get('/api/calendar/today', async (_req, res) => {
  try { res.json(await gcal.getTodayEvents()); }
  catch (err) { res.status(err.message === 'Not authenticated' ? 401 : 500).json({ error: err.message }); }
});

app.get('/api/calendar/month/:year/:month', async (req, res) => {
  try {
    const events = await gcal.getEventsForMonth(
      parseInt(req.params.year, 10),
      parseInt(req.params.month, 10)
    );
    res.json(events);
  } catch (err) {
    res.status(err.message === 'Not authenticated' ? 401 : 500).json({ error: err.message });
  }
});

app.get('/api/calendar/calendars', async (_req, res) => {
  try { res.json(await gcal.listCalendars()); }
  catch (err) { res.status(err.message === 'Not authenticated' ? 401 : 500).json({ error: err.message }); }
});

app.post('/api/calendar/sync-task/:id', async (req, res) => {
  try {
    const task = getTaskById.get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const eventId = await gcal.syncTaskToCalendar(task);
    res.json({ ok: true, eventId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/calendar/sync-blocks', async (req, res) => {
  try {
    const row    = getSetting.get('schedule_blocks');
    const blocks = row ? JSON.parse(row.value) : [];
    const count  = await gcal.syncBlocksToCalendar(blocks);
    res.json({ ok: true, count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/calendar/events', async (req, res) => {
  try {
    const { title, date, startTime, endTime, description, calendarId } = req.body;
    if (!title || !date || !startTime || !endTime) {
      return res.status(400).json({ error: 'title, date, startTime, endTime required' });
    }
    const event = await gcal.createEvent(title, date, startTime, endTime, description, calendarId);
    res.json(event);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/calendar/events/:eventId', async (req, res) => {
  try {
    await gcal.deleteEvent(req.params.eventId, req.query.calendarId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── settings ──────────────────────────────────────────────────────────────────

app.get('/api/settings', (_req, res) => {
  const rows = db.prepare("SELECT key, value, updated_at FROM settings WHERE key != 'google_tokens'").all();
  const out  = {};
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  res.json(out);
});

app.patch('/api/settings/calendar', (req, res) => {
  const { calendarId } = req.body;
  if (!calendarId) return res.status(400).json({ error: 'calendarId required' });
  upsertSetting.run('google_calendar_id', calendarId);
  res.json({ ok: true });
});

app.delete('/api/settings/google', (req, res) => {
  deleteSetting.run('google_tokens');
  deleteSetting.run('google_calendar_id');
  deleteSetting.run('daywan_calendar_id');
  res.json({ ok: true });
});

app.patch('/api/settings/notifications', (req, res) => {
  const prefs = req.body;
  upsertSetting.run('notification_prefs', JSON.stringify(prefs));
  res.json({ ok: true });
});

// ── Google Calendar push webhook ──────────────────────────────────────────────

app.post('/api/calendar/webhook', (req, res) => {
  const token = req.headers['x-goog-channel-token'];
  if (token !== (process.env.GOOGLE_WEBHOOK_TOKEN || 'lifeline-secret')) {
    return res.sendStatus(403);
  }

  const state = req.headers['x-goog-resource-state'];
  res.sendStatus(200); // respond fast — Google requires < 2 s

  if (state === 'sync') {
    // Initial handshake — fetch events to get a sync token baseline
    gcal.getChangedEvents(null)
      .catch(err => console.error('[calendar] initial sync error:', err.message));
    return;
  }

  if (state === 'exists') {
    const tokenRow  = getSetting.get('google_sync_token');
    const syncToken = tokenRow ? tokenRow.value : null;
    gcal.getChangedEvents(syncToken)
      .then(events => Promise.all(events.map(e => gcal.processCalendarEvent(e))))
      .catch(err => console.error('[calendar] webhook processing error:', err.message));
  }
});

app.post('/api/calendar/sync-today', async (req, res) => {
  try {
    const today = watToday();
    const tasks = getTasksByDate.all(today).filter(t => !t.calendar_event_id);
    let synced  = 0;
    for (const task of tasks) {
      try {
        await gcal.syncTaskToCalendar(task);
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

app.post('/api/calendar/sync-week', async (req, res) => {
  try {
    const today = watToday();
    const from  = new Date(Date.now() + 60 * 60 * 1000 - 7 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const tasks = db.prepare(
      'SELECT * FROM tasks WHERE date >= ? AND date <= ? ORDER BY date, id'
    ).all(from, today).filter(t => !t.calendar_event_id);
    let synced = 0;
    for (const task of tasks) {
      try {
        await gcal.syncTaskToCalendar(task);
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

app.post('/api/calendar/sync-test', async (req, res) => {
  try {
    const now       = new Date(Date.now() + 60 * 60 * 1000);
    const today     = now.toISOString().slice(0, 10);
    const startH    = String(now.getUTCHours() + 1).padStart(2, '0');
    const startTime = `${startH}:00`;
    const endTime   = `${startH}:30`;
    const event = await gcal.createEvent(
      `${getFounderProfile().brandName} Sync Test`, today, startTime, endTime, 'Webhook sync test event'
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

app.post('/telegram-webhook', (req, res) => {
  res.sendStatus(200);
  handleUpdate(req.body).catch((err) => console.error('[telegram] update error:', err.message));
});

// ── health ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true }));

// ── startup ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

initBot();
initScheduler();

if (!POLLING && process.env.SERVER_URL) {
  registerWebhook(process.env.SERVER_URL).catch((err) =>
    console.error('[telegram] webhook registration failed:', err.message)
  );
}

app.listen(PORT, () => console.log(`[server] listening on port ${PORT}`));
