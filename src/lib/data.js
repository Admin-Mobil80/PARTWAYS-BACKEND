import { getStore } from '../store/index.js';
import { currentWorkspace } from './context.js';
import { fail } from './http.js';

// The current request's workspace. Throws outside a request so nothing can write to an unscoped store.
export const store = () => {
  const ns = currentWorkspace();
  if (!ns) throw new Error('No workspace for this request');
  return getStore(ns);
};
export const globalStore = () => getStore('global');

export async function must(type, id, label = 'Item') {
  const item = await store().get(type, id);
  if (!item) fail(404, `${label} not found.`);
  return item;
}

export async function loadAll() {
  const s = store();
  const [org, programmes, participants, sessions] = await Promise.all([
    s.get('org', 'org'), s.list('programme'), s.list('participant'), s.list('session'),
  ]);
  return { org, programmes, participants, sessions };
}

export async function findParticipantByToken(token) {
  const all = await store().list('participant');
  return all.find((p) => p.invitation?.token === token) || null;
}

export const nowIso = () => new Date().toISOString();
