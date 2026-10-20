// Employee journey: invitation, format choice, interview, review and submission.
import { route, fail } from '../lib/http.js';
import { store, must, findParticipantByToken, nowIso } from '../lib/data.js';
import { newId, newToken } from '../lib/ids.js';
import { SERVICE, LANGUAGES, DURATIONS, SECTIONS, THEMES } from '../domain/catalog.js';
import { runTurn, planFor, guideOf } from '../domain/interviewer.js';
import { summarise } from '../domain/summariser.js';
import { llmInfo } from '../llm/index.js';
import { voiceInfo } from './voice.js';
import { redact } from '../domain/redact.js';

const ACTIVE = ['in_progress', 'paused'];

function inviteState(p, programme, sessions) {
  if (p.invitation.status === 'cancelled' || p.status === 'cancelled') return 'cancelled';
  if (['paused', 'archived'].includes(programme.status)) return 'inactive';
  if (sessions.some((s) => s.status === 'submitted')) return 'completed';
  if (p.status === 'withdrawn') return 'withdrawn';
  if (p.status === 'declined') return 'declined';
  const open = sessions.find((s) => ['in_progress', 'paused', 'draft', 'awaiting_review'].includes(s.status));
  if (open) return 'resume';
  if (p.status === 'expired' || (p.invitation.deadline && p.invitation.deadline < nowIso().slice(0, 10))) return 'expired';
  return 'active';
}

function publicProgramme(programme, org) {
  const guide = { objectives: programme.objectives, topics: programme.topics };
  return {
    id: programme.id, name: programme.name, intro: programme.intro, template: programme.template,
    languages: LANGUAGES.filter((l) => programme.languages.includes(l.code)),
    modes: programme.modes, durations: programme.durations.map((d) => ({ id: d, ...DURATIONS[d] })),
    topics: guide.topics.filter((t) => !['experience', 'reasons', 'anything_else', 'preventability'].includes(t.id)).map((t) => ({ id: t.id, label: t.label })),
    feedbackNotice: programme.feedbackNotice, completionMessage: programme.completionMessage,
    followUpWording: programme.followUpWording,
    org: { name: org.name, shortName: org.shortName, brandColor: org.brandColor, logoText: org.logoText || org.shortName, demo: !!org.demo },
  };
}

export function employeeSession(s, programme, participant) {
  const plan = planFor(s, programme, participant);
  return {
    id: s.id, status: s.status, mode: s.mode, initialMode: s.initialMode, modesUsed: s.modesUsed, language: s.language,
    duration: s.duration, focusTopics: s.focusTopics, voiceStyle: s.voiceStyle, phase: s.phase, currentTopic: s.currentTopic,
    transcript: s.transcript.filter((t) => t.role !== 'event'),
    topics: plan.topics.map((t) => ({ id: t.id, label: t.label, status: s.coverage?.[t.id] || 'pending' })),
    activeMs: s.activeMs, summary: s.pendingCorrection || s.summary, pendingCorrection: !!s.pendingCorrection,
    submittedAt: s.submittedAt, ratings: s.ratings, followUpRequested: s.followUpRequested, interviewId: s.interviewId || null,
    revisions: s.revisions, preview: s.population === 'preview', seriousConcernFlagged: !!s.seriousConcernFlagged,
    themes: Object.fromEntries(Object.entries(THEMES).map(([k, v]) => [k, v.label])), sections: SECTIONS,
    liveModel: llmInfo().live,
  };
}

async function loadSessionCtx(req) {
  const s = await must('session', req.params.id, 'Interview');
  const token = req.headers['x-session-token'];
  if (!token || token !== s.accessToken) fail(403, 'This interview link is not valid.');
  const programme = await must('programme', s.programmeId, 'Programme');
  const participant = s.participantId ? await store().get('participant', s.participantId) : s.previewParticipant || null;
  const org = await store().get('org', 'org');
  return { s, programme, participant, org };
}

