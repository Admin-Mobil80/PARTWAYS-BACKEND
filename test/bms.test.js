// BMS API checks through its handler, against a fresh local store.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-bms-test-'));
process.env.DATA_FILE = path.join(dir, 'store.json');
process.env.DEV_SHOW_OTP = '1';
process.env.AUTH_SECRET = 'test-secret';
process.env.BMS_ROOT_EMAIL = 'root@partways.test';
delete process.env.TABLE_NAME;
delete process.env.BMS_USER_POOL_ID;
delete process.env.COGNITO_USER_POOL_ID;
delete process.env.HR_ALLOWED_EMAILS;

const website = (await import('../src/lib/app.js')).handle;
const bms = (await import('../src/bms/app.js')).handle;

const req = (method, p, body, token) => ({ method, path: p, query: {}, headers: { authorization: token ? `Bearer ${token}` : undefined }, body: body ?? null });

async function bmsSignIn(email) {
  const start = await bms(req('POST', '/api/bms/auth/start', { email }));
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const v = await bms(req('POST', '/api/bms/auth/verify', { email, code: start.body.devCode }));
  assert.equal(v.status, 200, JSON.stringify(v.body));
  return v.body.token;
}

let root, hrToken, orgId;

before(async () => {
  const start = await website(req('POST', '/api/auth/signup', { email: 'owner@acme.test', orgName: 'Acme Ltd', country: 'GB' }));
  const v = await website(req('POST', '/api/auth/verify', { email: 'owner@acme.test', code: start.body.devCode }));
  assert.equal(v.status, 200, JSON.stringify(v.body));
  hrToken = v.body.token;
  orgId = v.body.orgId;
  root = await bmsSignIn('root@partways.test');
});

test('only the team can sign in, and website tokens are not accepted', async () => {
  const outsider = await bms(req('POST', '/api/bms/auth/start', { email: 'owner@acme.test' }));
  assert.equal(outsider.status, 403);
  const withHrToken = await bms(req('GET', '/api/bms/me', null, hrToken));
  assert.equal(withHrToken.status, 401);
  const me = await bms(req('GET', '/api/bms/me', null, root));
  assert.deepEqual(me.body, { email: 'root@partways.test', role: 'root' });
});

test('the website and the BMS cannot reach each other\'s routes', async () => {
  assert.equal((await website(req('GET', '/api/bms/orgs', null, root))).status, 404);
  assert.equal((await bms(req('GET', '/api/hr/me', null, hrToken))).status, 404);
});

test('organisations list their usage, and the overview adds them up', async () => {
  const { body } = await bms(req('GET', '/api/bms/orgs', null, root));
  const acme = body.organisations.find((o) => o.id === orgId);
  assert.equal(acme.name, 'Acme Ltd');
  assert.equal(acme.ownerEmail, 'owner@acme.test');
  assert.equal(acme.creditBalance, 3);
  assert.equal(acme.members, 1);
  const overview = (await bms(req('GET', '/api/bms/overview', null, root))).body;
  assert.equal(overview.organisations, 1);
  assert.equal(overview.signupsLast7Days, 1);
  assert.equal(overview.creditsOutstanding, 3);
});

test('credit adjustments need a reason, cannot go below zero, and are audited', async () => {
  const path = `/api/bms/orgs/${orgId}/credits`;
  assert.equal((await bms(req('POST', path, { delta: 5 }, root))).status, 400);
  assert.equal((await bms(req('POST', path, { delta: 0, reason: 'nothing' }, root))).status, 400);
  assert.equal((await bms(req('POST', path, { delta: -10, reason: 'too many' }, root))).status, 409);
  const added = await bms(req('POST', path, { delta: 5, reason: 'Pilot customer' }, root));
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.balance, 8);
  assert.equal(added.body.entry.note, '5 credits added by PartWays');

  // The organisation sees the new balance, without the internal reason.
  const billing = await website({ ...req('GET', '/api/hr/billing', null, hrToken), headers: { authorization: `Bearer ${hrToken}`, 'x-workspace': 'own' } });
  assert.equal(billing.body.balance, 8);
  assert.ok(!JSON.stringify(billing.body).includes('Pilot customer'));

  const detail = (await bms(req('GET', `/api/bms/orgs/${orgId}`, null, root))).body;
  assert.equal(detail.organisation.creditBalance, 8);
  assert.equal(detail.audit[0].reason, 'Pilot customer');
  assert.equal(detail.audit[0].by, 'root@partways.test');
});

test('the audit log includes organisations\' credit activity with balances', async () => {
  const hr = (method, p, body) => website({ ...req(method, p, body, hrToken), headers: { authorization: `Bearer ${hrToken}`, 'x-workspace': 'own' } });
  const bought = await hr('POST', '/api/hr/billing/simulate', { pack: 'pack_10' });
  assert.equal(bought.status, 200, JSON.stringify(bought.body));
  const { entries } = (await bms(req('GET', '/api/bms/audit', null, root))).body;
  const acme = entries.filter((e) => e.orgId === orgId);
  const free = acme.find((e) => e.action === 'credits_free');
  assert.equal(free.delta, 3);
  assert.equal(free.balanceAfter, 3);
  const purchase = acme.find((e) => e.action === 'credits_bought');
  assert.equal(purchase.delta, 10);
  assert.equal(purchase.by, 'owner@acme.test');
  assert.equal(purchase.simulated, true);
  assert.equal(purchase.balanceAfter, 18, 'after the free 3 and the 5 added by PartWays');
  // The manual adjustment appears once, as the BMS change with its reason.
  assert.equal(acme.filter((e) => e.action === 'credits_adjusted').length, 1);
  assert.ok(entries.every((e, i) => i === 0 || entries[i - 1].at >= e.at), 'newest first');
});

test('only the root manages the team; removal ends access at once', async () => {
  assert.equal((await bms(req('POST', '/api/bms/team', { email: 'ops@partways.test' }, root))).status, 200);
  const ops = await bmsSignIn('ops@partways.test');
  assert.equal((await bms(req('GET', '/api/bms/orgs', null, ops))).status, 200);
  assert.equal((await bms(req('POST', '/api/bms/team', { email: 'x@partways.test' }, ops))).status, 403);
  assert.equal((await bms(req('DELETE', '/api/bms/team/root@partways.test', null, root))).status, 409);
  assert.equal((await bms(req('DELETE', '/api/bms/team/ops@partways.test', null, root))).status, 200);
  assert.equal((await bms(req('GET', '/api/bms/orgs', null, ops))).status, 401);
  const audit = (await bms(req('GET', '/api/bms/audit', null, root))).body.entries.map((e) => e.action);
  assert.ok(audit.includes('team_member_added') && audit.includes('team_member_removed'));
});
