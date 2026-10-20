// Loads or resets the demonstration workspace.
import { generateDemoData, applyLaterRevisions } from './seed.js';
import { computeInsights } from './analytics.js';
import { buildSections, snapshotOf } from './reports.js';
import { newToken } from '../lib/ids.js';
import { getStore } from '../store/index.js';
import { newInterviewId } from './interview-ids.js';

function seedActions() {
  const ev = (themeId, text, n, of, period = 'Q3 2026') => ({ themeId, summary: text, counts: { respondents: n, of }, period, programmeId: 'prog_general' });
  return [
    {
      id: 'act_promo', programmeId: 'prog_general', title: 'Publish a transparent promotion framework for Technology',
      outcome: 'Engineers can see what each level requires and how promotion decisions are made.',
      owner: 'Head of Engineering', dueDate: '2026-12-15', status: 'in_progress', themes: ['career_progression'],
      successMeasure: 'Fewer Technology leavers confirm career progression as their main reason over the next two quarters; internal moves in Technology increase.',
      evidence: ev('career_progression', 'Career progression was the most common confirmed main reason in Technology.', 9, 29),
      notes: [
        { at: '2026-09-02T10:00:00Z', author: 'Head of Engineering', text: 'Draft levels agreed with engineering managers.' },
        { at: '2026-10-01T10:00:00Z', author: 'People Partner', text: 'Calibration panel pilot scheduled for November.', link: 'https://example.com/fictional/calibration-plan' },
      ],
      history: [{ at: '2026-07-20T09:00:00Z', change: 'Created from finding' }, { at: '2026-07-28T09:00:00Z', change: 'Status: proposed → accepted' }, { at: '2026-09-02T10:00:00Z', change: 'Status: accepted → in progress' }],
      createdAt: '2026-07-20T09:00:00Z', closingNote: null,
    },
    {
      id: 'act_backfill', programmeId: 'prog_general', title: 'Backfill Customer Service vacancies within 30 days of notice',
      outcome: 'Teams are not left short-staffed while replacements are approved.',
      owner: 'Director of Customer Service', dueDate: '2026-10-10', status: 'accepted', themes: ['workload'],
      successMeasure: 'Average vacancy gap under 30 days; workload raised by fewer Customer Service leavers.',
      evidence: ev('workload', 'Workload and staffing rose from 3 of 26 to 9 of 29 respondents between Q2 and Q3.', 9, 29),
      notes: [], history: [{ at: '2026-10-02T09:00:00Z', change: 'Created from leadership briefing' }, { at: '2026-10-05T09:00:00Z', change: 'Status: proposed → accepted' }],
      createdAt: '2026-10-02T09:00:00Z', closingNote: null,
    },
    {
      id: 'act_commission', programmeId: 'prog_general', title: 'Model commission changes before rollout',
      outcome: 'Sales colleagues understand how commission changes affect typical earnings before they take effect.',
      owner: 'Sales Operations Lead', dueDate: '2027-01-31', status: 'proposed', themes: ['compensation'],
      successMeasure: 'Every commission change is accompanied by worked examples; pay-related exits in Sales are reviewed next quarter.',
      evidence: ev('compensation', 'Pay and benefits is concentrated in Sales.', 4, 5),
      notes: [], history: [{ at: '2026-10-12T09:00:00Z', change: 'Created from finding' }], createdAt: '2026-10-12T09:00:00Z', closingNote: null,
    },
    {
      id: 'act_rota', programmeId: 'prog_depots', title: 'Publish depot rotas two weeks ahead',
      outcome: 'Depot colleagues can plan life outside work.',
      owner: 'Depot Operations Manager', dueDate: '2026-11-30', status: 'in_progress', themes: ['shift_patterns'],
      successMeasure: 'Rotas published 14 days ahead at all depots for 8 consecutive weeks.',
      evidence: { themeId: 'shift_patterns', summary: 'Shift patterns were raised in aggregate across depot exits.', counts: { respondents: null, of: 7 }, period: 'Q3 2026', programmeId: 'prog_depots' },
      notes: [{ at: '2026-10-07T08:00:00Z', author: 'Depot Operations Manager', text: 'Leeds depot now publishing 10 days ahead.' }],
      history: [{ at: '2026-09-15T09:00:00Z', change: 'Created from finding' }, { at: '2026-09-20T09:00:00Z', change: 'Status: accepted → in progress' }],
      createdAt: '2026-09-15T09:00:00Z', closingNote: null,
    },
    {
      id: 'act_dayone', programmeId: 'prog_early', title: 'Day-one readiness checklist for new starters',
      outcome: 'New starters have equipment, accounts and a buddy on their first day.',
      owner: 'People Operations', dueDate: '2026-08-31', status: 'completed', themes: ['onboarding'],
      successMeasure: 'System access on day one for 95% of starters.',
      evidence: { themeId: 'onboarding', summary: 'Onboarding concerns raised by early-tenure leavers.', counts: { respondents: 4, of: 5 }, period: 'Q2 2026', programmeId: 'prog_early' },
      notes: [{ at: '2026-08-29T08:00:00Z', author: 'People Operations', text: 'Checklist live for all sites. 92% day-one access in August.' }],
      history: [{ at: '2026-06-30T09:00:00Z', change: 'Created from report' }, { at: '2026-08-30T09:00:00Z', change: 'Status: in progress → completed' }],
      createdAt: '2026-06-30T09:00:00Z',
      closingNote: 'Checklist in place. Early-tenure feedback in Q3 still mentions onboarding, so we will keep watching; completion does not mean the concern is resolved.',
    },
    {
      id: 'act_restructure', programmeId: 'prog_general', title: 'Internal-first communication protocol for restructures',
      outcome: 'Employees hear about organisational change before external partners.',
      owner: 'Chief of Staff', dueDate: '2026-09-30', status: 'closed', themes: ['leadership_direction'],
      successMeasure: 'No reports of learning about changes externally.',
      evidence: ev('leadership_direction', 'Two Finance leavers in Q2 said they heard about the restructure externally.', 2, 26, 'Q2 2026'),
      notes: [], history: [{ at: '2026-07-01T09:00:00Z', change: 'Created from finding' }, { at: '2026-09-01T09:00:00Z', change: 'Status: proposed → closed without action' }],
      createdAt: '2026-07-01T09:00:00Z',
      closingNote: 'Closed without action: an existing communications policy already covers this. The Q2 cases are being raised with the Finance leadership team directly.',
    },
  ];
}