async function saveParticipant(p, patch) {
  if (!p?.id) return;
  Object.assign(p, patch);
  await store().put('participant', p);
}

route('GET', '/api/public/config', async () => ({
  service: SERVICE, languages: LANGUAGES, llm: llmInfo(), voice: voiceInfo(),
}));

route('GET', '/api/invite/:token', async (req) => {
  const p = await findParticipantByToken(req.params.token);
  if (!p) fail(404, 'We could not find this invitation. Check that you opened the full link from your message.');
  const programme = await must('programme', p.programmeId, 'Programme');
  const org = await store().get('org', 'org');
  const sessions = (await Promise.all(p.sessionIds.map((id) => store().get('session', id)))).filter(Boolean);
  const state = inviteState(p, programme, sessions);
  const open = sessions.find((s) => !['submitted', 'withdrawn', 'abandoned', 'discarded'].includes(s.status));
  const done = sessions.find((s) => s.status === 'submitted');
  return {
    state, service: SERVICE, programme: publicProgramme(programme, org),
    participant: { interviewId: p.interviewId, preferredLanguage: p.preferredLanguage, deadline: p.invitation.deadline, departureType: p.departureType },
    demo: !!org.demo,
    session: open ? { id: open.id, accessToken: open.accessToken, status: open.status, mode: open.mode } : null,
    submitted: done ? { id: done.id, accessToken: done.accessToken, submittedAt: done.submittedAt } : null,
    followUp: p.followUp ? { status: p.followUp.status } : null,
    declineReason: p.declineReason || null,
  };
});

route('POST', '/api/invite/:token/open', async (req) => {
  const p = await findParticipantByToken(req.params.token);
  if (!p) fail(404, 'Invitation not found.');
  if (['prepared', 'sent'].includes(p.invitation.status)) {
    p.invitation.status = 'opened';
    p.invitation.openedAt = nowIso();
    if (p.status === 'invited') p.status = 'not_started';
    await store().put('participant', p);
  }
  return { ok: true };
});

route('POST', '/api/invite/:token/decline', async (req) => {
  const p = await findParticipantByToken(req.params.token);
  if (!p) fail(404, 'Invitation not found.');
  if (p.status === 'submitted') fail(409, 'Feedback has already been submitted for this invitation.');
  await saveParticipant(p, { status: 'declined', declineReason: (req.body?.reason || '').slice(0, 500) || null,
    invitation: { ...p.invitation, status: 'responded', respondedAt: nowIso() } });
  return { ok: true };
});

route('POST', '/api/invite/:token/new-link', async (req) => {
  const p = await findParticipantByToken(req.params.token);
  if (!p) fail(404, 'Invitation not found.');
  p.linkRequests = [...(p.linkRequests || []), { at: nowIso() }];
  await store().put('participant', p);
  return { ok: true, message: 'Your request has been passed to the People Team, who can extend your invitation.' };
});

route('POST', '/api/invite/:token/follow-up', async (req) => {
  const p = await findParticipantByToken(req.params.token);
  if (!p) fail(404, 'Invitation not found.');
  p.followUp = { status: 'requested', requestedAt: nowIso(), note: (req.body?.note || '').slice(0, 1000), history: [{ at: nowIso(), status: 'requested', by: 'employee' }] };
  await store().put('participant', p);
  return { ok: true, followUp: { status: 'requested' } };
});

