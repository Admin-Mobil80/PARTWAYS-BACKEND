import { DEFAULT_TOPICS } from './catalog.js';
import { feedbackNoticeFor, followUpWordingFor } from './programmes.js';

const topic = (id, overrides = {}) => {
  const base = DEFAULT_TOPICS.find((t) => t.id === id);
  return { ...structuredClone(base), objectiveIds: [], exact: false, ...overrides };
};

const common = {
  languages: ['en', 'de', 'fr'],
  modes: ['ai_voice', 'ai_text'],
  durations: ['quick', 'standard', 'in_depth'],
  reminder: { enabled: true, afterDays: 4, max: 2 },
  followUpWording: followUpWordingFor('Calder & Finch'),
  feedbackNotice: feedbackNoticeFor('Calder & Finch'),
  completionMessage: 'Thank you for taking the time to share your experience. Your feedback has been submitted.',
};

function v(version, activatedAt, objectives, topics, changeSummary) {
  return { version, activatedAt, objectives: structuredClone(objectives), topics: structuredClone(topics), changeSummary };
}

export function buildProgrammes() {
  // Programme 1: general voluntary exits
  const p1Objectives = [
    { id: 'o_drivers', title: 'Understand the main drivers of voluntary departures', description: 'What is causing people to leave, and how the picture differs across the business.', context: '', priority: 'high', depth: 'standard', appliesTo: null, topicIds: ['experience', 'reasons'], themeIds: [] },
    { id: 'o_mobility', title: 'Identify barriers to internal mobility', description: 'Why people leave for progression elsewhere instead of moving internally.', context: 'An internal jobs board launched in 2025. We want to know whether people use it and what gets in the way.', priority: 'high', depth: 'deep', appliesTo: null, topicIds: ['career'], themeIds: ['career_progression'] },
    { id: 'o_preserve', title: 'Learn which practices are worth preserving', description: 'What works well and should be protected.', context: '', priority: 'medium', depth: 'standard', appliesTo: null, topicIds: ['positives'], themeIds: [] },
  ];
  const hybrid = { id: 'o_hybrid', title: 'Understand how the hybrid working policy affects retention', description: 'Whether the two-days-in-office policy introduced in June influences decisions to stay or leave.', context: 'Policy changed in June 2026.', priority: 'medium', depth: 'light', appliesTo: null, topicIds: ['flexibility'], themeIds: ['flexibility'] };

  const p1TopicsV1 = [
    topic('experience', { objectiveIds: ['o_drivers'] }), topic('reasons', { objectiveIds: ['o_drivers'] }),
    topic('role'), topic('manager'), topic('team'), topic('workload'),
    topic('career', { objectiveIds: ['o_mobility'], followUps: ['Did you look at internal moves before deciding to leave?', 'Did you use the internal jobs board? What happened?'] }),
    topic('reward'), topic('flexibility'), topic('leadership'),
    topic('positives', { objectiveIds: ['o_preserve'] }), topic('preventability', { objectiveIds: ['o_drivers'] }),
    topic('suggestions'),
    topic('recommend', { exact: true, opening: 'Would you recommend Calder & Finch as a place to work?' }),
    topic('anything_else'),
  ];
  const p1TopicsV2 = p1TopicsV1.map((t) => t.id === 'flexibility'
    ? { ...t, objectiveIds: ['o_hybrid'], tier: 'standard', followUps: ['How did the change to two office days affect you, if at all?'] }
    : t);

  const p1 = {
    id: 'prog_general', name: 'Voluntary exits 2026', template: 'general', status: 'active',
    description: 'Company-wide exit interviews for employees leaving Calder & Finch.',
    intro: 'Calder & Finch has asked PartWays to hear about your experience as you leave. It takes around 10–15 minutes and you choose how to take part.',
    reportingMode: 'individual', reportingMinimum: 5, createdAt: '2026-01-12T09:00:00Z',
    ...structuredClone(common),
    objectives: [...p1Objectives, hybrid],
    topics: p1TopicsV2,
    activeVersion: 2,
    guideVersions: [
      v(1, '2026-01-15T09:00:00Z', p1Objectives, p1TopicsV1, 'Initial guide.'),
      v(2, '2026-07-01T09:00:00Z', [...p1Objectives, hybrid], p1TopicsV2, 'Added objective “Understand how the hybrid working policy affects retention” and moved flexibility into standard-length interviews.'),
    ],
    draft: null,
  };

  // Programme 2: early tenure
  const p2Objectives = [
    { id: 'o_early', title: 'Understand why new hires leave within six months', description: 'What happens between offer and the decision to leave in the first months.', context: 'Early-tenure attrition rose in 2025.', priority: 'high', depth: 'deep', appliesTo: { dimension: 'tenureBand', values: ['Under 6 months'] }, topicIds: ['first_weeks', 'role', 'reasons'], themeIds: ['role_clarity', 'onboarding'] },
    { id: 'o_advert', title: 'Check whether roles match how they were advertised', description: 'Gaps between the job advert, interview and the reality of the role.', context: '', priority: 'medium', depth: 'standard', appliesTo: null, topicIds: ['role'], themeIds: ['role_clarity'] },
    { id: 'o_buddy', title: 'Find out whether the buddy scheme helps new starters', description: 'Whether the buddy programme makes a difference in the first weeks.', context: 'Buddy scheme launched March 2026.', priority: 'low', depth: 'light', appliesTo: null, topicIds: ['first_weeks'], themeIds: ['onboarding'] },
  ];
  const p2Topics = [
    topic('experience', { objectiveIds: ['o_early'] }),
    { id: 'first_weeks', label: 'First weeks and onboarding', themes: ['onboarding'], kind: 'core', tier: 'quick', exact: false,
      opening: 'What were your first few weeks like?', followUps: ['Did you have what you needed on day one?', 'Did you have a buddy? How did that work?'], objectiveIds: ['o_early', 'o_buddy'] },
    topic('role', { kind: 'core', tier: 'quick', objectiveIds: ['o_early', 'o_advert'] }),
    topic('reasons', { objectiveIds: ['o_early'] }), topic('manager'), topic('positives'),
    topic('preventability'), topic('anything_else'),
  ];
  const p2 = {
    id: 'prog_early', name: 'Early-tenure departures', template: 'early_tenure', status: 'active',
    description: 'Focused programme for people leaving within their first year.',
    intro: 'Calder & Finch has asked PartWays to understand the experience of people who leave in their first year. It takes around 10 minutes.',
    reportingMode: 'individual', reportingMinimum: 5, createdAt: '2026-03-02T09:00:00Z',
    ...structuredClone(common),
    objectives: p2Objectives, topics: p2Topics, activeVersion: 1,
    guideVersions: [v(1, '2026-03-05T09:00:00Z', p2Objectives, p2Topics, 'Initial guide.')],
    draft: null,
  };

  // Programme 3: frontline depots, aggregate-only reporting
  const p3Objectives = [
    { id: 'o_shifts', title: 'Understand how shift patterns affect retention at depots', description: 'Rota notice, night work and predictability of hours.', context: '', priority: 'high', depth: 'deep', appliesTo: null, topicIds: ['shifts', 'reasons'], themeIds: ['shift_patterns'] },
    { id: 'o_facilities', title: 'Understand whether site facilities and equipment affect retention', description: 'Break areas, equipment condition and site conditions.', context: 'Capital budget decision due in Q1 2027.', priority: 'medium', depth: 'standard', appliesTo: null, topicIds: ['facilities'], themeIds: [] },
  ];
  const p3Topics = [
    topic('experience', { opening: 'How was your time working at the depot?', objectiveIds: [] }),
    { id: 'shifts', label: 'Shifts and rota', themes: ['shift_patterns'], kind: 'core', tier: 'quick', exact: false,
      opening: 'How did the shift pattern work for you?', followUps: ['How much notice did you get of the rota?'], objectiveIds: ['o_shifts'] },
    topic('reasons', { objectiveIds: ['o_shifts'] }),
    { id: 'facilities', label: 'Site facilities and equipment', themes: [], kind: 'optional', tier: 'in_depth', exact: false,
      opening: 'How were the facilities and equipment on site?', followUps: [], objectiveIds: ['o_facilities'] },
    topic('team'), topic('positives'), topic('anything_else'),
  ];
  const p3 = {
    id: 'prog_depots', name: 'Depot exits', template: 'frontline', status: 'active',
    description: 'Exit interviews for warehouse and depot colleagues. Reported in aggregate only.',
    intro: 'Calder & Finch has asked PartWays to hear about your time at the depot. It takes 5–10 minutes.',
    reportingMode: 'aggregate', reportingMinimum: 5, createdAt: '2026-04-01T09:00:00Z',
    ...structuredClone(common),
    durations: ['quick', 'standard'],
    objectives: p3Objectives, topics: p3Topics, activeVersion: 1,
    guideVersions: [v(1, '2026-04-03T09:00:00Z', p3Objectives, p3Topics, 'Initial guide.')],
    draft: null,
  };

  // Programme 4: draft, not yet activated
  const p4Objectives = [
    { id: 'o_lead', title: 'Understand why experienced managers leave', description: 'Decision-making, autonomy and confidence in direction among people managers.', context: '', priority: 'high', depth: 'deep', appliesTo: null, topicIds: ['leadership', 'reasons'], themeIds: ['leadership_direction'] },
  ];
  const p4Topics = [topic('experience'), topic('reasons', { objectiveIds: ['o_lead'] }), topic('leadership', { kind: 'core', tier: 'quick', objectiveIds: ['o_lead'] }), topic('manager'), topic('positives'), topic('anything_else')];
  const p4 = {
    id: 'prog_leaders', name: 'Leadership exits (pilot)', template: 'leadership', status: 'draft',
    description: 'Draft programme for departing people managers and senior leaders.',
    intro: 'Calder & Finch has asked PartWays to hear about your experience as a leader in the organisation.',
    reportingMode: 'aggregate', reportingMinimum: 5, createdAt: '2026-10-08T09:00:00Z',
    ...structuredClone(common),
    objectives: p4Objectives, topics: p4Topics, activeVersion: null,
    guideVersions: [],
    draft: null,
  };

  return [p1, p2, p3, p4];
}
