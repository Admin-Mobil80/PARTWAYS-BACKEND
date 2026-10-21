// Participation administration. These routes never return interview content.
// People are de-identified: the HR workspace knows each person by their PartWays
// Interview Id and a masked email address and/or mobile number. The full contact
// details are only used to send, and are shown only when the person asks to be contacted.
// Invitations and reminders go to every channel a person has: email (sent through
// SES) and WhatsApp (recorded, not delivered, until a WhatsApp account is connected).
import { route, fail } from '../lib/http.js';
import { store, must, nowIso } from '../lib/data.js';
import { newId, newToken } from '../lib/ids.js';
import { TENURE_BANDS, ROLE_LEVELS, DURATIONS } from '../domain/catalog.js';
import { DEFAULT_MESSAGES } from '../domain/programmes.js';
import { assignInterviewId, consumeCredit, creditSummary } from '../domain/workspaces.js';
import { sendEmail } from '../lib/mailer.js';

export function normaliseMobile(raw) {
  let m = String(raw || '').replace(/[\s\-().]/g, '');
  if (m.startsWith('00')) m = `+${m.slice(2)}`;
  if (/^0\d{9,10}$/.test(m)) m = `+44${m.slice(1)}`;
  return /^\+[1-9]\d{7,14}$/.test(m) ? m : null;
}

export function normaliseEmailAddress(raw) {
  const e = String(raw || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null;
}

// riya@acme.com → r•••@acme.com
export function maskEmail(e) {
  const [local, domain] = String(e || '').split('@');
  return domain ? `${local.slice(0, 1)}•••@${domain}` : '';
}

const CHANNEL_LABEL = { email: 'Email', whatsapp: 'WhatsApp' };
export const channelsOf = (p) => [p.email && 'email', p.mobile && 'whatsapp'].filter(Boolean);
const channelText = (channels) => channels.map((c) => CHANNEL_LABEL[c]).join(' and ');

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
    id: p.id, interviewId: p.interviewId, programmeId: p.programmeId, population: p.population,
    mobile: p.mobile ? maskMobile(p.mobile) : null, email: p.email ? maskEmail(p.email) : null, channels: channelsOf(p),
    // Full contact details are shown only to follow up a contact request the person made themselves.
    contactMobile: p.followUp ? p.mobile || null : undefined,
    contactEmail: p.followUp ? p.email || null : undefined,
    businessUnit: p.businessUnit, function: p.function, location: p.location, tenureBand: p.tenureBand, roleLevel: p.roleLevel,
    departureDate: p.departureDate, preferredLanguage: p.preferredLanguage, status: p.status, declineReason: p.declineReason,
    invitation: { status: p.invitation.status, simulated: p.invitation.simulated, preparedAt: p.invitation.preparedAt, sentAt: p.invitation.sentAt,
      openedAt: p.invitation.openedAt, respondedAt: p.invitation.respondedAt, deadline: p.invitation.deadline, reminders: p.invitation.reminders,
      channel: channelText(channelsOf(p)), deliveries: (p.invitation.deliveries || []).map(({ channel, kind, at, simulated, failed }) => ({ channel, kind, at, simulated, failed })) },
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
    list = list.filter((p) => (p.interviewId || '').toLowerCase().replace(/-/g, '').includes(n.replace(/-/g, '')) || (n.length >= 3 && /^\d+$/.test(n) && (p.mobile || '').endsWith(n)) || (n.includes('@') && p.email === n) || (p.businessUnit || '').toLowerCase().replace(/\s/g, '').includes(n));
  }
  list.sort((a, b) => (b.invitation.sentAt || b.createdAt).localeCompare(a.invitation.sentAt || a.createdAt));
  return { participants: list.map((p) => opsView(p, sessions)) };
}, { auth: true });

route('GET', '/api/hr/participants/:id', async (req) => {
  const p = await must('participant', req.params.id, 'Participant');
  return { participant: opsView(p, await store().list('session')) };
}, { auth: true });

