// Fixed product vocabulary: themes, guide topics, templates and segment dimensions.

export const SERVICE = {
  name: 'PartWays',
  tagline: 'Independent exit interviews',
  description: 'PartWays is an independent interviewing service. It conducts exit interviews on behalf of the organisations that commission them.',
};

export const LANGUAGES = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'de', label: 'German', native: 'Deutsch' },
  { code: 'fr', label: 'French', native: 'Français' },
];

export const DURATIONS = {
  quick: { label: 'Quick', minutes: '5–7', maxTopics: 4 },
  standard: { label: 'Standard', minutes: '10–15', maxTopics: 7 },
  in_depth: { label: 'In depth', minutes: '20–25', maxTopics: 12 },
};

export const MODES = {
  ai_voice: 'Voice conversation',
  ai_text: 'Text conversation',
};

export const DIMENSIONS = [
  { key: 'businessUnit', label: 'Business unit' },
  { key: 'function', label: 'Function' },
  { key: 'location', label: 'Location' },
  { key: 'tenureBand', label: 'Tenure band' },
  { key: 'roleLevel', label: 'Role level' },
];

export const TENURE_BANDS = ['Under 6 months', '6–12 months', '1–3 years', '3–5 years', '5+ years'];
export const ROLE_LEVELS = ['Individual contributor', 'Team lead', 'Manager', 'Senior leader'];

// Themes describe what employees talk about. A theme can be positive, negative or mixed
// for a given person; tone lives on the summary point, not the theme.
export const THEMES = {
  career_progression: {
    label: 'Career progression and internal mobility',
    description: 'Promotion routes, internal moves, visible next steps and development opportunities.',
    subthemes: ['Promotion process', 'Internal moves', 'Learning and development'],
  },
  workload: {
    label: 'Workload and staffing',
    description: 'Volume of work, staffing levels, overtime and the sustainability of the pace.',
    subthemes: ['Staffing gaps', 'Overtime', 'Peak periods'],
  },
  manager_support: {
    label: 'Manager support',
    description: 'Day-to-day support, feedback and decision-making from the direct manager.',
    subthemes: ['Feedback', 'Advocacy', 'Availability'],
  },
  compensation: {
    label: 'Pay and benefits',
    description: 'Salary, bonus, benefits and how pay compares with the market.',
    subthemes: ['Market competitiveness', 'Bonus and commission', 'Benefits'],
  },
  personal_circumstances: {
    label: 'Personal circumstances',
    description: 'Relocation, family, study, health or other reasons outside work.',
    subthemes: ['Relocation', 'Family', 'Study'],
  },
  role_clarity: {
    label: 'Role expectations and fit',
    description: 'Whether the role matched what was described and responsibilities were clear.',
    subthemes: ['Role as advertised', 'Clarity of responsibilities'],
  },
  onboarding: {
    label: 'Onboarding and early support',
    description: 'Induction, training and support in the first months.',
    subthemes: ['Induction', 'Buddy and mentoring', 'Training'],
  },
  flexibility: {
    label: 'Flexibility and working arrangements',
    description: 'Hybrid and remote work, hours and the ability to fit work around life.',
    subthemes: ['Hybrid policy', 'Working hours'],
  },
  leadership_direction: {
    label: 'Leadership and direction',
    description: 'Confidence in senior leadership, communication and organisational direction.',
    subthemes: ['Communication of change', 'Strategy'],
  },
  team_belonging: {
    label: 'Team and belonging',
    description: 'Relationships with colleagues, collaboration and feeling part of the team.',
    subthemes: ['Colleagues', 'Collaboration'],
  },
  tools_process: {
    label: 'Tools and processes',
    description: 'Systems, equipment and processes needed to get work done.',
    subthemes: ['Systems', 'Process overhead'],
  },
  recognition: {
    label: 'Recognition',
    description: 'Whether contributions were noticed and valued.',
    subthemes: [],
  },
  shift_patterns: {
    label: 'Shift patterns and scheduling',
    description: 'Rota changes, notice of shifts and predictability of hours.',
    subthemes: ['Short-notice changes', 'Night shifts'],
  },
  contract_end: {
    label: 'End of contract',
    description: 'A fixed-term or project contract reached its planned end.',
    subthemes: [],
  },
};

export const SECTIONS = {
  main_reasons: 'Main reasons for leaving',
  positives: 'Positive experiences',
  concerns: 'Concerns',
  suggestions: 'Suggestions',
  additional: 'Additional comments',
};

