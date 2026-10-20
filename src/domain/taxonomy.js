// Analyst theme edits (rename, merge, split by subtheme). Stored edits are applied
// to a copy of the data before analysis, so the original reviewed accounts stay intact.
import { THEMES } from './catalog.js';

export const EMPTY_TAXONOMY = { id: 'taxonomy', edits: [] };

export function themesWith(taxonomy) {
  const themes = structuredClone(THEMES);
  for (const e of taxonomy?.edits || []) {
    if (e.op === 'rename' && themes[e.theme]) themes[e.theme].label = e.label;
    if (e.op === 'merge' && themes[e.into]) {
      for (const f of e.from) {
        if (!themes[f] || f === e.into) continue;
        themes[e.into].subthemes = [...new Set([...themes[e.into].subthemes, ...themes[f].subthemes])];
        delete themes[f];
      }
      if (e.label) themes[e.into].label = e.label;
    }
    if (e.op === 'split' && themes[e.theme]) {
      themes[e.into] = { label: e.label, description: `Split from ${themes[e.theme].label}: ${e.sub}.`, subthemes: [e.sub] };
      themes[e.theme].subthemes = themes[e.theme].subthemes.filter((x) => x !== e.sub);
    }
  }
  return themes;
}

function remapPoint(p, edits) {
  let themes = [...p.themes];
  for (const e of edits) {
    if (e.op === 'merge') themes = themes.map((t) => (e.from.includes(t) ? e.into : t));
    if (e.op === 'split' && themes.includes(e.theme) && p.sub === e.sub) themes = themes.map((t) => (t === e.theme ? e.into : t));
  }
  return [...new Set(themes)];
}

export function applyTaxonomy(data, taxonomy) {
  const edits = taxonomy?.edits || [];
  if (!edits.length) return { ...data, themes: THEMES };
  const sessions = data.sessions.map((s) => {
    if (!s.summary) return s;
    const points = s.summary.points.map((p) => ({ ...p, themes: remapPoint(p, edits) }));
    const seen = new Set();
    const factors = [];
    for (const f of s.summary.factors || []) {
      let theme = f.theme;
      for (const e of edits) if (e.op === 'merge' && e.from.includes(theme)) theme = e.into;
      if (seen.has(`${theme}:${f.role}`)) continue;
      seen.add(`${theme}:${f.role}`);
      factors.push({ ...f, theme });
    }
    return { ...s, summary: { ...s.summary, points, factors } };
  });
  const programmes = data.programmes.map((p) => {
    const fix = (topics) => topics.map((t) => ({ ...t, themes: [...new Set((t.themes || []).map((th) => edits.reduce((x, e) => (e.op === 'merge' && e.from.includes(x) ? e.into : x), th)))] }));
    return { ...p, topics: fix(p.topics), guideVersions: p.guideVersions.map((g) => ({ ...g, topics: fix(g.topics) })) };
  });
  return { ...data, sessions, programmes, themes: themesWith(taxonomy) };
}

export function validateEdit(edit, taxonomy) {
  const themes = themesWith(taxonomy);
  if (edit.op === 'rename') {
    if (!themes[edit.theme]) return 'Choose a theme to rename.';
    if (!String(edit.label || '').trim()) return 'Enter a new name.';
  } else if (edit.op === 'merge') {
    if (!Array.isArray(edit.from) || !edit.from.length || edit.from.some((f) => !themes[f])) return 'Choose the themes to merge.';
    if (!themes[edit.into]) return 'Choose the theme to merge into.';
  } else if (edit.op === 'split') {
    if (!themes[edit.theme]) return 'Choose a theme to split.';
    if (!themes[edit.theme].subthemes.includes(edit.sub)) return 'Choose a subtheme to split out.';
    if (!String(edit.label || '').trim()) return 'Name the new theme.';
  } else return 'Unknown change.';
  return null;
}
