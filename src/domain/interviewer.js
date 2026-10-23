// The AI interviewer. One function, runTurn, drives both voice and text interviews:
// it streams the spoken reply and then updates the session's coverage state.
import { DURATIONS, framingOf, TIER_ORDER, LANGUAGES, THEMES } from './catalog.js';
import { llmInfo, streamText, generateJson, fastModel } from '../llm/index.js';
import { offlineTurn } from './offline.js';

const MARKER = '###STATE###';

const LANG_NAME = Object.fromEntries(LANGUAGES.map((l) => [l.code, l.label]));

const RULES = `You are an AI exit interviewer working for PartWays, an independent interviewing service. An organisation has commissioned PartWays to hear from an employee who is leaving. You are not the employee's colleague, manager or employer, and you never speak as if you were.

How you converse:
- Ask one clear question per turn. Never stack several questions.
- Be warm and concise: usually one or two short sentences before your question. No exaggerated empathy, praise or enthusiasm, and do not acknowledge every answer with the same phrase.
- Listen first. Follow up on meaningful details, ambiguity or missing context in what the employee actually said. Do not probe just to fill time.
- Recognise topics already covered, even if the employee raised them before the guide reached them. Never repeat questions about something already explained.
- Accept positive, neutral and mixed experiences. Do not steer towards grievances. Personal reasons are a complete answer if the employee wants to leave it there.
- If the employee declines a topic, respect it immediately, offer to move on, and never return to it in other words.
- Let the employee redirect, add topics or correct earlier statements. When corrected, acknowledge briefly and use the corrected meaning from then on.
- Distinguish the trigger for leaving, contributing conditions, attractions of the next role, and positives about this employer. When several reasons are given, you may ask about relative importance, but accept that there may be no single main reason.
- Explore whether anything might have changed the decision, accepting that some departures were not preventable.
- Where useful, clarify whether something was recurring or a one-off, and whether it was experienced directly or heard from others.
- Clarify apparent contradictions neutrally; people can have mixed feelings.
- You may summarise your understanding and ask for confirmation, but never present an inferred motive as something the employee said.
- Never infer honesty, personality, mental health or emotion from how someone sounds.
- Never invent company policies, promise investigations or make commitments for the organisation. If the employee wants someone to act on something or contact them, say briefly that PartWays only records their feedback and cannot pass on requests, and that they can raise it directly with the organisation; then continue the interview.
- Keep the interview de-identified. Never ask for the employee's name, contact details or anything else that identifies them. If they name other people, do not repeat the names; refer to roles instead ("your manager", "a colleague").
- If the employee raises a serious concern (for example harassment, discrimination, safety, or wrongdoing), acknowledge it without interrogating or judging, say that PartWays cannot act on it but they can raise it directly with the organisation, and ask whether they would like to continue.
- If you did not understand something (unclear words, possible transcription error), ask for clarification instead of guessing.
- Adapt depth to the chosen length. In a quick interview, cover the essentials only; ask before going beyond the time the employee chose.
- Before ending, ask whether anything important was missed. When the employee has nothing to add, thank them briefly and explain that they will now see a summary they can review and correct before anything is submitted.
- Your words may be spoken aloud: no lists, headings, emoji or markdown. Keep turns short.
- Speak in the interview language given below.

Output format, exactly:
1. Your reply to the employee, in plain text.
2. A line containing only ${MARKER}
3. One line of JSON: {"coverage": {"<topicId>": "explored" | "insufficient" | "skipped" | "declined"}, "current_topic": "<topicId or null>", "phase": "opening" | "exploring" | "closing_check" | "ended", "serious_concern": true | false, "needs_clarification": true | false}
In "coverage" include only topics whose status changed this turn. Use "explored" when the employee has meaningfully addressed a topic (wherever it came up), "insufficient" when touched on only briefly, "skipped" when you or the employee moved past it, "declined" when the employee did not want to discuss it. Use phase "ended" only after the closing check, when the employee has confirmed there is nothing more to add.`;

export function guideOf(session, programme) {
  if (session.guide) return session.guide;
  const v = programme.guideVersions.find((g) => g.version === session.guideVersion);
  return v || { version: null, objectives: programme.objectives, topics: programme.topics };
}