// Default general exit-interview guide. Coverage is adaptive: `tier` decides which
// topics a quick or standard conversation offers; the interviewer still follows
// what the employee raises.
export const DEFAULT_TOPICS = [
  { id: 'experience', label: 'Overall experience and decision to leave', themes: [], kind: 'core', tier: 'quick',
    opening: 'How would you describe your time here, and how did the decision to leave come about?',
    followUps: ['What was the moment the decision became clear?', 'Was it one thing or a build-up over time?'] },
  { id: 'reasons', label: 'Main reasons, contributing factors and timing', themes: [], kind: 'core', tier: 'quick',
    opening: 'What would you say were the main reasons for leaving?',
    followUps: ['If there were several reasons, did one matter more than the others?', 'What attracted you to what comes next?'] },
  { id: 'role', label: 'Role expectations and fit', themes: ['role_clarity'], kind: 'optional', tier: 'standard',
    opening: 'How well did the role match what you expected when you joined?',
    followUps: ['Were your responsibilities clear?'] },
  { id: 'manager', label: 'Manager support, feedback and decisions', themes: ['manager_support'], kind: 'core', tier: 'standard',
    opening: 'How supported did you feel by your manager?',
    followUps: ['How did feedback usually happen?', 'Is there something your manager did that worked well?'] },
  { id: 'team', label: 'Team relationships and belonging', themes: ['team_belonging'], kind: 'optional', tier: 'in_depth',
    opening: 'What was it like working with your team?', followUps: [] },
  { id: 'workload', label: 'Workload, staffing and tools', themes: ['workload', 'tools_process'], kind: 'core', tier: 'standard',
    opening: 'How manageable was your workload?',
    followUps: ['Was that a recurring pattern or a particular period?', 'Did you have what you needed to get the work done?'] },
  { id: 'career', label: 'Career progression, learning and mobility', themes: ['career_progression'], kind: 'core', tier: 'standard',
    opening: 'How did you see your career developing here?',
    followUps: ['Did you look at internal moves before deciding to leave?'] },
  { id: 'reward', label: 'Recognition, pay and benefits', themes: ['compensation', 'recognition'], kind: 'optional', tier: 'standard',
    opening: 'How did you feel about recognition and pay?', followUps: ['How much did pay figure in your decision?'] },
  { id: 'flexibility', label: 'Flexibility and working arrangements', themes: ['flexibility', 'shift_patterns'], kind: 'optional', tier: 'in_depth',
    opening: 'How well did your working arrangements fit your life?', followUps: [] },
  { id: 'leadership', label: 'Leadership, culture and direction', themes: ['leadership_direction'], kind: 'optional', tier: 'in_depth',
    opening: 'How confident did you feel in the direction of the organisation?', followUps: [] },
  { id: 'positives', label: 'Positive experiences worth preserving', themes: [], kind: 'core', tier: 'quick',
    opening: 'What worked well that the organisation should keep doing?', followUps: [] },
  { id: 'preventability', label: 'What might have changed the decision', themes: [], kind: 'core', tier: 'standard',
    opening: 'Is there anything that might have changed your decision, or was it not something that could have been different?',
    followUps: [] },
  { id: 'suggestions', label: 'Suggestions and advice to leadership', themes: [], kind: 'optional', tier: 'in_depth',
    opening: 'If you could give leadership one piece of advice, what would it be?', followUps: [] },
  { id: 'recommend', label: 'Willingness to recommend or return', themes: [], kind: 'optional', tier: 'in_depth',
    opening: 'Would you recommend working here to a friend, or consider coming back one day?', followUps: [] },
  { id: 'anything_else', label: 'Anything else to add', themes: [], kind: 'core', tier: 'quick',
    opening: 'Is there anything important we have not covered?', followUps: [] },
];

export const TEMPLATES = {
  general: { label: 'General exits', framing: 'The employee is leaving the organisation. Do not assume the departure was a resignation.' },
  early_tenure: { label: 'Early-tenure exits', framing: 'The employee is leaving within their first year. Focus on expectations, onboarding and the decision point, without assuming onboarding caused the departure.' },
  leadership: { label: 'Leadership exits', framing: 'The employee held a leadership role. Explore direction, decision-making and the leadership team, while keeping questions about individuals neutral.' },
  frontline: { label: 'Frontline roles', framing: 'The employee worked in a frontline or operational role. Use plain, practical language about shifts, sites and day-to-day work.' },
  end_of_contract: { label: 'End-of-contract departures', framing: 'The employee is leaving because a fixed-term contract ended. Do not frame this as a choice to leave; focus on their experience and whether they would return.' },
  // The organisation describes the departures itself (programme.framing) and builds the guide from its own objectives.
  custom: { label: 'Custom', framing: '', about: 'Describe the departures in your own words and build the interview from your own objectives and questions.' },
};

// What the interviewer and planner are told about the departures: a Custom programme's
// own description, otherwise its template's.
export const framingOf = (programme) => (programme?.template === 'custom' && String(programme.framing || '').trim())
  || TEMPLATES[programme?.template]?.framing || TEMPLATES.general.framing;


export const TIER_ORDER = { quick: 0, standard: 1, in_depth: 2 };
