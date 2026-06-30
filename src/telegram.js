require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');
const {
  transcribeAudio, structureDump,
  generateMorningBriefing, generateEODReview,
  analyzeVoiceReport, suggestMonthlyCommitments, reviewGoalProgress,
  parseStrategicDocument, conversationalResponse,
} = require('./ai');
const { parseDocument, cleanDocumentText } = require('./document-parser');
const gcal = require('./google-calendar');
const {
  db, watToday, watTomorrow,
  getTasksByDate, getTaskById, insertTask, toggleTask, markTaskDone, updatePriority,
  carryTask, addIdea, getIdeas, addNote, getNotes, syncDayLog,
  upsertNudge, snoozeTask,
  getAllGoals, addGoal, updateGoalStatus,
  getCycles, getCyclesByGoal, addCycle, updateCycleCommitment,
  addGoalProgress, getGoalProgress,
  getSetting, saveDocumentAnalysis,
  saveUploadedDocument, getAllUploadedDocuments, linkDocumentToAnalysis, updateUploadedDocumentStatus,
  getPendingRecurring, confirmRecurring, confirmAllRecurring, rejectRecurring, rejectAllPendingRecurring,
} = require('./db');

// WAT datetime helpers (kept local — not needed in other modules)
function watNowDatetime() {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}
function watAfterMinutes(n) {
  return new Date(Date.now() + 60 * 60 * 1000 + n * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

const VALID_BUSINESSES = ['blok', 'aphl', 'trade', 'personal'];

const BIZ_LABEL = {
  blok:     'Blok AI',
  aphl:     'APHL Africa',
  trade:    'TradeSol',
  personal: 'Personal',
};

// chatId → array of tasks awaiting confirmation (YES/ADD to save, NO to discard)
const pendingTasks = new Map();

// chatId → { goal_id, suggested_title, commitments } — pending /suggest result for /newcycle
const pendingSuggestions = new Map();

// chatId → array of document-sourced tasks awaiting ADD/NO confirmation
const pendingDocTasks = new Map();

// chatId → { transcript, step } — voice note identified as strategic doc
const pendingVoiceDoc = new Map();

// chatId → { parsedText, wordCount, docId } — uploaded file awaiting business selection
const pendingDocument = new Map();

// chatId → { date, tasks } — pending recurring tasks awaiting confirmation
const pendingRecurring = new Map();

const TEMP_DIR = path.join(__dirname, '..', 'uploads', 'temp');
try { require('fs').mkdirSync(TEMP_DIR, { recursive: true }); } catch {}

let bot;

function getTodayTasks() {
  return getTasksByDate.all(watToday());
}

function saveTasks(structuredTasks) {
  const today = watToday();
  db.transaction((tasks) => {
    for (const t of tasks) {
      insertTask.run(today, t.name, t.business || 'personal', t.time || null, 'normal');
    }
  })(structuredTasks);
}

// ── formatting ────────────────────────────────────────────────────────────────

function getScheduleMap() {
  const row = getSetting.get('schedule_blocks');
  if (!row) return new Map();
  try {
    const blocks = JSON.parse(row.value);
    return new Map(blocks.map(b => [b.time, b.name]));
  } catch { return new Map(); }
}

function formatTaskList(tasks) {
  if (!tasks.length) return 'No tasks for today.';

  const schedMap = getScheduleMap();

  const sorted = [...tasks].sort((a, b) => {
    if (!a.time && !b.time) return 0;
    if (!a.time) return 1;
    if (!b.time) return -1;
    return a.time.localeCompare(b.time);
  });

  // Group consecutive tasks by time slot
  const groups = [];
  for (const t of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.time === (t.time || null)) {
      last.tasks.push(t);
    } else {
      groups.push({ time: t.time || null, tasks: [t] });
    }
  }

  let num = 1;
  const lines = [];
  for (const g of groups) {
    if (g.time) {
      const blockName = schedMap.get(g.time);
      const header = blockName
        ? `${blockName.split(':')[0].toUpperCase()} — ${g.time}`
        : g.time;
      lines.push('', header);
    } else {
      lines.push('', 'UNSCHEDULED');
    }
    for (const t of g.tasks) {
      const mark = t.source === 'recurring' ? '↻' : ' ';
      lines.push(`${num++}. [${t.done ? 'x' : mark}] ${t.name}`);
    }
  }

  return lines.join('\n').trimStart();
}

function fmtRate(tasks) {
  const total = tasks.length;
  const done  = tasks.filter(t => t.done).length;
  const rate  = total ? Math.round(done / total * 100) : 0;
  return `Today: ${done} of ${total} done (${rate}%)`;
}

// ── nudge digest ──────────────────────────────────────────────────────────────

function getActiveBlockName() {
  const row = getSetting.get('schedule_blocks');
  if (!row) return null;
  try {
    const blocks  = JSON.parse(row.value);
    const now     = new Date(Date.now() + 60 * 60 * 1000);
    const toMins  = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    const nowMins = now.getUTCHours() * 60 + now.getUTCMinutes();
    for (const b of blocks) {
      if (b.time && b.end && toMins(b.time) <= nowMins && nowMins < toMins(b.end)) {
        return b.name;
      }
    }
    return null;
  } catch { return null; }
}

function buildContext() {
  const today = watToday();
  const tasks = getTasksByDate.all(today);
  const done = tasks.filter(t => t.done);
  const pending = tasks.filter(t => !t.done);
  const rate = tasks.length > 0 ? Math.round((done.length / tasks.length) * 100) : 0;
  const activeBlock = getActiveBlockName();
  const now = new Date();
  const timeWAT = new Date(now.getTime() + 60 * 60 * 1000)
    .toISOString().slice(11, 16) + ' WAT';

  return {
    date: today,
    time: timeWAT,
    done: done.length,
    total: tasks.length,
    rate,
    activeBlock: activeBlock || 'No active block',
    pendingTasks: pending.slice(0, 5)
      .map(t => `[${t.business.toUpperCase()}] ${t.name}`)
      .join(', ') || 'None',
    recentCompleted: done.slice(-3)
      .map(t => t.name)
      .join(', ') || 'None yet',
  };
}

// overdue  — tasks from getPendingNudges (time already passed, not snoozed, nudge_count < 3)
// allTasks — full task list for the day (for upcoming + progress)
async function sendNudgeDigest(date, overdue, allTasks) {
  const now     = new Date(Date.now() + 60 * 60 * 1000);
  const toMins  = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const nowMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const nowHHMM =
    String(now.getUTCHours()).padStart(2, '0') + ':' +
    String(now.getUTCMinutes()).padStart(2, '0');

  // upcoming: not done, not anchor, scheduled in the next 60 minutes
  const upcoming = allTasks
    .filter(t => !t.done && t.time && t.business !== 'anchor')
    .filter(t => { const m = toMins(t.time); return m > nowMins && m <= nowMins + 60; })
    .sort((a, b) => a.time.localeCompare(b.time))
    .slice(0, 3);

  if (!overdue.length && !upcoming.length) return;

  const activeBlock = getActiveBlockName();
  const lines       = [`DAYWAN — ${nowHHMM} WAT`];
  if (activeBlock) lines.push(`Active block: ${activeBlock}`);

  if (overdue.length) {
    lines.push('', 'OVERDUE');
    for (const t of overdue) {
      lines.push(`[${t.business.toUpperCase()}] ${t.name} — due ${t.time}`);
    }
  }

  if (upcoming.length) {
    lines.push('', 'COMING UP NEXT');
    for (const t of upcoming) {
      lines.push(`[${t.business.toUpperCase()}] ${t.name} — due ${t.time}`);
    }
  }

  const total = allTasks.length;
  const done  = allTasks.filter(t => t.done).length;
  const pct   = total ? Math.round(done / total * 100) : 0;
  lines.push('', `Progress: ${done} of ${total} done (${pct}%)`);
  lines.push('', '/done <number> · /snooze <number> · /snoozeall');

  await sendMessage(lines.join('\n'));

  // Increment nudge_count for every overdue task included in the digest
  const nowDatetime = now.toISOString().replace('T', ' ').slice(0, 19);
  for (const t of overdue) {
    upsertNudge.run(t.id, date, (t.nudge_count || 0) + 1, nowDatetime);
  }
}

// ── exports ───────────────────────────────────────────────────────────────────

const POLLING = true; // set false for webhook/production

function initBot() {
  console.log('[telegram] initializing bot (polling=%s)', POLLING);

  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: POLLING });

  console.log('[telegram] bot instance created');

  if (POLLING) {
    bot.on('polling_error', (err) => {
      console.error('[telegram] polling error:', err.code, err.message);
    });

    bot.on('message', (msg) => {
      const from = msg.from?.username || msg.from?.first_name || msg.chat.id;
      const type = msg.voice ? 'voice' : msg.audio ? 'audio' : 'text';
      console.log('[telegram] message from %s | type=%s | text=%s',
        from, type, msg.text ? JSON.stringify(msg.text) : '—');
      handleUpdate({ message: msg }).catch((err) =>
        console.error('[telegram] handleUpdate error:', err.message)
      );
    });

    console.log('[telegram] polling started — listening for messages');
  }

  bot.on('error', (err) => {
    console.error('[telegram] bot error:', err.message);
  });

  return bot;
}

