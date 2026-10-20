// Insights, theme exploration, assistant, exports and analyst theme edits.
import { route, fail } from '../lib/http.js';
import { store, loadAll, nowIso } from '../lib/data.js';
import { computeInsights, themeDetail, asCsv, makeContext, quarterOf } from '../domain/analytics.js';
import { applyTaxonomy, validateEdit, EMPTY_TAXONOMY, themesWith } from '../domain/taxonomy.js';
import { ask, suggestedQuestions } from '../domain/assistant.js';
import { newId } from '../lib/ids.js';

// Defaults follow the workspace: demonstration data in the demo, live interviews in an organisation's own workspace.
export async function insightsFor(query) {
  const [data, taxonomy] = await Promise.all([loadAll(), store().get('meta', 'taxonomy')]);
  const own = !data.org?.demo;
  const q = {
    ...query,
    population: query.population || (own ? 'live' : 'demo'),
    programmeId: query.programmeId || (own ? (data.programmes.find((p) => p.status === 'active') || data.programmes[0])?.id : undefined),
    period: query.period || (own ? quarterOf(nowIso()) : undefined),
  };
  return computeInsights(makeContext(applyTaxonomy(data, taxonomy)), q);
}

function periodsAvailable(sessions) {
  const set = new Set();
  for (const s of sessions) if (s.submittedAt) set.add(quarterOf(s.submittedAt));
  set.add(quarterOf(nowIso()));
  return [...set].sort().reverse();
}

route('POST', '/api/hr/insights', async (req) => {
  const ins = await insightsFor(req.body?.query || {});
  const sessions = await store().list('session');
  return { ...ins, suggestions: suggestedQuestions(ins), periods: periodsAvailable(sessions) };
}, { auth: true });

route('POST', '/api/hr/insights/theme', async (req) => {
  const ins = await insightsFor(req.body?.query || {});
  const d = themeDetail(ins, req.body?.themeId);
  if (!d) fail(404, 'Theme not found.');
  return { ...d, scope: ins.scope, n: ins.current.n };
}, { auth: true });

route('POST', '/api/hr/insights/export', async (req) => {
  const ins = await insightsFor(req.body?.query || {});
  return { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="partways-findings.csv"' }, body: asCsv(ins) };
}, { auth: true });

route('POST', '/api/hr/assistant', async (req) => {
  const question = String(req.body?.question || '').trim().slice(0, 500);
  if (!question) fail(400, 'Ask a question.');
  const ins = await insightsFor(req.body?.query || {});
  try {
    const answer = await ask(ins, question, req.body?.history || []);
    return { answer: { ...answer, id: newId('ans'), question, query: ins.query, askedAt: nowIso(), n: ins.current.n } };
  } catch (err) {
    console.error('assistant failed', err);
    fail(503, 'The assistant could not answer just now. Please try again.');
  }
}, { auth: true });

route('GET', '/api/hr/taxonomy', async () => {
  const t = (await store().get('meta', 'taxonomy')) || EMPTY_TAXONOMY;
  return { taxonomy: t, themes: themesWith(t) };
}, { auth: true });

async function previewEdit(edit, query) {
  if (edit.op === 'split' && !edit.into) edit.into = `split_${String(edit.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'theme'}`;
  const taxonomy = (await store().get('meta', 'taxonomy')) || structuredClone(EMPTY_TAXONOMY);
  const err = validateEdit(edit, taxonomy);
  if (err) fail(400, err);
  const data = await loadAll();
  const before = computeInsights(makeContext(applyTaxonomy(data, taxonomy)), query);
  const next = { ...taxonomy, edits: [...taxonomy.edits, { ...edit, at: nowIso() }] };
  const after = computeInsights(makeContext(applyTaxonomy(data, next)), query);
  const ids = new Set([...(edit.from || []), edit.into, edit.theme].filter(Boolean));
  const row = (ins, id) => (ins.current.available && ins.current.themes[id] ? { id, label: ins.current.themes[id].label, respondents: ins.current.themes[id].respondents, confirmedReason: ins.current.themes[id].confirmedReason } : { id, removed: true });
  return { next, effect: { before: [...ids].map((id) => row(before, id)), after: [...ids].map((id) => row(after, id)), n: after.current.n } };
}

route('POST', '/api/hr/taxonomy/preview', async (req) => {
  const { effect } = await previewEdit(req.body?.edit || {}, req.body?.query || {});
  return { effect };
}, { auth: true });

route('POST', '/api/hr/taxonomy/apply', async (req) => {
  const { next, effect } = await previewEdit(req.body?.edit || {}, req.body?.query || {});
  await store().put('meta', next);
  return { taxonomy: next, effect };
}, { auth: true });

route('POST', '/api/hr/taxonomy/reset', async () => {
  await store().put('meta', structuredClone(EMPTY_TAXONOMY));
  return { ok: true };
}, { auth: true });

route('GET', '/api/hr/bookmarks', async () => ({ bookmarks: await store().list('bookmark') }), { auth: true });
route('POST', '/api/hr/bookmarks', async (req) => {
  const b = { id: newId('bm'), kind: req.body?.kind || 'theme', ref: req.body?.ref, title: String(req.body?.title || '').slice(0, 200), note: String(req.body?.note || '').slice(0, 1000), query: req.body?.query || null, createdAt: nowIso(), by: req.user.email };
  if (!b.ref || !b.title) fail(400, 'Nothing to bookmark.');
  await store().put('bookmark', b);
  return { bookmark: b };
}, { auth: true });
route('DELETE', '/api/hr/bookmarks/:id', async (req) => { await store().delete('bookmark', req.params.id); return { ok: true }; }, { auth: true });
