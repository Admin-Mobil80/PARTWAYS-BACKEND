// Turns plain-language learning objectives into a proposed interview plan, and
// checks a plan for objectives without coverage and redundant topics.
import { THEMES, TEMPLATES, DEFAULT_TOPICS } from './catalog.js';
import { llmInfo, generateJson } from '../llm/index.js';
import { offlinePlan } from './offline.js';

const THEME_IDS = Object.keys(THEMES);

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['topics', 'objective_themes'],
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'label', 'theme_ids', 'kind', 'tier', 'opening', 'follow_ups', 'objective_ids', 'exact'],
        properties: {
          id: { type: 'string' }, label: { type: 'string' },
          theme_ids: { type: 'array', items: { type: 'string', enum: THEME_IDS } },
          kind: { type: 'string', enum: ['core', 'optional'] },
          tier: { type: 'string', enum: ['quick', 'standard', 'in_depth'] },
          opening: { type: 'string' },
          follow_ups: { type: 'array', items: { type: 'string' } },
          objective_ids: { type: 'array', items: { type: 'string' } },
          exact: { type: 'boolean' },
        },
      },
    },
    objective_themes: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['objective_id', 'theme_ids'], properties: { objective_id: { type: 'string' }, theme_ids: { type: 'array', items: { type: 'string', enum: THEME_IDS } } } },
    },
  },
};

const SYSTEM = `You design exit-interview guides for PartWays, an independent interviewing service. HR describes what it wants to understand; you propose topics an AI interviewer will explore conversationally.

Rules:
- Start from the default guide topics where they fit (reuse their ids). Add a custom topic (short snake_case id) only when no default topic serves an objective.
- Keep "experience", "reasons", "positives" and "anything_else".
- Opening questions must be neutral, open and singular. Never lead (no "Was poor onboarding why you left?"). Follow-up directions explore without assuming the answer.
- Link each topic to the objectives it serves. Every objective should be served by at least one topic.
- tier controls the shortest interview that includes the topic (quick < standard < in_depth). High-priority objectives belong in quick or standard; low priority can be in_depth.
- kind "core" topics are offered in every interview of that length, "optional" when time allows. Core never means forced.
- Keep "exact": true only for questions HR supplied with exact wording.
- Map each objective to the theme ids its findings should draw on (empty if it is about reasons or positives generally).`;

export async function proposePlan({ objectives, template, framing, existingTopics = [] }) {
  if (!llmInfo().live) return offlinePlan(structuredClone(objectives), template);
  const defaults = DEFAULT_TOPICS.map((t) => `${t.id} [${t.tier}, ${t.kind}] ${t.label}: "${t.opening}" themes=${t.themes.join(',') || '-'}`).join('\n');
  const exact = existingTopics.filter((t) => t.exact).map((t) => `${t.id}: "${t.opening}"`).join('\n') || 'none';
  const objs = objectives.map((o) => `${o.id} [${o.priority} priority, ${o.depth} depth${o.appliesTo ? `, applies to ${o.appliesTo.dimension} = ${o.appliesTo.values.join('/')}` : ''}]: ${o.title}. ${o.description || ''} ${o.context ? `Context: ${o.context}` : ''}`).join('\n');
  const out = await generateJson({
    system: SYSTEM,
    messages: [{ role: 'user', content: `Departure context: ${framing || TEMPLATES[template]?.framing || TEMPLATES.general.framing}\n\nObjectives:\n${objs}\n\nExact-wording questions to keep:\n${exact}\n\nDefault guide topics:\n${defaults}\n\nTheme ids: ${THEME_IDS.join(', ')}` }],
    schema: SCHEMA, effort: 'medium',
  });
  const objIds = new Set(objectives.map((o) => o.id));
  const topics = out.topics.map((t) => ({
    id: t.id.replace(/[^a-z0-9_]/gi, '_').toLowerCase(), label: t.label, themes: t.theme_ids, kind: t.kind, tier: t.tier,
    opening: t.opening, followUps: t.follow_ups, objectiveIds: t.objective_ids.filter((id) => objIds.has(id)), exact: t.exact,
  }));
  const updated = objectives.map((o) => {
    const link = out.objective_themes.find((x) => x.objective_id === o.id);
    return { ...o, themeIds: link?.theme_ids || o.themeIds || [], topicIds: topics.filter((t) => t.objectiveIds.includes(o.id)).map((t) => t.id) };
  });
  return { topics, objectives: updated, generatedBy: 'model', template };
}

// Coverage check shown in the editor (OBJ-05).
export function analysePlan(objectives, topics) {
  const uncovered = objectives.filter((o) => !topics.some((t) => t.objectiveIds?.includes(o.id))).map((o) => ({ id: o.id, title: o.title }));
  const redundant = [];
  for (let i = 0; i < topics.length; i++) {
    for (let j = i + 1; j < topics.length; j++) {
      const a = topics[i], b = topics[j];
      const sameThemes = a.themes?.length && a.themes.length === b.themes?.length && a.themes.every((x) => b.themes.includes(x));
      const sameOpening = a.opening.trim().toLowerCase() === b.opening.trim().toLowerCase();
      if (sameThemes || sameOpening) redundant.push({ a: a.id, b: b.id, reason: sameOpening ? 'Same question wording' : 'Covers the same themes' });
    }
  }
  const leading = topics.filter((t) => /\b(was|did|is) (poor|bad|the lack of|low)\b|\bdon't you\b|\bwouldn't you\b/i.test(t.opening)).map((t) => ({ id: t.id, opening: t.opening }));
  return { uncovered, redundant, leading };
}

export function diffGuides(before, after) {
  const changes = [];
  const bo = new Map((before?.objectives || []).map((o) => [o.id, o]));
  const ao = new Map((after?.objectives || []).map((o) => [o.id, o]));
  for (const [id, o] of ao) {
    const b = bo.get(id);
    if (!b) changes.push(`Added objective “${o.title}”`);
    else {
      if (b.title !== o.title) changes.push(`Renamed objective “${b.title}” to “${o.title}”`);
      if (b.priority !== o.priority) changes.push(`Changed priority of “${o.title}” from ${b.priority} to ${o.priority}`);
      if (JSON.stringify(b.appliesTo) !== JSON.stringify(o.appliesTo)) changes.push(`Changed who “${o.title}” applies to`);
      if (b.depth !== o.depth) changes.push(`Changed depth of “${o.title}” to ${o.depth}`);
    }
  }
  for (const [id, b] of bo) if (!ao.has(id)) changes.push(`Removed objective “${b.title}”`);
  const bt = new Map((before?.topics || []).map((t) => [t.id, t]));
  const at = new Map((after?.topics || []).map((t) => [t.id, t]));
  for (const [id, t] of at) {
    const b = bt.get(id);
    if (!b) changes.push(`Added topic “${t.label}”`);
    else {
      if (b.opening !== t.opening) changes.push(`Changed opening question for “${t.label}”`);
      if (b.tier !== t.tier || b.kind !== t.kind) changes.push(`Changed when “${t.label}” is offered`);
      if (JSON.stringify(b.followUps) !== JSON.stringify(t.followUps)) changes.push(`Changed follow-up directions for “${t.label}”`);
      if (b.exact !== t.exact) changes.push(`${t.exact ? 'Fixed' : 'Freed'} the wording of “${t.label}”`);
    }
  }
  for (const [id, b] of bt) if (!at.has(id)) changes.push(`Removed topic “${b.label}”`);
  const order = (g) => (g?.topics || []).map((t) => t.id).join(',');
  if (changes.length === 0 && order(before) !== order(after)) changes.push('Changed topic order');
  return changes;
}
