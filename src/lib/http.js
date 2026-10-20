// Minimal router shared by the Lambda handler and the local dev server.
// A handler returns { status, body, headers } or { stream: async (write) => {} }.

const routes = [];

export class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

export function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, re, keys, handler, opts });
}

export const ok = (body, status = 200, headers = {}) => ({ status, body, headers });
export const fail = (status, message, details) => { throw new HttpError(status, message, details); };

export async function dispatch(req, { authenticate }) {
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = req.path.match(r.re);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    try {
      let user = null;
      if (r.opts.auth) {
        user = await authenticate(req);
        if (!user) return { status: 401, body: { error: 'Please sign in to continue.' } };
      }
      const res = await r.handler({ ...req, params, user });
      if (res?.stream) return res;
      const wrapped = res && typeof res.status === 'number' && 'body' in res;
      return wrapped ? { status: res.status, body: res.body, headers: res.headers || {} } : { status: 200, body: res, headers: {} };
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, body: { error: err.message, details: err.details } };
      console.error(err);
      return { status: 500, body: { error: 'Something went wrong on our side. Your work has been kept; please try again.' } };
    }
  }
  return { status: 404, body: { error: 'Not found' } };
}
