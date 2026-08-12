/**
 * PayrollBreakdownDialog — "مراجعة كشف المرتبات" per-employee detail.
 *
 * Phase 20.3/20.4/20.7: DISPLAY ONLY. Every number shown here comes verbatim
 * from GET /payroll/final-sheet (the same existing endpoint FinalSalaryModal
 * already uses for the printed sheet — no second payroll calculation, no
 * frontend recomputation). The only arithmetic performed in this file is
 * addition/subtraction of ALREADY-COMPUTED backend fields purely for
 * DISPLAY grouping (earnings subtotal, month-over-month difference) —
 * never a re-derivation of a business value the backend didn't already
 * return, matching the same "additive display grouping, not recalculation"
 * pattern FinalSalaryModal's own rowDedTotal()/rowNet() already use.
 *
 * Status badge (Phase 20.4/20.5): reuses the EXISTING Payroll.status field
 * (draft/finalized/paid — see prisma/schema.prisma) and the EXISTING C1
 * finalized/paid protection (payrollEngine.js's filterProtectedPayrollTargets,
 * PUT /payroll/:id remaining intentionally unconditional per that audit) —
 * this dialog does not add, remove, or bypass any backend guard. The lock
 * banner shown for finalized/paid rows is presentation-only: it does not
 * block the existing PUT /payroll/:id edit path in any way.
 *
 * Month comparison (Phase 20.7): fetches the SAME final-sheet endpoint for
 * month-1, nothing new on the backend.
 */
import React, { useEffect, useState } from 'react';
import { TrendingUp, TrendingDown, Minus, Loader2, History, Lock, FileSpreadsheet, CalendarDays } from 'lucide-react';
import api from '../lib/api';
import Dialog from './ui/Dialog';
import PayrollAuditDrawer from './PayrollAuditDrawer';
import EmployeeMonthlyStatementDrawer from './EmployeeMonthlyStatementDrawer';
import { fmtMoney, fmtIntZero, displayNetSalary } from '../lib/formatters';
import { MONTHS_AR } from '../lib/constants';

const STATUS_BADGE = {
  draft:     { label: 'مسودة',  cls: 'badge-gray'  },
  finalized: { label: 'معتمد',  cls: 'badge-blue'  },
  paid:      { label: 'مدفوع',  cls: 'badge-green' },
};

function Row({ label, value, sign, emphasis }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '6px 0', fontSize: emphasis ? 14 : 13,
      fontWeight: emphasis ? 800 : 500,
      color: emphasis ? 'var(--text)' : 'var(--text-2)',
    }}>
      <span>{sign ? `${sign} ${label}` : label}</span>
      <span style={{ fontFamily: 'Consolas,monospace', fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(value)}</span>
    </div>
  );
}

