// Deterministic generator for the fictional Calder & Finch demonstration dataset.
import { ORG, SNIPPETS, ARCHETYPES, UNITS } from './seed-content.js';
import { buildProgrammes } from './seed-programmes.js';
import { THEMES, TIER_ORDER } from './catalog.js';
import { buildPointId, newToken } from '../lib/ids.js';

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const QUARTERS = {
  Q2: ['2026-04-02', '2026-06-26'],
  Q3: ['2026-07-01', '2026-09-28'],
  Q4: ['2026-10-01', '2026-10-19'],
};

// Who submitted what, per programme and period. Patterns: career stagnation in
// Technology, workload rising in Customer Service, pay-driven moves in Sales,
// positive manager experiences, personal and uneventful departures.
const PLAN = [
  ['prog_general', 'Q2', 'career', 'Technology', 5], ['prog_general', 'Q2', 'mixed_manager', 'Technology', 2],
  ['prog_general', 'Q2', 'mixed_manager', 'Operations', 1], ['prog_general', 'Q2', 'career', 'Operations', 2],
  ['prog_general', 'Q2', 'workload', 'Customer Service', 3], ['prog_general', 'Q2', 'compensation', 'Sales', 4],
  ['prog_general', 'Q2', 'leadership', 'Finance', 2], ['prog_general', 'Q2', 'personal', null, 5],
  ['prog_general', 'Q2', 'uneventful', null, 2],
  ['prog_general', 'Q3', 'career', 'Technology', 6], ['prog_general', 'Q3', 'mixed_manager', 'Technology', 2],
  ['prog_general', 'Q3', 'mixed_manager', 'Sales', 1], ['prog_general', 'Q3', 'workload', 'Customer Service', 8],
  ['prog_general', 'Q3', 'workload', 'Operations', 1], ['prog_general', 'Q3', 'compensation', 'Sales', 4],
  ['prog_general', 'Q3', 'leadership', 'Operations', 1], ['prog_general', 'Q3', 'personal', null, 5],
  ['prog_general', 'Q3', 'uneventful', null, 2],
  ['prog_general', 'Q4', 'career', 'Technology', 2], ['prog_general', 'Q4', 'workload', 'Customer Service', 3],
  ['prog_general', 'Q4', 'personal', null, 1], ['prog_general', 'Q4', 'compensation', 'Sales', 1],
  ['prog_general', 'Q4', 'mixed_manager', 'Operations', 1],
  ['prog_early', 'Q2', 'early_tenure', null, 4], ['prog_early', 'Q2', 'personal', null, 1],
  ['prog_early', 'Q3', 'early_tenure', null, 6], ['prog_early', 'Q3', 'personal', null, 1],
  ['prog_depots', 'Q2', 'frontline', 'Operations', 3],
  ['prog_depots', 'Q3', 'frontline', 'Operations', 6], ['prog_depots', 'Q3', 'personal', 'Operations', 1],
];

