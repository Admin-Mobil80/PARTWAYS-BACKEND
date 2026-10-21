// End-to-end checks through the API handler, against a fresh demo dataset in a temp file.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-test-'));
process.env.DATA_FILE = path.join(dir, 'store.json');
process.env.DEV_SHOW_OTP = '1';
process.env.AUTH_SECRET = 'test-secret';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.LLM_PROVIDER;
delete process.env.TABLE_NAME;
delete process.env.HR_ALLOWED_EMAILS;

const { handle } = await import('../src/lib/app.js');

let token;
// HR calls go to the signed-in organisation's demonstration workspace unless a test says otherwise.
let workspace = 'demo';
async function call(method, p, body, headers = {}) {
  const [pathname, qs] = p.split('?');
  const res = await handle({ method, path: pathname, query: Object.fromEntries(new URLSearchParams(qs || '')), headers: { authorization: token ? `Bearer ${token}` : undefined, 'x-workspace': workspace, ...headers }, body: body ?? null });
  if (res.stream) {
    const out = [];
    await res.stream((c) => out.push(c));
    return { status: 200, body: out };
  }
  return res;
}
const hr = async (method, p, body) => {
  const r = await call(method, p, body);
  if (r.status >= 400) throw Object.assign(new Error(`${method} ${p} → ${r.status}: ${r.body?.error}`), { res: r });
  return r.body;
};
const insights = (query) => hr('POST', '/api/hr/insights', { query });

async function signUp(email, orgName) {
  const start = await call('POST', '/api/auth/signup', { email, orgName, country: 'GB' });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const v = await call('POST', '/api/auth/verify', { email, code: start.body.devCode });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  return v.body;
}

async function inOwnWorkspace(fn) {
  workspace = 'own';
  try { return await fn(); } finally { workspace = 'demo'; }
}

before(async () => {
  const v = await signUp('tester@example.com', 'Tester Ltd');
  assert.equal(v.created, true);
  token = v.token;
});

test('OTP sign-in rejects a wrong code and protects HR routes', async () => {
  const saved = token;
  token = null;
  assert.equal((await call('GET', '/api/hr/programmes')).status, 401);
  assert.equal((await call('POST', '/api/auth/start', { email: 'nobody@example.com' })).status, 404, 'unknown emails are told to sign up');
  assert.equal((await call('POST', '/api/auth/start', { email: 'tester@example.com' })).status, 200);
  const bad = await call('POST', '/api/auth/verify', { email: 'tester@example.com', code: '000000' });
  assert.ok(bad.status >= 400 || bad.body.retry);
  assert.equal((await call('POST', '/api/auth/signup', { email: 'tester@example.com', orgName: 'Again', country: 'GB' })).status, 409);
  assert.equal((await call('POST', '/api/auth/signup', { email: 'new@example.com', orgName: 'No Country' })).status, 400);
  token = saved;
});

test('sign-up creates a separate workspace with 3 free credits and a draft programme', async () => {
  await inOwnWorkspace(async () => {
    const me = await hr('GET', '/api/hr/me');
    assert.equal(me.organisation, 'Tester Ltd');
    assert.deepEqual(me.credits, { unlimited: false, balance: 3 });
    const { programmes } = await hr('GET', '/api/hr/programmes');
    assert.equal(programmes.length, 1);
    assert.equal(programmes[0].status, 'draft');
    assert.equal((await call('POST', '/api/hr/demo/reset', { scope: 'all' })).status, 409, 'own data can never be reset as demo data');
  });
  const { programmes } = await hr('GET', '/api/hr/programmes');
  assert.ok(programmes.length >= 3, 'the demo workspace is separate');
});

test('workspaces are isolated between organisations', async () => {
  const saved = token;
  const other = await signUp('second@example.org', 'Second Org');
  token = other.token;
  const theirs = await inOwnWorkspace(() => hr('GET', '/api/hr/programmes'));
  token = saved;
  const mine = await inOwnWorkspace(() => hr('GET', '/api/hr/programmes'));
  assert.notEqual(theirs.programmes[0].id, mine.programmes[0].id);
  assert.equal((await inOwnWorkspace(() => call('GET', `/api/hr/programmes/${theirs.programmes[0].id}`))).status, 404);
});

