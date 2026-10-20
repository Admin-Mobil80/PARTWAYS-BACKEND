// Report building. A report stores the insights snapshot it was generated from, so
// its numbers stay fixed until someone explicitly refreshes it.
import { THEMES } from './catalog.js';
import { fmtPct, listJoin, evidenceList } from './analytics.js';

export const REPORT_TEMPLATES = {
  programme_summary: { label: 'Programme summary', description: 'Participation, main findings, objectives and limitations for one programme and period.' },
  leadership_briefing: { label: 'Leadership briefing', description: 'A concise account of what deserves attention, what is working and agreed actions.' },
  period_comparison: { label: 'Period comparison', description: 'What changed between two reporting periods, with counts and proportions.' },
  theme_investigation: { label: 'Theme investigation', description: 'A focused look at one theme: prevalence, segments, mixed evidence and suggestions.' },
};

const SECTION_SETS = {
  programme_summary: ['scope', 'participation', 'key_findings', 'reasons', 'objectives', 'positives', 'suggestions', 'limitations'],
  leadership_briefing: ['key_findings', 'attention', 'positives', 'objectives', 'suggestions', 'actions', 'limitations', 'scope'],
  period_comparison: ['scope', 'participation', 'comparison', 'key_findings', 'limitations'],
  theme_investigation: ['scope', 'theme_focus', 'theme_segments', 'theme_evidence', 'suggestions', 'limitations'],
};

const TITLES = {
  scope: 'Scope and population', participation: 'Participation', key_findings: 'What we are hearing',
  reasons: 'Reasons for leaving', objectives: 'Findings against learning objectives', positives: 'What is working well',
  suggestions: 'Suggested actions', limitations: 'Limitations', attention: 'What deserves attention',
  comparison: 'Period comparison', actions: 'Action progress', theme_focus: 'Theme overview',
  theme_segments: 'Where this theme appears', theme_evidence: 'Supporting evidence',
};

const CHARTS = { reasons: 'reasons', comparison: 'comparison', participation: 'participation', theme_segments: 'segments', positives: 'positives' };

function suggestionsFrom(insights) {
  const rows = insights._rows || [];
  const bucket = {};
  for (const r of rows) {
    for (const p of r.s.summary.points.filter((x) => x.status !== 'removed' && x.section === 'suggestions')) {
      const key = p.textEn || p.text;
      (bucket[key] ||= { text: key, theme: p.themes[0], n: 0 }).n++;
    }
  }
  return Object.values(bucket).sort((a, b) => b.n - a.n);
}

