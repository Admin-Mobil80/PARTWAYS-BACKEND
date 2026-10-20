// Per-request workspace. Every store() call inside a request reads and writes only
// the namespace resolved for that request.
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

export const runInWorkspace = (ns, fn) => als.run({ ns }, fn);
export const currentWorkspace = () => als.getStore()?.ns || null;
