const { fmtDate, fmtTime } = require('./fastDate');
const { hasVerifiedManualEdit } = require('./manualEditAudit');

// ─── Canonical Attendance Row Builder (Phase 12.1) ────────────────────────────
// Consolidates three previously independent row-shaping implementations that
// had drifted out of sync: GET /attendance/daily's inline map, GET
// /attendance/monthly-detail's inline map, and manual.js's
// buildDailyResponseRow() (used by every PUT /attendance/... response).
// Drift found in the Phase 12 Module 3/4 audit: GET /daily and GET
// /monthly-detail both hardcoded branch/shift to '' instead of fetching them,
// both were missing several fields buildDailyResponseRow already included
// (morningOvertimeHours/eveningOvertimeHours/manualPenaltyReason/
// manualPenaltyByName/manualPenaltyAt/etc — the last three left the Monthly
// grid's manual-override tooltip showing incomplete info until a row was
// individually edited), and GET /daily's absenceType/penaltyDays/
// absenceReason/isAbsent fields lacked the weekend/holiday guard the other
// two already had.
//
// Pure — no DB access. Every existing call site already batches its own
// employee/record/adjustment/verified-manual-edit-id fetching; this function
// only shapes the final row from data the caller already has in hand, so
// consolidating onto it introduces no new query and no N+1.
//
// @param {object} employee - Employee row with department/branch/shift included
// @param {object|null} merged - mergeEffectivePenalty(applyApprovedAdjustment(rec, adj)) result, or null when no AttendanceDaily row exists yet for this employee/date
// @param {string} dateStr - "YYYY-MM-DD" for the row's date; used only when merged is null (no rec.date to read)
// @param {Set<number>} [verifiedManualIds] - from resolveVerifiedManualEditIds()
// @param {object|null} [adj] - the approved AttendanceAdjustment for this record, if any
function buildAttendanceRow({ employee, merged, dateStr, verifiedManualIds, adj }) {
  const isWeekendOrHoliday = !!(merged?.isWeekend || merged?.isHoliday);
  const manualEdit = merged
    ? hasVerifiedManualEdit(merged, verifiedManualIds || new Set(), !!adj)
    : false;

  return {
    id: merged?.id ?? null,
    employeeId: employee.id,
    employeeName: employee.name,
    employeeCode: employee.code,
    department: employee.department?.name || '',
    branch: employee.branch?.name || '',
    shift: employee.shift?.name || '',
    date: merged?.date ? fmtDate(merged.date) : dateStr,
    checkIn: merged?.checkIn ? fmtTime(merged.checkIn) : null,
    checkOut: merged?.checkOut ? fmtTime(merged.checkOut) : null,
    // Preserves the pre-existing type quirk exactly: a record with 0 worked
    // minutes formats to the STRING "0.00"; no record at all yields the
    // NUMBER 0 — this was already true of GET /daily's output before this
    // consolidation and is carried forward unchanged (not a new inconsistency).
    workedHours: merged ? ((merged.workedMinutes || 0) / 60).toFixed(2) : 0,
    workedMinutes: merged?.workedMinutes || 0,
    lateMinutes: merged?.lateMinutes || 0,
    overtimeHours: merged?.overtimeHours || 0,
    overtimeMinutes: merged?.overtimeMinutes || 0,
    morningOvertimeHours: merged?.morningOvertimeHours || 0,
    eveningOvertimeHours: merged?.eveningOvertimeHours || 0,
    earlyLeaveMinutes: merged?.earlyLeaveMinutes || 0,
    latePenaltyUnits: merged?.latePenaltyUnits || 0,
    earlyCheckoutUnits: merged?.earlyCheckoutUnits || 0,
    totalDeductionUnits: merged?.totalDeductionUnits || 0,
    effectiveLatePenalty: merged?.effectiveLatePenalty || 0,
    effectiveEarlyPenalty: merged?.effectiveEarlyPenalty || 0,
    effectiveTotalDeductionUnits: merged?.effectiveTotalDeductionUnits || 0,
    effectiveOvertimeUnits: merged?.effectiveOvertimeUnits || 0,
    hasManualPenalty: merged?.hasManualPenalty || false,
    hasManualOvertime: merged?.hasManualOvertime || false,
    manualLatePenaltyUnits: merged?.manualLatePenaltyUnits ?? null,
    manualEarlyPenaltyUnits: merged?.manualEarlyPenaltyUnits ?? null,
    manualOvertimeUnits: merged?.manualOvertimeUnits ?? null,
    manualPenaltyReason: merged?.manualPenaltyReason ?? null,
    manualPenaltyByName: merged?.manualPenaltyByName ?? null,
    manualPenaltyAt: merged?.manualPenaltyAt ?? null,
    status: merged?.status || 'absent',
    isAbsent: isWeekendOrHoliday ? false : (merged ? (merged.isAbsent ?? (merged.status === 'absent')) : true),
    isWeekend: merged?.isWeekend ?? false,
    isHoliday: merged?.isHoliday ?? false,
    manualEdit,
    absenceType: isWeekendOrHoliday ? null : (merged?.absenceType || null),
    penaltyDays: isWeekendOrHoliday ? null : (merged?.penaltyDays ?? null),
    absenceReason: isWeekendOrHoliday ? null : (merged?.absenceReason || null),
    absenceSetBy: merged?.absenceSetBy || null,
    absenceSetAt: merged?.absenceSetAt ?? null,
    isMonitored: employee.isMonitored || false,
    monitorColor: employee.monitorColor || null,
  };
}

module.exports = { buildAttendanceRow };
