// Programme setup: objectives, guide editing, versions and live preview.
import { route, fail } from '../lib/http.js';
import { store, must, nowIso } from '../lib/data.js';
import { newId } from '../lib/ids.js';
import { DEFAULT_TOPICS, TEMPLATES, DURATIONS, LANGUAGES, THEMES, DIMENSIONS } from '../domain/catalog.js';
import { proposePlan, analysePlan, diffGuides } from '../domain/planner.js';
import { createSession } from './employee.js';
import { llmInfo } from '../llm/index.js';
import { DEFAULT_MESSAGES, newProgramme } from '../domain/programmes.js';

export { DEFAULT_MESSAGES };

function workingGuide(p) {
  return p.draft || { objectives: p.objectives, topics: p.topics };
}

async function programmeSummary(p, participants, sessions) {
  const mine = participants.filter((x) => x.programmeId === p.id && x.population !== 'preview');
  const status = {};
  for (const x of mine) status[x.status] = (status[x.status] || 0) + 1;
  const processing = sessions.filter((s) => s.programmeId === p.id && s.status === 'submitted' && !s.summary).length;
  return {
    id: p.id, name: p.name, description: p.description, template: p.template, status: p.status,
    activeVersion: p.activeVersion, hasDraft: !!p.draft, reportingMode: p.reportingMode, objectives: p.objectives.length,
    counts: { participants: mine.length, ...status }, processing, createdAt: p.createdAt,
    demoParticipants: mine.filter((x) => x.population === 'demo').length, evaluationParticipants: mine.filter((x) => x.population === 'evaluation').length,
  };
}

route('GET', '/api/hr/meta', async () => ({
  templates: TEMPLATES, durations: DURATIONS, languages: LANGUAGES, dimensions: DIMENSIONS,
  themes: Object.fromEntries(Object.entries(THEMES).map(([k, v]) => [k, { label: v.label, description: v.description }])),
  defaultTopics: DEFAULT_TOPICS, llm: llmInfo(),
}), { auth: true });

route('GET', '/api/hr/programmes', async () => {
  const [programmes, participants, sessions] = await Promise.all([store().list('programme'), store().list('participant'), store().list('session')]);
  const order = { active: 0, paused: 1, draft: 2, archived: 3 };
  const list = await Promise.all(programmes.map((p) => programmeSummary(p, participants, sessions)));
  return { programmes: list.sort((a, b) => order[a.status] - order[b.status] || a.createdAt.localeCompare(b.createdAt)) };
}, { auth: true });

route('POST', '/api/hr/programmes', async (req) => {
  const { name, template = 'general', duplicateOf } = req.body || {};
  if (!String(name || '').trim()) fail(400, 'Give the programme a name.');
  let p;
  if (duplicateOf) {
    const src = await must('programme', duplicateOf, 'Programme');
    const g = workingGuide(src);
    p = { ...structuredClone(src), objectives: structuredClone(g.objectives), topics: structuredClone(g.topics) };
  } else {
    if (!TEMPLATES[template]) fail(400, 'Unknown template.');
    p = newProgramme({ name, template, org: await store().get('org', 'org') });
  }
  Object.assign(p, {
    id: newId('prog'), name: String(name).trim().slice(0, 120), status: 'draft', activeVersion: null, guideVersions: [], draft: null,
    createdAt: nowIso(), messages: p.messages || { ...DEFAULT_MESSAGES },
  });
  await store().put('programme', p);
  return { programme: p };
}, { auth: true });

route('GET', '/api/hr/programmes/:id', async (req) => {
  const p = await must('programme', req.params.id, 'Programme');
  const g = workingGuide(p);
  return {
    programme: { ...p, messages: p.messages || DEFAULT_MESSAGES },
    working: g, analysis: analysePlan(g.objectives, g.topics),
    changes: p.status === 'draft' ? [] : diffGuides({ objectives: p.objectives, topics: p.topics }, g),
  };
}, { auth: true });

