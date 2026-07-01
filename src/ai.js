require('dotenv').config();
const fetch = require('node-fetch');
const FormData = require('form-data');
const { getFounderProfile } = require('./db');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = 'claude-opus-4-8';

// ── founder-profile prompt helpers ───────────────────────────────────────────
// Every system prompt below used to have one founder's name, ventures, and
// team baked in as literal text. These helpers render that same context from
// whatever founder profile is active, so the prompts work for anyone using
// this app, not just the person it was originally written for.

function activeVentures(profile) {
  return profile.ventures.filter(v => v.status !== 'dormant');
}

function describeVentures(profile, ventures = profile.ventures) {
  return ventures.map(v => `- ${v.name}: ${v.description}`).join('\n');
}

function ventureBizList(profile) {
  return [...profile.ventures.map(v => v.slug), 'personal'].join('|');
}

async function claudeMessage(system, userContent, model = CLAUDE_MODEL) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.content[0].text;
}

async function transcribeAudio(audioBuffer, mimeType) {
  const ext = mimeType.split('/')[1] || 'webm';
  const form = new FormData();
  form.append('file', audioBuffer, { filename: `audio.${ext}`, contentType: mimeType });
  form.append('model', 'whisper-large-v3');

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      ...form.getHeaders(),
    },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.text;
}

async function structureDump(text) {
  const system = `You extract structured data from raw brain-dump notes about work plans.
Return ONLY valid JSON with this exact shape:
{
  "focus": "<one sentence describing the main focus for the day>",
  "tasks": [
    { "name": "<task name>", "business": "<business or project it belongs to>", "time": "<estimated duration or time slot, or null>" }
  ]
}
Do not include any explanation or markdown — only the raw JSON object.`;

  const reply = await claudeMessage(system, text);
  try {
    const match = reply.match(/\{[\s\S]*\}/);
    if (!match) return { focus: 'Could not parse the brain dump. Try again.', tasks: [] };
    return JSON.parse(match[0]);
  } catch {
    return { focus: 'Could not parse the brain dump. Try again.', tasks: [] };
  }
}

async function generateMorningBriefing(tasks, date) {
  const profile   = getFounderProfile();
  const brand     = profile.brandName;
  const ventures  = activeVentures(profile);
  const INVESTOR_FOCUS = profile.investorCadence;

  const ventureSections = ventures.map(v => {
    const skipNote = v.activeDays === 'weekdays' ? ' (weekdays only)' : '';
    const skipInstruction = v.activeDays === 'weekdays'
      ? ` — skip if weekend]`
      : `]`;
    const investorLines = v.investorFocus
      ? `\n[On weekdays, after listing tasks, add this line:]\nInvestor relations: one meaningful touchpoint today\n[Then the day-specific investor note provided in user content]`
      : '';
    return `${v.name.toUpperCase()}${skipNote}\n[List ${v.slug} recurring tasks sorted by time: HH:MM  task name${skipInstruction}${investorLines}`;
  }).join('\n\n');

  const system = `You are ${brand} — ${profile.name}'s morning briefing system — direct, no-nonsense, holds the standard.
Write a morning briefing in this exact format (plain text, no markdown, no emojis):

${brand} — Good morning
[Weekday, Date]

${profile.personalLabel}
[List personal recurring tasks sorted by time: HH:MM  task name]

${ventureSections}

${profile.closingLabel}
[List closing/evening anchor tasks sorted by time: HH:MM  task name — include the family call reminder]

X tasks total. Make today count.

[One hard, specific question the person must answer honestly before starting — no flattery, no softening]

Use exactly this structure. Replace placeholders with real data. No extra sections.`;

  const d       = new Date(date + 'T12:00:00Z');
  const DAYS    = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const weekday = DAYS[d.getUTCDay()];
  const isWeekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
  const investorNote = INVESTOR_FOCUS[d.getUTCDay()];

  const recurring = tasks.filter(t => t.source === 'recurring');
  const manual    = tasks.filter(t => t.source !== 'recurring');
  const fmtRec    = (t) => `${t.time || '—'}  ${t.name}`;
  const fmtManual = (t) => `${t.time || '—'}  ${t.name}`;

  const personalRec = recurring.filter(t => t.business === 'personal').sort((a,b) => (a.time||'').localeCompare(b.time||''));
  const totalCount  = tasks.length;

  const ventureTaskLists = ventures.map(v => {
    const rec = recurring.filter(t => t.business === v.slug).sort((a,b) => (a.time||'').localeCompare(b.time||''));
    const note = v.activeDays === 'weekdays' ? ' (none weekday only)' : '(none)';
    return `${v.name} recurring:\n${rec.map(fmtRec).join('\n') || note}`;
  }).join('\n\n');

  const userContent =
    `Date: ${weekday}, ${date}\n` +
    `Is weekend: ${isWeekend}\n` +
    `Investor focus for today: ${investorNote}\n\n` +
    `Personal recurring:\n${personalRec.map(fmtRec).join('\n') || '(none)'}\n\n` +
    `${ventureTaskLists}\n\n` +
    `Manual tasks today:\n${manual.map(fmtManual).join('\n') || '(none)'}\n\n` +
    `Total task count: ${totalCount}`;

  return claudeMessage(system, userContent);
}