export function buildSections(insights, template, { themeId, actions = [] } = {}) {
  const c = insights.current;
  const s = insights.scope;
  const n = c.n;
  const paras = (arr) => arr.map((x) => x.text).join(' ');
  const make = (id, text, extra = {}) => ({ id, title: TITLES[id], included: true, text, generated: true, edited: false, chart: CHARTS[id] || null, ...extra });
  const out = [];
  for (const id of SECTION_SETS[template] || SECTION_SETS.programme_summary) {
    if (id === 'scope') {
      const f = Object.entries(s.filters).map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ');
      out.push(make(id, `${s.programmes.map((p) => p.name).join(', ')}. ${s.periodLabel}, ${s.basisLabel.toLowerCase()}. ${f ? `Filtered to ${f}. ` : 'All segments. '}${n} submitted responses${insights.scope.population === 'demo' ? ' from fictional demonstration data' : ''}. Results describe the people who responded and are not a measure of all turnover.`));
    } else if (id === 'participation') {
      const p = c.participation;
      out.push(make(id, `${p.eligible} people were invited in this period. ${p.started} started an interview (${fmtPct(p.participationRate)}) and ${p.submitted} submitted feedback (${fmtPct(p.submissionRate)}). Of those who started, ${fmtPct(p.completionAfterStart)} went on to submit.`));
    } else if (!c.available) {
      out.push(make(id, `Not enough responses to report this section. The selection has ${n} submitted responses and the reporting minimum is ${c.minimum}.`, { unavailable: true }));
    } else if (id === 'key_findings') {
      out.push(make(id, paras([...insights.narrative.hearing, ...insights.narrative.changed.filter((x) => !x.caveat)])));
    } else if (id === 'reasons') {
      const top = Object.values(c.themes).filter((t) => t.confirmedReason).sort((a, b) => b.primary - a.primary || b.confirmedReason - a.confirmedReason);
      out.push(make(id, `Employees confirmed their own reasons for leaving during review. ${listJoin(top.slice(0, 4).map((t) => `${t.label.toLowerCase()} was the main reason for ${t.primary} and a confirmed reason for ${t.confirmedReason}`))}. ${c.noSingleMainReason ? `${c.noSingleMainReason} respondents said there was no single main reason. ` : ''}Topics that were mentioned but not confirmed as reasons are counted separately.`));
    } else if (id === 'objectives') {
      out.push(make(id, insights.objectives.map((o) => o.status === 'insufficient'
        ? `${o.title}: not enough evidence yet. ${o.unclear[0] || ''}`
        : `${o.title}: ${o.heard}`).join('\n\n')));
    } else if (id === 'positives') {
      out.push(make(id, paras(insights.narrative.working) || 'No positive themes were raised by enough respondents to report.'));
    } else if (id === 'attention') {
      out.push(make(id, paras(insights.narrative.attention) || 'No theme is concentrated in a particular segment beyond the overall pattern.'));
    } else if (id === 'comparison') {
      const cmp = insights.comparison;
      out.push(make(id, cmp?.available ? `${paras(insights.narrative.changed)} Changes are shown in percentage points of submitted respondents in each period.` : 'A comparison is not available for this selection because one period is below the reporting minimum.'));
    } else if (id === 'suggestions') {
      const sug = suggestionsFrom(insights).filter((x) => !themeId || x.theme === themeId).slice(0, 4);
      out.push(make(id, sug.length
        ? `Respondents suggested: ${sug.map((x) => `“${x.text}” (${x.n})`).join('; ')}. These are respondents' suggestions and interpretations for discussion, not proven solutions.`
        : 'Respondents did not make suggestions on this topic.', { interpretation: true }));
    } else if (id === 'actions') {
      const relevant = actions.filter((a) => a.programmeId === s.programmes[0]?.id || !a.programmeId);
      const byStatus = {};
      for (const a of relevant) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
      const overdue = relevant.filter((a) => a.dueDate && a.dueDate < new Date().toISOString().slice(0, 10) && !['completed', 'closed'].includes(a.status));
      out.push(make(id, relevant.length
        ? `${relevant.length} improvement actions are linked to this programme: ${Object.entries(byStatus).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ')}.${overdue.length ? ` ${overdue.length} ${overdue.length === 1 ? 'is' : 'are'} overdue.` : ''} Completing an action does not show that the underlying concern is resolved.`
        : 'No improvement actions have been created yet.', { actions: relevant.map((a) => ({ id: a.id, title: a.title, owner: a.owner, status: a.status, dueDate: a.dueDate })) }));
    } else if (id === 'limitations') {
      const lim = [
        `Findings describe ${n} people who chose to respond; they are not a measure of organisation-wide prevalence or proof of what caused turnover.`,
        'Employees chose to talk or type, so differences between voice and text interviews may reflect who chose each format.',
        'Topics that were not discussed are reported as not discussed, never as a favourable answer.',
        ...insights.narrative.attention.filter((x) => x.caveat).map((x) => x.text),
        ...(insights.comparison?.compositionNote || []),
      ];
      if (insights.scope.reportingMode === 'aggregate') lim.push('This programme reports in aggregate only; individual quotations are not available.');
      out.push(make(id, lim.join(' ')));
    } else if (id === 'theme_focus' && themeId) {
      const t = c.themes[themeId];
      out.push(make(id, `${t.label}: ${t.description} Raised by ${t.respondents} of ${n} respondents (${fmtPct(t.share)}); a confirmed reason for leaving for ${t.confirmedReason}, and the main reason for ${t.primary}. Tone of accounts: ${t.tone.positive} positive, ${t.tone.negative} negative, ${t.tone.mixed} mixed, ${t.tone.neutral} neutral.${t.mentions > t.respondents ? ` Mentions across all conversations: ${t.mentions} (one respondent can mention a theme several times; prevalence counts each person once).` : ''}`, { themeId }));
    } else if (id === 'theme_segments' && themeId) {
      const g = insights.segments.businessUnit.groups;
      out.push(make(id, g.map((x) => x.available ? `${x.value}: ${x.themes[themeId]?.respondents || 0} of ${x.n}` : `${x.value}: below reporting minimum`).join('; ') + '.', { themeId }));
    } else if (id === 'theme_evidence' && themeId) {
      const ev = evidenceList((insights._rows || []).flatMap((r) => r.s.summary.points.filter((p) => p.status !== 'removed' && p.themes.includes(themeId))), insights._rows, insights.scope.reportingMode, 6);
      out.push(make(id, ev.length ? 'Selected reviewed summary points supporting this theme.' : 'Individual evidence is not available in this programme\'s reporting mode.', { evidence: ev, themeId }));
    }
  }
  return out;
}

export function snapshotOf(insights) {
  return JSON.parse(JSON.stringify(insights));
}

export function isStale(report, sessions) {
  const progIds = new Set(report.snapshot.scope.programmes.map((p) => p.id));
  const latest = sessions.filter((s) => progIds.has(s.programmeId) && ['submitted', 'withdrawn'].includes(s.status))
    .reduce((m, s) => (s.updatedAt > m ? s.updatedAt : m), '');
  return latest > report.asOf;
}