export function planFor(session, programme, participant) {
  const guide = guideOf(session, programme);
  const dur = DURATIONS[session.duration] || DURATIONS.standard;
  const applicable = guide.objectives.filter((o) => !o.appliesTo || !participant || o.appliesTo.values.includes(participant[o.appliesTo.dimension]));
  const prioScore = { high: 3, medium: 2, low: 1 };
  const topicScore = (t) => {
    let s = t.kind === 'core' ? 2 : 0;
    let linked = false;
    for (const oid of t.objectiveIds || []) {
      const o = applicable.find((x) => x.id === oid);
      if (o) { s += prioScore[o.priority] || 1; linked = true; }
    }
    // Topics that serve a learning objective come before unlinked topics.
    if (linked) s += 3;
    if (session.focusTopics?.includes(t.id)) s += 10;
    return s;
  };
  const eligible = guide.topics.filter((t) => TIER_ORDER[t.tier] <= TIER_ORDER[session.duration] || session.focusTopics?.includes(t.id) || topicScore(t) >= 4);
  const always = new Set(['experience', 'anything_else']);
  const ranked = [...eligible].sort((a, b) => topicScore(b) - topicScore(a));
  const chosen = new Set(ranked.filter((t) => !always.has(t.id)).slice(0, Math.max(dur.maxTopics - 2, 1)).map((t) => t.id));
  for (const id of always) if (guide.topics.some((t) => t.id === id)) chosen.add(id);
  const topics = guide.topics.filter((t) => chosen.has(t.id));
  return { guide, topics, objectives: applicable, notApplicable: guide.objectives.filter((o) => !applicable.includes(o)), duration: dur };
}

function contextBlock(session, programme, org, participant) {
  const plan = planFor(session, programme, participant);
  const lang = LANG_NAME[session.language] || 'English';
  const lines = [];
  lines.push(`Commissioning organisation: ${org.name}. Programme: ${programme.name}.`);
  lines.push(`Departure context: ${framingOf(programme)}`);
  lines.push(`Interview language: ${lang}. Mode: ${session.mode === 'ai_voice' ? 'spoken conversation' : 'typed conversation'}.`);
  lines.push(`Chosen length: ${plan.duration.label} (${plan.duration.minutes} minutes). Active time so far: ${Math.round((session.activeMs || 0) / 60000)} minutes.`);
  if (session.voiceStyle === 'brief') lines.push('Conversational style requested: brief and to the point.');
  if (session.voiceStyle === 'warm') lines.push('Conversational style requested: warm and unhurried.');
  if (session.focusTopics?.length) lines.push(`The employee said they particularly want to discuss: ${session.focusTopics.map((id) => plan.guide.topics.find((t) => t.id === id)?.label || id).join('; ')}.`);
  lines.push('');
  lines.push('What the organisation wants to understand (learning objectives, in priority order). Let these guide where you spend time, without leading the employee or scripting their answers:');
  for (const o of [...plan.objectives].sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.priority] - { high: 0, medium: 1, low: 2 }[b.priority]))) {
    lines.push(`- [${o.priority} priority, ${o.depth} depth] ${o.title}. ${o.description || ''}${o.context ? ` Context: ${o.context}` : ''}`);
  }
  lines.push('');
  lines.push('Topics to offer in this interview (offer, never force; the employee may skip any):');
  for (const t of plan.topics) {
    const status = session.coverage?.[t.id] || 'not yet discussed';
    const q = t.exact ? `Ask with exactly this wording (translated if needed): "${t.opening}"` : `Possible opening: "${t.opening}"`;
    lines.push(`- ${t.id}: ${t.label}. Status: ${status}. ${q}${t.followUps?.length ? ` Useful follow-up directions: ${t.followUps.join(' | ')}` : ''}`);
  }
  const outOfPlan = plan.guide.topics.filter((t) => !plan.topics.includes(t));
  if (outOfPlan.length) lines.push(`Other guide topics, only if the employee raises them: ${outOfPlan.map((t) => `${t.id} (${t.label})`).join(', ')}.`);
  if (session.declinedTopics?.length) lines.push(`The employee declined these topics. Do not return to them in any form: ${session.declinedTopics.join(', ')}.`);
  const corrections = (session.transcript || []).filter((t) => t.corrected);
  if (corrections.length) lines.push(`The employee corrected the transcript: ${corrections.map((t) => `"${t.corrected.from}" should read "${t.text}"`).join('; ')}. Use the corrected wording.`);
  return lines.join('\n');
}