async function generateEODReview(tasks, date) {
  const profile  = getFounderProfile();
  const brand    = profile.brandName;
  const ventures = activeVentures(profile);

  const pillarLines = (profile.personalPillars || [])
    .map(p => `${p}: [one sentence, direct — did they follow through today?]`)
    .join('\n');

  const ventureSections = ventures.map(v => {
    const focusNote = v.investorFocus
      ? ' Investor relationship building — did they have one genuine touchpoint? did they update their pipeline? product progress?'
      : '';
    return `${v.name.toUpperCase()}\n[2-3 sentences: what happened, what was missed, pattern to flag if any.${focusNote} Be direct.]`;
  }).join('\n\n');

  const system = `You are ${brand} — ${profile.name}'s end-of-day review system — direct, honest, unsparing. No flattery. No filler.
Write an end-of-day review in this structure (plain text, no markdown, no emojis):

${brand} — End of Day
[Date]

PERSONAL
${pillarLines}
${profile.nonNegotiables ? `Note: ${profile.nonNegotiables}` : ''}

${ventureSections}

THE DAY
[One sentence: did the day succeed or fall short? Name the single biggest reason]

TOMORROW
[One concrete instruction. No softening.]

Use exactly this structure. Be direct. Do not add extra sections or padding.`;

  const fmtTask = (t) => {
    const s = t.done ? '[done]' : '[MISSED]';
    return `${s} ${t.name} (${t.business})${t.time ? ` ${t.time}` : ''}`;
  };

  const recurring = tasks.filter(t => t.source === 'recurring');
  const manual    = tasks.filter(t => t.source !== 'recurring');

  const personalTasks = recurring.filter(t => t.business === 'personal');

  const ventureTaskBlocks = ventures.map(v => {
    const vTasks = recurring.filter(t => t.business === v.slug);
    return `${v.name} recurring:\n${vTasks.map(fmtTask).join('\n') || '(none)'}`;
  }).join('\n\n');

  const userContent =
    `Date: ${date}\n\n` +
    `Personal recurring:\n${personalTasks.map(fmtTask).join('\n') || '(none)'}\n\n` +
    `${ventureTaskBlocks}\n\n` +
    `Manual tasks:\n${manual.map(fmtTask).join('\n') || '(none)'}`;

  return claudeMessage(system, userContent);
}

