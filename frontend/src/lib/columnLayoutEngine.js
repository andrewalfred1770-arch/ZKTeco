/**
 * columnLayoutEngine.js — PETSHROW responsive print column allocation engine.
 *
 * reportTemplate.js renders every table with `table-layout:fixed`, so the
 * header row's own `style="width:…"` is the ONLY thing that decides every
 * column's width — for the header cell AND every body/totals cell beneath
 * it. Before this module existed, that width came straight from each
 * column's authored `thStyle` (a designer's landscape-tuned guess, e.g.
 * "width:92px"), converted to a raw percentage of the columns' own pixel
 * sum. That guess never checked itself against the page it was actually
 * printing on:
 *   - In landscape, wide pages usually absorbed the slack, but nothing
 *     stopped a legibility floor being crossed on an 11-column report.
 *   - In portrait, the exact same proportions squeezed into ~35% less
 *     width, and low-priority columns (#, code) could steal more of that
 *     narrow budget than a screen-critical column (Date, Employee Name)
 *     was left with — producing clipped dates and crowded names.
 *
 * This module replaces that guess with a real allocation pass, run for
 * BOTH orientations from the same inputs (paper size, margins, scale,
 * column set, RTL is inherent — table stays `dir` on <html>): every column
 * is assigned a legibility-floor minimum width by CONTENT PRIORITY (not
 * just "narrower is safer"), the authored widths are then distributed
 * proportionally within whatever budget remains after every floor is
 * honored, and the whole row is renormalized back to exactly 100% — so the
 * generated table can never exceed the printable page width, and a
 * high-priority column can never be squeezed thinner than its floor by a
 * low-priority one still holding onto its guessed width.
 */
import { PAPER_MM, MM_TO_PX } from './printDesignSystem.js';

