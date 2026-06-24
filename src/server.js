require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const {
  db, watToday, watTomorrow, watCutoff, weekStart,
  getTasksByDate, getTaskById, insertTask, toggleTask, markTaskDone, updatePriority, deleteTask,
  getHistory, getKpis, upsertKpi,
  getRecurring, getRecurringGrouped, addRecurring, deactivateRecurring, populateRecurring,
  carryTask, addIdea, getIdeas, addNote, getNotes, syncDayLog,
  getGoals, getAllGoals, addGoal, updateGoalStatus, updateGoalTitle,
  getCycles, getCyclesByGoal, getCycleById, addCycle, updateCycleCommitment, updateCycleReflection,
  addGoalProgress, getGoalProgress,
  getSetting, upsertSetting, deleteSetting,
} = require('./db');
const gcal = require('./google-calendar');

const DEFAULT_BLOCKS = [
  { time: '05:30', end: '05:45', name: 'Prayer',                                   biz: 'anchor'   },
  { time: '05:45', end: '06:00', name: 'Journaling',                               biz: 'anchor'   },
  { time: '06:00', end: '06:30', name: 'Orient and daily priority',                biz: 'blok'     },
  { time: '06:30', end: '07:00', name: 'Pre-day setup: depot price, brief Candy',  biz: 'aphl'     },
  { time: '07:00', end: '07:30', name: 'Morning command: floor price, driver call',biz: 'aphl'     },
  { time: '07:30', end: '09:00', name: 'Raise: 5 investor emails, CRM update',     biz: 'blok'     },
  { time: '08:00', end: '10:00', name: 'Sales push: Candy runs outbound',          biz: 'aphl'     },
  { time: '09:00', end: '10:30', name: 'Product: PM review, Arkad user flow',      biz: 'blok'     },
  { time: '10:00', end: '13:00', name: 'Operations: payments, loading, tracking',  biz: 'aphl'     },
  { time: '10:30', end: '11:30', name: 'Comms: Slack, async check-ins',            biz: 'blok'     },
  { time: '11:30', end: '12:30', name: 'Brand: creative review, social metrics',   biz: 'blok'     },
  { time: '13:00', end: '14:00', name: 'MD strategic hour: depot, pricing',        biz: 'aphl'     },
  { time: '14:00', end: '15:30', name: 'Strategy: priorities, decision log',       biz: 'blok'     },
  { time: '16:00', end: '17:30', name: 'Unified day close: ops sync, revenue log', biz: 'blok'     },
  { time: '17:30', end: '18:00', name: 'Calls to loved ones',                      biz: 'anchor'   },
  { time: '18:00', end: '19:00', name: 'Pottery or reading',                       biz: 'personal' },
  { time: '19:00', end: '20:00', name: 'Physical activity',                        biz: 'personal' },
  { time: '20:30', end: '21:00', name: 'Evening wind-down and next day planning',  biz: 'anchor'   },
];
const { structureDump, transcribeAudio } = require('./ai');
const { initBot, handleUpdate, registerWebhook, POLLING, sendMessage } = require('./telegram');
const { initScheduler } = require('./scheduler');

// Wire sendMessage into gcal so processCalendarEvent can notify via Telegram
gcal.setMessageSender(sendMessage);

// ── app setup ─────────────────────────────────────────────────────────────────

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── tasks ─────────────────────────────────────────────────────────────────────

app.get('/api/tasks', (req, res) => {
  const date = req.query.date || watToday();
  syncDayLog(date);
  res.json(getTasksByDate.all(date));
});

app.post('/api/tasks', (req, res) => {
  const { name, business, scheduled_time, priority } = req.body;
  if (!name || !business) return res.status(400).json({ error: 'name and business are required' });
  const info = insertTask.run(watToday(), name, business, scheduled_time || null, priority || 'normal');
  res.status(201).json(getTaskById.get(info.lastInsertRowid));
});

app.patch('/api/tasks/:id/toggle', (req, res) => {
  const task = getTaskById.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  toggleTask.run(task.done ? 0 : 1, task.id);
  res.json(getTaskById.get(task.id));
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

app.delete('/api/tasks/:id', (req, res) => {
  const info = deleteTask.run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
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
  const { name, business, scheduled_time, days, time_block } = req.body;
  if (!name || !business) return res.status(400).json({ error: 'name and business are required' });
  addRecurring.run(name, business, scheduled_time || null, days || 'daily', time_block || null);
  res.status(201).json(getRecurringGrouped());
});

app.delete('/api/recurring/:id', (req, res) => {
  const info = deactivateRecurring.run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json(getRecurring.all());
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

app.post('/api/brain-dump/voice', upload.single('audio'), async (req, res) => {
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
  db.transaction((list) => {
    for (const t of list) {
      insertTask.run(today, t.name, t.business || 'personal', t.time || null, t.priority || 'normal');
    }
  })(tasks);
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
  res.json(DEFAULT_BLOCKS);
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
    // Start push notifications immediately (no-op on localhost)
    gcal.setupCalendarWatch(process.env.SERVER_URL).catch(err =>
      console.error('[calendar] watch setup after auth failed:', err.message)
    );
    res.redirect('/?connected=google');
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
  if (token !== (process.env.GOOGLE_WEBHOOK_TOKEN || 'daywan-secret')) {
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

app.post('/api/calendar/sync-test', async (req, res) => {
  try {
    const now       = new Date(Date.now() + 60 * 60 * 1000);
    const today     = now.toISOString().slice(0, 10);
    const startH    = String(now.getUTCHours() + 1).padStart(2, '0');
    const startTime = `${startH}:00`;
    const endTime   = `${startH}:30`;
    const event = await gcal.createEvent(
      'DAYWAN Sync Test', today, startTime, endTime, 'Webhook sync test event'
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
