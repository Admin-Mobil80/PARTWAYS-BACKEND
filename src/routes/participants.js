// Participation administration. These routes never return interview content.
// People are de-identified: the HR workspace knows each person by their PartWays
// Interview Id and a masked mobile number. The full number is only used to send.
import { route, fail } from '../lib/http.js';
import { store, must, nowIso } from '../lib/data.js';
import { newId, newToken } from '../lib/ids.js';
import { TENURE_BANDS, ROLE_LEVELS, DURATIONS } from '../domain/catalog.js';
import { DEFAULT_MESSAGES } from '../domain/programmes.js';
import { assignInterviewId, consumeCredit } from '../domain/workspaces.js';

export function normaliseMobile(raw) {
  let m = String(raw || '').replace(/[\s\-().]/g, '');
  if (m.startsWith('00')) m = `+${m.slice(2)}`;
  if (/^0\d{9,10}$/.test(m)) m = `+44${m.slice(1)}`;
  return /^\+[1-9]\d{7,14}$/.test(m) ? m : null;
}

function parseDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return undefined;
}

// +44 7700 900555 → +44 ••• ••• 555
export function maskMobile(m) {
  const s = String(m || '');
  const cc = s.match(/^\+(1|7|\d{2})/)?.[0] || '+';
  return `${cc} ••• ••• ${s.slice(-3)}`;
}

export function messageFor(p, programme, org, kind, origin) {
  const tpl = (programme.messages || DEFAULT_MESSAGES)[kind] || DEFAULT_MESSAGES[kind];
  const minutes = DURATIONS[programme.durations.includes('standard') ? 'standard' : programme.durations[0]].minutes;
  const link = `${origin || ''}/interview/#/i/${p.invitation.token}`;
  return tpl.replaceAll(' {firstName}', '').replaceAll('{firstName}', '').replaceAll('{interviewId}', p.interviewId || '').replaceAll('{org}', org.shortName || org.name)
    .replaceAll('{minutes}', minutes).replaceAll('{deadline}', new Date(p.invitation.deadline).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }))
    .replaceAll('{link}', link);
}

function opsView(p, sessions) {
  const mine = sessions.filter((s) => p.sessionIds.includes(s.id));
  return {
    id: p.id, interviewId: p.interviewId, programmeId: p.programmeId, mobile: maskMobile(p.mobile), population: p.population,
    // The full number is shown only to follow up a contact request the person made themselves.
    contactMobile: p.followUp ? p.mobile : undefined,
    businessUnit: p.businessUnit, function: p.function, location: p.location, tenureBand: p.tenureBand, roleLevel: p.roleLevel,
    departureDate: p.departureDate, preferredLanguage: p.preferredLanguage, status: p.status, declineReason: p.declineReason,
    invitation: { status: p.invitation.status, simulated: p.invitation.simulated, preparedAt: p.invitation.preparedAt, sentAt: p.invitation.sentAt,
      openedAt: p.invitation.openedAt, respondedAt: p.invitation.respondedAt, deadline: p.invitation.deadline, reminders: p.invitation.reminders, channel: 'WhatsApp' },
    followUp: p.followUp, linkRequests: p.linkRequests || [],
    sessions: mine.map((s) => ({ id: s.id, status: s.status, mode: s.mode, modesUsed: s.modesUsed, initialMode: s.initialMode, startedAt: s.startedAt, submittedAt: s.submittedAt, guideVersion: s.guideVersion, language: s.language, revisions: (s.revisions || []).map((r) => ({ at: r.at, type: r.type })) })),
    createdAt: p.createdAt,
  };
}

route('GET', '/api/hr/participants', async (req) => {
  const [parts, sessions] = await Promise.all([store().list('participant'), store().list('session')]);
  const { programmeId, status, q, population } = req.query || {};
  let list = parts.filter((p) => (!programmeId || p.programmeId === programmeId) && (!population || p.population === population));
  if (status === 'follow_up') list = list.filter((p) => p.followUp && p.followUp.status !== 'completed');
  else if (status) list = list.filter((p) => p.status === status);
  if (q) {
    const n = q.toLowerCase().replace(/\s/g, '');
    list = list.filter((p) => (p.interviewId || '').toLowerCase().replace(/-/g, '').includes(n.replace(/-/g, '')) || (n.length >= 3 && /^\d+$/.test(n) && p.mobile.endsWith(n)) || (p.businessUnit || '').toLowerCase().replace(/\s/g, '').includes(n));
  }
  list.sort((a, b) => (b.invitation.sentAt || b.createdAt).localeCompare(a.invitation.sentAt || a.createdAt));
  return { participants: list.map((p) => opsView(p, sessions)) };
}, { auth: true });

route('GET', '/api/hr/participants/:id', async (req) => {
  const p = await must('participant', req.params.id, 'Participant');
  return { participant: opsView(p, await store().list('session')) };
}, { auth: true });

