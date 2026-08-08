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
import { useCompanyBrand } from '../lib/branding';
import { COLORS, SHADOW, buildFooterLeft } from '../lib/printDesignSystem';

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
.cps-page{
  width:297mm; height:210mm; padding:3mm 6mm;
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
  grid-template-rows:repeat(3,1fr);
  gap:5mm;
}

/* ── Cut / crop guides ─────────────────────────────────────────────────── */
/* Guide lines sit inside the gap — z-index above cards, pointer-events off */
.cps-cut-v,.cps-cut-h{
  position:absolute; pointer-events:none; display:block; z-index:10;
}
/* Vertical guides — centered in col gaps at 33.33% and 66.67% */
.cps-cut-v{
  top:0; bottom:0; width:0;
  border-left:0.5px dashed #999;
}
.cps-cut-v1{ left:33.33%; }
.cps-cut-v2{ left:66.67%; }
/* Horizontal guides — centered in row gaps at 33.33% and 66.67% */
.cps-cut-h{
  left:0; right:0; height:0;
  border-top:0.5px dashed #999;
}
.cps-cut-h1{ top:33.33%; }
.cps-cut-h2{ top:66.67%; }
/* Edge tick marks — 6 px cross-hair at each guide endpoint */
.cps-cut-v::before,.cps-cut-v::after{
  content:''; position:absolute; left:-3px;
  width:6px; height:0; border-top:0.5px solid #777;
}
.cps-cut-v::before{ top:0; }
.cps-cut-v::after { bottom:0; }
.cps-cut-h::before,.cps-cut-h::after{
  content:''; position:absolute; top:-3px;
  height:6px; width:0; border-left:0.5px solid #777;
}
.cps-cut-h::before{ left:0; }
.cps-cut-h::after { right:0; }
@media print{
  .cps-cut-v,.cps-cut-h{ display:block; }
}

/* ── Individual card — same radius/shadow language as reportTemplate.js's
   .table-wrap / SalaryCard's cards, at a scale that fits a 1/9-page card. ── */
.cps-card{
  border:1px solid ${COLORS.cardBorder}; border-radius:6px; background:#fff;
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
  padding:1.5mm 3mm; border-bottom:1.5px solid ${COLORS.hair};
  background:linear-gradient(180deg,#F8FBFF,#EDF4FF); line-height:1.2; white-space:nowrap;
}

/* ── Employee name row ─────────────────────────────────────────────────── */
.cps-td-name{
  text-align:center; font-size:15pt; font-weight:700; color:${COLORS.brandInk};
  line-height:1.4; padding:2mm 3mm;
  background:${COLORS.alt};
  border-top:1px solid ${COLORS.cardBorder}; border-bottom:1px solid ${COLORS.cardBorder};
  vertical-align:middle;
  word-break:normal; overflow-wrap:break-word; white-space:normal;
}

/* ── Data rows ────────────────────────────────────────────────────────── */
.cps-tbl tbody tr.r-data td{
  border-bottom:0.5px solid ${COLORS.bd}; vertical-align:middle; overflow:hidden;
}
.cps-td-lbl{
  text-align:right; font-size:8pt; font-weight:600; color:${COLORS.i2};
  padding:0 2mm; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.cps-td-val{
  text-align:center; font-size:10pt; font-weight:700; padding:0 1mm;
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
   reportTemplate.js's tr.totals: soft-strong fill, inset shadow, navy ink. ── */
.r-net td{
  background:${COLORS.softStrong}; border-top:none; border-bottom:none;
  box-shadow:inset 0 3px 5px -3px rgba(15,39,75,0.35);
  vertical-align:middle; overflow:hidden;
}
.r-net .cps-td-lbl{font-size:9pt;font-weight:700;color:${COLORS.p};padding:0 2mm;}
.r-net .cps-td-val{font-size:14pt;font-weight:800;color:${COLORS.p};padding:0 1mm;}
.r-net .cps-td-ico svg{color:${COLORS.p};}

/* ── Page footer — same left(identity)/right(pagination) split as every
   table report's @page footer. Real per-page numbers (not CSS counters):
   this document's fixed-size page divs aren't rendered through an @page
   margin box, so the exact page index is computed in JS below instead. ─── */
.cps-footer{
  flex:0 0 auto; margin-top:2mm; padding-top:1.5mm;
  border-top:1px solid ${COLORS.bd};
  display:flex; justify-content:space-between; align-items:center;
  font-size:7.5pt; color:${COLORS.i3};
}

@media screen{
  .cps-page{margin:0 auto 8mm;box-shadow:0 1px 8px rgba(0,0,0,.12);}
}
@media print{
  .cps-page{margin:0;box-shadow:none;}
  body{background:#fff;}
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
  const brand = useCompanyBrand();
  const footerLeft = buildFooterLeft(brand, {});

  const valid = sheets.filter(Boolean);
  const pages = [];
  for (let i = 0; i < valid.length; i += PER_PAGE) pages.push(valid.slice(i, i + PER_PAGE));
  if (pages.length === 0) pages.push([]);

  return (
    <div className="cps-root">
      <style>{CSS}</style>
      {pages.map((group, p) => (
        <div className="cps-page" key={p}>

          {/* 3 × 3 card grid with cut guides */}
          <div className="cps-grid-wrap">
            <div className="cps-grid">
              {group.map((d, i) => (
                <Card key={d.employee?.id ?? i} d={d} monthLabel={monthLabel} year={year} />
              ))}
            </div>
            <span className="cps-cut-v cps-cut-v1" aria-hidden="true" />
            <span className="cps-cut-v cps-cut-v2" aria-hidden="true" />
            <span className="cps-cut-h cps-cut-h1" aria-hidden="true" />
            <span className="cps-cut-h cps-cut-h2" aria-hidden="true" />
          </div>

          {/* Page footer — company identity (left) · real page N/M (right),
              same visual language as every table report's footer. */}
          <div className="cps-footer">
            <span>{footerLeft}</span>
            <span>صفحة {p + 1} من {pages.length}</span>
          </div>

        </div>
      ))}
    </div>
  );
}
