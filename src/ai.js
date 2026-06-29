require('dotenv').config();
const fetch = require('node-fetch');
const FormData = require('form-data');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = 'claude-opus-4-8';

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

  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude did not return valid JSON');
  return JSON.parse(match[0]);
}

async function generateMorningBriefing(tasks, date) {
  const INVESTOR_FOCUS = [
    'Monday: Research a new target investor today — know their thesis before you reach out.',
    'Tuesday: Find one warm intro path — who in your network can connect you to a target?',
    'Wednesday: Research an investor deeply — portfolio, thesis, recent posts, mutual connections.',
    'Thursday: Identify another warm intro path and send the ask today.',
    'Friday: Follow up on this week\'s conversations — update your pipeline while it\'s fresh.',
    'Saturday: Rest from investor work. Relationships need breathing room.',
    'Sunday: Rest from investor work. Relationships need breathing room.',
  ];

  const system = `You are Arkad — direct, no-nonsense, holds people to hard standards.
Write a morning briefing in this exact format (plain text, no markdown, no emojis):

DAYWAN — Good morning
[Weekday, Date]

TAKE CARE OF YOURSELF FIRST
[List personal recurring tasks sorted by time: HH:MM  task name]

APHL AFRICA
[List aphl recurring tasks sorted by time: HH:MM  task name]

BLOK AI (weekdays only)
[List blok recurring tasks sorted by time: HH:MM  task name — skip if weekend]
[On weekdays, after listing Blok tasks, add this line:]
Investor relations: one meaningful touchpoint today
[Then the day-specific investor note provided in user content]

CLOSE THE DAY WELL
17:30  Calls to loved ones and family — call someone today
19:00  Physical training
20:30  Evening gratitude, plan tomorrow

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
  const aphlRec     = recurring.filter(t => t.business === 'aphl').sort((a,b) => (a.time||'').localeCompare(b.time||''));
  const blokRec     = recurring.filter(t => t.business === 'blok').sort((a,b) => (a.time||'').localeCompare(b.time||''));
  const totalCount  = tasks.length;

  const userContent =
    `Date: ${weekday}, ${date}\n` +
    `Is weekend: ${isWeekend}\n` +
    `Investor focus for today: ${investorNote}\n\n` +
    `Personal recurring:\n${personalRec.map(fmtRec).join('\n') || '(none)'}\n\n` +
    `APHL recurring:\n${aphlRec.map(fmtRec).join('\n') || '(none)'}\n\n` +
    `Blok AI recurring:\n${blokRec.map(fmtRec).join('\n') || '(none weekday only)'}\n\n` +
    `Manual tasks today:\n${manual.map(fmtManual).join('\n') || '(none)'}\n\n` +
    `Total task count: ${totalCount}`;

  return claudeMessage(system, userContent);
}

async function generateEODReview(tasks, date) {
  const system = `You are Arkad — direct, honest, unsparing. No flattery. No filler.
Write an end-of-day review in this structure (plain text, no markdown, no emojis):

DAYWAN — End of Day
[Date]

PERSONAL
Spiritual: [did they pray and reflect? one sentence, direct]
Mental: [did they journal and check in? one sentence]
Physical: [did they train and read? one sentence]
Grooming: [did they maintain their routine? one sentence]
Family: [did they call a family member today? name it directly if skipped — this is non-negotiable]

APHL AFRICA
[2-3 sentences: what ops happened, what was missed, pattern to flag if any]

BLOK AI
[2-3 sentences: investor relationship building — did they have one genuine touchpoint? did they update their pipeline? product progress? be direct]

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
  const aphlTasks     = recurring.filter(t => t.business === 'aphl');
  const blokTasks     = recurring.filter(t => t.business === 'blok');

  const userContent =
    `Date: ${date}\n\n` +
    `Personal recurring:\n${personalTasks.map(fmtTask).join('\n') || '(none)'}\n\n` +
    `APHL recurring:\n${aphlTasks.map(fmtTask).join('\n') || '(none)'}\n\n` +
    `Blok AI recurring:\n${blokTasks.map(fmtTask).join('\n') || '(none)'}\n\n` +
    `Manual tasks:\n${manual.map(fmtTask).join('\n') || '(none)'}`;

  return claudeMessage(system, userContent);
}

async function analyzeVoiceReport(transcript, tasks) {
  const system = `You are OGV's day tracking system. OGV will send voice reports \
throughout the day describing what he has done, completed, or \
is working on. Your job is to match what he says to his current \
task list and identify which tasks are done.

Return JSON only in this format:
{
  "completed": [1, 3, 5],
  "new_tasks": [{"name":"task name","business":"blok|aphl|trade|personal","time":""}],
  "summary": "one sentence plain English summary of what was reported",
  "type": "completion" | "dump" | "mixed"
}

completed: array of task IDs from the provided task list that \
match what was described as done. Be liberal in matching — \
if he says "I called Candy" match it to any task about briefing \
or calling Candy. If he says "spoke to an investor" or "sent a message" \
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
  const match  = reply.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude did not return valid JSON for voice report');
  return JSON.parse(match[0]);
}

async function suggestMonthlyCommitments(goal, existingCycles) {
  const currentMonth = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 7);

  const system = `You are OGV's strategic advisor. OGV runs Blok AI (pre-seed AI wealthtech, fundraising, Arkad AI coach), APHL Africa (petroleum haulage Port Harcourt, Candy Opusunju ops), TradeSol (youth commerce training), Personal (pottery, reading, fitness). Be direct and specific. No filler.
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
  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude did not return valid JSON for commitments');
  return JSON.parse(match[0]);
}

async function parseStrategicDocument(documentText, business, existingGoals, currentTasks) {
  const system = `You are OGV's strategic execution advisor.
OGV is an Igbo entrepreneur running:
- Blok AI: pre-seed AI wealthtech, fundraising active, AI coach Arkad, product manager on the team
- APHL Africa: petroleum haulage Port Harcourt, Candy Opusunju runs ops and sales

OGV has sent you a strategic business document.
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
- One risk OGV should be aware of

Return JSON only:
{
  "summary": "one paragraph summary of the document",
  "key_insight": "the single most important thing from this document",
  "risk": "one risk to be aware of",
  "tasks": [
    {
      "name": "specific actionable task",
      "business": "blok or aphl or trade or personal",
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
  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude did not return valid JSON for document analysis');
  return JSON.parse(match[0]);
}

async function reviewGoalProgress(goal, cycles, progressNotes) {
  const system = `You are OGV's strategic advisor. Direct strategic review voice. No flattery.
Given a goal, all its monthly cycles, and progress notes, write a short honest assessment: what has moved, what has not, what needs to change. 3-5 sentences. Plain text.`;

  const userContent =
    `Goal: ${goal.dimension} — ${goal.title} (${goal.business})\n` +
    `Cycles: ${JSON.stringify(cycles)}\n` +
    `Progress notes: ${JSON.stringify(progressNotes)}`;

  return claudeMessage(system, userContent, 'claude-sonnet-4-6');
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
};
