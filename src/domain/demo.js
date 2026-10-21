// Loads or resets the demonstration workspace.
import { generateDemoData, applyLaterRevisions } from './seed.js';
import { computeInsights } from './analytics.js';
import { buildSections, snapshotOf } from './reports.js';
import { newToken } from '../lib/ids.js';
import { getStore } from '../store/index.js';
import { newInterviewId } from './interview-ids.js';

export async function resetDemo(store) {
  const data = generateDemoData();

  // Saved reports are generated before later corrections, so they show as superseded.
  const reports = [];
  const q3 = computeInsights(data, { programmeId: 'prog_general', period: '2026-Q3' });
  reports.push({
    id: 'rep_q3_brief', programmeId: 'prog_general', template: 'leadership_briefing', title: 'Q3 2026 leadership briefing',
    query: q3.query, createdAt: '2026-10-03T09:30:00Z', asOf: '2026-10-03T09:30:00Z', generatedAt: '2026-10-03T09:30:00Z',
    sections: buildSections(q3, 'leadership_briefing'), snapshot: snapshotOf(q3), createdBy: 'Head of People',
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
  await store.putMany('bookmark', bookmarks);
  await store.put('meta', { id: 'demo', resetAt: new Date().toISOString(), version: 1 });
  if (store.ns) await getStore('global').putMany('interview', interviewIndex);
  return { programmes: data.programmes.length, participants: data.participants.length, sessions: data.sessions.length, reports: reports.length };
}

// Removes evaluation interviews only, keeping the demonstration dataset.
export async function resetEvaluation(store) {
  const parts = (await store.list('participant')).filter((p) => p.population === 'evaluation');
  const sessions = (await store.list('session')).filter((s) => s.population === 'evaluation');
  for (const p of parts) await store.delete('participant', p.id);
  for (const s of sessions) await store.delete('session', s.id);
  return { participants: parts.length, sessions: sessions.length };
}