export function generateDemoData({ now = '2026-10-20T08:00:00Z' } = {}) {
  const rnd = mulberry32(20261013);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const chance = (p) => rnd() < p;
  const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const dateIn = ([from, to]) => {
    const a = Date.parse(from), b = Date.parse(to);
    return new Date(a + rnd() * (b - a) + between(8, 17) * 3600e3).toISOString();
  };
  const addDays = (iso, d) => new Date(Date.parse(iso) + d * 864e5).toISOString();

  const programmes = buildProgrammes();
  const progById = Object.fromEntries(programmes.map((p) => [p.id, p]));
  const participants = [];
  const sessions = [];
  let seq = 0;

  function mobileFor(lang) {
    seq += 1;
    const n = String(seq).padStart(3, '0');
    // UK numbers use the Ofcom range reserved for fiction (07700 900xxx).
    if (lang === 'de') return `+49 1510 0900${n}`;
    if (lang === 'fr') return `+33 6 39 98 0${n.slice(0, 1)} ${n.slice(1)}`;
    return `+44 7700 900${n}`;
  }

  function segmentFor(archetype, unitHint, programmeId) {
    let unit = unitHint;
    if (!unit) unit = pick(Object.keys(UNITS));
    if (programmeId === 'prog_depots') unit = 'Operations';
    const u = UNITS[unit];
    let fn = pick(u.functions);
    if (programmeId === 'prog_depots') fn = 'Warehouse';
    const location = programmeId === 'prog_depots' ? pick(['Leeds', 'Leeds', 'Hamburg', 'Lyon']) : pick(u.locations);
    let tenureBand = pick(['1–3 years', '1–3 years', '3–5 years', '6–12 months', '5+ years']);
    if (archetype === 'career' || archetype === 'mixed_manager') tenureBand = pick(['1–3 years', '3–5 years', '3–5 years', '5+ years']);
    if (programmeId === 'prog_early') tenureBand = archetype === 'early_tenure' ? pick(['Under 6 months', 'Under 6 months', 'Under 6 months', '6–12 months']) : '6–12 months';
    let roleLevel = pick(['Individual contributor', 'Individual contributor', 'Individual contributor', 'Team lead', 'Manager']);
    if (archetype === 'leadership') roleLevel = pick(['Manager', 'Senior leader']);
    if (programmeId === 'prog_depots' || programmeId === 'prog_early') roleLevel = 'Individual contributor';
    // English only for now; German and French interviews come back with multi-language support.
    const lang = 'en';
    return { businessUnit: unit, function: fn, location, tenureBand, roleLevel, lang };
  }

  function makeParticipant(programmeId, seg, invitedAt, extra = {}) {
    const id = `par_${String(participants.length + 1).padStart(3, '0')}`;
    const p = {
      id, programmeId, population: 'demo',
      mobile: mobileFor(seg.lang), preferredLanguage: seg.lang,
      businessUnit: seg.businessUnit, function: seg.function, location: seg.location,
      tenureBand: seg.tenureBand, roleLevel: seg.roleLevel,
      departureDate: addDays(invitedAt, between(7, 24)).slice(0, 10),
      departureType: 'voluntary',
      status: 'invited',
      invitation: {
        token: newToken(rnd), channel: 'whatsapp', status: 'sent', simulated: true,
        preparedAt: addDays(invitedAt, -1), sentAt: invitedAt, openedAt: null, respondedAt: null,
        deadline: addDays(invitedAt, 21).slice(0, 10), reminders: [],
      },
      declineReason: null, sessionIds: [], createdAt: addDays(invitedAt, -1),
      ...extra,
    };
    participants.push(p);
    return p;
  }

  function coverageFor(programme, guide, points, duration, declined) {
    const themesSpoken = new Set(points.flatMap((p) => p.themes));
    const cov = {};
    for (const t of guide.topics) {
      if (declined.includes(t.id)) { cov[t.id] = 'declined'; continue; }
      const inTier = TIER_ORDER[t.tier] <= TIER_ORDER[duration];
      const touched = t.themes.some((th) => themesSpoken.has(th));
      if (touched) cov[t.id] = 'explored';
      else if (['experience', 'reasons', 'positives', 'anything_else'].includes(t.id)) cov[t.id] = 'explored';
      else if (t.id === 'first_weeks' || t.id === 'shifts') cov[t.id] = 'explored';
      else if (!inTier) cov[t.id] = 'not_asked';
      else if (chance(0.12)) cov[t.id] = 'skipped';
      else if (chance(t.themes.length ? 0.3 : 0.5)) cov[t.id] = 'explored';
      else cov[t.id] = 'not_asked';
      if (cov[t.id] === 'explored' && !touched && t.themes.length && chance(0.15)) cov[t.id] = 'insufficient';
    }
    return cov;
  }

  function buildInterview(programme, archetype, participant, submittedAt, mode) {
    const spec = ARCHETYPES[archetype];
    const lang = participant.preferredLanguage;
    const chosen = spec.slots.map((slot) => pick(slot)).filter(Boolean).map((id) => SNIPPETS[id]);
    const guide = programme.guideVersions.find((g) => g.activatedAt <= submittedAt && (!programme.guideVersions.find((n) => n.version === g.version + 1) || programme.guideVersions.find((n) => n.version === g.version + 1).activatedAt > submittedAt)) || programme.guideVersions[0];
    const duration = pick(['quick', 'standard', 'standard', 'standard', 'in_depth', 'in_depth']);
    const transcript = [];
    const t0 = Date.parse(submittedAt) - between(25, 40) * 60e3;
    let clock = t0;
    const say = (role, text, extra = {}) => {
      clock += between(8, 70) * 1000;
      const turn = { id: `t${transcript.length + 1}`, role, text, lang, at: new Date(clock).toISOString(), ...extra };
      transcript.push(turn);
      return turn;
    };
    {
      say('interviewer', lang === 'de'
        ? 'Hallo, ich bin ein KI-Interviewer von PartWays, einem unabhängigen Dienst. Calder & Finch hat uns gebeten, von Ihren Erfahrungen zu hören. Erzählen Sie doch zunächst, wie Ihre Zeit dort war.'
        : lang === 'fr'
          ? "Bonjour, je suis un intervieweur IA de PartWays, un service indépendant. Calder & Finch nous a demandé de recueillir votre expérience. Pour commencer, comment s'est passé votre temps chez eux ?"
          : "Hello, I'm an AI interviewer from PartWays, an independent service. Calder & Finch asked us to hear about your experience. To start, how would you describe your time there?");
    }
    const declined = [];
    if (archetype !== 'mixed_manager' && !chosen.some((c) => c.theme === 'manager_support') && chance(0.08)) declined.push('manager');

    const points = [];
    const factors = [];
    let rank = 1;
    for (const snip of chosen) {
      const mentions = snip.role === 'trigger' && snip.theme === 'workload' ? between(1, 3) : 1;
      say('interviewer', snip.q);
      const turn = say('employee', snip.quote[lang] || snip.quote.en);
      const evidence = [{ turnId: turn.id, kind: lang === 'en' ? 'quote' : 'translated_quote', text: snip.quote[lang] || snip.quote.en, lang, translation: lang === 'en' ? null : snip.quote.en }];
      points.push({
        id: buildPointId(points.length + 1), section: snip.section, text: snip.summary, themes: [snip.theme], sub: snip.sub,
        tone: snip.tone, origin: 'interviewer', status: 'kept', evidence, mentions,
        lang: 'en', translatedFrom: lang === 'en' ? null : lang, snippet: snip.id,
      });
      if (snip.role === 'trigger' || snip.role === 'contributing') {
        const unconfirmed = snip.role === 'contributing' && chance(0.2);
        factors.push({ theme: snip.theme, role: snip.role, status: unconfirmed ? 'suggested' : 'confirmed', rank: unconfirmed ? null : rank++ });
      } else if (snip.role === 'pull') {
        factors.push({ theme: snip.theme, role: 'pull', status: 'confirmed', rank: null });
      }
    }
    const noSingle = factors.filter((f) => f.status === 'confirmed' && f.role !== 'pull').length > 1 && chance(0.15);
    if (noSingle) factors.forEach((f) => { if (f.rank) f.rank = 1; });
    {
      say('interviewer', lang === 'de' ? 'Gibt es noch etwas Wichtiges, das wir nicht besprochen haben?' : lang === 'fr' ? "Y a-t-il quelque chose d'important que nous n'avons pas abordé ?" : 'Is there anything important we have not covered?');
      say('employee', lang === 'de' ? 'Nein, ich glaube, das war alles.' : lang === 'fr' ? "Non, je crois que c'est tout." : "No, I think that's everything.");
    }
    const coverage = coverageFor(programme, guide, points, duration, declined);
    const activeMs = (clock - t0) + between(2, 6) * 60e3;
    return {
      guide, duration, transcript, points, factors, coverage, declined, noSingle,
      preventability: pick(spec.preventable), activeMs,
    };
  }

  function submitted(programmeId, period, archetype, unitHint) {
    const programme = progById[programmeId];
    const seg = segmentFor(archetype, unitHint, programmeId);
    const submittedAt = dateIn(QUARTERS[period]);
    const invitedAt = addDays(submittedAt, -between(2, 9));
    const par = makeParticipant(programmeId, seg, invitedAt);
    let mode = rnd() < 0.65 ? 'ai_voice' : 'ai_text';
    if (programmeId === 'prog_depots' && mode === 'ai_text') mode = 'ai_voice';
    let initialMode = mode;
    const modesUsed = [mode];
    if (mode === 'ai_text' && chance(0.25)) { initialMode = 'ai_voice'; modesUsed.unshift('ai_voice'); }
    const iv = buildInterview(programme, archetype, par, submittedAt, mode);
    const id = `ses_${String(sessions.length + 1).padStart(3, '0')}`;
    const session = {
      id, participantId: par.id, programmeId, population: 'demo', guideVersion: iv.guide.version,
      initialMode, mode, modesUsed, language: par.preferredLanguage, duration: iv.duration, focusTopics: [],
      status: 'submitted', transcript: iv.transcript, coverage: iv.coverage, declinedTopics: iv.declined,
      activeMs: iv.activeMs, startedAt: new Date(Date.parse(submittedAt) - iv.activeMs - 5 * 60e3).toISOString(),
      updatedAt: submittedAt, submittedAt,
      summary: { points: iv.points, factors: iv.factors, noSingleMainReason: iv.noSingle, preventability: iv.preventability, finalComment: null },
      ratings: { ease: between(4, 5), heard: between(3, 5), accuracy: between(4, 5) },
      revisions: [], archetype,
    };
    sessions.push(session);
    par.sessionIds.push(id);
    par.status = 'submitted';
    Object.assign(par.invitation, { status: 'responded', openedAt: addDays(invitedAt, 0.2), respondedAt: submittedAt });
    return { par, session };
  }

  for (const [programmeId, period, archetype, unit, count] of PLAN) {
    for (let i = 0; i < count; i++) submitted(programmeId, period, archetype, unit);
  }

  // Specific demonstration cases --------------------------------------------
  const general = sessions.filter((x) => x.programmeId === 'prog_general');

  // A participant who raised workload five times (counts once for prevalence).
  const repeat = general.find((x) => x.archetype === 'workload' && x.submittedAt > '2026-07');
  repeat.summary.points.find((p) => p.themes.includes('workload')).mentions = 5;

  // Non-submitted participation records for each period -----------------------
  function nonResponder(programmeId, period, state) {
    const seg = segmentFor(pick(['career', 'workload', 'personal']), null, programmeId);
    const invitedAt = dateIn(QUARTERS[period]);
    const p = makeParticipant(programmeId, seg, invitedAt);
    const inv = p.invitation;
    if (state === 'prepared') { inv.status = 'prepared'; inv.sentAt = null; p.status = 'invited'; }
    if (state === 'sent') { inv.status = 'sent'; p.status = 'invited'; }
    if (state === 'opened') { inv.status = 'opened'; inv.openedAt = addDays(invitedAt, 1); p.status = 'not_started'; }
    if (state === 'declined') {
      inv.status = 'responded'; inv.openedAt = addDays(invitedAt, 1); inv.respondedAt = addDays(invitedAt, 1);
      p.status = 'declined'; p.declineReason = pick([null, 'I have already spoken to my manager.', 'Prefer not to take part.']);
    }
    if (state === 'expired') { inv.status = chance(0.5) ? 'opened' : 'sent'; p.status = 'expired'; inv.deadline = addDays(invitedAt, 14).slice(0, 10); }
    if (state === 'cancelled') { inv.status = 'cancelled'; p.status = 'cancelled'; }
    if (state === 'abandoned' || state === 'in_progress' || state === 'awaiting_review') {
      inv.status = 'opened'; inv.openedAt = addDays(invitedAt, 1);
      const sid = `ses_${String(sessions.length + 1).padStart(3, '0')}`;
      const startedAt = addDays(invitedAt, 1.1);
      const lang = p.preferredLanguage;
      const draft = state === 'awaiting_review';
      const snip = SNIPPETS[pick(['career_t2', 'wl_t1', 'comp_t1'])];
      sessions.push({
        id: sid, participantId: p.id, programmeId, population: 'demo', guideVersion: progById[programmeId].activeVersion,
        initialMode: 'ai_voice', mode: 'ai_voice', modesUsed: ['ai_voice'], language: lang, duration: 'standard', focusTopics: [],
        status: state === 'abandoned' ? 'abandoned' : draft ? 'draft' : 'paused',
        transcript: [
          { id: 't1', role: 'interviewer', text: "Hello, I'm an AI interviewer from PartWays, an independent service. Calder & Finch asked us to hear about your experience. To start, how would you describe your time there?", lang: 'en', at: startedAt },
          { id: 't2', role: 'employee', text: snip.quote[lang] || snip.quote.en, lang, at: addDays(startedAt, 0.001) },
        ],
        coverage: { experience: 'explored' }, declinedTopics: [], activeMs: 4 * 60e3, startedAt, updatedAt: addDays(startedAt, 0.002),
        submittedAt: null,
        summary: draft ? { points: [{ id: 'pt_1', section: snip.section, text: snip.summary, themes: [snip.theme], sub: snip.sub, tone: snip.tone, origin: 'interviewer', status: 'kept', evidence: [{ turnId: 't2', kind: lang === 'en' ? 'quote' : 'translated_quote', text: snip.quote[lang] || snip.quote.en, lang, translation: lang === 'en' ? null : snip.quote.en }], mentions: 1, lang: 'en' }], factors: [{ theme: snip.theme, role: 'trigger', status: 'suggested', rank: null }], noSingleMainReason: false, preventability: 'not_discussed', finalComment: null } : null,
        ratings: null, revisions: [],
      });
      p.sessionIds.push(sid);
      p.status = state === 'abandoned' ? 'in_progress' : draft ? 'awaiting_review' : 'in_progress';
      if (state === 'abandoned') p.status = 'expired';
    }
    return p;
  }
  const opsMix = {
    Q2: ['sent', 'sent', 'sent', 'expired', 'expired', 'expired', 'declined', 'declined', 'opened', 'abandoned'],
    Q3: ['sent', 'sent', 'sent', 'sent', 'expired', 'expired', 'declined', 'declined', 'declined', 'opened', 'abandoned', 'cancelled'],
    Q4: ['prepared', 'prepared', 'sent', 'sent', 'sent', 'sent', 'opened', 'opened', 'in_progress', 'in_progress', 'awaiting_review', 'awaiting_review', 'declined'],
  };
  for (const [period, states] of Object.entries(opsMix)) for (const st of states) nonResponder('prog_general', period, st);
  for (const st of ['sent', 'expired', 'declined']) nonResponder('prog_early', 'Q2', st);
  for (const st of ['sent', 'sent', 'expired', 'opened']) nonResponder('prog_early', 'Q3', st);
  for (const st of ['sent', 'opened', 'in_progress']) nonResponder('prog_early', 'Q4', st);
  for (const st of ['sent', 'sent', 'expired']) nonResponder('prog_depots', 'Q2', st);
  for (const st of ['sent', 'sent', 'expired', 'declined']) nonResponder('prog_depots', 'Q3', st);
  for (const st of ['prepared', 'sent', 'sent']) nonResponder('prog_depots', 'Q4', st);


  // Correction case: as first submitted, pay was the confirmed main reason. A later
  // correction (applyLaterRevisions) makes progression the main reason.
  const corr = general.find((s) => s.archetype === 'career' && s.status === 'submitted' && s.summary.points.some((p) => p.snippet === 'comp_mention'));
  if (corr) {
    corr.correctionCase = true;
    for (const f of corr.summary.factors) {
      if (f.role === 'trigger') { f.role = 'contributing'; f.rank = 2; f.status = 'confirmed'; }
      else if (f.theme === 'compensation') { f.role = 'trigger'; f.rank = 1; }
      else if (f.rank) f.rank += 1;
    }
  }

  for (const s of sessions) s.accessToken ||= newToken(rnd);
  return { org: { ...ORG }, programmes, participants, sessions, now };
}

