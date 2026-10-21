// Report builder, saved reports, refresh, and PDF/CSV exports.
import PDFDocument from 'pdfkit';
import { route, fail } from '../lib/http.js';
import { store, must, nowIso } from '../lib/data.js';
import { newId } from '../lib/ids.js';
import { REPORT_TEMPLATES, buildSections, snapshotOf, isStale } from '../domain/reports.js';
import { asCsv, fmtPct } from '../domain/analytics.js';
import { SERVICE } from '../domain/catalog.js';
import { insightsFor } from './insights.js';

async function withStale(r) {
  const sessions = await store().list('session');
  return { ...r, stale: isStale(r, sessions) };
}

route('GET', '/api/hr/reports', async () => {
  const [reports, sessions] = await Promise.all([store().list('report'), store().list('session')]);
  return {
    templates: REPORT_TEMPLATES,
    reports: reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => ({
      id: r.id, title: r.title, template: r.template, programmeId: r.programmeId, createdAt: r.createdAt, asOf: r.asOf,
      scope: r.snapshot.scope, n: r.snapshot.current.n, stale: isStale(r, sessions), createdBy: r.createdBy,
    })),
  };
}, { auth: true });

route('POST', '/api/hr/reports', async (req) => {
  const { template = 'programme_summary', query = {}, title, themeId } = req.body || {};
  if (!REPORT_TEMPLATES[template]) fail(400, 'Choose a report template.');
  if (template === 'theme_investigation' && !themeId) fail(400, 'Choose a theme to investigate.');
  const ins = await insightsFor(query);
  const at = nowIso();
  const r = {
    id: newId('rep'), programmeId: ins.query.programmeId, template, themeId: themeId || null,
    title: String(title || `${REPORT_TEMPLATES[template].label}: ${ins.scope.programmes.map((p) => p.name).join(', ')}, ${ins.scope.periodLabel.split(' (')[0]}`).slice(0, 160),
    query: ins.query, createdAt: at, asOf: at, generatedAt: at, createdBy: req.user.email,
    sections: buildSections(ins, template, { themeId }), snapshot: snapshotOf(ins),
  };
  await store().put('report', r);
  return { report: await withStale(r) };
}, { auth: true });

route('GET', '/api/hr/reports/:id', async (req) => ({ report: await withStale(await must('report', req.params.id, 'Report')) }), { auth: true });

route('PUT', '/api/hr/reports/:id', async (req) => {
  const r = await must('report', req.params.id, 'Report');
  if (req.body?.title) r.title = String(req.body.title).slice(0, 160);
  if (Array.isArray(req.body?.sections)) {
    const byId = Object.fromEntries(r.sections.map((s) => [s.id, s]));
    const next = [];
    for (const s of req.body.sections) {
      const cur = byId[s.id];
      if (!cur) continue;
      if (typeof s.text === 'string' && s.text !== cur.text) { cur.text = s.text.slice(0, 10000); cur.edited = true; }
      if (typeof s.included === 'boolean') cur.included = s.included;
      if (typeof s.chartIncluded === 'boolean') cur.chartIncluded = s.chartIncluded;
      next.push(cur);
      delete byId[s.id];
    }
    r.sections = [...next, ...Object.values(byId)];
  }
  r.updatedAt = nowIso();
  await store().put('report', r);
  return { report: await withStale(r), savedAt: r.updatedAt };
}, { auth: true });

// Adds a finding or assistant answer, keeping its evidence and data context.
route('POST', '/api/hr/reports/:id/items', async (req) => {
  const r = await must('report', req.params.id, 'Report');
  const { title, text, refs, scope, interpretation } = req.body || {};
  if (!String(text || '').trim()) fail(400, 'Nothing to add.');
  r.sections.push({ id: newId('sec'), title: String(title || 'Added finding').slice(0, 200), included: true, text: String(text).slice(0, 5000), generated: false, edited: false, added: true, refs: refs || [], sourceScope: scope || null, interpretation: !!interpretation, chart: null });
  r.updatedAt = nowIso();
  await store().put('report', r);
  return { report: await withStale(r) };
}, { auth: true });

