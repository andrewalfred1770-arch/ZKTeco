const router = require('express').Router();
const { getPrisma } = require('../utils/prisma');
const moment = require('moment');
const XLSX = require('xlsx');
const { authenticate, authorize } = require('../middleware/auth');
const { mergeEffectivePenalty } = require('../engines/attendanceEngine');
const { applyApprovedAdjustment, computePayroll } = require('../engines/payrollEngine');
const { monthRange } = require('../utils/monthRange');
const prisma = getPrisma();
router.use(authenticate);

// Monthly attendance report - Excel export
router.get('/attendance/monthly/export', async (req, res) => {
  try {
    const { month, year, branchId, format = 'xlsx' } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year) || new Date().getFullYear();

    const { startDate, endDate } = monthRange(y, m);

    const empWhere = { status: true };
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
      const workDays = records.filter(r => ['present', 'late', 'early_leave'].includes(r.status)).length;
      const absentDays = records.filter(r => r.isAbsent).length;
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
    res.status(500).json({ error: err.message });
  }
});

// Payroll report - Excel export
router.get('/payroll/export', async (req, res) => {
  try {
    const { month, year, branchId } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year) || new Date().getFullYear();

    const payrolls = await prisma.payroll.findMany({
      where: { month: m, year: y },
      include: { employee: { include: { department: true, branch: true } } },
      orderBy: { employee: { name: 'asc' } },
    });

    let filtered = payrolls;
    if (branchId) filtered = filtered.filter(p => p.employee.branchId === parseInt(branchId));

    // EP-022 Phase 8: this export previously read straight off the stored
    // Payroll row — a write-time snapshot that goes stale the moment
    // attendance changes after the last "احتساب المرتبات" run, exactly the
    // class of bug fixed under EF-017 for GET /payroll. Overlaid fresh here
    // for the same reason: computePayroll() is the single canonical source,
    // so the exported Excel numbers can never diverge from the grid/print.
    const fresh = await Promise.all(filtered.map(p => computePayroll(p.employeeId, p.month, p.year)));

    // Column order mirrors the grid's canonical order (EP-022): كود، اسم
    // الموظف، الراتب الأساسي، أجر الساعة، أيام الحضور، الغياب، ساعات
    // الإضافي، قيمة الإضافي، ساعات الخصم، الخصومات، السلف، الخصم الإداري،
    // صافي المرتب (13 canonical columns). Department/Branch (not grid
    // columns) stay after identity; Late Penalty (not among the 13
    // canonical grid columns) is appended after Net Salary rather than
    // interleaved.
    const rows = filtered.map((p, i) => {
      const c = fresh[i];
      return {
        'Employee Code': p.employee.code || '',
        'Employee Name': p.employee.name,
        'Department': p.employee.department?.name || '',
        'Branch': p.employee.branch?.name || '',
        'Basic Salary': Math.round(c.basicSalary || 0),
        'Hourly Rate': Math.round(c.hourlyRate || 0),
        'Work Days': c.workDays,
        'Absent Days': c.absentDays,
        'OT Hours': Math.round(c.overtimeHours || 0),
        'OT Amount': Math.round(c.overtimeAmount || 0),
        'Penalty Units': c.penaltyUnits || 0,
        'Deductions': Math.round(c.deductions || 0),
        'Advances': Math.round(c.advances || 0),
        'Manual Deduction': Math.round(c.manualDeductionAdjustment || 0),
        'Net Salary': Math.round(c.netSalary || 0),
        'Late Penalty': Math.round(c.latePenalty || 0),
      };
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = Object.keys(rows[0] || {}).map(() => ({ wch: 16 }));
    XLSX.utils.book_append_sheet(wb, ws, `Payroll ${m}-${y}`);

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="payroll_${m}_${y}.xlsx"`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