// Contacts already invited to a programme, so nobody is invited twice by either channel.
async function existingContacts(programmeId) {
  const live = (await store().list('participant')).filter((p) => p.programmeId === programmeId && p.status !== 'cancelled');
  return { mobiles: new Set(live.map((p) => normaliseMobile(p.mobile)).filter(Boolean)), emails: new Set(live.map((p) => p.email).filter(Boolean)) };
}
const noContacts = () => ({ mobiles: new Set(), emails: new Set() });

function validateRow(row, existing, seen) {
  const errors = [], warnings = [];
  const mobile = row.mobile ? normaliseMobile(row.mobile) : null;
  const email = row.email ? normaliseEmailAddress(row.email) : null;
  if (!row.mobile && !row.email) errors.push('Add an email address, a mobile number, or both.');
  if (row.mobile && !mobile) errors.push('Mobile number is not valid. Use international format, for example +44 7700 900123.');
  if (row.email && !email) errors.push('Email address is not valid.');
  let duplicate = null;
  if ((mobile && existing.mobiles.has(mobile)) || (email && existing.emails.has(email))) duplicate = `Already invited to this programme with this ${mobile && existing.mobiles.has(mobile) ? 'mobile number' : 'email address'}.`;
  else if ((mobile && seen.mobiles.has(mobile)) || (email && seen.emails.has(email))) duplicate = 'Appears more than once in this file.';
  if (mobile) seen.mobiles.add(mobile);
  if (email) seen.emails.add(email);
  const departureDate = parseDate(row.departureDate);
  if (departureDate === undefined) errors.push('Departure date is not a date. Use YYYY-MM-DD or DD/MM/YYYY.');
  if (row.tenureBand && !TENURE_BANDS.includes(row.tenureBand)) warnings.push(`Tenure band “${row.tenureBand}” is not one of the standard bands; it will be kept as written.`);
  if (row.roleLevel && !ROLE_LEVELS.includes(row.roleLevel)) warnings.push(`Role level “${row.roleLevel}” is not standard; it will be kept as written.`);
  const lang = ['en', 'de', 'fr'].includes(String(row.language || '').toLowerCase()) ? String(row.language).toLowerCase() : 'en';
  if (row.language && lang !== String(row.language).toLowerCase()) warnings.push(`Language “${row.language}” is not available; English will be offered first.`);
  return {
    input: row, errors, warnings, duplicate,
    status: errors.length ? 'error' : duplicate ? 'duplicate' : warnings.length ? 'warning' : 'ok',
    clean: { mobile, email, departureDate: departureDate || null, businessUnit: row.businessUnit || '', function: row.function || '', location: row.location || '', tenureBand: row.tenureBand || '', roleLevel: row.roleLevel || '', preferredLanguage: lang },
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
  const aliases = { mobile: 'mobile', phone: 'mobile', 'mobile number': 'mobile', whatsapp: 'mobile', email: 'email', 'email address': 'email', 'e-mail': 'email', 'business unit': 'businessUnit', businessunit: 'businessUnit', function: 'function', location: 'location', 'tenure band': 'tenureBand', tenure: 'tenureBand', tenureband: 'tenureBand', 'role level': 'roleLevel', rolelevel: 'roleLevel', 'departure date': 'departureDate', departuredate: 'departureDate', language: 'language' };
  const header = nonEmpty[0].map((h) => aliases[h.trim().toLowerCase()] || null);
  if (!header.includes('mobile') && !header.includes('email')) fail(400, 'The first row must be a header including “email”, “mobile”, or both. Names are not needed: each person gets a PartWays Interview Id.');
  return nonEmpty.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()]).filter(([h]) => h)));
}

