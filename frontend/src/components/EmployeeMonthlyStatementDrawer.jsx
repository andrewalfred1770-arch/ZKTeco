/**
 * EmployeeMonthlyStatementDrawer — "الكشف الشهري الفعلي" opened from the
 * Payroll Employee Review dialog.
 *
 * Phase 20.1: DISPLAY ONLY. Reuses the EXACT existing Monthly Attendance
 * data source — GET /api/attendance/monthly-detail (the same endpoint
 * AttendanceMonthlyPage.jsx itself uses), narrowed to one employee via its
 * existing `employeeId` query param (already supported server-side, see
 * routes/attendance/monthly.js — EP-014 narrowing, no new backend code).
 * Row classification reuses the SAME shared attendanceRowClass()/isAbsentRow()
 * (gridDefaults.js) every other attendance page/print report already uses —
 * not a second implementation of "what counts as absence" or "what is an
 * official holiday" (Phase 19's isHolidayRow semantics apply unchanged: an
 * official holiday is data.isHoliday OR data.status==='holiday', never
 * inferred from weekend/leave).
 *
 * No AttendanceDaily row, Payroll row, or Employee row is ever written by
 * this component — it makes exactly one GET request and renders it.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Loader2, Printer } from 'lucide-react';
import api from '../lib/api';
import Drawer from './ui/Drawer';
import PrintPreviewModal from './PrintPreviewModal';
import { attendanceRowClass, isAbsentRow, isHolidayRow } from '../lib/gridDefaults';
import { STATUS_LABELS, fmtOTHours, fmtPenaltyUnits, westernDigits } from '../lib/formatters';
import { MONTHS_AR } from '../lib/constants';

function StatusText({ row }) {
  const label = STATUS_LABELS[row.status];
  if (!label) return <span style={{ color: 'var(--text-3)' }}>{row.status || '—'}</span>;
  return <span style={{ color: label.color, fontWeight: 700 }}>{label.ar}</span>;
}

// Compact summary card — reuses the app's ONE shared metric-strip design
// (`.metric`/`.metric-label`/`.metric-value`, index.css) that the Dashboard
// and Payroll page's own KPI rows already use, so these four cards read as
// the same first-class figures instead of a bespoke widget.
function SummaryCard({ label, value, accent, color }) {
  return (
    <div className="metric" style={{ '--m-accent': accent, '--m-color': color, flex: '1 1 130px' }}>
      <span className="metric-label">{label}</span>
      <span className="metric-value" style={{ direction: 'ltr', fontSize: 18 }}>{value}</span>
    </div>
  );
}

// Print column set — mirrors the on-screen table's own columns/formatters
// exactly (same fields, same fmtOTHours/fmtPenaltyUnits), fed into the SAME
// buildReportHTML() print engine every other report in the app already uses
// via PrintPreviewModal — no second print/PDF implementation.
function buildPrintColumns() {
  return [
    { header: 'التاريخ', key: 'date', align: 'num', thStyle: 'width:90px' },
    { header: 'الحضور', key: 'checkIn', format: v => v || '—', align: 'num', thStyle: 'width:85px' },
    { header: 'الانصراف', key: 'checkOut', format: v => v || '—', align: 'num', thStyle: 'width:85px' },
    { header: 'ساعات العمل', key: 'workedHours', format: v => v ?? '0.00', align: 'num', thStyle: 'width:90px' },
    { header: 'التأخير', key: 'effectiveLatePenalty', format: v => (v || 0) > 0 ? fmtPenaltyUnits(v) : '—',
      tdClass: r => (r.effectiveLatePenalty || 0) > 0 ? 'num amber' : 'num muted', thStyle: 'width:85px' },
    { header: 'الإضافي', key: 'effectiveOvertimeUnits', format: v => (v || 0) > 0 ? fmtOTHours(v) : '—',
      tdClass: r => (r.effectiveOvertimeUnits || 0) > 0 ? 'num green' : 'num muted', thStyle: 'width:85px' },
    { header: 'انصراف مبكر', key: 'effectiveEarlyPenalty', format: v => (v || 0) > 0 ? fmtPenaltyUnits(v) : '—',
      tdClass: r => (r.effectiveEarlyPenalty || 0) > 0 ? 'num amber' : 'num muted', thStyle: 'width:90px' },
    { header: 'الحالة', key: 'status', format: v => STATUS_LABELS[v]?.ar || v || '—', thStyle: 'width:95px' },
  ];
}

export default function EmployeeMonthlyStatementDrawer({ employeeId, employeeName, month, year, open, onClose }) {
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]);
  const [printOpen, setPrintOpen] = useState(false); // Phase 20.4

  useEffect(() => {
    if (!open || !employeeId) return;
    setLoading(true);
    api.get('/attendance/monthly-detail', { params: { month, year, employeeId } })
      .then((r) => setRows(Array.isArray(r.data) ? r.data : []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [open, employeeId, month, year]);

  // Summary counts — reuse the SAME classifiers used for row color, so the
  // footer can never disagree with what the rows themselves display.
  // Present/actual-absence/holiday/weekend are mutually exclusive by
  // construction (attendanceEngine.js only ever sets one of
  // status/isWeekend/isHoliday/isAbsent's effective meaning per day).
  const summary = useMemo(() => {
    let present = 0, actualAbsent = 0, holiday = 0, weekend = 0, otHours = 0, deductUnits = 0;
    for (const r of rows) {
      if (isHolidayRow(r)) holiday++;
      else if (r.isWeekend) weekend++;
      else if (isAbsentRow(r)) actualAbsent++;
      else present++;
      // Phase 20.4: additive sums of the SAME per-day fields the table cells
      // below already render (effectiveOvertimeUnits/effectiveTotalDeductionUnits,
      // from buildAttendanceRow — see attendanceRow.js) — no new calculation,
      // just the monthly aggregate of values the attendance API already returns.
      otHours     += r.effectiveOvertimeUnits || 0;
      deductUnits += r.effectiveTotalDeductionUnits || 0;
    }
    return { present, actualAbsent, holiday, weekend, otHours, deductUnits, total: rows.length };
  }, [rows]);

  const printColumns = useMemo(() => buildPrintColumns(), []);
  const printStats = useMemo(() => ([
    { label: 'أيام الحضور',      value: westernDigits(summary.present),      color: 'green' },
    { label: 'أيام الغياب',      value: westernDigits(summary.actualAbsent), color: 'red' },
    { label: 'الساعات الإضافية', value: fmtOTHours(summary.otHours),         color: 'purple' },
    { label: 'إجمالي الخصومات',  value: fmtPenaltyUnits(summary.deductUnits), color: 'red' },
  ]), [summary]);
  const employeeCode = rows[0]?.employeeCode;

  return (
    <>
    <Drawer
      open={open}
      onClose={onClose}
      side="left"
      width={760}
      title={
        // Phase 20.4: employee name is the prominent, bold first line — the
        // month/year sits underneath as a compact secondary line, with the
        // print action anchored to that same line. Name is read from the
        // actual selected employee record (the `employeeName` prop this
        // component receives from its caller) — never hardcoded.
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <CalendarDays style={{ width: 16, height: 16, color: 'var(--accent)', flexShrink: 0 }} />
            <span style={{ fontWeight: 800, fontSize: 15, color: 'var(--text)' }}>
              الكشف الشهري الفعلي — {employeeName || ''}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingInlineStart: 24 }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-3)' }}>
              {MONTHS_AR[(month || 1) - 1]} {year}
            </span>
            {/* Prints ONLY this statement (this employee/month), via the SAME
                PrintPreviewModal/buildReportHTML print engine every other
                report in the app already uses — no second print engine.
                This button and the PrintPreviewModal below are BOTH mounted
                as siblings of Drawer (not inside it), so opening the preview
                never requires closing this drawer first — see the render
                below and the PrintPreviewModal z-index fix (Phase 20.4). */}
            {rows.length > 0 && (
              <button
                onClick={() => setPrintOpen(true)}
                title="طباعة"
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  background: 'transparent', border: '1px solid var(--border)', borderRadius: 6,
                  padding: '3px 10px', cursor: 'pointer', color: 'var(--c-accent)', fontSize: 11.5, fontWeight: 700,
                }}
              >
                <Printer style={{ width: 12, height: 12 }} /> طباعة
              </button>
            )}
          </div>
        </div>
      }
    >
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '40px 0', color: 'var(--text-3)' }}>
          <Loader2 style={{ width: 18, height: 18, animation: 'spin 1s linear infinite' }} />
          <span style={{ fontSize: 13 }}>جاري تحميل الكشف الشهري...</span>
        </div>
      ) : rows.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--text-3)', textAlign: 'center', padding: '40px 0' }}>
          لا توجد بيانات حضور لهذا الشهر
        </p>
      ) : (
        <>
          {/* ── Phase 20.4: monthly summary cards — the four figures required
              (أيام الحضور/أيام الغياب/الساعات الإضافية/إجمالي الخصومات), each
              an additive sum of fields the attendance API already returns per
              day (see summary useMemo above) — no recalculation. ── */}
          <div className="card" style={{ display: 'flex', flexWrap: 'wrap', padding: 0, overflow: 'hidden', marginBottom: 12 }}>
            <div style={{ flex: '1 1 130px' }}><SummaryCard label="أيام الحضور" value={westernDigits(summary.present)} accent="#16A34A" color="#16A34A" /></div>
            <div style={{ flex: '1 1 130px', borderRight: '1px solid var(--border)' }}><SummaryCard label="أيام الغياب" value={westernDigits(summary.actualAbsent)} accent="#DC2626" color="#DC2626" /></div>
            <div style={{ flex: '1 1 130px', borderRight: '1px solid var(--border)' }}><SummaryCard label="الساعات الإضافية" value={fmtOTHours(summary.otHours)} accent="#8b5cf6" color="#8b5cf6" /></div>
            <div style={{ flex: '1 1 130px', borderRight: '1px solid var(--border)' }}><SummaryCard label="إجمالي الخصومات" value={fmtPenaltyUnits(summary.deductUnits)} accent="#ef4444" color="#ef4444" /></div>
          </div>

          {/* ── Summary strip — same four states Phase 19 defined, same colors ── */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            {[
              { label: 'حضور فعلي', value: summary.present, cls: 'badge-green' },
              { label: 'غياب فعلي', value: summary.actualAbsent, cls: 'badge-red' },
              { label: 'عطلات رسمية', value: summary.holiday, cls: 'badge-blue' },
              { label: 'إجازات أسبوعية', value: summary.weekend, cls: 'badge-gray' },
            ].map((s) => (
              <span key={s.label} className={s.cls} style={{ padding: '4px 11px', borderRadius: 999, fontSize: 11.5, fontWeight: 700 }}>
                {s.label}: {westernDigits(s.value)}
              </span>
            ))}
          </div>

          <div className="data-table" style={{ width: '100%', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr>
                  {['التاريخ', 'الحضور', 'الانصراف', 'ساعات العمل', 'التأخير', 'الإضافي', 'انصراف مبكر', 'الحالة'].map(h => (
                    <th key={h} style={{ padding: '7px 10px', textAlign: 'center', color: 'var(--text-3)', fontWeight: 700, fontSize: 11, borderBottom: '1px solid var(--border)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id ?? r.date} className={attendanceRowClass({ data: r })}>
                    <td style={{ padding: '6px 10px', textAlign: 'center' }}>{r.date}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'center', fontFamily: 'Consolas,monospace' }}>{r.checkIn || '—'}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'center', fontFamily: 'Consolas,monospace' }}>{r.checkOut || '—'}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'center', fontFamily: 'Consolas,monospace' }}>{r.workedHours ?? '0.00'}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'center', fontFamily: 'Consolas,monospace' }}>{(r.effectiveLatePenalty || 0) > 0 ? fmtPenaltyUnits(r.effectiveLatePenalty) : '—'}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'center', fontFamily: 'Consolas,monospace' }}>{(r.effectiveOvertimeUnits || 0) > 0 ? fmtOTHours(r.effectiveOvertimeUnits) : '—'}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'center', fontFamily: 'Consolas,monospace' }}>{(r.effectiveEarlyPenalty || 0) > 0 ? fmtPenaltyUnits(r.effectiveEarlyPenalty) : '—'}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'center' }}><StatusText row={r} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Drawer>

    {/* Phase 20.4: reuses PrintPreviewModal exactly like the Payroll/Attendance
        pages' own "طباعة" buttons — same component, same print/PDF engine —
        scoped to only this employee's rows (already narrowed by the API
        query above), never the page behind this drawer. */}
    <PrintPreviewModal
      isOpen={printOpen}
      onClose={() => setPrintOpen(false)}
      data={rows}
      customColumns={printColumns}
      customStats={printStats}
      title={`الكشف الشهري الفعلي — ${employeeName || ''}`}
      meta={{
        period: `${MONTHS_AR[(month || 1) - 1]} ${year}`,
        subtitle: employeeCode ? `كود الموظف: ${employeeCode}` : '',
      }}
      orientation="portrait"
    />
    </>
  );
}