async function createSession({ programme, participant, body, population, accessToken }) {
  const mode = ['ai_voice', 'ai_text'].includes(body.mode) ? body.mode : 'ai_text';
  const language = programme.languages.includes(body.language) ? body.language : programme.languages[0];
  const duration = programme.durations.includes(body.duration) ? body.duration : programme.durations.includes('standard') ? 'standard' : programme.durations[0];
  const guide = body.guide || { version: programme.activeVersion, objectives: programme.objectives, topics: programme.topics };
  const s = {
    id: newId('ses'), accessToken: accessToken || newToken(), participantId: participant?.id || null, interviewId: participant?.interviewId || null, programmeId: programme.id,
    population, guideVersion: guide.version ?? null, guide: structuredClone(guide),
    initialMode: body.initialMode || mode, mode, modesUsed: [mode], language, duration,
    focusTopics: (body.focusTopics || []).filter((id) => guide.topics.some((t) => t.id === id)).slice(0, 4),
    voiceStyle: ['balanced', 'warm', 'brief'].includes(body.voiceStyle) ? body.voiceStyle : 'balanced',
    voice: body.voice || null,
    status: 'in_progress', phase: 'opening', currentTopic: null,
    transcript: [], coverage: {}, declinedTopics: [], events: [], activeMs: 0,
    startedAt: nowIso(), updatedAt: nowIso(), submittedAt: null, summary: null, ratings: null,
    followUpRequested: false, revisions: [],
  };
  await store().put('session', s);
  return s;
}

route('POST', '/api/invite/:token/session', async (req) => {
  const p = await findParticipantByToken(req.params.token);
  if (!p) fail(404, 'Invitation not found.');
  const programme = await must('programme', p.programmeId, 'Programme');
  const sessions = (await Promise.all(p.sessionIds.map((id) => store().get('session', id)))).filter(Boolean);
  const state = inviteState(p, programme, sessions);
  if (state === 'completed') fail(409, 'You have already submitted feedback for this invitation, so a new interview cannot be started.');
  if (['cancelled', 'inactive', 'expired'].includes(state)) fail(409, 'This invitation is no longer active.');
  const open = sessions.find((s) => ['in_progress', 'paused', 'draft', 'awaiting_review'].includes(s.status));
  if (open) return { id: open.id, accessToken: open.accessToken, resumed: true };
  const s = await createSession({ programme, participant: p, body: req.body || {}, population: p.population || 'demo' });
  p.sessionIds.push(s.id);
  p.status = 'in_progress';
  if (p.invitation.status !== 'responded') { p.invitation.status = 'responded'; p.invitation.respondedAt = nowIso(); }
  if (!p.invitation.openedAt) p.invitation.openedAt = nowIso();
  await store().put('participant', p);
  return { id: s.id, accessToken: s.accessToken, resumed: false };
});

// --- Session endpoints (access token per session) ---------------------------

route('GET', '/api/session/:id', async (req) => {
  const { s, programme, participant, org } = await loadSessionCtx(req);
  return { session: employeeSession(s, programme, participant), programme: publicProgramme(programme, org), service: SERVICE };
});

route('POST', '/api/session/:id/turn', async (req) => {
  const ctx = await loadSessionCtx(req);
  const { s } = ctx;
  if (!ACTIVE.includes(s.status)) fail(409, 'This conversation has finished. You can review your summary instead.');
  const text = redact(String(req.body?.text || '').trim().slice(0, 4000));
  const event = req.body?.event ? { type: req.body.event } : null;
  if (!text && !event) fail(400, 'Nothing to send.');
  if (req.body?.activeMs > s.activeMs) s.activeMs = Math.min(req.body.activeMs, s.activeMs + 30 * 60e3);
  if (event?.type === 'repeat') {
    const last = [...s.transcript].reverse().find((t) => t.role === 'interviewer');
    return { stream: async (write) => { write({ t: 'delta', text: last?.text || '' }); write({ t: 'done', turn: last, repeat: true }); } };
  }
  if (s.status === 'paused') s.status = 'in_progress';
  if (text) s.transcript.push({ id: `t${s.transcript.length + 1}`, role: 'employee', text, lang: s.language, at: nowIso(), via: req.body?.via === 'voice' ? 'voice' : 'text' });
  if (event) s.events.push({ at: nowIso(), type: event.type });
  if (event?.type === 'mode_text' && s.mode !== 'ai_text') { s.mode = 'ai_text'; s.modesUsed = [...new Set([...s.modesUsed, 'ai_text'])]; }
  s.updatedAt = nowIso();
  // Save the employee's words before generating, so nothing is lost if generation fails.
  await store().put('session', s);
  return {
    stream: async (write) => {
      try {
        const out = await runTurn({ ...ctx, session: s, employeeText: text, event }, (delta) => write({ t: 'delta', text: delta }));
        const turn = { id: `t${s.transcript.length + 1}`, role: 'interviewer', text: out.reply, lang: s.language, at: nowIso() };
        s.transcript.push(turn);
        s.updatedAt = nowIso();
        await store().put('session', s);
        const session = employeeSession(s, ctx.programme, ctx.participant);
        write({ t: 'done', turn, phase: s.phase, topics: session.topics, seriousConcern: !!out.state?.serious_concern, currentTopic: s.currentTopic });
      } catch (err) {
        console.error('turn failed', err);
        write({ t: 'error', message: 'The interviewer could not respond just now. Your answer has been saved. Try again, or switch to text.' });
      }
    },
  };
});

