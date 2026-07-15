/**
 * SalaryCard — Printable A4 Landscape Enterprise Payroll Statement
 *
 * Modern ERP-style payslip (SAP/Oracle HCM/Zoho/Odoo look):
 * - Soft blue/gray enterprise palette, white background
 * - KPI cards for attendance summary, professional info card
 * - Clean modern tables with alternating rows and highlighted totals
 * - RTL Arabic layout, A4 Landscape, single-page print-ready
 */
import React from 'react';
import { useCompanyBrand } from '../lib/branding';
import { formatHours, displayNetSalary } from '../lib/formatters';

// Integer-only money/number — Western digits, commas, no fractions (by request).
const r0   = (n) => Math.round(Number(n) || 0);
function fmt(n) {
  if (n == null || isNaN(n)) return '—';
  const num = r0(n);
  const intStr = Math.abs(num).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (num < 0 ? '-' : '') + intStr;
}
// EF-012.1: hourlyRate display — previously Math.ceil'd to a whole unit
// (e.g. internal 33.333333333333336 → displayed "34"), which is not the
// nearest representation of the engine's actual value and had no documented
// accounting reason (unlike fmt()'s whole-currency-unit rule above, which is
// explicitly "by request"). Rounded to 2 decimals instead — matches the rate
// the Payroll Engine (payrollEngine.js's computeRates) actually computes and
// uses in every OT/penalty calculation, so this field can never imply a
// different rate than the one that was actually used.
function fmtRate(n) {
  if (n == null || isNaN(Number(n))) return '—';
  const num = Number(n);
  return num.toFixed(2);
}

// ── Enterprise palette ────────────────────────────────────────────────────
const C = {
  ink:        '#0f172a',
  sub:        '#64748b',
  border:     '#e2e8f0',
  brand:      '#2563eb',
  brandDark:  '#1e3a8a',
  brandSoft:  '#eff6ff',
  success:    '#16a34a',
  successSoft:'#f0fdf4',
  danger:     '#dc2626',
  dangerSoft: '#fef2f2',
  amber:      '#d97706',
  amberSoft:  '#fffbeb',
  purple:     '#7c3aed',
  surface:    '#f8fafc',
};

const thBase = {
  border: `1px solid ${C.border}`, padding: '1.5mm 4mm',
  background: C.brandSoft, color: C.brandDark,
  fontWeight: 800, fontSize: 15, textAlign: 'center',
};
const tdLabel = {
  border: `1px solid ${C.border}`, padding: '1.2mm 4mm',
  fontSize: 14, fontWeight: 600, color: C.ink,
};
const tdAmt = {
  border: `1px solid ${C.border}`, padding: '1.2mm 4mm',
  fontSize: 14, fontWeight: 700, textAlign: 'center',
  fontFamily: 'Consolas,monospace', color: C.ink,
};

function pad2(n) { return String(n).padStart(2, '0'); }
function printedAtStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ── KPI card — attendance summary ───────────────────────────────────────────
function Kpi({ label, value, color }) {
  return (
    <div style={{
      flex: 1, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6,
      padding: '2mm', textAlign: 'center',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.5mm',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.sub, letterSpacing: '0.2px' }}>{label}</div>
      <div dir="ltr" style={{ fontSize: 22, fontWeight: 900, color: color || C.ink, fontFamily: 'Consolas,monospace', lineHeight: 1.1 }}>
        {value}
      </div>
    </div>
  );
}

// ── Employee info card field ────────────────────────────────────────────────
function Field({ label, value, mono }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, padding: '1.6mm 3mm' }}>
      <div style={{ fontSize: 11, color: C.sub, fontWeight: 700, marginBottom: 2 }}>{label}</div>
      <div dir={mono ? 'ltr' : undefined} style={{
        fontSize: 15, fontWeight: 700, color: C.ink,
        fontFamily: mono ? 'Consolas,monospace' : 'inherit',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{value || '—'}</div>
    </div>
  );
}

// ── Payroll table — earnings / deductions ───────────────────────────────────
function PayrollTable({ title, accentColor, rows, totalLabel, totalValue, totalColor, totalBg }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', flex: 1 }}>
      <thead>
        <tr>
          <th colSpan={2} style={{ ...thBase, fontSize: 18, color: accentColor, background: C.surface, borderBottom: `2px solid ${accentColor}` }}>
            {title}
          </th>
        </tr>
        <tr>
          <th style={{ ...thBase, width: '60%' }}>البيان</th>
          <th style={{ ...thBase, width: '40%' }}>المبلغ</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} style={{ background: i % 2 === 1 ? C.surface : '#fff' }}>
            <td style={tdLabel}>{r.label}</td>
            <td dir="ltr" style={tdAmt}>{fmt(r.value)}</td>
          </tr>
        ))}
        <tr>
          <td style={{ ...tdLabel, fontWeight: 900, background: totalBg, fontSize: 16 }}>{totalLabel}</td>
          <td dir="ltr" style={{ ...tdAmt, fontWeight: 900, fontSize: 20, background: totalBg, color: totalColor }}>
            {fmt(totalValue)}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

