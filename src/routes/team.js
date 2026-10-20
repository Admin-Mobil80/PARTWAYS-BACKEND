// Team members of an organisation's own workspace. Only owners manage the team.
import { route, fail } from '../lib/http.js';
import { store } from '../lib/data.js';
import { normaliseEmail } from '../auth/index.js';
import { addMember, setMemberRole, removeMember } from '../domain/workspaces.js';

async function ownersOnly(req) {
  if ((await store().get('org', 'org'))?.demo) fail(409, 'Team members are managed in your own workspace.');
  if (req.user.role !== 'owner') fail(403, 'Only owners can manage the team.');
}

route('GET', '/api/hr/team', async (req) => {
  const members = (await store().list('member')).sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  return { members: members.map((m) => ({ ...m, you: m.id === req.user.email })) };
}, { auth: true });

route('POST', '/api/hr/team', async (req) => {
  await ownersOnly(req);
  const member = await addMember(req.user.orgId, { email: normaliseEmail(req.body?.email), role: req.body?.role || 'analyst', addedBy: req.user.email });
  return { member };
}, { auth: true });

route('PUT', '/api/hr/team/:email', async (req) => {
  await ownersOnly(req);
  return { member: await setMemberRole(req.user.orgId, normaliseEmail(req.params.email), req.body?.role) };
}, { auth: true });

route('DELETE', '/api/hr/team/:email', async (req) => {
  await ownersOnly(req);
  const email = normaliseEmail(req.params.email);
  if (email === req.user.email) fail(409, 'You cannot remove yourself.');
  await removeMember(req.user.orgId, email);
  return { ok: true };
}, { auth: true });