test('credits: one per invitation, reminders free, packs add credits', async () => {
  await inOwnWorkspace(async () => {
    const { programmes } = await hr('GET', '/api/hr/programmes');
    const prog = programmes[0].id;
    await hr('POST', `/api/hr/programmes/${prog}/activate`, { acknowledgeGaps: true });
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const { participant } = await hr('POST', '/api/hr/participants', { programmeId: prog, mobile: `+44 7700 900${100 + i}` });
      assert.match(participant.interviewId, /^PW-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      assert.equal(participant.mobile, '+44 ••• ••• 10' + i, 'the full number is never returned');
      ids.push(participant);
    }
    assert.equal(new Set(ids.map((p) => p.interviewId)).size, 4);
    for (const p of ids.slice(0, 3)) await hr('POST', `/api/hr/participants/${p.id}/send`, { kind: 'invitation' });
    assert.equal((await hr('GET', '/api/hr/me')).credits.balance, 0);
    await hr('POST', `/api/hr/participants/${ids[0].id}/send`, { kind: 'reminder' });
    const blocked = await call('POST', `/api/hr/participants/${ids[3].id}/send`, { kind: 'invitation' });
    assert.equal(blocked.status, 402);
    const msg = await hr('GET', `/api/hr/participants/${ids[3].id}/message?kind=invitation`);
    assert.ok(msg.text.includes(ids[3].interviewId));
    const billing = await hr('GET', '/api/hr/billing');
    assert.deepEqual(billing.packs.map((p) => [p.credits, p.usd]), [[10, 100], [25, 200], [50, 300], [100, 500]]);
    assert.equal(billing.payments, 'simulated');
    const bought = await hr('POST', '/api/hr/billing/simulate', { pack: 'pack_10' });
    assert.equal(bought.balance, 10);
    await hr('POST', `/api/hr/participants/${ids[3].id}/send`, { kind: 'invitation' });
    assert.equal((await hr('GET', '/api/hr/me')).credits.balance, 9);

    // The invitation link reaches the right workspace and shows the Interview Id, not a name.
    const link = (await hr('GET', `/api/hr/participants/${ids[3].id}/message`)).link;
    const inv = await call('GET', `/api/invite/${link.split('/i/')[1]}`);
    assert.equal(inv.status, 200);
    assert.equal(inv.body.participant.interviewId, ids[3].interviewId);
    assert.equal(inv.body.programme.modes.includes('human'), false);
  });
  assert.equal((await hr('GET', '/api/hr/me')).credits.unlimited, true, 'the demo workspace does not use credits');
});

test('employee text is stored without email addresses or phone numbers', async () => {
  const pv = await hr('POST', '/api/hr/programmes/prog_general/preview', { mode: 'ai_text' });
  const h = { 'x-session-token': pv.accessToken };
  await call('POST', `/api/session/${pv.id}/turn`, { text: 'Call me on +44 7700 900123 or mail jo.bloggs@example.com, workload was high for 3 years.' }, h);
  const s = (await call('GET', `/api/session/${pv.id}`, null, h)).body.session;
  const said = s.transcript.find((t) => t.role === 'employee').text;
  assert.ok(!said.includes('900123') && !said.includes('@'), said);
  assert.ok(said.includes('3 years'));
});

test('demo data meets the evaluation minimums', async () => {
  const { programmes } = await hr('GET', '/api/hr/programmes');
  assert.ok(programmes.length >= 3);
  const submitted = programmes.reduce((s, p) => s + (p.counts.submitted || 0), 0);
  assert.ok(submitted >= 60, `submitted ${submitted}`);
  const q3 = await insights({ programmeId: 'prog_general', period: '2026-Q3' });
  const q2 = await insights({ programmeId: 'prog_general', period: '2026-Q2' });
  assert.ok(q3.current.available && q2.current.available);
  assert.ok(q3.comparison.available);
});