export async function resetDemo(store) {
  const data = generateDemoData();
  const actions = seedActions();

  // Saved reports are generated before later corrections, so they show as superseded.
  const reports = [];
  const q3 = computeInsights(data, { programmeId: 'prog_general', period: '2026-Q3' });
  reports.push({
    id: 'rep_q3_brief', programmeId: 'prog_general', template: 'leadership_briefing', title: 'Q3 2026 leadership briefing',
    query: q3.query, createdAt: '2026-10-03T09:30:00Z', asOf: '2026-10-03T09:30:00Z', generatedAt: '2026-10-03T09:30:00Z',
    sections: buildSections(q3, 'leadership_briefing', { actions }), snapshot: snapshotOf(q3), createdBy: 'Head of People',
  });
  const cmp = computeInsights(data, { programmeId: 'prog_general', period: '2026-Q3', compareTo: '2026-Q2' });
  reports.push({
    id: 'rep_q3_cmp', programmeId: 'prog_general', template: 'period_comparison', title: 'Q3 vs Q2 2026 comparison',
    query: cmp.query, createdAt: '2026-10-05T14:00:00Z', asOf: '2026-10-05T14:00:00Z', generatedAt: '2026-10-05T14:00:00Z',
    sections: buildSections(cmp, 'period_comparison'), snapshot: snapshotOf(cmp), createdBy: 'HR Analyst',
  });

  applyLaterRevisions(data);
  const bookmarks = [];

  // Links and Interview Ids are unique to each copy of the demonstration workspace.
  const interviewIndex = [];
  for (const p of data.participants) {
    p.invitation.token = newToken();
    p.interviewId = newInterviewId();
    interviewIndex.push({ id: p.interviewId, orgId: store.ns, participantId: p.id, at: p.createdAt });
  }
  for (const s of data.sessions) {
    s.accessToken = newToken();
    s.interviewId = data.participants.find((p) => p.id === s.participantId)?.interviewId || null;
  }

  await store.clear(['org', 'programme', 'participant', 'session', 'report', 'action', 'bookmark', 'ledger', 'meta']);
  await store.put('org', data.org);
  await store.putMany('programme', data.programmes);
  await store.putMany('participant', data.participants);
  await store.putMany('session', data.sessions);
  await store.putMany('report', reports);
  await store.putMany('action', actions);
  await store.putMany('bookmark', bookmarks);
  await store.put('meta', { id: 'demo', resetAt: new Date().toISOString(), version: 1 });
  if (store.ns) await getStore('global').putMany('interview', interviewIndex);
  return { programmes: data.programmes.length, participants: data.participants.length, sessions: data.sessions.length, reports: reports.length, actions: actions.length };
}

// Removes evaluation interviews only, keeping the demonstration dataset.
export async function resetEvaluation(store) {
  const parts = (await store.list('participant')).filter((p) => p.population === 'evaluation');
  const sessions = (await store.list('session')).filter((s) => s.population === 'evaluation');
  for (const p of parts) await store.delete('participant', p.id);
  for (const s of sessions) await store.delete('session', s.id);
  return { participants: parts.length, sessions: sessions.length };
}
