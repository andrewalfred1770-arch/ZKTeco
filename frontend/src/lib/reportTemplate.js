/**
 * reportTemplate.js — PETSHROW unified A4 report generator
 *
 * Produces a single, self-contained HTML document used by THREE consumers:
 *   1. PDF export  → Electron Chromium `webContents.printToPDF` (real Arabic shaping)
 *   2. Print       → window.print() fallback (browser)
 *   3. Preview     → live A4 iframe in PrintPreviewModal
 *
 * Arabic fonts (Cairo) are embedded as base64 @font-face so output is correct
 * regardless of which fonts the host/printer has installed. This is what makes
 * the Arabic PDF render perfectly (no more mojibake from jsPDF/helvetica).
 */
import { CAIRO_FONTS } from './fonts/cairoFontData.js';
import { PLEX_FONTS } from './fonts/ibmPlexArabicFontData.js';
import { BRAND } from './branding.js';
import { westernDigits, getNestedValue } from './formatters.js';

const ARABIC_RANGE =
  'U+0600-06FF,U+0750-077F,U+0870-089F,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFF,U+0660-0669';

// ── Build embedded @font-face rules (Cairo, arabic + latin per weight) ─────────
function fontFaceCSS() {
  const weights = [400, 600, 700, 800];
  let css = '';
  for (const w of weights) {
    const ar = CAIRO_FONTS[`arabic_${w}`];
    const la = CAIRO_FONTS[`latin_${w}`];
    if (ar) {
      css += `@font-face{font-family:'Cairo';font-style:normal;font-weight:${w};font-display:swap;`
           + `src:url(data:font/woff2;base64,${ar}) format('woff2');unicode-range:${ARABIC_RANGE};}`;
    }
    if (la) {
      css += `@font-face{font-family:'Cairo';font-style:normal;font-weight:${w};font-display:swap;`
           + `src:url(data:font/woff2;base64,${la}) format('woff2');}`;
    }
  }
  return css;
}
// ── Build embedded @font-face rules (IBM Plex Sans Arabic, arabic + latin) ─────
function plexFontFaceCSS() {
  const weights = [400, 600, 700];
  let css = '';
  for (const w of weights) {
    const ar = PLEX_FONTS[`arabic_${w}`];
    const la = PLEX_FONTS[`latin_${w}`];
    if (ar) {
      css += `@font-face{font-family:'IBM Plex Sans Arabic';font-style:normal;font-weight:${w};font-display:swap;`
           + `src:url(data:font/woff2;base64,${ar}) format('woff2');unicode-range:${ARABIC_RANGE};}`;
    }
    if (la) {
      css += `@font-face{font-family:'IBM Plex Sans Arabic';font-style:normal;font-weight:${w};font-display:swap;`
           + `src:url(data:font/woff2;base64,${la}) format('woff2');}`;
    }
  }
  return css;
}

// Computed once (the base64 blobs don't change at runtime)
const FONT_CSS = fontFaceCSS();
const PLEX_CSS = plexFontFaceCSS();

/** Embedded Cairo @font-face CSS — reuse anywhere a self-contained Arabic
 *  print/PDF document is built (e.g. the salary sheet). */
export const EMBEDDED_FONT_CSS = FONT_CSS;

/** Embedded IBM Plex Sans Arabic @font-face CSS (compact salary sheet font). */
export const EMBEDDED_FONT_CSS_PLEX = PLEX_CSS;

/** Cairo + IBM Plex Sans Arabic embedded together — used by the salary sheet so
 *  both the detailed (Cairo) and compact (Plex) layouts render correctly. */
export const EMBEDDED_FONT_CSS_ALL = FONT_CSS + PLEX_CSS;

