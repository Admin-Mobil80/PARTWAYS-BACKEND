// Turns an interview transcript into the reviewable summary the employee corrects.
import { THEMES, SECTIONS, LANGUAGES } from './catalog.js';
import { llmInfo, generateJson } from '../llm/index.js';
import { offlineSummary } from './offline.js';

const THEME_IDS = Object.keys(THEMES);

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['points', 'factors', 'preventability'],
  properties: {
    points: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['section', 'text', 'text_en', 'themes', 'tone', 'evidence_turn_ids', 'direct_quote', 'direct_quote_en'],
        properties: {
          section: { type: 'string', enum: Object.keys(SECTIONS) },
          text: { type: 'string' },
          text_en: { type: 'string' },
          themes: { type: 'array', items: { type: 'string', enum: THEME_IDS } },
          tone: { type: 'string', enum: ['positive', 'negative', 'mixed', 'neutral'] },
          evidence_turn_ids: { type: 'array', items: { type: 'string' } },
          direct_quote: { type: 'string' },
          direct_quote_en: { type: 'string' },
        },
      },
    },
    factors: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['theme', 'role', 'stated_importance'],
        properties: {
          theme: { type: 'string', enum: THEME_IDS },
          role: { type: 'string', enum: ['trigger', 'contributing', 'pull'] },
          stated_importance: { type: 'string', enum: ['main', 'secondary', 'unclear'] },
        },
      },
    },
    preventability: { type: 'string', enum: ['yes', 'maybe', 'no', 'unsure', 'not_discussed'] },
  },
};

const SYSTEM = `You write the draft summary of an exit interview. The employee will review, correct and approve it before anything is shared, so fidelity matters more than polish.

Rules:
- Every point must be supported by what the employee said. Cite the transcript turn ids it comes from.
- Write each point as a short, neutral sentence in the interview language ("text") and in English ("text_en"). Describe what the employee said; never present an inferred motive, emotion or personality judgement as fact.
- Preserve qualifications and mixed views: if they praised their manager but criticised promotions, keep both, as separate points if needed.
- Respect corrections: if the employee corrected something later in the conversation, use only the corrected meaning.
- Leave out topics the employee declined to discuss.
- "direct_quote" must be an exact, contiguous excerpt (under 30 words) of the employee's own words from a cited turn, or an empty string. Never paraphrase inside a quote. "direct_quote_en" is its English translation (empty if the interview is in English or there is no quote).
- Sections: main_reasons (why they are leaving), positives, concerns, suggestions, additional (anything else, including attractions of the next role).
- Factors: list each departure factor the employee described. role "trigger" for what prompted leaving, "contributing" for conditions that added to it, "pull" for attractions of the next opportunity. stated_importance "main" only if the employee clearly said so. These are suggestions the employee will confirm or change.
- Themes: tag with the closest theme ids; use none if nothing fits.
- De-identify: never include names of people (the employee or anyone else), phone numbers, email addresses or other details that single out an individual. Refer to roles instead ("their manager", "a colleague"). If the only suitable quote contains a name, leave direct_quote empty.
- preventability: the employee's own stated view of whether anything could have changed the decision, or "not_discussed".`;

export async function summarise(session) {
  if (!llmInfo().live) return offlineSummary(session);
  const langName = LANGUAGES.find((l) => l.code === session.language)?.label || 'English';
  const transcript = session.transcript
    .filter((t) => t.role === 'interviewer' || t.role === 'employee')
    .map((t) => `[${t.id}] ${t.role === 'employee' ? 'EMPLOYEE' : 'INTERVIEWER'}: ${t.text}`).join('\n');
  const themeList = Object.entries(THEMES).map(([k, v]) => `${k}: ${v.label}`).join('\n');
  const out = await generateJson({
    system: SYSTEM,
    messages: [{ role: 'user', content: `Interview language: ${langName}.\nDeclined topics: ${(session.declinedTopics || []).join(', ') || 'none'}.\n\nTheme ids:\n${themeList}\n\nTranscript:\n${transcript}` }],
    schema: SCHEMA, effort: 'medium',
  });
  return fromModel(out, session);
}

// Validates model output against the transcript so no quote can be fabricated.
export function fromModel(out, session) {
  const turns = Object.fromEntries(session.transcript.map((t) => [t.id, t]));
  const points = out.points.map((p, i) => {
    const cited = p.evidence_turn_ids.map((id) => turns[id]).filter((t) => t?.role === 'employee');
    const quote = p.direct_quote?.trim();
    const quoteTurn = quote ? cited.find((t) => t.text.includes(quote)) : null;
    const evidence = quoteTurn
      ? [{ turnId: quoteTurn.id, kind: session.language === 'en' ? 'quote' : 'translated_quote', text: quote, lang: session.language, translation: session.language === 'en' ? null : (p.direct_quote_en || null) }]
      : cited.slice(0, 1).map((t) => ({ turnId: t.id, kind: 'paraphrase', text: p.text, lang: session.language, translation: null }));
    return {
      id: `pt_${i + 1}`, section: p.section, text: p.text, textEn: session.language === 'en' ? null : p.text_en,
      themes: p.themes, tone: p.tone, sub: null, origin: 'interviewer', status: 'kept', evidence, mentions: Math.max(1, cited.length), lang: session.language,
      unsupported: cited.length === 0,
    };
  }).filter((p) => !p.unsupported);
  const seen = new Set();
  const factors = [];
  for (const f of out.factors) {
    if (seen.has(f.theme)) continue;
    seen.add(f.theme);
    factors.push({ theme: f.theme, role: f.role, status: 'suggested', rank: f.role !== 'pull' && f.stated_importance === 'main' ? 1 : null });
  }
  return { points, factors, noSingleMainReason: false, preventability: out.preventability, finalComment: null, generatedBy: 'model' };
}
