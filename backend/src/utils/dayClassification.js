/**
 * dayClassification.js — what a calendar day with NO AttendanceDaily row means, decided ONCE.
 *
 * WHY. attendanceEngine.processDate() is the authority on a day's status and it stores its verdict in AttendanceDaily:
 *   - a date strictly before the employee's hireDate  -> 'holiday' (isHoliday) — never an absence, penalty or deduction (F-02)
 *   - Friday (permanent weekly off) / a configured weekend day -> 'weekend'
 *   - a public holiday                                   -> 'holiday'
 *   - any other past day without punches                 -> 'absent'
 * But the READ screens that show a day for which no row exists yet (Daily, Employee Movement, Dashboard) used to answer "absent"
 * for EVERY such day (utils/attendanceRow.js, merged === null), blind to hireDate, Friday and holidays. For a mid-month hire (or any
 * employee whose rows were never generated) the screens therefore showed — and Movement summed into absentDays / totalPenaltyDays —
 * absences for days before the employee existed and for weekly-off days, while the engine/payroll treat those days as non-working.
 *
 * This module is the read-side mirror of the engine's own classification, with the SAME precedence and the SAME representation
 * (status/isWeekend/isHoliday exactly as upsertDaily writes them). It decides nothing new and writes nothing.
 *
 * Pure: no DB, no clock. Callers evaluate the calendar facts (weekend/holiday) with the existing helpers and pass booleans in.
 * An unknown hireDate (null) is never invented: the day is simply not "before hire".
 */
const moment = require('moment');

/** "YYYY-MM-DD" of an Employee.hireDate (a Date or date string), or null when there is none. */
function hireDateStr(hireDate) {
  if (hireDate === null || hireDate === undefined || hireDate === '') return null;
  const m = moment(hireDate);
  return m.isValid() ? m.format('YYYY-MM-DD') : null;
}

/** True when `dateStr` is strictly before the employee's hire date (same comparison as the engine's pre-hire gate). */
function isBeforeHire(hireDate, dateStr) {
  const h = hireDateStr(hireDate);
  return h !== null && dateStr < h;
}

/**
 * @param {{hireDate?: Date|string|null, dateStr: string, isWeekendDay?: boolean, isHolidayDay?: boolean}} p
 * @returns {{reason:'pre-hire'|'post-stop'|'weekend'|'holiday'|'working', status:string, isWeekend:boolean, isHoliday:boolean, isAbsent:boolean}}
 */
function classifyMissingDay({ hireDate, dateStr, isWeekendDay = false, isHolidayDay = false, stopDate = null, stopped = false }) {
  if (isBeforeHire(hireDate, dateStr)) {
    // exactly what the engine stores for a pre-hire day: isHoliday + status 'holiday', isWeekend untouched (false)
    return { reason: 'pre-hire', status: 'holiday', isWeekend: false, isHoliday: true, isAbsent: false };
  }
  // Outside the employment period on the END side: payroll never derives an absence on/after the stop date (the stop date itself is the first
  // excluded day) and never guesses for a stopped employee with no recorded stop date (utils/payrollPeriod.virtualAbsentDates). The read screens
  // must say the same, with the same non-working representation as a pre-hire day, so the absence count matches the payroll it feeds.
  const stop = hireDateStr(stopDate);
  if ((stop && dateStr >= stop) || (stopped && !stop)) {
    return { reason: 'post-stop', status: 'holiday', isWeekend: false, isHoliday: true, isAbsent: false };
  }
  if (isWeekendDay || isHolidayDay) {
    return { reason: isWeekendDay ? 'weekend' : 'holiday', status: isWeekendDay ? 'weekend' : 'holiday', isWeekend: !!isWeekendDay, isHoliday: !!isHolidayDay, isAbsent: false };
  }
  return { reason: 'working', status: 'absent', isWeekend: false, isHoliday: false, isAbsent: true };
}

/** Index of Holiday rows -> (dateStr, branchId) => boolean, with the engine's rule: a holiday applies to its branch or to every branch (branchId null). */
function buildHolidayIndex(holidayRows) {
  const all = new Set();
  const byBranch = new Map();
  for (const h of holidayRows || []) {
    const d = new Date(h.date).toISOString().slice(0, 10);          // Holiday.date is stored at UTC midnight
    if (h.branchId === null || h.branchId === undefined) all.add(d);
    else { if (!byBranch.has(h.branchId)) byBranch.set(h.branchId, new Set()); byBranch.get(h.branchId).add(d); }
  }
  return (dateStr, branchId) => all.has(dateStr) || (branchId !== null && branchId !== undefined && !!byBranch.get(branchId) && byBranch.get(branchId).has(dateStr));
}

module.exports = { hireDateStr, isBeforeHire, classifyMissingDay, buildHolidayIndex };
