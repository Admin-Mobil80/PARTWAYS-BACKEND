// Offline developer mode: rule-based stand-ins used only when no language model is
// configured. The interface labels this mode; it is not the evaluated interviewer.
import { THEMES, DEFAULT_TOPICS, TIER_ORDER } from './catalog.js';

export const KEYWORDS = {
  career_progression: ['promot', 'career', 'progress', 'grow', 'senior', 'develop', 'internal role', 'internal job', 'beförder', 'karriere', 'entwick', 'carrière', 'évolu', 'progresser'],
  workload: ['workload', 'overtime', 'short-staffed', 'understaffed', 'too much work', 'pressure', 'queue', 'burn', 'überstunden', 'arbeitslast', 'charge de travail', 'heures sup', 'surcharg'],
  manager_support: ['manager', 'boss', 'supervisor', 'vorgesetzt', 'chef', 'responsable'],
  compensation: ['pay', 'salary', 'money', 'bonus', 'commission', 'raise', 'gehalt', 'geld', 'salaire', 'argent', 'rémunération'],
  personal_circumstances: ['family', 'moving', 'relocat', 'partner', 'study', 'health', 'baby', 'familie', 'umzug', 'zieh', 'famille', 'déménag', 'études'],
  role_clarity: ['role', 'job description', 'advert', 'expected', 'responsibilit', 'rolle', 'stelle', 'poste', 'missions'],
  onboarding: ['induction', 'onboarding', 'first week', 'first day', 'training', 'buddy', 'einarbeitung', 'intégration', 'formation'],
  flexibility: ['hybrid', 'remote', 'flexib', 'from home', 'office days', 'homeoffice', 'télétravail', 'flexibilité'],
  leadership_direction: ['leadership', 'direction', 'restructur', 'strategy', 'senior management', 'führung', 'umstrukt', 'direction générale', 'stratégie'],
  team_belonging: ['team', 'colleague', 'kolleg', 'équipe', 'collègue'],
  tools_process: ['system', 'tool', 'laptop', 'software', 'process', 'werkzeug', 'outil', 'logiciel'],
  recognition: ['recogni', 'appreciat', 'valued', 'thank', 'anerkenn', 'reconnaiss'],
  shift_patterns: ['shift', 'rota', 'night', 'schicht', 'dienstplan', 'planning', 'nuit'],
  contract_end: ['contract ended', 'fixed-term', 'fixed term', 'befristet', 'cdd', 'fin de contrat'],
};

const DECLINE = ['don\'t want to', 'do not want to', 'rather not', 'prefer not', 'not comfortable', 'möchte nicht', 'lieber nicht', 'préfère ne pas', 'pas envie', 'ne veux pas'];
const NOTHING = ['nothing', 'no that', "that's all", 'that is all', 'no,', 'nope', 'nein', 'nichts', 'das war', 'non', 'rien', "c'est tout"];
const POSITIVE = ['good', 'great', 'brilliant', 'enjoy', 'support', 'helpful', 'love', 'gut', 'toll', 'super', 'bien', 'génial', 'excellent'];
const NEGATIVE = ['bad', 'never', 'frustrat', 'hard', 'stress', 'difficult', 'unfair', 'poor', 'schlecht', 'schwierig', 'mauvais', 'difficile', 'injuste'];
const SUGGEST = /\b(would like|wish|should|suggest|recommend|would be better|would have (kept|helped|made)|would help|it would|could (have|try|do)|sollte|könnte|vorschlag|devrait|pourrait|suggère)\b/;

const has = (text, words) => words.some((w) => text.includes(w));

export function detectThemes(text) {
  const t = text.toLowerCase();
  return Object.entries(KEYWORDS).filter(([, ws]) => has(t, ws)).map(([id]) => id);
}

export function toneOf(text) {
  const t = text.toLowerCase();
  const p = has(t, POSITIVE), n = has(t, NEGATIVE);
  return p && n ? 'mixed' : p ? 'positive' : n ? 'negative' : 'neutral';
}