function nowStr() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return westernDigits(`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}  ${pad(d.getHours())}:${pad(d.getMinutes())}`);
}

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Escape a value for use inside a CSS double-quoted string (content property)
function cssStr(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Sum a numeric column across rows. */
function sumKey(rows, key) {
  return rows.reduce((s, r) => {
    const v = Number(getNestedValue(r, key));
    return s + (isNaN(v) ? 0 : v);
  }, 0);
}

/**
 * Build the full A4 report HTML.
 *
 * @param {Object}   o
 * @param {string}   o.title         report title
 * @param {Array}    o.columns       [{ header, key, format?, align?, tdClass?, thStyle?, total? }]
 *                                    total: 'sum' | (rows)=>value | function for custom
 * @param {Object[]} o.rows
 * @param {Object}   o.meta          { period, branch, dept, employee, shift, subtitle }
 * @param {Array}    o.stats         [{ label, value, color }]
 * @param {boolean}  o.showSignatures
 * @param {boolean}  o.showRowIndex
 * @param {string}   o.orientation   'portrait' | 'landscape'
 * @param {boolean}  o.embedFonts    embed base64 fonts (default true)
 */
// Extract the pixel-width hint from a thStyle string (e.g. 'width:80px' → 80).
// Returns a default of 80 when the style is absent or has no width declaration.
function parseThWidth(thStyle) {
  const m = (thStyle || '').match(/width:\s*(\d+(?:\.\d+)?)px/);
  return m ? parseFloat(m[1]) : 80;
}

export function buildReportHTML(o = {}) {
  const {
    title = 'تقرير',
    columns = [],
    rows = [],
    meta = {},
    stats = null,
    showSignatures = true,   // kept for API compatibility — never rendered
    showRowIndex = true,
    orientation = 'landscape',
    embedFonts = true,
    brand = BRAND,
  } = o;

  // ── Column widths (unchanged) ──────────────────────────────────────────────
  const idxPx   = showRowIndex ? 60 : 0;
  const colPx   = columns.map(c => parseThWidth(c.thStyle));
  const totalPx = idxPx + colPx.reduce((a, b) => a + b, 0) || 1;
  const pct     = px => (px / totalPx * 100).toFixed(2) + '%';

  // ── Brand / dates ─────────────────────────────────────────────────────────
  const logoHTML = brand.logoUrl
    ? `<img src="${esc(brand.logoUrl)}" alt="${esc(brand.name)}"
         style="width:100%;height:100%;object-fit:contain;border-radius:8px;" />`
    : `<span style="font-size:13px;font-weight:900;letter-spacing:-0.5px;">${esc(brand.mark || BRAND.mark)}</span>`;

  const printDate   = nowStr();
  const count       = westernDigits(rows.length);
  const isLand      = orientation === 'landscape';
  const generatedBy = meta.generatedBy || '';

  // ── Adaptive density — drives CSS token overrides per report ──────────────
  // small  ≤5 cols : spacious cells, taller rows
  // medium 6–9     : default (no override)
  // large  ≥10     : compact cells to prevent overflow
  const colCount = columns.length;
  const density  = colCount <= 5 ? 'small' : colCount <= 9 ? 'medium' : 'large';

  // ── Info panel rows (right column of header) ──────────────────────────────
  // SVG icon helpers (monochrome, 16×16 viewBox)
  const svgCal   = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6B7280" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
  const svgUsers = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6B7280" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
  const svgUser  = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6B7280" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

  const infoRow = (icon, label, value) =>
    `<div class="irow"><span class="iico">${icon}</span><span class="ilbl">${esc(label)}</span><span class="ival">${esc(value)}</span></div>`;

  let infoHTML = infoRow(svgCal,   'تاريخ الطباعة',  printDate)
               + infoRow(svgUsers, 'عدد السجلات',    count);
  if (generatedBy) infoHTML += infoRow(svgUser, 'تم إنشاء التقرير بواسطة', generatedBy);

  // ── Period strip ──────────────────────────────────────────────────────────
  const svgCalSmall = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#17325C" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
  const periodStrip = meta.period
    ? `<div class="period-strip">${svgCalSmall}<span class="period-lbl">الفترة</span><span class="period-val">${esc(meta.period)}</span></div>`
    : '';

  // ── Subtitle line under title (dept or employee) ──────────────────────────
  const titleSub = meta.employee
    ? `<div class="ttl-sub">${esc(meta.employee)}</div>`
    : meta.dept
    ? `<div class="ttl-sub">${esc(meta.dept)}</div>`
    : '';

  // ── KPI cards ─────────────────────────────────────────────────────────────
  // Inline SVG icons per colour theme
  const kpiIcons = {
    blue:   `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563EB" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    green:  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#16A34A" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    red:    `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#DC2626" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    amber:  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    purple: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#7C3AED" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`,
  };

  const statsBar = stats && stats.length
    ? `<div class="kpis">${stats.map(s => {
        const c = s.color || 'blue';
        return `<div class="kpi-card kpi-${esc(c)}">
          <div class="kpi-top">${kpiIcons[c] || kpiIcons.blue}<span class="kpi-lbl">${esc(s.label)}</span></div>
          <div class="kpi-num">${esc(s.value)}</div>
        </div>`;
      }).join('')}</div>`
    : '';

  // ── Table header cells ────────────────────────────────────────────────────
  const ths = (showRowIndex ? `<th class="idx" style="width:${pct(idxPx)}">#</th>` : '')
    + columns.map((c, i) => `<th style="width:${pct(colPx[i])}">${esc(c.header)}</th>`).join('');

  // ── Body rows (data-processing unchanged) ─────────────────────────────────
  const trs = rows.map((row, i) => {
    const cells = columns.map(c => {
      const raw = getNestedValue(row, c.key);
      const val = c.format ? (c.format(raw, row) ?? '—') : (raw ?? '—');
      const cls = c.tdClass ? c.tdClass(row) : (c.align === 'num' ? 'num' : '');
      const style = c.align && c.align !== 'num' ? `text-align:${c.align}` : '';
      return `<td class="${cls}" style="${style}">${esc(val)}</td>`;
    }).join('');
    return `<tr class="${i % 2 === 1 ? 'alt' : ''}">${showRowIndex ? `<td class="idx">${westernDigits(i + 1)}</td>` : ''}${cells}</tr>`;
  }).join('');

  // ── Totals row (computation unchanged) ────────────────────────────────────
  const hasTotals = columns.some(c => c.total);
  let totalsRow = '';
  if (hasTotals && rows.length) {
    const cells = columns.map((c, i) => {
      if (i === 0 && !c.total) return `<td class="t-label">الإجمالي</td>`;
      if (!c.total) return `<td></td>`;
      let v;
      if (c.total === 'sum') v = sumKey(rows, c.key);
      else if (typeof c.total === 'function') v = c.total(rows);
      else v = c.total;
      const out = c.format ? c.format(v, { __total: true }) : v;
      return `<td class="num t-val">${esc(out)}</td>`;
    }).join('');
    totalsRow = `<tr class="totals">${showRowIndex ? '<td></td>' : ''}${cells}</tr>`;
  }

  // ── Screen-only footer (hidden in @media print) ───────────────────────────
  const screenFooter = `<div class="screen-foot">
    <span>${esc(brand.name)}</span>
    ${generatedBy ? `<span>تم إنشاء التقرير بواسطة : ${esc(generatedBy)}</span>` : '<span></span>'}
    <span class="sf-page">صفحة <span id="pn">1</span></span>
  </div>`;

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl" data-cols="${density}">
<head>
<meta charset="UTF-8">
<title>${esc(title)} — ${esc(brand.name)}</title>
<style>
${embedFonts ? FONT_CSS : ''}
*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;}

/* ════════════════════════════════════════════════════════════════════════════════
   PETSHROW ERP ▸ ENTERPRISE PRINT DESIGN SYSTEM  v2.5  (10/10 target)
   ─────────────────────────────────────────────────────────────────────────────
   One source of truth. Every visual decision lives here.
   Change a token → the entire report updates automatically.
   ════════════════════════════════════════════════════════════════════════════════ */
:root{
  /* ── Palette ─────────────────────────────────────────────────────────────── */
  --p    : #17325C;   /* primary navy   – headings, borders, totals */
  --a    : #2563EB;   /* accent blue    – numeric highlights        */
  --suc  : #16A34A;   /* success        – present, positive         */
  --wrn  : #F59E0B;   /* warning        – late, attention           */
  --dng  : #DC2626;   /* danger         – absent, deductions        */
  --pur  : #7C3AED;   /* purple         – overtime, special         */

  /* ── Surfaces ────────────────────────────────────────────────────────────── */
  --bg    : #FFFFFF;  /* page / card background                      */
  --soft  : #EAF2FF;  /* period strip • table header • totals row    */
  --alt   : #F8FAFC;  /* alternating table row                       */
  --panel : #F2F7FE;  /* header info panel                           */

  /* ── Ink scale ───────────────────────────────────────────────────────────── */
  --i1 : #1F2937;   /* primary body text          */
  --i2 : #374151;   /* secondary text             */
  --i3 : #6B7280;   /* labels, captions, muted    */
  --i4 : #9CA3AF;   /* faint – row numbers, icons */

  /* ── Borders ─────────────────────────────────────────────────────────────── */
  --bd  : #D8E2EE;  /* outer border – same on every block          */
  --bd2 : #C3D5E8;  /* inner thead cell separator                  */

  /* ── Spacing scale  4 · 8 · 12 · 16 · 20 · 24 · 32 ─────────────────────── */
  --sp1 : 4px;
  --sp2 : 8px;
  --sp3 : 12px;
  --sp4 : 16px;   /* ← section gap                                 */
  --sp5 : 20px;
  --sp6 : 24px;
  --sp7 : 32px;

  /* ── Component tokens ────────────────────────────────────────────────────── */
  --sg  : var(--sp4);  /* section gap – same below every block     */
  --br  : 10px;        /* border-radius – same everywhere          */
  --bw  : 1px;         /* border-width  – same everywhere          */
  --shd : 0 1px 2px rgba(23,50,92,.05);   /* one shadow, invisible */

  /* ── Table rhythm ────────────────────────────────────────────────────────── */
  --ch  : 10px;   /* cell horizontal padding                       */
  --cv  : 8px;    /* cell vertical padding                         */
  --rh  : 38px;   /* body row min-height                           */
  --thh : 54px;   /* thead row height                              */
}

/* ── Page ─────────────────────────────────────────────────────────────────── */
@page{
  size: A4 ${isLand ? 'landscape' : 'portrait'};
  margin: 14mm 12mm 22mm 12mm;
  @bottom-right{
    content: "صفحة " counter(page) " من " counter(pages);
    font-size: 7pt; color: #9CA3AF;
    font-family: 'Cairo', Tahoma, Arial, sans-serif;
  }
}
html, body{
  font-family: 'Cairo', Tahoma, Arial, sans-serif;
  color: var(--i1); background: var(--bg);
  direction: rtl; font-size: 9.5pt; line-height: 1.5;
}

/* ════════════════════════════════════════════════════════════════════════════
   ALIGNMENT GRID
   Every block: width:100%, same horizontal start/end, uniform gap below.
   ════════════════════════════════════════════════════════════════════════════ */
.rpt-hdr, .period-strip, .kpis, .tbl-wrap, .screen-foot{
  width: 100%;
  margin-bottom: var(--sg);
}

/* ════════════════════════════════════════════════════════════════════════════
   ① HEADER  ─  3-column white card, no dark background
   ════════════════════════════════════════════════════════════════════════════ */
.rpt-hdr{
  display: flex; direction: ltr;  /* logo = visual-left */
  align-items: stretch;
  background: var(--bg);
  border: var(--bw) solid var(--bd);
  border-radius: var(--br);
  box-shadow: var(--shd);
  overflow: hidden;
  page-break-inside: avoid; break-inside: avoid;
}

/* Brand (left column) */
.hdr-brand{
  display: flex; align-items: center; gap: var(--sp3);
  padding: var(--sp5) var(--sp5);
  border-right: var(--bw) solid var(--bd);
  min-width: 196px; flex-shrink: 0; direction: ltr;
}
.hdr-logo-box{
  width: 44px; height: 44px; flex-shrink: 0;
  border-radius: var(--sp2);   /* 8px — rounds the square logo */
  background: var(--p); color: #fff;
  display: flex; align-items: center; justify-content: center;
  overflow: hidden; font-size: 13px; font-weight: 900;
}
.hdr-brand-name{ font-size: 11.5pt; font-weight: 800; color: var(--p); line-height: 1.1; }
.hdr-brand-tag1{ font-size: 7.5pt; color: var(--i3); margin-top: var(--sp1); line-height: 1.35; }
.hdr-brand-tag2{ font-size: 7pt;   color: var(--i4); margin-top: var(--sp1); line-height: 1.35; }

/* Title (center column) */
.hdr-center{
  flex: 1;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  padding: var(--sp5) var(--sp5);   /* matches brand column padding for visual balance */
  text-align: center; direction: rtl;
  border-right: var(--bw) solid var(--bd);
}
/* Brand text wrapper — explicit ltr so Arabic RTL cascade doesn't bleed in */
.hdr-brand-txt{ direction: ltr; }
/* 18pt ≈ 24px  spec: title 24px */
.hdr-title-txt{ font-size: 18pt; font-weight: 800; color: var(--p); line-height: 1.15; }
/* 10.5pt ≈ 14px  spec: subtitle 14px */
.ttl-sub      { font-size: 10.5pt; font-weight: 600; color: var(--i3); margin-top: var(--sp2); }

/* Info panel (right column) */
.hdr-info{
  background: var(--panel);
  padding: var(--sp3) var(--sp5);
  display: flex; flex-direction: column; justify-content: center; gap: var(--sp2);
  min-width: 208px; flex-shrink: 0; direction: rtl;
}
.irow{ display: flex; align-items: center; gap: var(--sp2); }
.iico{ flex-shrink: 0; line-height: 1; opacity: .6; }
.ilbl{ font-size: 6.5pt; color: var(--i3); font-weight: 600; min-width: 74px; text-align: right; }
.ival{ font-size: 7.5pt; font-weight: 700; color: var(--i2); }

/* ════════════════════════════════════════════════════════════════════════════
   ② PERIOD STRIP  ─  42–46px, soft blue, full width
   ════════════════════════════════════════════════════════════════════════════ */
.period-strip{
  display: flex; align-items: center; gap: var(--sp2);
  background: var(--soft);
  border: var(--bw) solid var(--bd);
  border-radius: var(--br);
  /* 12px v-pad + ~18px text-line-height = 42px row → within 42–46px spec */
  padding: var(--sp3) var(--sp5);
  direction: rtl;
  page-break-inside: avoid; break-inside: avoid;
}
.period-lbl{ font-size: 8pt;   color: var(--p); font-weight: 700; }
.period-val{ font-size: 8.5pt; font-weight: 700; color: var(--p); direction: ltr; }

/* ════════════════════════════════════════════════════════════════════════════
   ③ KPI CARDS  ─  72px, equal width, equal gap, white bg, soft border
   ════════════════════════════════════════════════════════════════════════════ */
.kpis{
  display: flex; gap: var(--sp3);   /* 12px gap between cards */
  page-break-inside: avoid; break-inside: avoid;
}
.kpi-card{
  flex: 1; min-height: 72px;
  display: flex; flex-direction: column; justify-content: center; gap: var(--sp1);
  padding: var(--sp2) var(--sp3);   /* 8px 12px */
  direction: rtl;
  background: var(--bg);
  border: var(--bw) solid var(--bd);
  border-radius: var(--br);
  box-shadow: var(--shd);
  page-break-inside: avoid;
}
.kpi-top{ display: flex; align-items: center; gap: 6px; }
.kpi-top svg{ width: 16px; height: 16px; flex-shrink: 0; }  /* override SVG presentation attrs */
.kpi-lbl{ font-size: 7.5pt; font-weight: 700; color: var(--i2); line-height: 1; }
/* 20pt ≈ 26.7px — closer to spec 30px, fits within 72px card */
.kpi-num{ font-size: 20pt; font-weight: 800; line-height: 1.05; font-variant-numeric: tabular-nums; }

/* KPI colour themes — soft tinted backgrounds */
.kpi-blue  { border-color:#BFDBFE; background:#EFF6FF; } .kpi-blue   .kpi-num{ color: var(--a);   }
.kpi-green { border-color:#BBF7D0; background:#F0FDF4; } .kpi-green  .kpi-num{ color: var(--suc); }
.kpi-red   { border-color:#FECACA; background:#FEF2F2; } .kpi-red    .kpi-num{ color: var(--dng); }
.kpi-amber { border-color:#FDE68A; background:#FFFBEB; } .kpi-amber  .kpi-num{ color: var(--wrn); }
.kpi-purple{ border-color:#DDD6FE; background:#F5F3FF; } .kpi-purple .kpi-num{ color: var(--pur); }

/* ════════════════════════════════════════════════════════════════════════════
   ④ TABLE  ─  wrapped in a card that matches every other block
   ════════════════════════════════════════════════════════════════════════════ */
.tbl-wrap{
  border: var(--bw) solid var(--bd);
  border-radius: var(--br);
  box-shadow: var(--shd);
  overflow: hidden;   /* clips table corners to the wrapper radius (screen/preview only) */
}
/* Chromium's print/PDF paginator can clip the bottom of the last row when an
   overflow:hidden container is fragmented across a page break — the rounded
   corners this clips are a screen-only nicety, so drop the clip for print. */
@media print{
  .tbl-wrap{ overflow: visible; }
}

table{
  width: 100%; border-collapse: collapse; table-layout: fixed;
  font-size: 9pt; margin: 0; border: none;
}
thead{ display: table-header-group; }

/* Table header */
thead th{
  background: var(--soft); color: var(--p);
  font-weight: 700; font-size: 10pt;
  padding: var(--cv) var(--ch);
  text-align: right;
  border-inline: 0.5px solid var(--bd2);
  border-block: 0.5px solid var(--bd2);
  white-space: normal; overflow: visible; text-overflow: clip;
  line-height: 1.45; vertical-align: middle;
  height: var(--thh);   /* 54px */
}

/* Table body */
tbody td{
  padding: var(--cv) var(--ch);
  border: 0.5px solid var(--bd);
  text-align: right; vertical-align: middle;
  overflow-wrap: break-word; word-break: break-word;
  line-height: 1.4; height: var(--rh);   /* 38px */
}
tbody tr.alt td{ background: var(--alt); }

/* Row-index column (auto #) — same nowrap contract as .num above, plus its
   own muted/small styling. Width is set generously (see idxPx above) so
   3–5 digit values fit even when many data columns compress its percentage
   share of the fixed table layout. */
th.idx, td.idx{
  text-align: center; color: var(--i4); font-size: 7pt; font-variant-numeric: tabular-nums;
  white-space: nowrap; overflow-wrap: normal; word-break: keep-all; overflow: hidden;
  letter-spacing: -0.2px;
}

/* Numeric cells — tabular-nums, LTR, centered. Also covers row/sequence-number
   columns rendered as data (e.g. log IDs, day numbers): must never wrap onto
   separate lines per digit, regardless of column width (99 / 999 / 1000 / 9999). */
.num, td.num{
  font-variant-numeric: tabular-nums lining-nums; direction: ltr; text-align: center; unicode-bidi: plaintext;
  white-space: nowrap; overflow-wrap: normal; word-break: keep-all; overflow: hidden; text-overflow: clip;
}

/* Status / value colours */
td.red    { color: var(--dng); font-weight: 700; }
td.green  { color: var(--suc); font-weight: 700; }
td.amber  { color: var(--wrn); font-weight: 700; }
td.muted  { color: var(--i4); }
td.status-present { color: var(--suc); font-weight: 700; }
td.status-absent  { color: var(--dng); font-weight: 700; }
td.status-late    { color: var(--wrn); font-weight: 700; }
td.status-weekend { color: #6B7280; }
td.status-holiday { color: var(--a); }

tr{ page-break-inside: avoid; break-inside: avoid; }

/* Totals row — must never be split across a page boundary. Redundant with
   the generic tr rule above (kept as the explicit, self-documenting
   guarantee for this specific row, per EF-016.1). */
tr.totals{ break-inside: avoid; page-break-inside: avoid; }

/* Totals row — visually continuous with the table body */
tr.totals td{
  background: var(--soft);
  border-top: 2px solid var(--p); border-bottom: none;
  border-inline: 0.5px solid var(--bd2);
  font-weight: 800; font-size: 10pt; color: var(--p);
  padding: var(--cv) var(--ch); height: var(--rh); vertical-align: middle;
}
tr.totals td.t-label{ text-align: right; white-space: nowrap; }
tr.totals td.t-val{ font-variant-numeric: tabular-nums; direction: ltr; text-align: center; }

/* ════════════════════════════════════════════════════════════════════════════
   ⑤ SCREEN FOOTER  ─  hidden during print (@page carries page number)
   ════════════════════════════════════════════════════════════════════════════ */
.screen-foot{
  display: flex; justify-content: space-between; align-items: center;
  direction: rtl; font-size: 9pt; color: var(--i3);
  border-top: var(--bw) solid var(--bd); padding-top: var(--sp2);
  margin-bottom: 0;
}
.sf-page{ font-weight: 700; color: var(--i2); }
@media print{ .screen-foot{ display: none; } }

/* ════════════════════════════════════════════════════════════════════════════
   ADAPTIVE DENSITY — overrides applied via data-cols on <html>
   small  (≤5 cols)  : larger padding, taller rows — report breathes
   medium (6–9 cols) : default values above — no override needed
   large  (≥10 cols) : tighter padding, shorter rows — all data fits
   ════════════════════════════════════════════════════════════════════════════ */

/* ── Small report (≤5 columns) ────────────────────────────────────────────── */
[data-cols="small"]{
  --ch  : 14px;   /* wider cell horizontal padding  */
  --cv  : 10px;   /* taller cell vertical padding   */
  --rh  : 44px;   /* taller body rows               */
  --thh : 58px;   /* taller header                  */
}
[data-cols="small"] .kpis{ gap: var(--sp4); }  /* 16px gap — cards feel less dense */

/* ── Large report (≥10 columns) ───────────────────────────────────────────── */
[data-cols="large"]{
  --ch  : 7px;    /* narrower cell padding to reclaim column space  */
  --cv  : 6px;    /* shorter vertical padding                       */
  --rh  : 36px;   /* compact rows                                   */
  --thh : 48px;   /* compact header                                 */
}
[data-cols="large"] table  { font-size: 8.5pt; }
[data-cols="large"] thead th{ font-size: 8.5pt; }
</style>
</head>
<body>

  <!-- ── Header ── -->
  <div class="rpt-hdr">

    <!-- LEFT: brand -->
    <div class="hdr-brand">
      <div class="hdr-logo-box">${logoHTML}</div>
      <div class="hdr-brand-txt">
        <div class="hdr-brand-name">${esc(brand.name)}</div>
        <div class="hdr-brand-tag1">${esc(brand.tagline)}</div>
        <div class="hdr-brand-tag2">${esc(brand.module)}</div>
      </div>
    </div>

    <!-- CENTER: title -->
    <div class="hdr-center">
      <div class="hdr-title-txt">${esc(title)}</div>
      ${titleSub}
    </div>

    <!-- RIGHT: info panel -->
    <div class="hdr-info">${infoHTML}</div>
  </div>

  ${periodStrip}
  ${statsBar}

  <div class="tbl-wrap">
    <table>
      <thead><tr>${ths}</tr></thead>
      <tbody>${trs}${totalsRow}</tbody>
    </table>
  </div>

  ${screenFooter}
</body>
</html>`;
}

export default buildReportHTML;