route('POST', '/api/session/:id/event', async (req) => {
  const { s, programme, participant } = await loadSessionCtx(req);
  const type = req.body?.type;
  const allowed = ['pause', 'resume', 'mute', 'unmute', 'audio_failure', 'reconnected', 'transcript_on', 'transcript_off', 'mode_voice', 'mode_text', 'extend'];
  if (!allowed.includes(type)) fail(400, 'Unknown event.');
  s.events.push({ at: nowIso(), type, detail: req.body?.detail || null });
  if (req.body?.activeMs > s.activeMs) s.activeMs = req.body.activeMs;
  if (type === 'pause' && s.status === 'in_progress') s.status = 'paused';
  if (type === 'resume' && s.status === 'paused') s.status = 'in_progress';
  if (type === 'mode_text') { s.mode = 'ai_text'; s.modesUsed = [...new Set([...s.modesUsed, 'ai_text'])]; }
  if (type === 'mode_voice') { s.mode = 'ai_voice'; s.modesUsed = [...new Set([...s.modesUsed, 'ai_voice'])]; }
  s.updatedAt = nowIso();
  await store().put('session', s);
  return { session: employeeSession(s, programme, participant) };
});

route('POST', '/api/session/:id/correct-turn', async (req) => {
  const { s, programme, participant } = await loadSessionCtx(req);
  const turn = s.transcript.find((t) => t.id === req.body?.turnId && t.role === 'employee');
  if (!turn) fail(404, 'That part of the conversation could not be found.');
  const text = redact(String(req.body?.text || '').trim());
  if (!text) fail(400, 'The corrected text cannot be empty.');
  turn.corrected = { from: turn.corrected?.from || turn.text, at: nowIso() };
  turn.text = text;
  s.updatedAt = nowIso();
  await store().put('session', s);
  return { session: employeeSession(s, programme, participant) };
});

route('POST', '/api/session/:id/finish', async (req) => {
  const { s, programme, participant } = await loadSessionCtx(req);
  if (!ACTIVE.includes(s.status) && s.status !== 'awaiting_review') fail(409, 'This interview cannot be finished from its current state.');
  if (req.body?.activeMs > s.activeMs) s.activeMs = req.body.activeMs;
  if (!s.transcript.some((t) => t.role === 'employee')) fail(400, 'There is nothing to summarise yet. You can continue the conversation or leave without submitting.');
  if (!s.summary || req.body?.regenerate) {
    try {
      s.summary = await summarise(s);
    } catch (err) {
      console.error('summary failed', err);
      fail(503, 'Your conversation is saved, but the summary could not be prepared just now. Please try again in a moment.');
    }
  }
  s.status = 'awaiting_review';
  s.phase = 'ended';
  s.endedAt = nowIso();
  s.updatedAt = nowIso();
  await store().put('session', s);
  if (participant?.id) await saveParticipant(participant, { status: 'awaiting_review' });
  return { session: employeeSession(s, programme, participant) };
});

