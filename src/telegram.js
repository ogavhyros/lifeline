require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const {
  transcribeAudio, structureDump,
  generateMorningBriefing, generateEODReview,
  analyzeVoiceReport, suggestMonthlyCommitments, reviewGoalProgress,
} = require('./ai');
const {
  db, watToday, watTomorrow,
  getTasksByDate, getTaskById, insertTask, toggleTask, markTaskDone, updatePriority,
  carryTask, addIdea, getIdeas, addNote, getNotes, syncDayLog,
  upsertNudge, snoozeTask,
  getAllGoals, addGoal, updateGoalStatus,
  getCycles, getCyclesByGoal, addCycle, updateCycleCommitment,
  addGoalProgress, getGoalProgress,
  getSetting,
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

async function handleUpdate(update) {
  const chatId = String(process.env.TELEGRAM_CHAT_ID);
  const msg = update.message;
  if (!msg) return;
  if (String(msg.chat.id) !== chatId) return;

  try {
    const voice = msg.voice || msg.audio;
    const text  = msg.text || '';

    // ── pending confirmation (YES/ADD → save, NO → discard) ───────────────────
    if (pendingTasks.has(chatId) && !voice) {
      const upper   = text.trim().toUpperCase();
      const pending = pendingTasks.get(chatId);
      pendingTasks.delete(chatId);

      if (upper === 'YES' || upper === 'ADD') {
        saveTasks(pending);
        await sendMessage(`${pending.length} task${pending.length !== 1 ? 's' : ''} added.`);
      } else if (upper === 'NO') {
        await sendMessage('Discarded.');
      } else {
        // process as a new message
        if (text.startsWith('/')) {
          await handleCommand(text);
        } else if (text.length > 20) {
          await handleDump(text);
        }
      }
      return;
    }

    if (voice) {
      // clear any stale pending tasks before processing new voice note
      pendingTasks.delete(chatId);
      await handleVoice(voice, chatId);
    } else if (text.startsWith('/')) {
      await handleCommand(text);
    } else if (text.length > 20) {
      await handleDump(text);
    }
  } catch (err) {
    console.error('handleUpdate error:', err);
    await sendMessage(`Error: ${err.message}`);
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
        '/snoozeall — snooze all pending tasks\n\n' +
        'GOALS & CYCLES:\n' +
        '/goals — view 2026 goals\n' +
        '/addgoal <biz> <dimension> <title> — add a goal\n' +
        '/cycle — this month\'s cycles\n' +
        '/commitdone <cycle_id> <1|2|3> — mark commitment done\n' +
        '/suggest <goal_id> — AI-suggest monthly commitments\n' +
        '/newcycle <goal_id> — create cycle from suggestion\n' +
        '/review <goal_id> — AI review of goal progress\n' +
        '/logprogress <goal_id> <note> — log progress note\n\n' +
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

    default:
      break;
  }
}

// ── dump / voice handlers ─────────────────────────────────────────────────────

async function handleDump(text) {
  const structured = await structureDump(text);
  saveTasks(structured.tasks);
  const tasks = getTodayTasks();
  await sendMessage(`Focus: ${structured.focus}\n\n${formatTaskList(tasks)}`);
}

async function handleVoice(voice, chatId) {
  const fileInfo = await bot.getFile(voice.file_id);
  const fileUrl  = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;

  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`Failed to download voice file: ${res.status}`);

  const mimeType    = voice.mime_type || 'audio/ogg';
  const audioBuffer = await res.buffer();

  const transcript = await transcribeAudio(audioBuffer, mimeType);
  const tasks      = getTodayTasks();
  const analysis   = await analyzeVoiceReport(transcript, tasks);

  const { completed = [], new_tasks = [], summary = '', type = 'dump' } = analysis;

  // ── dump: show structured tasks and ask YES/NO ────────────────────────────
  if (type === 'dump') {
    if (!new_tasks.length) {
      await sendMessage(`Transcript: "${transcript}"\n\nNo tasks found.`);
      return;
    }
    pendingTasks.set(chatId, new_tasks);
    const preview = new_tasks
      .map((t, i) => `${i + 1}. [${t.business || 'personal'}] ${t.name}${t.time ? ` — ${t.time}` : ''}`)
      .join('\n');
    await sendMessage(
      `Transcript: "${transcript}"\n\nFocus: ${summary}\n\nTasks:\n${preview}\n\n` +
      'Reply YES to add these tasks, or NO to discard.'
    );
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
    .map(t => `— ${t.name}`);

  let reply;
  if (completedNames.length) {
    reply =
      `✓ Updated\n\nCompleted:\n${completedNames.join('\n')}\n\n` +
      `${summary}\n\n${fmtRate(updatedTasks)}`;
  } else {
    reply = `Transcript: "${transcript}"\n\n${summary}`;
  }

  if (new_tasks.length) {
    const preview = new_tasks
      .map((t, i) => `${i + 1}. [${t.business || 'personal'}] ${t.name}${t.time ? ` — ${t.time}` : ''}`)
      .join('\n');
    reply +=
      `\n\nAlso noted ${new_tasks.length} new task${new_tasks.length !== 1 ? 's' : ''} — ` +
      `reply ADD to save them or ignore.\n${preview}`;
    pendingTasks.set(chatId, new_tasks);
  }

  await sendMessage(reply);
}

module.exports = { initBot, handleUpdate, registerWebhook, sendMessage, POLLING };