export default function PayrollBreakdownDialog({ row, month, year, open, onClose }) {
  const [loading, setLoading] = useState(false);
  const [sheet, setSheet] = useState(null);
  const [prevSheet, setPrevSheet] = useState(null);
  const [prevLoading, setPrevLoading] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [statementOpen, setStatementOpen] = useState(false); // Phase 20.1

  const empId = row?.employeeId || row?.employee?.id;

  useEffect(() => {
    if (!open || !empId) return;
    setLoading(true);
    setSheet(null);
    setPrevSheet(null);
    setShowCompare(false);
    api.get('/payroll/final-sheet', { params: { employeeId: empId, month, year } })
      .then((r) => setSheet(r.data))
      .catch(() => setSheet(null))
      .finally(() => setLoading(false));
  }, [open, empId, month, year]);

  const loadComparison = () => {
    if (prevSheet || prevLoading) { setShowCompare((s) => !s); return; }
    let pm = month - 1, py = year;
    if (pm < 1) { pm = 12; py -= 1; }
    setPrevLoading(true);
    api.get('/payroll/final-sheet', { params: { employeeId: empId, month: pm, year: py } })
      .then((r) => setPrevSheet(r.data))
      .catch(() => setPrevSheet(false)) // false = "requested, unavailable" (distinct from null = "not yet requested")
      .finally(() => { setPrevLoading(false); setShowCompare(true); });
  };

  if (!open) return null;

  const status = row?.status || 'draft';
  const badge = STATUS_BADGE[status] || { label: status, cls: 'badge-gray' };
  const isLocked = status === 'finalized' || status === 'paid';

  const earningsTotal = sheet ? (sheet.earnings?.basicSalary || 0) + (sheet.earnings?.overtimeAmount || 0) + (sheet.earnings?.bonus || 0) : 0;
  const deductionsTotal = sheet ? (sheet.deductions?.total || 0) + (sheet.deductions?.advances || 0) : 0;

  let diff = null, diffPct = null;
  if (prevSheet) {
    diff = displayNetSalary(sheet?.netSalary) - displayNetSalary(prevSheet.netSalary);
    diffPct = prevSheet.netSalary ? (diff / displayNetSalary(prevSheet.netSalary)) * 100 : null;
  }

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        maxWidth={520}
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span>مراجعة كشف المرتبات — {row?.employee?.name || row?.employeeName || ''}</span>
            <span className={badge.cls} style={{ padding: '2px 9px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
              {isLocked && <Lock style={{ width: 10, height: 10, display: 'inline', verticalAlign: '-1px', marginLeft: 3 }} />}
              {badge.label}
            </span>
          </div>
        }
        footer={
          <div style={{ display: 'flex', gap: 8, width: '100%' }}>
            <button className="btn-secondary text-xs py-1.5 px-3" onClick={() => setAuditOpen(true)}>
              <History className="w-3.5 h-3.5" /> سجل التغييرات
            </button>
            <button className="btn-secondary text-xs py-1.5 px-3" onClick={loadComparison} disabled={prevLoading}>
              {prevLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <TrendingUp className="w-3.5 h-3.5" />}
              مقارنة بالشهر السابق
            </button>
            {/* Phase 20.1: opens the REAL existing Monthly Attendance data
                (GET /attendance/monthly-detail, employeeId-narrowed) for
                this exact employee/month/year — not a new calculation. */}
            <button className="btn-secondary text-xs py-1.5 px-3" onClick={() => setStatementOpen(true)}>
              <CalendarDays className="w-3.5 h-3.5" /> الكشف الشهري الفعلي
            </button>
            <div style={{ flex: 1 }} />
            <button className="btn-primary text-xs py-1.5 px-3" onClick={onClose}>إغلاق</button>
          </div>
        }
      >
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '30px 0', color: 'var(--text-3)' }}>
            <Loader2 style={{ width: 18, height: 18, animation: 'spin 1s linear infinite' }} />
            <span style={{ fontSize: 13 }}>جاري التحميل...</span>
          </div>
        ) : !sheet ? (
          <p style={{ fontSize: 13, color: 'var(--text-3)', textAlign: 'center', padding: '30px 0' }}>تعذر تحميل بيانات هذا الراتب</p>
        ) : (
          <>
            {isLocked && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', marginBottom: 12,
                borderRadius: 8, background: 'var(--accent-soft)', border: '1px solid var(--border)',
                fontSize: 12, color: 'var(--text-2)',
              }}>
                <Lock style={{ width: 14, height: 14, flexShrink: 0, color: 'var(--accent)' }} />
                هذا الراتب {badge.label} — التعديل عليه لا يزال ممكنًا من الجدول، لكنه يتطلب مراجعة متأنية.
              </div>
            )}

            {/* ── Calculation explanation ─────────────────────────────────── */}
            <div style={{ borderRadius: 10, border: '1px solid var(--border)', padding: '12px 14px', background: 'var(--surface-3)' }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>المستحقات</p>
              <Row label="الراتب الأساسي" value={sheet.earnings?.basicSalary} />
              {(sheet.earnings?.overtimeAmount || 0) > 0 && <Row label="الإضافي" value={sheet.earnings.overtimeAmount} />}
              {(sheet.earnings?.bonus || 0) > 0 && <Row label="مكافأة / بدل" value={sheet.earnings.bonus} />}
              <div style={{ borderTop: '1px dashed var(--border)', margin: '4px 0' }} />
              <Row label="إجمالي المستحقات" value={earningsTotal} emphasis />
            </div>

            <div style={{ borderRadius: 10, border: '1px solid var(--border)', padding: '12px 14px', marginTop: 10, background: 'var(--surface-3)' }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>الخصومات</p>
              {(sheet.deductions?.absentAmount || 0) > 0 && <Row label={`الغياب (${fmtIntZero(sheet.deductions.absentDays)} يوم)`} value={sheet.deductions.absentAmount} />}
              {(sheet.deductions?.lateAmount || 0) > 0 && <Row label="التأخير" value={sheet.deductions.lateAmount} />}
              {(sheet.deductions?.earlyAmount || 0) > 0 && <Row label="الانصراف المبكر" value={sheet.deductions.earlyAmount} />}
              {(sheet.deductions?.manualDeductionAdjustment || 0) > 0 && <Row label="خصم إداري" value={sheet.deductions.manualDeductionAdjustment} />}
              {(sheet.deductions?.advances || 0) > 0 && <Row label="السلف" value={sheet.deductions.advances} />}
              {deductionsTotal === 0 && <p style={{ fontSize: 12, color: 'var(--text-3)' }}>لا توجد خصومات</p>}
              <div style={{ borderTop: '1px dashed var(--border)', margin: '4px 0' }} />
              <Row label="إجمالي الخصومات" value={deductionsTotal} emphasis />
            </div>

            {/* ── Formula ──────────────────────────────────────────────────── */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, flexWrap: 'wrap',
              margin: '14px 0', padding: '10px 14px', borderRadius: 10,
              background: 'var(--accent-soft)', fontSize: 12.5, fontWeight: 700, color: 'var(--text-2)',
              fontFamily: 'Consolas,monospace', direction: 'ltr',
            }}>
              <span>{fmtMoney(sheet.earnings?.basicSalary)}</span>
              <span>+</span>
              <span>{fmtMoney(earningsTotal - (sheet.earnings?.basicSalary || 0))}</span>
              <span>−</span>
              <span>{fmtMoney(deductionsTotal)}</span>
              <span>=</span>
              <span style={{ color: 'var(--c-net)', fontSize: 14 }}>{fmtMoney(displayNetSalary(sheet.netSalary))}</span>
            </div>

            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '10px 14px', borderRadius: 10, background: 'var(--surface)',
              border: '2px solid var(--accent)',
            }}>
              <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>صافي الراتب</span>
              <span style={{ fontSize: 18, fontWeight: 800, color: 'var(--c-net)', fontFamily: 'Consolas,monospace' }}>
                {fmtMoney(displayNetSalary(sheet.netSalary))}
              </span>
            </div>

            {/* ── Month comparison ─────────────────────────────────────────── */}
            {showCompare && (
              <div style={{ marginTop: 14, borderRadius: 10, border: '1px solid var(--border)', padding: '12px 14px' }}>
                <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  مقارنة صافي الراتب
                </p>
                {prevSheet === false ? (
                  <p style={{ fontSize: 12, color: 'var(--text-3)' }}>لا تتوفر بيانات مرتب للشهر السابق لهذا الموظف</p>
                ) : prevSheet ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                      {MONTHS_AR[(month - 2 + 12) % 12]}: {' '}
                      <strong style={{ color: 'var(--text-2)' }}>{fmtMoney(displayNetSalary(prevSheet.netSalary))}</strong>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                      {MONTHS_AR[month - 1]}: <strong style={{ color: 'var(--text-2)' }}>{fmtMoney(displayNetSalary(sheet.netSalary))}</strong>
                    </div>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 4, fontSize: 12.5, fontWeight: 700,
                      color: diff > 0 ? 'var(--c-green)' : diff < 0 ? 'var(--c-red)' : 'var(--text-3)',
                    }}>
                      {diff > 0 ? <TrendingUp style={{ width: 13, height: 13 }} /> : diff < 0 ? <TrendingDown style={{ width: 13, height: 13 }} /> : <Minus style={{ width: 13, height: 13 }} />}
                      {diff > 0 ? '+' : ''}{fmtMoney(diff)}
                      {diffPct != null && ` (${diffPct > 0 ? '+' : ''}${diffPct.toFixed(1)}%)`}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </>
        )}
      </Dialog>

      <PayrollAuditDrawer
        payrollId={row?.id}
        employeeName={row?.employee?.name || row?.employeeName}
        open={auditOpen}
        onClose={() => setAuditOpen(false)}
      />

      <EmployeeMonthlyStatementDrawer
        employeeId={empId}
        employeeName={row?.employee?.name || row?.employeeName}
        month={month}
        year={year}
        open={statementOpen}
        onClose={() => setStatementOpen(false)}
      />
    </>
  );
}