function eventNote(event) {
  switch (event?.type) {
    case 'start': return 'The interview is starting now. Introduce yourself as an AI interviewer from PartWays, an independent service, say briefly who asked for the conversation and that the employee will review a summary before anything is submitted, then open with an invitation to describe their experience.';
    case 'resume': return 'The employee has returned to a paused or interrupted interview. In one sentence, say where the conversation had reached, then continue with the next useful question. Do not ask them to repeat anything.';
    case 'long_pause': return 'The employee has been quiet for a while. Offer one short, unpressured prompt (for example that there is no rush, or offer to move to another topic). Do not ask whether they are still there.';
    case 'skip_topic': return 'The employee pressed "Skip topic". Mark the current topic as skipped, acknowledge without comment, and move to a different topic.';
    case 'mode_text': return 'The employee has switched from voice to typing. Continue the same conversation in text without restarting.';
    case 'extend': return 'The employee agreed to continue beyond their chosen length.';
    case 'finish': return 'The employee pressed "Finish". Briefly check whether anything important was missed, unless you have already done so.';
    default: return null;
  }
}

function toMessages(session, event, employeeText) {
  const msgs = [];
  const push = (role, text) => {
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content += `\n\n${text}`;
    else msgs.push({ role, content: text });
  };
  push('user', '<event>Interview session opened.</event>');
  for (const t of session.transcript || []) {
    if (t.role === 'interviewer') push('assistant', t.text);
    else if (t.role === 'employee') push('user', t.text);
    else if (t.role === 'event') push('user', `<event>${t.text}</event>`);
  }
  const note = eventNote(event);
  if (note) push('user', `<event>${note}</event>`);
  if (employeeText) push('user', employeeText);
  if (msgs[msgs.length - 1].role === 'assistant') push('user', '<event>Continue.</event>');
  return msgs;
}

function parseState(raw) {
  const idx = raw.indexOf(MARKER);
  if (idx < 0) return { reply: raw.trim(), state: null };
  const reply = raw.slice(0, idx).trim();
  const json = raw.slice(idx + MARKER.length).trim().split('\n')[0];
  try { return { reply, state: JSON.parse(json) }; } catch { return { reply, state: null }; }
}

export function applyState(session, state, plan) {
  if (!state) return;
  const valid = new Set(plan.guide.topics.map((t) => t.id));
  for (const [id, st] of Object.entries(state.coverage || {})) {
    if (!valid.has(id) || !['explored', 'insufficient', 'skipped', 'declined'].includes(st)) continue;
    const prev = session.coverage[id];
    if (prev === 'declined') continue;
    if (prev === 'explored' && st === 'insufficient') continue;
    session.coverage[id] = st;
    if (st === 'declined' && !session.declinedTopics.includes(id)) session.declinedTopics.push(id);
  }
  if (['opening', 'exploring', 'closing_check', 'ended'].includes(state.phase)) session.phase = state.phase;
  session.currentTopic = valid.has(state.current_topic) ? state.current_topic : session.currentTopic;
  if (state.serious_concern) session.seriousConcernFlagged = true;
}

// Runs one interviewer turn. onText receives reply text as it is generated.
export async function runTurn({ session, programme, org, participant, employeeText, event }, onText) {
  const plan = planFor(session, programme, participant);
  session.coverage ||= {};
  session.declinedTopics ||= [];
  if (!llmInfo().live) {
    const out = offlineTurn({ session, plan, org, employeeText, event });
    onText?.(out.reply);
    applyState(session, out.state, plan);
    return out;
  }
  // The fixed rules come first, so every turn shares the same prefix and OpenAI's
  // automatic prompt caching applies; the per-interview context follows.
  const system = `${RULES}\n\n${contextBlock(session, programme, org, participant)}`;
  // Hold back text that could be the start of the state marker.
  let buffer = '';
  let emitted = 0;
  let done = false;
  const raw = await streamText({ system, messages: toMessages(session, event, employeeText), effort: 'low', maxTokens: 2000 }, (delta) => {
    if (done) return;
    buffer += delta;
    const idx = buffer.indexOf(MARKER);
    if (idx >= 0) {
      if (idx > emitted) onText?.(buffer.slice(emitted, idx));
      emitted = idx;
      done = true;
      return;
    }
    const safe = buffer.length - MARKER.length;
    if (safe > emitted) { onText?.(buffer.slice(emitted, safe)); emitted = safe; }
  });
  if (!done && raw.length > emitted) onText?.(raw.slice(emitted));
  const out = parseState(raw);
  applyState(session, out.state, plan);
  return out;
}

