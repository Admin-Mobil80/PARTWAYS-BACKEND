// BMS API for the PartWays team: organisations, their usage and credits, the
// team itself, and an audit log of every change made from here.
import { createRouter, fail } from '../lib/http.js';
import { getStore } from '../store/index.js';
import { newId } from '../lib/ids.js';
import { creditSummary } from '../domain/workspaces.js';
import { authenticate, normaliseEmail, startLogin, teamMember, verifyLogin } from './auth.js';

export const bms = createRouter();
const { route } = bms;
export { authenticate };

const g = () => getStore('global');
const nowIso = () => new Date().toISOString();
const DAY_MS = 24 * 3600 * 1000;
const MAX_ADJUSTMENT = 1000;

async function audit(by, action, details = {}) {
  await g().put('bmsaudit', { id: `${nowIso()}_${newId('aud')}`, at: nowIso(), by, action, ...details });
}

// One organisation's usage, from its own workspace (never its demonstration copy).
async function orgStats(orgId) {
  const s = getStore(orgId);
  const [members, programmes, participants, sessions, credits] = await Promise.all([
    s.list('member'), s.list('programme'), s.list('participant'), s.list('session'), creditSummary(s),
  ]);
  const purchases = credits.ledger.filter((e) => e.kind === 'purchase');
  const paid = purchases.filter((e) => !e.simulated);
  const activity = [
    ...credits.ledger.map((e) => e.at),
    ...sessions.map((x) => x.updatedAt || x.startedAt),
    ...participants.map((p) => p.invitation?.sentAt),
  ].filter(Boolean).sort();
  return {
    members: members.length,
    programmes: programmes.length,
    invitationsSent: participants.filter((p) => p.invitation?.sentAt).length,
    interviewsCompleted: sessions.filter((x) => x.status === 'submitted').length,
    creditBalance: credits.balance,
    revenueUsd: paid.reduce((n, e) => n + (e.amountUsd || 0), 0),
    purchases: paid.length,
    testPurchases: purchases.length - paid.length,
    lastActivityAt: activity.at(-1) || null,
    _detail: { members, programmes, participants, sessions, ledger: credits.ledger },
  };
}

async function allOrgs() {
  const orgs = await g().list('org');
  return Promise.all(orgs.map(async (o) => {
    const { _detail, ...stats } = await orgStats(o.id);
    return { id: o.id, name: o.name, country: o.country, ownerEmail: o.ownerEmail, createdAt: o.createdAt, ...stats };
  }));
}

async function mustOrg(id) {
  const org = await g().get('org', id);
  if (!org) fail(404, 'Organisation not found.');
  return org;
}

const rootOnly = (req) => { if (req.user.role !== 'root') fail(403, 'Only the root account can manage the team.'); };

// --- Sign-in -----------------------------------------------------------------
route('POST', '/api/bms/auth/start', async (req) => startLogin(req.body?.email));
route('POST', '/api/bms/auth/verify', async (req) => verifyLogin(req.body?.email, req.body?.code, req.body?.session));
route('GET', '/api/bms/me', async (req) => req.user, { auth: true });

// --- Overview ----------------------------------------------------------------
route('GET', '/api/bms/overview', async () => {
  const orgs = await allOrgs();
  const since = (days) => new Date(Date.now() - days * DAY_MS).toISOString();
  const sum = (k) => orgs.reduce((n, o) => n + o[k], 0);
  return {
    organisations: orgs.length,
    signupsLast30Days: orgs.filter((o) => o.createdAt >= since(30)).length,
    signupsLast7Days: orgs.filter((o) => o.createdAt >= since(7)).length,
    invitationsSent: sum('invitationsSent'),
    interviewsCompleted: sum('interviewsCompleted'),
    revenueUsd: sum('revenueUsd'),
    purchases: sum('purchases'),
    creditsOutstanding: sum('creditBalance'),
    recentSignups: orgs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5)
      .map(({ id, name, country, ownerEmail, createdAt }) => ({ id, name, country, ownerEmail, createdAt })),
  };
}, { auth: true });