test('theme prevalence counts each respondent once, mentions separately', async () => {
  const ins = await insights({ programmeId: 'prog_general', period: '2026-Q3' });
  const w = ins.current.themes.workload;
  assert.ok(w.respondents <= ins.current.n);
  assert.ok(w.mentions > w.respondents, 'repeat mentions exist in the demo data');
  assert.equal(Math.round(w.share * 1000), Math.round((w.respondents / ins.current.n) * 1000));
});

test('reporting minimum hides small selections and segments', async () => {
  const ins = await insights({ programmeId: 'prog_general', period: '2026-Q3', filters: { businessUnit: ['Finance'] } });
  assert.equal(ins.current.available, false);
  assert.equal(ins.current.themes, null);
  const all = await insights({ programmeId: 'prog_general', period: '2026-Q3' });
  for (const g of all.segments.businessUnit.groups) if (g.n < all.current.minimum) assert.equal(g.available, false);
});

test('aggregate programmes never expose individual evidence', async () => {
  const d = await hr('POST', '/api/hr/insights/theme', { query: { programmeId: 'prog_depots', period: '2026-Q3' }, themeId: 'shift_patterns' });
  if (d.available) {
    assert.equal(d.reportingMode, 'aggregate');
    assert.equal(Object.values(d.evidence || {}).flat().length, 0);
  }
  const ins = await insights({ programmeId: 'prog_depots', period: '2026-Q3' });
  for (const o of ins.objectives) assert.equal((o.evidence || []).length, 0);
});

test('assistant answers from the same numbers as the dashboard', async () => {
  const ins = await insights({ programmeId: 'prog_general', period: '2026-Q3' });
  const { answer } = await hr('POST', '/api/hr/assistant', { query: { programmeId: 'prog_general', period: '2026-Q3' }, question: 'Why are people leaving because of workload?' });
  const w = ins.current.themes.workload;
  assert.match(answer.said, new RegExp(`${w.respondents} of ${ins.current.n}`));
});

test('employee interview: text conversation, review, submit, then correct and withdraw', async () => {
  const tryRes = await hr('POST', '/api/hr/demo/try', { persona: 'workload', programmeId: 'prog_general' });
  const tokenInv = tryRes.link.split('/i/')[1];
  const inv = await call('GET', `/api/invite/${tokenInv}`);
  assert.equal(inv.status, 200);
  const sess = await call('POST', `/api/invite/${tokenInv}/session`, { mode: 'ai_text', language: 'en', duration: 'quick' });
  const { id, accessToken } = sess.body;
  const h = { 'x-session-token': accessToken };
  await call('POST', `/api/session/${id}/turn`, { event: 'start' }, h);
  for (const text of ['The workload was too much and we were short staffed for months.', 'My team was great and very supportive.', 'No, that is everything.']) {
    const r = await call('POST', `/api/session/${id}/turn`, { text }, h);
    assert.ok(r.body.some((c) => c.t === 'done'), JSON.stringify(r.body.at(-1)));
  }
  assert.equal((await call('POST', `/api/session/${id}/submit`, {}, h)).status >= 400, true, 'cannot submit before review');
  const fin = await call('POST', `/api/session/${id}/finish`, {}, h);
  assert.equal(fin.status, 200);
  const s1 = (await call('GET', `/api/session/${id}`, null, h)).body.session;
  assert.ok(s1.summary.points.length > 0);
  // The employee confirms workload as the trigger.
  const summary = structuredClone(s1.summary);
  for (const f of summary.factors) { f.status = 'confirmed'; }
  const put = await call('PUT', `/api/session/${id}/summary`, { summary }, h);
  assert.equal(put.status, 200);
  const sub = await call('POST', `/api/session/${id}/submit`, {}, h);
  assert.equal(sub.status, 200, JSON.stringify(sub.body));

  const evalQ = { programmeId: 'prog_general', period: '2026-Q4', population: 'evaluation' };
  const before = await insights(evalQ);
  assert.equal(before.current.participation.submitted >= 1, true);

  const wd = await call('POST', `/api/session/${id}/withdraw`, {}, h);
  assert.equal(wd.status, 200);
  const after = await insights(evalQ);
  assert.equal(after.current.participation.submitted, before.current.participation.submitted - 1);
});

