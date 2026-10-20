// Insight assistant: answers questions from the same insights object the dashboard
// uses, so numbers agree, and never sees quotes the reporting mode withholds.
import { THEMES } from './catalog.js';
import { fmtPct, listJoin, evidenceList, themeDetail } from './analytics.js';
import { llmInfo, generateJson } from '../llm/index.js';
import { detectThemes } from './offline.js';

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['answerable', 'said', 'interpretation', 'suggestion', 'gap', 'table', 'refs'],
  properties: {
    answerable: { type: 'boolean' },
    said: { type: 'string' },
    interpretation: { type: 'string' },
    suggestion: { type: 'string' },
    gap: { type: 'string' },
    table: {
      type: 'object', additionalProperties: false, required: ['columns', 'rows'],
      properties: { columns: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } } },
    },
    refs: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['type', 'id'], properties: { type: { type: 'string', enum: ['theme', 'objective', 'comparison', 'segment'] }, id: { type: 'string' } } } },
  },
};

const SYSTEM = `You are the insight assistant in PartWays, an exit-interview analysis product. You answer HR questions using only the data provided, which describes submitted, employee-reviewed exit feedback for a specific programme, period and filter selection.

Rules:
- Use only the numbers given. Copy counts and percentages exactly; never estimate, round differently or invent figures, quotes or evidence.
- "said": what respondents said, with counts (for example "9 of 29 respondents").
- "interpretation": a cautious reading of the pattern, clearly framed as interpretation. Leave empty if not warranted.
- "suggestion": an optional suggested next step grounded in the findings, framed as a suggestion, not a proven solution. Leave empty unless useful.
- If the data cannot answer the question, set answerable=false and explain in "gap" exactly what is missing (for example: the topic was not asked, the group is below the reporting minimum, the period has no data, or the data does not include that dimension). Never fill gaps with generic HR advice.
- Groups marked unavailable are below the reporting minimum: say so and do not describe their content.
- Mentioning a topic is not the same as leaving because of it: distinguish confirmed reasons from topics raised.
- Exit feedback describes the people who responded, not the whole workforce, and does not prove causes.
- Only quote wording that appears in the evidence list, and label translated quotes as translations. If the evidence list is empty, no individual quotes are available.
- "table": include a table only when the user asks for one or a comparison is clearer as a table; otherwise columns and rows are empty arrays.
- "refs": the themes, objectives, comparisons or segments that support the answer, using the ids given.
- Write in plain British English.`;

export function compactContext(ins) {
  const c = ins.current;
  const lines = [];
  lines.push(`Scope: ${ins.scope.programmes.map((p) => p.name).join(', ')}; ${ins.scope.periodLabel}; basis: ${ins.scope.basisLabel}; filters: ${JSON.stringify(ins.scope.filters)}; reporting mode: ${ins.scope.reportingMode}; reporting minimum: ${ins.scope.minimum}; population: ${ins.scope.population === 'demo' ? 'fictional demonstration data' : ins.scope.population}.`);
  lines.push(`Submitted responses: ${c.n}. Invited: ${c.participation.eligible}, started: ${c.participation.started}, submitted from this invitation cohort: ${c.participation.submitted}.`);
  if (!c.available) {
    lines.push(`This selection is BELOW the reporting minimum (${c.n} < ${c.minimum}). No findings may be described.`);
    return lines.join('\n');
  }
  lines.push('\nThemes (respondents = unique people; share = of submitted; confirmed = employee-confirmed reason for leaving; main = confirmed main reason; tone counts per person):');
  for (const t of Object.values(c.themes).filter((x) => x.respondents || x.confirmedReason)) {
    lines.push(`- ${t.id} "${t.label}": respondents ${t.respondents} (${fmtPct(t.share)}), confirmed reason ${t.confirmedReason}, main reason ${t.primary}, suggested but unconfirmed ${t.suggestedOnly}, tone +${t.tone.positive}/-${t.tone.negative}/mixed ${t.tone.mixed}/neutral ${t.tone.neutral}, mentions ${t.mentions}, subthemes ${JSON.stringify(t.subthemes)}`);
  }
  lines.push(`No single main reason: ${c.noSingleMainReason}. Preventability (employee view): ${JSON.stringify(c.preventability)}.`);
  if (ins.comparison) {
    lines.push(`\nComparison with ${ins.comparison.periodLabel} (n=${ins.comparison.n}, available=${ins.comparison.available}):`);
    for (const r of ins.comparison.rows) lines.push(`- ${r.id}: ${r.prev} of ${ins.comparison.n} (${fmtPct(r.prevShare)}) → ${r.now} of ${c.n} (${fmtPct(r.nowShare)}), ${r.ppChange == null ? 'n/a' : `${r.ppChange >= 0 ? '+' : ''}${r.ppChange.toFixed(1)} percentage points`}`);
    for (const n of ins.comparison.compositionNote) lines.push(`  Composition note: ${n}`);
  }
  for (const [dim, s] of Object.entries(ins.segments || {})) {
    lines.push(`\nBy ${s.label}:`);
    for (const g of s.groups) {
      if (!g.available) { lines.push(`- ${g.value}: n=${g.n}, unavailable (below reporting minimum)`); continue; }
      const top = Object.entries(g.themes).sort((a, b) => b[1].respondents - a[1].respondents).slice(0, 5).map(([id, t]) => `${id} ${t.respondents}/${g.n} (main reason ${t.primary})`);
      lines.push(`- ${g.value}: n=${g.n}; ${top.join('; ')}`);
    }
  }
  lines.push('\nLearning objectives:');
  for (const o of ins.objectives) lines.push(`- ${o.id} "${o.title}": status ${o.status}; addressed by ${o.addressed} of ${o.total}; ${o.heard || 'no finding'}; unclear: ${o.unclear.join(' ')}`);
  const ev = evidenceList((ins._rows || []).flatMap((r) => r.s.summary.points.filter((p) => p.status !== 'removed')), ins._rows, ins.scope.reportingMode, 80);
  lines.push(`\nEvidence (${ins.scope.reportingMode === 'aggregate' ? 'none: aggregate reporting mode' : `${ev.length} reviewed summary points`}):`);
  for (const e of ev) lines.push(`- [${e.respondent}] ${e.summary}${e.kind !== 'paraphrase' ? ` | ${e.lang === 'en' ? 'quote' : `translated quote, original ${e.lang}`}: "${e.translation || e.text}"` : ''}`);
  return lines.join('\n');
}

