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
import { isAbsentRow } from './gridDefaults.js';

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

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Escape a value for use inside a CSS double-quoted string (content property)
function cssStr(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Metadata-card icons — small monochrome stroke marks (currentColor, so each
// simply inherits the card's accent color). Presentation-only, three fixed
// icons for the three fixed metadata fields (period / generated-by / count).
function svgIcon(paths, size = 13) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}
const META_ICONS = {
  period: svgIcon(`<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>`),
  user:   svgIcon(`<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>`),
  count:  svgIcon(`<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15h6M9 11h6"/>`),
};

/** Sum a numeric column across rows. */
function sumKey(rows, key) {
  return rows.reduce((s, r) => {
    const v = Number(getNestedValue(r, key));
    return s + (isNaN(v) ? 0 : v);
  }, 0);
}

// Statistics-row micro-card accent — maps the color NAME callers already
// pass on each stat (business logic, untouched) to one of the six
// enterprise-palette CSS classes below. Presentation-only lookup.
const ACCENT_CLASS = {
  blue: 'blue', green: 'green', red: 'red',
  amber: 'amber', orange: 'amber', yellow: 'amber',
  purple: 'purple', teal: 'teal', cyan: 'teal',
};


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

// Named CSS page sizes Chromium understands natively via the `size` property —
// no manual mm math needed, and each stays exactly the paper's real dimensions.
const PAPER_SIZE_KEYWORDS = { A4: 'A4', Letter: 'letter', Legal: 'legal' };

// Print-time margin presets (mm) — "normal" is the exact value this template
// shipped with before print-experience settings existed, so the default
// output is byte-for-byte unchanged for every existing caller.
const MARGIN_PRESETS = {
  normal: { v: 10, h: 8 },
  narrow: { v: 6,  h: 5 },
  wide:   { v: 16, h: 14 },
};

export function buildReportHTML(o = {}) {
  const {
    title = 'تقرير',
    columns = [],
    rows = [],
    meta = {},
    stats = null,
    showSignatures = false,  // now actually renders a sign-off block (see § SIGNATURE)
    showRowIndex = true,
    orientation = 'landscape',
    embedFonts = true,
    brand = BRAND,
    // ── Print Experience settings (Print Preview → left sidebar) ─────────────
    // Every one of these defaults to the exact behavior this function had
    // before the settings existed, so any caller that doesn't pass them
    // (there is none today besides PrintPreviewModal, but this keeps the
    // function itself provably backward-compatible) gets byte-identical
    // output. None of this touches report content, calculations, columns,
    // or row data — purely page geometry and document chrome.
    paperSize        = 'A4',      // 'A4' | 'Letter' | 'Legal'
    margins          = 'normal',  // 'normal' | 'narrow' | 'wide'
    scalePercent     = 100,       // print-time content scale, 100 = unchanged
    showHeaderFooter = true,      // letterhead + meta line + page footer
    repeatHeader     = true,      // table header repeats on every printed page
    printBackground  = true,      // shaded cells/rows print as seen vs. ink-saving outline
    watermarkText    = '',        // '' = no watermark
    showStamp        = false,     // overlay brand.stampUrl in the signature area
  } = o;

  // ── Column widths ────────────────────────────────────────────────────────
  // Total-bearing columns render an aggregate SUM in the footer row, which is
  // systematically wider than any single row's value (more digits, but the
  // same formatter/unit-suffix, e.g. " ساعات") — widen just those columns a
  // bit so the footer sum has room to fit the width its own header/body
  // cells already share, instead of clipping against a width only ever
  // tuned for per-row content. header/body/totals all read from this same
  // colPx/pct array, so they stay pixel-identical to each other either way.
  const idxPx   = showRowIndex ? 60 : 0;
  const colPx   = columns.map(c => parseThWidth(c.thStyle) + (c.total ? 16 : 0));
  const totalPx = idxPx + colPx.reduce((a, b) => a + b, 0) || 1;
  const pct     = px => (px / totalPx * 100).toFixed(2) + '%';

  // ── Brand / dates ─────────────────────────────────────────────────────────
  // Only the official company logo image — no standalone monogram/"P" mark
  // fallback. When no logo is configured, the tile is simply omitted (see
  // dh-logo rendering below) and the company name/tagline text stands alone.
  const logoHTML = brand.logoUrl
    ? `<img src="${esc(brand.logoUrl)}" alt="${esc(brand.name)}"
         style="width:100%;height:100%;object-fit:contain;" />`
    : '';

  const count       = westernDigits(rows.length);
  const isLand      = orientation === 'landscape';
  const generatedBy = meta.generatedBy || '';

  // ── Footer identity — brings the previously-unused company contact/footer
  // settings (بيانات الشركة → إعدادات الطباعة) onto every printed page
  // instead of just the bare brand name. Falls back gracefully when the
  // user hasn't filled either field in yet.
  const footerContact = meta.printContactText || brand.printContactText || '';
  const footerLeft = [brand.name, footerContact].filter(Boolean).join('  ·  ');

  // ── Print Experience geometry ──────────────────────────────────────────────
  const pageSizeKeyword = PAPER_SIZE_KEYWORDS[paperSize] || PAPER_SIZE_KEYWORDS.A4;
  const marginPreset     = MARGIN_PRESETS[margins] || MARGIN_PRESETS.normal;
  const scale            = Math.max(0.5, Math.min(1.5, (Number(scalePercent) || 100) / 100));

  // Diagonal repeating watermark — a background-image (not a fixed-position
  // element) because only element backgrounds reliably repeat on EVERY
  // printed page in paginated media; a single absolutely-positioned div only
  // ever renders once. Built as an inline SVG tile so no extra asset/request
  // is needed and it scales losslessly at any zoom/DPI.
  const watermarkCSS = watermarkText ? (() => {
    const safe = esc(watermarkText).slice(0, 40);
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='420' height='420'>`
      + `<text x='210' y='210' font-family='Cairo,Arial,sans-serif' font-size='34' font-weight='800' `
      + `fill='rgba(15,23,42,0.055)' text-anchor='middle' dominant-baseline='middle' `
      + `transform='rotate(-32 210 210)'>${safe}</text></svg>`;
    const uri = `data:image/svg+xml;base64,${typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(svg))) : ''}`;
    return `background-image:url("${uri}"); background-repeat:repeat;`;
  })() : '';

  // ── Signature / sign-off block ─────────────────────────────────────────────
  // A real enterprise document ends with an approval trail, not just a page
  // number. Three roles is the common accounting convention (prepared /
  // reviewed / approved) — company stamp, when enabled, sits over the
  // approval line the way a physical rubber stamp would.
  const signatureHTML = showSignatures ? `
    <div class="signature-area">
      <div class="sig-block"><div class="sig-line">إعداد</div></div>
      <div class="sig-block"><div class="sig-line">مراجعة</div></div>
      <div class="sig-block">
        ${showStamp && brand.stampUrl ? `<img class="sig-stamp" src="${esc(brand.stampUrl)}" alt="" />` : ''}
        <div class="sig-line">اعتماد</div>
      </div>
    </div>` : '';

  // ── Adaptive density — drives CSS token overrides per report ──────────────
  // small  ≤5 cols : spacious cells, taller rows
  // medium 6–9     : default (no override)
  // large  ≥10     : compact cells to prevent overflow
  const colCount = columns.length;
  const density  = colCount <= 5 ? 'small' : colCount <= 9 ? 'medium' : 'large';

  // ── Document header — an official letterhead: masthead · metadata cards ·
  // statistics cards · one divider. `title` is trusted as-is (callers like
  // EmployeeMovementPage already build "حركة الموظف — <name>" themselves).
  const fullTitle = title;
  const brandSub  = brand.tagline || brand.description || '';

  // ── Metadata cards — exactly three fixed fields (period / generated-by /
  // record count). No print-timestamp field — a printed enterprise document
  // does not carry a "printed at" stamp.
  function metaItem(iconKey, label, value) {
    if (!value) return '';
    return `<div class="dh-meta-card">
      <div class="dh-meta-top"><span class="dh-meta-icon">${META_ICONS[iconKey]}</span><span class="dh-meta-label">${esc(label)}</span></div>
      <span class="dh-meta-value">${esc(value)}</span>
    </div>`;
  }
  const metaBarHTML = `<div class="dh-meta-bar">
    ${metaItem('period', 'الفترة', meta.period)}
    ${metaItem('user', 'بواسطة', generatedBy)}
    ${metaItem('count', 'عدد السجلات', count)}
  </div>`;

  // ── Statistics row — compact "enterprise micro cards": each stat's own
  // (already-existing) color name — 'blue'/'green'/'red'/'amber'/'purple'/
  // 'teal', passed unchanged by the caller's business logic — picks only
  // the 3px top accent line. No new data, no calculation touched here.
  const kpiHTML = stats && stats.length
    ? `<div class="dh-kpis">${stats.map(s => {
        const c = ACCENT_CLASS[s.color] || 'blue';
        return `<div class="dh-kpi c-${c}">
          <span class="dh-kpi-value">${esc(s.value)}</span>
          <span class="dh-kpi-label">${esc(s.label)}</span>
        </div>`;
      }).join('')}</div>`
    : '';

  // ── Table header cells ────────────────────────────────────────────────────
  const ths = (showRowIndex ? `<th class="idx" style="width:${pct(idxPx)}">#</th>` : '')
    + columns.map((c, i) => `<th style="width:${pct(colPx[i])}">${esc(c.header)}</th>`).join('');

  // ── Body rows (data-processing unchanged) ─────────────────────────────────
  // Absence detection reuses the same isAbsentRow() the on-screen grids use
  // (gridDefaults.js) — one canonical definition, so a printed report shows
  // exactly the rows the grid would have highlighted.
  const trs = rows.map((row, i) => {
    const cells = columns.map(c => {
      const raw = getNestedValue(row, c.key);
      const val = c.format ? (c.format(raw, row) ?? '—') : (raw ?? '—');
      const cls = c.tdClass ? c.tdClass(row) : (c.align === 'num' ? 'num' : '');
      const style = c.align && c.align !== 'num' ? `text-align:${c.align}` : '';
      return `<td class="${cls}" style="${style}">${esc(val)}</td>`;
    }).join('');
    const rowCls = [i % 2 === 1 ? 'alt' : '', isAbsentRow(row) ? 'row-absent' : ''].filter(Boolean).join(' ');
    return `<tr class="${rowCls}">${showRowIndex ? `<td class="idx">${westernDigits(i + 1)}</td>` : ''}${cells}</tr>`;
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
    totalsRow = `<tr class="totals">${showRowIndex ? '<td class="idx"></td>' : ''}${cells}</tr>`;
  }

  // ── Screen-only footer (hidden in @media print) ───────────────────────────
  const screenFooter = `<div class="screen-foot">
    <span>${esc(footerLeft)}</span>
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
*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:${printBackground ? 'exact' : 'economy'};print-color-adjust:${printBackground ? 'exact' : 'economy'};}

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
  --sp4 : 10px;   /* ← section gap (print-optimized: was 16px)     */
  --sp5 : 14px;   /* header/info-panel padding (print-optimized: was 20px) */
  --sp6 : 24px;
  --sp7 : 32px;

  /* ── Component tokens ────────────────────────────────────────────────────── */
  --sg  : var(--sp4);  /* section gap – same below every block     */
  --bw  : 1px;         /* border-width  – same everywhere          */

  /* ── Table rhythm ────────────────────────────────────────────────────────── */
  --ch  : 10px;   /* cell horizontal padding                       */
  --cv  : 8px;    /* cell vertical padding                         */
  --rh  : 38px;   /* body row min-height                           */
  --thh : 52px;   /* thead row height                              */
}

/* ── Page ─────────────────────────────────────────────────────────────────── */
@page{
  size: ${pageSizeKeyword} ${isLand ? 'landscape' : 'portrait'};
  /* Print-optimized default ("normal" preset, 10mm/8mm): far more than the
     7pt page-number footnote needs, but comfortably inside every printer's
     safe-print area. "narrow"/"wide" (Print Preview → Margins) scale this
     same rule — nothing here is hardcoded anymore. */
  margin: ${marginPreset.v}mm ${marginPreset.h}mm ${marginPreset.v}mm ${marginPreset.h}mm;
  /* Document footer — repeats on every printed page (unlike the screen-only
     .screen-foot below, which only ever occupied page 1's flow). This is
     the ERP-document convention: company identity anchored bottom-left,
     pagination bottom-right, on every sheet. Tied to showHeaderFooter — off
     when printing onto pre-printed letterhead stationery that already
     carries this information. */
  ${showHeaderFooter ? `@bottom-left{
    content: "${cssStr(footerLeft)}";
    font-size: 7pt; color: #9CA3AF;
    font-family: 'Cairo', Tahoma, Arial, sans-serif;
  }` : ''}
  @bottom-right{
    content: "صفحة " counter(page) " من " counter(pages);
    font-size: 7pt; color: #9CA3AF;
    font-family: 'Cairo', Tahoma, Arial, sans-serif;
  }
}
html, body{
  font-family: 'Cairo', Tahoma, Arial, sans-serif;
  color: var(--i1); background: var(--bg);
  direction: rtl; line-height: 1.5;
  /* Print Preview → Scale — a print-time content scale distinct from the
     preview's own on-screen zoom (which never affects the printed page,
     exactly like Word/Acrobat). 100% reproduces the exact 9.5pt this
     template always shipped with. */
  font-size: calc(9.5pt * ${scale});
  ${watermarkCSS}
}

/* ════════════════════════════════════════════════════════════════════════════
   ALIGNMENT GRID
   Every block: width:100%, same horizontal start/end, uniform gap below.
   ════════════════════════════════════════════════════════════════════════════ */
table, .table-wrap, .screen-foot{
  width: 100%;
  margin-bottom: var(--sg);
}
table{ margin-bottom: 0; }

/* ════════════════════════════════════════════════════════════════════════════
   OFFICIAL DOCUMENT HEADER — plain letterhead, not a dashboard.
   Premium letterhead — soft-shadowed cards + a subtle gradient table head,
   inspired by SAP S/4HANA / Dynamics 365 / Oracle Fusion / Odoo Enterprise
   printed report headers. One consistent 8px rhythm between all four
   sections; exactly ONE hairline divider, placed right before the table:
     ① Masthead   — company (left) + report title/date (right), two columns
     ② Metadata   — 3 compact info cards: الفترة · بواسطة · عدد السجلات
     ③ Statistics — one KPI card per stat: number + label + color accent
     ④ Divider    — the only rule in the header, then the table
   ════════════════════════════════════════════════════════════════════════════ */
:root{
  --hair: #D9E2EC;                          /* header hairline / divider */
  --card-bd: #E5E7EB;                       /* card border — all header cards */
  --card-shadow: 0 2px 4px rgba(15,39,75,0.07), 0 1px 2px rgba(15,39,75,0.05);
  --rhythm: 6px;                            /* gap between the 4 header sections (compressed from the requested 12px — see reportTemplate.js header-block comment) */
}

/* ① Masthead — two plain columns, no rule/card of its own. DOM order is
   report-title-block first, company-block second: in this RTL document the
   first flex child lands at the inline-start (visual RIGHT), so the title
   renders on the right and the company block on the left, per spec. */
.doc-header{
  display: flex; align-items: center; justify-content: space-between;
  gap: 24px;
  margin-bottom: var(--rhythm);
  page-break-inside: avoid; break-inside: avoid;
}
.dh-brand{ display: flex; align-items: center; gap: 10px; direction: ltr; flex-shrink: 0; }
.dh-logo{
  width: 48px; height: 48px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  overflow: hidden; line-height: 1;
}
.dh-brand-text{ direction: ltr; text-align: left; line-height: 1.2; }
.dh-brand-name{ font-size: 18px; font-weight: 700; color: #0F274B; white-space: nowrap; }
.dh-brand-sub{ font-size: 14px; color: var(--i3); font-weight: 500; margin-top: 1px; white-space: nowrap; }

.dh-report{ flex: 1; min-width: 0; direction: rtl; text-align: right; }
.dh-title{
  font-size: 27px; font-weight: 700; color: #0F274B; line-height: 1;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dh-period{ font-size: 15px; font-weight: 600; color: #0F274B; margin-top: 2px; line-height: 1.1; }
.dh-subtitle{ font-size: 14px; color: var(--i3); font-weight: 500; margin-top: 1px; }

/* ② Metadata cards — premium info blocks: white body, soft border, 10px
   radius, very soft shadow, equal height, icon in the accent color, bold
   value. */
.dh-meta-bar{
  display: flex; direction: rtl; align-items: stretch; gap: 10px;
  margin-bottom: var(--rhythm);
  page-break-inside: avoid; break-inside: avoid;
}
.dh-meta-card{
  flex: 1 1 0; min-width: 0;
  display: flex; flex-direction: column; justify-content: center; gap: 3px;
  padding: 3px 12px;
  background: #fff;
  border: 1px solid var(--card-bd);
  border-radius: 10px;
  box-shadow: var(--card-shadow);
}
.dh-meta-top{ display: flex; align-items: center; gap: 5px; color: #2563EB; line-height: 1; }
.dh-meta-icon{ display: flex; flex-shrink: 0; line-height: 1; }
.dh-meta-icon svg{ display: block; }
.dh-meta-label{ font-size: 12px; color: var(--i3); font-weight: 600; line-height: 1; }
.dh-meta-value{ font-size: 15px; color: #0F274B; font-weight: 700; line-height: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ③ Statistics row — premium KPI cards: white body, soft border, rounded
   corners, soft shadow, a 4px color accent on the TOP edge only. Equal
   width, equal height, generous padding — cards breathe, not cramped. */
.dh-kpis{
  display: flex; direction: rtl; align-items: stretch; gap: 10px;
  margin-bottom: var(--rhythm);
  page-break-inside: avoid; break-inside: avoid;
}
.dh-kpi{
  flex: 1 1 0; min-width: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  padding: 4px 8px;
  background: #fff;
  border: 1px solid var(--card-bd);
  border-radius: 8px;
  border-top: 4px solid var(--kpi-accent, #2563EB);
  box-shadow: var(--card-shadow);
  page-break-inside: avoid;
}
.dh-kpi-value{ font-size: 21px; font-weight: 700; color: #0F274B; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -0.2px; }
.dh-kpi-label{ font-size: 11px; font-weight: 500; color: var(--i3); line-height: 1.2; white-space: nowrap; }

.dh-kpi.c-blue  { --kpi-accent: #2563EB; }
.dh-kpi.c-green { --kpi-accent: #16A34A; }
.dh-kpi.c-red   { --kpi-accent: #DC2626; }
.dh-kpi.c-amber { --kpi-accent: #F97316; }
.dh-kpi.c-purple{ --kpi-accent: #7C3AED; }
.dh-kpi.c-teal  { --kpi-accent: #0D9488; }

/* ④ The ONLY divider in the header — closes it, then the table begins
   8–10px later. No double rule, no heavy border. */
.dh-divider{ height: 1px; background: var(--hair); margin-bottom: 6px; }

/* ════════════════════════════════════════════════════════════════════════════
   ③ TABLE  ─  a premium document ledger: rounded 12px container, soft
   border, overflow hidden so the table's own square corners never poke
   past the wrapper's radius. No harsh edges.
   ════════════════════════════════════════════════════════════════════════════ */
.table-wrap{
  border: 1px solid var(--card-bd);
  border-radius: 12px;
  box-shadow: var(--card-shadow);
  overflow: hidden;
  page-break-inside: auto;
}
table{
  width: 100%; border-collapse: collapse; table-layout: fixed;
  font-size: 9pt; margin: 0;
}
/* Print Preview → Repeat Header: table-header-group repeats thead on every
   printed page (the default); table-row-group renders it once, in place,
   like any other row — for reports where a repeating header would be
   redundant against a very short single-page table. */
thead{ display: ${repeatHeader ? 'table-header-group' : 'table-row-group'}; }

/* Table header — soft blue gradient, not flat, per the enterprise-report
   spec (SAP/Dynamics/Oracle Fusion table heads use a subtle top-lit tint).
   The wrapper's overflow:hidden already clips square corners to its 12px
   radius, but the first/last cell also carry an explicit inner radius so
   the rounding reads correctly even where repeatHeader reprints the row
   at the top of every subsequent page. */
thead th{
  background: linear-gradient(180deg, #F8FBFF, #EDF4FF);
  color: #0F274B;
  font-weight: 700; font-size: 14px;
  padding: var(--cv) var(--ch);
  text-align: right;
  border-inline: 0.5px solid var(--hair);
  border-block: 0.5px solid var(--hair);
  white-space: normal; overflow: visible; text-overflow: clip;
  line-height: 1.3; vertical-align: middle;
  height: var(--thh);   /* 52px */
}
thead th:first-child{ border-top-right-radius: 11px; }
thead th:last-child{ border-top-left-radius: 11px; }

/* Table body */
tbody td{
  padding: var(--cv) var(--ch);
  border: 0.5px solid var(--bd);
  text-align: right; vertical-align: middle;
  overflow-wrap: break-word; word-break: break-word;
  line-height: 1.4; height: var(--rh);   /* 38px */
}
tbody tr.alt td{ background: var(--alt); }

/* Absent row — entire row, not just the status cell (mirrors the on-screen
   .row-absent grid rows in index.css). Matches the .alt rule's specificity
   (tbody tr.CLASS td) and is declared after it so an absent row always wins
   over zebra striping. The first-child selector below targets the idx
   column (or first data column when showRowIndex is off) — the DOM-first
   column, which in this dir=rtl document renders at the table's
   rightmost/leading edge, so a negative inset offset draws the accent on
   that true leading edge. */
tbody tr.row-absent td{ background: #FEF2F2; }
tbody tr.row-absent td:first-child{ box-shadow: inset -4px 0 0 var(--dng); }

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
tr.totals td.t-label{ text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* Aggregate sums run wider than any single row's value (more digits, same
   unit-word suffix as the per-row formatter) — hold the value at the body's
   font-size rather than the row's 10pt bump, and tighten tracking slightly,
   so the wider figure still fits the exact column width shared with the
   header/body above (see the total-column colPx widening). Bold weight
   alone still reads as "total" without inflating the size. text-overflow
   is ellipsis (not the previous clip) purely as a last-resort safety net —
   the width/font changes are what actually prevent truncation in practice. */
tr.totals td.t-val{
  font-variant-numeric: tabular-nums; direction: ltr; text-align: center;
  font-size: 9pt; letter-spacing: -0.2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ════════════════════════════════════════════════════════════════════════════
   ④ SIGNATURE AREA  ─  the sign-off trail a real accounting document ends
   with (prepared / reviewed / approved), not just a page number. Three
   equal-width blocks, a plain rule for the physical signature to sit above —
   no card, no shadow, matching the rest of this ledger-style document.
   ════════════════════════════════════════════════════════════════════════════ */
.signature-area{
  display: flex; justify-content: space-between; gap: var(--sp6);
  margin-top: var(--sp7); page-break-inside: avoid; break-inside: avoid;
}
.sig-block{ flex: 1; text-align: center; position: relative; }
.sig-line{
  border-top: 1px solid var(--i3); margin-top: 40px; padding-top: 6px;
  font-size: 8pt; font-weight: 600; color: var(--i3);
}
.sig-stamp{
  position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%) rotate(-8deg);
  width: 64px; height: 64px; object-fit: contain; opacity: 0.85;
}

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

/* ── Large report (≥10 columns) ───────────────────────────────────────────── */
[data-cols="large"]{
  --ch  : 7px;    /* narrower cell padding to reclaim column space  */
  --cv  : 5px;    /* shorter vertical padding (print-optimized: was 6px) */
  --rh  : 32px;   /* compact rows (print-optimized: was 36px) — still one
                      full, comfortably-padded line at the unchanged 8.5pt
                      font; only applied AFTER header/metadata/margin trims */
  --thh : 40px;   /* compact header (print-optimized: was 48px)     */
}
[data-cols="large"] table  { font-size: 8.5pt; }
[data-cols="large"] thead th{ font-size: 8.5pt; }
</style>
</head>
<body>

  <!-- ── Document header — print-only, not the on-screen branding card.
       Gated by showHeaderFooter (Print Preview → Header/Footer) for
       printing onto pre-printed company letterhead stationery. ── -->
  ${showHeaderFooter ? `<div class="doc-header">
    <div class="dh-report">
      <div class="dh-title">${esc(fullTitle)}</div>
      ${meta.period ? `<div class="dh-period">${esc(meta.period)}</div>` : ''}
      ${meta.subtitle ? `<div class="dh-subtitle">${esc(meta.subtitle)}</div>` : ''}
    </div>
    <div class="dh-brand">
      ${logoHTML ? `<span class="dh-logo">${logoHTML}</span>` : ''}
      <div class="dh-brand-text">
        <div class="dh-brand-name">${esc(brand.name)}</div>
        ${brandSub ? `<div class="dh-brand-sub">${esc(brandSub)}</div>` : ''}
      </div>
    </div>
  </div>
  ${metaBarHTML}` : ''}

  ${kpiHTML}
  ${showHeaderFooter ? '<div class="dh-divider"></div>' : ''}

  <div class="table-wrap">
    <table>
      <thead><tr>${ths}</tr></thead>
      <tbody>${trs}${totalsRow}</tbody>
    </table>
  </div>

  ${signatureHTML}

  ${showHeaderFooter ? screenFooter : ''}
</body>
</html>`;
}

export default buildReportHTML;