function validateRow(row, existingMobiles, seenMobiles) {
  const errors = [], warnings = [];
  const mobile = normaliseMobile(row.mobile);
  if (!row.mobile) errors.push('Mobile number is missing.');
  else if (!mobile) errors.push('Mobile number is not valid. Use international format, for example +44 7700 900123.');
  let duplicate = null;
  if (mobile && existingMobiles.has(mobile)) duplicate = 'Already invited to this programme with this mobile number.';
  else if (mobile && seenMobiles.has(mobile)) duplicate = 'Appears more than once in this file.';
  if (mobile) seenMobiles.add(mobile);
  const departureDate = parseDate(row.departureDate);
  if (departureDate === undefined) errors.push('Departure date is not a date. Use YYYY-MM-DD or DD/MM/YYYY.');
  if (row.tenureBand && !TENURE_BANDS.includes(row.tenureBand)) warnings.push(`Tenure band “${row.tenureBand}” is not one of the standard bands; it will be kept as written.`);
  if (row.roleLevel && !ROLE_LEVELS.includes(row.roleLevel)) warnings.push(`Role level “${row.roleLevel}” is not standard; it will be kept as written.`);
  const lang = ['en', 'de', 'fr'].includes(String(row.language || '').toLowerCase()) ? String(row.language).toLowerCase() : 'en';
  if (row.language && lang !== String(row.language).toLowerCase()) warnings.push(`Language “${row.language}” is not available; English will be offered first.`);
  return {
    input: row, errors, warnings, duplicate,
    status: errors.length ? 'error' : duplicate ? 'duplicate' : warnings.length ? 'warning' : 'ok',
    clean: { mobile, departureDate: departureDate || null, businessUnit: row.businessUnit || '', function: row.function || '', location: row.location || '', tenureBand: row.tenureBand || '', roleLevel: row.roleLevel || '', preferredLanguage: lang },
  };
}

function parseCsv(text) {
  const rows = [];
  let cur = [''], q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur[cur.length - 1] += '"'; i++; } else if (c === '"') q = false; else cur[cur.length - 1] += c; }
    else if (c === '"') q = true;
    else if (c === ',' || c === '\t' || c === ';') cur.push('');
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; rows.push(cur); cur = ['']; }
    else cur[cur.length - 1] += c;
  }
  if (cur.length > 1 || cur[0]) rows.push(cur);
  const nonEmpty = rows.filter((r) => r.some((x) => x.trim()));
  if (!nonEmpty.length) return [];
  const aliases = { mobile: 'mobile', phone: 'mobile', 'mobile number': 'mobile', 'business unit': 'businessUnit', businessunit: 'businessUnit', function: 'function', location: 'location', 'tenure band': 'tenureBand', tenure: 'tenureBand', tenureband: 'tenureBand', 'role level': 'roleLevel', rolelevel: 'roleLevel', 'departure date': 'departureDate', departuredate: 'departureDate', language: 'language' };
  const header = nonEmpty[0].map((h) => aliases[h.trim().toLowerCase()] || null);
  if (!header.includes('mobile')) fail(400, 'The first row must be a header including “mobile”. Names are not needed: each person gets a PartWays Interview Id.');
  return nonEmpty.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()]).filter(([h]) => h)));
}

route('POST', '/api/hr/participants/import/validate', async (req) => {
  const programme = await must('programme', req.body?.programmeId, 'Programme');
  const rows = req.body?.csv ? parseCsv(req.body.csv) : req.body?.rows || [];
  if (!rows.length) fail(400, 'No rows found. Paste rows under a header line, or add participants one at a time.');
  if (rows.length > 500) fail(400, 'Import up to 500 rows at a time.');
  const existing = new Set((await store().list('participant')).filter((p) => p.programmeId === programme.id && p.status !== 'cancelled').map((p) => normaliseMobile(p.mobile)));
  const seen = new Set();
  const results = rows.map((r) => validateRow(r, existing, seen));
  const counts = { ok: 0, warning: 0, error: 0, duplicate: 0 };
  for (const r of results) counts[r.status]++;
  return { rows: results, counts };
}, { auth: true });

async function createParticipant(programme, clean, population) {
  const id = newId('par');
  const p = {
    id, interviewId: await assignInterviewId(store().ns, id), programmeId: programme.id, population,
    mobile: clean.mobile, preferredLanguage: clean.preferredLanguage || 'en',
    businessUnit: clean.businessUnit, function: clean.function, location: clean.location, tenureBand: clean.tenureBand, roleLevel: clean.roleLevel,
    departureDate: clean.departureDate, departureType: clean.departureType || 'voluntary', status: 'invited',
    invitation: { token: newToken(), channel: 'whatsapp', status: 'prepared', simulated: true, preparedAt: nowIso(), sentAt: null, openedAt: null, respondedAt: null,
      deadline: new Date(Date.now() + 21 * 864e5).toISOString().slice(0, 10), reminders: [] },
    followUp: null, declineReason: null, sessionIds: [], createdAt: nowIso(),
  };
  await store().put('participant', p);
  return p;
}

// People added in an organisation's own workspace are live; in the demo they are evaluation records.
const newPopulation = async () => ((await store().get('org', 'org'))?.demo ? 'evaluation' : 'live');