route('PUT', '/api/hr/programmes/:id/settings', async (req) => {
  const p = await must('programme', req.params.id, 'Programme');
  const b = req.body || {};
  const str = (v, max = 2000) => (v === undefined ? undefined : String(v).slice(0, max));
  const set = (k, v) => { if (v !== undefined) p[k] = v; };
  set('name', str(b.name, 120)); set('description', str(b.description, 500)); set('intro', str(b.intro));
  set('completionMessage', str(b.completionMessage)); set('feedbackNotice', str(b.feedbackNotice));
  if (Array.isArray(b.languages)) { const l = b.languages.filter((x) => LANGUAGES.some((y) => y.code === x)); if (!l.length) fail(400, 'Choose at least one language.'); p.languages = l; }
  if (Array.isArray(b.modes)) { const m = b.modes.filter((x) => ['ai_voice', 'ai_text'].includes(x)); if (!m.length) fail(400, 'Choose at least one interview format.'); p.modes = m; }
  if (Array.isArray(b.durations)) { const d = b.durations.filter((x) => DURATIONS[x]); if (!d.length) fail(400, 'Choose at least one interview length.'); p.durations = d; }
  if (b.reportingMode) p.reportingMode = b.reportingMode === 'aggregate' ? 'aggregate' : 'individual';
  if (b.reportingMinimum !== undefined) { const n = Number(b.reportingMinimum); if (!(n >= 3 && n <= 50)) fail(400, 'The reporting minimum must be between 3 and 50.'); p.reportingMinimum = n; }
  if (b.reminder) p.reminder = { enabled: !!b.reminder.enabled, afterDays: Math.max(1, Math.min(14, Number(b.reminder.afterDays) || 4)), max: Math.max(0, Math.min(3, Number(b.reminder.max) || 2)) };
  if (b.messages) p.messages = { invitation: str(b.messages.invitation) || DEFAULT_MESSAGES.invitation, reminder: str(b.messages.reminder) || DEFAULT_MESSAGES.reminder };
  p.updatedAt = nowIso();
  await store().put('programme', p);
  return { programme: p };
}, { auth: true });

function cleanObjectives(list) {
  return (list || []).map((o, i) => {
    const title = String(o.title || '').trim().slice(0, 200);
    if (!title) fail(400, `Objective ${i + 1} needs a description of what you want to understand.`);
    return {
      id: o.id || newId('obj'), title, description: String(o.description || '').slice(0, 1000), context: String(o.context || '').slice(0, 1000),
      priority: ['high', 'medium', 'low'].includes(o.priority) ? o.priority : 'medium',
      depth: ['light', 'standard', 'deep'].includes(o.depth) ? o.depth : 'standard',
      appliesTo: o.appliesTo?.dimension && o.appliesTo.values?.length ? { dimension: o.appliesTo.dimension, values: o.appliesTo.values } : null,
      topicIds: o.topicIds || [], themeIds: (o.themeIds || []).filter((t) => THEMES[t]),
    };
  });
}

