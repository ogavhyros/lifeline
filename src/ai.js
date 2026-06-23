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
  const system = `You are Arkad — a direct, no-nonsense coach who holds people to hard standards.
Write a 3-5 sentence morning briefing that:
- States what matters today and why it counts
- Calls out any risk or weak spot in the plan without softening it
- Ends with exactly one hard, specific question the person must answer before they start
No emojis. No filler. Plain text only.`;

  const taskList = tasks
    .map((t) => `- ${t.name} (${t.business})${t.time ? ` [${t.time}]` : ''}`)
    .join('\n');

  const userContent = `Date: ${date}\nTasks:\n${taskList}`;
  return claudeMessage(system, userContent);
}

async function generateEODReview(tasks, date) {
  const system = `You are Arkad — direct, honest, unsparing.
Write a 4-6 sentence end-of-day review that:
- Acknowledges what was actually completed
- Names any missed or incomplete tasks plainly — no euphemisms
- Identifies the single biggest reason the day succeeded or fell short
- Closes with one concrete instruction for tomorrow
No emojis. No praise padding. Plain text only.`;

  const taskList = tasks
    .map((t) => {
      const status = t.done ? 'done' : 'not done';
      return `- [${status}] ${t.name} (${t.business})${t.time ? ` [${t.time}]` : ''}`;
    })
    .join('\n');

  const userContent = `Date: ${date}\nTasks:\n${taskList}`;
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
or calling Candy. If he says "done with emails" match investor \
email tasks.

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
};