export async function ask(ins, question, history = []) {
  if (!llmInfo().live) return offlineAnswer(ins, question);
  const prior = history.slice(-4).map((h) => `Q: ${h.question}\nA: ${h.said} ${h.interpretation || ''} ${h.gap || ''}`).join('\n\n');
  const out = await generateJson({
    system: SYSTEM,
    messages: [{ role: 'user', content: `Data:\n${compactContext(ins)}\n\n${prior ? `Earlier in this conversation:\n${prior}\n\n` : ''}Question: ${question}` }],
    schema: SCHEMA, effort: 'medium',
  });
  const validThemes = new Set(Object.keys(ins.current.themes || THEMES));
  const validObj = new Set(ins.objectives.map((o) => o.id));
  out.refs = out.refs.filter((r) => (r.type === 'theme' || r.type === 'comparison' ? validThemes.has(r.id) : r.type === 'objective' ? validObj.has(r.id) : true));
  if (!out.table.columns.length) out.table = null;
  return { ...out, scope: scopeLine(ins), generatedBy: 'model' };
}

function scopeLine(ins) {
  const f = Object.entries(ins.scope.filters).map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ');
  return `${ins.scope.programmes.map((p) => p.name).join(', ')} · ${ins.scope.periodLabel} · ${ins.current.n} submitted responses${f ? ` · ${f}` : ''}`;
}

export function suggestedQuestions(ins) {
  const c = ins.current;
  if (!c.available) return ['How many people have been invited and responded so far?'];
  const qs = [];
  const top = Object.values(c.themes).filter((t) => t.primary).sort((a, b) => b.primary - a.primary)[0];
  if (top) qs.push(`What is driving ${top.label.toLowerCase()} as a reason for leaving?`);
  if (ins.comparison?.available) qs.push(`What changed compared with ${ins.comparison.periodLabel.split(' (')[0]}?`);
  const pos = Object.values(c.themes).sort((a, b) => b.tone.positive - a.tone.positive)[0];
  if (pos?.tone.positive) qs.push('What is working well that we should preserve?');
  const gap = ins.objectives.find((o) => o.status === 'insufficient');
  if (gap) qs.push(`What do we know about: ${gap.title.toLowerCase()}?`);
  qs.push('Compare reasons for leaving by business unit as a table.');
  return qs.slice(0, 5);
}