function cleanSummary(input, existing, session) {
  const sections = Object.keys(SECTIONS);
  const themes = Object.keys(THEMES);
  const prevById = Object.fromEntries((existing?.points || []).map((p) => [p.id, p]));
  const points = (input.points || []).map((p, i) => {
    const prev = prevById[p.id];
    const text = redact(String(p.text || '').trim().slice(0, 1000));
    if (!text && p.status !== 'removed') return null;
    const changed = prev && prev.text !== text;
    return {
      ...(prev || {}),
      id: p.id || `pt_new_${i + 1}_${Date.now() % 100000}`,
      section: sections.includes(p.section) ? p.section : 'additional',
      text, textEn: changed || !prev ? (session.language === 'en' ? null : prev?.textEn && !changed ? prev.textEn : null) : prev.textEn,
      themes: (p.themes || prev?.themes || []).filter((t) => themes.includes(t)),
      tone: ['positive', 'negative', 'mixed', 'neutral'].includes(p.tone) ? p.tone : prev?.tone || 'neutral',
      origin: prev ? (changed ? 'employee_edited' : prev.origin) : 'employee',
      status: p.status === 'removed' ? 'removed' : 'kept',
      evidence: prev && !changed ? prev.evidence : prev ? [{ turnId: prev.evidence?.[0]?.turnId || null, kind: 'paraphrase', text, lang: session.language, translation: null }] : [{ turnId: null, kind: 'employee_written', text, lang: session.language, translation: null }],
      mentions: prev?.mentions || 1, lang: session.language,
    };
  }).filter(Boolean);
  const factors = (input.factors || []).filter((f) => themes.includes(f.theme)).map((f) => ({
    theme: f.theme, role: ['trigger', 'contributing', 'pull'].includes(f.role) ? f.role : 'contributing',
    status: ['suggested', 'confirmed', 'rejected'].includes(f.status) ? f.status : 'suggested',
    rank: Number.isInteger(f.rank) && f.rank > 0 && f.rank < 10 ? f.rank : null,
  }));
  return {
    points, factors, noSingleMainReason: !!input.noSingleMainReason,
    preventability: ['yes', 'maybe', 'no', 'unsure', 'not_discussed'].includes(input.preventability) ? input.preventability : 'not_discussed',
    finalComment: input.finalComment ? redact(String(input.finalComment).slice(0, 2000)) : null,
    generatedBy: existing?.generatedBy,
  };
}

route('PUT', '/api/session/:id/summary', async (req) => {
  const { s, programme, participant } = await loadSessionCtx(req);
  if (s.status === 'submitted') {
    s.pendingCorrection = cleanSummary(req.body?.summary || {}, s.pendingCorrection || s.summary, s);
  } else {
    if (!['awaiting_review', 'draft'].includes(s.status)) fail(409, 'This summary can no longer be edited.');
    s.summary = cleanSummary(req.body?.summary || {}, s.summary, s);
  }
  s.updatedAt = nowIso();
  await store().put('session', s);
  return { session: employeeSession(s, programme, participant), savedAt: s.updatedAt };
});

route('POST', '/api/session/:id/save-draft', async (req) => {
  const { s, programme, participant } = await loadSessionCtx(req);
  if (req.body?.summary) s.summary = cleanSummary(req.body.summary, s.summary, s);
  if (!['awaiting_review', 'draft'].includes(s.status)) fail(409, 'Only a summary under review can be saved for later.');
  s.status = 'draft';
  s.updatedAt = nowIso();
  await store().put('session', s);
  if (participant?.id) await saveParticipant(participant, { status: 'awaiting_review' });
  return { session: employeeSession(s, programme, participant) };
});

route('POST', '/api/session/:id/discard', async (req) => {
  const { s, participant } = await loadSessionCtx(req);
  if (s.status === 'submitted') fail(409, 'Submitted feedback is withdrawn with the withdraw option instead.');
  s.status = 'discarded';
  s.summary = null;
  s.updatedAt = nowIso();
  await store().put('session', s);
  if (participant?.id) await saveParticipant(participant, { status: 'withdrawn' });
  return { ok: true };
});

