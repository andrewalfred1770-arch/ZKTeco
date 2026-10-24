/**
 * payrollListScope.js — which payroll rows a month's LIST shows, and which figures it shows for them. Extracted VERBATIM from
 * routes/payroll.js GET / so the Excel export (routes/reports.js) applies exactly the same row set and the same approved-record rule
 * — before this, the grid and its own Excel export listed different employees and different numbers for finalized/paid rows.
 *
 * No new business rule lives here: the stopped-employee rule (Phase 22.1), the hire-date start rule (utils/employmentEligibility.js)
 * and the closed-payroll rule (finalized/paid rows are approved records) are moved, not changed.
 */
const { isRuleTrue } = require('../engines/rulesEngine');
const { monthRange } = require('./monthRange');
const { hasStarted } = require('./employmentEligibility');

const isClosedStatus = (s) => s === 'finalized' || s === 'paid';

/**
 * @param {object} prisma
 * @param {Array} payrolls Payroll rows with `employee: { status, effectiveStopDate, hireDate }` included
 * @param {number} m month (1-12)  @param {number} y year  @param {object} rules getRules() result
 * @returns {Promise<Array>} the rows the payroll list shows for that month
 */
async function selectListablePayrolls(prisma, payrolls, m, y, rules) {
  const stoppedEmployeeFilterEnabled = isRuleTrue(rules['exclude_stopped_employees_from_payroll']);

  let eligiblePayrolls = payrolls;
  if (stoppedEmployeeFilterEnabled) {
    const inactiveIds = [...new Set(
      payrolls
        .filter(p => p.employee.status === false && !isClosedStatus(p.status))
        .map(p => p.employeeId)
    )];

    // Legacy fallback ONLY for inactive employees with no effectiveStopDate on record (pre-Phase-22.1 data).
    const undatedInactiveIds = inactiveIds.filter(id => {
      const p = payrolls.find(row => row.employeeId === id);
      return p && p.employee.effectiveStopDate == null;
    });
    let eligibleUndatedIds = new Set();
    if (undatedInactiveIds.length) {
      const { startDate, endDate } = monthRange(y, m);
      const attended = await prisma.attendanceDaily.findMany({
        where: {
          employeeId: { in: undatedInactiveIds },
          date: { gte: startDate, lte: endDate },
          OR: [{ checkIn: { not: null } }, { checkOut: { not: null } }],
        },
        select: { employeeId: true },
        distinct: ['employeeId'],
      });
      eligibleUndatedIds = new Set(attended.map(a => a.employeeId));
    }

    // Month-boundary convention (Phase 22.1 §5): eligible for month (m,y) iff effectiveStopDate is strictly AFTER the first day of
    // that month — the stop date itself is the first excluded operational day.
    const { startDate: monthStart } = monthRange(y, m);
    eligiblePayrolls = payrolls.filter(p => {
      if (p.employee.status === true) return true;
      if (isClosedStatus(p.status)) return true;
      if (p.employee.effectiveStopDate != null) {
        return new Date(p.employee.effectiveStopDate).getTime() > monthStart.getTime();
      }
      return eligibleUndatedIds.has(p.employeeId);
    });
  }

  // Start side of the eligibility rule: a DRAFT payroll of a month that ended before the employee's hireDate (and without punches in
  // it) is not listed. Never applied to finalized/paid rows (approved records are always shown); nothing is deleted.
  {
    const { startDate: mStart, endDate: monthEnd } = monthRange(y, m);
    const unstarted = eligiblePayrolls.filter(p => !isClosedStatus(p.status) && p.employee.hireDate && !hasStarted(p.employee, { to: monthEnd }, false));
    if (unstarted.length) {
      const attended = await prisma.attendanceDaily.findMany({
        where: { employeeId: { in: unstarted.map(p => p.employeeId) }, date: { gte: mStart, lte: monthEnd }, OR: [{ checkIn: { not: null } }, { checkOut: { not: null } }] },
        select: { employeeId: true }, distinct: ['employeeId'],
      });
      const withEvidence = new Set(attended.map(a => a.employeeId));
      const hide = new Set(unstarted.filter(p => !withEvidence.has(p.employeeId)).map(p => p.employeeId));
      if (hide.size) eligiblePayrolls = eligiblePayrolls.filter(p => !hide.has(p.employeeId) || isClosedStatus(p.status));
    }
  }
  return eligiblePayrolls;
}

/**
 * The figures a list/export row shows: draft rows show the live computePayroll() result; closed (finalized/paid) rows are approved
 * records and show what was approved (the stored row), never freshly computed figures that may differ after a later attendance edit.
 */
function displayedFigures(storedRow, fresh) {
  return isClosedStatus(storedRow.status) ? { ...fresh, ...storedRow, dailyRate: fresh.dailyRate } : fresh;
}

module.exports = { selectListablePayrolls, displayedFigures, isClosedStatus };
