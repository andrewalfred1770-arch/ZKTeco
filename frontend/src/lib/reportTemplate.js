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
import { isAbsentRow, attendanceRowClass } from './gridDefaults.js';
import {
  tokensCSS, PAPER_SIZE_KEYWORDS, MARGIN_PRESETS, buildFooterLeft,
} from './printDesignSystem.js';
import { computeColumnWidths, selectPrintableColumns } from './columnLayoutEngine.js';

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

// Phase 25.1 (F5): must escape all 5 HTML-significant characters — this
// value is interpolated both into element text content AND into quoted HTML
// attributes (alt="...", src="...") elsewhere in this file. Escaping only
// &/</> left a `"` in an attribute value (e.g. company branding name/logo
// URL) free to close the attribute early and inject a new one.
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

// Status-column totals cell — only ever built for a column literally keyed
// 'status' that carries no `total` of its own (attendance_daily, movement).
// The status column is usually one of the narrower columns, so this shows
// ONLY the absence count — no stacked breakdown, no extra label text — the
// same single-number, same-class treatment as every other totals cell;
// the column's own header ("الحالة") already gives it context. `count` is
// computed once by the caller (rows.filter(isAbsentRow).length) and reused
// here and in the summary strip below — never recomputed twice.
function buildStatusTotalsCell(count) {
  return `<td class="num t-val">${westernDigits(count)}</td>`;
}

