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
const { normaliseMobile } = await import('../src/routes/participants.js');

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

test('sign-up country comes from the visitor\'s location when CloudFront knows it', async () => {
  assert.equal((await call('GET', '/api/public/country', null, { 'cloudfront-viewer-country': 'IN' })).body.country, 'IN');
  assert.equal((await call('GET', '/api/public/country')).body.country, null);
  assert.equal((await call('GET', '/api/public/country', null, { 'cloudfront-viewer-country': '<x>' })).body.country, null);
});

test('a Custom programme carries its own description of the departures', async () => {
  await inOwnWorkspace(async () => {
    assert.equal((await call('POST', '/api/hr/programmes', { name: 'Custom', template: 'custom' })).status, 400, 'a Custom programme needs a description');
    const framing = 'Nurses leaving in their first two years. Focus on shift patterns.';
    const { programme: p } = await hr('POST', '/api/hr/programmes', { name: 'Custom', template: 'custom', framing });
    assert.equal(p.framing, framing);
    assert.deepEqual(p.topics.map((t) => t.id), ['experience', 'reasons', 'positives', 'anything_else']);
    const { programme: q } = await hr('PUT', `/api/hr/programmes/${p.id}/settings`, { framing: 'Nurses leaving.' });
    assert.equal(q.framing, 'Nurses leaving.');
    const { programme: g } = await hr('POST', '/api/hr/programmes', { name: 'General', template: 'general', framing: 'ignored' });
    assert.equal(g.framing, undefined, 'only Custom programmes keep their own description');
  });
});

