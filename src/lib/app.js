// Shared request handling for Lambda and the local server.
import '../routes/index.js';
import { dispatch } from './http.js';
import { runInWorkspace } from './context.js';
import { authenticate } from '../auth/index.js';
import { orgForToken } from '../store/index.js';
import { demoNamespace, ensureDemoWorkspace } from '../domain/workspaces.js';

// Every request runs inside one workspace: the signed-in person's organisation (or
// its demonstration copy), or for employee links the workspace the link belongs to.
async function resolveWorkspace(req) {
  const p = req.path;
  if (p.startsWith('/api/hr/')) {
    const user = await authenticate(req);
    if (!user) return { ns: 'global', user: null };
    const demo = req.headers?.['x-workspace'] === 'demo';
    const ns = demo ? demoNamespace(user.orgId) : user.orgId;
    if (demo) await ensureDemoWorkspace(ns);
    return { ns, user: { ...user, workspace: demo ? 'demo' : 'own' } };
  }
  const m = p.match(/^\/api\/invite\/([^/]+)/);
  const token = m ? decodeURIComponent(m[1]) : (p.startsWith('/api/session/') || p.startsWith('/api/voice/')) ? req.headers?.['x-session-token'] : null;
  if (token) return { ns: (await orgForToken(token)) || 'global', user: null };
  return { ns: 'global', user: null };
}

// Owners run the workspace; analysts work with findings and themes; leaders read and act on findings.
// The demo workspace keeps its "View as" switch, so it is not restricted.
const FINDINGS = ['/api/hr/insights', '/api/hr/assistant', '/api/hr/reports', '/api/hr/actions', '/api/hr/bookmarks'];
function allowed(user, req) {
  if (!user || user.workspace === 'demo' || user.role === 'owner' || req.method === 'GET') return true;
  if (FINDINGS.some((x) => req.path.startsWith(x))) return true;
  if (req.path.startsWith('/api/hr/taxonomy')) return user.role === 'analyst';
  return /^\/api\/hr\/programmes\/[^/]+\/preview$/.test(req.path);
}

export async function handle(req) {
  const { ns, user } = await resolveWorkspace(req);
  if (!allowed(user, req)) return { status: 403, body: { error: 'Your role cannot make this change. Ask an owner of your workspace.' }, headers: {} };
  const res = await runInWorkspace(ns, () => dispatch(req, { authenticate: async () => user }));
  if (res?.stream) {
    const inner = res.stream;
    res.stream = (write) => runInWorkspace(ns, () => inner(write));
  }
  return res;
}

export { encodeBody, contentTypeFor } from './http.js';