// Totals-row time values — fmtPenaltyUnits() (and any formatter following the
// same convention) renders a summed time total as "<number> <ساعة|ساعتان|
// ساعات>", e.g. "35 ساعات". On one line that reads as crowded, especially in
// portrait — this splits ONLY that literal "<number> <unit-word>" shape into
// number-over-unit for display; the summed value and its formatter are
// unchanged, this is purely how the already-computed string is laid out.
const TIME_TOTAL_RE = /^([\d.,٠-٩٫٬-]+)\s+(ساعة|ساعتان|ساعات)$/;
function buildTotalValueCell(formatted) {
  const m = TIME_TOTAL_RE.exec(String(formatted ?? ''));
  if (!m) return `<td class="num t-val">${esc(formatted)}</td>`;
  return `<td class="num t-val t-val-time">`
    + `<span class="t-num">${esc(m[1])}</span>`
    + `<span class="t-unit">${esc(m[2])}</span>`
    + `</td>`;
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

// Paper-size keywords and margin presets now live in printDesignSystem.js —
// the same source PrintPreviewModal.jsx reads for its on-screen page-box math,
// so the two can never drift out of sync the way two hand-copied constant
// tables could.

export function buildReportHTML(o = {}) {
  const {
    title = 'تقرير',
    columns: allColumns = [],
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
    // Ordered list of items to headline in the Enterprise Summary Strip
    // (rendered between the table and the signature area). Each entry is
    // either a column `key` string, or `{ key, label }` to override the
    // displayed label while still reusing that column's already-computed
    // total. Two sentinel keys are also accepted: '__absence' (the status
    // column's already-computed absent-row count) and '__count' (the
    // already-computed row count shown in the metadata bar). Every value
    // is read from the SAME computation the totals row below itself uses —
    // nothing here sums or calculates anything new. null (default) shows
    // every totaled column, in column order, plus the absence count when a
    // status column is present — a safe generic fallback for any caller
    // that hasn't curated a specific set.
    summaryKeys      = null,
    // KPI-only documents (e.g. the Monthly Attendance "طباعة الملخص" summary
    // print) have no per-row table at all — just the letterhead + `stats`
    // cards above. false omits the <table> entirely; every other section
    // (header, KPI cards, signatures, footer) is unaffected. Default true
    // keeps every existing caller byte-identical.
    showTable        = true,
  } = o;

  // ── Print Experience geometry ──────────────────────────────────────────────
  // Computed before column selection/widths below (rather than in its
  // original spot further down) because selectPrintableColumns() needs the
  // real printable page width — paper size × orientation × margins — to
  // decide which columns even fit before computeColumnWidths() sizes them.
  const isLand           = orientation === 'landscape';
  const pageSizeKeyword  = PAPER_SIZE_KEYWORDS[paperSize] || PAPER_SIZE_KEYWORDS.A4;
  const marginPreset     = MARGIN_PRESETS[margins] || MARGIN_PRESETS.normal;
  const scale             = Math.max(0.5, Math.min(1.5, (Number(scalePercent) || 100) / 100));
  // Vertical-only compaction for the single-employee monthly statement print
  // (EmployeeMonthlyStatementDrawer sets meta.compactVertical) — trims top/
  // bottom page margin and the letterhead's own internal vertical rhythm so
  // the header/KPI stack doesn't push the table unnecessarily far down the
  // page. Scoped to this one caller via the meta flag rather than
  // orientation/report-type, since other portrait reports (Dashboard,
  // AttendanceDailyPage) share this same template and must render
  // byte-identical to before. Horizontal margins (h) are untouched.
  const compact           = !!meta.compactVertical;
  const pageMarginTopMM   = compact ? Math.max(marginPreset.v - 3, 6) : marginPreset.v;
  const pageMarginBotMM   = compact ? Math.max(marginPreset.v - 2, 7) : marginPreset.v;

  // ── Column selection — hide, don't silently compress ───────────────────────
  // A report whose columns' own priority floors (see columnLayoutEngine.js)
  // don't all fit this page gets low-priority (then medium-priority) columns
  // dropped from the print entirely — never a column rendered at a
  // near-zero/0px width. This runs BEFORE colPx/computeColumnWidths below, so
  // every remaining computation (widths, header cells, body cells, totals,
  // summary strip, density) only ever sees the columns that actually print.
  // Column set, order, and every calculation for the columns that DO print
  // are untouched — this only ever removes a column outright, never resizes
  // or reorders one.
  const keepMask = selectPrintableColumns({
    columns: allColumns, showRowIndex, paperSize, marginPreset, isLandscape: isLand, scale,
  });
  const columns = allColumns.filter((_, i) => keepMask[i]);

  // ── Column widths ────────────────────────────────────────────────────────
  // Total-bearing columns render an aggregate SUM in the footer row, which is
  // systematically wider than any single row's value (more digits, but the
  // same formatter/unit-suffix, e.g. " ساعات") — widen just those columns a
  // bit so the footer sum has room to fit the width its own header/body
  // cells already share, instead of clipping against a width only ever
  // tuned for per-row content. header/body/totals all read from this same
  // colPx array (fed into computeColumnWidths() below), so they stay
  // pixel-identical to each other either way.
  const idxPx = showRowIndex ? 60 : 0;
  const colPx = columns.map(c => parseThWidth(c.thStyle) + (c.total ? 16 : 0));

  // ── Brand / dates ─────────────────────────────────────────────────────────
  // Only the official company logo image — no standalone monogram/"P" mark
  // fallback. When no logo is configured, the tile is simply omitted (see
  // dh-logo rendering below) and the company name/tagline text stands alone.
  const logoHTML = brand.logoUrl
    ? `<img src="${esc(brand.logoUrl)}" alt="${esc(brand.name)}" width="41" height="41"
         style="width:100%;height:100%;object-fit:contain;" />`
    : '';

  // ── Custom print letterhead banner (بيانات الشركة → إعدادات الطباعة →
  // رأس صفحة الطباعة / نص رأس الطباعة) — previously collected but never
  // rendered anywhere. Renders only when the user has actually set one of
  // the two fields, so a report with neither configured looks byte-identical
  // to before this existed. Width/height attributes are set from the field's
  // own documented recommended size (1200×300 in Company Settings) purely as
  // an intrinsic-size hint so the browser reserves the right box before the
  // image loads — actual display size is governed by the CSS below.
  const printHeaderHTML = (brand.printHeaderUrl || brand.printHeaderText)
    ? `<div class="doc-print-header">
        ${brand.printHeaderUrl ? `<img src="${esc(brand.printHeaderUrl)}" alt="" width="1200" height="300" />` : ''}
        ${brand.printHeaderText ? `<div class="dph-text">${esc(brand.printHeaderText)}</div>` : ''}
      </div>`
    : '';

  const count       = westernDigits(rows.length);
  const generatedBy = meta.generatedBy || '';

  // ── Footer identity — brings the previously-unused company contact/footer
  // settings (بيانات الشركة → إعدادات الطباعة) onto every printed page
  // instead of just the bare brand name. Falls back gracefully when the
  // user hasn't filled any field in yet. Built by the same shared helper
  // every print surface (table reports, payslips) now uses, so the footer
  // reads identically everywhere.
  const footerLeft = buildFooterLeft(brand, meta);

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
        ${showStamp && brand.stampUrl ? `<img class="sig-stamp" src="${esc(brand.stampUrl)}" alt="" width="64" height="64" />` : ''}
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

  // ── Column widths — responsive allocation engine ───────────────────────────
  // `table-layout:fixed` derives every row's column widths from the header
  // row's own `style="width:…"`, so this is the one place that needs to
  // reconcile a column's AUTHORED width (a designer's landscape-tuned guess)
  // against the page it's actually printing on. computeColumnWidths()
  // (columnLayoutEngine.js) runs the same priority-floor allocation for
  // BOTH orientations — not just portrait — using the real printable width
  // for this paperSize/orientation/margins/scale, so:
  //   - landscape's extra room is still respected (authored proportions win
  //     whenever nobody's under their floor), and
  //   - a report with many columns can no longer silently cross a
  //     legibility floor in landscape either, the way flat pct(px) did.
  // Column set, order, and every calculation are untouched — this only
  // changes how wide each already-existing column is drawn.
  const { idxWidthPct, colWidthPct } = computeColumnWidths({
    columns, showRowIndex, idxPx, colPx, paperSize, marginPreset, isLandscape: isLand, scale,
  });

  // ── Table header cells ────────────────────────────────────────────────────
  const ths = (showRowIndex ? `<th class="idx" style="width:${idxWidthPct}">#</th>` : '')
    + columns.map((c, i) => `<th style="width:${colWidthPct[i]}">${esc(c.header)}</th>`).join('');

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
    // Phase 19: reuses the SAME shared classifier the live grids use
    // (gridDefaults.js#attendanceRowClass) instead of a second, hand-rolled
    // absent-only check — print now shows the same official-holiday
    // distinction the grid already does, not just plain vs. absent.
    // attendanceRowClass can also emit row-monitored/row-weekend/row-late/
    // row-overtime; this stylesheet defines a rule for none of those (only
    // row-absent and row-holiday, below), so their presence in the class
    // list here is a harmless no-op, not a new print behavior.
    const rowCls = [i % 2 === 1 ? 'alt' : '', attendanceRowClass({ data: row })].filter(Boolean).join(' ');
    return `<tr class="${rowCls}">${showRowIndex ? `<td class="idx">${westernDigits(i + 1)}</td>` : ''}${cells}</tr>`;
  }).join('');

  // ── Shared totals computation — the totals row AND the summary strip below
  // both read from this ONE pass; nothing is summed or calculated twice, and
  // nothing here is a new calculation — every value uses the exact same
  // sumKey()/format() a caller's column definition already specifies. ───────
  const hasTotals   = columns.some(c => c.total);
  const hasStatusCol = columns.some(c => c.key === 'status');
  const absentRowsForStatus = hasStatusCol ? rows.filter(isAbsentRow) : [];
  const absentCount  = absentRowsForStatus.length;
  // Absence-type breakdown for the summary strip's grouped absence item —
  // reuses the exact same `absenceType` field AbsenceTypeModal already
  // writes and the grid already reads elsewhere; a category is counted only
  // when rows actually carry it, never invented for a report that doesn't
  // use it.
  const absenceWithoutPermission = absentRowsForStatus.filter(r => r.absenceType === 'without_permission').length;
  const absenceWithPermission    = absentRowsForStatus.filter(r => r.absenceType === 'with_permission').length;
  const columnTotals = columns.filter(c => c.total).map(c => {
    let v;
    if (c.total === 'sum') v = sumKey(rows, c.key);
    else if (typeof c.total === 'function') v = c.total(rows);
    else v = c.total;
    return { column: c, formatted: c.format ? c.format(v, { __total: true }) : v };
  });
  const findColumnTotal = key => columnTotals.find(ct => ct.column.key === key);

  // ── Totals row — a plain table footer. The "الإجمالي" label is a single,
  // fixed cell — never more than the row-index column plus (when it has no
  // total of its own) the very first data column, merged via colspan purely
  // so a short label never truncates against a narrow 48–65px code column.
  // It always sits at the row's leading edge, never reflows into the middle
  // of the row, and every other column — total or not — keeps its own
  // individual cell in its own position, exactly like the header/body rows
  // above it. ─────────────────────────────────────────────────────────────
  let totalsRow = '';
  if (hasTotals && rows.length) {
    const firstColHasTotal = !!(columns[0] && columns[0].total);
    // Edge case: no row-index column AND the first data column has its own
    // total means there's normally nowhere left for the label to sit — the
    // label must still get a cell, so in this one case it claims the first
    // column instead of that column showing its own total, rather than the
    // "الإجمالي" label vanishing from the row entirely.
    const labelNeedsFirstCol = !showRowIndex && firstColHasTotal;
    const labelUsesFirstCol  = firstColHasTotal && !labelNeedsFirstCol;
    const labelSpan = (showRowIndex ? 1 : 0) + (labelUsesFirstCol ? 0 : 1);
    const bodyCols  = labelUsesFirstCol ? columns : columns.slice(1);

    // A column that genuinely has no total (e.g. payroll's hourlyRate, a
    // rate rather than a summable figure) still gets its own cell — never
    // merged away, so every numeric total stays under its own column
    // exactly like the header above it — just rendered as a muted dash
    // instead of a bare empty cell, so it reads as "not applicable" rather
    // than as a rendering gap.
    const valueCells = bodyCols.map(c => {
      if (c.key === 'status' && !c.total) return buildStatusTotalsCell(absentCount);
      if (!c.total) return `<td class="t-blank">—</td>`;
      return buildTotalValueCell(findColumnTotal(c.key).formatted);
    }).join('');

    const labelCell = labelSpan > 0
      ? `<td class="t-label" colspan="${labelSpan}">الإجمالي</td>`
      : '';

    totalsRow = `<tr class="totals">${labelCell}${valueCells}</tr>`;
  }

  // ── Enterprise Summary Strip — a single flat, premium band between the
  // table and the signature area highlighting a handful of the SAME totals
  // computed above. `summaryKeys` (see param doc) lets a report-type-aware
  // caller (PrintPreviewModal.jsx) curate which 3–4 totals matter most for
  // that report; any caller that doesn't pass it gets every totaled column
  // plus the absence count — never an invented figure, never a duplicate
  // calculation. Gated identically to the totals row: nothing to summarize
  // when there's nothing to total. ──────────────────────────────────────
  let summaryStripHTML = '';
  if (hasTotals && rows.length) {
    const ssItem = (label, value, subHTML = '') =>
      `<div class="ss-item"><span class="ss-label">${esc(label)}</span><span class="ss-value">${esc(value)}</span>${subHTML}</div>`;
    const keyList = (summaryKeys && summaryKeys.length) ? summaryKeys : [
      ...(hasStatusCol ? ['__absence'] : []),
      ...columnTotals.map(ct => ct.column.key),
    ];
    const items = keyList.map(entry => {
      const key = typeof entry === 'string' ? entry : entry.key;
      const overrideLabel = typeof entry === 'string' ? null : entry.label;
      if (key === '__absence') {
        if (!hasStatusCol) return '';
        // One grouped block — total absence figure as the item's headline
        // value, the with/without-permission split (only when that category
        // actually has rows) as small caption lines underneath — never
        // separate KPI cards, never a category that doesn't exist in the
        // data.
        const subLines = [
          absenceWithoutPermission > 0 ? `<span class="ss-sub-line">بدون إذن: ${westernDigits(absenceWithoutPermission)} يوم</span>` : '',
          absenceWithPermission > 0    ? `<span class="ss-sub-line">بإذن: ${westernDigits(absenceWithPermission)} يوم</span>`       : '',
        ].filter(Boolean);
        const subHTML = subLines.length ? `<div class="ss-sub">${subLines.join('')}</div>` : '';
        return ssItem(overrideLabel || 'إجمالي الغياب', `${westernDigits(absentCount)} يوم`, subHTML);
      }
      if (key === '__count') return ssItem(overrideLabel || 'عدد السجلات', count);
      const found = findColumnTotal(key);
      if (!found) return '';
      return ssItem(overrideLabel || found.column.header, found.formatted);
    }).filter(Boolean);
    if (items.length) summaryStripHTML = `<div class="summary-strip">${items.join('')}</div>`;
  }

  // ── Screen-only footer (hidden in @media print) ───────────────────────────
  const screenFooter = `<div class="screen-foot">
    <span>${esc(footerLeft)}</span>
    ${generatedBy ? `<span>تم إنشاء التقرير بواسطة : ${esc(generatedBy)}</span>` : '<span></span>'}
    <span class="sf-page">صفحة <span id="pn">1</span></span>
  </div>`;

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl" data-cols="${density}" data-orientation="${isLand ? 'landscape' : 'portrait'}" data-compact="${compact ? '1' : ''}">
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
${tokensCSS()}