// ── Summary bar — final totals strip ────────────────────────────────────────
function SummaryCell({ label, value, color, bg }) {
  return (
    <div style={{
      flex: 1, background: bg, border: `1px solid ${C.border}`, borderRadius: 6,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '1.5mm', gap: '1mm',
    }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: C.sub }}>{label}</div>
      <div dir="ltr" style={{ fontSize: 24, fontWeight: 900, color, fontFamily: 'Consolas,monospace' }}>{value}</div>
    </div>
  );
}

export default function SalaryCard({ data, showBorder = true }) {
  const brand = useCompanyBrand();
  if (!data) return null;

  const { employee, attendance, earnings, deductions, monthLabel, year, month, notes, netSalary } = data;

  const cardStyle = {
    width: '297mm',
    minHeight: '210mm',
    background: '#fff',
    color: C.ink,
    fontFamily: "'IBM Plex Sans Arabic','Cairo','Tahoma',Arial,sans-serif",
    direction: 'rtl',
    padding: '3mm 11mm',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    ...(showBorder ? { border: `1px solid ${C.border}`, borderRadius: 6 } : {}),
  };

  const earningsRows = [
    { label: 'الراتب الأساسي', value: earnings?.basicSalary },
    { label: `إضافي صباحي (${formatHours(attendance?.morningOT)})`, value: earnings?.morningOT?.amount },
    { label: `إضافي مسائي (${formatHours(attendance?.eveningOT)})`, value: earnings?.eveningOT?.amount },
    { label: 'مكافأة / بدل', value: earnings?.bonus },
    { label: ' ', value: null },
  ];
  const deductionsRows = [
    {
      label: (() => {
        const penDays = deductions?.absentPenaltyDays;
        const actDays = deductions?.absentDays || 0;
        if (penDays != null && penDays !== actDays) {
          return `خصم الغياب (${penDays} يوم خصم / ${actDays} يوم فعلي)`;
        }
        return `خصم الغياب (${actDays} أيام)`;
      })(),
      value: deductions?.absentAmount,
    },
    { label: `خصم التأخير (${(deductions?.latePenalty ?? 0).toFixed(1)} ساعة)`, value: deductions?.lateAmount },
    { label: `خصم الانصراف المبكر (${(deductions?.earlyPenalty ?? 0).toFixed(1)} ساعة)`, value: deductions?.earlyAmount },
    { label: 'خصم إداري', value: deductions?.manualDeductionAdjustment },
    // السلف (advances) intentionally NOT listed here: deductions.total
    // (dedTotal below) deliberately excludes advances (net = basic+ot+bonus
    // -deductions-advances), so including it in this table would make the
    // visible rows disagree with the printed total. Advances is instead
    // shown in its own dedicated card directly beneath this table — see the
    // "السلف" section rendered right after the deductions PayrollTable below.
  ];

  // EF-011 Accounting Policy: the earnings/deductions SECTION totals are the
  // sum of that section's own displayed (already-rounded) line items — not a
  // separately-rounded backend total — so each table is calculator-verifiable
  // from the rows printed above it. This is unchanged by EF-019.1.
  const earnTotal = earningsRows.reduce((s, r) => s + r0(r.value), 0);
  const dedTotal  = deductionsRows.reduce((s, r) => s + r0(r.value), 0);
  // EF-019.1: the final "صافي الراتب" figure is NOT re-derived from these
  // section totals (EF-019 proved that independently re-rounding a different
  // set of components per screen is exactly what caused cross-system ±1
  // divergences) — it is the ONE shared displayNetSalary() helper applied to
  // this same statement's own canonical `netSalary` field, identical to every
  // other consumer (Payroll Grid, Final Salary Modal, Compact Salary Sheet,
  // Print/PDF/Excel).
  const net = displayNetSalary(netSalary);

  return (
    <div style={cardStyle} className="salary-card" data-employee-id={employee?.id}>

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: `2px solid ${C.brand}`, paddingBottom: '1mm', marginBottom: '1.5mm',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '3mm', flex: 1 }}>
          <div style={{
            width: 34, height: 34, borderRadius: 8,
            background: brand.logoUrl ? 'transparent' : C.brand, color: '#fff', overflow: 'hidden',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, fontSize: 18, flexShrink: 0,
          }}>
            {brand.logoUrl
              ? <img src={brand.logoUrl} alt={brand.name} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              : brand.mark}
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 900, color: C.ink, letterSpacing: '0.4px' }}>{brand.company}</div>
            <div style={{ fontSize: 12, color: C.sub, fontWeight: 600 }}>
              {brand.tagline}{employee?.branch ? ` · فرع: ${employee.branch}` : ''}
            </div>
          </div>
        </div>

        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 900, color: C.brandDark }}>كشف مرتب الموظف</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.brand, marginTop: 2 }}>{monthLabel} {year}</div>
        </div>

        <div style={{ flex: 1, textAlign: 'left', fontSize: 12, color: C.sub, fontWeight: 600, lineHeight: 1.8 }}>
          <div>كود الموظف: <b dir="ltr" style={{ color: C.ink, fontFamily: 'Consolas,monospace' }}>{employee?.code}</b></div>
          <div>تاريخ الطباعة: <span dir="ltr" style={{ fontFamily: 'Consolas,monospace' }}>{printedAtStr()}</span></div>
        </div>
      </div>

      {/* ── Employee Info Card + معلومات الحساب + Attendance KPI Cards ──────── */}
      <div style={{ display: 'flex', gap: '3mm', marginBottom: '2mm' }}>
        {/* Info card */}
        <div style={{
          flex: 0.9, border: `1px solid ${C.border}`, borderRadius: 6, padding: '2mm 3mm',
          background: '#fff', display: 'flex', flexDirection: 'column', gap: '2mm',
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 20, fontWeight: 900, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {employee?.name}
            </div>
            <div dir="ltr" style={{
              fontSize: 13, fontWeight: 700, color: C.brand, background: C.brandSoft,
              borderRadius: 4, padding: '1.5mm 3mm', fontFamily: 'Consolas,monospace', flexShrink: 0, marginRight: '2mm',
            }}>
              #{employee?.code}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2mm', flex: 1 }}>
            <Field label="القسم" value={employee?.department} />
            <Field label="الوظيفة" value={employee?.position} />
            <Field label="الشيفت" value={employee?.shift} />
          </div>
        </div>

        {/* EF-012.2: "معلومات الحساب" — the 5 rate/basis inputs that feed
            every downstream calculation, exposed together in one place
            instead of a single stray "أجر الساعة" field. All 5 values
            already existed (employee.salary/hourlyRate/dailyRate from the
            API; monthDays/workHoursPerDay derived on the frontend from
            those same fields — dailyRate = basicSalary/monthDays and
            hourlyRate = dailyRate/workHoursPerDay, both computed in
            payrollEngine.js's computeRates() — so no API/engine change was
            needed to surface them). */}
        <div style={{
          flex: 1.1, border: `1px solid ${C.border}`, borderRadius: 6, padding: '2mm 3mm',
          background: C.surface, display: 'flex', flexDirection: 'column', gap: '2mm',
        }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: C.brandDark }}>معلومات الحساب</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '2mm', flex: 1 }}>
            <Field label="الراتب الأساسي" value={fmt(employee?.salary)} mono />
            <Field label="عدد أيام الشهر" value={employee?.dailyRate ? fmt(Math.round((employee.salary || 0) / employee.dailyRate)) : '—'} mono />
            <Field label="ساعات العمل اليومية" value={employee?.hourlyRate ? fmt(Math.round((employee.dailyRate || 0) / employee.hourlyRate)) : '—'} mono />
            <Field label="أجر اليوم" value={fmtRate(employee?.dailyRate)} mono />
            <Field label="أجر الساعة" value={fmtRate(employee?.hourlyRate)} mono />
          </div>
        </div>

        {/* KPI cards */}
        <div style={{ display: 'flex', gap: '2mm', flex: 1.6 }}>
          <Kpi label="أيام الحضور" value={attendance?.workDays || 0} color={C.success} />
          <Kpi label="أيام الغياب" value={attendance?.absentDays || 0} color={(attendance?.absentDays || 0) > 0 ? C.danger : C.ink} />
          {/* EF-012: "وقت التأخير" only showed late minutes — silently
              excluding early-leave hours, which are a separate deduction
              shown further down. Replaced with a single unified figure:
              late hours + early-leave hours (attendance.latePenalty/
              earlyPenalty — the same effective, post-override unit counts
              already used for the deductions table below), so this KPI can
              never mislead about the total time being deducted. */}
          <Kpi
            label="إجمالي ساعات الخصم"
            value={formatHours((attendance?.latePenalty || 0) + (attendance?.earlyPenalty || 0))}
            color={((attendance?.latePenalty || 0) + (attendance?.earlyPenalty || 0)) > 0 ? C.amber : C.sub}
          />
          <Kpi label="إضافي صباحي (ساعات)" value={formatHours(attendance?.morningOT)} color={C.purple} />
          <Kpi label="إضافي مسائي (ساعات)" value={formatHours(attendance?.eveningOT)} color={C.purple} />
          <Kpi label="إجمالي ساعات الإضافي" value={formatHours(attendance?.totalOTHours)} color={C.purple} />
        </div>
      </div>

      {/* ── Earnings & Deductions tables — side by side ────────────────────── */}
      <div style={{ display: 'flex', gap: '3mm', marginBottom: '2mm', alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <PayrollTable
            title="✚ المستحقات" accentColor={C.success}
            rows={earningsRows}
            totalLabel="إجمالي المستحقات" totalValue={earnTotal}
            totalColor={C.success} totalBg={C.successSoft}
          />
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '2mm' }}>
          <PayrollTable
            title="✖ الخصومات" accentColor={C.danger}
            rows={deductionsRows}
            totalLabel="إجمالي الخصومات" totalValue={dedTotal}
            totalColor={C.danger} totalBg={C.dangerSoft}
          />
          {/* السلف (advances) — its own accounting section, deliberately
              separate from "الخصومات": deductions.total never includes
              advances (net = earnings - deductions.total - advances), so
              advances is never summed into the deductions table/footer
              above. Placed directly beneath the deductions table so the
              printed layout mirrors the real accounting model. */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            border: `1px solid ${C.border}`, borderRadius: 6, background: C.amberSoft,
            padding: '2mm 4mm',
          }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: C.amber }}>السلف</div>
            <div dir="ltr" style={{ fontSize: 20, fontWeight: 900, color: C.amber, fontFamily: 'Consolas,monospace' }}>
              {fmt(deductions?.advances)}
            </div>
          </div>
        </div>
      </div>

      {/* ── Summary bar — final totals ─────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: '3mm', marginBottom: notes ? '1.5mm' : '2mm' }}>
        <SummaryCell label="إجمالي المستحقات" value={fmt(earnTotal)} color={C.success} bg={C.successSoft} />
        <SummaryCell label="إجمالي الخصومات" value={fmt(dedTotal)} color={C.danger} bg={C.dangerSoft} />
        <div style={{
          flex: 1.4, background: `linear-gradient(135deg, ${C.brandDark}, ${C.brand})`, borderRadius: 6,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: '1.5mm', color: '#fff', gap: '0.5mm',
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, opacity: 0.85 }}>صافي الراتب</div>
          <div dir="ltr" style={{ fontSize: 30, fontWeight: 900, fontFamily: 'Consolas,monospace', letterSpacing: '0.5px' }}>
            {fmt(net)}
          </div>
        </div>
      </div>

      {/* ── Notes ───────────────────────────────────────────────────────────── */}
      {notes && (
        <div style={{
          border: `1px solid ${C.border}`, borderRadius: 6, padding: '1.5mm 3mm', marginBottom: '3mm',
          fontSize: 9.5, background: C.amberSoft, color: C.ink,
        }}>
          <b style={{ color: C.amber }}>ملاحظات: </b>{notes}
        </div>
      )}

      {/* ── Signatures ──────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: '3mm', marginTop: 'auto' }}>
        {[
          { label: 'توقيع الموظف', name: employee?.name },
          { label: 'توقيع الحسابات', name: 'مسؤول الحسابات' },
          { label: 'اعتماد المدير', name: 'المدير العام' },
        ].map((s, i) => (
          <div key={i} style={{ flex: 1, border: `1px solid ${C.border}`, borderRadius: 6, padding: '1.5mm 3mm', textAlign: 'center' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.sub, marginBottom: '4mm' }}>{s.label}</div>
            <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: '1mm', fontSize: 12, color: C.sub }}>{s.name}</div>
          </div>
        ))}
      </div>

      {/* ── Period range + footer ───────────────────────────────────────────── */}
      <div style={{
        textAlign: 'center', marginTop: '1mm', fontSize: 11, color: '#94a3b8',
        borderTop: `1px solid ${C.border}`, paddingTop: '1mm',
        display: 'flex', justifyContent: 'space-between',
      }}>
        <span>الفترة: {month === 1 ? 12 : month - 1}/{month === 1 ? year - 1 : year} ← {month}/{year}</span>
        <span>{brand.product} · مستند مُولّد تلقائياً · {printedAtStr()}</span>
      </div>

    </div>
  );
}
