require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');
const {
  transcribeAudio, structureDump,
  generateMorningBriefing, generateEODReview,
  analyzeVoiceReport,
  parseStrategicDocument, conversationalResponse, findTaskToDelete,
} = require('./ai');
const { parseDocument, cleanDocumentText } = require('./document-parser');
const gcal = require('./google-calendar');
const {
  db, watToday, watTomorrow,
  getTasksByDate, getTaskById, insertTask, toggleTask, markTaskDone, updatePriority, deleteTask,
  carryTask, addIdea, getIdeas, addNote, getNotes, syncDayLog,
  upsertNudge, snoozeTask,
  getAllGoals,
  getSetting, saveDocumentAnalysis,
  saveUploadedDocument, getAllUploadedDocuments, linkDocumentToAnalysis, updateUploadedDocumentStatus,
  getPendingRecurring, confirmRecurring, confirmAllRecurring, rejectRecurring, rejectAllPendingRecurring,
  getBusinesses, getFounderProfile, logTaskInsert,
  getUserById, getUserByChatId, setUserChatId, getConnectToken, deleteConnectToken,
} = require('./db');

// WAT datetime helpers (kept local — not needed in other modules)
function watNowDatetime() {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}
function watAfterMinutes(n) {
  return new Date(Date.now() + 60 * 60 * 1000 + n * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

// Businesses/ventures are read live from the businesses table so adding or
// removing a venture in Settings updates bot behavior with no code change.
function getValidBusinesses(userId) {
  return getBusinesses(userId).map(b => b.slug);
}

function getBizLabel(userId, slug) {
  const biz = getBusinesses(userId).find(b => b.slug === slug);
  return biz ? biz.name : slug;
}

function getBrand(userId) {
  return getFounderProfile(userId).brandName || 'LIFELINE';
}

// All pending-state maps stay keyed by chatId (a String) — chat_id ↔ user_id
// is a stable 1:1 link once connected, so keying by either works; chatId is
// what's readily at hand at every one of these call sites.

// chatId → array of tasks awaiting confirmation (YES/ADD to save, NO to discard)
const pendingTasks = new Map();

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

function getTodayTasks(userId) {
  return getTasksByDate(userId, watToday());
}

function saveTasks(userId, structuredTasks) {
  const today = watToday();
  db.transaction((tasks) => {
    for (const t of tasks) {
      insertTask(userId, today, t.name, t.business || 'personal', t.time || null, 'normal');
      logTaskInsert('telegram-braindump', t.name, { date: today, business: t.business || 'personal', userId });
    }
  })(structuredTasks);
}

// ── formatting ────────────────────────────────────────────────────────────────

function getScheduleMap(userId) {
  const row = getSetting(userId, 'schedule_blocks');
  if (!row) return new Map();
  try {
    const blocks = JSON.parse(row.value);
    return new Map(blocks.map(b => [b.time, b.name]));
  } catch { return new Map(); }
}

function formatTaskList(userId, tasks) {
  if (!tasks.length) return 'No tasks for today.';

  const schedMap = getScheduleMap(userId);

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

function getActiveBlockName(userId) {
  const row = getSetting(userId, 'schedule_blocks');
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

async function handleBotError(userId, err, context) {
  console.error(`[telegram error] ${context}:`, err.message);
  const msg = err.message || '';
  let text;
  if (/401|authentication|invalid x-api-key/i.test(msg)) {
    text = 'My AI connection is down right now. Use /today to see your task list.';
  } else if (/JSON|parse/i.test(msg)) {
    text = 'I had trouble processing that. Try rephrasing or use /today for your task list.';
  } else if (/429|rate.?limit/i.test(msg)) {
    text = 'Too many requests right now. Wait 30 seconds and try again.';
  } else if (/500|overloaded/i.test(msg)) {
    text = 'The AI service is temporarily overloaded. Try again in a minute.';
  } else if (/ECONNREFUSED|network|fetch/i.test(msg)) {
    text = 'I could not reach the server right now. Check your connection and try again.';
  } else {
    text = 'Something went wrong. Try again or use /today.';
  }
  await sendMessage(userId, text);
}

function buildContext(userId) {
  const today = watToday();
  const tasks = getTasksByDate(userId, today);
  const done = tasks.filter(t => t.done);
  const pending = tasks.filter(t => !t.done);
  const rate = tasks.length > 0 ? Math.round((done.length / tasks.length) * 100) : 0;
  const activeBlock = getActiveBlockName(userId);
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
async function sendNudgeDigest(userId, date, overdue, allTasks) {
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

  const activeBlock = getActiveBlockName(userId);
  const lines       = [`${getBrand(userId)} — ${nowHHMM} WAT`];
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

  await sendMessage(userId, lines.join('\n'));

  // Increment nudge_count for every overdue task included in the digest
  const nowDatetime = now.toISOString().replace('T', ' ').slice(0, 19);
  for (const t of overdue) {
    upsertNudge(t.id, date, (t.nudge_count || 0) + 1, nowDatetime);
  }
}

// ── exports ───────────────────────────────────────────────────────────────────

const POLLING = true; // set false for webhook/production

function initBot() {
  console.log(`[telegram] initializing bot (polling=${POLLING}) pid=${process.pid} time=${new Date().toISOString()}`);

  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: POLLING });

  console.log(`[telegram] bot instance created pid=${process.pid}`);

  if (POLLING) {
    bot.on('polling_error', (err) => {
      console.error(`[telegram] polling error: code=${err.code} message=${err.message} pid=${process.pid}`);
      if (String(err.code).includes('409') || String(err.message).includes('409') || /conflict/i.test(err.message || '')) {
        console.error(`[telegram] *** 409 CONFLICT — another process is ALSO polling this bot token right now (pid=${process.pid} is one of at least two) ***`);
      }
    });

    bot.on('message', (msg) => {
      const from = msg.from?.username || msg.from?.first_name || msg.chat.id;
      const type = msg.voice ? 'voice' : msg.audio ? 'audio' : 'text';
      console.log('[telegram] message from %s | type=%s | text=%s | update_id=%s | pid=%s',
        from, type, msg.text ? JSON.stringify(msg.text) : '—', msg.message_id, process.pid);
      handleUpdate({ message: msg }).catch((err) =>
        console.error('[telegram] handleUpdate error:', err.message)
      );
    });

    console.log(`[telegram] polling started — listening for messages pid=${process.pid}`);
  }

  bot.on('error', (err) => {
    console.error('[telegram] bot error:', err.message);
  });

  return bot;
}

async function sendMessage(userId, text) {
  const user = getUserById.get(userId);
  if (!user || !user.telegram_chat_id) {
    console.warn(`[telegram] sendMessage skipped — user ${userId} has no linked telegram_chat_id`);
    return;
  }
  return bot.sendMessage(user.telegram_chat_id, text);
}

async function registerWebhook(serverUrl) {
  const url = `${serverUrl}/webhook`;
  await bot.setWebHook(url);
  console.log(`Webhook set: ${url}`);
}

// ── Telegram connect flow ─────────────────────────────────────────────────────
// The one path that has to work for a chat_id with NO linked user yet — that's
// the whole point of it. Handled ahead of the "resolve user or bail" gate in
// handleUpdate below.

async function handleStartCommand(text, chatId) {
  const token = text.split(' ')[1];
  const existingUser = getUserByChatId.get(chatId);

  if (!token) {
    if (existingUser) {
      await bot.sendMessage(chatId, `Welcome back to ${getBrand(existingUser.id)}. Send /today to see your tasks.`);
    } else {
      await bot.sendMessage(chatId,
        'Welcome to LIFELINE. To connect this chat to your account, open your dashboard → Settings → Connect Telegram, and tap the link it gives you.'
      );
    }
    return;
  }

  const tokenRow = getConnectToken.get(token);
  if (!tokenRow) {
    await bot.sendMessage(chatId, 'That connect link has expired or was already used. Generate a new one from Settings → Connect Telegram.');
    return;
  }

  try {
    setUserChatId.run(chatId, tokenRow.user_id);
  } catch (err) {
    // UNIQUE constraint on telegram_chat_id — this chat is already linked to
    // a different account.
    await bot.sendMessage(chatId, 'This Telegram chat is already connected to a different LIFELINE account.');
    return;
  }
  deleteConnectToken.run(token);
  const user = getUserById.get(tokenRow.user_id);
  await bot.sendMessage(chatId, `Connected! This chat is now linked to your ${getBrand(tokenRow.user_id)} account${user?.name ? `, ${user.name}` : ''}. Send /today to see your tasks.`);
  console.log(`[telegram] chat ${chatId} linked to user ${tokenRow.user_id} via connect token`);
}

// ── document helpers ──────────────────────────────────────────────────────────

function hasDocPrefix(userId, text) {
  const slugs = getValidBusinesses(userId).join('|');
  return new RegExp(`^(${slugs}):\\s*`, 'i').test(text.trim());
}

function extractDocPrefix(userId, text) {
  const slugs = getValidBusinesses(userId).join('|');
  const match = text.trim().match(new RegExp(`^(${slugs}):\\s*`, 'i'));
  return { biz: match[1].toLowerCase(), docText: text.slice(match[0].length).trim() };
}

async function runDocAnalysis(userId, biz, docText) {
  const goals   = getAllGoals(userId);
  const tasks   = getTodayTasks(userId);
  const analysis = await parseStrategicDocument(userId, docText, biz, goals, tasks);
  saveDocumentAnalysis(
    userId, biz, docText.slice(0, 200),
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

function saveDocumentTasks(userId, tasks) {
  const today = watToday();
  const stmt  = db.prepare(
    `INSERT INTO tasks (user_id, date, name, business, time, done, priority, source)
     VALUES (?, ?, ?, ?, ?, 0, ?, 'document')`
  );
  db.transaction((ts) => {
    for (const t of ts) stmt.run(userId, today, t.name, t.business || 'blok', t.time || null, t.priority || 'normal');
  })(tasks);
  syncDayLog(userId, today);
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg) return;
  const chatId = String(msg.chat.id);
  const text   = msg.text || '';

  if (text.startsWith('/start')) {
    await handleStartCommand(text, chatId);
    return;
  }

  const user = getUserByChatId.get(chatId);
  if (!user) {
    // Unrecognized chat — no linked account. Don't process arbitrary input
    // from an unlinked chat; point them at the connect flow instead.
    await bot.sendMessage(chatId,
      "This Telegram chat isn't connected to a LIFELINE account yet. Open your dashboard → Settings → Connect Telegram to link it."
    ).catch(() => {});
    return;
  }
  const userId = user.id;

  try {
    const voice = msg.voice || msg.audio;
    const upper = text.trim().toUpperCase();

    // ── pending voice doc flow (TASKS/DUMP, then business) ───────────────────
    if (pendingVoiceDoc.has(chatId) && !voice) {
      const state = pendingVoiceDoc.get(chatId);

      if (state.step === 'awaiting_format') {
        if (upper === 'TASKS') {
          pendingVoiceDoc.set(chatId, { ...state, step: 'awaiting_business' });
          await sendMessage(userId, `Which business? Reply ${getValidBusinesses(userId).join(', ')}`);
        } else if (upper === 'DUMP') {
          pendingVoiceDoc.delete(chatId);
          await handleDump(userId, state.transcript);
        } else {
          pendingVoiceDoc.delete(chatId);
        }
        return;
      }

      if (state.step === 'awaiting_business') {
        const biz = text.trim().toLowerCase();
        if (!getValidBusinesses(userId).includes(biz)) {
          await sendMessage(userId, `Reply ${getValidBusinesses(userId).join(', ')}`);
          return;
        }
        pendingVoiceDoc.delete(chatId);
        await sendMessage(userId, `Analyzing your ${getBizLabel(userId, biz)} document…`);
        try {
          const analysis = await runDocAnalysis(userId, biz, state.transcript);
          pendingDocTasks.set(chatId, analysis.tasks);
          await sendMessage(userId, formatDocAnalysisReply(biz, analysis));
        } catch (err) {
          await handleBotError(userId, err, 'voice document analysis');
        }
        return;
      }
    }

    // ── pending document task confirmation (ADD/TOMORROW → save, NO → discard) ─
    if (pendingDocTasks.has(chatId) && !voice) {
      const tasks = pendingDocTasks.get(chatId);
      pendingDocTasks.delete(chatId);
      if (upper === 'ADD') {
        saveDocumentTasks(userId, tasks);
        await sendMessage(userId, `${tasks.length} task${tasks.length !== 1 ? 's' : ''} assigned to today.\n\n${formatTaskList(userId, getTodayTasks(userId))}`);
      } else if (upper === 'TOMORROW') {
        const tomorrow = watTomorrow();
        const stmt = db.prepare(
          `INSERT INTO tasks (user_id, date, name, business, time, done, priority, source)
           VALUES (?, ?, ?, ?, ?, 0, ?, 'document')`
        );
        db.transaction((ts) => {
          for (const t of ts) stmt.run(userId, tomorrow, t.name, t.business || 'blok', t.time || null, t.priority || 'normal');
        })(tasks);
        syncDayLog(userId, tomorrow);
        await sendMessage(userId, `${tasks.length} task${tasks.length !== 1 ? 's' : ''} assigned to tomorrow.`);
      } else if (upper === 'NO') {
        await sendMessage(userId, 'Discarded.');
      } else if (text.startsWith('/')) {
        await handleCommand(userId, text, chatId);
      }
      return;
    }

    // ── pending document business selection ──────────────────────────────────
    if (pendingDocument.has(chatId) && !voice && !text.startsWith('/')) {
      const biz = text.trim().toLowerCase();
      if (!getValidBusinesses(userId).includes(biz)) {
        await sendMessage(userId, `Reply ${getValidBusinesses(userId).join(', ')}`);
        return;
      }
      const { parsedText, wordCount, filename } = pendingDocument.get(chatId);
      pendingDocument.delete(chatId);

      const docInfo = saveUploadedDocument(userId, filename, filename, 'text', null, biz, parsedText);
      const docId   = docInfo.lastInsertRowid;
      db.prepare('UPDATE uploaded_documents SET assigned_to = ? WHERE user_id = ? AND id = ?')
        .run(getFounderProfile(userId).name, userId, docId);
      updateUploadedDocumentStatus(userId, 'parsed', docId);

      await sendMessage(userId, `Document saved. Analyzing for ${getBizLabel(userId, biz)}…`);
      try {
        const goals    = getAllGoals(userId);
        const tasks    = getTodayTasks(userId);
        const analysis = await parseStrategicDocument(userId, parsedText, biz, goals, tasks);
        const anaInfo  = saveDocumentAnalysis(
          userId, biz, parsedText.slice(0, 200),
          analysis.summary, analysis.key_insight, analysis.risk,
          JSON.stringify(analysis.tasks)
        );
        linkDocumentToAnalysis(userId, anaInfo.lastInsertRowid, 'analyzed', docId);
        pendingDocTasks.set(chatId, analysis.tasks.map(t => ({ ...t, business: t.business || biz })));
        await sendMessage(userId, formatDocAnalysisReply(biz, analysis));
      } catch (err) {
        await handleBotError(userId, err, 'document analysis');
      }
      return;
    }

    // ── pending recurring confirmation (CONFIRM ALL / CONFIRM N / SKIP / EDIT) ─
    if (pendingRecurring.has(chatId) && !voice && msg.text) {
      const { date, tasks } = pendingRecurring.get(chatId);

      if (upper === 'CONFIRM ALL') {
        pendingRecurring.delete(chatId);
        confirmAllRecurring(userId, date);
        await sendMessage(userId, `${tasks.length} recurring task${tasks.length !== 1 ? 's' : ''} added to today.`);
        return;
      }

      if (upper.startsWith('CONFIRM ')) {
        const nums = upper.slice(8).trim().split(/\s+/)
          .map(n => parseInt(n, 10))
          .filter(n => !isNaN(n) && n > 0 && n <= tasks.length);
        if (nums.length) {
          pendingRecurring.delete(chatId);
          for (const n of nums) confirmRecurring(userId, tasks[n - 1].id);
          for (let i = 0; i < tasks.length; i++) {
            if (!nums.includes(i + 1)) rejectRecurring(userId, tasks[i].id);
          }
          const skipped = tasks.length - nums.length;
          await sendMessage(userId, `${nums.length} task${nums.length !== 1 ? 's' : ''} confirmed${skipped ? `, ${skipped} skipped` : ''}.`);
          return;
        }
      }

      if (upper === 'SKIP') {
        pendingRecurring.delete(chatId);
        rejectAllPendingRecurring(userId, date);
        await sendMessage(userId, 'Starting fresh today. Add tasks manually or via brain dump.');
        return;
      }

      if (upper === 'EDIT') {
        pendingRecurring.delete(chatId);
        rejectAllPendingRecurring(userId, date);
        await sendMessage(userId,
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
        saveTasks(userId, pending);
        await sendMessage(userId, `${pending.length} task${pending.length !== 1 ? 's' : ''} added.`);
      } else if (upper === 'NO') {
        await sendMessage(userId, 'Discarded.');
      } else {
        if (text.startsWith('/')) {
          await handleCommand(userId, text, chatId);
        } else if (text.length > 20) {
          await handleDump(userId, text);
        }
      }
      return;
    }

    if (msg.document) {
      await handleDocumentFile(userId, msg.document, chatId);
      return;
    }

    if (voice) {
      pendingTasks.delete(chatId);
      await handleVoice(userId, voice, chatId);
    } else if (text.startsWith('/')) {
      await handleCommand(userId, text, chatId);
    } else {
      const lowerText = text.toLowerCase();
      const wordCount = text.trim().split(/\s+/).filter(Boolean).length;

      // Document: >200 words with business prefix
      if (wordCount > 200 && hasDocPrefix(userId, text)) {
        const { biz, docText } = extractDocPrefix(userId, text);
        await sendMessage(userId, `Analyzing your ${getBizLabel(userId, biz)} document…`);
        try {
          const analysis = await runDocAnalysis(userId, biz, docText);
          pendingDocTasks.set(chatId, analysis.tasks);
          await sendMessage(userId, formatDocAnalysisReply(biz, analysis));
        } catch (err) {
          await handleBotError(userId, err, 'document analysis');
        }
        return;
      }

      // Brain dump: >150 words with task-like language
      const taskKeywords = /\b(need to|have to|must|should|plan to|going to|will|today I|this week)\b/i;
      if (wordCount > 150 && taskKeywords.test(text)) {
        await handleDump(userId, text);
        return;
      }

      // Casual completion: short message mentioning done/finished/completed
      const isCompletion =
        (lowerText.includes('done') || lowerText.includes('finished') || lowerText.includes('completed')) &&
        wordCount < 20;
      if (isCompletion) {
        await handleCasualCompletion(userId, text);
        return;
      }

      // Deletion intent
      const DELETION_KEYWORDS = [
        'remove', 'delete', 'cancel', 'drop', 'scratch', 'forget',
        'get rid of', "don't need", 'remove the', 'delete the', 'cancel the',
      ];
      if (DELETION_KEYWORDS.some(kw => lowerText.includes(kw))) {
        await handleDeletion(userId, text);
        return;
      }

      // Everything else: conversational
      const ctx = buildContext(userId);
      try {
        const reply = await conversationalResponse(userId, text, ctx);
        if (reply) {
          await sendMessage(userId, reply);
        } else {
          await sendMessage(userId, `Here is your list for today:\n\n${formatTaskList(userId, getTodayTasks(userId))}`);
        }
      } catch {
        await sendMessage(userId, `Here is your list for today:\n\n${formatTaskList(userId, getTodayTasks(userId))}`);
      }
    }
  } catch (err) {
    await handleBotError(userId, err, 'message handling');
  }
}

// ── natural language task deletion ───────────────────────────────────────────

async function handleDeletion(userId, text) {
  const today = watToday();
  const pending = getTasksByDate(userId, today).filter(t => !t.done);

  if (!pending.length) {
    await sendMessage(userId, 'No pending tasks to remove today.');
    return;
  }

  try {
    const result = await findTaskToDelete(text, pending);
    if (result.task_id) {
      const task = pending.find(t => t.id === result.task_id);
      const name = task ? task.name : result.task_name;
      deleteTask(userId, result.task_id);
      syncDayLog(userId, today);
      await sendMessage(userId, `Done — ${name} is off your list.`);
    } else {
      await sendMessage(userId, 'Which task do you want to remove? Send /today to see your numbered list, then reply with the name or number.');
    }
  } catch (err) {
    await handleBotError(userId, err, 'task deletion');
  }
}

// ── casual completion handler ─────────────────────────────────────────────────

async function handleCasualCompletion(userId, text) {
  const today = watToday();
  const pending = getTasksByDate(userId, today).filter(t => !t.done);
  const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 3);
  const matched = pending.find(t =>
    words.some(w => t.name.toLowerCase().includes(w))
  );

  if (matched) {
    markTaskDone(userId, matched.id);
    upsertNudge(matched.id, today, 99, watNowDatetime());
    syncDayLog(userId, today);
    try {
      const ctx = buildContext(userId);
      const reply = await conversationalResponse(userId, `Just marked done: ${matched.name}`, ctx);
      await sendMessage(userId, reply);
    } catch (err) {
      await handleBotError(userId, err, 'conversational response');
    }
  } else {
    await sendMessage(userId, 'Which task did you finish? Send the number (/done N) or tell me the name.');
  }
}

// ── command handlers ──────────────────────────────────────────────────────────

async function handleCommand(userId, text, chatId) {
  const parts  = text.split(' ');
  const cmd    = parts[0].toLowerCase().split('@')[0]; // strip @botname suffix Telegram appends
  const args   = parts.slice(1);

  switch (cmd) {
    case '/start': {
      // Handled earlier in handleUpdate for unlinked chats; a linked chat
      // sending /add with no token just gets the help text.
    }
    case '/help': {
      await sendMessage(userId,
        `${getBrand(userId)} commands:\n\n` +
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
        'PERSONAL:\n' +
        '/family — family time reminder\n\n' +
        'PLANNING:\n' +
        'Personal OKRs and venture Rocks live in the app — see the Planning section in the sidebar.\n' +
        'You\'ll get a message here at the start of each quarter to review and set new ones.\n\n' +
        `Businesses: ${getValidBusinesses(userId).join(', ')}\n` +
        'Send voice to report completions or dump new tasks.'
      );
      break;
    }

    case '/today': {
      await sendMessage(userId, formatTaskList(userId, getTodayTasks(userId)));
      break;
    }

    case '/done': {
      const num   = parseInt(args[0], 10);
      const tasks = getTodayTasks(userId);
      if (!num || num < 1 || num > tasks.length) {
        await sendMessage(userId, `Give a number between 1 and ${tasks.length}.`);
        return;
      }
      const task        = tasks[num - 1];
      const newDoneState = task.done ? 0 : 1;
      toggleTask(userId, newDoneState, task.id);
      if (newDoneState === 1) {
        // Suppress future nudges for this task today
        upsertNudge(task.id, watToday(), 99, watNowDatetime());
      }
      await sendMessage(userId, formatTaskList(userId, getTodayTasks(userId)));
      break;
    }

    case '/add': {
      const business = (args[0] || '').toLowerCase();
      const name     = args.slice(1).join(' ').trim();
      if (!getValidBusinesses(userId).includes(business)) {
        await sendMessage(userId, `Business must be one of: ${getValidBusinesses(userId).join(', ')}`);
        return;
      }
      if (!name) {
        await sendMessage(userId, 'Usage: /add <business> <task name>');
        return;
      }
      insertTask(userId, watToday(), name, business, null, 'normal');
      logTaskInsert('telegram-add-command', name, { date: watToday(), business, userId });
      await sendMessage(userId, formatTaskList(userId, getTodayTasks(userId)));
      break;
    }

    case '/carry': {
      const num   = parseInt(args[0], 10);
      const tasks = getTodayTasks(userId);
      if (!num || num < 1 || num > tasks.length) {
        await sendMessage(userId, `Give a number between 1 and ${tasks.length}.`);
        return;
      }
      const task = tasks[num - 1];
      carryTask(userId, task.id, task.date, watTomorrow());
      await sendMessage(userId, `Carried to tomorrow: ${task.name}`);
      break;
    }

    case '/priority': {
      const num   = parseInt(args[0], 10);
      const level = (args[1] || '').toLowerCase();
      const tasks = getTodayTasks(userId);
      if (!num || num < 1 || num > tasks.length) {
        await sendMessage(userId, `Give a task number between 1 and ${tasks.length}.`);
        return;
      }
      if (!['high', 'normal', 'low'].includes(level)) {
        await sendMessage(userId, 'Priority must be high, normal, or low.');
        return;
      }
      const task = tasks[num - 1];
      updatePriority(userId, level, task.id);
      await sendMessage(userId, `Priority set: ${task.name} → ${level}`);
      break;
    }

    case '/snooze': {
      const num   = parseInt(args[0], 10);
      const tasks = getTodayTasks(userId);
      if (!num || num < 1 || num > tasks.length) {
        await sendMessage(userId, `Give a number between 1 and ${tasks.length}.`);
        return;
      }
      const task  = tasks[num - 1];
      const until = watAfterMinutes(30);
      snoozeTask(task.id, watToday(), until);
      await sendMessage(userId, `Snoozed for 30 minutes: ${task.name}`);
      break;
    }

    case '/snoozeall': {
      const tasks = getTodayTasks(userId).filter(t => !t.done && t.business !== 'anchor');
      if (!tasks.length) {
        await sendMessage(userId, 'No pending tasks to snooze.');
        return;
      }
      const today = watToday();
      const until = watAfterMinutes(30);
      for (const task of tasks) snoozeTask(task.id, today, until);
      await sendMessage(userId, 'All pending tasks snoozed for 30 minutes.');
      break;
    }

    case '/brief': {
      const tasks = getTodayTasks(userId);
      if (!tasks.length) {
        await sendMessage(userId, 'No tasks for today. Add some first.');
        return;
      }
      try {
        const briefing = await generateMorningBriefing(userId, tasks, watToday());
        await sendMessage(userId, briefing);
      } catch (err) {
        await handleBotError(userId, err, 'morning briefing');
      }
      break;
    }

    case '/eod': {
      const tasks = getTodayTasks(userId);
      if (!tasks.length) {
        await sendMessage(userId, 'No tasks recorded today.');
        return;
      }
      try {
        const review = await generateEODReview(userId, tasks, watToday());
        await sendMessage(userId, review);
      } catch (err) {
        await handleBotError(userId, err, 'EOD review');
      }
      break;
    }

    case '/rate': {
      const tasks = getTodayTasks(userId);
      if (!tasks.length) {
        await sendMessage(userId, 'No tasks for today.');
        return;
      }
      await sendMessage(userId, fmtRate(tasks));
      break;
    }

    case '/week': {
      const since = new Date(Date.now() + 60 * 60 * 1000 - 30 * 86400000).toISOString().slice(0, 10);
      const rows  = db.prepare(
        `SELECT business, COUNT(*) AS total, SUM(done) AS completed
         FROM tasks
         WHERE user_id = ? AND date >= ?
         GROUP BY business
         ORDER BY business`
      ).all(userId, since);
      if (!rows.length) {
        await sendMessage(userId, 'No data for the last 30 days.');
        return;
      }
      const lines = rows.map((r) => {
        const pct = r.total ? Math.round((r.completed / r.total) * 100) : 0;
        return `${getBizLabel(userId, r.business)}: ${r.completed}/${r.total} tasks (${pct}%)`;
      });
      await sendMessage(userId, lines.join('\n'));
      break;
    }

    case '/missed': {
      const rows = db.prepare(
        `SELECT name, business, COUNT(*) AS frequency
         FROM tasks
         WHERE user_id = ? AND done = 0 AND date < ?
         GROUP BY name
         ORDER BY frequency DESC
         LIMIT 5`
      ).all(userId, watToday());
      if (!rows.length) {
        await sendMessage(userId, 'No missed tasks found.');
        return;
      }
      const list = rows.map((r, i) =>
        `${i + 1}. ${r.name} (${getBizLabel(userId, r.business)}) — missed ${r.frequency}×`
      ).join('\n');
      await sendMessage(userId, list);
      break;
    }

    case '/idea': {
      const valid = getValidBusinesses(userId);
      let biz = (args[0] || '').toLowerCase();
      let content;
      if (valid.includes(biz)) {
        content = args.slice(1).join(' ').trim();
      } else {
        biz     = valid[0] || 'personal';
        content = args.join(' ').trim();
      }
      if (!content) {
        await sendMessage(userId, 'Usage: /idea <business> <content>');
        return;
      }
      addIdea(userId, biz, content);
      await sendMessage(userId, `Idea saved to ${getBizLabel(userId, biz)}`);
      break;
    }

    case '/ideas': {
      const ideas = getIdeas(userId).slice(0, 5);
      if (!ideas.length) {
        await sendMessage(userId, 'No ideas saved yet. Use /idea <business> <content>');
        return;
      }
      const list = ideas
        .map((idea, i) => `${i + 1}. [${idea.business.toUpperCase()}] ${idea.content}`)
        .join('\n');
      await sendMessage(userId, `Your last 5 ideas:\n\n${list}`);
      break;
    }

    case '/note': {
      const biz     = (args[0] || '').toLowerCase();
      const content = args.slice(1).join(' ').trim();
      if (!getValidBusinesses(userId).includes(biz)) {
        await sendMessage(userId, `Business must be one of: ${getValidBusinesses(userId).join(', ')}`);
        return;
      }
      if (!content) {
        await sendMessage(userId, 'Usage: /note <business> <content>');
        return;
      }
      addNote(userId, biz, content);
      await sendMessage(userId, `Note saved to ${getBizLabel(userId, biz)}`);
      break;
    }

    case '/notes': {
      const notes = getNotes(userId).slice(0, 5);
      if (!notes.length) {
        await sendMessage(userId, 'No notes saved yet. Use /note <business> <content>');
        return;
      }
      const list = notes
        .map((note, i) => `${i + 1}. [${note.business.toUpperCase()}] ${note.content}`)
        .join('\n');
      await sendMessage(userId, `Your last 5 notes:\n\n${list}`);
      break;
    }

    case '/pm': {
      const now    = new Date(Date.now() + 60 * 60 * 1000);
      const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const label  = `${days[now.getUTCDay()]}, ${now.getUTCDate()} ${months[now.getUTCMonth()]}`;
      await sendMessage(userId,
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
        await sendMessage(userId,
          `MONDAY — ROADMAP REVIEW AGENDA\n\n` +
          `1. Review last week output — what shipped, what did not\n` +
          `2. Set this week's top 3 priorities for the product\n` +
          `3. Align on any investor-related product questions\n` +
          `4. Confirm capacity and timeline for this week\n` +
          `5. Any team issues to resolve\n\n` +
          `Duration: 45 minutes max.`
        );
      } else if (dow === 3) {
        await sendMessage(userId,
          `WEDNESDAY — MID-WEEK DECISION SYNC\n\n` +
          `1. What decisions are blocked waiting for me?\n` +
          `2. User feedback review — anything urgent?\n` +
          `3. Any scope changes needed?\n` +
          `4. Check on this week's priorities — on track?\n\n` +
          `Duration: 30 minutes max.`
        );
      } else if (dow === 5) {
        await sendMessage(userId,
          `FRIDAY — SPRINT CLOSE REVIEW\n\n` +
          `1. What shipped this week?\n` +
          `2. What did not ship and why?\n` +
          `3. What carries to next week?\n` +
          `4. One thing that went well, one thing to improve\n` +
          `5. Set context for next week's Monday review\n\n` +
          `Duration: 30 minutes max.`
        );
      } else {
        await sendMessage(userId,
          `Weekly PM sessions are Monday (roadmap), Wednesday (decisions), Friday (sprint close).\n` +
          `Daily check-in: /pm`
        );
      }
      break;
    }

    case '/analyze': {
      await sendMessage(userId,
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
      await sendMessage(userId, msg);
      break;
    }

    case '/docs': {
      const docNum = parseInt(args[0], 10);
      const allDocs = getAllUploadedDocuments(userId).slice(0, 5);
      if (docNum && docNum >= 1 && docNum <= allDocs.length) {
        const doc = allDocs[docNum - 1];
        if (!doc.parsed_text) {
          await sendMessage(userId, `Document ${docNum} has no parsed text. Re-upload via the dashboard.`);
          return;
        }
        await sendMessage(userId, 'Re-analyzing…');
        try {
          const goals    = getAllGoals(userId);
          const tasks    = getTodayTasks(userId);
          const analysis = await parseStrategicDocument(userId, doc.parsed_text, doc.business || 'blok', goals, tasks);
          const biz      = doc.business || 'blok';
          const anaInfo  = saveDocumentAnalysis(
            userId, biz, doc.parsed_text.slice(0, 200),
            analysis.summary, analysis.key_insight, analysis.risk,
            JSON.stringify(analysis.tasks)
          );
          linkDocumentToAnalysis(userId, anaInfo.lastInsertRowid, 'analyzed', doc.id);
          pendingDocTasks.set(chatId, analysis.tasks.map(t => ({ ...t, business: t.business || biz })));
          await sendMessage(userId, formatDocAnalysisReply(biz, analysis));
        } catch (err) {
          await handleBotError(userId, err, 'document re-analysis');
        }
        return;
      }
      if (!allDocs.length) {
        await sendMessage(userId,
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
      await sendMessage(userId,
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
        await sendMessage(userId,
          `Family time block — 17:30\n\nWho are you calling today?\n\nThis is protected time.\nThe business can wait 30 minutes.`
        );
      } else {
        await sendMessage(userId,
          `Family time is at 17:30 today.\nProtect it.`
        );
      }
      break;
    }

    case '/gcal': {
      let connected = false;
      try { gcal.getClient(userId); connected = true; } catch { }
      if (!connected) {
        await sendMessage(userId,
          'Google Calendar not connected.\n' +
          'Open your dashboard and go to Settings to connect.'
        );
        return;
      }
      const now      = new Date(Date.now() + 60 * 60 * 1000);
      const dayLabel = now.toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
      });

      let calEvents = [];
      try { calEvents = await gcal.getTodayEvents(userId); } catch { }

      const brand = getBrand(userId);
      const lifelineTasks = getTodayTasks(userId);
      const syncedEventIds = new Set(lifelineTasks.map(t => t.calendar_event_id).filter(Boolean));

      // Build merged list
      const items = [];

      // LIFELINE tasks
      for (const t of lifelineTasks) {
        if (t.business === 'anchor') continue;
        const tag = t.calendar_event_id ? '[SYNCED]' : `[${brand}]`;
        items.push({ time: t.time || '99:99', line: `${t.time || '--:--'}  ${t.name} ${tag}` });
      }

      // Calendar events not already represented as LIFELINE tasks
      for (const e of calEvents) {
        if (syncedEventIds.has(e.id)) continue;
        items.push({ time: e.start || '99:99', line: `${e.start || '--:--'}  ${e.title} [CALENDAR]` });
      }

      items.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0);

      const calCount      = calEvents.filter(e => !syncedEventIds.has(e.id)).length;
      const lifelineCount = lifelineTasks.filter(t => t.business !== 'anchor').length;

      const lines = [`TODAY — ${dayLabel}`, ''];
      if (!items.length) {
        lines.push('Nothing scheduled today.');
      } else {
        lines.push(...items.map(i => i.line));
      }
      lines.push('', `${calCount} calendar event${calCount !== 1 ? 's' : ''} · ${lifelineCount} ${brand} task${lifelineCount !== 1 ? 's' : ''}`);

      await sendMessage(userId, lines.join('\n'));
      break;
    }

    case '/calsync': {
      const unsynced = getTodayTasks(userId).filter(t => !t.calendar_event_id && t.business !== 'anchor');
      if (!unsynced.length) {
        await sendMessage(userId, 'All tasks are already synced to Google Calendar.');
        return;
      }
      await sendMessage(userId, `Syncing ${unsynced.length} task${unsynced.length !== 1 ? 's' : ''}...`);
      let synced = 0;
      for (const t of unsynced) {
        try { await gcal.syncTaskToCalendar(userId, t); synced++; } catch { }
      }
      await sendMessage(userId, `Synced ${synced} task${synced !== 1 ? 's' : ''} to Google Calendar.\nCheck your calendar.`);
      break;
    }

    default:
      break;
  }
}

// ── dump / voice handlers ─────────────────────────────────────────────────────

async function handleDump(userId, text) {
  const structured = await structureDump(text);
  saveTasks(userId, structured.tasks);

  if (!structured.tasks.length) {
    await sendMessage(userId, 'No tasks found in that. Try being more specific.');
    return;
  }

  const parts = structured.tasks.map(t => {
    const timeStr = t.time ? ` by ${t.time}` : '';
    return `${t.name}${timeStr}`;
  });

  const reply = parts.length === 1
    ? `Added — ${parts[0]}.`
    : `Added ${parts.length} tasks — ${parts.join(', ')}.`;

  await sendMessage(userId, reply);
}

async function handleVoice(userId, voice, chatId) {
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
    await sendMessage(userId,
      `This sounds like a strategic document or detailed plan.\n` +
      `How should I treat it?\n\n` +
      `Reply TASKS to extract 2–3 daily tasks\n` +
      `Reply DUMP to structure it as a brain dump`
    );
    return;
  }

  const tasks      = getTodayTasks(userId);
  const analysis   = await analyzeVoiceReport(userId, transcript, tasks);

  const { completed = [], new_tasks = [], summary = '', type = 'dump' } = analysis;

  // ── dump: show structured tasks and ask YES/NO ────────────────────────────
  if (type === 'dump') {
    if (!new_tasks.length) {
      const ctx = buildContext(userId);
      const reply = await conversationalResponse(userId, `Voice note received but no tasks were found in it: "${transcript}"`, ctx);
      await sendMessage(userId, reply);
      return;
    }
    pendingTasks.set(chatId, new_tasks);
    const preview = new_tasks
      .map((t, i) => `${i + 1}. [${t.business || 'personal'}] ${t.name}${t.time ? ` — ${t.time}` : ''}`)
      .join('\n');
    const ctx = buildContext(userId);
    const convMsg = `Voice brain dump captured ${new_tasks.length} tasks. Focus: ${summary}. Tasks: ${new_tasks.map(t => t.name).join(', ')}`;
    const intro = await conversationalResponse(userId, convMsg, ctx);
    await sendMessage(userId, `${intro}\n\nTasks captured:\n${preview}\n\nReply YES to add these, or NO to discard.`);
    return;
  }

  // ── completion / mixed: mark tasks done ───────────────────────────────────
  const today = watToday();

  if (completed.length) {
    db.transaction((ids) => {
      for (const id of ids) {
        const t = tasks.find(t => t.id === id);
        if (t && !t.done) markTaskDone(userId, id);
      }
    })(completed);
    syncDayLog(userId, today);
  }

  const completedNames = tasks
    .filter(t => completed.includes(t.id))
    .map(t => t.name);

  const ctx = buildContext(userId);
  let convMsg;
  if (completedNames.length) {
    convMsg = `Voice report processed. Just marked done: ${completedNames.join(', ')}. ${summary}`;
  } else {
    convMsg = `Voice note received: "${transcript}". ${summary}. No tasks matched for completion.`;
  }

  const reply = await conversationalResponse(userId, convMsg, ctx);

  if (new_tasks.length) {
    const preview = new_tasks
      .map((t, i) => `${i + 1}. [${t.business || 'personal'}] ${t.name}${t.time ? ` — ${t.time}` : ''}`)
      .join('\n');
    pendingTasks.set(chatId, new_tasks);
    await sendMessage(userId,
      `${reply}\n\nAlso captured ${new_tasks.length} new task${new_tasks.length !== 1 ? 's' : ''}:\n${preview}\n\nReply ADD to save or ignore.`
    );
  } else {
    await sendMessage(userId, reply);
  }
}

async function handleDocumentFile(userId, doc, chatId) {
  const ALLOWED_DOC_EXTS = new Set(['.pdf', '.docx', '.doc', '.txt', '.md']);
  const ext = path.extname(doc.file_name || '').toLowerCase();

  if (!ALLOWED_DOC_EXTS.has(ext)) {
    await sendMessage(userId, 'Only PDF, Word, and text files are supported. Send a document file.');
    return;
  }
  if (doc.file_size && doc.file_size > 10 * 1024 * 1024) {
    await sendMessage(userId, 'File too large. Maximum 10MB.');
    return;
  }

  await sendMessage(userId, `Got your document: ${doc.file_name}\nDownloading and parsing…`);

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

    await sendMessage(userId,
      `Parsed: ${words} words extracted.\n\n` +
      `Which business is this for?\n` +
      `Reply ${getValidBusinesses(userId).join(', ')}`
    );
  } catch (err) {
    await handleBotError(userId, err, 'document file processing');
  }
}

// ── recurring task confirmation message ───────────────────────────────────────

async function sendRecurringConfirmation(userId, date) {
  try {
    const pending = getPendingRecurring(userId, date);
    if (!pending.length) return;

    const user = getUserById.get(userId);
    if (!user || !user.telegram_chat_id) return;
    const chatId = String(user.telegram_chat_id);
    pendingRecurring.set(chatId, { date, tasks: pending });

    const lines = pending.map((t, i) =>
      `${i + 1}. [${t.business.toUpperCase()}] ${t.scheduled_time || '--'} ${t.name}`
    ).join('\n');

    await sendMessage(userId,
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
