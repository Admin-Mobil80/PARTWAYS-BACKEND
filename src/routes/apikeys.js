// API keys for the PartWays API, managed by owners in their organisation's own workspace.
import { route, fail } from '../lib/http.js';
import { store } from '../lib/data.js';
import { listApiKeys, createApiKey, revokeApiKey } from '../domain/apikeys.js';

async function ownersOnly(req) {
  if ((await store().get('org', 'org'))?.demo) fail(409, 'API keys belong to your own workspace, not the demonstration.');
  if (req.user.role !== 'owner') fail(403, 'Only owners can manage API keys.');
}

route('GET', '/api/hr/apikeys', async (req) => {
  await ownersOnly(req);
  return { keys: await listApiKeys(req.user.orgId) };
}, { auth: true });

// The full key is in this response only.
route('POST', '/api/hr/apikeys', async (req) => {
  await ownersOnly(req);
  return createApiKey(req.user.orgId, { name: req.body?.name, by: req.user.email });
}, { auth: true });

route('DELETE', '/api/hr/apikeys/:id', async (req) => {
  await ownersOnly(req);
  return { key: await revokeApiKey(req.user.orgId, req.params.id, req.user.email) };
}, { auth: true });