async function sendMessage(text) {
  return bot.sendMessage(process.env.TELEGRAM_CHAT_ID, text);
}

async function registerWebhook(serverUrl) {
  const url = `${serverUrl}/webhook`;
  await bot.setWebHook(url);
  console.log(`Webhook set: ${url}`);
}

// ── document helpers ──────────────────────────────────────────────────────────

function hasDocPrefix(text) {
  return /^(blok|aphl|trade|personal):\s*/i.test(text.trim());
}

function extractDocPrefix(text) {
  const match = text.trim().match(/^(blok|aphl|trade|personal):\s*/i);
  return { biz: match[1].toLowerCase(), docText: text.slice(match[0].length).trim() };
}

async function runDocAnalysis(biz, docText) {
  const goals   = getAllGoals.all();
  const tasks   = getTodayTasks();
  const analysis = await parseStrategicDocument(docText, biz, goals, tasks);
  saveDocumentAnalysis.run(
    biz, docText.slice(0, 200),
    analysis.summary, analysis.key_insight, analysis.risk,
    JSON.stringify(analysis.tasks)
  );
  return analysis;
}

function formatDocAnalysisReply(biz, analysis) {
  const taskLines = analysis.tasks.map((t, i) => {
    const pri = t.priority === 'high' ? '[HIGH]' : '[NORMAL]';
    return `${i + 1}. ${pri} ${t.name}\n   Why: ${t.rationale}`;
  }).join('\n');
  return (
    `DOCUMENT ANALYSIS — ${biz.toUpperCase()}\n\n` +
    `Summary:\n${analysis.summary}\n\n` +
    `Key insight:\n${analysis.key_insight}\n\n` +
    `Risk to watch:\n${analysis.risk}\n\n` +
    `TASKS FOR TODAY (${analysis.tasks.length}):\n${taskLines}\n\n` +
    'Reply ADD to add these to today, or NO to discard.'
  );
}

function saveDocumentTasks(tasks) {
  const today = watToday();
  const stmt  = db.prepare(
    `INSERT INTO tasks (date, name, business, time, done, priority, source)
     VALUES (?, ?, ?, ?, 0, ?, 'document')`
  );
  db.transaction((ts) => {
    for (const t of ts) stmt.run(today, t.name, t.business || 'blok', t.time || null, t.priority || 'normal');
  })(tasks);
  syncDayLog(today);
}