// ── Column priority classification ──────────────────────────────────────
// Keyed off the column's data `key` (falls back to its header text) — every
// REPORT_COLUMNS preset in PrintPreviewModal.jsx already uses stable,
// descriptive keys (employeeName, employee.name, department, date, checkIn,
// status, employeeCode, dayNum, …), so no report needs to opt in explicitly.
// A caller can still override by passing an explicit `priority` on the
// column definition ('high' | 'medium' | 'low') when a report's own
// semantics don't match the generic pattern below.
// NOTE: these must stay precise, not just "contains a related word" — e.g. a
// loose /name/i would also match the movement report's `dayName` ("اليوم" /
// Day, spec'd as MEDIUM priority) since "dayName" itself ends in "Name".
// Only match the identity/date fields the spec calls out, never a field
// that merely shares a substring with one.
const HIGH_PATTERNS = [/employeename/i, /^name$/i, /\.name$/i, /department/i, /^date$/i, /workdate/i];
const LOW_PATTERNS  = [/code$/i, /^id$/i, /^#$/i, /^daynum$/i];

function classifyPriority(col) {
  if (col.priority === 'high' || col.priority === 'medium' || col.priority === 'low') return col.priority;
  const key = col.key || '';
  const header = col.header || '';
  if (LOW_PATTERNS.some(re => re.test(key) || re.test(header))) return 'low';
  if (HIGH_PATTERNS.some(re => re.test(key) || re.test(header))) return 'high';
  return 'medium';
}

// Legibility-floor minimums (px, at 100% scale) — the width below which the
// column's own content class becomes unreadable at this template's print
// font sizes:
//   high   — a full employee name / department name / DD/MM/YYYY date must
//            never wrap or clip.
//   medium — check-in/out times, status labels, day names: shorter content,
//            still needs room to stay on one line.
//   low    — row index, short codes: a handful of digits/characters.
const PRIORITY_MIN_PX = { high: 95, medium: 66, low: 40 };

// A column's floor is normally just its tier's blanket PRIORITY_MIN_PX — a
// reasonable default when 'high' means "a full name/department/date". But a
// tier is a PRINT-ORDER priority ("must stay visible"), not a content-width
// class — a report can have a narrow 'high' column (an employee code, a
// 2-digit day count) that would otherwise be forced into the same 95px floor
// as a full name, wasting budget other columns need. `minPx` on a column def
// overrides its tier's blanket floor with the actual minimum that column's
// own content needs, same override precedent as `priority` above.
function resolveMinPx(col, tier) {
  return typeof col.minPx === 'number' ? col.minPx : PRIORITY_MIN_PX[tier];
}

/**
 * Decide which columns actually get PRINTED on this page, before any width
 * is computed. computeColumnWidths() below can honor every priority floor
 * right up until the floors themselves no longer fit the page (minsSum >
 * pagePx) — past that point its overflow branch fills tiers strictly
 * high→medium→low, and if a lower tier's own floor-share arithmetic runs
 * it out of remaining budget entirely, that tier is left at 0px: a column
 * that's technically still "in" the table but invisible, still occupying a
 * header cell and body cells with no readable content — a subtler version
 * of the exact "compressed column" failure this engine exists to prevent.
 * This pass runs first and removes columns outright instead of letting
 * them collapse to 0: starting from the lowest priority tier, it drops one
 * column at a time (rightmost/last first — an arbitrary but stable
 * tie-break) until every column still in the report can be given its own
 * priority floor by computeColumnWidths(), never touching 'high' tier
 * columns. A report that still doesn't fit after every 'low' and 'medium'
 * column is gone (i.e. even the 'high' tier alone exceeds the page) is left
 * as-is — computeColumnWidths()'s existing proportional squeeze is the
 * correct last-resort behavior for that edge case, not further hiding.
 *
 * @param {Object}  o
 * @param {Array}   o.columns       same column defs computeColumnWidths() takes
 * @param {boolean} o.showRowIndex
 * @param {string}  o.paperSize
 * @param {Object}  o.marginPreset
 * @param {boolean} o.isLandscape
 * @param {number}  o.scale
 * @returns {boolean[]} keep mask, one entry per `columns` (true = print it)
 */
export function selectPrintableColumns({
  columns, showRowIndex, paperSize, marginPreset, isLandscape, scale = 1,
}) {
  const priors  = columns.map(classifyPriority);
  const scaleMul = Math.max(0.85, Math.min(1.25, scale));
  const mins    = columns.map((c, i) => resolveMinPx(c, priors[i]) * scaleMul);
  const idxMin  = showRowIndex ? PRIORITY_MIN_PX.low * scaleMul : 0;

  const paper       = PAPER_MM[paperSize] || PAPER_MM.A4;
  const fullWmm     = isLandscape ? paper.h : paper.w;
  const printableMm = Math.max(1, fullWmm - 2 * marginPreset.h);
  const pagePx      = printableMm * MM_TO_PX;

  const keep = columns.map(() => true);
  const sumMins = () => idxMin + mins.reduce((s, m, i) => s + (keep[i] ? m : 0), 0);

  for (const tier of ['low', 'medium']) {
    while (sumMins() > pagePx) {
      let dropIdx = -1;
      for (let i = columns.length - 1; i >= 0; i--) {
        if (keep[i] && priors[i] === tier) { dropIdx = i; break; }
      }
      if (dropIdx === -1) break; // nothing left in this tier — move to the next
      keep[dropIdx] = false;
    }
    if (sumMins() <= pagePx) break;
  }

  return keep;
}

/**
 * Compute each column's final width as a percentage string, guaranteed to
 * (a) sum to exactly 100% and (b) never place a column below its
 * priority-scaled legibility floor while ANY slack remains in the row to
 * take from lower-priority columns first.
 *
 * @param {Object}   o
 * @param {Array}    o.columns        report column defs (same shape buildReportHTML takes)
 * @param {boolean}  o.showRowIndex
 * @param {number}   o.idxPx          authored row-index column width (px)
 * @param {number[]} o.colPx          authored per-column width (px), same order as `columns`
 * @param {string}   o.paperSize      'A4' | 'Letter' | 'Legal'
 * @param {Object}   o.marginPreset   { v, h } mm, from printDesignSystem.MARGIN_PRESETS
 * @param {boolean}  o.isLandscape
 * @param {number}   o.scale          content scale factor (scalePercent / 100), already clamped by the caller
 * @returns {{ idxWidthPct: string, colWidthPct: string[] }}
 */
export function computeColumnWidths({
  columns, showRowIndex, idxPx, colPx, paperSize, marginPreset, isLandscape, scale = 1,
}) {
  const weights  = (showRowIndex ? [idxPx] : []).concat(colPx);
  const priors   = (showRowIndex ? ['low'] : []).concat(columns.map(classifyPriority));
  // idx (row-index) has no column def of its own to carry a `minPx`
  // override — {} resolves to the plain tier floor, same as before.
  const colDefs  = (showRowIndex ? [{}] : []).concat(columns);
  // Larger print-time scale (Print Preview → Scale) grows every glyph, so the
  // same legibility floor needs proportionally more px at 125% than at 85%;
  // clamp the multiplier itself so an extreme scale can't inflate floors
  // past usefulness (they're still a FLOOR — real content can want more).
  const scaleMul = Math.max(0.85, Math.min(1.25, scale));
  const mins     = colDefs.map((c, i) => resolveMinPx(c, priors[i]) * scaleMul);

  const paper       = PAPER_MM[paperSize] || PAPER_MM.A4;
  const fullWmm     = isLandscape ? paper.h : paper.w;
  const printableMm = Math.max(1, fullWmm - 2 * marginPreset.h);
  const pagePx       = printableMm * MM_TO_PX;

  const totalW  = weights.reduce((a, b) => a + b, 0) || 1;
  const minsSum = mins.reduce((a, b) => a + b, 0) || 0;

  let widths;
  if (minsSum <= pagePx) {
    // Common case: every column's floor fits on the page at least once.
    // Iterative floor-and-redistribute pass: pin any column under its own
    // priority floor to that floor, then re-share the remaining page
    // budget across every still-free column in proportion to its authored
    // weight. Repeats because pinning a column shrinks the free budget,
    // which can push another column below ITS floor on the next pass; it
    // terminates because each pass either pins at least one more column or
    // converges.
    widths = weights.map(w => (w / totalW) * pagePx);
    for (let pass = 0; pass < weights.length; pass++) {
      const pinned = widths.map((w, i) => w < mins[i]);
      if (!pinned.some(Boolean)) break;
      const pinnedTotal = pinned.reduce((s, p, i) => s + (p ? mins[i] : 0), 0);
      const freeWeightTotal = weights.reduce((s, w, i) => s + (pinned[i] ? 0 : w), 0) || 1;
      const remaining = Math.max(0, pagePx - pinnedTotal);
      widths = weights.map((w, i) => pinned[i] ? mins[i] : (w / freeWeightTotal) * remaining);
    }
  } else {
    // Overflow case: there isn't enough page width to give every column its
    // own floor (typical for 10+ column reports in portrait). A flat
    // proportional-to-floor squeeze here would shrink a high-priority
    // column (Employee Name, Date) by the same ratio as a low-priority one
    // (#, code) — exactly the "important column becomes too narrow while a
    // low-value one keeps its width" failure this engine exists to
    // prevent. Instead, fill floors in strict priority order — high tier
    // first, then medium, then low — so a lower tier is the one that gets
    // squeezed (even below its own floor) before a higher tier ever is.
    widths = new Array(weights.length).fill(0);
    let remaining = pagePx;
    for (const tier of ['high', 'medium', 'low']) {
      const idxs = priors.reduce((acc, p, i) => { if (p === tier) acc.push(i); return acc; }, []);
      if (!idxs.length) continue;
      const tierFloorTotal = idxs.reduce((s, i) => s + mins[i], 0);
      if (tierFloorTotal <= remaining) {
        idxs.forEach(i => { widths[i] = mins[i]; });
        remaining -= tierFloorTotal;
      } else {
        // Not enough room to give this tier its full floor either — split
        // what's left among just this tier's columns, proportional to
        // their own floor (keeps same-tier columns relatively balanced),
        // and every lower tier gets nothing left to take.
        idxs.forEach(i => { widths[i] = tierFloorTotal > 0 ? (mins[i] / tierFloorTotal) * remaining : 0; });
        remaining = 0;
      }
    }
  }

  const finalTotal = widths.reduce((a, b) => a + b, 0) || 1;
  const pctStrings = widths.map(w => (w / finalTotal * 100).toFixed(2) + '%');

  return {
    idxWidthPct: showRowIndex ? pctStrings[0] : '0%',
    colWidthPct: showRowIndex ? pctStrings.slice(1) : pctStrings,
  };
}

export default computeColumnWidths;