test('a local mobile number takes the organisation\'s country code', () => {
  assert.equal(normaliseMobile('098450 04028', '91'), '+919845004028');
  assert.equal(normaliseMobile('07700 900123'), '+447700900123', 'the UK is the default');
  assert.equal(normaliseMobile('+49 151 00900801', '91'), '+4915100900801', 'an international number keeps its own code');
  assert.equal(normaliseMobile('0091 98450 04028', '44'), '+919845004028');
  assert.equal(normaliseMobile('12345', '91'), null);
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

test('live voice: unavailable without a key; turns are stored in spoken order and redacted', async () => {
  const pv = await hr('POST', '/api/hr/programmes/prog_general/preview', { mode: 'ai_voice' });
  const h = { 'x-session-token': pv.accessToken };
  assert.equal((await call('GET', '/api/public/config')).body.voice.realtime, false);
  assert.equal((await call('POST', `/api/session/${pv.id}/realtime`, {}, h)).status, 409, 'no live voice without an OpenAI key');
  const t0 = Date.now() - 60000;
  const a = await call('POST', `/api/session/${pv.id}/realtime/turn`, { role: 'interviewer', text: 'How was your time here?', at: t0 }, h);
  assert.equal(a.status, 200);
  // The reply was spoken (and stored) before the employee's earlier words finished transcribing.
  await call('POST', `/api/session/${pv.id}/realtime/turn`, { role: 'interviewer', text: 'What changed?', at: t0 + 2000 }, h);
  await call('POST', `/api/session/${pv.id}/realtime/turn`, { role: 'employee', text: 'Busy. Mail me at jo@example.com', at: t0 + 1000 }, h);
  const s = (await call('GET', `/api/session/${pv.id}`, null, h)).body.session;
  const turns = s.transcript.map((x) => `${x.role}: ${x.text}`);
  assert.equal(turns.length, 3);
  assert.match(turns[1], /^employee: Busy\./);
  assert.ok(!turns[1].includes('jo@example.com'), 'contact details are removed');
  assert.equal(turns[2], 'interviewer: What changed?');
  assert.equal((await call('POST', `/api/session/${pv.id}/realtime/turn`, { role: 'employee', text: '  ' }, h)).status, 400);
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

test('employee interview: text conversation, review, submit; submitting is final', async () => {
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

  // Nothing can change a submitted summary.
  assert.equal((await call('PUT', `/api/session/${id}/summary`, { summary }, h)).status, 409);
  assert.equal((await call('POST', `/api/session/${id}/submit`, {}, h)).status, 409);
  assert.equal((await call('POST', `/api/session/${id}/discard`, {}, h)).status, 409);
  const turnId = (await call('GET', `/api/session/${id}`, null, h)).body.session.transcript.find((x) => x.role === 'employee').id;
  assert.equal((await call('POST', `/api/session/${id}/correct-turn`, { turnId, text: 'changed' }, h)).status, 409);
  for (const gone of ['withdraw', 'start-correction', 'cancel-correction']) {
    assert.equal((await call('POST', `/api/session/${id}/${gone}`, {}, h)).status, 404, `${gone} no longer exists`);
  }
  const after = await insights(evalQ);
  assert.equal(after.current.participation.submitted, before.current.participation.submitted);
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

test('participants: adding or importing can send the invitation in the same step', async () => {
  const added = await hr('POST', '/api/hr/participants', { programmeId: 'prog_general', email: 'oneStep@example.com', send: true });
  assert.equal(added.added, true);
  assert.equal(added.participant.invitation.status, 'sent');
  assert.deepEqual(added.deliveries.map((d) => d.channel), ['email']);

  const csv = 'email,mobile\nimport.a@example.com,\n,+353 85 555 0101\nimport.c@example.com,+353 85 555 0102';
  const check = await hr('POST', '/api/hr/participants/import/validate', { programmeId: 'prog_general', csv });
  const r = await hr('POST', '/api/hr/participants/import/commit', { programmeId: 'prog_general', rows: check.rows.map((x) => x.input), send: true });
  assert.deepEqual({ created: r.created, sent: r.sent, notSent: r.notSent }, { created: 3, sent: 3, notSent: 0 });

  // In the organisation's own workspace: a draft programme cannot send, and credits are checked before anyone is added.
  await inOwnWorkspace(async () => {
    const { programme: draft } = await hr('POST', '/api/hr/programmes', { name: 'Draft for add-and-send' });
    assert.equal(draft.status, 'draft');
    const before = (await hr('GET', '/api/hr/participants')).participants.length;
    assert.equal((await call('POST', '/api/hr/participants', { programmeId: draft.id, email: 'nope@example.com', send: true })).status, 409);
    assert.equal((await hr('GET', '/api/hr/participants')).participants.length, before, 'nobody is added half-way');
    const plain = await hr('POST', '/api/hr/participants', { programmeId: draft.id, email: 'later@example.com' });
    assert.equal(plain.participant.invitation.status, 'prepared', 'adding without sending still works');
  });
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

test('a restricted live Stripe key counts as live payments', async () => {
  const { stripeMode } = await import('../src/routes/billing.js');
  const before = process.env.STRIPE_SECRET_KEY;
  try {
    for (const [key, mode] of [['rk_live_abc', 'live'], ['sk_live_abc', 'live'], ['sk_test_abc', 'test'], ['rk_test_abc', 'test']]) {
      process.env.STRIPE_SECRET_KEY = key;
      assert.equal(stripeMode(), mode, key);
    }
  } finally {
    if (before === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = before;
  }
});

test('with self-service buying off, prices are hidden and purchases refused', async () => {
  const before = process.env.SELF_SERVE_CREDITS;
  process.env.SELF_SERVE_CREDITS = '0';
  process.env.CREDITS_CONTACT_EMAIL = 'sales@partways.test';
  try {
    await inOwnWorkspace(async () => {
      const b = await hr('GET', '/api/hr/billing');
      assert.equal(b.selfServe, false);
      assert.equal(b.packs, undefined, 'no prices');
      assert.equal(b.contactEmail, 'sales@partways.test');
      for (const path of ['/api/hr/billing/checkout', '/api/hr/billing/simulate']) {
        const r = await call('POST', path, { pack: 'pack_10' });
        assert.equal(r.status, 403, path);
        assert.match(r.body.error, /sales@partways\.test/);
      }
    });
  } finally {
    if (before === undefined) delete process.env.SELF_SERVE_CREDITS; else process.env.SELF_SERVE_CREDITS = before;
    delete process.env.CREDITS_CONTACT_EMAIL;
  }
});