async function handleUpdate(update) {
  const chatId = String(process.env.TELEGRAM_CHAT_ID);
  const msg = update.message;
  if (!msg) return;
  if (String(msg.chat.id) !== chatId) return;

  try {
    const voice = msg.voice || msg.audio;
    const text  = msg.text || '';
    const upper = text.trim().toUpperCase();

    // ── pending voice doc flow (TASKS/DUMP, then business) ───────────────────
    if (pendingVoiceDoc.has(chatId) && !voice) {
      const state = pendingVoiceDoc.get(chatId);

      if (state.step === 'awaiting_format') {
        if (upper === 'TASKS') {
          pendingVoiceDoc.set(chatId, { ...state, step: 'awaiting_business' });
          await sendMessage('Which business? Reply blok, aphl, trade, or personal');
        } else if (upper === 'DUMP') {
          pendingVoiceDoc.delete(chatId);
          await handleDump(state.transcript);
        } else {
          pendingVoiceDoc.delete(chatId);
        }
        return;
      }

      if (state.step === 'awaiting_business') {
        const biz = text.trim().toLowerCase();
        if (!VALID_BUSINESSES.includes(biz)) {
          await sendMessage('Reply blok, aphl, trade, or personal');
          return;
        }
        pendingVoiceDoc.delete(chatId);
        await sendMessage(`Analyzing your ${BIZ_LABEL[biz] || biz} document…`);
        try {
          const analysis = await runDocAnalysis(biz, state.transcript);
          pendingDocTasks.set(chatId, analysis.tasks);
          await sendMessage(formatDocAnalysisReply(biz, analysis));
        } catch (err) {
          await sendMessage(`Analysis failed: ${err.message}`);
        }
        return;
      }
    }

    // ── pending document task confirmation (ADD/TOMORROW → save, NO → discard) ─
    if (pendingDocTasks.has(chatId) && !voice) {
      const tasks = pendingDocTasks.get(chatId);
      pendingDocTasks.delete(chatId);
      if (upper === 'ADD') {
        saveDocumentTasks(tasks);
        await sendMessage(`${tasks.length} task${tasks.length !== 1 ? 's' : ''} assigned to today.\n\n${formatTaskList(getTodayTasks())}`);
      } else if (upper === 'TOMORROW') {
        const today = watToday();
        const tomorrow = watTomorrow();
        const stmt = db.prepare(
          `INSERT INTO tasks (date, name, business, time, done, priority, source)
           VALUES (?, ?, ?, ?, 0, ?, 'document')`
        );
        db.transaction((ts) => {
          for (const t of ts) stmt.run(tomorrow, t.name, t.business || 'blok', t.time || null, t.priority || 'normal');
        })(tasks);
        syncDayLog(tomorrow);
        await sendMessage(`${tasks.length} task${tasks.length !== 1 ? 's' : ''} assigned to tomorrow.`);
      } else if (upper === 'NO') {
        await sendMessage('Discarded.');
      } else if (text.startsWith('/')) {
        await handleCommand(text);
      }
      return;
    }

    // ── pending document business selection ──────────────────────────────────
    if (pendingDocument.has(chatId) && !voice && !text.startsWith('/')) {
      const biz = text.trim().toLowerCase();
      if (!VALID_BUSINESSES.includes(biz)) {
        await sendMessage('Reply blok, aphl, trade, or personal');
        return;
      }
      const { parsedText, wordCount, filename } = pendingDocument.get(chatId);
      pendingDocument.delete(chatId);

      const docInfo = saveUploadedDocument.run(filename, filename, 'text', null, biz, parsedText);
      const docId   = docInfo.lastInsertRowid;
      updateUploadedDocumentStatus.run('parsed', docId);

      await sendMessage(`Document saved. Analyzing for ${BIZ_LABEL[biz] || biz}…`);
      try {
        const goals    = getAllGoals.all();
        const tasks    = getTodayTasks();
        const analysis = await parseStrategicDocument(parsedText, biz, goals, tasks);
        const anaInfo  = saveDocumentAnalysis.run(
          biz, parsedText.slice(0, 200),
          analysis.summary, analysis.key_insight, analysis.risk,
          JSON.stringify(analysis.tasks)
        );
        linkDocumentToAnalysis.run(anaInfo.lastInsertRowid, 'analyzed', docId);
        pendingDocTasks.set(chatId, analysis.tasks.map(t => ({ ...t, business: t.business || biz })));
        await sendMessage(formatDocAnalysisReply(biz, analysis));
      } catch (err) {
        await sendMessage(`Analysis failed: ${err.message}`);
      }
      return;
    }

    // ── pending recurring confirmation (CONFIRM ALL / CONFIRM N / SKIP / EDIT) ─
    if (pendingRecurring.has(chatId) && !voice && msg.text) {
      const { date, tasks } = pendingRecurring.get(chatId);

      if (upper === 'CONFIRM ALL') {
        pendingRecurring.delete(chatId);
        confirmAllRecurring(date);
        await sendMessage(`${tasks.length} recurring task${tasks.length !== 1 ? 's' : ''} added to today.`);
        return;
      }

      if (upper.startsWith('CONFIRM ')) {
        const nums = upper.slice(8).trim().split(/\s+/)
          .map(n => parseInt(n, 10))
          .filter(n => !isNaN(n) && n > 0 && n <= tasks.length);
        if (nums.length) {
          pendingRecurring.delete(chatId);
          for (const n of nums) confirmRecurring(tasks[n - 1].id);
          for (let i = 0; i < tasks.length; i++) {
            if (!nums.includes(i + 1)) rejectRecurring.run(tasks[i].id);
          }
          const skipped = tasks.length - nums.length;
          await sendMessage(`${nums.length} task${nums.length !== 1 ? 's' : ''} confirmed${skipped ? `, ${skipped} skipped` : ''}.`);
          return;
        }
      }

      if (upper === 'SKIP') {
        pendingRecurring.delete(chatId);
        rejectAllPendingRecurring.run(date);
        await sendMessage('Starting fresh today. Add tasks manually or via brain dump.');
        return;
      }

      if (upper === 'EDIT') {
        pendingRecurring.delete(chatId);
        rejectAllPendingRecurring.run(date);
        await sendMessage(
          'Send me the list of tasks you want today.\n' +
          'One per line, format:\n' +
          '[business] task name at HH:MM\n\n' +
          'Example:\n' +
          'aphl Get depot price at 06:30\n' +
          'blok Investor touchpoint at 07:30\n' +
          'personal Morning journal at 05:45'
        );
        return;
      }
      // Other text falls through to normal handlers below
    }

    // ── pending brain-dump task confirmation (YES/ADD → save, NO → discard) ──
    if (pendingTasks.has(chatId) && !voice) {
      const pending = pendingTasks.get(chatId);
      pendingTasks.delete(chatId);

      if (upper === 'YES' || upper === 'ADD') {
        saveTasks(pending);
        await sendMessage(`${pending.length} task${pending.length !== 1 ? 's' : ''} added.`);
      } else if (upper === 'NO') {
        await sendMessage('Discarded.');
      } else {
        if (text.startsWith('/')) {
          await handleCommand(text);
        } else if (text.length > 20) {
          await handleDump(text);
        }
      }
      return;
    }

    if (msg.document) {
      await handleDocumentFile(msg.document, chatId);
      return;
    }

    if (voice) {
      pendingTasks.delete(chatId);
      await handleVoice(voice, chatId);
    } else if (text.startsWith('/')) {
      await handleCommand(text);
    } else {
      const lowerText = text.toLowerCase();
      const wordCount = text.trim().split(/\s+/).filter(Boolean).length;

      // Document: >200 words with business prefix
      if (wordCount > 200 && hasDocPrefix(text)) {
        const { biz, docText } = extractDocPrefix(text);
        await sendMessage(`Analyzing your ${BIZ_LABEL[biz] || biz} document…`);
        try {
          const analysis = await runDocAnalysis(biz, docText);
          pendingDocTasks.set(chatId, analysis.tasks);
          await sendMessage(formatDocAnalysisReply(biz, analysis));
        } catch (err) {
          await sendMessage(`Analysis failed: ${err.message}`);
        }
        return;
      }

      // Brain dump: >150 words with task-like language
      const taskKeywords = /\b(need to|have to|must|should|plan to|going to|will|today I|this week)\b/i;
      if (wordCount > 150 && taskKeywords.test(text)) {
        await handleDump(text);
        return;
      }

      // Casual completion: short message mentioning done/finished/completed
      const isCompletion =
        (lowerText.includes('done') || lowerText.includes('finished') || lowerText.includes('completed')) &&
        wordCount < 20;
      if (isCompletion) {
        await handleCasualCompletion(text, chatId);
        return;
      }

      // Everything else: conversational
      const ctx = buildContext();
      const reply = await conversationalResponse(text, ctx);
      await sendMessage(reply);
    }
  } catch (err) {
    console.error('handleUpdate error:', err);
    await sendMessage(`Error: ${err.message}`);
  }
}

