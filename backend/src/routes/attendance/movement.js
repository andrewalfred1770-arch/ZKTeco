const router = require('express').Router();
const { getPrisma } = require('../../utils/prisma');
const moment = require('moment');
const { mergeEffectivePenalty } = require('../../engines/attendanceEngine');
const { applyApprovedAdjustment, selectOvertimeMultiplier, computeRates } = require('../../engines/payrollEngine');
const { getRules } = require('../../engines/rulesEngine');

const prisma = getPrisma();

// ─── Monthly Employee Movement Report ────────────────────────────────────────
// GET /api/attendance/movement?month=2026-06
//   employeeId omitted/empty → MODE 1: full-company ledger (every active
//     employee × every day of the month, optionally narrowed by branchId/departmentId)
//   employeeId provided      → MODE 2: same row schema, single employee only
const MOVEMENT_DAYS_AR = ['الأحد','الإثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];

function movementFmtTime(dt) {
  if (!dt) return null;
  const d = new Date(dt);
  const h = d.getHours(), m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12  = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${String(h12).padStart(2,'0')}:${String(m).padStart(2,'0')} ${ampm}`;
}

// Builds the per-day rows for one employee for the given month, each row
// pre-stamped with employee identity fields so the frontend ledger grid uses
// one identical column set for both "all employees" and "single employee" modes.
function buildMovementDays(employee, recMap, yearStr, monthStr, totalDays) {
  const days = [];
  for (let d = 1; d <= totalDays; d++) {
    const dateStr = `${yearStr}-${monthStr}-${String(d).padStart(2,'0')}`;
    const rec = recMap.get(dateStr);
    const dayDate = new Date(`${dateStr}T12:00:00`);

    const morningOT   = rec?.morningOvertimeHours || 0;
    const eveningOT   = rec?.eveningOvertimeHours || 0;
    const latePenalty = rec?.latePenaltyUnits     || 0;
    const earlyPenalty= rec?.earlyCheckoutUnits   || 0;
    const totalDeduct = rec?.totalDeductionUnits  || 0;
    const workedMins  = rec?.workedMinutes        || 0;
    const effectiveLatePenalty   = rec?.effectiveLatePenalty   || 0;
    const effectiveEarlyPenalty  = rec?.effectiveEarlyPenalty  || 0;
    const effectiveTotalDeduct   = rec?.effectiveTotalDeductionUnits || 0;
    const effectiveOvertimeUnits = rec?.effectiveOvertimeUnits  || 0;

    days.push({
      id:             rec?.id ?? null,
      employeeId:     employee.id,
      employeeCode:   employee.code,
      employeeName:   employee.name,
      department:     employee.department?.name || '',
      branch:         employee.branch?.name || '',
      date:           dateStr,
      dayName:        MOVEMENT_DAYS_AR[dayDate.getDay()],
      dayNum:         d,
      checkIn:        rec?.checkIn  ? movementFmtTime(rec.checkIn)  : null,
      checkOut:       rec?.checkOut ? movementFmtTime(rec.checkOut) : null,
      workedHours:    parseFloat((workedMins / 60).toFixed(2)),
      lateMinutes:    rec?.lateMinutes        || 0,
      earlyLeaveMin:  rec?.earlyLeaveMinutes  || 0,
      morningOT,
      eveningOT,
      // Friday-OT certification fix: totalOT must be the actual credited OT
      // (effectiveOvertimeUnits), not morningOT+eveningOT. On weekend/holiday
      // days (including Friday when configured as a weekend day),
      // attendanceEngine intentionally leaves morningOvertimeHours/
      // eveningOvertimeHours at 0 — all worked-minute OT is carried solely in
      // effectiveOvertimeUnits/overtimeHours instead (see attendanceEngine.js's
      // weekend/holiday branch). The old `morningOT + eveningOT` formula was
      // structurally 0 for every such day, silently excluding all weekend/
      // holiday/Friday-weekend OT from this report's per-day and monthly
      // "ساعات الإضافي" totals — money (otAmount) was never affected, since it
      // already used effectiveOvertimeUnits/totalEffectiveOvertimeUnits.
      totalOT:        effectiveOvertimeUnits,
      latePenalty,
      earlyPenalty,
      totalDeductions: totalDeduct,
      latePenaltyUnits:   rec?.latePenaltyUnits   ?? 0,
      earlyCheckoutUnits: rec?.earlyCheckoutUnits ?? 0,
      effectiveLatePenalty,
      effectiveEarlyPenalty,
      effectiveTotalDeductions: effectiveTotalDeduct,
      effectiveOvertimeUnits,
      hasManualPenalty: rec?.hasManualPenalty || false,
      hasManualOvertime: rec?.hasManualOvertime || false,
      manualLatePenaltyUnits:  rec?.manualLatePenaltyUnits  ?? null,
      manualEarlyPenaltyUnits: rec?.manualEarlyPenaltyUnits ?? null,
      manualOvertimeUnits:     rec?.manualOvertimeUnits     ?? null,
      manualPenaltyReason: rec?.manualPenaltyReason ?? null,
      // EF-015: additive — tooltip "Modified By / Modified At" needs these.
      manualPenaltyByName: rec?.manualPenaltyByName ?? null,
      manualPenaltyAt:     rec?.manualPenaltyAt     ?? null,
      status:   rec?.status   || 'absent',
      isWeekend: rec?.isWeekend || false,
      isHoliday: rec?.isHoliday || false,
      isAbsent:  rec?.isAbsent  || (!rec && !rec?.isWeekend),
      hasData:   !!rec,
      absenceType:   rec?.absenceType   || null,
      penaltyDays:   rec?.penaltyDays   ?? null,
      absenceReason: rec?.absenceReason || null,
      absenceSetBy:  rec?.absenceSetBy  || null,
      // EP-018: was missing from this row builder (unlike daily.js/monthly.js,
      // which already stamp it) — every day-row on this page silently had
      // isMonitored=undefined, so both the "Distinguished" filter and the
      // name-cell highlight never matched any employee here.
      isMonitored:   employee.isMonitored  || false,
      monitorColor:  employee.monitorColor || null,
    });
  }
  return days;
}

// Per-employee summary totals (also reused, summed across employees, for the
// company-wide "All Employees" summary).
function summarizeMovementDays(days, hourlyRate, multipliers, totalDays) {
  const workDays = days.filter(d => !d.isWeekend && !d.isHoliday);
  // isAbsent is the single canonical absence flag (attendanceEngine) — a
  // checkIn-only or checkOut-only day is present, not absent, so this must
  // not re-derive absence from checkIn presence.
  const presentDays  = workDays.filter(d => !d.isAbsent).length;
  const absentDays   = workDays.filter(d => d.isAbsent).length;
  // EP-024.2: sum of the HR-entered/rule-derived deduction-day amount per
  // absent day (AttendanceDaily.penaltyDays) — distinct from absentDays
  // (a pure calendar count). Same field payrollEngine.js sums independently
  // as totalAbsencePenaltyDays; this is display-only, no money computed here.
  const totalPenaltyDays = workDays.filter(d => d.isAbsent).reduce((s, d) => s + (d.penaltyDays || 0), 0);
  // Canonical: "late" is defined by the effective (post-override) penalty,
  // never by raw lateMinutes — see PART 3 (canonical penalty runtime).
  const lateDays     = days.filter(d => d.effectiveLatePenalty > 0).length;
  // All totals use .toFixed(2) — matches frontend computeSummaryFromDays precision.
  // Single precision constant eliminates the backend-vs-frontend rounding gap.
  const P = (n) => parseFloat(n.toFixed(2));
  const totalWorkedH = P(days.reduce((s, d) => s + d.workedHours, 0));
  const totalOTH     = P(days.reduce((s, d) => s + d.totalOT, 0));
  const totalLateMin = days.reduce((s, d) => s + d.lateMinutes, 0);
  const totalDeductU = P(days.reduce((s, d) => s + d.totalDeductions, 0));
  const totalEffectiveLatePenalty  = P(days.reduce((s, d) => s + d.effectiveLatePenalty, 0));
  const totalEffectiveEarlyPenalty = P(days.reduce((s, d) => s + d.effectiveEarlyPenalty, 0));
  const totalEffectiveDeductionUnits = P(days.reduce((s, d) => s + d.effectiveTotalDeductions, 0));
  const totalEffectiveOvertimeUnits  = P(days.reduce((s, d) => s + (d.effectiveOvertimeUnits || 0), 0));
  // EF-008 Finding #4: per-day multiplier via the same selectOvertimeMultiplier
  // Payroll Engine uses — single source of truth, no duplicated business logic.
  const otAmount     = P(days.reduce((s, d) => s + (d.effectiveOvertimeUnits || 0) * hourlyRate * selectOvertimeMultiplier(d, multipliers), 0));
  const deductAmount = P(totalDeductU * hourlyRate);
  const effectiveDeductAmount = P(totalEffectiveDeductionUnits * hourlyRate);
  const netEffect    = P(otAmount - deductAmount);
  const effectiveNetEffect = P(otAmount - effectiveDeductAmount);

  return {
    totalDays,
    workingDays: workDays.length,
    presentDays, absentDays, lateDays, totalPenaltyDays,
    totalWorkedHours: totalWorkedH,
    totalOTHours:     totalOTH,
    totalEffectiveOvertimeUnits,
    totalLateMinutes: totalLateMin,
    totalDeductionUnits: totalDeductU,
    totalEffectiveLatePenalty,
    totalEffectiveEarlyPenalty,
    totalEffectiveDeductionUnits,
    otAmount, deductAmount, effectiveDeductAmount,
    netEffect, effectiveNetEffect,
    hourlyRate: parseFloat(hourlyRate.toFixed(2)),
  };
}

// Sums per-employee summaries into one company-wide summary (Mode 1 KPI cards).
function aggregateMovementSummaries(summaries, totalDays) {
  const sum = key => parseFloat(summaries.reduce((s, x) => s + (x[key] || 0), 0).toFixed(2));
  return {
    totalDays,
    workingDays: summaries[0]?.workingDays || 0,
    presentDays: sum('presentDays'),
    absentDays: sum('absentDays'),
    totalPenaltyDays: sum('totalPenaltyDays'),
    lateDays: sum('lateDays'),
    totalWorkedHours: sum('totalWorkedHours'),
    totalOTHours: sum('totalOTHours'),
    totalEffectiveOvertimeUnits: sum('totalEffectiveOvertimeUnits'),
    totalLateMinutes: sum('totalLateMinutes'),
    totalDeductionUnits: sum('totalDeductionUnits'),
    totalEffectiveLatePenalty: sum('totalEffectiveLatePenalty'),
    totalEffectiveEarlyPenalty: sum('totalEffectiveEarlyPenalty'),
    totalEffectiveDeductionUnits: sum('totalEffectiveDeductionUnits'),
    otAmount: sum('otAmount'),
    deductAmount: sum('deductAmount'),
    effectiveDeductAmount: sum('effectiveDeductAmount'),
    netEffect: sum('netEffect'),
    effectiveNetEffect: sum('effectiveNetEffect'),
  };
}

router.get('/movement', async (req, res) => {
  try {
    const { employeeId, month, branchId, departmentId } = req.query;
    if (!month) {
      return res.status(400).json({ error: 'يجب تحديد الشهر' });
    }

    // Parse month
    const [yearStr, monthStr] = month.split('-');
    const year    = parseInt(yearStr);
    const monthNo = parseInt(monthStr);
    const startDate = new Date(`${yearStr}-${monthStr}-01T00:00:00`);
    const endDate   = moment(startDate).endOf('month').toDate();
    // EF-014 Issue #2: the current (in-progress) month must never render days
    // beyond today — those days have no attendance yet and previously showed
    // as misleading "absent" placeholder rows. Past/future months are
    // unaffected (full month, exactly as before).
    const today = moment();
    const isCurrentMonth = today.year() === year && (today.month() + 1) === monthNo;
    const totalDays = isCurrentMonth ? today.date() : moment(startDate).daysInMonth();

    // Resolve the employee set for this request.
    let employees;
    if (employeeId) {
      const employee = await prisma.employee.findUnique({
        where: { id: parseInt(employeeId) },
        include: {
          department: { select: { name: true } },
          branch:     { select: { name: true } },
          shift:      { select: { name: true, startTime: true, endTime: true } },
        },
      });
      if (!employee) return res.status(404).json({ error: 'الموظف غير موجود' });
      employees = [employee];
    } else {
      const empWhere = { status: true };
      if (branchId) empWhere.branchId = parseInt(branchId);
      if (departmentId) empWhere.departmentId = parseInt(departmentId);
      employees = await prisma.employee.findMany({
        where: empWhere,
        include: {
          department: { select: { name: true } },
          branch:     { select: { name: true } },
          shift:      { select: { name: true, startTime: true, endTime: true } },
        },
        orderBy: { name: 'asc' },
      });
    }

    const empIds = employees.map(e => e.id);
    const records = await prisma.attendanceDaily.findMany({
      where: { employeeId: { in: empIds }, date: { gte: startDate, lte: endDate } },
      orderBy: { date: 'asc' },
    });
    const recordIds = records.map(r => r.id);
    const adjustments = await prisma.attendanceAdjustment.findMany({
      where: { attendanceDailyId: { in: recordIds }, approvalStatus: 'approved' },
    });
    const adjByDailyId = new Map(adjustments.map(a => [a.attendanceDailyId, a]));

    // Group merged records by employee → date for O(1) lookup while building days.
    const recordsByEmp = new Map();
    for (const r of records) {
      const merged = mergeEffectivePenalty(applyApprovedAdjustment(r, adjByDailyId.get(r.id)));
      if (!recordsByEmp.has(r.employeeId)) recordsByEmp.set(r.employeeId, new Map());
      recordsByEmp.get(r.employeeId).set(moment(r.date).format('YYYY-MM-DD'), merged);
    }

    const allDays = [];
    const employeeSummaries = [];
    let singleEmployeeMeta = null;

    for (const employee of employees) {
      const rules = await getRules(employee.branchId, employee.departmentId, employee.id);
      const monthDays = parseFloat(rules.month_days || 30);
      const workHoursPerDay = parseFloat(rules.work_hours_per_day || 8);
      // EF-008 Finding #4: read the same rule keys payrollEngine.js's computePayroll
      // reads, with the same fallback-to-general-multiplier behavior, so
      // selectOvertimeMultiplier resolves identically in both places.
      const overtimeMultiplier = parseFloat(rules.overtime_multiplier || '1.5');
      const multipliers = {
        otMultiplier: overtimeMultiplier,
        fridayOTMultiplier: parseFloat(rules.friday_ot_multiplier || overtimeMultiplier),
        holidayOTMultiplier: parseFloat(rules.holiday_ot_multiplier || overtimeMultiplier),
        weekendOTMultiplier: parseFloat(rules.weekend_work_multiplier || overtimeMultiplier),
      };
      // EF-010: single source of truth — same function payrollEngine.computePayroll
      // uses, eliminating the previously-duplicated formula.
      const { dailyRate, hourlyRate } = computeRates(employee.salary || 0, monthDays, workHoursPerDay);

      const recMap = recordsByEmp.get(employee.id) || new Map();
      const days = buildMovementDays(employee, recMap, yearStr, monthStr, totalDays);
      const summary = summarizeMovementDays(days, hourlyRate, multipliers, totalDays);

      allDays.push(...days);
      employeeSummaries.push(summary);

      if (employeeId) {
        singleEmployeeMeta = {
          id:         employee.id,
          name:       employee.name,
          code:       employee.code,
          position:   employee.position,
          department: employee.department?.name,
          branch:     employee.branch?.name,
          shift:      employee.shift?.name,
          shiftStart: employee.shift?.startTime,
          shiftEnd:   employee.shift?.endTime,
          salary:     employee.salary,
          hourlyRate: parseFloat(hourlyRate.toFixed(2)),
        };
      }
    }

    const summary = employeeId
      ? employeeSummaries[0]
      : aggregateMovementSummaries(employeeSummaries, totalDays);

    res.json({
      mode: employeeId ? 'single' : 'all',
      employee: singleEmployeeMeta,
      employeeCount: employees.length,
      month,
      year,
      monthNo,
      totalDays,
      days: allDays,
      summary,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