const L = {
  intro: {
    en: (org) => `Hello, I'm an AI interviewer from PartWays, an independent service. ${org} asked us to hear about your experience as you leave. At the end you'll see a summary you can correct before anything is submitted. To start, how would you describe your time there?`,
    de: (org) => `Hallo, ich bin ein KI-Interviewer von PartWays, einem unabhängigen Dienst. ${org} hat uns gebeten, von Ihren Erfahrungen zu hören. Am Ende sehen Sie eine Zusammenfassung, die Sie korrigieren können, bevor etwas übermittelt wird. Wie würden Sie Ihre Zeit dort beschreiben?`,
    fr: (org) => `Bonjour, je suis un intervieweur IA de PartWays, un service indépendant. ${org} nous a demandé de recueillir votre expérience. À la fin, vous verrez un résumé que vous pourrez corriger avant tout envoi. Pour commencer, comment décririez-vous votre temps chez eux ?`,
  },
  ack: { en: ['Thank you.', 'I see.', 'That makes sense.', 'Understood.'], de: ['Danke.', 'Verstehe.', 'Das ist nachvollziehbar.'], fr: ['Merci.', 'Je comprends.', "C'est clair."] },
  declined: { en: "Of course, we'll leave that there.", de: 'Natürlich, das lassen wir so stehen.', fr: 'Bien sûr, nous en restons là.' },
  pause: { en: "There's no rush. If you'd prefer, we can move on to something else.", de: 'Lassen Sie sich Zeit. Wir können auch gern zu etwas anderem übergehen.', fr: "Prenez votre temps. Si vous préférez, nous pouvons passer à autre chose." },
  resume: { en: 'Welcome back. We had been talking about', de: 'Willkommen zurück. Wir hatten über folgendes gesprochen:', fr: 'Bon retour. Nous parlions de' },
  closing: { en: 'Is there anything important we have not covered?', de: 'Gibt es noch etwas Wichtiges, das wir nicht besprochen haben?', fr: "Y a-t-il quelque chose d'important que nous n'avons pas abordé ?" },
  end: { en: "Thank you for sharing all of that. Next you'll see a summary of what you said. You can correct, remove or add anything before you decide whether to submit it.", de: 'Danke, dass Sie das alles geteilt haben. Als Nächstes sehen Sie eine Zusammenfassung. Sie können alles korrigieren, entfernen oder ergänzen, bevor Sie entscheiden, ob Sie sie übermitteln.', fr: "Merci d'avoir partagé tout cela. Vous allez maintenant voir un résumé. Vous pourrez corriger, supprimer ou ajouter des éléments avant de décider de l'envoyer." },
  skip: { en: "Let's move on.", de: 'Gehen wir weiter.', fr: 'Passons à la suite.' },
};

const tr = (key, lang) => L[key][lang] || L[key].en;

export function offlineTurn({ session, plan, org, employeeText, event }) {
  const lang = session.language || 'en';
  const cov = session.coverage;
  const state = { coverage: {}, current_topic: session.currentTopic || null, phase: session.phase || 'opening', serious_concern: false, needs_clarification: false };
  const parts = [];
  const nextTopic = () => plan.topics.find((t) => !['explored', 'declined', 'skipped', 'insufficient'].includes(cov[t.id]) && !state.coverage[t.id] && t.id !== 'anything_else');
  const askNext = () => {
    const t = nextTopic();
    if (!t) { state.phase = 'closing_check'; state.current_topic = 'anything_else'; parts.push(tr('closing', lang)); return; }
    state.current_topic = t.id; state.phase = 'exploring';
    parts.push(t.opening);
  };

  if (event?.type === 'start') {
    state.current_topic = 'experience'; state.phase = 'opening';
    return { reply: tr('intro', lang)(org.name), state };
  }
  if (event?.type === 'long_pause') return { reply: tr('pause', lang), state };
  if (event?.type === 'resume') {
    const cur = plan.guide.topics.find((t) => t.id === session.currentTopic);
    parts.push(`${tr('resume', lang)} ${cur ? cur.label.toLowerCase() : '…'}.`);
    if (cur && !cov[cur.id]) { parts.push(cur.opening); } else askNext();
    return { reply: parts.join(' '), state };
  }
  if (event?.type === 'skip_topic' && session.currentTopic) {
    state.coverage[session.currentTopic] = 'skipped';
    parts.push(tr('skip', lang));
    askNext();
    return { reply: parts.join(' '), state };
  }
  if (event?.type === 'finish') {
    state.phase = 'closing_check'; state.current_topic = 'anything_else';
    return { reply: tr('closing', lang), state };
  }

  const text = (employeeText || '').toLowerCase();
  if (session.phase === 'closing_check' && (has(text, NOTHING) || text.split(/\s+/).length <= 3)) {
    state.coverage.anything_else = 'explored';
    state.phase = 'ended';
    return { reply: tr('end', lang), state };
  }
  if (has(text, DECLINE) && session.currentTopic) {
    state.coverage[session.currentTopic] = 'declined';
    parts.push(tr('declined', lang));
    askNext();
    return { reply: parts.join(' '), state };
  }
  const themes = detectThemes(text);
  for (const t of plan.guide.topics) {
    if (t.themes?.some((th) => themes.includes(th)) && !['declined'].includes(cov[t.id])) state.coverage[t.id] = 'explored';
  }
  if (session.currentTopic && !state.coverage[session.currentTopic]) {
    state.coverage[session.currentTopic] = text.split(/\s+/).length > 6 ? 'explored' : 'insufficient';
  }
  const acks = L.ack[lang] || L.ack.en;
  parts.push(acks[(session.transcript?.length || 0) % acks.length]);
  const cur = plan.guide.topics.find((t) => t.id === session.currentTopic);
  const asked = new Set((session.transcript || []).filter((t) => t.role === 'interviewer').map((t) => t.text));
  const follow = cur?.followUps?.find((f) => !asked.has(f) && ![...asked].some((a) => a.includes(f)));
  if (follow && text.split(/\s+/).length > 4 && !(session.followedUp || []).includes(cur.id)) {
    session.followedUp = [...(session.followedUp || []), cur.id];
    parts.push(follow);
  } else {
    askNext();
  }
  return { reply: parts.join(' '), state };
}

