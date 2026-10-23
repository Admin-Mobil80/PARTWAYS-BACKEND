// Programme defaults shared by sign-up, the programme routes and the demonstration data.
import { DEFAULT_TOPICS } from './catalog.js';
import { newId } from '../lib/ids.js';

export const DEFAULT_MESSAGES = {
  invitation: 'Hi, {org} has asked PartWays, an independent interviewing service, to hear about your experience as you leave. It takes about {minutes} minutes, by voice or by typing, and your answers are de-identified before {org} sees them. Your PartWays Interview Id is {interviewId}. Your link: {link} (open until {deadline}).',
  reminder: 'Hi, a reminder that your PartWays exit interview ({interviewId}) for {org} is open until {deadline}. You can take part, or decline, here: {link}',
};

export const feedbackNoticeFor = (orgShort) => `PartWays keeps a written transcript and the summary you approve. Audio is used only to run the live conversation and is not kept as a recording. Your feedback is de-identified: ${orgShort} sees it under a PartWays Interview Id, never with your name, email address or mobile number, and names, phone numbers and email addresses are removed from what you say. Reviewed feedback is combined with other responses for reporting. Removing a point before you submit removes it from what is shared.`;

export function templateTopics(template) {
  const pick = (ids) => ids.map((id) => ({ ...structuredClone(DEFAULT_TOPICS.find((t) => t.id === id)), objectiveIds: [], exact: false }));
  if (template === 'custom') return pick(['experience', 'reasons', 'positives', 'anything_else']);
  if (template === 'end_of_contract') return pick(['experience', 'role', 'manager', 'team', 'positives', 'suggestions', 'recommend', 'anything_else']);
  if (template === 'frontline') return pick(['experience', 'reasons', 'workload', 'flexibility', 'manager', 'team', 'positives', 'preventability', 'anything_else']);
  if (template === 'early_tenure') return pick(['experience', 'reasons', 'role', 'manager', 'team', 'positives', 'preventability', 'anything_else']);
  if (template === 'leadership') return pick(['experience', 'reasons', 'leadership', 'manager', 'career', 'reward', 'positives', 'preventability', 'suggestions', 'anything_else']);
  return pick(DEFAULT_TOPICS.map((t) => t.id));
}

// A new draft programme from a template. The caller sets the id and name.
export function newProgramme({ name, template = 'general', framing = '', org }) {
  const short = org?.shortName || org?.name || 'your organisation';
  return {
    id: newId('prog'), name, template, ...(template === 'custom' ? { framing } : {}), status: 'draft',
    languages: ['en', 'de', 'fr'], modes: ['ai_voice', 'ai_text'], durations: ['quick', 'standard', 'in_depth'],
    reminder: { enabled: true, afterDays: 4, max: 2 },
    feedbackNotice: feedbackNoticeFor(short),
    completionMessage: 'Thank you. Your feedback has been submitted.',
    reportingMode: 'aggregate', reportingMinimum: 5, objectives: [], topics: templateTopics(template),
    intro: 'We would like to hear about your experience as you leave.', description: '',
    activeVersion: null, guideVersions: [], draft: null, messages: { ...DEFAULT_MESSAGES },
    createdAt: new Date().toISOString(),
  };
}