route('POST', '/api/session/:id/submit', async (req) => {
  const { s, programme, participant } = await loadSessionCtx(req);
  if (s.population === 'preview') fail(409, 'Preview interviews cannot be submitted. They are not added to any findings.');
  if (s.status === 'submitted' && s.pendingCorrection) {
    if (req.body?.summary) s.pendingCorrection = cleanSummary(req.body.summary, s.pendingCorrection, s);
    s.summary = s.pendingCorrection;
    delete s.pendingCorrection;
    s.revisions.push({ at: nowIso(), type: 'correction', note: (req.body?.note || 'Employee corrected their submitted summary.').slice(0, 500), by: 'employee' });
    s.updatedAt = nowIso();
    await store().put('session', s);
    return { session: employeeSession(s, programme, participant) };
  }
  if (!['awaiting_review', 'draft'].includes(s.status)) fail(409, 'This summary is not ready to submit.');
  if (req.body?.summary) s.summary = cleanSummary(req.body.summary, s.summary, s);
  if (!s.summary.points.some((p) => p.status === 'kept')) fail(400, 'There is nothing left to submit. Add a point, or leave without submitting.');
  s.status = 'submitted';
  s.submittedAt = nowIso();
  s.updatedAt = s.submittedAt;
  await store().put('session', s);
  if (participant?.id) await saveParticipant(participant, { status: 'submitted' });
  return { session: employeeSession(s, programme, participant) };
});

route('POST', '/api/session/:id/start-correction', async (req) => {
  const { s, programme, participant } = await loadSessionCtx(req);
  if (s.status !== 'submitted') fail(409, 'Only submitted feedback can be corrected.');
  s.pendingCorrection = structuredClone(s.summary);
  await store().put('session', s);
  return { session: employeeSession(s, programme, participant) };
});

route('POST', '/api/session/:id/cancel-correction', async (req) => {
  const { s, programme, participant } = await loadSessionCtx(req);
  delete s.pendingCorrection;
  await store().put('session', s);
  return { session: employeeSession(s, programme, participant) };
});

route('POST', '/api/session/:id/withdraw', async (req) => {
  const { s, programme, participant } = await loadSessionCtx(req);
  if (s.status !== 'submitted') fail(409, 'Only submitted feedback can be withdrawn.');
  s.status = 'withdrawn';
  delete s.pendingCorrection;
  s.revisions.push({ at: nowIso(), type: 'withdrawal', note: 'Employee withdrew their submitted feedback.', by: 'employee' });
  s.updatedAt = nowIso();
  await store().put('session', s);
  if (participant?.id) await saveParticipant(participant, { status: 'withdrawn' });
  return { session: employeeSession(s, programme, participant) };
});

route('POST', '/api/session/:id/ratings', async (req) => {
  const { s } = await loadSessionCtx(req);
  const r = {};
  for (const k of ['ease', 'heard', 'accuracy']) {
    const v = Number(req.body?.[k]);
    if (v >= 1 && v <= 5) r[k] = v;
  }
  s.ratings = { ...(s.ratings || {}), ...r };
  await store().put('session', s);
  return { ok: true };
});

route('POST', '/api/session/:id/follow-up', async (req) => {
  const { s, participant } = await loadSessionCtx(req);
  s.followUpRequested = true;
  s.events.push({ at: nowIso(), type: 'follow_up_requested' });
  await store().put('session', s);
  if (participant?.id) {
    participant.followUp = { status: 'requested', requestedAt: nowIso(), note: (req.body?.note || '').slice(0, 1000), history: [{ at: nowIso(), status: 'requested', by: 'employee' }] };
    await store().put('participant', participant);
  }
  return { ok: true, followUp: { status: 'requested' } };
});

export { createSession, publicProgramme, guideOf };