// Applied after report snapshots are taken, so saved reports show as superseded.
export function applyLaterRevisions(data) {
  const general = data.sessions.filter((s) => s.programmeId === 'prog_general' && s.status === 'submitted');
  // Correction: a primary reason changed from pay to career progression after submission.
  const target = general.find((s) => s.correctionCase);
  if (target) {
    for (const f of target.summary.factors) {
      if (f.theme === 'compensation') { f.role = 'pull'; f.rank = null; }
      else if (f.role === 'contributing' && f.theme === 'career_progression') { f.role = 'trigger'; f.rank = 1; }
      else if (f.rank) f.rank -= 1;
    }
    target.revisions.push({ at: '2026-10-09T11:12:00Z', type: 'correction', note: 'Employee changed the main reason from pay to career progression. Pay is now recorded as a feature of the new role, not a reason for leaving.', by: 'employee' });
    target.updatedAt = '2026-10-09T11:12:00Z';
  }
  // Withdrawal after submission.
  const w = general.find((s) => s.archetype === 'compensation' && s.submittedAt > '2026-07');
  if (w) {
    w.status = 'withdrawn';
    w.revisions.push({ at: '2026-10-11T16:40:00Z', type: 'withdrawal', note: 'Employee withdrew their submitted feedback.', by: 'employee' });
    w.updatedAt = '2026-10-11T16:40:00Z';
    const p = data.participants.find((x) => x.id === w.participantId);
    p.status = 'withdrawn';
  }
  return data;
}

export const THEME_IDS = Object.keys(THEMES);