// Deterministic fallback used in offline developer mode.
function offlineAnswer(ins, question) {
  const c = ins.current;
  const base = { scope: scopeLine(ins), generatedBy: 'offline', interpretation: '', suggestion: '', table: null, refs: [] };
  if (!c.available) return { ...base, answerable: false, said: '', gap: `This selection has ${c.n} submitted responses, below the reporting minimum of ${c.minimum}, so findings cannot be shown.` };
  const q = question.toLowerCase();
  const themes = detectThemes(q);
  if (/business unit|by unit|segment|table/.test(q)) {
    const g = ins.segments.businessUnit.groups;
    return { ...base, answerable: true, said: 'Confirmed main reasons for leaving by business unit are shown below. Units below the reporting minimum are not shown.',
      table: { columns: ['Business unit', 'Responses', 'Most common main reason'], rows: g.map((x) => x.available ? [x.value, String(x.n), (() => { const t = Object.entries(x.themes).sort((a, b) => b[1].primary - a[1].primary)[0]; return t && t[1].primary ? `${c.themes[t[0]]?.label || t[0]} (${t[1].primary})` : 'None confirmed'; })()] : [x.value, String(x.n), 'Below reporting minimum']) } };
  }
  for (const [dim, seg] of Object.entries(ins.segments)) {
    const g = seg.groups.find((x) => x.value.length > 3 && q.includes(x.value.toLowerCase()));
    if (!g) continue;
    if (!g.available) return { ...base, answerable: false, said: '', gap: `${g.value} has fewer than ${c.minimum} submitted responses in this selection, so its findings are not shown.` };
    const top = Object.entries(g.themes).sort((a, b) => b[1].respondents - a[1].respondents).slice(0, 4);
    return { ...base, answerable: true,
      said: `In ${g.value} (${g.n} respondents), the most raised themes were ${listJoin(top.map(([id, x]) => `${(c.themes[id]?.label || id).toLowerCase()} (${x.respondents} of ${g.n}${x.primary ? `, the main reason for ${x.primary}` : ''})`))}.`,
      interpretation: top[0] && c.themes[top[0][0]] ? `For comparison, ${c.themes[top[0][0]].label.toLowerCase()} was raised by ${fmtPct(c.themes[top[0][0]].share)} of all respondents.` : '',
      table: { columns: ['Theme', `${g.value}`, 'All respondents'], rows: top.map(([id, x]) => [c.themes[id]?.label || id, `${x.respondents} of ${g.n} (${fmtPct(x.share)})`, `${c.themes[id]?.respondents} of ${c.n} (${fmtPct(c.themes[id]?.share)})`]) },
      refs: top.map(([id]) => ({ type: 'segment', dimension: dim, value: g.value, id })) };
  }
  if (/compar|change|last quarter|previous|improv/.test(q) && ins.comparison) {
    const rows = ins.comparison.rows.filter((r) => r.ppChange != null).sort((a, b) => Math.abs(b.ppChange) - Math.abs(a.ppChange)).slice(0, 5);
    return { ...base, answerable: ins.comparison.available,
      said: ins.comparison.available ? ins.narrative.changed.map((x) => x.text).join(' ') : '',
      gap: ins.comparison.available ? '' : 'One of the periods is below the reporting minimum, so a comparison is not available.',
      table: { columns: ['Theme', ins.comparison.periodLabel.split(' (')[0], c.periodLabel.split(' (')[0], 'Change (pp)'], rows: rows.map((r) => [r.label, `${r.prev} (${fmtPct(r.prevShare)})`, `${r.now} (${fmtPct(r.nowShare)})`, `${r.ppChange >= 0 ? '+' : ''}${r.ppChange.toFixed(0)}`]) },
      refs: rows.map((r) => ({ type: 'comparison', id: r.id })) };
  }
  if (/preserv|working well|positive|keep/.test(q)) {
    return { ...base, answerable: true, said: ins.narrative.working.map((x) => x.text).join(' '), refs: ins.narrative.working.flatMap((x) => x.refs) };
  }
  if (themes.length) {
    const t = c.themes[themes[0]];
    if (!t.respondents) return { ...base, answerable: false, said: '', gap: `No respondents in this selection raised ${t.label.toLowerCase()}. That does not mean it is not an issue: it may not have been asked about.` };
    const d = themeDetail(ins, themes[0]);
    const subs = Object.entries(t.subthemes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.toLowerCase()} (${v})`);
    const where = d.segments.businessUnit?.groups.filter((g) => g.available && g.respondents).sort((a, b) => b.share - a.share).slice(0, 2).map((g) => `${g.value} (${g.respondents} of ${g.n})`);
    return { ...base, answerable: true,
      said: `${t.label} was raised by ${t.respondents} of ${c.n} respondents (${fmtPct(t.share)}) and confirmed as a reason for leaving by ${t.confirmedReason}, the main reason for ${t.primary}.${subs.length ? ` Accounts most often concerned ${listJoin(subs)}.` : ''}`,
      interpretation: where?.length ? `It is most concentrated in ${listJoin(where)}.` : '',
      refs: [{ type: 'theme', id: themes[0] }] };
  }
  const obj = ins.objectives.find((o) => q.includes(o.title.toLowerCase().slice(0, 25)));
  if (obj) return { ...base, answerable: obj.status !== 'insufficient', said: obj.heard || '', gap: obj.status === 'insufficient' ? obj.unclear.join(' ') : '', refs: [{ type: 'objective', id: obj.id }] };
  if (/driv|why|reason/.test(q)) return { ...base, answerable: true, said: ins.narrative.hearing.map((x) => x.text).join(' '), refs: ins.narrative.hearing.flatMap((x) => x.refs) };
  return { ...base, answerable: false, said: '', gap: 'The submitted feedback in this selection does not contain information that answers this question. Try asking about a theme, a comparison with the previous period, or a learning objective.' };
}