async function analyzeVoiceReport(transcript, tasks) {
  const profile = getFounderProfile();
  const bizList = ventureBizList(profile);

  const system = `You are ${profile.brandName}, ${profile.name}'s day tracking system. ${profile.name} will send voice reports \
throughout the day describing what he has done, completed, or \
is working on. Your job is to match what he says to his current \
task list and identify which tasks are done.

Return JSON only in this format:
{
  "completed": [1, 3, 5],
  "new_tasks": [{"name":"task name","business":"${bizList}","time":""}],
  "summary": "one sentence plain English summary of what was reported",
  "type": "completion" | "dump" | "mixed"
}

completed: array of task IDs from the provided task list that \
match what was described as done. Be liberal in matching — \
if he mentions briefing or checking in with a team member, match it to \
any task about that. If he says "spoke to an investor" or "sent a message" \
match investor relationship building touchpoint tasks.

new_tasks: any new tasks mentioned that are not in the current list.

type:
  "completion" if he is mainly reporting what he did
  "dump" if he is mainly planning or brain dumping new tasks
  "mixed" if both

Return ONLY the JSON. No markdown.`;

  const taskList = tasks
    .map(t => `ID ${t.id}: [${t.business}] ${t.name} — ${t.done ? 'DONE' : 'PENDING'}`)
    .join('\n');

  const userContent =
    `Current tasks:\n${taskList}\n\nVoice report transcript:\n${transcript}`;

  const reply = await claudeMessage(system, userContent, 'claude-sonnet-4-6');
  try {
    const match = reply.match(/\{[\s\S]*\}/);
    if (!match) return { completed: [], new_tasks: [], summary: transcript, type: 'dump' };
    return JSON.parse(match[0]);
  } catch {
    return { completed: [], new_tasks: [], summary: transcript, type: 'dump' };
  }
}

async function suggestMonthlyCommitments(goal, existingCycles) {
  const profile = getFounderProfile();
  const currentMonth = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 7);
  const ventureSummary = profile.ventures
    .map(v => `${v.name} (${v.description})`)
    .join(', ');

  const system = `You are ${profile.name}'s strategic advisor. ${profile.name} runs ${ventureSummary}, and Personal (${(profile.personalPillars || []).join(', ')}). Be direct and specific. No filler.
Given a one-year goal and the history of past monthly cycles for that goal, suggest exactly 2 to 3 monthly commitments that move concretely toward the goal. Each commitment must be specific, measurable, and completable in one month.
Return JSON only:
{
  "suggested_title": "one phrase describing this month's focus",
  "commitments": ["commitment 1", "commitment 2", "commitment 3"]
}`;

  const userContent =
    `Goal: ${goal.dimension} — ${goal.title}\n` +
    `Business: ${goal.business}\n` +
    `Past cycles: ${JSON.stringify(existingCycles)}\n` +
    `Current month: ${currentMonth}\n` +
    `Suggest commitments for this month.`;

  const reply = await claudeMessage(system, userContent, 'claude-sonnet-4-6');
  try {
    const match = reply.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in response');
    return JSON.parse(match[0]);
  } catch (e) {
    throw new Error(`Could not parse monthly commitments: ${e.message}`);
  }
}

async function parseStrategicDocument(documentText, business, existingGoals, currentTasks) {
  const profile = getFounderProfile();
  const bizList = ventureBizList(profile).split('|').join(' or ');

  const system = `You are ${profile.name}'s strategic execution advisor.
${profile.name} is ${profile.identity}
${profile.name} runs:
${describeVentures(profile)}

${profile.name} has sent you a strategic business document.
Your job is to read it and extract ONLY 2 to 3 daily tasks that move the overall vision forward.

Rules:
- Tasks must be specific and completable in one day
- Tasks must connect directly to what the document describes
- Do not create generic tasks — be specific to the document content
- Prioritize tasks that unblock the most downstream work
- If the document describes a problem, the tasks should solve it
- If it describes a goal, the tasks should move toward it
- If it is a plan, the tasks should execute the next step

Also write:
- A one paragraph strategic summary of the document
- The single most important insight from the document
- One risk ${profile.name} should be aware of

Return JSON only:
{
  "summary": "one paragraph summary of the document",
  "key_insight": "the single most important thing from this document",
  "risk": "one risk to be aware of",
  "tasks": [
    {
      "name": "specific actionable task",
      "business": "${bizList}",
      "time": "suggested HH:MM or empty string",
      "priority": "high or normal",
      "rationale": "one sentence explaining why this task matters"
    }
  ]
}

Maximum 3 tasks. Minimum 2. No more, no less.
Return ONLY the JSON. No markdown. No explanation.`;

  const userContent =
    `Business context: ${business}\n\n` +
    `Current active goals:\n${JSON.stringify(existingGoals)}\n\n` +
    `Today's existing tasks (avoid duplicating these):\n${currentTasks.map(t => t.name).join(', ')}\n\n` +
    `Strategic document:\n${documentText}`;

  const reply = await claudeMessage(system, userContent, 'claude-sonnet-4-6');
  try {
    const match = reply.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in response');
    return JSON.parse(match[0]);
  } catch (e) {
    throw new Error(`Could not parse document analysis: ${e.message}`);
  }
}