route('POST', '/api/hr/reports/:id/refresh', async (req) => {
  const r = await must('report', req.params.id, 'Report');
  const ins = await insightsFor(r.query);
  const fresh = Object.fromEntries(buildSections(ins, r.template, { themeId: r.themeId }).map((s) => [s.id, s]));
  // Reports made before Actions was removed may still have its section.
  r.sections = r.sections.filter((s) => s.id !== 'actions').map((s) => {
    if (s.added) return s;
    if (s.edited) return { ...s, needsReview: true };
    return fresh[s.id] ? { ...fresh[s.id], included: s.included } : s;
  });
  r.snapshot = snapshotOf(ins);
  r.asOf = nowIso();
  r.generatedAt = r.asOf;
  r.refreshHistory = [...(r.refreshHistory || []), { at: r.asOf, by: req.user.email }];
  await store().put('report', r);
  return { report: await withStale(r) };
}, { auth: true });

route('DELETE', '/api/hr/reports/:id', async (req) => { await store().delete('report', req.params.id); return { ok: true }; }, { auth: true });

route('GET', '/api/hr/reports/:id/csv', async (req) => {
  const r = await must('report', req.params.id, 'Report');
  return { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${slug(r.title)}.csv"` }, body: asCsv({ ...r.snapshot, current: r.snapshot.current }) };
}, { auth: true });

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'report';

route('GET', '/api/hr/reports/:id/pdf', async (req) => {
  const r = await must('report', req.params.id, 'Report');
  const org = await store().get('org', 'org');
  const buf = await renderPdf(r, org);
  return { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${slug(r.title)}.pdf"` }, body: buf };
}, { auth: true });

function renderPdf(r, org) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 56, right: 56 }, info: { Title: r.title, Author: SERVICE.name } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    const ink = '#1c1b22', muted = '#5f5d6b', accent = '#3f3a8c', brand = org.brandColor || '#0f766e';
    const W = doc.page.width - 112;
    const snap = r.snapshot;

    doc.fillColor(accent).font('Helvetica-Bold').fontSize(10).text(`${SERVICE.name.toUpperCase()}  ·  INDEPENDENT EXIT INTERVIEWS`, { characterSpacing: 0.6 });
    doc.fillColor(brand).font('Helvetica').fontSize(10).text(`Prepared for ${org.name}`);
    doc.moveDown(0.8);
    doc.fillColor(ink).font('Helvetica-Bold').fontSize(20).text(r.title, { width: W });
    doc.moveDown(0.3);
    doc.fillColor(muted).font('Helvetica').fontSize(9.5)
      .text(`${snap.scope.programmes.map((p) => p.name).join(', ')}  ·  ${snap.scope.periodLabel}  ·  ${snap.scope.basisLabel}`)
      .text(`${snap.current.n} submitted responses  ·  Data as of ${new Date(r.asOf).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}  ·  Exported ${new Date().toLocaleDateString('en-GB', { dateStyle: 'medium' })}`);
    if (Object.keys(snap.scope.filters).length) doc.text(`Filters: ${Object.entries(snap.scope.filters).map(([k, v]) => `${k} = ${v.join(', ')}`).join('; ')}`);
    if (snap.scope.population === 'demo') doc.fillColor('#9a3412').text('Fictional demonstration data.');
    doc.moveDown(1);

    const section = (title) => {
      if (doc.y > doc.page.height - 160) doc.addPage();
      doc.moveDown(0.4).fillColor(accent).font('Helvetica-Bold').fontSize(13).text(title).moveDown(0.25);
    };
    const para = (t, opts = {}) => doc.fillColor(opts.color || ink).font(opts.font || 'Helvetica').fontSize(opts.size || 10.5).text(t, { width: W, lineGap: 2.5, paragraphGap: 6 });
    const bars = (rows, max) => {
      const labelW = 190, barW = W - labelW - 70;
      for (const row of rows) {
        if (doc.y > doc.page.height - 80) doc.addPage();
        const y = doc.y;
        doc.fillColor(ink).font('Helvetica').fontSize(9.5).text(row.label, 56, y, { width: labelW - 10 });
        const w = max ? Math.max(2, (row.value / max) * barW) : 0;
        doc.rect(56 + labelW, y + 1, barW, 10).fill('#ecebf3');
        doc.rect(56 + labelW, y + 1, w, 10).fill(row.color || accent);
        doc.fillColor(muted).fontSize(9).text(row.text, 56 + labelW + barW + 8, y, { width: 62 });
        doc.y = y + 18;
        doc.x = 56;
      }
      doc.moveDown(0.4);
    };

    for (const s of r.sections.filter((x) => x.included)) {
      section(s.title);
      if (s.interpretation) para('Interpretation and suggestions, not proven causes or solutions.', { color: muted, size: 9, font: 'Helvetica-Oblique' });
      if (s.edited) para('Edited by an analyst. Figures come from the data as of the date above.', { color: muted, size: 9, font: 'Helvetica-Oblique' });
      for (const p of String(s.text).split('\n\n')) para(p);
      const c = snap.current;
      if (s.chart === 'reasons' && c.available && s.chartIncluded !== false) {
        const rows = Object.values(c.themes).filter((t) => t.confirmedReason).sort((a, b) => b.primary - a.primary || b.confirmedReason - a.confirmedReason).slice(0, 8);
        para('Confirmed main reason for leaving (respondents)', { size: 9, color: muted, font: 'Helvetica-Bold' });
        bars(rows.map((t) => ({ label: t.label, value: t.primary, text: `${t.primary} of ${c.n}` })), Math.max(...rows.map((t) => t.primary), 1));
      }
      if (s.chart === 'positives' && c.available && s.chartIncluded !== false) {
        const rows = Object.values(c.themes).filter((t) => t.tone.positive).sort((a, b) => b.tone.positive - a.tone.positive).slice(0, 5);
        bars(rows.map((t) => ({ label: t.label, value: t.tone.positive, text: `${t.tone.positive} of ${c.n}`, color: '#0f766e' })), c.n);
      }
      if (s.chart === 'comparison' && snap.comparison?.available && s.chartIncluded !== false) {
        const rows = snap.comparison.rows.filter((x) => x.now || x.prev).sort((a, b) => b.now - a.now).slice(0, 7);
        para(`Share of submitted respondents raising each theme: ${snap.comparison.periodLabel.split(' (')[0]} (light) and ${c.periodLabel.split(' (')[0]} (dark)`, { size: 9, color: muted, font: 'Helvetica-Bold' });
        for (const x of rows) {
          bars([{ label: x.label, value: (x.prevShare || 0) * 100, text: `${x.prev} (${fmtPct(x.prevShare)})`, color: '#a9a5d6' }], 100);
          doc.y -= 6;
          bars([{ label: '', value: (x.nowShare || 0) * 100, text: `${x.now} (${fmtPct(x.nowShare)})` }], 100);
        }
      }
      if (s.chart === 'participation') {
        const p = c.participation;
        bars([
          { label: 'Invited', value: p.eligible, text: String(p.eligible) },
          { label: 'Started', value: p.started, text: `${p.started} (${fmtPct(p.participationRate)})` },
          { label: 'Submitted', value: p.submitted, text: `${p.submitted} (${fmtPct(p.submissionRate)})` },
        ], p.eligible || 1);
      }
      if (s.evidence?.length) {
        for (const e of s.evidence) {
          const label = e.kind === 'paraphrase' ? 'Paraphrase' : e.lang !== 'en' ? `Translated quotation (original ${e.lang.toUpperCase()})` : 'Direct quotation';
          para(`${label} · ${e.respondent}`, { size: 8.5, color: muted, font: 'Helvetica-Bold' });
          para(e.kind === 'paraphrase' ? e.summary : `“${e.translation || e.text}”`, { size: 10 });
        }
      }
    }
    doc.moveDown(1);
    para(`Generated by ${SERVICE.name}. Findings describe submitted, employee-reviewed feedback from people who chose to respond. Interview audio is not retained.`, { size: 8.5, color: muted });
    doc.end();
  });
}
