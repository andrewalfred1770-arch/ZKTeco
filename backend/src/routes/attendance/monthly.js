const router = require('express').Router();
const { getPrisma } = require('../../utils/prisma');
const moment = require('moment');
const { mergeEffectivePenalty } = require('../../engines/attendanceEngine');
const { applyApprovedAdjustment } = require('../../engines/payrollEngine');
const { monthRange, getEffectiveMonthEndDate } = require('../../utils/monthRange');
const { resolveVerifiedManualEditIds } = require('../../utils/manualEditAudit');
const { buildAttendanceRow } = require('../../utils/attendanceRow');
const { pLimit } = require('../../utils/pLimit');

const prisma = getPrisma();

// Phase 24.2: same root cause as Phase 24.1's payroll fix — each request to
// these routes fires 3-4 findMany() calls (employees, attendanceDaily,
// attendanceAdjustment, manualEditAuditLog), all issued via Promise.all-style
// concurrent awaits. With several of these requests in flight at once (e.g.
// concurrency=50 against 1,000+ employees), that's 150-200+ simultaneous
// pool checkouts against a 13-connection Prisma pool — measured live:
// 100% pool-timeout failures ("Timed out fetching a new connection") at
// concurrency=50 before this fix. Bounding the query burst through one
// shared, module-level (process-wide, not per-request) limiter keeps the
// pool from ever being oversubscribed, mirroring payroll.js's approach.
const ATTENDANCE_QUERY_CONCURRENCY = parseInt(process.env.ATTENDANCE_QUERY_CONCURRENCY, 10) || 15;
const attendanceQueryLimit = pLimit(ATTENDANCE_QUERY_CONCURRENCY);

// Fields buildAttendanceRow()/the /monthly summary loop actually read off the
// employee row — trims the previous `include: true` (every column on
// Employee + full Department/Branch/Shift rows) down to what's used, cutting
// both query time and response-shaping payload per employee.
const MONTHLY_DETAIL_EMPLOYEE_SELECT = {
  id: true, name: true, code: true, isMonitored: true, monitorColor: true,
  department: { select: { name: true } },
  branch: { select: { name: true } },
  shift: { select: { name: true } },
};
const MONTHLY_SUMMARY_EMPLOYEE_SELECT = {
  id: true, name: true, code: true, salary: true, isMonitored: true, monitorColor: true,
  department: { select: { name: true } },
  branch: { select: { name: true } },
};