async function reviewGoalProgress(goal, cycles, progressNotes) {
  const profile = getFounderProfile();
  const system = `You are ${profile.name}'s strategic advisor. Direct strategic review voice. No flattery.
Given a goal, all its monthly cycles, and progress notes, write a short honest assessment: what has moved, what has not, what needs to change. 3-5 sentences. Plain text.`;

  const userContent =
    `Goal: ${goal.dimension} — ${goal.title} (${goal.business})\n` +
    `Cycles: ${JSON.stringify(cycles)}\n` +
    `Progress notes: ${JSON.stringify(progressNotes)}`;

  return claudeMessage(system, userContent, 'claude-sonnet-4-6');
}

async function conversationalResponse(message, context) {
  const profile = getFounderProfile();
  const ventureLines = describeVentures(profile);
  const goalLines = (profile.currentGoals || []).map(g => `- ${g}`).join('\n');

  const system = `You are ${profile.brandName} — ${profile.name}'s personal accountability partner.
${profile.name} is ${profile.identity}
${profile.name} runs:
${ventureLines}
- Personal: ${(profile.personalPillars || []).join(', ')}

His current goals:
${goalLines}

Today's context:
Date: ${context.date}
Time: ${context.time}
Tasks done today: ${context.done} of ${context.total}
Success rate: ${context.rate}%
Active block: ${context.activeBlock}
Pending tasks: ${context.pendingTasks}
Recent completed: ${context.recentCompleted}

HOW TO RESPOND:
- Talk like a person, not a system
- Be direct and warm but never soft on accountability
- If he asks what he can do for you, tell him what matters RIGHT NOW based on the time and his pending tasks
- If he is behind on tasks, call it out gently but clearly
- If he has done well, acknowledge it briefly then push forward
- Never list tasks in a robotic numbered format unless he specifically asks for his task list
- Keep responses under 5 sentences unless he asks something that needs more
- Use his name ${profile.name} occasionally but not every message
- Never use emojis
- Never start with "Great!" or "Sure!" or "Of course!"
- If he seems off track, ask one sharp question
- If he is checking in, give him the one most important thing to focus on right now
- Sound like someone who has read his plan and genuinely cares whether he executes it

NEVER do these:
- Dump a full task list unless asked with /today
- Give generic motivational filler
- Start with a compliment
- Use bullet points or numbered lists in conversational replies
- Say "As your accountability partner..."
- Repeat back what he just said to you

Respond conversationally. One to four sentences max unless the question genuinely needs more.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        system,
        messages: [{ role: 'user', content: message }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    return data.content[0].text;
  } catch {
    return 'I ran into an issue processing that. Try again or use /today to see your tasks.';
  }
}

async function findTaskToDelete(message, tasks) {
  const system = `You match a user's natural language deletion request to a task in their list.
Return JSON only: {"task_id": 123, "task_name": "matched name"} or {"task_id": null} if no clear match.
Return ONLY the JSON. No markdown.`;

  const taskList = tasks
    .map(t => `ID ${t.id}: [${t.business}] ${t.name}${t.time ? ` — ${t.time}` : ''}`)
    .join('\n');

  const userContent = `Deletion request: "${message}"\n\nTask list:\n${taskList}`;

  try {
    const reply = await claudeMessage(system, userContent, 'claude-sonnet-4-6');
    const match = reply.match(/\{[\s\S]*\}/);
    if (!match) return { task_id: null };
    return JSON.parse(match[0]);
  } catch {
    return { task_id: null };
  }
}

module.exports = {
  transcribeAudio,
  structureDump,
  generateMorningBriefing,
  generateEODReview,
  analyzeVoiceReport,
  suggestMonthlyCommitments,
  reviewGoalProgress,
  parseStrategicDocument,
  conversationalResponse,
  findTaskToDelete,
};
