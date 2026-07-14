/**
 * live-validation-report.js — READ-ONLY diagnostic dump for the Rules Engine
 * live certification. Does not write anything. Run with:
 *   node scripts/live-validation-report.js
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const moment = require('moment');

const TARGET_KEYS = [
  'weekend_days', 'friday_is_weekend', 'checkin_window_start', 'checkin_window_end',
  'weekend_work_multiplier', 'late_penalty_per_minute', 'half_day_deduction', 'early_leave_penalty',
];

async function main() {
  const out = {};

  // ── 1. Rule table — target keys ────────────────────────────────────────────
  out.rules = await prisma.rule.findMany({
    where: { key: { in: TARGET_KEYS } },
    select: { id: true, key: true, name: true, value: true, type: true, isActive: true, priority: true, updatedAt: true },
    orderBy: { key: 'asc' },
  });

  // ── 2. Recent audit entries for target keys ─────────────────────────────────
  out.recentAudits = await prisma.ruleAudit.findMany({
    where: { ruleKey: { in: TARGET_KEYS } },
    orderBy: { changedAt: 'desc' },
    take: 15,
  });

  // ── 3. Legacy AttendanceRule table — any global rows for target keys? ───────
  out.legacyGlobalRows = await prisma.attendanceRule.findMany({
    where: { ruleKey: { in: TARGET_KEYS }, branchId: null, departmentId: null, employeeId: null },
  });
  out.legacyScopedRows = await prisma.attendanceRule.findMany({
    where: { ruleKey: { in: TARGET_KEYS }, NOT: { branchId: null, departmentId: null, employeeId: null } },
  });

  // ── 4. attendance_logs source breakdown ─────────────────────────────────────
  out.logSourceCounts = await prisma.attendanceLog.groupBy({
    by: ['source'],
    _count: { _all: true },
    _max: { timestamp: true },
    _min: { timestamp: true },
  });
  out.realtimeLogs = await prisma.attendanceLog.findMany({
    where: { source: 'device-realtime' },
    orderBy: { timestamp: 'desc' },
    take: 10,
    include: { employee: { select: { id: true, name: true, code: true } } },
  });

  // ── 5. Friday rows in attendance_daily (2025-2026) ──────────────────────────
  const allDaily = await prisma.attendanceDaily.findMany({
    where: { date: { gte: new Date('2025-01-01'), lte: new Date('2026-12-31') } },
    select: { id: true, employeeId: true, date: true, status: true, isWeekend: true, isHoliday: true, isAbsent: true, checkIn: true, checkOut: true, manualEdit: true, overtimeHours: true, lateMinutes: true },
  });

  function dow(d) { return moment(d).day(); } // 0=Sun..6=Sat

  const fridays = allDaily.filter(r => dow(r.date) === 5);
  const saturdays = allDaily.filter(r => dow(r.date) === 6);
  const sundays = allDaily.filter(r => dow(r.date) === 0);

  function summarize(rows) {
    const byStatus = {};
    let weekendTrue = 0, weekendFalse = 0;
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      if (r.isWeekend) weekendTrue++; else weekendFalse++;
    }
    return { total: rows.length, byStatus, isWeekendTrue: weekendTrue, isWeekendFalse: weekendFalse };
  }

  out.fridaySummary = summarize(fridays);
  out.saturdaySummary = summarize(saturdays);
  out.sundaySummary = summarize(sundays);

  out.fridaySample = fridays.slice(0, 8).map(r => ({ ...r, date: moment(r.date).format('YYYY-MM-DD') }));
  out.sundaySample = sundays.slice(0, 8).map(r => ({ ...r, date: moment(r.date).format('YYYY-MM-DD') }));
  out.saturdaySample = saturdays.slice(0, 8).map(r => ({ ...r, date: moment(r.date).format('YYYY-MM-DD') }));

  // distinct Friday dates with non-weekend status (i.e. processed as workday)
  out.fridayWorkdayDates = [...new Set(fridays.filter(r => !r.isWeekend).map(r => moment(r.date).format('YYYY-MM-DD')))].sort();
  out.fridayWeekendDates = [...new Set(fridays.filter(r => r.isWeekend).map(r => moment(r.date).format('YYYY-MM-DD')))].sort();

  // ── 6. Check-in window evidence ──────────────────────────────────────────────
  // A. normal morning checkIn (05:00-12:00)
  out.normalCheckInSample = allDaily.filter(r => r.checkIn && !r.manualEdit).slice(0, 0); // placeholder, refine below
  const withCheckin = allDaily.filter(r => r.checkIn);
  out.normalCheckInSample = withCheckin.slice(0, 5).map(r => ({
    employeeId: r.employeeId, date: moment(r.date).format('YYYY-MM-DD'),
    checkIn: moment(r.checkIn).format('HH:mm'), checkOut: r.checkOut ? moment(r.checkOut).format('HH:mm') : null,
    status: r.status,
  }));

  // B. checkout-only days: checkIn=null, checkOut set
  const checkoutOnly = allDaily.filter(r => !r.checkIn && r.checkOut);
  out.checkoutOnlySample = checkoutOnly.slice(0, 8).map(r => ({
    employeeId: r.employeeId, date: moment(r.date).format('YYYY-MM-DD'),
    checkIn: r.checkIn, checkOut: moment(r.checkOut).format('HH:mm'), status: r.status, isAbsent: r.isAbsent,
  }));
  out.checkoutOnlyCount = checkoutOnly.length;

  // ── 7. manualEdit rows ────────────────────────────────────────────────────
  const manualRows = allDaily.filter(r => r.manualEdit);
  out.manualEditCount = manualRows.length;
  out.manualEditSample = manualRows.slice(0, 5).map(r => ({
    employeeId: r.employeeId, date: moment(r.date).format('YYYY-MM-DD'), status: r.status,
    checkIn: r.checkIn ? moment(r.checkIn).format('HH:mm') : null, checkOut: r.checkOut ? moment(r.checkOut).format('HH:mm') : null,
  }));

  // ── 8. Payroll — current month ──────────────────────────────────────────────
  const now = moment();
  out.currentMonth = { month: now.month() + 1, year: now.year() };
  out.payrollSample = await prisma.payroll.findMany({
    where: { month: now.month() + 1, year: now.year() },
    include: { employee: { select: { id: true, name: true, salary: true } } },
    orderBy: { employeeId: 'asc' },
    take: 8,
  });

  // ── 9. historical_rebuild_jobs ───────────────────────────────────────────────
  out.rebuildJobs = await prisma.historicalRebuildJob.findMany({ orderBy: { id: 'desc' }, take: 5 });

  // ── 10. Duplicate checks ──────────────────────────────────────────────────────
  out.dupAttendanceDaily = await prisma.$queryRaw`
    SELECT employeeId, date, COUNT(*) c FROM attendance_daily GROUP BY employeeId, date HAVING c > 1
  `;
  out.dupPayroll = await prisma.$queryRaw`
    SELECT employeeId, month, year, COUNT(*) c FROM payrolls GROUP BY employeeId, month, year HAVING c > 1
  `;

  // ── 11. Employees overview (for picking test subjects) ───────────────────────
  out.employees = await prisma.employee.findMany({
    where: { status: true },
    select: { id: true, name: true, code: true, zkUserId: true, salary: true, branchId: true, departmentId: true },
    orderBy: { id: 'asc' },
  });

  console.log(JSON.stringify(out, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