function cleanTopics(list) {
  const seen = new Set();
  return (list || []).map((t, i) => {
    const opening = String(t.opening || '').trim();
    const label = String(t.label || '').trim();
    if (!label || !opening) fail(400, `Topic ${i + 1} needs a name and an opening question.`);
    let id = String(t.id || label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || `topic_${i + 1}`;
    while (seen.has(id)) id += '_2';
    seen.add(id);
    return {
      id, label: label.slice(0, 120), opening: opening.slice(0, 500), themes: (t.themes || []).filter((x) => THEMES[x]),
      kind: t.kind === 'core' ? 'core' : 'optional', tier: ['quick', 'standard', 'in_depth'].includes(t.tier) ? t.tier : 'standard',
      exact: !!t.exact, followUps: (t.followUps || []).map((f) => String(f).trim()).filter(Boolean).slice(0, 6), objectiveIds: t.objectiveIds || [],
    };
  });
}

route('PUT', '/api/hr/programmes/:id/draft', async (req) => {
  const p = await must('programme', req.params.id, 'Programme');
  if (p.status === 'archived') fail(409, 'Archived programmes cannot be edited. Duplicate it to start a new version.');
  const objectives = cleanObjectives(req.body?.objectives);
  const topics = cleanTopics(req.body?.topics);
  const objIds = new Set(objectives.map((o) => o.id));
  for (const t of topics) t.objectiveIds = t.objectiveIds.filter((id) => objIds.has(id));
  for (const o of objectives) o.topicIds = topics.filter((t) => t.objectiveIds.includes(o.id)).map((t) => t.id);
  const g = { objectives, topics, updatedAt: nowIso() };
  if (p.status === 'draft') { p.objectives = objectives; p.topics = topics; p.draft = null; } else p.draft = g;
  p.updatedAt = nowIso();
  await store().put('programme', p);
  return {
    programme: p, working: g, analysis: analysePlan(objectives, topics),
    changes: p.status === 'draft' ? [] : diffGuides({ objectives: p.objectives, topics: p.topics }, g), savedAt: p.updatedAt,
  };
}, { auth: true });

route('POST', '/api/hr/programmes/:id/plan', async (req) => {
  const p = await must('programme', req.params.id, 'Programme');
  const objectives = cleanObjectives(req.body?.objectives);
  if (!objectives.length) fail(400, 'Add at least one thing you want to understand first.');
  try {
    const plan = await proposePlan({ objectives, template: p.template, existingTopics: workingGuide(p).topics });
    return { ...plan, analysis: analysePlan(plan.objectives, plan.topics) };
  } catch (err) {
    console.error('plan failed', err);
    fail(503, 'The interview plan could not be generated just now. Your objectives are unchanged; please try again.');
  }
}, { auth: true });

route('POST', '/api/hr/programmes/:id/activate', async (req) => {
  const p = await must('programme', req.params.id, 'Programme');
  const g = workingGuide(p);
  if (!g.topics.length) fail(400, 'Add at least one topic before activating.');
  const a = analysePlan(g.objectives, g.topics);
  if (a.uncovered.length && !req.body?.acknowledgeGaps) fail(409, 'Some objectives have no topics in the guide.', { uncovered: a.uncovered });
  const prev = p.guideVersions[p.guideVersions.length - 1];
  const changes = prev ? diffGuides(prev, g) : ['Initial guide.'];
  if (prev && !changes.length && p.status !== 'paused') fail(409, 'There are no changes to activate.');
  const version = (prev?.version || 0) + 1;
  p.guideVersions.push({ version, activatedAt: nowIso(), objectives: structuredClone(g.objectives), topics: structuredClone(g.topics), changeSummary: changes.join('; ') });
  p.objectives = structuredClone(g.objectives);
  p.topics = structuredClone(g.topics);
  p.activeVersion = version;
  p.draft = null;
  p.status = 'active';
  p.updatedAt = nowIso();
  await store().put('programme', p);
  return { programme: p, version, changes };
}, { auth: true });

for (const [action, from, to] of [['pause', ['active'], 'paused'], ['resume', ['paused'], 'active'], ['archive', ['active', 'paused', 'draft'], 'archived']]) {
  route('POST', `/api/hr/programmes/:id/${action}`, async (req) => {
    const p = await must('programme', req.params.id, 'Programme');
    if (!from.includes(p.status)) fail(409, `A ${p.status} programme cannot be ${to}.`);
    if (action === 'resume' && !p.activeVersion) fail(409, 'Activate the guide first.');
    p.status = to;
    p.updatedAt = nowIso();
    await store().put('programme', p);
    return { programme: p };
  }, { auth: true });
}

route('POST', '/api/hr/programmes/:id/discard-draft', async (req) => {
  const p = await must('programme', req.params.id, 'Programme');
  p.draft = null;
  await store().put('programme', p);
  return { programme: p };
}, { auth: true });

// Live preview: a real interview against the working (possibly unsaved) guide.
route('POST', '/api/hr/programmes/:id/preview', async (req) => {
  const p = await must('programme', req.params.id, 'Programme');
  const b = req.body || {};
  const g = b.guide ? { objectives: cleanObjectives(b.guide.objectives), topics: cleanTopics(b.guide.topics) } : workingGuide(p);
  const s = await createSession({
    programme: p, participant: null, population: 'preview',
    body: { mode: b.mode || 'ai_text', language: b.language || 'en', duration: b.duration || 'standard', guide: { version: 'preview', ...structuredClone(g) } },
  });
  s.previewParticipant = b.segment || null;
  s.previewBy = req.user.email;
  await store().put('session', s);
  return { id: s.id, accessToken: s.accessToken };
}, { auth: true });
