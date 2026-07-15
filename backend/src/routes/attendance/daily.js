const router = require('express').Router();
const { getPrisma } = require('../../utils/prisma');
const moment = require('moment');
const { mergeEffectivePenalty } = require('../../engines/attendanceEngine');
const { applyApprovedAdjustment } = require('../../engines/payrollEngine');
const { resolveVerifiedManualEditIds, hasVerifiedManualEdit } = require('../../utils/manualEditAudit');

const prisma = getPrisma();

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
      include: { department: true },
    });

    const empIds = employees.map(e => e.id);
    const records = await prisma.attendanceDaily.findMany({
      where: { date: d, employeeId: { in: empIds } },
    });

    const recordIds = records.map(r => r.id);
    const adjustments = await prisma.attendanceAdjustment.findMany({
      where: { attendanceDailyId: { in: recordIds }, approvalStatus: 'approved' },
    });
    const adjByDailyId = new Map(adjustments.map(a => [a.attendanceDailyId, a]));

    const map = new Map(records.map(r => [r.employeeId, mergeEffectivePenalty(applyApprovedAdjustment(r, adjByDailyId.get(r.id)))]));

    // EF-014: resolve manualEdit against real evidence — see resolveVerifiedManualEditIds.
    const verifiedManualIds = await resolveVerifiedManualEditIds(records.filter(r => r.manualEdit).map(r => r.id));

    const result = employees.map(emp => {
      const rec = map.get(emp.id);
      return {
        employeeId: emp.id,
        employeeName: emp.name,
        employeeCode: emp.code,
        department: emp.department?.name || '',
        branch: '',
        shift: '',
        date: moment(d).format('YYYY-MM-DD'),
        checkIn: rec?.checkIn ? moment(rec.checkIn).format('HH:mm') : null,
        checkOut: rec?.checkOut ? moment(rec.checkOut).format('HH:mm') : null,
        workedHours: rec ? (rec.workedMinutes / 60).toFixed(2) : 0,
        workedMinutes: rec?.workedMinutes || 0,
        lateMinutes: rec?.lateMinutes || 0,
        overtimeHours: rec?.overtimeHours || 0,
        overtimeMinutes: rec?.overtimeMinutes || 0,
        earlyLeaveMinutes: rec?.earlyLeaveMinutes || 0,
        latePenaltyUnits: rec?.latePenaltyUnits || 0,
        earlyCheckoutUnits: rec?.earlyCheckoutUnits || 0,
        totalDeductionUnits: rec?.totalDeductionUnits || 0,
        effectiveLatePenalty: rec?.effectiveLatePenalty || 0,
        effectiveEarlyPenalty: rec?.effectiveEarlyPenalty || 0,
        effectiveTotalDeductionUnits: rec?.effectiveTotalDeductionUnits || 0,
        effectiveOvertimeUnits: rec?.effectiveOvertimeUnits || 0,
        hasManualPenalty: rec?.hasManualPenalty || false,
        hasManualOvertime: rec?.hasManualOvertime || false,
        manualLatePenaltyUnits: rec?.manualLatePenaltyUnits ?? null,
        manualEarlyPenaltyUnits: rec?.manualEarlyPenaltyUnits ?? null,
        manualOvertimeUnits: rec?.manualOvertimeUnits ?? null,
        manualPenaltyReason: rec?.manualPenaltyReason ?? null,
        manualPenaltyByName: rec?.manualPenaltyByName ?? null,
        manualPenaltyAt: rec?.manualPenaltyAt ?? null,
        status: rec?.status || 'absent',
        isAbsent: rec?.isAbsent ?? true,
        isWeekend: rec?.isWeekend ?? false,
        isHoliday: rec?.isHoliday ?? false,
        manualEdit: rec ? hasVerifiedManualEdit(rec, verifiedManualIds, !!adjByDailyId.get(rec.id)) : false,
        id: rec?.id || null,
        absenceType: rec?.absenceType || null,
        penaltyDays: rec?.penaltyDays ?? null,
        absenceReason: rec?.absenceReason || null,
        absenceSetBy: rec?.absenceSetBy || null,
        absenceSetAt: rec?.absenceSetAt || null,
        isMonitored: emp.isMonitored || false,
        monitorColor: emp.monitorColor || null,
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