route('POST', '/api/hr/participants/import/commit', async (req) => {
  const programme = await must('programme', req.body?.programmeId, 'Programme');
  const existing = new Set((await store().list('participant')).filter((p) => p.programmeId === programme.id && p.status !== 'cancelled').map((p) => normaliseMobile(p.mobile)));
  const seen = new Set();
  const results = (req.body?.rows || []).map((r) => validateRow(r, existing, seen));
  const created = [];
  const population = await newPopulation();
  for (const r of results) if (r.status === 'ok' || r.status === 'warning') created.push(await createParticipant(programme, r.clean, population));
  return { created: created.length, skipped: results.length - created.length };
}, { auth: true });

route('POST', '/api/hr/participants', async (req) => {
  const programme = await must('programme', req.body?.programmeId, 'Programme');
  const existing = new Set((await store().list('participant')).filter((p) => p.programmeId === programme.id && p.status !== 'cancelled').map((p) => normaliseMobile(p.mobile)));
  const r = validateRow(req.body || {}, existing, new Set());
  if (r.status === 'error') fail(400, r.errors.join(' '));
  if (r.status === 'duplicate') fail(409, r.duplicate);
  const p = await createParticipant(programme, r.clean, await newPopulation());
  return { participant: opsView(p, []) };
}, { auth: true });

route('GET', '/api/hr/participants/:id/message', async (req) => {
  const p = await must('participant', req.params.id, 'Participant');
  const programme = await must('programme', p.programmeId, 'Programme');
  const org = await store().get('org', 'org');
  const kind = req.query?.kind === 'reminder' ? 'reminder' : 'invitation';
  return { kind, channel: 'WhatsApp', to: maskMobile(p.mobile), interviewId: p.interviewId, text: messageFor(p, programme, org, kind, req.query?.origin), preview: true, link: `/interview/#/i/${p.invitation.token}` };
}, { auth: true });

route('POST', '/api/hr/participants/:id/send', async (req) => {
  const p = await must('participant', req.params.id, 'Participant');
  const programme = await must('programme', p.programmeId, 'Programme');
  if (programme.status !== 'active') fail(409, 'Activate the programme before sending invitations.');
  if (p.invitation.status === 'cancelled') fail(409, 'This invitation was cancelled.');
  const kind = req.body?.kind === 'reminder' ? 'reminder' : 'invitation';
  if (kind === 'invitation') {
    if (p.invitation.status !== 'prepared') fail(409, 'This invitation has already been sent. Send a reminder instead.');
    p.invitation.credit = (await consumeCredit(store(), p))?.id || null;
    p.invitation.status = 'sent';
    p.invitation.sentAt = nowIso();
  } else {
    if (['submitted', 'declined', 'withdrawn'].includes(p.status)) fail(409, 'This person has already responded.');
    if (p.invitation.reminders.length >= (programme.reminder?.max ?? 2)) fail(409, 'The maximum number of reminders has been sent.');
    p.invitation.reminders.push({ at: nowIso(), simulated: true });
  }
  // No WhatsApp provider is connected in the prototype: the message is recorded as a demonstration send.
  p.invitation.simulated = true;
  await store().put('participant', p);
  return { participant: opsView(p, []), simulated: true, creditUsed: !!p.invitation.credit && kind === 'invitation', message: `WhatsApp is not connected yet, so the ${kind} was recorded but not delivered.` };
}, { auth: true });

route('POST', '/api/hr/participants/:id/extend', async (req) => {
  const p = await must('participant', req.params.id, 'Participant');
  const days = Math.max(1, Math.min(30, Number(req.body?.days) || 7));
  const base = Math.max(Date.now(), Date.parse(p.invitation.deadline || nowIso()));
  p.invitation.deadline = new Date(base + days * 864e5).toISOString().slice(0, 10);
  if (p.status === 'expired') p.status = p.sessionIds.length ? 'in_progress' : p.invitation.openedAt ? 'not_started' : 'invited';
  await store().put('participant', p);
  return { participant: opsView(p, []) };
}, { auth: true });

route('POST', '/api/hr/participants/:id/cancel', async (req) => {
  const p = await must('participant', req.params.id, 'Participant');
  if (p.status === 'submitted') fail(409, 'Feedback has been submitted, so the invitation cannot be cancelled.');
  p.invitation.status = 'cancelled';
  p.status = 'cancelled';
  await store().put('participant', p);
  return { participant: opsView(p, []) };
}, { auth: true });

route('POST', '/api/hr/participants/:id/follow-up', async (req) => {
  const p = await must('participant', req.params.id, 'Participant');
  const status = req.body?.status;
  if (!['acknowledged', 'scheduled', 'completed'].includes(status)) fail(400, 'Choose acknowledged, scheduled or completed.');
  if (!p.followUp) fail(409, 'No follow-up has been requested.');
  p.followUp.status = status;
  p.followUp.history = [...(p.followUp.history || []), { at: nowIso(), status, by: req.user.email, note: (req.body?.note || '').slice(0, 500) }];
  await store().put('participant', p);
  return { participant: opsView(p, []) };
}, { auth: true });

export { createParticipant };
