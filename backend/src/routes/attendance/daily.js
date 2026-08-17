const router = require('express').Router();
const { getPrisma } = require('../../utils/prisma');
const moment = require('moment');
const { mergeEffectivePenalty } = require('../../engines/attendanceEngine');
const { applyApprovedAdjustment } = require('../../engines/payrollEngine');
const { resolveVerifiedManualEditIds } = require('../../utils/manualEditAudit');
const { buildAttendanceRow } = require('../../utils/attendanceRow');

const prisma = getPrisma();

// Perf Batch 1 (Fix #5): same trim as attendance/monthly.js's
// MONTHLY_DETAIL_EMPLOYEE_SELECT — only the fields buildAttendanceRow()
// actually reads off the employee row, instead of `include: true` hydrating
// every column on Employee plus full Department/Branch/Shift rows on every
// request to this endpoint (the default landing screen / most-polled route).
const DAILY_EMPLOYEE_SELECT = {
  id: true, name: true, code: true, isMonitored: true, monitorColor: true,
  department: { select: { name: true } },
  branch: { select: { name: true } },
  shift: { select: { name: true } },
};

// Get daily attendance (for AG Grid)
router.get('/daily', async (req, res) => {
  try {
    const { date, branchId, departmentId, employeeId } = req.query;
    const targetDate = date ? new Date(date) : new Date();
    const d = new Date(moment(targetDate).format('YYYY-MM-DD'));

    let empWhere = { status: true };
    if (branchId) empWhere.branchId = parseInt(branchId);
    if (departmentId) empWhere.departmentId = parseInt(departmentId);
    // EP-014: optional narrowing for realtime single-row refresh — omitted by
    // every existing caller (initial load, filters), who see identical results.
    if (employeeId) empWhere.id = parseInt(employeeId);

    const employees = await prisma.employee.findMany({
      where: empWhere,
      select: DAILY_EMPLOYEE_SELECT,
    });

    const empIds = employees.map(e => e.id);
    const records = await prisma.attendanceDaily.findMany({
      where: { date: d, employeeId: { in: empIds } },
      // Perf Batch 1 (Fix #5): same trim as attendance/monthly.js's explicit
      // select — every field buildAttendanceRow()/mergeEffectivePenalty()/
      // applyApprovedAdjustment() actually reads off an AttendanceDaily row
      // on this response path, and nothing else (trims createdAt/updatedAt/
      // conditionDeductionUnits/manualConditionUnits, none of which are read
      // here, off the ORM row-hydration cost).
      select: {
        id: true, employeeId: true, date: true, checkIn: true, checkOut: true,
        workedMinutes: true, lateMinutes: true, overtimeMinutes: true, overtimeHours: true,
        earlyLeaveMinutes: true, isAbsent: true, isHoliday: true, isWeekend: true, status: true,
        manualEdit: true, earlyCheckoutUnits: true, eveningOvertimeHours: true,
        latePenaltyUnits: true, morningOvertimeHours: true, totalDeductionUnits: true,
        manualEarlyPenaltyUnits: true, manualLatePenaltyUnits: true, manualPenaltyAt: true,
        manualPenaltyBy: true, manualPenaltyByName: true, manualPenaltyReason: true,
        manualOvertimeUnits: true, overtimeRulesUnits: true, absenceType: true,
        penaltyDays: true, absenceReason: true, absenceSetBy: true, absenceSetAt: true,
      },
    });

    const recordIds = records.map(r => r.id);
    const adjustments = await prisma.attendanceAdjustment.findMany({
      where: { attendanceDailyId: { in: recordIds }, approvalStatus: 'approved' },
    });
    const adjByDailyId = new Map(adjustments.map(a => [a.attendanceDailyId, a]));

    const map = new Map(records.map(r => [r.employeeId, mergeEffectivePenalty(applyApprovedAdjustment(r, adjByDailyId.get(r.id)))]));

    // EF-014: resolve manualEdit against real evidence — see resolveVerifiedManualEditIds.
    const verifiedManualIds = await resolveVerifiedManualEditIds(records.filter(r => r.manualEdit).map(r => r.id));

    const dateStr = moment(d).format('YYYY-MM-DD');
    const result = employees.map(emp => {
      const merged = map.get(emp.id) || null;
      return buildAttendanceRow({
        employee: emp,
        merged,
        dateStr,
        verifiedManualIds,
        adj: merged ? adjByDailyId.get(merged.id) : null,
      });
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