// ── casual completion handler ─────────────────────────────────────────────────

async function handleCasualCompletion(text, chatId) {
  const today = watToday();
  const pending = getTasksByDate.all(today).filter(t => !t.done);
  const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 3);
  const matched = pending.find(t =>
    words.some(w => t.name.toLowerCase().includes(w))
  );

  if (matched) {
    markTaskDone.run(matched.id);
    upsertNudge.run(matched.id, today, 99, watNowDatetime());
    syncDayLog(today);
    const ctx = buildContext();
    const reply = await conversationalResponse(
      `Just marked done: ${matched.name}`,
      ctx
    );
    await sendMessage(reply);
  } else {
    await sendMessage('Which task did you finish? Send the number (/done N) or tell me the name.');
  }
}

// ── command handlers ──────────────────────────────────────────────────────────

async function handleCommand(text) {
  const parts = text.split(' ');
  const cmd   = parts[0].toLowerCase().split('@')[0]; // strip @botname suffix Telegram appends
  const args  = parts.slice(1);

  switch (cmd) {
    case '/start': {
      await sendMessage(
        'DAYWAN commands:\n\n' +
        '/today — task list for today\n' +
        '/done <n> — toggle task done/undone\n' +
        '/add <business> <task> — add a task\n' +
        '/carry <n> — carry task to tomorrow\n' +
        '/priority <n> <high|normal|low> — set priority\n' +
        '/brief — morning briefing\n' +
        '/eod — end-of-day review\n' +
        '/rate — success rate\n' +
        '/week — completion by business (30 days)\n' +
        '/missed — top 5 most-missed tasks\n' +
        '/idea <business> <content> — save an idea\n' +
        '/ideas — last 5 ideas\n' +
        '/note <business> <content> — save a note\n' +
        '/notes — last 5 notes\n' +
        '/snooze <n> — snooze task for 30 mins\n' +
        '/snoozeall — snooze all pending tasks\n' +
        '/gcal — view today\'s calendar events\n' +
        '/calsync — sync pending tasks to Google Calendar\n\n' +
        'PM & INVESTOR RELATIONS:\n' +
        '/pm — daily PM check-in template\n' +
        '/pmweekly — weekly PM session agenda (Mon/Wed/Fri)\n' +
        '/investor — daily investor relationship prompt\n' +
        '/analyze — instructions for strategic document analysis\n' +
        '/docs — your uploaded document library\n' +
        'blok: [text] or aphl: [text] — analyze a business document\n' +
        'Send a PDF, Word, or text file to upload and analyze it.\n\n' +
        'GOALS & CYCLES:\n' +
        '/goals — view 2026 goals\n' +
        '/addgoal <biz> <dimension> <title> — add a goal\n' +
        '/cycle — this month\'s cycles\n' +
        '/commitdone <cycle_id> <1|2|3> — mark commitment done\n' +
        '/suggest <goal_id> — AI-suggest monthly commitments\n' +
        '/newcycle <goal_id> — create cycle from suggestion\n' +
        '/review <goal_id> — AI review of goal progress\n' +
        '/logprogress <goal_id> <note> — log progress note\n\n' +
        'PERSONAL:\n' +
        '/family — family time reminder\n\n' +
        'Businesses: blok, aphl, trade, personal\n' +
        'Send voice to report completions or dump new tasks.'
      );
      break;
    }

    case '/today': {
      await sendMessage(formatTaskList(getTodayTasks()));
      break;
    }

    case '/done': {
      const num   = parseInt(args[0], 10);
      const tasks = getTodayTasks();
      if (!num || num < 1 || num > tasks.length) {
        await sendMessage(`Give a number between 1 and ${tasks.length}.`);
        return;
      }
      const task        = tasks[num - 1];
      const newDoneState = task.done ? 0 : 1;
      toggleTask.run(newDoneState, task.id);
      if (newDoneState === 1) {
        // Suppress future nudges for this task today
        upsertNudge.run(task.id, watToday(), 99, watNowDatetime());
      }
      await sendMessage(formatTaskList(getTodayTasks()));
      break;
    }

    case '/add': {
      const business = (args[0] || '').toLowerCase();
      const name     = args.slice(1).join(' ').trim();
      if (!VALID_BUSINESSES.includes(business)) {
        await sendMessage(`Business must be one of: ${VALID_BUSINESSES.join(', ')}`);
        return;
      }
      if (!name) {
        await sendMessage('Usage: /add <business> <task name>');
        return;
      }
      insertTask.run(watToday(), name, business, null, 'normal');
      await sendMessage(formatTaskList(getTodayTasks()));
      break;
    }

    case '/carry': {
      const num   = parseInt(args[0], 10);
      const tasks = getTodayTasks();
      if (!num || num < 1 || num > tasks.length) {
        await sendMessage(`Give a number between 1 and ${tasks.length}.`);
        return;
      }
      const task = tasks[num - 1];
      carryTask(task.id, task.date, watTomorrow());
      await sendMessage(`Carried to tomorrow: ${task.name}`);
      break;
    }

    case '/priority': {
      const num   = parseInt(args[0], 10);
      const level = (args[1] || '').toLowerCase();
      const tasks = getTodayTasks();
      if (!num || num < 1 || num > tasks.length) {
        await sendMessage(`Give a task number between 1 and ${tasks.length}.`);
        return;
      }
      if (!['high', 'normal', 'low'].includes(level)) {
        await sendMessage('Priority must be high, normal, or low.');
        return;
      }
      const task = tasks[num - 1];
      updatePriority.run(level, task.id);
      await sendMessage(`Priority set: ${task.name} → ${level}`);
      break;
    }

    case '/snooze': {
      const num   = parseInt(args[0], 10);
      const tasks = getTodayTasks();
      if (!num || num < 1 || num > tasks.length) {
        await sendMessage(`Give a number between 1 and ${tasks.length}.`);
        return;
      }
      const task  = tasks[num - 1];
      const until = watAfterMinutes(30);
      snoozeTask.run(task.id, watToday(), until);
      await sendMessage(`Snoozed for 30 minutes: ${task.name}`);
      break;
    }

    case '/snoozeall': {
      const tasks = getTodayTasks().filter(t => !t.done && t.business !== 'anchor');
      if (!tasks.length) {
        await sendMessage('No pending tasks to snooze.');
        return;
      }
      const today = watToday();
      const until = watAfterMinutes(30);
      for (const task of tasks) snoozeTask.run(task.id, today, until);
      await sendMessage('All pending tasks snoozed for 30 minutes.');
      break;
    }

    case '/brief': {
      const tasks = getTodayTasks();
      if (!tasks.length) {
        await sendMessage('No tasks for today. Add some first.');
        return;
      }
      const briefing = await generateMorningBriefing(tasks, watToday());
      await sendMessage(briefing);
      break;
    }

    case '/eod': {
      const tasks = getTodayTasks();
      if (!tasks.length) {
        await sendMessage('No tasks recorded today.');
        return;
      }
      const review = await generateEODReview(tasks, watToday());
      await sendMessage(review);
      break;
    }

    case '/rate': {
      const tasks = getTodayTasks();
      if (!tasks.length) {
        await sendMessage('No tasks for today.');
        return;
      }
      await sendMessage(fmtRate(tasks));
      break;
    }

    case '/week': {
      const since = new Date(Date.now() + 60 * 60 * 1000 - 30 * 86400000).toISOString().slice(0, 10);
      const rows  = db.prepare(
        `SELECT business, COUNT(*) AS total, SUM(done) AS completed
         FROM tasks
         WHERE date >= ?
         GROUP BY business
         ORDER BY business`
      ).all(since);
      if (!rows.length) {
        await sendMessage('No data for the last 30 days.');
        return;
      }
      const lines = rows.map((r) => {
        const pct = r.total ? Math.round((r.completed / r.total) * 100) : 0;
        return `${BIZ_LABEL[r.business] || r.business}: ${r.completed}/${r.total} tasks (${pct}%)`;
      });
      await sendMessage(lines.join('\n'));
      break;
    }

    case '/missed': {
      const rows = db.prepare(
        `SELECT name, business, COUNT(*) AS frequency
         FROM tasks
         WHERE done = 0 AND date < ?
         GROUP BY name
         ORDER BY frequency DESC
         LIMIT 5`
      ).all(watToday());
      if (!rows.length) {
        await sendMessage('No missed tasks found.');
        return;
      }
      const list = rows.map((r, i) =>
        `${i + 1}. ${r.name} (${BIZ_LABEL[r.business] || r.business}) — missed ${r.frequency}×`
      ).join('\n');
      await sendMessage(list);
      break;
    }

    case '/idea': {
      let biz = (args[0] || '').toLowerCase();
      let content;
      if (VALID_BUSINESSES.includes(biz)) {
        content = args.slice(1).join(' ').trim();
      } else {
        biz     = 'blok';
        content = args.join(' ').trim();
      }
      if (!content) {
        await sendMessage('Usage: /idea <business> <content>');
        return;
      }
      addIdea.run(biz, content);
      await sendMessage(`Idea saved to ${BIZ_LABEL[biz]}`);
      break;
    }

    case '/ideas': {
      const ideas = getIdeas.all().slice(0, 5);
      if (!ideas.length) {
        await sendMessage('No ideas saved yet. Use /idea <business> <content>');
        return;
      }
      const list = ideas
        .map((idea, i) => `${i + 1}. [${idea.business.toUpperCase()}] ${idea.content}`)
        .join('\n');
      await sendMessage(`Your last 5 ideas:\n\n${list}`);
      break;
    }

    case '/note': {
      const biz     = (args[0] || '').toLowerCase();
      const content = args.slice(1).join(' ').trim();
      if (!VALID_BUSINESSES.includes(biz)) {
        await sendMessage(`Business must be one of: ${VALID_BUSINESSES.join(', ')}`);
        return;
      }
      if (!content) {
        await sendMessage('Usage: /note <business> <content>');
        return;
      }
      addNote.run(biz, content);
      await sendMessage(`Note saved to ${BIZ_LABEL[biz]}`);
      break;
    }

    case '/notes': {
      const notes = getNotes.all().slice(0, 5);
      if (!notes.length) {
        await sendMessage('No notes saved yet. Use /note <business> <content>');
        return;
      }
      const list = notes
        .map((note, i) => `${i + 1}. [${note.business.toUpperCase()}] ${note.content}`)
        .join('\n');
      await sendMessage(`Your last 5 notes:\n\n${list}`);
      break;
    }

    // ── GOALS & CYCLES ────────────────────────────────────────────────────────

    case '/goals': {
      const goals = getAllGoals.all();
      if (!goals.length) {
        await sendMessage('No goals set. Use /addgoal <biz> <growth|finance|operations> <title>');
        return;
      }

      const BIZ_ORDER = ['blok', 'aphl', 'trade', 'personal'];
      const grouped   = {};
      for (const g of goals) {
        if (!grouped[g.business]) grouped[g.business] = [];
        grouped[g.business].push(g);
      }

      const sections = BIZ_ORDER
        .filter(b => grouped[b])
        .map(b => {
          const header = `${BIZ_LABEL[b] || b.toUpperCase()}`;
          const rows   = grouped[b]
            .map(g => `${g.dimension.charAt(0).toUpperCase() + g.dimension.slice(1)}: ${g.title} (${g.status})`)
            .join('\n');
          return `${header}\n${rows}`;
        });

      await sendMessage(`YOUR 2026 GOALS\n\n${sections.join('\n\n')}`);
      break;
    }

    case '/addgoal': {
      const biz  = (args[0] || '').toLowerCase();
      const dim  = (args[1] || '').toLowerCase();
      const title = args.slice(2).join(' ').trim();

      const VALID_DIMS = ['growth', 'finance', 'operations'];
      if (!VALID_BUSINESSES.includes(biz)) {
        await sendMessage(`Business must be one of: ${VALID_BUSINESSES.join(', ')}`);
        return;
      }
      if (!VALID_DIMS.includes(dim)) {
        await sendMessage('Dimension must be growth, finance, or operations.');
        return;
      }
      if (!title) {
        await sendMessage('Usage: /addgoal <business> <dimension> <title>');
        return;
      }
      addGoal.run(biz, dim, title, null, null, 2026);
      await sendMessage(`Goal set for ${BIZ_LABEL[biz]} [${dim.charAt(0).toUpperCase() + dim.slice(1)}]: ${title}`);
      break;
    }

    case '/cycle': {
      const watNow   = new Date(Date.now() + 60 * 60 * 1000);
      const monthStr = watNow.toISOString().slice(0, 7);
      const monthLabel = watNow.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      const cycles   = getCycles.all(monthStr);

      if (!cycles.length) {
        await sendMessage(
          `No cycles set for ${monthLabel}.\n` +
          'Use /suggest <goal_id> to get AI-suggested commitments.'
        );
        return;
      }

      const sections = cycles.map(c => {
        const biz  = BIZ_LABEL[c.business] || c.business;
        const fmt  = (s, text) =>
          s === 'done' ? `[DONE] ${text}` : `[    ] ${text}`;

        let lines = [`${biz} — ${c.title}`];
        if (c.goal_title) lines.push(`Goal: ${c.goal_title}`);
        lines.push(`1. ${fmt(c.status_1, c.commitment_1)}`);
        lines.push(`2. ${fmt(c.status_2, c.commitment_2)}`);
        if (c.commitment_3) lines.push(`3. ${fmt(c.status_3, c.commitment_3)}`);
        lines.push(`(ID: ${c.id})`);
        return lines.join('\n');
      });

      await sendMessage(`${monthLabel.toUpperCase()} CYCLES\n\n${sections.join('\n\n')}`);
      break;
    }

    case '/commitdone': {
      const cycleId = parseInt(args[0], 10);
      const which   = parseInt(args[1], 10);
      if (!cycleId || ![1, 2, 3].includes(which)) {
        await sendMessage('Usage: /commitdone <cycle_id> <1|2|3>');
        return;
      }
      try {
        const updated = updateCycleCommitment(cycleId, which, 'done');
        if (!updated) { await sendMessage(`Cycle ${cycleId} not found.`); return; }
        const commitmentText = updated[`commitment_${which}`];
        await sendMessage(`Done: ${commitmentText}`);
      } catch (e) {
        await sendMessage(`Error: ${e.message}`);
      }
      break;
    }

    case '/suggest': {
      const goalId = parseInt(args[0], 10);
      if (!goalId) { await sendMessage('Usage: /suggest <goal_id>'); return; }
      const goal = getAllGoals.all().find(g => g.id === goalId);
      if (!goal) { await sendMessage(`Goal ${goalId} not found.`); return; }

      await sendMessage('Thinking…');
      const existingCycles = getCyclesByGoal.all(goalId);
      const suggestion     = await suggestMonthlyCommitments(goal, existingCycles);

      const chatId = String(process.env.TELEGRAM_CHAT_ID);
      pendingSuggestions.set(chatId, { goal_id: goalId, ...suggestion });

      const list = suggestion.commitments.map((c, i) => `${i + 1}. ${c}`).join('\n');
      await sendMessage(
        `Suggested focus: ${suggestion.suggested_title}\n\n${list}\n\n` +
        `Reply /newcycle ${goalId} to set this as your cycle for the month.`
      );
      break;
    }

    case '/newcycle': {
      const goalId = parseInt(args[0], 10);
      if (!goalId) { await sendMessage('Usage: /newcycle <goal_id>'); return; }
      const goal = getAllGoals.all().find(g => g.id === goalId);
      if (!goal) { await sendMessage(`Goal ${goalId} not found.`); return; }

      const chatId = String(process.env.TELEGRAM_CHAT_ID);
      let suggestion;
      const pending = pendingSuggestions.get(chatId);
      if (pending && pending.goal_id === goalId) {
        suggestion = pending;
        pendingSuggestions.delete(chatId);
      } else {
        await sendMessage('Generating suggestions…');
        const existingCycles = getCyclesByGoal.all(goalId);
        suggestion = await suggestMonthlyCommitments(goal, existingCycles);
      }

      const month = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 7);
      const { suggested_title, commitments } = suggestion;

      try {
        addCycle.run(
          goal.business, goalId, month, suggested_title,
          commitments[0], commitments[1], commitments[2] || null
        );
      } catch (e) {
        if (e.message.includes('UNIQUE')) {
          await sendMessage(`A cycle for ${goal.business} / goal ${goalId} already exists this month.`);
          return;
        }
        throw e;
      }

      const list = commitments.map((c, i) => `${i + 1}. ${c}`).join('\n');
      await sendMessage(`Cycle set for ${month}:\n${suggested_title}\n${list}`);
      break;
    }

    case '/review': {
      const goalId = parseInt(args[0], 10);
      if (!goalId) { await sendMessage('Usage: /review <goal_id>'); return; }
      const goal = getAllGoals.all().find(g => g.id === goalId);
      if (!goal) { await sendMessage(`Goal ${goalId} not found.`); return; }

      await sendMessage('Reviewing…');
      const cycles      = getCyclesByGoal.all(goalId);
      const progress    = getGoalProgress.all(goalId);
      const assessment  = await reviewGoalProgress(goal, cycles, progress);
      await sendMessage(assessment);
      break;
    }

    case '/logprogress': {
      const goalId = parseInt(args[0], 10);
      const note   = args.slice(1).join(' ').trim();
      if (!goalId || !note) {
        await sendMessage('Usage: /logprogress <goal_id> <note>');
        return;
      }
      const goal = getAllGoals.all().find(g => g.id === goalId);
      if (!goal) { await sendMessage(`Goal ${goalId} not found.`); return; }
      addGoalProgress.run(goalId, note);
      await sendMessage(`Progress logged for ${goal.title}`);
      break;
    }

    case '/pm': {
      const now    = new Date(Date.now() + 60 * 60 * 1000);
      const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const label  = `${days[now.getUTCDay()]}, ${now.getUTCDate()} ${months[now.getUTCMonth()]}`;
      await sendMessage(
        `PM DAILY CHECK-IN — ${label}\n\n` +
        `Send this to your PM:\n\n` +
        `Morning sync:\n` +
        `- What are you working on today?\n` +
        `- Any blockers I need to unblock?\n` +
        `- What needs my decision today?\n\n` +
        `Copy and adapt as needed.\n` +
        `Use /pmweekly for the weekly agenda template.`
      );
      break;
    }

    case '/pmweekly': {
      const dow = new Date(Date.now() + 60 * 60 * 1000).getUTCDay();
      if (dow === 1) {
        await sendMessage(
          `MONDAY — ROADMAP REVIEW AGENDA\n\n` +
          `1. Review last week output — what shipped, what did not\n` +
          `2. Set this week's top 3 priorities for the product\n` +
          `3. Align on any investor-related product questions\n` +
          `4. Confirm capacity and timeline for this week\n` +
          `5. Any team issues to resolve\n\n` +
          `Duration: 45 minutes max.`
        );
      } else if (dow === 3) {
        await sendMessage(
          `WEDNESDAY — MID-WEEK DECISION SYNC\n\n` +
          `1. What decisions are blocked waiting for me?\n` +
          `2. User feedback review — anything urgent?\n` +
          `3. Any scope changes needed?\n` +
          `4. Check on this week's priorities — on track?\n\n` +
          `Duration: 30 minutes max.`
        );
      } else if (dow === 5) {
        await sendMessage(
          `FRIDAY — SPRINT CLOSE REVIEW\n\n` +
          `1. What shipped this week?\n` +
          `2. What did not ship and why?\n` +
          `3. What carries to next week?\n` +
          `4. One thing that went well, one thing to improve\n` +
          `5. Set context for next week's Monday review\n\n` +
          `Duration: 30 minutes max.`
        );
      } else {
        await sendMessage(
          `Weekly PM sessions are Monday (roadmap), Wednesday (decisions), Friday (sprint close).\n` +
          `Daily check-in: /pm`
        );
      }
      break;
    }

    case '/analyze': {
      await sendMessage(
        `Send me a strategic document to break into daily tasks.\n\n` +
        `Paste your document as a text message — a business plan, investor memo, operations report, strategic note, or any business document.\n\n` +
        `Prefix with the business name:\n` +
        `blok: [paste document]\n` +
        `aphl: [paste document]\n\n` +
        `I will extract 2–3 specific daily tasks from it and tell you the key insight and risk.`
      );
      break;
    }

    case '/investor': {
      const dow = new Date(Date.now() + 60 * 60 * 1000).getUTCDay();
      const msgs = {
        1: `INVESTOR TOUCHPOINT — Monday\n\nToday's focus: Research\nPick one investor or fund to research deeply.\n\nQuestions to answer:\n- What is their investment thesis?\n- What companies have they backed that are similar to Blok AI?\n- What have they posted or written recently?\n- Who in your network knows them?\n- What would make them care about Blok AI specifically?\n\nGoal: Know them well enough to have a real conversation, not pitch them blindly.`,
        2: `INVESTOR TOUCHPOINT — Tuesday\n\nToday's focus: Warm intro mapping\n\nOpen your contact list. Who do you know who knows your target investors?\n\nQuestions to answer:\n- Who is one person who can introduce you to someone on your target list?\n- What do you need to send them to make the ask easy?\n- Have you kept this person warm recently?\n\nGoal: One intro request sent today to someone who can connect you.`,
        3: `INVESTOR TOUCHPOINT — Wednesday\n\nToday's focus: Deepen an existing relationship\n\nPick someone already in your pipeline. Not a cold contact. Someone you have spoken to before.\n\nOptions:\n- Share a product update or milestone\n- Send an article relevant to their thesis\n- Ask for their honest feedback on something specific\n- Check in genuinely with no pitch attached\n\nGoal: One meaningful interaction that moves the relationship forward.`,
        4: `INVESTOR TOUCHPOINT — Thursday\n\nToday's focus: Warm intro follow-up\n\nCheck your pending intro requests. Has anyone responded? Do you need to nudge a connector?\n\nAlso: Is there a founder in your network who has raised recently? They are often the best source of warm intros and honest advice.\n\nGoal: Move one intro request forward today.`,
        5: `INVESTOR TOUCHPOINT — Friday\n\nToday's focus: Week recap and pipeline update\n\nBefore you close the week:\n- Who did you connect with this week?\n- What conversations are warm?\n- What needs follow-up next week?\n- Did any relationship go cold that needs attention?\n\nUpdate your pipeline notes now while it is fresh.\nGoal: Clean, current pipeline going into the weekend.`,
      };
      const msg = msgs[dow] || `Investor relations rest day.\n\nWeekend is for recovery, not outreach. Relationships need breathing room.\n\nUse the time to think about who you want to build a relationship with next week.`;
      await sendMessage(msg);
      break;
    }

    case '/docs': {
      const docNum = parseInt(args[0], 10);
      const allDocs = getAllUploadedDocuments.all().slice(0, 5);
      if (docNum && docNum >= 1 && docNum <= allDocs.length) {
        const doc = allDocs[docNum - 1];
        if (!doc.parsed_text) {
          await sendMessage(`Document ${docNum} has no parsed text. Re-upload via the dashboard.`);
          return;
        }
        await sendMessage('Re-analyzing…');
        try {
          const goals    = getAllGoals.all();
          const tasks    = getTodayTasks();
          const analysis = await parseStrategicDocument(doc.parsed_text, doc.business || 'blok', goals, tasks);
          const biz      = doc.business || 'blok';
          const anaInfo  = saveDocumentAnalysis.run(
            biz, doc.parsed_text.slice(0, 200),
            analysis.summary, analysis.key_insight, analysis.risk,
            JSON.stringify(analysis.tasks)
          );
          linkDocumentToAnalysis.run(anaInfo.lastInsertRowid, 'analyzed', doc.id);
          pendingDocTasks.set(chatId, analysis.tasks.map(t => ({ ...t, business: t.business || biz })));
          await sendMessage(formatDocAnalysisReply(biz, analysis));
        } catch (err) {
          await sendMessage(`Analysis failed: ${err.message}`);
        }
        return;
      }
      if (!allDocs.length) {
        await sendMessage(
          'YOUR DOCUMENTS\n\nNo documents uploaded yet.\n\nSend any PDF, Word, or text file to analyze it.'
        );
        return;
      }
      const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const lines = allDocs.map((d, i) => {
        const date    = new Date(d.upload_date || '');
        const dateStr = isNaN(date) ? '—' : `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
        const status  = d.analysis_id ? 'analyzed' : 'uploaded';
        return `${i + 1}. [${(d.business || '—').toUpperCase()}] ${d.original_name} — ${status} — ${dateStr}`;
      });
      await sendMessage(
        `YOUR DOCUMENTS\n\n${lines.join('\n')}\n\n` +
        'Send any PDF, Word, or text file to analyze it.\n' +
        '/docs <number> to re-analyze a document.'
      );
      break;
    }

    case '/family': {
      const now     = new Date(Date.now() + 60 * 60 * 1000);
      const hourWAT = now.getUTCHours();
      if (hourWAT >= 17) {
        await sendMessage(
          `Family time block — 17:30\n\nWho are you calling today?\n\nThis is protected time.\nThe business can wait 30 minutes.`
        );
      } else {
        await sendMessage(
          `Family time is at 17:30 today.\nProtect it.`
        );
      }
      break;
    }

    case '/gcal': {
      let connected = false;
      try { gcal.getClient(); connected = true; } catch { }
      if (!connected) {
        await sendMessage(
          'Google Calendar not connected.\n' +
          'Open your dashboard and go to Settings to connect.'
        );
        return;
      }
      const events = await gcal.getTodayEvents();
      const now    = new Date(Date.now() + 60 * 60 * 1000);
      const dayLabel = now.toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
      });
      if (!events.length) {
        await sendMessage(`YOUR CALENDAR — ${dayLabel}\n\nNo events today.`);
        return;
      }
      const lines = [`YOUR CALENDAR — ${dayLabel}`, ''];
      for (const e of events) {
        lines.push(`${e.start} – ${e.end}  ${e.title}`);
      }
      lines.push('', `${events.length} event${events.length !== 1 ? 's' : ''} today.`);
      await sendMessage(lines.join('\n'));
      break;
    }

    case '/calsync': {
      const today = watToday();
      const tasks = getTodayTasks().filter(t => t.time && !t.done && t.business !== 'anchor');
      if (!tasks.length) {
        await sendMessage('No pending timed tasks to sync.');
        return;
      }
      let synced = 0;
      for (const t of tasks) {
        try { await gcal.syncTaskToCalendar(t); synced++; } catch { }
      }
      await sendMessage(`Synced ${synced} task${synced !== 1 ? 's' : ''} to Google Calendar.`);
      break;
    }

    default:
      break;
  }
}

// ── dump / voice handlers ─────────────────────────────────────────────────────

async function handleDump(text) {
  const structured = await structureDump(text);
  saveTasks(structured.tasks);
  const ctx = buildContext();
  const convMsg = `Brain dump processed. ${structured.tasks.length} tasks added — ${structured.tasks.map(t => t.name).join(', ')}. Focus: ${structured.focus}`;
  const reply = await conversationalResponse(convMsg, ctx);
  await sendMessage(reply);
}

async function handleVoice(voice, chatId) {
  const fileInfo = await bot.getFile(voice.file_id);
  const fileUrl  = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;

  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`Failed to download voice file: ${res.status}`);

  const mimeType    = voice.mime_type || 'audio/ogg';
  const audioBuffer = await res.buffer();

  const transcript  = await transcribeAudio(audioBuffer, mimeType);
  const wordCount   = transcript.split(/\s+/).filter(Boolean).length;

  // Long transcript — may be a strategic document or plan
  if (wordCount > 300) {
    pendingVoiceDoc.set(chatId, { transcript, step: 'awaiting_format' });
    await sendMessage(
      `This sounds like a strategic document or detailed plan.\n` +
      `How should I treat it?\n\n` +
      `Reply TASKS to extract 2–3 daily tasks\n` +
      `Reply DUMP to structure it as a brain dump`
    );
    return;
  }

  const tasks      = getTodayTasks();
  const analysis   = await analyzeVoiceReport(transcript, tasks);

  const { completed = [], new_tasks = [], summary = '', type = 'dump' } = analysis;

  // ── dump: show structured tasks and ask YES/NO ────────────────────────────
  if (type === 'dump') {
    if (!new_tasks.length) {
      const ctx = buildContext();
      const reply = await conversationalResponse(`Voice note received but no tasks were found in it: "${transcript}"`, ctx);
      await sendMessage(reply);
      return;
    }
    pendingTasks.set(chatId, new_tasks);
    const preview = new_tasks
      .map((t, i) => `${i + 1}. [${t.business || 'personal'}] ${t.name}${t.time ? ` — ${t.time}` : ''}`)
      .join('\n');
    const ctx = buildContext();
    const convMsg = `Voice brain dump captured ${new_tasks.length} tasks. Focus: ${summary}. Tasks: ${new_tasks.map(t => t.name).join(', ')}`;
    const intro = await conversationalResponse(convMsg, ctx);
    await sendMessage(`${intro}\n\nTasks captured:\n${preview}\n\nReply YES to add these, or NO to discard.`);
    return;
  }

  // ── completion / mixed: mark tasks done ───────────────────────────────────
  const today = watToday();

  if (completed.length) {
    db.transaction((ids) => {
      for (const id of ids) {
        const t = tasks.find(t => t.id === id);
        if (t && !t.done) markTaskDone.run(id);
      }
    })(completed);
    syncDayLog(today);
  }

  const updatedTasks   = getTodayTasks();
  const completedNames = tasks
    .filter(t => completed.includes(t.id))
    .map(t => t.name);

  const ctx = buildContext();
  let convMsg;
  if (completedNames.length) {
    convMsg = `Voice report processed. Just marked done: ${completedNames.join(', ')}. ${summary}`;
  } else {
    convMsg = `Voice note received: "${transcript}". ${summary}. No tasks matched for completion.`;
  }

  const reply = await conversationalResponse(convMsg, ctx);

  if (new_tasks.length) {
    const preview = new_tasks
      .map((t, i) => `${i + 1}. [${t.business || 'personal'}] ${t.name}${t.time ? ` — ${t.time}` : ''}`)
      .join('\n');
    pendingTasks.set(chatId, new_tasks);
    await sendMessage(
      `${reply}\n\nAlso captured ${new_tasks.length} new task${new_tasks.length !== 1 ? 's' : ''}:\n${preview}\n\nReply ADD to save or ignore.`
    );
  } else {
    await sendMessage(reply);
  }
}

async function handleDocumentFile(doc, chatId) {
  const ALLOWED_DOC_EXTS = new Set(['.pdf', '.docx', '.doc', '.txt', '.md']);
  const ext = path.extname(doc.file_name || '').toLowerCase();

  if (!ALLOWED_DOC_EXTS.has(ext)) {
    await sendMessage('Only PDF, Word, and text files are supported. Send a document file.');
    return;
  }
  if (doc.file_size && doc.file_size > 10 * 1024 * 1024) {
    await sendMessage('File too large. Maximum 10MB.');
    return;
  }

  await sendMessage(`Got your document: ${doc.file_name}\nDownloading and parsing…`);

  try {
    const fileInfo = await bot.getFile(doc.file_id);
    const fileUrl  = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
    const res      = await fetch(fileUrl);
    if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);

    const buf      = await res.buffer();
    const tmpPath  = path.join(TEMP_DIR, `${Date.now()}-${doc.file_name}`);
    fs.writeFileSync(tmpPath, buf);

    const mimeByExt = {
      '.pdf':  'application/pdf',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.doc':  'application/msword',
      '.txt':  'text/plain',
      '.md':   'text/plain',
    };
    const mimeType = mimeByExt[ext] || 'text/plain';
    const parsed   = await parseDocument(tmpPath, mimeType);
    const cleaned  = cleanDocumentText(parsed.text);
    const words    = cleaned.split(/\s+/).filter(Boolean).length;

    fs.unlink(tmpPath, () => {});

    pendingDocument.set(chatId, { parsedText: cleaned, wordCount: words, filename: doc.file_name });

    await sendMessage(
      `Parsed: ${words} words extracted.\n\n` +
      `Which business is this for?\n` +
      `Reply blok, aphl, trade, or personal`
    );
  } catch (err) {
    await sendMessage(`Failed to process document: ${err.message}`);
  }
}

// ── recurring task confirmation message ───────────────────────────────────────

async function sendRecurringConfirmation(date) {
  try {
    const pending = getPendingRecurring.all(date);
    if (!pending.length) return;

    const chatId = String(process.env.TELEGRAM_CHAT_ID);
    pendingRecurring.set(chatId, { date, tasks: pending });

    const lines = pending.map((t, i) =>
      `${i + 1}. [${t.business.toUpperCase()}] ${t.scheduled_time || '--'} ${t.name}`
    ).join('\n');

    await sendMessage(
      `DAILY ROUTINES — confirm for today\n\n` +
      `These recurring tasks are ready to add:\n\n` +
      `${lines}\n\n` +
      `Reply CONFIRM ALL to add everything\n` +
      `Reply CONFIRM 1 3 5 to add specific tasks by number\n` +
      `Reply SKIP to start fresh with no recurring tasks today\n` +
      `Reply EDIT to adjust before confirming`
    );
  } catch (err) {
    console.error('[telegram] sendRecurringConfirmation error:', err.message);
  }
}

module.exports = { initBot, handleUpdate, registerWebhook, sendMessage, sendNudgeDigest, POLLING, sendRecurringConfirmation };
