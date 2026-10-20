import fs from 'node:fs';
import path from 'node:path';

// Local development store: whole dataset in memory, flushed to one JSON file.
// Layout: { v: 2, ns: { <namespace>: { <type>: { <id>: item } } } }.
export function createFileStore(file) {
  let data = { v: 2, ns: {} };
  if (fs.existsSync(file)) {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (loaded.v === 2) data = loaded;
    else console.log('[PartWays] Older single-workspace data file found; starting fresh.');
  }
  let timer = null;
  const flush = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(flush, 50); };
  const bucket = (ns, type) => ((data.ns[ns] ||= {})[type] ||= {});
  const clone = (v) => (v == null ? v : structuredClone(v));

  return {
    async get(ns, type, id) { return clone(bucket(ns, type)[id]) ?? null; },
    async put(ns, type, item) {
      if (!item.id) throw new Error('item.id required');
      bucket(ns, type)[item.id] = clone(item);
      schedule();
      return item;
    },
    async delete(ns, type, id) { delete bucket(ns, type)[id]; schedule(); },
    async list(ns, type) { return Object.values(bucket(ns, type)).map(clone); },
    async putMany(ns, type, items) { for (const i of items) bucket(ns, type)[i.id] = clone(i); schedule(); },
    async clear(ns, types) { for (const t of types) (data.ns[ns] ||= {})[t] = {}; schedule(); },
    flushNow() { clearTimeout(timer); flush(); },
  };
}
