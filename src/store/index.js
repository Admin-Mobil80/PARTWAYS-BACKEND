// Storage facade. Every entity is a JSON document addressed by (type, id) within a
// namespace: one per organisation workspace, one per organisation's demonstration
// workspace, and 'global' for accounts, sign-in codes and lookup indexes.
// DynamoDB in AWS, a JSON file locally.
import { createFileStore } from './file.js';
import { createDynamoStore } from './dynamo.js';

let base;
const scoped = new Map();

function baseStore() {
  if (!base) {
    base = process.env.STORE === 'dynamo' || process.env.TABLE_NAME
      ? createDynamoStore(process.env.TABLE_NAME)
      : createFileStore(process.env.DATA_FILE || new URL('../../data/store.json', import.meta.url).pathname);
  }
  return base;
}

// Tokens that reach the public employee routes are indexed globally so a request
// can be routed to the right workspace without exposing which one it is.
function indexEntries(ns, type, item) {
  if (ns === 'global') return [];
  const out = [];
  if (type === 'participant' && item.invitation?.token) out.push({ id: item.invitation.token, orgId: ns });
  if (type === 'session' && item.accessToken) out.push({ id: item.accessToken, orgId: ns });
  return out;
}

export function getStore(ns) {
  if (!ns) throw new Error('Store namespace required');
  if (scoped.has(ns)) return scoped.get(ns);
  const b = baseStore();
  const s = {
    ns,
    get: (type, id) => b.get(ns, type, id),
    async put(type, item) {
      await b.put(ns, type, item);
      const idx = indexEntries(ns, type, item);
      if (idx.length) await b.putMany('global', 'token', idx);
      return item;
    },
    delete: (type, id) => b.delete(ns, type, id),
    list: (type) => b.list(ns, type),
    async putMany(type, items) {
      await b.putMany(ns, type, items);
      const idx = items.flatMap((i) => indexEntries(ns, type, i));
      if (idx.length) await b.putMany('global', 'token', idx);
    },
    clear: (types) => b.clear(ns, types),
    flushNow: () => b.flushNow?.(),
  };
  scoped.set(ns, s);
  return s;
}

export async function orgForToken(token) {
  if (!token) return null;
  return (await getStore('global').get('token', String(token)))?.orgId || null;
}

export function setBaseStore(s) { base = s; scoped.clear(); }

export const TYPES = [
  'org', 'programme', 'participant', 'session', 'report', 'action', 'bookmark', 'ledger', 'member', 'meta',
];