test('preview interviews never reach findings and cannot be submitted', async () => {
  const before = await insights({ programmeId: 'prog_general', period: '2026-Q4', population: 'all' });
  const pv = await hr('POST', '/api/hr/programmes/prog_general/preview', { mode: 'ai_text' });
  const h = { 'x-session-token': pv.accessToken };
  await call('POST', `/api/session/${pv.id}/turn`, { text: 'Workload was very high and pay was low.' }, h);
  await call('POST', `/api/session/${pv.id}/finish`, {}, h);
  assert.ok((await call('POST', `/api/session/${pv.id}/submit`, {}, h)).status >= 400);
  const after = await insights({ programmeId: 'prog_general', period: '2026-Q4', population: 'all' });
  assert.equal(after.current.n, before.current.n);
});

test('objective-linked topics are planned before unlinked ones', async () => {
  const pv = await hr('POST', '/api/hr/programmes/prog_general/preview', { mode: 'ai_text', duration: 'standard' });
  const s = (await call('GET', `/api/session/${pv.id}`, null, { 'x-session-token': pv.accessToken })).body.session;
  assert.ok(s.topics.some((t) => t.id === 'flexibility'), 'the hybrid-working objective topic is in a standard preview');
});

test('saved reports keep their snapshot and flag newer data', async () => {
  const { reports } = await hr('GET', '/api/hr/reports');
  const brief = reports.find((r) => r.id === 'rep_q3_brief');
  assert.ok(brief.stale, 'demo revisions after the report make it stale');
  const r = await hr('POST', `/api/hr/reports/${brief.id}/refresh`);
  assert.equal(r.report.stale, false);
});

test('guide changes create a new version; old interviews keep theirs', async () => {
  const p = await hr('GET', '/api/hr/programmes/prog_early');
  const topics = p.working.topics.map((t) => (t.id === 'manager' ? { ...t, opening: 'How was working with your manager?' } : t));
  const d = await hr('PUT', '/api/hr/programmes/prog_early/draft', { objectives: p.working.objectives, topics });
  assert.ok(d.changes.length >= 1);
  const a = await hr('POST', '/api/hr/programmes/prog_early/activate', { acknowledgeGaps: true });
  assert.equal(a.version, (p.programme.activeVersion || 0) + 1);
});

test('participants: duplicate mobile numbers are rejected and sends are simulated', async () => {
  const add = await hr('POST', '/api/hr/participants', { programmeId: 'prog_general', mobile: '+44 7700 900555' });
  assert.equal(add.participant.mobile, '+44 ••• ••• 555');
  const dup = await call('POST', '/api/hr/participants', { programmeId: 'prog_general', mobile: '07700 900555' });
  assert.equal(dup.status, 409);
  const sent = await hr('POST', `/api/hr/participants/${add.participant.id}/send`, { kind: 'invitation' });
  assert.equal(sent.simulated, true);
  const detail = await hr('GET', `/api/hr/participants/${add.participant.id}`);
  assert.equal(detail.participant.transcript, undefined);
  assert.equal(detail.participant.summary, undefined);
});

