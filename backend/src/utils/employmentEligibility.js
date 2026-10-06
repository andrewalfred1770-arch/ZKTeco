/**
 * employmentEligibility.js — THE single definition of "was this employee in
 * scope for a period", derived from Employee.status + effectiveStopDate.
 *
 * Business rule (same semantics Payroll has always applied, see routes/payroll.js
 * "Month-boundary convention"): for a period [from, to] an employee is eligible iff
 *   1. status is active, OR
 *   2. status is stopped AND effectiveStopDate is strictly AFTER `from`
 *      (the stop date itself is the first excluded day), OR
 *   3. status is stopped, effectiveStopDate was never recorded (legacy rows) AND
 *      the employee has punch evidence inside the period.
 *
 * The rule is exposed in two equivalent forms so no caller re-implements it:
 *   - eligibleEmployeeWhere(period)  → Prisma `where` (DB-side; read endpoints)
 *   - isEligible(employee, period, hasPunchEvidence) → in-memory predicate
 *
 * Deliberately NOT part of the rule: payroll policy flags
 * (exclude_stopped_employees_from_payroll), payroll finalized/paid overrides,
 * and any view-level "must have a stored row" constraint. The latter is the
 * attendance read layer's concern and lives in attendanceScopeWhere().
 *
 * Read-only: builds query conditions / evaluates values; never reads or writes
 * data itself, and never alters generation/compute paths (engines select
 * active employees on their own, intentionally).
 */
const moment = require('moment');
const { monthRange } = require('./monthRange');

/** Period for a single calendar day (UTC-midnight date, the AttendanceDaily.date convention). */
function dayPeriod(date) {
  const d = new Date(moment(date).format('YYYY-MM-DD'));
  return { from: d, to: d };
}

/** Period for a whole calendar month (month 1-12), via the shared monthRange(). */
function monthPeriod(year, month) {
  const { startDate, endDate } = monthRange(year, month);
  return { from: startDate, to: endDate };
}

const hasPunch = [{ checkIn: { not: null } }, { checkOut: { not: null } }];

/** Prisma `where` implementing the eligibility rule for `period`. */
function eligibleEmployeeWhere(period) {
  return {
    OR: [
      { status: true },
      { status: false, effectiveStopDate: { gt: period.from } },
      {
        status: false,
        effectiveStopDate: null,
        attendanceDaily: { some: { date: { gte: period.from, lte: period.to }, OR: hasPunch } },
      },
    ],
  };
}

/** In-memory form of the same rule. `hasPunchEvidence` only matters for legacy stopped rows. */
function isEligible(employee, period, hasPunchEvidence = false) {
  if (employee.status === true) return true;
  if (employee.effectiveStopDate != null) {
    return new Date(employee.effectiveStopDate).getTime() > period.from.getTime();
  }
  return !!hasPunchEvidence;
}

/**
 * Attendance read layer: eligible employees, and — for stopped ones — only
 * those with a stored AttendanceDaily row in the period, so historical
 * inspection never fabricates "absent" rows for people who weren't active.
 * Kept separate from the generic rule on purpose.
 */
function attendanceScopeWhere(period) {
  return {
    AND: [
      eligibleEmployeeWhere(period),
      {
        OR: [
          { status: true },
          { attendanceDaily: { some: { date: { gte: period.from, lte: period.to } } } },
        ],
      },
    ],
  };
}

module.exports = { dayPeriod, monthPeriod, eligibleEmployeeWhere, isEligible, attendanceScopeWhere };
