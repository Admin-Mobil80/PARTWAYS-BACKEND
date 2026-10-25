// Every number shown anywhere (dashboard, drill-down, assistant, reports, exports)
// comes from computeInsights, so all views agree for the same selection.
import { THEMES, DIMENSIONS, SECTIONS } from './catalog.js';

export const PERIOD_BASES = {
  submission: 'Feedback submitted in period',
  departure: 'Departure date in period',
  invitation: 'Invitation sent in period',
};

export function quarterOf(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

export function previousQuarter(q) {
  const [y, n] = q.split('-Q').map(Number);
  return n === 1 ? `${y - 1}-Q4` : `${y}-Q${n - 1}`;
}

export function quarterLabel(q) {
  const [y, n] = q.split('-Q');
  const months = ['Jan–Mar', 'Apr–Jun', 'Jul–Sep', 'Oct–Dec'][Number(n) - 1];
  return `Q${n} ${y} (${months})`;
}

const FILTER_KEYS = ['businessUnit', 'function', 'location', 'tenureBand', 'roleLevel', 'language', 'mode'];

export function normaliseQuery(q = {}) {
  const filters = {};
  for (const k of FILTER_KEYS) {
    const v = q.filters?.[k];
    if (v && (Array.isArray(v) ? v.length : true)) filters[k] = Array.isArray(v) ? v : [v];
  }
  return {
    programmeId: q.programmeId || 'prog_general',
    period: q.period || '2026-Q3',
    compareTo: q.compareTo === undefined ? previousQuarter(q.period || '2026-Q3') : q.compareTo,
    basis: PERIOD_BASES[q.basis] ? q.basis : 'submission',
    population: q.population || 'demo',
    filters,
  };
}

function inPopulation(rec, population) {
  if (population === 'all') return ['demo', 'evaluation', 'live'].includes(rec.population || 'demo');
  return (rec.population || 'demo') === population;
}

function matchesSegment(participant, session, filters) {
  for (const [k, vals] of Object.entries(filters)) {
    if (k === 'language') { if (!session || !vals.includes(session.language)) return false; continue; }
    if (k === 'mode') { if (!session || !vals.some((m) => (session.modesUsed || [session.mode]).includes(m))) return false; continue; }
    if (!vals.includes(participant[k])) return false;
  }
  return true;
}

function basisDate(basis, participant, session) {
  if (basis === 'departure') return participant.departureDate;
  if (basis === 'invitation') return participant.invitation?.sentAt;
  return session?.submittedAt;
}

// The latest session per participant represents them, so each person counts once.
function primarySession(participant, sessionsById) {
  const list = (participant.sessionIds || []).map((id) => sessionsById[id]).filter(Boolean);
  return list.find((s) => s.status === 'submitted') || list.find((s) => s.status === 'withdrawn') || list[list.length - 1] || null;
}

const keptPoints = (s) => (s.summary?.points || []).filter((p) => p.status !== 'removed');

function themeTone(points) {
  const tones = new Set(points.map((p) => p.tone));
  if (tones.has('positive') && tones.has('negative')) return 'mixed';
  if (tones.has('mixed')) return 'mixed';
  if (tones.has('negative')) return 'negative';
  if (tones.has('positive')) return 'positive';
  return 'neutral';
}

function pct(n, d) { return d ? n / d : null; }

function themeStats(sessions, guideTopicsFor, themes = THEMES) {
  const N = sessions.length;
  const out = {};
  for (const [id, meta] of Object.entries(themes)) {
    const rec = { id, label: meta.label, description: meta.description, respondents: 0, mentions: 0,
      tone: { positive: 0, negative: 0, mixed: 0, neutral: 0 }, confirmedReason: 0, primary: 0, suggestedOnly: 0, pull: 0,
      subthemes: {}, addressed: 0, sessionIds: [] };
    for (const s of sessions) {
      const pts = keptPoints(s).filter((p) => p.themes.includes(id));
      const factors = (s.summary?.factors || []).filter((f) => f.theme === id && f.status !== 'rejected');
      const topics = guideTopicsFor(s).filter((t) => t.themes?.includes(id));
      if (topics.some((t) => ['explored', 'insufficient'].includes(s.coverage?.[t.id])) || pts.length) rec.addressed++;
      if (!pts.length && !factors.length) continue;
      if (pts.length) {
        rec.respondents++;
        rec.sessionIds.push(s.id);
        rec.mentions += pts.reduce((a, p) => a + (p.mentions || 1), 0);
        rec.tone[themeTone(pts)]++;
        for (const p of pts) if (p.sub) rec.subthemes[p.sub] = (rec.subthemes[p.sub] || 0) + 1;
      }
      const confirmed = factors.filter((f) => f.status === 'confirmed' && f.role !== 'pull');
      if (confirmed.length) rec.confirmedReason++;
      if (confirmed.some((f) => f.rank === 1)) rec.primary++;
      if (!confirmed.length && factors.some((f) => f.status === 'suggested')) rec.suggestedOnly++;
      if (factors.some((f) => f.role === 'pull')) rec.pull++;
    }
    rec.share = pct(rec.respondents, N);
    rec.reasonShare = pct(rec.confirmedReason, N);
    rec.primaryShare = pct(rec.primary, N);
    rec.coverageShare = rec.addressed ? rec.respondents / rec.addressed : null;
    out[id] = rec;
  }
  return out;
}

export function makeContext(data) {
  const sessionsById = Object.fromEntries(data.sessions.map((s) => [s.id, s]));
  const progById = Object.fromEntries(data.programmes.map((p) => [p.id, p]));
  const guideFor = (s) => {
    const p = progById[s.programmeId];
    return p?.guideVersions.find((g) => g.version === s.guideVersion) || { topics: p?.topics || [], objectives: p?.objectives || [] };
  };
  return { ...data, themes: data.themes || THEMES, sessionsById, progById, guideFor, guideTopicsFor: (s) => guideFor(s).topics };
}

function selectPopulation(ctx, q, period) {
  const programmes = q.programmeId === 'all' ? ctx.programmes.filter((p) => p.status !== 'draft') : [ctx.progById[q.programmeId]].filter(Boolean);
  const progIds = new Set(programmes.map((p) => p.id));
  const parts = ctx.participants.filter((p) => progIds.has(p.programmeId) && inPopulation(p, q.population));
  const rows = parts.map((p) => ({ p, s: primarySession(p, ctx.sessionsById) }));

  // Participation uses the invitation cohort; findings use the selected basis.
  const cohort = rows.filter(({ p, s }) => quarterOf(p.invitation?.sentAt) === period
    && !['prepared', 'cancelled'].includes(p.invitation?.status) && matchesSegment(p, s, filterWithoutSession(q.filters)));
  const started = cohort.filter(({ p, s }) => s || ['in_progress', 'awaiting_review', 'submitted', 'withdrawn'].includes(p.status));
  const submittedInCohort = cohort.filter(({ s }) => s?.status === 'submitted');

  const findings = rows.filter(({ p, s }) => s?.status === 'submitted'
    && quarterOf(basisDate(q.basis, p, s)) === period && matchesSegment(p, s, q.filters));

  return { programmes, cohort, started, submittedInCohort, findings };
}

function filterWithoutSession(filters) {
  const f = { ...filters };
  delete f.language; delete f.mode;
  return f;
}

function minimumFor(programmes) {
  return Math.max(...programmes.map((p) => p.reportingMinimum || 3), 1);
}

function reportingModeFor(programmes) {
  return programmes.some((p) => p.reportingMode === 'aggregate') ? 'aggregate' : 'individual';
}

function core(ctx, q, period) {
  const pop = selectPopulation(ctx, q, period);
  const sessions = pop.findings.map(({ s }) => s);
  const N = sessions.length;
  const min = minimumFor(pop.programmes);
  const themes = themeStats(sessions, ctx.guideTopicsFor, ctx.themes);
  const modeMix = { initial: {}, used: {} };
  const durations = {};
  const prevent = { yes: 0, maybe: 0, no: 0, unsure: 0, not_discussed: 0 };
  const ratings = { ease: [], heard: [], accuracy: [] };
  let noSingle = 0;
  for (const s of sessions) {
    modeMix.initial[s.initialMode] = (modeMix.initial[s.initialMode] || 0) + 1;
    for (const m of new Set(s.modesUsed || [s.mode])) modeMix.used[m] = (modeMix.used[m] || 0) + 1;
    (durations[s.mode] ||= []).push(s.activeMs || 0);
    prevent[s.summary?.preventability || 'not_discussed']++;
    if (s.summary?.noSingleMainReason) noSingle++;
    for (const k of Object.keys(ratings)) if (s.ratings?.[k]) ratings[k].push(s.ratings[k]);
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return {
    period, periodLabel: quarterLabel(period), n: N, minimum: min,
    available: N >= min,
    participation: {
      eligible: pop.cohort.length, started: pop.started.length, submitted: pop.submittedInCohort.length,
      participationRate: pct(pop.started.length, pop.cohort.length),
      submissionRate: pct(pop.submittedInCohort.length, pop.cohort.length),
      completionAfterStart: pct(pop.submittedInCohort.length, pop.started.length),
      statusCounts: countBy(pop.cohort, ({ p }) => p.status),
    },
    themes, modeMix,
    durationMinutes: Object.fromEntries(Object.entries(durations).map(([m, a]) => [m, avg(a) / 60000])),
    preventability: prevent, noSingleMainReason: noSingle,
    experience: Object.fromEntries(Object.entries(ratings).map(([k, a]) => [k, { average: avg(a), n: a.length }])),
    _rows: pop.findings, _programmes: pop.programmes,
  };
}

function countBy(arr, fn) {
  const o = {};
  for (const x of arr) { const k = fn(x); o[k] = (o[k] || 0) + 1; }
  return o;
}

function segments(ctx, rows, min) {
  const out = {};
  for (const d of DIMENSIONS) {
    const groups = {};
    for (const r of rows) (groups[r.p[d.key]] ||= []).push(r.s);
    out[d.key] = {
      label: d.label,
      groups: Object.entries(groups).sort((a, b) => b[1].length - a[1].length).map(([value, ss]) => {
        if (ss.length < min) return { value, n: ss.length, available: false };
        const th = themeStats(ss, ctx.guideTopicsFor, ctx.themes);
        return {
          value, n: ss.length, available: true,
          themes: Object.fromEntries(Object.values(th).filter((t) => t.respondents).map((t) => [t.id, { respondents: t.respondents, share: t.share, primary: t.primary, negative: t.tone.negative + t.tone.mixed, positive: t.tone.positive }])),
        };
      }),
    };
  }
  return out;
}

function comparison(now, prev) {
  if (!prev) return null;
  const rows = Object.keys(now.themes).map((id) => {
    const a = now.themes[id], b = prev.themes[id];
    const pp = a.share != null && b.share != null ? (a.share - b.share) * 100 : null;
    const rel = b.respondents ? (a.respondents - b.respondents) / b.respondents : null;
    return { id, label: a.label, now: a.respondents, nowShare: a.share, prev: b.respondents, prevShare: b.share, ppChange: pp, relativeChange: rel,
      primaryNow: a.primary, primaryPrev: b.primary };
  }).filter((r) => r.now || r.prev);
  return {
    period: prev.period, periodLabel: prev.periodLabel, n: prev.n, available: prev.available && now.available,
    compositionNote: compositionNote(now, prev), rows,
  };
}

function compositionNote(now, prev) {
  const notes = [];
  if (Math.abs(now.n - prev.n) >= Math.max(5, prev.n * 0.25)) notes.push(`The number of submitted responses changed from ${prev.n} to ${now.n}.`);
  const unitShare = (c) => countBy(c._rows, ({ p }) => p.businessUnit);
  const a = unitShare(now), b = unitShare(prev);
  for (const u of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const sa = (a[u] || 0) / (now.n || 1), sb = (b[u] || 0) / (prev.n || 1);
    if (Math.abs(sa - sb) >= 0.1) notes.push(`${u} made up ${fmtPct(sa)} of responses, compared with ${fmtPct(sb)} in the earlier period.`);
  }
  return notes;
}

export function fmtPct(x, digits = 0) {
  if (x == null || Number.isNaN(x)) return '–';
  return `${(x * 100).toFixed(digits)}%`;
}

function objectiveFindings(ctx, rows, programmes, min, mode) {
  const out = [];
  for (const prog of programmes) {
    for (const obj of prog.objectives || []) {
      const counts = { explored: 0, insufficient: 0, skipped: 0, declined: 0, not_asked: 0, not_applicable: 0, not_in_guide: 0 };
      const contributing = [];
      for (const r of rows.filter((x) => x.p.programmeId === prog.id)) {
        const guide = ctx.guideFor(r.s);
        if (!guide.objectives?.some((o) => o.id === obj.id)) { counts.not_in_guide++; continue; }
        if (obj.appliesTo && !obj.appliesTo.values.includes(r.p[obj.appliesTo.dimension])) { counts.not_applicable++; continue; }
        const states = obj.topicIds.map((t) => r.s.coverage?.[t]).filter(Boolean);
        const st = states.includes('explored') ? 'explored' : states.includes('insufficient') ? 'insufficient'
          : states.includes('declined') ? 'declined' : states.includes('skipped') ? 'skipped' : 'not_asked';
        counts[st]++;
        if (st === 'explored' || st === 'insufficient') contributing.push(r);
      }
      const evidenceSessions = contributing.map((r) => r.s);
      const lens = objectiveLens(obj);
      const th = themeStats(evidenceSessions, ctx.guideTopicsFor, ctx.themes);
      let themesRanked;
      if (lens === 'drivers') themesRanked = Object.values(th).filter((t) => t.confirmedReason).sort((a, b) => b.primary - a.primary || b.confirmedReason - a.confirmedReason).map((t) => ({ id: t.id, label: t.label, n: t.confirmedReason, primary: t.primary, measure: 'confirmed reason' }));
      else if (lens === 'positives') themesRanked = Object.values(th).filter((t) => t.tone.positive + t.tone.mixed).sort((a, b) => (b.tone.positive + b.tone.mixed) - (a.tone.positive + a.tone.mixed)).map((t) => ({ id: t.id, label: t.label, n: t.tone.positive + t.tone.mixed, measure: 'positive or mixed' }));
      else themesRanked = obj.themeIds.map((id) => th[id]).filter((t) => t?.respondents).map((t) => ({ id: t.id, label: t.label, n: t.respondents, tone: t.tone, subthemes: t.subthemes, measure: 'raised' }));
      const relevantPoints = evidenceSessions.flatMap((s) => keptPoints(s).filter((p) => lens === 'drivers' ? p.section === 'main_reasons'
        : lens === 'positives' ? p.tone === 'positive' : p.themes.some((t) => obj.themeIds.includes(t))));
      const addressed = counts.explored + counts.insufficient;
      const strongest = themesRanked[0];
      let status = 'insufficient';
      if (addressed >= min && strongest && strongest.n >= 3) status = 'supported';
      else if (addressed > 0 && relevantPoints.length > 0) status = 'emerging';
      const unclear = [];
      if (counts.not_asked + counts.skipped + counts.declined > 0) unclear.push(`${counts.not_asked + counts.skipped + counts.declined} of ${rows.filter((x) => x.p.programmeId === prog.id).length} respondents did not discuss this (${counts.not_asked} not asked, ${counts.skipped} skipped, ${counts.declined} declined).`);
      if (counts.not_in_guide) unclear.push(`${counts.not_in_guide} responses used an earlier guide version that did not include this objective.`);
      if (counts.insufficient) unclear.push(`${counts.insufficient} ${counts.insufficient === 1 ? 'conversation' : 'conversations'} touched on this only briefly.`);
      if (addressed < min) unclear.push(`Fewer than ${min} respondents addressed this objective, which is below the reporting minimum.`);
      if (status !== 'insufficient' && lens === 'themes' && themesRanked.length === 0) unclear.push('Respondents discussed the topic, but their accounts did not form a consistent theme.');
      const suggested = Object.values(th).reduce((a, t) => a + t.suggestedOnly, 0);
      if (suggested && lens === 'drivers') unclear.push(`${suggested} suggested departure ${suggested === 1 ? 'factor was' : 'factors were'} not confirmed by the employee and are excluded from confirmed reasons.`);
      out.push({
        id: obj.id, programmeId: prog.id, programmeName: prog.name, title: obj.title, description: obj.description,
        priority: obj.priority, lens, counts, addressed, total: rows.filter((x) => x.p.programmeId === prog.id).length,
        status, themes: status === 'insufficient' && addressed < min ? [] : themesRanked.slice(0, 4),
        heard: status === 'insufficient' ? null : summariseObjective(lens, themesRanked, addressed),
        evidence: status === 'insufficient' ? [] : evidenceList(relevantPoints, rows, mode, 4),
        unclear,
      });
    }
  }
  return out;
}

function objectiveLens(obj) {
  if (obj.themeIds?.length) return 'themes';
  if (obj.topicIds.includes('positives')) return 'positives';
  if (obj.topicIds.some((t) => ['reasons', 'experience', 'preventability'].includes(t))) return 'drivers';
  return 'themes';
}

function summariseObjective(lens, ranked, addressed) {
  if (!ranked.length) return `Respondents addressed this (${addressed}), but no recurring pattern emerged.`;
  const top = ranked.slice(0, 3).map((t) => `${t.label.toLowerCase()} (${t.n} of ${addressed})`);
  if (lens === 'drivers') return `The most frequently confirmed reasons were ${listJoin(top)}.`;
  if (lens === 'positives') return `Positive accounts most often concerned ${listJoin(top)}.`;
  return `Of ${addressed} respondents who addressed this, the recurring themes were ${listJoin(top)}.`;
}

export function listJoin(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function describeRespondent(p, s) {
  const mode = { ai_voice: 'Voice', ai_text: 'Text' }[s.mode];
  return `${p.businessUnit} · ${p.tenureBand} · ${mode} · ${quarterLabel(quarterOf(s.submittedAt)).split(' (')[0]}`;
}

// In aggregate mode individual wording is never returned, by any route.
export function evidenceList(points, rows, mode, limit = 50) {
  if (mode === 'aggregate') return [];
  const owner = new Map();
  for (const r of rows) for (const p of keptPoints(r.s)) owner.set(p, r);
  // Identical accounts from several people are shown once, with a count.
  const seen = new Map();
  const out = [];
  for (const pt of points) {
    const key = pt.evidence?.[0]?.text || pt.text;
    if (seen.has(key)) { seen.get(key).similar++; continue; }
    if (out.length >= limit) continue;
    const r = owner.get(pt);
    const ev = pt.evidence?.[0];
    const item = {
      sessionId: r?.s.id, pointId: pt.id, summary: pt.textEn || pt.text, translated: !!pt.textEn || !!pt.translatedFrom, section: SECTIONS[pt.section], tone: pt.tone,
      kind: ev?.kind || 'paraphrase', text: ev?.text || pt.text, lang: ev?.lang || 'en', translation: ev?.translation || null,
      respondent: r ? describeRespondent(r.p, r.s) : '', mentions: pt.mentions || 1, similar: 0,
    };
    seen.set(key, item);
    out.push(item);
  }
  return out;
}

function narrative(cur, cmp, objectives, segs) {
  const out = { hearing: [], changed: [], attention: [], working: [], objectives: [] };
  if (!cur.available) return out;
  const reasons = Object.values(cur.themes).filter((t) => t.primary).sort((a, b) => b.primary - a.primary).slice(0, 3);
  if (reasons.length) {
    out.hearing.push({
      text: `The most common confirmed main reasons for leaving were ${listJoin(reasons.map((t) => `${t.label.toLowerCase()} (${t.primary} of ${cur.n})`))}.`,
      refs: reasons.map((t) => ({ type: 'theme', id: t.id })),
    });
  }
  const unavoidable = cur.themes.personal_circumstances.primary + cur.themes.contract_end.primary;
  if (unavoidable) out.hearing.push({ text: `${unavoidable} of ${cur.n} departures were for personal circumstances or a contract ending, and most of these respondents described their experience positively.`, refs: [{ type: 'theme', id: 'personal_circumstances' }] });

  if (cmp?.available) {
    const moves = cmp.rows.filter((r) => r.ppChange != null && Math.abs(r.now - r.prev) >= 3).sort((a, b) => Math.abs(b.ppChange) - Math.abs(a.ppChange)).slice(0, 2);
    for (const m of moves) {
      out.changed.push({
        text: `${m.label} was raised by ${m.now} of ${cur.n} respondents (${fmtPct(m.nowShare)}), compared with ${m.prev} of ${cmp.n} (${fmtPct(m.prevShare)}) in ${cmp.periodLabel.split(' (')[0]}: a change of ${m.ppChange > 0 ? '+' : ''}${m.ppChange.toFixed(0)} percentage points.`,
        refs: [{ type: 'comparison', id: m.id }],
      });
    }
    if (!moves.length) out.changed.push({ text: 'No theme changed by three or more respondents compared with the previous period.', refs: [{ type: 'comparison' }] });
    for (const n of cmp.compositionNote) out.changed.push({ text: n, refs: [{ type: 'comparison' }], caveat: true });
  } else if (cmp) {
    out.changed.push({ text: 'A comparison with the previous period is not available because one of the periods is below the reporting minimum.', refs: [], caveat: true });
  }

  const unit = segs.businessUnit.groups.filter((g) => g.available);
  let best = null;
  for (const g of unit) {
    for (const [id, t] of Object.entries(g.themes)) {
      const overall = cur.themes[id];
      if (t.negative >= 3 && t.share - overall.share >= 0.2 && (!best || t.share - overall.share > best.gap)) best = { g, id, t, gap: t.share - overall.share };
    }
  }
  if (best) out.attention.push({ text: `${cur.themes[best.id].label} is concentrated in ${best.g.value}: raised by ${best.t.respondents} of ${best.g.n} respondents there (${fmtPct(best.t.share)}), against ${fmtPct(cur.themes[best.id].share)} overall.`, refs: [{ type: 'segment', dimension: 'businessUnit', value: best.g.value, id: best.id }] });
  const hidden = segs.businessUnit.groups.filter((g) => !g.available);
  if (hidden.length) out.attention.push({ text: `${hidden.length} business unit${hidden.length > 1 ? 's have' : ' has'} fewer than ${cur.minimum} responses, so ${hidden.length > 1 ? 'they are' : 'it is'} not shown separately.`, refs: [], caveat: true });

  const positives = Object.values(cur.themes).filter((t) => t.tone.positive).sort((a, b) => b.tone.positive - a.tone.positive).slice(0, 2);
  for (const t of positives) {
    const mixed = t.tone.mixed || t.tone.negative ? ` (${t.tone.negative + t.tone.mixed} described it negatively or with mixed views)` : '';
    out.working.push({ text: `${t.tone.positive} respondents spoke positively about ${t.label.toLowerCase()}${mixed}.`, refs: [{ type: 'theme', id: t.id }] });
  }
  for (const o of objectives) {
    out.objectives.push({ text: o.status === 'insufficient' ? `Not enough evidence yet: “${o.title}”. ${o.unclear[0] || ''}` : `${o.title}: ${o.heard}`, refs: [{ type: 'objective', id: o.id }], status: o.status });
  }
  return out;
}

export function computeInsights(data, query = {}) {
  const ctx = data.sessionsById ? data : makeContext(data);
  const q = normaliseQuery(query);
  const cur = core(ctx, q, q.period);
  const prev = q.compareTo ? core(ctx, q, q.compareTo) : null;
  const mode = reportingModeFor(cur._programmes);
  const segs = segments(ctx, cur._rows, cur.minimum);
  const objectives = objectiveFindings(ctx, cur._rows, cur._programmes, cur.minimum, mode);
  const cmp = prev ? comparison(cur, prev) : null;
  const result = {
    query: q, generatedAt: new Date().toISOString(),
    scope: {
      programmes: cur._programmes.map((p) => ({ id: p.id, name: p.name })),
      periodLabel: cur.periodLabel, basis: q.basis, basisLabel: PERIOD_BASES[q.basis], population: q.population,
      filters: q.filters, reportingMode: mode, minimum: cur.minimum,
    },
    current: strip(cur),
    previous: prev ? strip(prev) : null,
    comparison: cmp,
    segments: cur.available ? segs : null,
    objectives,
    narrative: narrative(cur, cmp, objectives, segs),
  };
  Object.defineProperty(result, '_rows', { value: cur._rows, enumerable: false });
  Object.defineProperty(result, '_ctx', { value: ctx, enumerable: false });
  return result;
}

function strip(c) {
  const { _rows, _programmes, ...rest } = c;
  if (!c.available) {
    // Below the reporting minimum nothing derived from feedback content is returned.
    return { ...rest, themes: null, preventability: null, noSingleMainReason: null, experience: null, durationMinutes: null };
  }
  rest.themes = Object.fromEntries(Object.entries(rest.themes).map(([k, v]) => { const { sessionIds, ...t } = v; return [k, t]; }));
  return rest;
}

export function themeDetail(insights, themeId) {
  const ctx = insights._ctx;
  const rows = insights._rows;
  const cur = insights.current;
  if (!cur.available) return { available: false, minimum: cur.minimum, n: cur.n };
  const t = cur.themes[themeId];
  if (!t) return null;
  const sessions = rows.filter((r) => keptPoints(r.s).some((p) => p.themes.includes(themeId)));
  const points = sessions.flatMap((r) => keptPoints(r.s).filter((p) => p.themes.includes(themeId)));
  const trend = [insights.previous, cur].filter(Boolean).map((c) => ({ period: c.period, label: c.periodLabel, n: c.n, available: c.available, respondents: c.available ? c.themes[themeId].respondents : null, share: c.available ? c.themes[themeId].share : null }));
  const segs = {};
  for (const [dim, s] of Object.entries(insights.segments || {})) {
    segs[dim] = { label: s.label, groups: s.groups.map((g) => g.available ? { value: g.value, n: g.n, available: true, respondents: g.themes[themeId]?.respondents || 0, share: g.themes[themeId]?.share || 0 } : g) };
  }
  const mode = insights.scope.reportingMode;
  const byTone = { positive: [], negative: [], mixed: [], neutral: [] };
  for (const p of points) byTone[p.tone]?.push(p);
  return {
    available: true, theme: { ...t, id: themeId, subthemeList: ctx.themes[themeId]?.subthemes || [] },
    trend, segments: segs, reportingMode: mode,
    evidence: {
      positive: evidenceList(byTone.positive, rows, mode), negative: evidenceList(byTone.negative, rows, mode),
      mixed: evidenceList(byTone.mixed, rows, mode), neutral: evidenceList(byTone.neutral, rows, mode),
    },
    aggregateSummary: mode === 'aggregate' ? Object.entries(t.subthemes).map(([k, v]) => ({ subtheme: k, respondents: v })) : null,
    ctxNote: ctx ? null : null,
  };
}

export function asCsv(insights) {
  const c = insights.current;
  const lines = [
    ['PartWays export', 'Fictional demonstration data'],
    ['Programmes', insights.scope.programmes.map((p) => p.name).join('; ')],
    ['Period', insights.scope.periodLabel], ['Period basis', insights.scope.basisLabel],
    ['Filters', Object.entries(insights.scope.filters).map(([k, v]) => `${k}=${v.join('|')}`).join('; ') || 'None'],
    ['Submitted responses', c.n], ['Eligible invited participants', c.participation.eligible],
    [],
  ];
  if (!c.available) {
    lines.push([`Not enough responses to show findings (minimum ${c.minimum}).`]);
  } else {
    lines.push(['Theme', 'Respondents', 'Share of submitted', 'Confirmed reason', 'Main reason', 'Positive', 'Negative', 'Mixed', 'Mentions (all)']);
    for (const t of Object.values(c.themes).filter((x) => x.respondents || x.confirmedReason)) {
      lines.push([t.label, t.respondents, fmtPct(t.share, 1), t.confirmedReason, t.primary, t.tone.positive, t.tone.negative, t.tone.mixed, t.mentions]);
    }
  }
  return lines.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
}
