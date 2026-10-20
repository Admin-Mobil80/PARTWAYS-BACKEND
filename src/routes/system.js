// Sign-in, organisation appearance and demonstration controls.
import { route, fail } from '../lib/http.js';
import { store, globalStore, nowIso } from '../lib/data.js';
import { startLogin, startSignup, verifyLogin } from '../auth/index.js';
import { creditSummary } from '../domain/workspaces.js';
import { resetDemo, resetEvaluation } from '../domain/demo.js';
import { createParticipant } from './participants.js';
import { SERVICE } from '../domain/catalog.js';

route('POST', '/api/auth/start', async (req) => startLogin(req.body?.email));
route('POST', '/api/auth/signup', async (req) => startSignup(req.body));
route('POST', '/api/auth/verify', async (req) => verifyLogin(req.body?.email, req.body?.code, req.body?.session));
route('GET', '/api/hr/me', async (req) => {
  const { unlimited, balance } = await creditSummary(store());
  const own = await globalStore().get('org', req.user.orgId);
  return { email: req.user.email, name: req.user.name, role: req.user.role, workspace: req.user.workspace, organisation: own?.name, credits: { unlimited, balance } };
}, { auth: true });

route('GET', '/api/hr/org', async () => ({ org: await store().get('org', 'org'), service: SERVICE, meta: await store().get('meta', 'demo') }), { auth: true });
route('PUT', '/api/hr/org', async (req) => {
  const org = await store().get('org', 'org');
  const b = req.body || {};
  if (b.name) org.name = String(b.name).slice(0, 120);
  if (b.shortName) org.shortName = String(b.shortName).slice(0, 60);
  if (b.brandColor) { if (!/^#[0-9a-f]{6}$/i.test(b.brandColor)) fail(400, 'Use a colour like #0f766e.'); org.brandColor = b.brandColor; }
  if (b.logoText !== undefined) org.logoText = String(b.logoText).slice(0, 40);
  await store().put('org', org);
  if (!org.demo && b.name) {
    const g = await globalStore().get('org', req.user.orgId);
    if (g) await globalStore().put('org', { ...g, name: org.name });
  }
  return { org };
}, { auth: true });

route('POST', '/api/hr/demo/reset', async (req) => {
  if (!(await store().get('org', 'org'))?.demo) fail(409, 'Only the demonstration workspace can be reset.');
  const scope = req.body?.scope;
  if (scope === 'evaluation') return { scope, removed: await resetEvaluation(store()) };
  if (scope === 'all') return { scope, created: await resetDemo(store()) };
  fail(400, 'Choose what to reset.');
}, { auth: true });

const PERSONAS = {
  positive_move: { label: 'Positive career move', brief: 'You enjoyed your time, liked your manager and team, and are leaving for a bigger role elsewhere. Answer naturally in your own words.', segment: { businessUnit: 'Technology', function: 'Engineering', location: 'Manchester', tenureBand: '3–5 years', roleLevel: 'Individual contributor' } },
  early_mismatch: { label: 'Early-tenure mismatch', brief: 'You joined four months ago. The role turned out to be different from the advert, and your first weeks were disorganised. Your buddy was helpful.', segment: { businessUnit: 'Customer Service', function: 'Claims', location: 'Leeds', tenureBand: 'Under 6 months', roleLevel: 'Individual contributor' }, programmeId: 'prog_early' },
  workload: { label: 'Repeated workload concerns', brief: 'You raised workload with your manager several times. The team was short-staffed for months. You are tired but still care about colleagues.', segment: { businessUnit: 'Customer Service', function: 'Customer support', location: 'Manchester', tenureBand: '1–3 years', roleLevel: 'Team lead' } },
  personal: { label: 'Personal reasons only', brief: 'You are relocating for family reasons. You have nothing negative to say and would prefer to keep it brief.', segment: { businessUnit: 'Finance', function: 'Finance operations', location: 'Manchester', tenureBand: '5+ years', roleLevel: 'Manager' } },
};

route('GET', '/api/hr/demo/personas', async () => ({ personas: PERSONAS }), { auth: true });

// "Try an interview": in the demonstration workspace, a fresh evaluation participant
// with a real invitation link. Own workspaces use the free programme preview instead.
route('POST', '/api/hr/demo/try', async (req) => {
  if (!(await store().get('org', 'org'))?.demo) fail(409, 'Use Preview on a programme to try an interview in your own workspace. Previews are free.');
  const persona = PERSONAS[req.body?.persona] || null;
  const programmeId = req.body?.programmeId || persona?.programmeId || 'prog_general';
  const programme = await store().get('programme', programmeId);
  if (!programme || programme.status !== 'active') fail(409, 'Choose an active programme.');
  const n = (await store().list('participant')).filter((p) => p.population === 'evaluation').length + 1;
  const seg = persona?.segment || { businessUnit: 'Operations', function: 'Transport planning', location: 'Leeds', tenureBand: '1–3 years', roleLevel: 'Individual contributor' };
  const p = await createParticipant(programme, {
    mobile: `+44 7700 900${String(900 + (n % 100)).padStart(3, '0')}`,
    preferredLanguage: req.body?.language || 'en', departureDate: new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10), ...seg,
  }, 'evaluation');
  p.invitation.status = 'sent';
  p.invitation.sentAt = nowIso();
  p.persona = req.body?.persona || null;
  await store().put('participant', p);
  return { participant: { id: p.id, interviewId: p.interviewId }, link: `/interview/#/i/${p.invitation.token}`, persona };
}, { auth: true });