/* ── Page ─────────────────────────────────────────────────────────────────── */
@page{
  size: ${pageSizeKeyword} ${isLand ? 'landscape' : 'portrait'};
  /* Print-optimized default ("normal" preset, 10mm/8mm): far more than the
     7pt page-number footnote needs, but comfortably inside every printer's
     safe-print area. "narrow"/"wide" (Print Preview → Margins) scale this
     same rule — nothing here is hardcoded anymore. Top/bottom only trim
     further under compact mode (see pageMarginTopMM/pageMarginBotMM above) —
     horizontal (h) margin is always the untouched preset value. */
  margin: ${pageMarginTopMM}mm ${marginPreset.h}mm ${pageMarginBotMM}mm ${marginPreset.h}mm;
  /* Document footer — repeats on every printed page (unlike the screen-only
     .screen-foot below, which only ever occupied page 1's flow). This is
     the ERP-document convention: company identity anchored bottom-left,
     pagination bottom-right, on every sheet. Tied to showHeaderFooter — off
     when printing onto pre-printed letterhead stationery that already
     carries this information. This shared template is not used by the
     salary-card print output (CompactSalarySheet.jsx owns its own print
     CSS and footer scoping) — generic reports keep their footer. */
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
/* Custom print letterhead banner (بيانات الشركة → إعدادات الطباعة) — an
   optional strip above the masthead, only present when the user has
   configured one; absent otherwise, so it never affects the default
   letterhead rhythm below it. */
.doc-print-header{ margin-bottom: var(--rhythm); page-break-inside: avoid; break-inside: avoid; }
.doc-print-header img{ display: block; margin: 0 auto 4px; width: 100%; height: auto; max-height: 70px; object-fit: contain; }
.dph-text{ text-align: center; font-size: 11px; color: var(--i3); font-weight: 600; line-height: 1.3; }

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
  width: 41px; height: 41px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  overflow: hidden; line-height: 1;
}
.dh-brand-text{ direction: ltr; text-align: left; line-height: 1.15; }
.dh-brand-name{ font-size: 19px; font-weight: 700; color: #0F274B; white-space: nowrap; }
.dh-brand-sub{ font-size: 13px; color: var(--i3); font-weight: 500; margin-top: 0; white-space: nowrap; }

/* No min-width:0 here on purpose — that override was what let the flex
   item shrink below the title's own content width, which is what forced
   the old ellipsis-truncation below. Dropping it means the title box
   claims its full natural width (still bounded by the space dh-brand's
   fixed-size block leaves it, via the header's justify-content:space-between
   — this doesn't change the header layout, it just stops pre-shrinking the
   title area smaller than it needs to be). */
.dh-report{ flex: 1; direction: rtl; text-align: right; }
.dh-title{
  font-size: 32px; font-weight: 800; color: #0F274B; line-height: 1.25;
  letter-spacing: normal;
  /* Single line, but never clipped/truncated — the old overflow:hidden +
     text-overflow:ellipsis silently cut long titles short; a real
     enterprise document header shows the full title. line-height:1.25
     (not 1) is what keeps tall Arabic letterforms/diacritics from being
     clipped top or bottom. */
  white-space: nowrap; overflow: visible;
  margin-bottom: 5px;
}
.dh-period{ font-size: 18px; font-weight: 600; color: #0F274B; margin-top: 0; line-height: 1.25; }
.dh-subtitle{ font-size: 13px; color: var(--i3); font-weight: 500; margin-top: 0; line-height: 1.15; }

/* ② Metadata cards — premium info blocks: white body, soft border, 10px
   radius, very soft shadow, equal (fixed 48px) height, icon in the accent
   color, bold value. */
.dh-meta-bar{
  display: flex; direction: rtl; align-items: stretch; gap: 10px;
  margin-bottom: var(--rhythm);
  page-break-inside: avoid; break-inside: avoid;
}
.dh-meta-card{
  flex: 1 1 0; min-width: 0; height: 55px;
  display: flex; flex-direction: column; justify-content: center; gap: 3px;
  padding: 0 12px;
  background: #fff;
  border: 1px solid var(--card-bd);
  border-radius: 10px;
  box-shadow: var(--card-shadow);
}
.dh-meta-top{ display: flex; align-items: center; gap: 5px; color: #2563EB; line-height: 1; }
.dh-meta-icon{ display: flex; flex-shrink: 0; line-height: 1; }
.dh-meta-icon svg{ display: block; }
.dh-meta-label{ font-size: 13px; color: var(--i3); font-weight: 600; line-height: 1; }
.dh-meta-value{ font-size: 17px; color: #0F274B; font-weight: 700; line-height: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ③ Statistics row — premium KPI cards: white body, soft border, rounded
   corners, soft shadow, a 4px color accent on the TOP edge only. Equal
   width, equal (fixed 56px) height. */
.dh-kpis{
  display: flex; direction: rtl; align-items: stretch; gap: 10px;
  margin-bottom: var(--rhythm);
  page-break-inside: avoid; break-inside: avoid;
}
.dh-kpi{
  flex: 1 1 0; min-width: 0; height: 64px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  padding: 0 8px;
  background: #fff;
  border: 1px solid var(--card-bd);
  border-radius: 8px;
  border-top: 4px solid var(--kpi-accent, #2563EB);
  box-shadow: var(--card-shadow);
  page-break-inside: avoid;
}
.dh-kpi-value{ font-size: 24px; font-weight: 700; color: #0F274B; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -0.2px; }
.dh-kpi-label{ font-size: 13px; font-weight: 500; color: var(--i3); line-height: 1.2; white-space: nowrap; }

.dh-kpi.c-blue  { --kpi-accent: #2563EB; }
.dh-kpi.c-green { --kpi-accent: #16A34A; }
.dh-kpi.c-red   { --kpi-accent: #DC2626; }
.dh-kpi.c-amber { --kpi-accent: #F97316; }
.dh-kpi.c-purple{ --kpi-accent: #7C3AED; }
.dh-kpi.c-teal  { --kpi-accent: #0D9488; }

/* ④ The ONLY divider in the header — closes it, then the table begins
   right after with only a small gap. No double rule, no heavy border. */
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
  white-space: normal; overflow: visible; text-overflow: clip; overflow-wrap: break-word;
  line-height: 1.3; vertical-align: middle;
  min-height: var(--thh);   /* 52px — a floor, not a cap: a header that wraps to a
                                second line grows the row instead of overlapping it */
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

/* Phase 19 (corrected scope): official-holiday row tint only — previously
   this stylesheet had NO row-level background for holiday at all (only the
   status-text-color rule further below), so a printed attendance report
   showed an official holiday with no visual distinction from an ordinary
   working day. Weekly off / approved leave intentionally get NO new print
   styling here — the corrected requirement keeps their existing (unchanged)
   presentation, only official holiday (data.isHoliday, an explicit
   Holiday-table match) becomes blue. */
tbody tr.row-holiday td{ background: #DBEAFE; }
tbody tr.row-holiday td:first-child{ box-shadow: inset -4px 0 0 var(--a); }

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

/* Totals row — a flat, natural extension of the table body (same family of
   cell as every row above it, not a separate raised/recessed panel): one
   crisp navy rule on top is the only thing that marks it as the document's
   authoritative summary line — no inset shadow, no heavier fill than the
   table already uses elsewhere, matching how SAP/Dynamics/Oracle Fusion
   ledger totals rows sit flush with the table instead of floating over it. */
tr.totals td{
  background: var(--soft-strong);
  border-top: 1.5px solid var(--p); border-bottom: none;
  border-inline: 0.5px solid var(--bd2);
  padding: var(--cv) var(--ch); height: 40px; vertical-align: middle;
}
/* Typographic hierarchy: the label names the row, the numbers ARE the row —
   so the label reads clearly but stays visually quieter (smaller, navy but
   not the heaviest weight in the row) while every real total is the
   largest/boldest text on the line, the one thing the eye is meant to land
   on when scanning down a page of these. Colspan-merged (see totalsRow
   build above) so "الإجمالي" always has room and never truncates. */
tr.totals td.t-label{
  text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  font-size: 12.5px; font-weight: 700; color: var(--p); letter-spacing: 0.1px;
}
/* Aggregate sums run wider than any single row's value (more digits, same
   unit-word suffix as the per-row formatter) — the wider figure still fits
   the exact column width shared with the header/body above (see the
   total-column colPx widening). The largest, boldest text in the row —
   this is the visual focus the totals row exists for. text-overflow is
   ellipsis purely as a last-resort safety net — the width/font sizing is
   what actually prevents truncation in practice. */
tr.totals td.t-val{
  font-variant-numeric: tabular-nums; direction: ltr; text-align: center;
  font-size: 15.5px; font-weight: 800; color: var(--p); letter-spacing: -0.2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* Time totals ("35 ساعات") — number over unit instead of one crowded line.
   Stacked inside the SAME fixed row height as every other totals cell
   (tr.totals td height above), centered both ways, no wrap inside the
   number itself. Presentation-only split of the already-formatted string —
   see buildTotalValueCell() in reportTemplate.js. */
tr.totals td.t-val-time{
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 0; line-height: 1.1; white-space: nowrap;
}
tr.totals td.t-val-time .t-num{
  font-variant-numeric: tabular-nums; direction: ltr;
  font-size: 15.5px; font-weight: 800; color: var(--p); letter-spacing: -0.2px;
}
tr.totals td.t-val-time .t-unit{
  font-size: 10px; font-weight: 700; color: var(--i4); letter-spacing: 0.1px;
}
/* A column that genuinely carries no total (e.g. payroll's hourlyRate, a
   rate rather than a summable figure) still gets its own cell — never
   merged away, so column alignment with the header above never breaks —
   just rendered as a small muted dash instead of a bare empty cell, so a
   run of these reads as "not applicable here" rather than a visual gap. */
tr.totals td.t-blank{
  text-align: center; color: var(--i4); font-weight: 400; font-size: 9pt;
}

/* Totals row — portrait responsiveness. A portrait page has meaningfully
   less usable width than landscape (the same fixed-pixel column widths
   above now occupy a narrower printable area), so the exact font-size/
   padding that fits comfortably in landscape can crowd — and, via the
   ellipsis safety nets above, visibly clip — totals-row text in portrait.
   This block touches ONLY tr.totals (not the table header/body, not any
   other row) and only shrinks typography/padding enough that every total
   keeps fitting cleanly inside its own column — same columns, same order,
   same values, same colspan on the label cell, just sized for the page
   it's actually printing on. */
[data-orientation="portrait"] tr.totals td{
  padding: 6px 4px; height: 36px;
}
[data-orientation="portrait"] tr.totals td.t-label{
  font-size: 11px;
}
[data-orientation="portrait"] tr.totals td.t-val{
  font-size: 12px;
}
[data-orientation="portrait"] tr.totals td.t-val-time .t-num{
  font-size: 12px;
}
[data-orientation="portrait"] tr.totals td.t-val-time .t-unit{
  font-size: 11px;
}
[data-orientation="portrait"] tr.totals td.t-blank{
  font-size: 11px;
}

/* ════════════════════════════════════════════════════════════════════════════
   ENTERPRISE SUMMARY STRIP — one flat, elegant band between the table and
   the signature area. No cards, no icons, no color, no gradients: a single
   white surface with a hairline border and a very soft shadow, holding a
   handful of label/value pairs separated by light vertical rules — the
   SAP/Oracle Fusion/Dynamics 365 convention for "the numbers that matter
   most," not a dashboard. Every value is read straight from the totals
   already computed above it (see summaryStripHTML build) — nothing here
   sums or calculates anything.
   ════════════════════════════════════════════════════════════════════════════ */
.summary-strip{
  display: flex; flex-wrap: wrap; align-items: stretch;
  background: #fff; border: 1px solid #E6ECF5; border-radius: 12px;
  box-shadow: var(--card-shadow);
  padding: 16px 24px;
  margin-top: var(--sg); margin-bottom: 0;
  page-break-inside: avoid; break-inside: avoid;
}
.ss-item{
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 4px; flex: 1 1 0; min-width: 130px; padding: 0 20px;
  border-inline-start: 1px solid #EEF1F6;
}
.ss-item:first-child{ border-inline-start: none; padding-inline-start: 0; }
.ss-item:last-child{ padding-inline-end: 0; }
.ss-label{ font-size: 12px; font-weight: 500; color: #6B7280; white-space: nowrap; }
.ss-value{
  font-size: 22px; font-weight: 800; color: var(--p);
  font-variant-numeric: tabular-nums; direction: ltr; unicode-bidi: plaintext;
  white-space: nowrap; letter-spacing: -0.2px;
}
/* Absence breakdown — small caption lines under the headline value, part of
   the SAME grouped item (see summaryStripHTML build), never separate cards. */
.ss-sub{ display: flex; flex-direction: column; align-items: center; gap: 1px; margin-top: 1px; }
.ss-sub-line{ font-size: 10.5px; font-weight: 600; color: #94A3B8; white-space: nowrap; }

/* ════════════════════════════════════════════════════════════════════════════
   ④ SIGNATURE AREA  ─  the sign-off trail a real accounting document ends
   with (prepared / reviewed / approved), not just a page number. Three
   equal-width blocks, a plain rule for the physical signature to sit above —
   no card, no shadow, matching the rest of this ledger-style document.
   ════════════════════════════════════════════════════════════════════════════ */
.signature-area{
  display: flex; justify-content: space-between; gap: var(--sp6);
  margin-top: var(--sp5); page-break-inside: avoid; break-inside: avoid;
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

/* ════════════════════════════════════════════════════════════════════════════
   PORTRAIT RESPONSIVENESS — a dedicated, narrower-page pass over table
   typography/padding. The header/body column WIDTHS are already
   recalculated for portrait above (see computeColumnWidths() in
   columnLayoutEngine.js); this is the matching typography half of that
   same fix — a modest, orientation-only
   size/padding trim (never a transform/scale()) so the already-protected
   minimum column widths have text that comfortably fits them. Landscape is
   untouched: none of these selectors match without data-orientation="portrait".
   Font floors are hard requirements, not tuning targets: body text can never
   go below 11px (8.5pt) and header text can never go below 12px (9pt),
   regardless of column count — so the [data-cols="large"] portrait overrides
   below hold at the SAME floor rather than shrinking further, unlike the
   (landscape-only) [data-cols="large"] block above this one. Row height is
   unaffected here (still --rh from the density block above, 32–44px — well
   above the 24px floor), so this section only ever touches font-size/padding. */
[data-orientation="portrait"] table{ font-size: 8.5pt; }
[data-orientation="portrait"] thead th{ font-size: 9pt; padding-inline: 4px; line-height: 1.25; }
[data-orientation="portrait"] tbody td{ padding-inline: 4px; }
[data-orientation="portrait"][data-cols="large"] thead th{ font-size: 9pt; }
[data-orientation="portrait"][data-cols="large"] table{ font-size: 8.5pt; }
/* Row-index (#) column reads at a deliberately smaller, muted size in
   landscape (th.idx/td.idx above) — in portrait that same 7pt (~9.3px) falls
   under the 11px body-text floor, so it gets its own floor-compliant bump
   here without touching every other muted/secondary text style. */
[data-orientation="portrait"] th.idx, [data-orientation="portrait"] td.idx{ font-size: 11px; }

/* ════════════════════════════════════════════════════════════════════════════
   VERTICAL COMPACTION — single-employee monthly statement print only
   (meta.compactVertical, set by EmployeeMonthlyStatementDrawer.jsx; see the
   compact const above). Touches ONLY box heights / margins / gaps of the
   header, metadata cards, and KPI cards — never a font-size, never a table
   row/column rule, never horizontal spacing. Every value below still leaves
   each card's own (unchanged) text comfortably centered — the height drop
   is surplus padding, not a squeeze against the text. Landscape/other
   report types never carry data-compact="1", so this block is a no-op for
   every other caller of buildReportHTML. ════════════════════════════════════════ */
[data-compact="1"]{
  --rhythm: 6px; /* was 9px — gap between the 4 letterhead sections */
}
[data-compact="1"] .dh-title{ margin-bottom: 3px; } /* was 5px */
[data-compact="1"] .dh-meta-card{ height: 44px; }   /* was 55px */
[data-compact="1"] .dh-kpi{ height: 50px; }         /* was 64px */
[data-compact="1"] .dh-divider{ margin-bottom: 4px; } /* was 6px */
</style>
</head>
<body>

  <!-- ── Document header — print-only, not the on-screen branding card.
       Gated by showHeaderFooter (Print Preview → Header/Footer) for
       printing onto pre-printed company letterhead stationery. ── -->
  ${showHeaderFooter ? `${printHeaderHTML}<div class="doc-header">
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

  ${showTable ? `<div class="table-wrap">
    <table>
      <thead><tr>${ths}</tr></thead>
      <tbody>${trs}${totalsRow}</tbody>
    </table>
  </div>` : ''}

  ${showTable ? summaryStripHTML : ''}

  ${signatureHTML}

  ${showHeaderFooter ? screenFooter : ''}
</body>
</html>`;
}

export default buildReportHTML;
