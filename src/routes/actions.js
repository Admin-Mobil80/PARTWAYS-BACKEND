// Improvement actions: owned, dated, linked to evidence, with progress history.
import { route, fail } from '../lib/http.js';
import { store, must, nowIso, loadAll } from '../lib/data.js';
import { newId } from '../lib/ids.js';
import { computeInsights, makeContext, quarterOf, previousQuarter } from '../domain/analytics.js';
import { applyTaxonomy } from '../domain/taxonomy.js';

const STATUSES = ['proposed', 'accepted', 'in_progress', 'completed', 'closed'];
const LABEL = { proposed: 'proposed', accepted: 'accepted', in_progress: 'in progress', completed: 'completed', closed: 'closed without action' };
const today = () => nowIso().slice(0, 10);
const decorate = (a) => ({ ...a, overdue: !!a.dueDate && a.dueDate < today() && !['completed', 'closed'].includes(a.status) });

function clean(b, partial = false) {
  const out = {};
  const str = (k, max) => { if (b[k] !== undefined) out[k] = String(b[k] || '').trim().slice(0, max); };
  str('title', 200); str('outcome', 1000); str('owner', 120); str('successMeasure', 1000);
  if (b.dueDate !== undefined) { if (b.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(b.dueDate)) fail(400, 'Use a valid due date.'); out.dueDate = b.dueDate || null; }
  if (Array.isArray(b.themes)) out.themes = b.themes.slice(0, 6);
  if (!partial) {
    for (const k of ['title', 'owner', 'outcome']) if (!out[k]) fail(400, `Add ${k === 'outcome' ? 'the intended outcome' : `a ${k}`}.`);
  } else {
    for (const k of ['title', 'owner']) if (out[k] === '') fail(400, `The ${k} cannot be empty.`);
  }
  return out;
}

route('GET', '/api/hr/actions', async () => ({ actions: (await store().list('action')).map(decorate).sort((a, b) => (a.dueDate || '9').localeCompare(b.dueDate || '9')), statuses: LABEL }), { auth: true });

route('POST', '/api/hr/actions', async (req) => {
  const b = req.body || {};
  const a = {
    id: newId('act'), ...clean(b), status: 'proposed', programmeId: b.programmeId || null,
    themes: b.themes || [], evidence: b.evidence || null, notes: [], createdAt: nowIso(), closingNote: null,
    history: [{ at: nowIso(), change: b.evidence ? 'Created from finding' : 'Created', by: req.user.email }],
  };
  await store().put('action', a);
  return { action: decorate(a) };
}, { auth: true });

route('GET', '/api/hr/actions/:id', async (req) => {
  const a = await must('action', req.params.id, 'Action');
  // Subsequent feedback on the action's themes: observed change, not proof of effect.
  let related = null;
  if (a.programmeId && a.themes.length) {
    const data = makeContext(applyTaxonomy(await loadAll(), await store().get('meta', 'taxonomy')));
    const startQ = previousQuarter(quarterOf(a.createdAt));
    const periods = [startQ];
    let q = startQ;
    while (q < quarterOf(nowIso())) { q = q.endsWith('Q4') ? `${Number(q.slice(0, 4)) + 1}-Q1` : `${q.slice(0, 6)}${Number(q.slice(6)) + 1}`; periods.push(q); }
    related = {
      note: 'Shows what later respondents said on the same themes. A change after an action does not show that the action caused it.',
      periods: periods.map((p) => {
        const ins = computeInsights(data, { programmeId: a.programmeId, period: p, compareTo: null });
        return { period: p, label: ins.current.periodLabel, n: ins.current.n, available: ins.current.available, inProgress: p === quarterOf(nowIso()),
          themes: a.themes.map((t) => ({ id: t, label: ins.current.available ? ins.current.themes[t]?.label : t, respondents: ins.current.available ? ins.current.themes[t]?.respondents : null, share: ins.current.available ? ins.current.themes[t]?.share : null })) };
      }),
    };
  }
  return { action: decorate(a), related };
}, { auth: true });

route('PUT', '/api/hr/actions/:id', async (req) => {
  const a = await must('action', req.params.id, 'Action');
  const patch = clean(req.body || {}, true);
  const changes = Object.entries(patch).filter(([k, v]) => JSON.stringify(a[k]) !== JSON.stringify(v)).map(([k]) => k);
  Object.assign(a, patch);
  if (changes.length) a.history.push({ at: nowIso(), change: `Updated ${changes.join(', ')}`, by: req.user.email });
  await store().put('action', a);
  return { action: decorate(a) };
}, { auth: true });

route('POST', '/api/hr/actions/:id/status', async (req) => {
  const a = await must('action', req.params.id, 'Action');
  const status = req.body?.status;
  if (!STATUSES.includes(status)) fail(400, 'Unknown status.');
  const note = String(req.body?.note || '').trim();
  if (status === 'closed' && !note) fail(400, 'Give a reason for closing without action.');
  if (status === 'completed' && !note) fail(400, 'Add a short outcome note before completing.');
  const prev = a.status;
  a.status = status;
  if (['closed', 'completed'].includes(status)) a.closingNote = note;
  a.history.push({ at: nowIso(), change: `Status: ${LABEL[prev]} → ${LABEL[status]}`, by: req.user.email, note: note || undefined });
  await store().put('action', a);
  return { action: decorate(a) };
}, { auth: true });

route('POST', '/api/hr/actions/:id/notes', async (req) => {
  const a = await must('action', req.params.id, 'Action');
  const text = String(req.body?.text || '').trim().slice(0, 2000);
  const link = String(req.body?.link || '').trim();
  if (!text) fail(400, 'Write a progress note.');
  if (link && !/^https?:\/\//.test(link)) fail(400, 'Links must start with http:// or https://');
  a.notes.push({ at: nowIso(), author: req.user.email, text, link: link || undefined });
  a.history.push({ at: nowIso(), change: 'Progress note added', by: req.user.email });
  await store().put('action', a);
  return { action: decorate(a) };
}, { auth: true });
