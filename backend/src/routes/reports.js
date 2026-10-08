const router = require('express').Router();
const { sendError } = require('../utils/apiError');
const { getPrisma } = require('../utils/prisma');
const { parsePeriod } = require('../utils/period');
const moment = require('moment');
const XLSX = require('xlsx');
const { authenticate, authorize } = require('../middleware/auth');
const { mergeEffectivePenalty } = require('../engines/attendanceEngine');
const { applyApprovedAdjustment, computePayroll, buildPayrollPreloadMap } = require('../engines/payrollEngine');
const { monthRange } = require('../utils/monthRange');
const { attendanceScopeWhere, monthPeriod } = require('../utils/employmentEligibility');
const prisma = getPrisma();
router.use(authenticate);

// Phase 31 (F1 fix — Phase 25 audit, Critical): these three export routes
// previously required only a valid login, no role check — an employee-role
// account could download the full company payroll or any colleague's
// attendance export. No self-service export UI exists for these, so
// admin/hr only, matching the equivalent write-side routes elsewhere in
// the app (payroll.js, rules.js) which were already correctly gated.
router.use(authorize('admin', 'hr'));

// Monthly attendance report - Excel export
router.get('/attendance/monthly/export', async (req, res) => {
  try {
    const { month, year, branchId, format = 'xlsx' } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year) || new Date().getFullYear();

    const { startDate, endDate } = monthRange(y, m);

    const empWhere = attendanceScopeWhere(monthPeriod(y, m));
    if (branchId) empWhere.branchId = parseInt(branchId);

    const employees = await prisma.employee.findMany({
      where: empWhere,
      include: { department: true, branch: true },
      orderBy: { name: 'asc' },
    });

    // EF-002.1: batch-fetch all employees' daily records + adjustments in 2
    // queries instead of 2 per employee (was 1+2N). Grouping in memory below
    // reconstructs the exact same per-employee `records` array (same rows,
    // same order via sort) the old per-employee query returned.
    const empIds = employees.map(e => e.id);
    const allRecords = empIds.length
      ? await prisma.attendanceDaily.findMany({
          where: { employeeId: { in: empIds }, date: { gte: startDate, lte: endDate } },
          orderBy: { date: 'asc' },
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

    const rows = [];
    for (const emp of employees) {
      const records = recordsByEmployee.get(emp.id) || [];

      const effRecords = records.map(r => mergeEffectivePenalty(applyApprovedAdjustment(r, adjByDailyIdGlobal.get(r.id))));

      // Certification HIGH#3: status-based, matching payrollEngine.js's
      // canonical definition (and routes/attendance.js's /monthly route) —
      // not the isWeekend/isHoliday/isAbsent-flag combination, which
      // silently disagrees with Payroll.workDays whenever a record carries a
      // stale/legacy status value (e.g. the removed 'half_day' status).
      // Counted on the approved-adjustment-aware rows (effRecords), like Payroll / Daily / Movement.
      const workDays = effRecords.filter(r => ['present', 'late', 'early_leave'].includes(r.status)).length;
      const absentDays = effRecords.filter(r => r.isAbsent).length;
      const totalHours = records.reduce((s, r) => s + r.workedMinutes / 60, 0);
      const totalOT = records.reduce((s, r) => s + r.overtimeHours, 0);
      const totalLate = records.reduce((s, r) => s + r.lateMinutes, 0);
      const totalEffectiveOvertimeUnits = effRecords.reduce((s, r) => s + (r.effectiveOvertimeUnits || 0), 0);
      const totalEffectiveDeductionUnits = effRecords.reduce((s, r) => s + (r.effectiveTotalDeductionUnits || 0), 0);

      rows.push({
        'Employee Code': emp.code || '',
        'Employee Name': emp.name,
        'Department': emp.department?.name || '',
        'Branch': emp.branch?.name || '',
        'Work Days': workDays,
        'Absent Days': absentDays,
        'Total Hours': parseFloat(totalHours.toFixed(2)),
        // Canonical financial overtime (Manual Override → Approved Adjustment → Policy Engine)
        'Overtime (Units)': parseFloat(totalEffectiveOvertimeUnits.toFixed(2)),
        // Raw time — analytics only
        'Overtime Hours (Raw)': parseFloat(totalOT.toFixed(2)),
        'Late Minutes (Raw)': totalLate,
        'Total Deduction Units': parseFloat(totalEffectiveDeductionUnits.toFixed(2)),
        'Basic Salary': emp.salary,
      });
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = Object.keys(rows[0] || {}).map(() => ({ wch: 18 }));
    XLSX.utils.book_append_sheet(wb, ws, `Attendance ${m}-${y}`);

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="attendance_${m}_${y}.xlsx"`);
    res.send(buf);
  } catch (err) {
    sendError(res, err);
  }
});

// Payroll report - Excel export
router.get('/payroll/export', async (req, res) => {
  try {
    const { month, year, branchId } = req.query;
    const per = parsePeriod(month, year);
    if (per.error) return res.status(400).json({ error: per.error, code: per.code });
    const m = per.m;
    const y = per.y;

    // branchId filtering pushed into the query itself (was a JS-side
    // .filter() AFTER fetching every branch's payrolls) — same result set,
    // fewer rows ever fetched/decoded when a branch is selected.
    const where = { month: m, year: y };
    if (branchId) where.employee = { branchId: parseInt(branchId) };

    const filtered = await prisma.payroll.findMany({
      where,
      include: { employee: { include: { department: true, branch: true } } },
      orderBy: { employee: { name: 'asc' } },
    });

    // EP-022 Phase 8: this export previously read straight off the stored
    // Payroll row — a write-time snapshot that goes stale the moment
    // attendance changes after the last "احتساب المرتبات" run, exactly the
    // class of bug fixed under EF-017 for GET /payroll. Overlaid fresh here
    // for the same reason: computePayroll() is the single canonical source,
    // so the exported Excel numbers can never diverge from the grid/print.
    //
    // Perf: batch-preload rules/attendance/adjustments/existing-payroll/
    // advances ONCE for the whole export instead of computePayroll()
    // re-issuing its 6 per-employee queries for every row (the same N+1
    // payrollEngine.buildPayrollPreloadMap() was built to eliminate for
    // GET /payroll and calculateMonthlyPayroll — reused verbatim here, not
    // reimplemented). `filtered[i].employee` is already the full Employee
    // row (via the `include` above), so no extra employee query is needed
    // either. Every value computePayroll() returns is byte-for-byte
    // identical either way — this changes only how its inputs are fetched.
    const preloadEmployees = filtered.map(p => p.employee);
    const preloadTargets = filtered.map(p => ({ employeeId: p.employeeId, month: p.month, year: p.year }));
    const preloadMap = await buildPayrollPreloadMap(preloadTargets, preloadEmployees);
    const fresh = await Promise.all(filtered.map(p => computePayroll(p.employeeId, p.month, p.year, {
      preload: preloadMap.get(`${p.employeeId}|${p.month}|${p.year}`),
    })));

    // Column order mirrors the grid's canonical order (EP-022): كود، اسم
    // الموظف، الراتب الأساسي، أجر الساعة، أيام الحضور، الغياب، ساعات
    // الإضافي، قيمة الإضافي، ساعات الخصم، الخصومات، السلف، الخصم الإداري،
    // صافي المرتب (13 canonical columns). Department/Branch (not grid
    // columns) stay after identity; Late Penalty (not among the 13
    // canonical grid columns) is appended after Net Salary rather than
    // interleaved.
    // F-08: money cells carry the canonical Payroll precision (cents), not a
    // whole-unit Math.round. Payroll stores/returns money to the cent; rounding
    // each column to whole units here made Excel disagree with the stored row
    // (e.g. 3237.5 -> 3238) and made basic + OT - deductions - advances differ
    // from Net Salary by +-1 in the same sheet. toFixed(2) also strips the
    // floating-point noise computePayroll() can carry (2594.1899999999996).
    const money2 = (v) => Number((Number(v) || 0).toFixed(2));
    const MONEY_COLS = ['Basic Salary', 'OT Amount', 'Deductions', 'Advances', 'Manual Deduction', 'Net Salary', 'Late Penalty'];
    const rows = filtered.map((p, i) => {
      const c = fresh[i];
      return {
        'Employee Code': p.employee.code || '',
        'Employee Name': p.employee.name,
        'Department': p.employee.department?.name || '',
        'Branch': p.employee.branch?.name || '',
        'Basic Salary': money2(c.basicSalary),
        // Phase 8.2: Hourly Rate is a RATE, not a money total — the canonical
        // presentation policy (EF-012.1, applied in PayrollPage's grid and
        // SalaryCard's fmtRate()) shows it to 2 decimal places, matching
        // payrollEngine.js's computeRates() exact value, not whole-unit
        // Math.round like the money columns around it. This export
        // previously used Math.round() here too, silently disagreeing with
        // the grid/SalaryCard for the same employee/month. Same
        // Number(x).toFixed(2) rounding rule as those two, applied to the
        // same computePayroll() value — no new formatter, no engine change.
        'Hourly Rate': parseFloat((c.hourlyRate || 0).toFixed(2)),
        'Work Days': c.workDays,
        'Absent Days': c.absentDays,
        // Phase 8.3 Task 1: OT Hours is a spreadsheet-calculable numeric
        // column (like its sibling 'Penalty Units' just below, which is also
        // an unrounded hour-unit figure) — not the grid's HH:mm duration
        // string, which is a text format Excel can't sum/average. Kept
        // numeric intentionally; the previous Math.round() here silently
        // dropped a trailing half-hour (e.g. 7.5 → 8) and disagreed with
        // 'Penalty Units' own no-rounding convention in this very row —
        // that rounding is removed so this column carries the same
        // precision as computePayroll() itself, matching 'Penalty Units'.
        'OT Hours': c.overtimeHours || 0,
        'OT Amount': money2(c.overtimeAmount),
        'Penalty Units': c.penaltyUnits || 0,
        'Deductions': money2(c.deductions),
        'Advances': money2(c.advances),
        'Manual Deduction': money2(c.manualDeductionAdjustment),
        'Net Salary': money2(c.netSalary),
        'Late Penalty': money2(c.latePenalty),
      };
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = Object.keys(rows[0] || {}).map(() => ({ wch: 16 }));
    // Show cents in Excel for the money columns (numeric cells, not text).
    const headers = Object.keys(rows[0] || {});
    headers.forEach((h, ci) => {
      if (!MONEY_COLS.includes(h)) return;
      for (let ri = 1; ri <= rows.length; ri++) {
        const cell = ws[XLSX.utils.encode_cell({ r: ri, c: ci })];
        if (cell && cell.t === 'n') cell.z = '#,##0.00';
      }
    });
    XLSX.utils.book_append_sheet(wb, ws, `Payroll ${m}-${y}`);

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="payroll_${m}_${y}.xlsx"`);
    res.send(buf);
  } catch (err) {
    sendError(res, err);
  }
});

// Employee daily detail export
router.get('/attendance/employee/:id/export', async (req, res) => {
  try {
    const { month, year } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year) || new Date().getFullYear();
    const employeeId = parseInt(req.params.id);

    const employee = await prisma.employee.findUnique({ where: { id: employeeId }, include: { department: true } });
    const { startDate, endDate } = monthRange(y, m);

    const records = await prisma.attendanceDaily.findMany({
      where: { employeeId, date: { gte: startDate, lte: endDate } },
      orderBy: { date: 'asc' },
    });

    const rows = records.map(r => ({
      'Date': moment(r.date).format('YYYY-MM-DD'),
      'Day': moment(r.date).format('dddd'),
      'Check In': r.checkIn ? moment(r.checkIn).format('HH:mm') : '-',
      'Check Out': r.checkOut ? moment(r.checkOut).format('HH:mm') : '-',
      'Worked Hours': parseFloat((r.workedMinutes / 60).toFixed(2)),
      'Late (min)': r.lateMinutes,
      'OT Hours': r.overtimeHours,
      'Early Leave (min)': r.earlyLeaveMinutes,
      'Status': r.status,
      'Notes': r.notes || '',
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = Object.keys(rows[0] || {}).map(() => ({ wch: 16 }));
    XLSX.utils.book_append_sheet(wb, ws, employee?.name || 'Employee');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="attendance_${employeeId}_${m}_${y}.xlsx"`);
    res.send(buf);
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