// Get monthly attendance for an employee
router.get('/monthly', async (req, res) => {
  try {
    const { month, year, branchId, departmentId, employeeId } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year) || new Date().getFullYear();

    const { startDate, endDate } = monthRange(y, m);

    let empWhere = { status: true };
    if (branchId) empWhere.branchId = parseInt(branchId);
    if (departmentId) empWhere.departmentId = parseInt(departmentId);
    // EP-014: optional narrowing for realtime single-row refresh — omitted by
    // every existing caller (initial load, filters), who see identical results.
    if (employeeId) empWhere.id = parseInt(employeeId);

    const employees = await attendanceQueryLimit(() => prisma.employee.findMany({
      where: empWhere,
      select: MONTHLY_SUMMARY_EMPLOYEE_SELECT,
    }));

    // EF-002.1: batch-fetch all employees' daily records + adjustments in 2
    // queries instead of 2 per employee (was 1+2N). Grouping in memory below
    // reconstructs the exact same per-employee `records` array the old
    // per-employee query returned — same rows, same fields, same filters.
    const empIds = employees.map(e => e.id);
    const allRecords = empIds.length
      ? await attendanceQueryLimit(() => prisma.attendanceDaily.findMany({
          where: { employeeId: { in: empIds }, date: { gte: startDate, lte: endDate } },
        }))
      : [];
    const recordsByEmployee = new Map();
    for (const r of allRecords) {
      if (!recordsByEmployee.has(r.employeeId)) recordsByEmployee.set(r.employeeId, []);
      recordsByEmployee.get(r.employeeId).push(r);
    }
    const allRecordIds = allRecords.map(r => r.id);
    const allAdjustments = allRecordIds.length
      ? await attendanceQueryLimit(() => prisma.attendanceAdjustment.findMany({
          where: { attendanceDailyId: { in: allRecordIds }, approvalStatus: 'approved' },
        }))
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
    const { month, year, branchId, departmentId, employeeId } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year) || new Date().getFullYear();

    // Phase 23.4: a day that hasn't happened yet has no attendance to show —
    // clamp the query itself (not a post-filter) to MIN(endOfMonth, today),
    // so this single query result — which the statement drawer's table, its
    // KPI totals, and its print output all derive from with no further
    // refetch — can never disagree, and no future-dated row (however it got
    // into the table) can surface here regardless of month/date-boundary
    // math elsewhere. For a future month this naturally yields an empty
    // result (see getEffectiveMonthEndDate), matching the existing "لا توجد
    // بيانات حضور لهذا الشهر" empty state — no separate future-month branch needed.
    const { startDate } = monthRange(y, m);
    const endDate = getEffectiveMonthEndDate(y, m);

    const empWhere = { status: true };
    if (branchId)     empWhere.branchId     = parseInt(branchId);
    if (departmentId) empWhere.departmentId = parseInt(departmentId);
    // EP-014: optional narrowing for realtime single-row refresh — omitted by
    // every existing caller (initial load, filters), who see identical results.
    if (employeeId)   empWhere.id           = parseInt(employeeId);

    const employees = await attendanceQueryLimit(() => prisma.employee.findMany({
      where:   empWhere,
      select:  MONTHLY_DETAIL_EMPLOYEE_SELECT,
      orderBy: { name: 'asc' },
    }));

    if (!employees.length) return res.json([]);

    const empIds = employees.map(e => e.id);
    const records = startDate <= endDate
      ? await attendanceQueryLimit(() => prisma.attendanceDaily.findMany({
          where:    { date: { gte: startDate, lte: endDate }, employeeId: { in: empIds } },
          orderBy:  [{ employeeId: 'asc' }, { date: 'asc' }],
          // Phase 24.2: explicit select — trims createdAt/updatedAt/
          // conditionDeductionUnits/manualConditionUnits (none read by
          // buildAttendanceRow, mergeEffectivePenalty, or
          // applyApprovedAdjustment on this response path) off the ORM
          // row-hydration cost for what can be tens of thousands of rows
          // per request. Every field buildAttendanceRow/mergeEffectivePenalty/
          // applyApprovedAdjustment actually reads is still selected below.
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
        }))
      : [];

    const recordIds = records.map(r => r.id);
    const adjustments = await attendanceQueryLimit(() => prisma.attendanceAdjustment.findMany({
      where: { attendanceDailyId: { in: recordIds }, approvalStatus: 'approved' },
    }));
    const adjByDailyId = new Map(adjustments.map(a => [a.attendanceDailyId, a]));
    const empMap = new Map(employees.map(e => [e.id, e]));
    // EF-014: resolve manualEdit against real evidence — see resolveVerifiedManualEditIds.
    const verifiedManualIds = await attendanceQueryLimit(() => resolveVerifiedManualEditIds(records.filter(r => r.manualEdit).map(r => r.id)));

    const result = records.map(r => {
      const adj = adjByDailyId.get(r.id);
      const merged = mergeEffectivePenalty(applyApprovedAdjustment(r, adj));
      // Defensive: preserves the pre-existing `emp?.` fallback behavior this
      // route already had — an orphaned record whose employee vanished
      // mid-request still yields a row with blank identity fields instead
      // of throwing.
      const emp = empMap.get(r.employeeId) || { id: r.employeeId, name: '', code: '' };
      return buildAttendanceRow({ employee: emp, merged, verifiedManualIds, adj });
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