export function themeLabels() {
  return Object.fromEntries(Object.entries(THEMES).map(([k, v]) => [k, v.label]));
}

// --- Live voice (OpenAI Realtime) ---------------------------------------------
// In a live voice interview the browser talks to a speech-to-speech model directly.
// It gets the same rules and plan as the text interviewer, without the state marker:
// progress is tracked separately after each interviewer turn (trackProgress).

const VOICE_RULES = `${RULES.slice(0, RULES.indexOf('\n\nOutput format, exactly:'))}

You are speaking live with the employee by voice. Talk as you would in a real conversation: natural, brief, one question at a time. The employee can interrupt you at any time; when they do, stop and listen. Never read out lists or structure.`;

export function realtimeInstructions({ session, programme, org, participant }) {
  const lines = [VOICE_RULES, '', contextBlock(session, programme, org, participant), ''];
  const prior = (session.transcript || []).filter((t) => t.role === 'interviewer' || t.role === 'employee');
  if (prior.length) {
    lines.push('The conversation so far. Continue from here: do not restart, do not introduce yourself again, and do not ask the employee to repeat anything.');
    for (const t of prior.slice(-40)) lines.push(`${t.role === 'interviewer' ? 'Interviewer' : 'Employee'}: ${t.text}`);
    lines.push('', 'Begin by saying in one sentence where the conversation had reached, then ask the next useful question.');
  } else {
    lines.push(`Begin as soon as the conversation starts. ${eventNote({ type: 'start' })}`);
  }
  return lines.join('\n');
}

const PROGRESS_RULES = `You track the progress of a live exit interview between an AI interviewer and a departing employee. You do not speak to anyone. From the topics and the conversation, return:
- coverage: only topics whose status should change. "explored" when the employee has meaningfully addressed it (wherever it came up), "insufficient" when touched on only briefly, "skipped" when the interviewer or employee moved past it, "declined" when the employee did not want to discuss it.
- current_topic: the topic id being discussed now, or null.
- phase: "opening", "exploring", "closing_check" (the interviewer has asked whether anything was missed), or "ended" when the interviewer's most recent turn closes the interview (thanks the employee and says goodbye or that the summary comes next), however the employee answered the closing check.
- serious_concern: true if the employee raised harassment, discrimination, safety or wrongdoing.`;

// Strict, so the smaller progress model cannot drift from the allowed values;
// strict mode has no open-ended maps, so coverage comes back as a list.
const PROGRESS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['coverage', 'current_topic', 'phase', 'serious_concern'],
  properties: {
    coverage: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['topic', 'status'],
        properties: { topic: { type: 'string' }, status: { type: 'string', enum: ['explored', 'insufficient', 'skipped', 'declined'] } },
      },
    },
    current_topic: { type: ['string', 'null'] },
    phase: { type: 'string', enum: ['opening', 'exploring', 'closing_check', 'ended'] },
    serious_concern: { type: 'boolean' },
  },
};

export async function trackProgress({ session, programme, participant }) {
  const plan = planFor(session, programme, participant);
  session.coverage ||= {};
  session.declinedTopics ||= [];
  if (!llmInfo().live) return null;
  const topics = plan.guide.topics.map((t) => `- ${t.id}: ${t.label} (status so far: ${session.coverage[t.id] || 'not yet discussed'})`).join('\n');
  const convo = (session.transcript || []).filter((t) => t.role === 'interviewer' || t.role === 'employee').slice(-30)
    .map((t) => `${t.role === 'interviewer' ? 'Interviewer' : 'Employee'}: ${t.text}`).join('\n');
  const state = await generateJson({
    system: PROGRESS_RULES,
    messages: [{ role: 'user', content: `Topics:\n${topics}\n\nConversation (most recent last):\n${convo}` }],
    schema: PROGRESS_SCHEMA, strict: true, model: fastModel(), effort: 'low', maxTokens: 1500,
  });
  state.coverage = Object.fromEntries((state.coverage || []).map((c) => [c.topic, c.status]));
  applyState(session, state, plan);
  return state;
}