test('participants: invited by email, WhatsApp or both, on every channel they have', async () => {
  const byEmail = await hr('POST', '/api/hr/participants', { programmeId: 'prog_general', email: 'Leaver@Example.com' });
  assert.equal(byEmail.participant.email, 'l•••@example.com', 'the full email is never returned');
  assert.equal(byEmail.participant.mobile, null);
  assert.deepEqual(byEmail.participant.channels, ['email']);
  assert.equal((await call('POST', '/api/hr/participants', { programmeId: 'prog_general', email: 'leaver@example.com' })).status, 409, 'duplicate email, any case');
  assert.equal((await call('POST', '/api/hr/participants', { programmeId: 'prog_general' })).status, 400, 'email or mobile is required');
  assert.equal((await call('POST', '/api/hr/participants', { programmeId: 'prog_general', email: 'not-an-email' })).status, 400);

  const both = await hr('POST', '/api/hr/participants', { programmeId: 'prog_general', email: 'both@example.com', mobile: '+44 7700 900556' });
  assert.deepEqual(both.participant.channels, ['email', 'whatsapp']);
  assert.equal(both.participant.invitation.channel, 'Email and WhatsApp');

  const preview = await hr('GET', `/api/hr/participants/${both.participant.id}/message?kind=invitation`);
  assert.deepEqual(preview.messages.map((m) => m.channel), ['email', 'whatsapp']);
  assert.ok(preview.messages[0].subject.includes('has asked PartWays'));
  assert.ok(preview.messages.every((m) => m.text.includes(both.participant.interviewId)));

  const sent = await hr('POST', `/api/hr/participants/${both.participant.id}/send`, { kind: 'invitation' });
  assert.deepEqual(sent.deliveries.map((d) => d.channel), ['email', 'whatsapp']);
  assert.equal(sent.simulated, true, 'nothing is delivered from the demonstration workspace');
  assert.match(sent.message, /demonstration workspace/);
  const reminder = await hr('POST', `/api/hr/participants/${both.participant.id}/send`, { kind: 'reminder' });
  assert.deepEqual(reminder.participant.invitation.reminders[0].channels, ['email', 'whatsapp']);

  const csv = 'email,mobile,business unit\nmix@example.com,,Sales\n,+44 7700 900557,Ops\nmix@example.com,,Sales\n,,Ops';
  const check = await hr('POST', '/api/hr/participants/import/validate', { programmeId: 'prog_general', csv });
  assert.deepEqual(check.rows.map((r) => r.status), ['ok', 'ok', 'duplicate', 'error']);
});

test('actions require reasons to close and notes to complete', async () => {
  const { action } = await hr('POST', '/api/hr/actions', { title: 'T', owner: 'O', outcome: 'X' });
  assert.equal((await call('POST', `/api/hr/actions/${action.id}/status`, { status: 'closed' })).status, 400);
  assert.equal((await call('POST', `/api/hr/actions/${action.id}/status`, { status: 'completed' })).status, 400);
  assert.equal((await call('POST', `/api/hr/actions/${action.id}/status`, { status: 'completed', note: 'Done' })).status, 200);
});

test('owners add team members, who sign in to the same workspace with their role', async () => {
  const saved = token;
  await inOwnWorkspace(async () => {
    const { member } = await hr('POST', '/api/hr/team', { email: 'analyst@example.com', role: 'analyst' });
    assert.equal(member.role, 'analyst');
    assert.equal((await call('POST', '/api/hr/team', { email: 'second@example.org', role: 'leader' })).status, 409, 'one workspace per person');
    const start = await call('POST', '/api/auth/start', { email: 'analyst@example.com' });
    const v = await call('POST', '/api/auth/verify', { email: 'analyst@example.com', code: start.body.devCode });
    token = v.body.token;
    const me = await hr('GET', '/api/hr/me');
    assert.equal(me.organisation, 'Tester Ltd');
    assert.equal(me.role, 'analyst');
    assert.equal((await call('POST', '/api/hr/team', { email: 'x@example.com', role: 'owner' })).status, 403);
    const { programmes } = await hr('GET', '/api/hr/programmes');
    assert.equal((await call('POST', '/api/hr/participants', { programmeId: programmes[0].id, mobile: '+44 7700 900777' })).status, 403, 'analysts cannot send invitations');
    assert.equal((await call('POST', '/api/hr/insights', { query: {} })).status, 200);
    token = saved;
    assert.equal((await call('PUT', '/api/hr/team/tester@example.com', { role: 'analyst' })).status, 409, 'the last owner stays an owner');
    await hr('DELETE', '/api/hr/team/analyst@example.com');
    assert.equal((await call('POST', '/api/auth/start', { email: 'analyst@example.com' })).status, 404);
  }).finally(() => { token = saved; });
});
