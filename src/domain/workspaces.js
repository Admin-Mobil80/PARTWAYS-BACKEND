// Organisation workspaces, credits and PartWays Interview Ids.
// Each organisation has its own workspace namespace, plus a private copy of the
// demonstration workspace (`<orgId>~demo`) so evaluation interviews never mix.
import crypto from 'node:crypto';
import { getStore } from '../store/index.js';
import { fail } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { resetDemo } from './demo.js';
import { newProgramme } from './programmes.js';
import { newInterviewId } from './interview-ids.js';

export const FREE_CREDITS = 3;
export const PACKS = {
  pack_10: { id: 'pack_10', credits: 10, usd: 100 },
  pack_25: { id: 'pack_25', credits: 25, usd: 200 },
  pack_50: { id: 'pack_50', credits: 50, usd: 300 },
  pack_100: { id: 'pack_100', credits: 100, usd: 500 },
};

export const demoNamespace = (orgId) => `${orgId}~demo`;
export const isDemoNamespace = (ns) => ns === 'demo' || String(ns).endsWith('~demo');

const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const nowIso = () => new Date().toISOString();

export async function createOrganisation({ orgName, name = '', country, email }) {
  const g = getStore('global');
  const orgId = `org_${crypto.randomBytes(8).toString('hex')}`;
  const at = nowIso();
  await g.put('org', { id: orgId, name: orgName, country, ownerEmail: email, createdAt: at });
  await g.put('user', { id: email, email, name, orgId, role: 'owner', createdAt: at });
  const s = getStore(orgId);
  const org = {
    id: 'org', orgId, name: orgName, shortName: orgName.length > 28 ? initials(orgName) : orgName, brandColor: '#0f766e',
    logoText: initials(orgName), hrContactName: `${orgName} People Team`, country, demo: false, createdAt: at,
  };
  await s.put('org', org);
  await s.put('member', { id: email, email, name, role: 'owner', addedAt: at, addedBy: null });
  await s.put('ledger', { id: newId('led'), at, kind: 'free_grant', delta: FREE_CREDITS, note: `${FREE_CREDITS} free interviews` });
  await s.put('programme', newProgramme({ name: 'Exit interviews', template: 'general', org }));
  return { orgId };
}

// The demonstration workspace is created the first time an organisation opens it.
export async function ensureDemoWorkspace(ns) {
  const s = getStore(ns);
  if (!(await s.get('org', 'org'))) await resetDemo(s);
}

// --- Team members: each person belongs to one organisation; the owner manages the team. ---
export const TEAM_ROLES = ['owner', 'analyst', 'leader'];

export async function addMember(orgId, { email, role, addedBy }) {
  const g = getStore('global');
  if (!TEAM_ROLES.includes(role)) fail(400, 'Choose a role.');
  const existing = await g.get('user', email);
  if (existing) fail(409, existing.orgId === orgId ? 'This person is already in your team.' : 'This email already belongs to another PartWays workspace.');
  const at = nowIso();
  await g.put('user', { id: email, email, name: '', orgId, role, createdAt: at });
  const member = { id: email, email, name: '', role, addedAt: at, addedBy };
  await getStore(orgId).put('member', member);
  return member;
}

export async function setMemberRole(orgId, email, role) {
  if (!TEAM_ROLES.includes(role)) fail(400, 'Choose a role.');
  const s = getStore(orgId), g = getStore('global');
  const member = await s.get('member', email);
  if (!member) fail(404, 'Team member not found.');
  if (member.role === 'owner' && role !== 'owner') await keepAnOwner(s, email);
  const user = await g.get('user', email);
  await g.put('user', { ...user, role });
  await s.put('member', { ...member, role });
  return { ...member, role };
}

export async function removeMember(orgId, email) {
  const s = getStore(orgId), g = getStore('global');
  const member = await s.get('member', email);
  if (!member) fail(404, 'Team member not found.');
  if (member.role === 'owner') await keepAnOwner(s, email);
  await s.delete('member', email);
  const user = await g.get('user', email);
  if (user?.orgId === orgId) await g.delete('user', email);
}

async function keepAnOwner(s, leaving) {
  const owners = (await s.list('member')).filter((m) => m.role === 'owner' && m.id !== leaving);
  if (!owners.length) fail(409, 'A workspace needs at least one owner. Make someone else an owner first.');
}

// --- Credits: one credit per invitation sent. Reminders are free. ---------------
export async function creditSummary(store) {
  const org = await store.get('org', 'org');
  const ledger = (await store.list('ledger')).sort((a, b) => b.at.localeCompare(a.at));
  const balance = ledger.reduce((n, e) => n + e.delta, 0);
  return { unlimited: !!org?.demo, balance, ledger };
}

export async function consumeCredit(store, participant, by = null) {
  const { unlimited, balance } = await creditSummary(store);
  if (unlimited) return null;
  if (balance < 1) fail(402, 'You have no interview credits left. Get more credits (Credits and billing) to send more invitations.', { code: 'no_credits' });
  const entry = { id: newId('led'), at: nowIso(), kind: 'invite', delta: -1, interviewId: participant.interviewId, note: `Invitation ${participant.interviewId}`, ...(by ? { by } : {}) };
  await store.put('ledger', entry);
  return entry;
}

// Idempotent: a purchase is recorded once however many times it is confirmed.
export async function grantPurchase(store, { ref, packId, simulated = false, amountUsd, by = null }) {
  const pack = PACKS[packId];
  if (!pack) fail(400, 'Unknown credit pack.');
  const id = `purchase_${ref}`;
  const existing = await store.get('ledger', id);
  if (existing) return { entry: existing, duplicate: true };
  const entry = { id, at: nowIso(), kind: 'purchase', delta: pack.credits, packId, amountUsd: amountUsd ?? pack.usd, simulated, note: `${pack.credits} credits${simulated ? ' (test purchase)' : ''}`, ...(by ? { by } : {}) };
  await store.put('ledger', entry);
  return { entry, duplicate: false };
}

// --- PartWays Interview Ids: PW-XXXX-XXXX, unique across all workspaces. ----------
export async function assignInterviewId(ns, participantId) {
  const g = getStore('global');
  for (let i = 0; i < 8; i++) {
    const id = newInterviewId();
    if (await g.get('interview', id)) continue;
    await g.put('interview', { id, orgId: ns, participantId, at: nowIso() });
    return id;
  }
  throw new Error('Could not allocate an interview id');
}
