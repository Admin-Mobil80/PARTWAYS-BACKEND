// API keys let an organisation's own systems, such as its HR system, call the
// PartWays API (/api/v1). A key is shown once when it is created; PartWays keeps
// only a hash of its secret. Each key's id is indexed globally so a request can
// be routed to its workspace without saying which one it is.
import crypto from 'node:crypto';
import { getStore } from '../store/index.js';
import { nowIso } from '../lib/data.js';
import { fail } from '../lib/http.js';

const PREFIX = 'pw_live_';
const MAX_ACTIVE = 10;
const KEY_RE = /^pw_live_([0-9a-f]{12})_([A-Za-z0-9_-]{32})$/;
const hash = (secret) => crypto.createHash('sha256').update(secret).digest('hex');

// What the workspace sees: never the hash.
export function keyView({ hash: _hash, ...k }) {
  return { ...k, display: `${PREFIX}${k.id}_…${k.last4}` };
}

export async function listApiKeys(orgId) {
  const keys = await getStore(orgId).list('apikey');
  return keys.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(keyView);
}

export async function createApiKey(orgId, { name, by }) {
  const label = String(name || '').trim().slice(0, 60);
  if (!label) fail(400, 'Give the key a name, for example the HR system that will use it.');
  const s = getStore(orgId);
  if ((await s.list('apikey')).filter((k) => !k.revokedAt).length >= MAX_ACTIVE) fail(409, `A workspace can have up to ${MAX_ACTIVE} active keys. Revoke one you no longer use.`);
  const id = crypto.randomBytes(6).toString('hex');
  const secret = crypto.randomBytes(24).toString('base64url');
  const key = { id, name: label, hash: hash(secret), last4: secret.slice(-4), createdAt: nowIso(), createdBy: by, lastUsedAt: null, revokedAt: null, revokedBy: null };
  await s.put('apikey', key);
  await getStore('global').put('apikey', { id, orgId });
  return { key: keyView(key), secret: `${PREFIX}${id}_${secret}` };
}

export async function revokeApiKey(orgId, id, by) {
  const s = getStore(orgId);
  const key = await s.get('apikey', id);
  if (!key) fail(404, 'API key not found.');
  if (!key.revokedAt) {
    Object.assign(key, { revokedAt: nowIso(), revokedBy: by });
    await s.put('apikey', key);
  }
  return keyView(key);
}

// The key a request carries (Authorization: Bearer <key>, or X-API-Key), and its
// organisation. Null for a missing, malformed, unknown or revoked key.
export async function authenticateApiKey(req) {
  const auth = req.headers?.authorization || req.headers?.Authorization || '';
  const raw = (auth.startsWith('Bearer ') ? auth.slice(7) : req.headers?.['x-api-key'] || '').trim();
  const m = raw.match(KEY_RE);
  if (!m) return null;
  const idx = await getStore('global').get('apikey', m[1]);
  if (!idx) return null;
  const s = getStore(idx.orgId);
  const key = await s.get('apikey', m[1]);
  if (!key || key.revokedAt) return null;
  if (!crypto.timingSafeEqual(Buffer.from(key.hash, 'hex'), Buffer.from(hash(m[2]), 'hex'))) return null;
  // Last use is recorded at most once a minute.
  if (!key.lastUsedAt || Date.now() - Date.parse(key.lastUsedAt) > 60_000) {
    key.lastUsedAt = nowIso();
    await s.put('apikey', key);
  }
  return { orgId: idx.orgId, key };
}
