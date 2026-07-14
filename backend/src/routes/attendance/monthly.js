const router = require('express').Router();
const { getPrisma } = require('../../utils/prisma');
const moment = require('moment');
const { mergeEffectivePenalty } = require('../../engines/attendanceEngine');
const { applyApprovedAdjustment } = require('../../engines/payrollEngine');
const { monthRange } = require('../../utils/monthRange');
const { resolveVerifiedManualEditIds, hasVerifiedManualEdit } = require('../../utils/manualEditAudit');

const prisma = getPrisma();

// Get monthly attendance for an employee
router.get('/monthly', async (req, res) => {
  try {
    const { month, year, branchId, departmentId } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year) || new Date().getFullYear();

    const { startDate, endDate } = monthRange(y, m);

    let empWhere = { status: true };
    if (branchId) empWhere.branchId = parseInt(branchId);
    if (departmentId) empWhere.departmentId = parseInt(departmentId);

    const employees = await prisma.employee.findMany({
      where: empWhere,
      include: { department: true, branch: true },
    });

    // EF-002.1: batch-fetch all employees' daily records + adjustments in 2
    // queries instead of 2 per employee (was 1+2N). Grouping in memory below
    // reconstructs the exact same per-employee `records` array the old
    // per-employee query returned — same rows, same fields, same filters.
    const empIds = employees.map(e => e.id);
    const allRecords = empIds.length
      ? await prisma.attendanceDaily.findMany({
          where: { employeeId: { in: empIds }, date: { gte: startDate, lte: endDate } },
        })
      : [];
    const recordsByEmployee = new Map();
    for (const r of allRecords) {
      if (!recordsByEmployee.has(r.employeeId)) recordsByEmployee.set(r.employeeId, []);
      recordsByEmployee.get(r.employeeId).push(r);
    }
    const allRecordIds = allRecords.map(r => r.id);
    const allAdjustments = allRecordIds.length
      ? await prisma.attendanceAdjustment.findMany({
          where: { attendanceDailyId: { in: allRecordIds }, approvalStatus: 'approved' },
        })
      : [];
    const adjByDailyIdGlobal = new Map(allAdjustments.map(a => [a.attendanceDailyId, a]));

    const results = [];
    for (const emp of employees) {
      const records = recordsByEmployee.get(emp.id) || [];

      const effRecords = records.map(r => mergeEffectivePenalty(applyApprovedAdjustment(r, adjByDailyIdGlobal.get(r.id))));

      // Same filter as payrollEngine.js:124 — status-based, not isAbsent flag.
      // Fixes workDays discrepancy between /monthly route and payroll calculations.
      const workDays = records.filter(r => ['present', 'late', 'early_leave'].includes(r.status)).length;
      const absentDays = records.filter(r => r.isAbsent).length;
      const totalHours = records.reduce((s, r) => s + r.workedMinutes / 60, 0);
      const totalOT = records.reduce((s, r) => s + r.overtimeHours, 0);
      const totalLate = records.reduce((s, r) => s + r.lateMinutes, 0);
      const totalEffectiveOvertimeUnits = effRecords.reduce((s, r) => s + (r.effectiveOvertimeUnits || 0), 0);
      const totalEffectiveLatePenalty = effRecords.reduce((s, r) => s + (r.effectiveLatePenalty || 0), 0);
      const totalEffectiveEarlyPenalty = effRecords.reduce((s, r) => s + (r.effectiveEarlyPenalty || 0), 0);
      const totalEffectiveDeductionUnits = effRecords.reduce((s, r) => s + (r.effectiveTotalDeductionUnits || 0), 0);

      results.push({
        employeeId: emp.id,
        employeeName: emp.name,
        employeeCode: emp.code,
        department: emp.department?.name || '',
        branch: emp.branch?.name || '',
        workDays,
        absentDays,
        totalHours: totalHours.toFixed(2),
        // Raw OT hours — analytics only. Canonical financial figure is
        // `totalEffectiveOvertimeUnits` (Manual Override → Approved Adjustment → Policy Engine).
        totalOvertimeHours: totalOT.toFixed(2),
        totalEffectiveOvertimeUnits: parseFloat(totalEffectiveOvertimeUnits.toFixed(2)),
        totalLateMinutes: totalLate,
        totalEffectiveLatePenalty: parseFloat(totalEffectiveLatePenalty.toFixed(2)),
        totalEffectiveEarlyPenalty: parseFloat(totalEffectiveEarlyPenalty.toFixed(2)),
        totalEffectiveDeductionUnits: parseFloat(totalEffectiveDeductionUnits.toFixed(2)),
        salary: emp.salary,
        isMonitored: emp.isMonitored || false,
        monitorColor: emp.monitorColor || null,
      });
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Monthly detail — all employees × all days for a given month.
// Flat list sorted by employee name then date; used by the Excel-like editing grid.
router.get('/monthly-detail', async (req, res) => {
  try {
    const { month, year, branchId, departmentId } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year) || new Date().getFullYear();

    const { startDate, endDate } = monthRange(y, m);

    const empWhere = { status: true };
    if (branchId)     empWhere.branchId     = parseInt(branchId);
    if (departmentId) empWhere.departmentId = parseInt(departmentId);

    const employees = await prisma.employee.findMany({
      where:   empWhere,
      include: { department: true },
      orderBy: { name: 'asc' },
    });

    if (!employees.length) return res.json([]);

    const empIds = employees.map(e => e.id);
    const records = await prisma.attendanceDaily.findMany({
      where:    { date: { gte: startDate, lte: endDate }, employeeId: { in: empIds } },
      orderBy:  [{ employeeId: 'asc' }, { date: 'asc' }],
    });

    const recordIds = records.map(r => r.id);
    const adjustments = await prisma.attendanceAdjustment.findMany({
      where: { attendanceDailyId: { in: recordIds }, approvalStatus: 'approved' },
    });
    const adjByDailyId = new Map(adjustments.map(a => [a.attendanceDailyId, a]));
    const empMap = new Map(employees.map(e => [e.id, e]));
    // EF-014: resolve manualEdit against real evidence — see resolveVerifiedManualEditIds.
    const verifiedManualIds = await resolveVerifiedManualEditIds(records.filter(r => r.manualEdit).map(r => r.id));

    const result = records.map(r => {
      const eff = mergeEffectivePenalty(applyApprovedAdjustment(r, adjByDailyId.get(r.id)));
      const emp = empMap.get(r.employeeId);
      return {
        id:             r.id,
        employeeId:     r.employeeId,
        employeeCode:   emp?.code   || '',
        employeeName:   emp?.name   || '',
        department:     emp?.department?.name || '',
        branch:         '',
        date:           moment(r.date).format('YYYY-MM-DD'),
        checkIn:        r.checkIn  ? moment(r.checkIn).format('HH:mm')  : null,
        checkOut:       r.checkOut ? moment(r.checkOut).format('HH:mm') : null,
        workedMinutes:  r.workedMinutes    || 0,
        lateMinutes:    r.lateMinutes      || 0,
        overtimeHours:  r.overtimeHours    || 0,
        earlyLeaveMinutes: r.earlyLeaveMinutes || 0,
        effectiveLatePenalty:        eff.effectiveLatePenalty        || 0,
        effectiveEarlyPenalty:       eff.effectiveEarlyPenalty       || 0,
        effectiveOvertimeUnits:      eff.effectiveOvertimeUnits      || 0,
        effectiveTotalDeductionUnits:eff.effectiveTotalDeductionUnits || 0,
        hasManualPenalty:   eff.hasManualPenalty   || false,
        hasManualOvertime:  eff.hasManualOvertime  || false,
        manualLatePenaltyUnits:  r.manualLatePenaltyUnits  ?? null,
        manualEarlyPenaltyUnits: r.manualEarlyPenaltyUnits ?? null,
        manualOvertimeUnits:     r.manualOvertimeUnits     ?? null,
        status:    r.status    || 'absent',
        isAbsent:  (r.isWeekend || r.isHoliday) ? false : (r.isAbsent ?? (r.status === 'absent')),
        isWeekend: r.isWeekend ?? false,
        isHoliday: r.isHoliday ?? false,
        manualEdit: hasVerifiedManualEdit(r, verifiedManualIds, !!adjByDailyId.get(r.id)),
        absenceType:   (r.isWeekend || r.isHoliday) ? null : (r.absenceType   || null),
        penaltyDays:   (r.isWeekend || r.isHoliday) ? null : (r.penaltyDays   ?? null),
        absenceReason: (r.isWeekend || r.isHoliday) ? null : (r.absenceReason || null),
        absenceSetBy:  r.absenceSetBy  || null,
        absenceSetAt:  r.absenceSetAt  ?? null,
        isMonitored: emp?.isMonitored || false,
        monitorColor: emp?.monitorColor || null,
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get employee monthly detail (per day breakdown)
router.get('/employee/:id/monthly', async (req, res) => {
  try {
    const { month, year } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year) || new Date().getFullYear();
    const employeeId = parseInt(req.params.id);

    const { startDate, endDate } = monthRange(y, m);

    const records = await prisma.attendanceDaily.findMany({
      where: { employeeId, date: { gte: startDate, lte: endDate } },
      orderBy: { date: 'asc' },
    });

    res.json(records.map(r => ({
      ...r,
      checkIn: r.checkIn ? moment(r.checkIn).format('HH:mm') : null,
      checkOut: r.checkOut ? moment(r.checkOut).format('HH:mm') : null,
      date: moment(r.date).format('YYYY-MM-DD'),
      workedHours: (r.workedMinutes / 60).toFixed(2),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
