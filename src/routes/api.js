// The PartWays API (v1), for an organisation's own systems: typically an HR system
// that starts an exit interview when someone resigns. Each request carries one of
// the workspace's API keys (Settings → API access) and acts in that workspace as
// an owner would: invitations use credits and are sent by email and/or WhatsApp
// exactly as from the workspace. Like the workspace, the API never returns
// interview content. Reference: /developers/ on the website.
import { route, fail, ok } from '../lib/http.js';
import { store, globalStore, must } from '../lib/data.js';
import { channelsOf, createParticipant, validateRow, existingContacts, noContacts, checkCanInvite, sendMessage } from './participants.js';

const API = { auth: 'api' };
const MAX_EXTERNAL_ID = 100;

const submittedAt = (p, sessions) => sessions.filter((s) => p.sessionIds.includes(s.id) && s.submittedAt).map((s) => s.submittedAt).sort().at(-1) || null;

// An invitation as the API shows it: status and dates, no contact details or content.
function apiView(p, sessions = []) {
  const inv = p.invitation;
  return {
    interviewId: p.interviewId, programmeId: p.programmeId, externalId: p.externalId || null, status: p.status,
    departureDate: p.departureDate || null,
    invitation: { status: inv.status, channels: channelsOf(p), sentAt: inv.sentAt, openedAt: inv.openedAt, deadline: inv.deadline, remindersSent: inv.reminders.length, delivered: inv.status !== 'prepared' && !inv.simulated },
    submittedAt: submittedAt(p, sessions), createdAt: p.createdAt,
  };
}

const programmeView = (p) => ({ id: p.id, name: p.name, status: p.status, template: p.template });

function cleanExternalId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).trim();
  if (!s || s.length > MAX_EXTERNAL_ID) fail(400, `externalId must be 1 to ${MAX_EXTERNAL_ID} characters.`, { code: 'invalid' });
  return s;
}

// A live (not preview or evaluation) participant of this workspace, by PartWays Interview Id.
async function byInterviewId(raw) {
  const id = String(raw || '').trim().toUpperCase();
  const idx = await globalStore().get('interview', id);
  const p = idx && idx.orgId === store().ns ? await store().get('participant', idx.participantId) : null;
  if (!p || p.population !== 'live') fail(404, 'No invitation with this Interview Id in your workspace.', { code: 'not_found' });
  return p;
}

route('GET', '/api/v1/programmes', async () => {
  const all = await store().list('programme');
  return { programmes: all.filter((p) => p.status !== 'archived').map(programmeView) };
}, API);

// Adds a departing employee to a programme and, unless send is false, sends their
// invitation straight away (one credit). With an externalId, repeating the same
// request returns the invitation already made instead of inviting twice.
route('POST', '/api/v1/invitations', async (req) => {
  const b = req.body || {};
  if (!b.programmeId) fail(400, 'programmeId is required. GET /api/v1/programmes lists your programmes.', { code: 'invalid' });
  const programme = await store().get('programme', String(b.programmeId));
  if (!programme || programme.status === 'archived') fail(404, 'Programme not found. GET /api/v1/programmes lists your programmes.', { code: 'not_found' });
  const externalId = cleanExternalId(b.externalId);
  const all = await store().list('participant');
  if (externalId) {
    const earlier = all.find((p) => p.programmeId === programme.id && p.externalId === externalId && p.status !== 'cancelled');
    if (earlier) return ok({ invitation: apiView(earlier, await store().list('session')), created: false });
  }
  const row = { email: b.email, mobile: b.mobile, departureDate: b.departureDate, businessUnit: b.businessUnit, function: b.function, location: b.location, tenureBand: b.tenureBand, roleLevel: b.roleLevel };
  const r = validateRow(row, await existingContacts(programme.id), noContacts());
  if (r.status === 'error') fail(400, r.errors.join(' '), { code: 'invalid' });
  if (r.status === 'duplicate') fail(409, r.duplicate, { code: 'duplicate' });
  const send = b.send !== false;
  if (send) await checkCanInvite(programme, 1);
  const p = await createParticipant(programme, r.clean, 'live', { source: 'api', addedBy: req.user.email, ...(externalId ? { externalId } : {}) });
  let sendError = null;
  if (send) {
    try { await sendMessage(p, 'invitation', req); } catch (err) { sendError = err.message; }
  }
  const saved = await store().get('participant', p.id);
  return ok({ invitation: apiView(saved), created: true, ...(r.warnings.length ? { warnings: r.warnings } : {}), ...(sendError ? { sendError } : {}) }, 201);
}, API);

route('GET', '/api/v1/invitations', async (req) => {
  const { programmeId, externalId, status } = req.query || {};
  const limit = Math.max(1, Math.min(100, Number(req.query?.limit) || 50));
  const [parts, sessions] = await Promise.all([store().list('participant'), store().list('session')]);
  const list = parts.filter((p) => p.population === 'live' && (!programmeId || p.programmeId === programmeId) && (!externalId || p.externalId === externalId) && (!status || p.status === status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { invitations: list.slice(0, limit).map((p) => apiView(p, sessions)), total: list.length };
}, API);

route('GET', '/api/v1/invitations/:interviewId', async (req) => {
  const p = await byInterviewId(req.params.interviewId);
  return { invitation: apiView(p, await store().list('session')) };
}, API);

// Sends the invitation of someone added with send: false.
route('POST', '/api/v1/invitations/:interviewId/send', async (req) => {
  const p = await byInterviewId(req.params.interviewId);
  await sendMessage(p, 'invitation', req);
  return { invitation: apiView(await must('participant', p.id, 'Invitation')) };
}, API);

// For example when a resignation is withdrawn. Submitted feedback cannot be cancelled.
route('POST', '/api/v1/invitations/:interviewId/cancel', async (req) => {
  const p = await byInterviewId(req.params.interviewId);
  if (p.status === 'submitted') fail(409, 'Feedback has been submitted, so the invitation cannot be cancelled.', { code: 'conflict' });
  p.invitation.status = 'cancelled';
  p.status = 'cancelled';
  await store().put('participant', p);
  return { invitation: apiView(p, await store().list('session')) };
}, API);