route('POST', '/api/hr/participants/import/validate', async (req) => {
  const programme = await must('programme', req.body?.programmeId, 'Programme');
  const rows = req.body?.csv ? parseCsv(req.body.csv) : req.body?.rows || [];
  if (!rows.length) fail(400, 'No rows found. Paste rows under a header line, or add participants one at a time.');
  if (rows.length > 500) fail(400, 'Import up to 500 rows at a time.');
  const existing = await existingContacts(programme.id);
  const seen = noContacts();
  const results = rows.map((r) => validateRow(r, existing, seen));
  const counts = { ok: 0, warning: 0, error: 0, duplicate: 0 };
  for (const r of results) counts[r.status]++;
  return { rows: results, counts };
}, { auth: true });

async function createParticipant(programme, clean, population) {
  const id = newId('par');
  const p = {
    id, interviewId: await assignInterviewId(store().ns, id), programmeId: programme.id, population,
    mobile: clean.mobile || null, email: clean.email || null, preferredLanguage: clean.preferredLanguage || 'en',
    businessUnit: clean.businessUnit, function: clean.function, location: clean.location, tenureBand: clean.tenureBand, roleLevel: clean.roleLevel,
    departureDate: clean.departureDate, departureType: clean.departureType || 'voluntary', status: 'invited',
    invitation: { token: newToken(), status: 'prepared', simulated: true, preparedAt: nowIso(), sentAt: null, openedAt: null, respondedAt: null,
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
  const existing = await existingContacts(programme.id);
  const seen = noContacts();
  const results = (req.body?.rows || []).map((r) => validateRow(r, existing, seen));
  const created = [];
  const population = await newPopulation();
  for (const r of results) if (r.status === 'ok' || r.status === 'warning') created.push(await createParticipant(programme, r.clean, population));
  return { created: created.length, skipped: results.length - created.length };
}, { auth: true });

route('POST', '/api/hr/participants', async (req) => {
  const programme = await must('programme', req.body?.programmeId, 'Programme');
  const r = validateRow(req.body || {}, await existingContacts(programme.id), noContacts());
  if (r.status === 'error') fail(400, r.errors.join(' '));
  if (r.status === 'duplicate') fail(409, r.duplicate);
  const p = await createParticipant(programme, r.clean, await newPopulation());
  return { participant: opsView(p, []) };
}, { auth: true });

function siteOrigin(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  if (req.headers?.origin) return req.headers.origin;
  if (req.query?.origin) return req.query.origin;
  const host = req.headers?.['x-forwarded-host'] || req.headers?.host || 'localhost:8787';
  return `${host.startsWith('localhost') ? 'http' : 'https'}://${host}`;
}

const subjectFor = (kind, org) => {
  const name = org.shortName || org.name;
  return kind === 'reminder' ? `Reminder: ${name} would like to hear about your experience` : `${name} has asked PartWays to hear about your experience`;
};

// What would be sent on each channel the person has.
function previews(p, programme, org, kind, origin) {
  const text = messageFor(p, programme, org, kind, origin);
  return channelsOf(p).map((channel) => (channel === 'email'
    ? { channel, to: maskEmail(p.email), subject: subjectFor(kind, org), text, live: !org.demo }
    : { channel, to: maskMobile(p.mobile), text, live: false }));
}

route('GET', '/api/hr/participants/:id/message', async (req) => {
  const p = await must('participant', req.params.id, 'Participant');
  const programme = await must('programme', p.programmeId, 'Programme');
  const org = await store().get('org', 'org');
  const kind = req.query?.kind === 'reminder' ? 'reminder' : 'invitation';
  const messages = previews(p, programme, org, kind, siteOrigin(req));
  return {
    kind, channel: channelText(channelsOf(p)), messages, interviewId: p.interviewId, preview: true, link: `/interview/#/i/${p.invitation.token}`,
    // Kept for the single-message preview: the first channel's text and recipient.
    to: messages[0]?.to, text: messages[0]?.text,
  };
}, { auth: true });

// Sends on every channel the person has. Email goes through SES; WhatsApp is
// recorded but not delivered until a WhatsApp account is connected. In the
// demonstration workspace nothing is delivered. One credit per invitation,
// charged only once at least one channel has gone out.
route('POST', '/api/hr/participants/:id/send', async (req) => {
  const p = await must('participant', req.params.id, 'Participant');
  const programme = await must('programme', p.programmeId, 'Programme');
  const org = await store().get('org', 'org');
  if (programme.status !== 'active') fail(409, 'Activate the programme before sending invitations.');
  if (p.invitation.status === 'cancelled') fail(409, 'This invitation was cancelled.');
  const channels = channelsOf(p);
  if (!channels.length) fail(409, 'This person has no email address or mobile number to send to.');
  const kind = req.body?.kind === 'reminder' ? 'reminder' : 'invitation';
  if (kind === 'invitation') {
    if (p.invitation.status !== 'prepared') fail(409, 'This invitation has already been sent. Send a reminder instead.');
    const { unlimited, balance } = await creditSummary(store());
    if (!unlimited && balance < 1) fail(402, 'You have no interview credits left. Buy credits to send more invitations.', { code: 'no_credits' });
  } else {
    if (['submitted', 'declined', 'withdrawn'].includes(p.status)) fail(409, 'This person has already responded.');
    if (p.invitation.reminders.length >= (programme.reminder?.max ?? 2)) fail(409, 'The maximum number of reminders has been sent.');
  }

  const at = nowIso();
  const origin = siteOrigin(req);
  const deliveries = [];
  for (const m of previews(p, programme, org, kind, origin)) {
    if (m.channel === 'email' && m.live) {
      try {
        const r = await sendEmail({ to: p.email, subject: m.subject, text: m.text, link: `${origin}/interview/#/i/${p.invitation.token}` });
        deliveries.push({ channel: 'email', kind, at, simulated: r.simulated, messageId: r.messageId || null });
      } catch (err) {
        console.error('Invitation email failed', err);
        deliveries.push({ channel: 'email', kind, at, simulated: false, failed: true });
      }
    } else {
      deliveries.push({ channel: m.channel, kind, at, simulated: true });
    }
  }
  const sent = deliveries.filter((d) => !d.failed);
  p.invitation.deliveries = [...(p.invitation.deliveries || []), ...deliveries];
  if (!sent.length) {
    await store().put('participant', p);
    fail(502, 'The email could not be sent, so nothing was charged. Please try again in a few minutes.');
  }
  if (kind === 'invitation') {
    p.invitation.credit = (await consumeCredit(store(), p))?.id || null;
    p.invitation.status = 'sent';
    p.invitation.sentAt = at;
  } else {
    p.invitation.reminders.push({ at, simulated: sent.every((d) => d.simulated), channels: sent.map((d) => d.channel) });
  }
  p.invitation.simulated = sent.every((d) => d.simulated);
  await store().put('participant', p);

  const delivered = sent.filter((d) => !d.simulated).map((d) => CHANNEL_LABEL[d.channel]);
  const notes = [];
  if (delivered.length) notes.push(`Sent by ${delivered.join(' and ')}.`);
  if (deliveries.some((d) => d.failed)) notes.push('The email could not be sent; try a reminder later.');
  if (org.demo) notes.push(`This is the demonstration workspace, so the ${kind} was recorded but not delivered.`);
  else if (sent.some((d) => d.channel === 'whatsapp')) notes.push(`WhatsApp is not connected yet, so the WhatsApp ${kind} was recorded but not delivered.`);
  else if (sent.some((d) => d.channel === 'email' && d.simulated)) notes.push(`Email is not configured here, so the ${kind} was recorded but not delivered.`);
  return {
    participant: opsView(p, []), simulated: p.invitation.simulated, deliveries: sent.map(({ channel, simulated }) => ({ channel, simulated })),
    creditUsed: !!p.invitation.credit && kind === 'invitation', message: notes.join(' '),
  };
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