// --- Organisations -----------------------------------------------------------
route('GET', '/api/bms/orgs', async () => {
  const orgs = await allOrgs();
  return { organisations: orgs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
}, { auth: true });

route('GET', '/api/bms/orgs/:id', async (req) => {
  const org = await mustOrg(req.params.id);
  const { _detail, ...stats } = await orgStats(org.id);
  const byProgramme = (id) => _detail.participants.filter((p) => p.programmeId === id);
  const auditLog = (await g().list('bmsaudit')).filter((a) => a.orgId === org.id).sort((a, b) => b.at.localeCompare(a.at));
  return {
    organisation: { id: org.id, name: org.name, country: org.country, ownerEmail: org.ownerEmail, createdAt: org.createdAt, ...stats },
    members: _detail.members.map(({ email, name, role, addedAt }) => ({ email, name, role, addedAt }))
      .sort((a, b) => a.addedAt.localeCompare(b.addedAt)),
    programmes: _detail.programmes.map((p) => ({
      id: p.id, name: p.name, status: p.status, createdAt: p.createdAt,
      invitationsSent: byProgramme(p.id).filter((x) => x.invitation?.sentAt).length,
      interviewsCompleted: _detail.sessions.filter((x) => x.status === 'submitted' && byProgramme(p.id).some((pp) => pp.sessionIds?.includes(x.id))).length,
    })),
    ledger: _detail.ledger.map(({ id, at, kind, delta, note, amountUsd, simulated }) => ({ id, at, kind, delta, note, amountUsd, simulated })),
    audit: auditLog,
  };
}, { auth: true });

// Credits added or removed by the PartWays team. The reason stays in the BMS
// audit log; the organisation's own ledger shows only that PartWays made it.
route('POST', '/api/bms/orgs/:id/credits', async (req) => {
  const org = await mustOrg(req.params.id);
  const delta = Number(req.body?.delta);
  const reason = String(req.body?.reason || '').trim().slice(0, 500);
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_ADJUSTMENT) fail(400, `Enter a whole number of credits between -${MAX_ADJUSTMENT} and ${MAX_ADJUSTMENT}, other than 0.`);
  if (reason.length < 3) fail(400, 'Give a reason for the change.');
  const s = getStore(org.id);
  const { balance } = await creditSummary(s);
  if (balance + delta < 0) fail(409, `This organisation has ${balance} credit${balance === 1 ? '' : 's'}; you cannot remove more than that.`);
  const entry = {
    id: newId('led'), at: nowIso(), kind: 'adjustment', delta,
    note: delta > 0 ? `${delta} credit${delta === 1 ? '' : 's'} added by PartWays` : `${-delta} credit${delta === -1 ? '' : 's'} removed by PartWays`,
  };
  await s.put('ledger', entry);
  await audit(req.user.email, 'credits_adjusted', { orgId: org.id, orgName: org.name, delta, reason, balanceAfter: balance + delta });
  return { entry, balance: balance + delta };
}, { auth: true });

// --- Team --------------------------------------------------------------------
route('GET', '/api/bms/team', async (req) => {
  const members = (await g().list('bmsmember')).filter((m) => ['root', 'admin'].includes(m.role))
    .sort((a, b) => (a.role === 'root' ? -1 : b.role === 'root' ? 1 : a.addedAt.localeCompare(b.addedAt)));
  return { members: members.map((m) => ({ ...m, you: m.email === req.user.email })) };
}, { auth: true });

route('POST', '/api/bms/team', async (req) => {
  rootOnly(req);
  const email = normaliseEmail(req.body?.email);
  if (await teamMember(email)) fail(409, 'This person is already on the team.');
  const member = { id: email, email, role: 'admin', addedAt: nowIso(), addedBy: req.user.email };
  await g().put('bmsmember', member);
  await audit(req.user.email, 'team_member_added', { member: email });
  return { member };
}, { auth: true });

route('DELETE', '/api/bms/team/:email', async (req) => {
  rootOnly(req);
  const email = normaliseEmail(req.params.email);
  const member = await teamMember(email);
  if (!member) fail(404, 'Team member not found.');
  if (member.role === 'root') fail(409, 'The root account cannot be removed.');
  await g().delete('bmsmember', email);
  await audit(req.user.email, 'team_member_removed', { member: email });
  return { ok: true };
}, { auth: true });

// --- Audit log ---------------------------------------------------------------
// BMS changes plus every organisation's credit activity: free credits on sign-up,
// purchases and credits used by invitations. Manual adjustments come from the BMS
// entries, which also hold the reason. Each credit line carries the balance after it.
const LEDGER_ACTION = { free_grant: 'credits_free', purchase: 'credits_bought', invite: 'credits_used' };
route('GET', '/api/bms/audit', async () => {
  const [bmsEntries, orgs] = await Promise.all([g().list('bmsaudit'), g().list('org')]);
  const credit = (await Promise.all(orgs.map(async (o) => {
    const ledger = (await getStore(o.id).list('ledger')).sort((a, b) => a.at.localeCompare(b.at));
    let balance = 0;
    return ledger.map((e) => {
      balance += e.delta;
      if (!LEDGER_ACTION[e.kind]) return null;
      return {
        id: `${o.id}_${e.id}`, at: e.at, by: e.by || null, action: LEDGER_ACTION[e.kind], orgId: o.id, orgName: o.name,
        delta: e.delta, balanceAfter: balance, interviewId: e.interviewId || null, packId: e.packId || null,
        amountUsd: e.amountUsd ?? null, simulated: !!e.simulated,
      };
    }).filter(Boolean);
  }))).flat();
  const entries = [...bmsEntries, ...credit].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 500);
  return { entries };
}, { auth: true });
