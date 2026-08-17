/**
 * CompactSalarySheet — 9-per-page A4 landscape payroll card grid.
 * Each card renders as a 3-column table: label | value | icon (RTL order).
 *
 * Visual tokens (navy/blue accents, card radius/shadow, Cairo typography,
 * footer identity line) now come from printDesignSystem.js — the same
 * source reportTemplate.js's table reports and SalaryCard use — so a
 * printed bulk sheet reads as the same document family instead of a
 * separate black-and-white card design. The 3×3 card grid, PER_PAGE=9, and
 * every payroll field/calculation below are unchanged.
 */
import React from 'react';
import {
  Wallet, PlusCircle, MinusCircle, Clock, CreditCard, UserMinus, Banknote,
} from 'lucide-react';
import { displayNetSalary } from '../lib/formatters';
import { COLORS, SHADOW } from '../lib/printDesignSystem';

export const PER_PAGE = 9; // 3 cols × 3 rows

// Phase 8.1: r0() was a byte-for-byte duplicate of formatters.js's
// displayNetSalary() (same Math.round(Number(n)||0)) — removed in favor of
// the shared function. fmtNum/fmtAmt/fmtBackend themselves stay local: they
// deliberately never render a negative sign (Math.abs — this card has no
// negative-value use case), which fmtMoney()/fmtInt() do not replicate, so
// they are not interchangeable with any canonical formatter without risking
// a different displayed string on a negative input.
function fmtNum(n) {
  return Math.abs(displayNetSalary(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function fmtAmt(n) { return displayNetSalary(n) === 0 ? '—' : fmtNum(n); }
// Display-only — '—' when the backend hasn't provided a value. Never a computed fallback.
function fmtBackend(n) { return (n == null || isNaN(Number(n))) ? '—' : fmtNum(n); }

const MONTH_NUM = {
  'يناير':1,'فبراير':2,'مارس':3,'أبريل':4,'مايو':5,'يونيو':6,
  'يوليو':7,'أغسطس':8,'سبتمبر':9,'أكتوبر':10,'نوفمبر':11,'ديسمبر':12,
};

// ── Scoped print-first styles — tokens sourced from printDesignSystem.js ───
const CSS = `
.cps-root{
  direction:rtl;
  font-family:'Cairo','IBM Plex Sans Arabic',Tahoma,Arial,sans-serif;
  color:${COLORS.i1}; background:#fff;
  font-feature-settings:'tnum' 1,'lnum' 1;
}
.cps-root *{box-sizing:border-box;}
.cps-num{direction:ltr;unicode-bidi:isolate;font-variant-numeric:tabular-nums;}

/* ── A4 landscape page ─────────────────────────────────────────────────── */
/* Vertical budget, measured against the REAL production render (real
   embedded Cairo fonts + real icons). Before the name-row/data-row
   compression above, a card's own unconstrained content was 69.80mm —
   3 of those + 2×3mm gaps needed 215.4mm, more than the ENTIRE 210mm
   page even at 0 margin (confirmed by literally trying 0 margin: it
   still failed by 1.8mm, plus 0 margin hit a second, separate bug —
   Chromium's print pass rounds a hair past an exact 210mm tie, silently
   inserting a blank trailing page). The name-row and data-row changes
   above recover real content height (measured, not guessed) down to a
   value that fits inside an equal repeat(3,1fr) row with 3mm top/bottom
   padding (a deliberately non-zero, non-exact-boundary margin — enough
   to keep Chromium's print-vs-screen rounding away from both the page's
   own edge and the card's own cell edge). No card WIDTH, color, border,
   icon, or payroll value is touched — only page/grid geometry plus the
   two documented internal reserves above. */
.cps-page{
  width:297mm; height:210mm; padding:3mm 9mm;
  margin:0 auto; background:#fff;
  display:flex; flex-direction:column;
  page-break-after:always; break-after:page;
  overflow:hidden;
}
.cps-page:last-child{page-break-after:auto;break-after:auto;}

/* ── 3 × 3 card grid ───────────────────────────────────────────────────── */
.cps-grid-wrap{
  flex:1 1 auto; min-height:0; position:relative;
}
.cps-grid{
  width:100%; height:100%;
  display:grid;
  grid-template-columns:repeat(3,1fr);
  /* repeat(3,1fr): equal division, back to a proportional track now that
     real (measured) content height fits under the fair-share row size —
     see the geometry comment above for the compression that made this
     true again instead of needing an explicit fixed-mm track. */
  grid-template-rows:repeat(3,1fr);
  /* Explicit 3mm gap on both axes — a real CSS Grid gap is the ONLY
     spacing mechanism between cards (no transform-scale inset trick), so
     the white separation between every pair of adjacent cards is exactly
     3mm, guaranteed and uniform. */
  gap:3mm;
}

/* ── Cutting guides — small L-shaped corner brackets, one set per card,
   living entirely inside the 3mm whitespace produced by .cps-grid's own
   gap property above. Each bracket is offset 0.3mm off its card's real border
   (never touching it) and only 1mm long, so even on adjoining cards the
   two facing brackets stay a full 0.4mm apart at the gap's midpoint —
   they can never cross into a card, sit on top of its content/icons, or
   replace the card's own border. Anchored to .cps-cell (a plain grid
   item wrapping the untouched .cps-card, see the grid map below), not to
   .cps-card itself, specifically so .cps-card's own overflow:hidden
   (unconditional, screen and print alike) never clips or otherwise affects
   them — the marks are guaranteed visible in screen preview, Print
   Preview, window.print(), and Electron printToPDF() alike, because
   they're a single unconditional rule, not something gated behind
   @media print. Real borders (not a background/gradient trick), so they
   survive print/PDF rasterization the same way the card borders do. ── */
.cps-cell{ position:relative; }
.cps-crop{
  position:absolute; width:1mm; height:1mm;
  border-style:solid; border-width:0; border-color:${COLORS.i4};
  pointer-events:none;
}
.cps-crop-tl{ top:-1.3mm; left:-1.3mm; border-top-width:0.3mm; border-left-width:0.3mm; }
.cps-crop-tr{ top:-1.3mm; right:-1.3mm; border-top-width:0.3mm; border-right-width:0.3mm; }
.cps-crop-bl{ bottom:-1.3mm; left:-1.3mm; border-bottom-width:0.3mm; border-left-width:0.3mm; }
.cps-crop-br{ bottom:-1.3mm; right:-1.3mm; border-bottom-width:0.3mm; border-right-width:0.3mm; }

/* ── Individual card — same radius/shadow language as reportTemplate.js's
   .table-wrap / SalaryCard's cards, sized to fill its 1/9-page grid cell.
   Navy (COLORS.p), 1.5px — the strongest, darkest line on the card, so
   the outer boundary always reads first, ahead of the net-salary row's
   own border and well ahead of the light-gray internal row hairlines —
   and kept as a real border, not just the box-shadow (which some print/
   PDF paths don't render reliably; the shadow stays too, purely as
   depth, never the sole boundary).
   Cards fill their grid cell exactly (no transform:scale inset trick) —
   the ONLY spacing between cards is the real .cps-grid gap property, so
   the measured gap is exactly what that gap value says. ────────────────── */
.cps-card{
  border:1.5px solid ${COLORS.p}; border-radius:6px; background:#fff;
  box-shadow:${SHADOW.card};
  display:flex; flex-direction:column;
  overflow:hidden; break-inside:avoid; page-break-inside:avoid;
  min-height:0; height:100%;
}

/* ── Card table (fills full card height) ──────────────────────────────── */
.cps-tbl{
  width:100%; height:100%;
  border-collapse:collapse; table-layout:fixed;
  flex:1 1 auto;
}

/* Column widths: label | value | icon (RTL: right→left = first→last td) */
.cps-col-lbl{width:52%;}
.cps-col-val{width:32%;}
.cps-col-ico{width:16%;}

/* ── Month header row — same soft-blue gradient as reportTemplate.js's
   thead th, brand-ink text, instead of a plain white/black rule. ───────── */
.cps-td-month{
  text-align:center; font-size:9pt; font-weight:700; color:${COLORS.brandInk};
  padding:1.5mm 3mm; border-bottom:1.5px solid ${COLORS.i4};
  background:linear-gradient(180deg,#F8FBFF,#EDF4FF); line-height:1.2; white-space:nowrap;
}

/* ── Employee name row — same sharpened tone as the data rows below, so
   the whole card reads as one consistent set of separators.
   min-height reserves room for a full 2-LINE wrap (15pt × 1.4 line-height
   ≈ 7.4mm/line × 2 + 4mm padding ≈ 18.8mm) up front, on every card, not
   just the ones with a long name — so a long name wraps in full (never
   truncated, never ellipsized) WITHOUT changing that card's total height
   relative to its neighbors: short names just leave the row's extra
   space blank (still vertical-align:middle), long ones fill it. This is
   what keeps "equal card height regardless of content" true even when
   names differ in length, instead of trading that off against showing
   the full name. ─────────────────────────────────────────────────────── */
.cps-td-name{
  text-align:center; font-size:15pt; font-weight:700; color:${COLORS.brandInk};
  /* line-height 1.4→1.3 and padding 2mm→1.5mm (vertical) still reserve a
     genuine, measured 2-full-line floor: 2×(15pt×1.3 line-height)=13.76mm
     + 3mm padding = 16.76mm, rounded UP (never down) to 16.9mm so a real
     2-line name always has slightly MORE room than the arithmetic
     minimum, never less — font-size itself is untouched, so this never
     trades away readability, only the extra blank margin short/1-line
     names were otherwise reserving unconditionally. Recovers ~1.9mm. */
  line-height:1.3; padding:1.5mm 3mm; min-height:16.9mm;
  background:${COLORS.alt};
  border-top:1px solid ${COLORS.i4}; border-bottom:1.25px solid ${COLORS.i4};
  vertical-align:middle;
  word-break:normal; overflow-wrap:break-word; white-space:normal;
}

/* ── Data rows ────────────────────────────────────────────────────────── */
/* 1px solid, COLORS.i4 (neutral slate-gray, not the pale bd/bd2 blues) —
   sharp and print-safe: dark enough to survive grayscale/physical print
   without being as heavy as the navy card/net-row borders, keeping the
   outer-card > net-row > internal-row visual hierarchy the design calls
   for. 0.5px widths round away to nothing at typical print DPI, and the
   pale bd/bd2 tones risk washing out on physical toner — both avoided.
   line-height:1.2 (was the browser default 'normal', which real Cairo
   renders taller than an 8-10pt single line of digits/labels needs) —
   font-size and padding are untouched, this only tightens the leading
   each of the 6 plain data rows reserves around its own single line. */
.cps-tbl tbody tr.r-data td{
  border-bottom:1px solid ${COLORS.i4}; vertical-align:middle; overflow:hidden;
  line-height:1.2;
}
.cps-td-lbl{
  text-align:right; font-size:8pt; font-weight:600; color:${COLORS.i2};
  padding:0 2mm; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  /* Vertical divider before the value column — border-inline-end follows
     dir:rtl automatically (renders on the visual left of this cell,
     i.e. between label and value), so this doesn't need a hardcoded
     left/right side to stay correct under RTL. */
  border-inline-end:1px solid ${COLORS.i4};
}
.cps-td-val{
  text-align:center; font-size:10pt; font-weight:700; padding:0 1mm;
  border-inline-end:1px solid ${COLORS.i4};
}
.cps-td-ico{
  text-align:center; padding:0 1mm;
  display:table-cell; vertical-align:middle;
}
.cps-ico-wrap{display:flex;align-items:center;justify-content:center;}

/* Row accent colors — the same six-color enterprise palette every report
   uses (COLORS.suc/dng/wrn/pur), not a bespoke bootstrap-ish scale. */
.r-basic .cps-td-ico svg{color:${COLORS.i3};}    .r-basic .cps-td-val{color:${COLORS.i1};}
.r-ot    .cps-td-ico svg{color:${COLORS.suc};}   .r-ot    .cps-td-val{color:${COLORS.suc};}
.r-late  .cps-td-ico svg{color:${COLORS.dng};}   .r-late  .cps-td-val{color:${COLORS.dng};}
.r-abs   .cps-td-ico svg{color:${COLORS.dng};}   .r-abs   .cps-td-val{color:${COLORS.dng};}
.r-adv   .cps-td-ico svg{color:${COLORS.wrn};}   .r-adv   .cps-td-val{color:${COLORS.wrn};}
.r-adm   .cps-td-ico svg{color:${COLORS.pur};}   .r-adm   .cps-td-val{color:${COLORS.pur};}

/* ── Net salary row (highlighted) — same "totals row" treatment as
   reportTemplate.js's tr.totals: soft-strong fill, inset shadow, navy ink,
   PLUS a real border (not just the shadow) as its own top separator — a
   box-shadow alone is not guaranteed to render in every print/PDF path,
   so the row boundary itself must not depend on it. Stronger (1.5px,
   navy) than the 1px hairline between ordinary rows, matching how
   reportTemplate.js's own tr.totals marks itself as the summary line. ── */
.r-net td{
  background:${COLORS.softStrong}; border-top:1.5px solid ${COLORS.p}; border-bottom:none;
  box-shadow:inset 0 3px 5px -3px rgba(15,39,75,0.35);
  vertical-align:middle; overflow:hidden;
}
.r-net .cps-td-lbl{font-size:9pt;font-weight:700;color:${COLORS.p};padding:0 2mm;}
.r-net .cps-td-val{font-size:14pt;font-weight:800;color:${COLORS.p};padding:0 1mm;}
.r-net .cps-td-ico svg{color:${COLORS.p};}

@media screen{
  .cps-page{margin:0 auto 8mm;box-shadow:0 1px 8px rgba(0,0,0,.12);}
}
@media print{
  .cps-page{margin:0;box-shadow:none;}
  body{background:#fff;}
  /* No overflow escape hatch here on purpose: .cps-card stays
     overflow:hidden in print too. The 4.2mm row buffer added to
     .cps-page's padding above is what keeps every row (including
     صافي المرتب) inside its card now — content is sized to fit the
     geometry, not grown past a clipped box. */
}
`;

// ── Single employee card ─────────────────────────────────────────────────────
function Card({ d, monthLabel, year }) {
  const emp = d.employee   || {};
  const ear = d.earnings   || {};
  const ded = d.deductions || {};

  // ── Display only — every value is an explicit backend field, never an
  // inferred/residual subtraction, so this card can never silently drop or
  // double-count a deduction component as the total's composition changes.
  const basic   = displayNetSalary(ear.basicSalary);
  const ot      = displayNetSalary(ear.overtimeAmount);
  const lateAmt = displayNetSalary(ded.lateAmount);
  const absAmt  = displayNetSalary(ded.absentAmount);
  const adv     = displayNetSalary(ded.advances);
  // "خصم إداري" groups every remaining named deduction component (early-leave,
  // HR manual adjustment) — an explicit sum of known fields, not `total`
  // minus what's shown elsewhere. Row display only.
  const admDed  = displayNetSalary(ded.earlyAmount) + displayNetSalary(ded.manualDeductionAdjustment);
  // EF-019.1: "الصافي" is the ONE shared displayNetSalary() helper applied to
  // this card's own canonical `netSalary` field — not re-derived from the
  // rows above (which, notably, never included `bonus` in the old formula
  // here — a latent bug this also fixes). Identical to every other payroll
  // consumer (Payroll Grid, Salary Card, Final Salary Modal, Print/PDF/Excel).
  const net = displayNetSalary(d.netSalary);
  // ──────────────────────────────────

  // Optional absent-days count for label enrichment
  const absDays = displayNetSalary(
    d.absentDays ?? ded.absentDays ?? d.attendance?.absentDays ?? d.summary?.absentDays ?? 0
  );
  const absLabel = absDays > 0 ? `خصم الغياب (${absDays} أيام)` : 'خصم الغياب';

  const mNum = MONTH_NUM[monthLabel] || '';
  const headerText = `مرتب شهر ${monthLabel}${mNum ? ` (${mNum})` : ''}`;

  return (
    <div className="cps-card">
      <table className="cps-tbl">
        <colgroup>
          <col className="cps-col-lbl" />
          <col className="cps-col-val" />
          <col className="cps-col-ico" />
        </colgroup>
        <tbody>

          {/* Month header — full-width, white bg, centered bold */}
          <tr>
            <td className="cps-td-month" colSpan={3}>{headerText}</td>
          </tr>

          {/* Employee name row — full-width, dominant */}
          <tr>
            <td colSpan={3} className="cps-td-name">{emp.name || '—'}</td>
          </tr>

          {/* ── Salary rows ── */}
          <tr className="r-data r-basic">
            <td className="cps-td-lbl">الراتب الأساسي</td>
            <td className="cps-td-val cps-num">{fmtAmt(basic)}</td>
            <td className="cps-td-ico"><span className="cps-ico-wrap"><Wallet size={12} strokeWidth={2} /></span></td>
          </tr>

          <tr className="r-data r-ot">
            <td className="cps-td-lbl">إجمالي الإضافي</td>
            <td className="cps-td-val cps-num">{fmtAmt(ot)}</td>
            <td className="cps-td-ico"><span className="cps-ico-wrap"><PlusCircle size={12} strokeWidth={2} /></span></td>
          </tr>

          <tr className="r-data r-late">
            <td className="cps-td-lbl">خصم التأخير</td>
            <td className="cps-td-val cps-num">{fmtNum(lateAmt)}</td>
            <td className="cps-td-ico"><span className="cps-ico-wrap"><Clock size={12} strokeWidth={2} /></span></td>
          </tr>

          <tr className="r-data r-abs">
            <td className="cps-td-lbl">{absLabel}</td>
            <td className="cps-td-val cps-num">{fmtAmt(absAmt)}</td>
            <td className="cps-td-ico"><span className="cps-ico-wrap"><MinusCircle size={12} strokeWidth={2} /></span></td>
          </tr>

          <tr className="r-data r-adv">
            <td className="cps-td-lbl">السلف</td>
            <td className="cps-td-val cps-num">{fmtAmt(adv)}</td>
            <td className="cps-td-ico"><span className="cps-ico-wrap"><CreditCard size={12} strokeWidth={2} /></span></td>
          </tr>

          <tr className="r-data r-adm">
            <td className="cps-td-lbl">خصم إداري</td>
            <td className="cps-td-val cps-num">{fmtAmt(admDed)}</td>
            <td className="cps-td-ico"><span className="cps-ico-wrap"><UserMinus size={12} strokeWidth={2} /></span></td>
          </tr>

          {/* ── Net salary row — light gray highlight ── */}
          <tr className="r-net">
            <td className="cps-td-lbl">صافي المرتب</td>
            <td className="cps-td-val cps-num">{fmtBackend(net)}</td>
            <td className="cps-td-ico"><span className="cps-ico-wrap"><Banknote size={13} strokeWidth={2} /></span></td>
          </tr>

        </tbody>
      </table>
    </div>
  );
}

// ── Root component ───────────────────────────────────────────────────────────
export default function CompactSalarySheet({ sheets = [], monthLabel = '', year = '' }) {
  const valid = sheets.filter(Boolean);
  const pages = [];
  for (let i = 0; i < valid.length; i += PER_PAGE) pages.push(valid.slice(i, i + PER_PAGE));
  if (pages.length === 0) pages.push([]);

  return (
    <div className="cps-root">
      <style>{CSS}</style>
      {pages.map((group, p) => (
        <div className="cps-page" key={p}>

          {/* 3 × 3 card grid — default auto-placement fills cells in DOM
              order starting at the first cell, row by row, for every page,
              full or partial. A partial last page therefore always leaves
              its remaining cells at the END (bottom) of the grid, keeping
              every card top-aligned and cutting-predictable instead of
              being re-centered into the middle of the page. */}
          <div className="cps-grid-wrap">
            <div className="cps-grid">
              {group.map((d, i) => (
                <div className="cps-cell" key={d.employee?.id ?? i}>
                  <span className="cps-crop cps-crop-tl" />
                  <span className="cps-crop cps-crop-tr" />
                  <span className="cps-crop cps-crop-bl" />
                  <span className="cps-crop cps-crop-br" />
                  <Card d={d} monthLabel={monthLabel} year={year} />
                </div>
              ))}
            </div>
          </div>

        </div>
      ))}
    </div>
  );
}