export function offlineSummary(session) {
  const points = [];
  const factors = [];
  const employeeTurns = (session.transcript || []).filter((t) => t.role === 'employee' && t.text.split(/\s+/).length >= 3);
  let reasonsSeen = 0;
  for (const turn of employeeTurns) {
    const themes = detectThemes(turn.text);
    const tone = toneOf(turn.text);
    const lower = turn.text.toLowerCase();
    let section = 'additional';
    if (SUGGEST.test(lower)) section = 'suggestions';
    else if (tone === 'positive') section = 'positives';
    else if (themes.length && reasonsSeen < 2 && tone !== 'positive') { section = 'main_reasons'; reasonsSeen++; }
    else if (tone === 'negative' || tone === 'mixed') section = 'concerns';
    const sentence = turn.text.length > 220 ? `${turn.text.slice(0, 217).trim()}…` : turn.text;
    points.push({
      id: `pt_${points.length + 1}`, section, text: sentence, textEn: null, themes, tone, sub: null,
      origin: 'interviewer', status: 'kept',
      evidence: [{ turnId: turn.id, kind: session.language === 'en' ? 'quote' : 'translated_quote', text: turn.text, lang: session.language, translation: null }],
      mentions: 1, lang: session.language,
    });
    if (section === 'main_reasons') for (const th of themes) if (!factors.some((f) => f.theme === th)) factors.push({ theme: th, role: factors.length ? 'contributing' : 'trigger', status: 'suggested', rank: null });
  }
  return { points, factors, noSingleMainReason: false, preventability: 'not_discussed', finalComment: null, generatedBy: 'offline' };
}

export function offlinePlan(objectives, template) {
  const topics = [];
  const add = (id, objId) => {
    let t = topics.find((x) => x.id === id);
    if (!t) {
      const base = DEFAULT_TOPICS.find((x) => x.id === id);
      t = { ...structuredClone(base), objectiveIds: [], exact: false };
      topics.push(t);
    }
    if (objId && !t.objectiveIds.includes(objId)) t.objectiveIds.push(objId);
    return t;
  };
  add('experience'); add('reasons');
  for (const o of objectives) {
    const themes = detectThemes(`${o.title} ${o.description || ''} ${o.context || ''}`);
    o.themeIds = themes;
    const matched = DEFAULT_TOPICS.filter((t) => t.themes.some((th) => themes.includes(th)));
    if (/positive|preserv|working well|keep/i.test(o.title)) matched.push(DEFAULT_TOPICS.find((t) => t.id === 'positives'));
    if (/why|driver|reason/i.test(o.title)) matched.push(DEFAULT_TOPICS.find((t) => t.id === 'reasons'));
    if (matched.length) {
      for (const m of matched) {
        const t = add(m.id, o.id);
        if (o.priority === 'high' && TIER_ORDER[t.tier] > TIER_ORDER.standard) t.tier = 'standard';
        if (o.priority === 'high') t.kind = 'core';
      }
      o.topicIds = [...new Set(matched.map((m) => m.id))];
    } else {
      const id = `obj_${o.id}`;
      topics.push({ id, label: o.title, themes: [], kind: o.priority === 'high' ? 'core' : 'optional', tier: o.priority === 'high' ? 'quick' : 'standard', exact: false,
        opening: `I'd like to understand something the organisation is interested in: ${o.title.replace(/^(understand|identify|learn|find out|check)\s+/i, '').replace(/\.$/, '')}. What was your experience of that?`,
        followUps: [], objectiveIds: [o.id] });
      o.topicIds = [id];
    }
  }
  add('positives'); add('preventability'); add('anything_else');
  const order = ['experience', 'reasons'];
  topics.sort((a, b) => {
    const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
    if (a.id === 'anything_else') return 1; if (b.id === 'anything_else') return -1;
    return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib);
  });
  return { topics, objectives, generatedBy: 'offline', template };
}

export const THEME_NAMES = Object.fromEntries(Object.entries(THEMES).map(([k, v]) => [k, v.label]));
