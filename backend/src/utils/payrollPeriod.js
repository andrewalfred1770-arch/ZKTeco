/**
 * payrollPeriod.js — the two employment-period rules approved on 2026-10-14, as pure functions (no DB, no clock).
 *
 * RULE 1 — a hire date INSIDE the payroll month pays only the days from the hire date on, on the month's existing month_days basis:
 *      paidDays = month_days − (days of the month BEFORE the hire date)         e.g. hired on the 16th: 30 − 15 = 15 of 30 days
 *      basic    = monthlySalary × paidDays / month_days
 *   The daily/hourly rates (and so what one absent day costs) keep deriving from the FULL monthly salary — only the basic that is paid
 *   changes. A hire date on/before the 1st, or unknown (null — never invented), changes nothing. A hire date AFTER the month is not
 *   pro-rated: such a month only has a payroll at all when punches exist in it (utils/employmentEligibility.js), and then the data wins.
 *   Consequence of the approved month_days basis, stated here so nobody is surprised: in a 31-day month a hire on the 31st leaves
 *   30 days before it, i.e. 0 paid days.
 *
 * RULE 2 — an eligible working day with NO AttendanceDaily row counts as an absence (the automatic one salary day, D5), exactly the
 *   row the engine would create for it. Eligible = strictly in the past, on/after the hire date, before the stop date, not Friday
 *   (permanent weekly off) / a configured weekend day, not a public holiday. Today and future days are never counted. A stopped
 *   employee without a recorded stop date is not guessed at. AttendanceDaily stays the single source of truth: this only fills the
 *   rows that the engine has not (yet) written, it never overrides a stored row.
 */
const moment = require('moment');
const { hireDateStr } = require('./dayClassification');

const pad = (n) => String(n).padStart(2, '0');

/** Calendar days of the payroll month that precede the hire date (0 unless the hire date falls strictly inside the month). */
function preHireDaysInMonth(hireDate, month, year) {
  const h = hireDateStr(hireDate);
  if (!h) return 0;
  const first = `${year}-${pad(month)}-01`;
  const last = moment(first).endOf('month').format('YYYY-MM-DD');
  if (h <= first || h > last) return 0;               // started on/before the 1st, or after the month (no pro-rating either way)
  return Number(h.slice(8, 10)) - 1;
}

/** The approved paid fraction: (month_days − daysBeforeHire) / month_days, kept within [0, 1]. */
function prorationFactor(preHireDays, monthDays) {
  const md = Number(monthDays) > 0 ? Number(monthDays) : 30;
  if (!(preHireDays > 0)) return 1;
  return Math.min(1, Math.max(0, (md - preHireDays) / md));
}

/**
 * Dates ("YYYY-MM-DD") of the month that count as absent although no row exists.
 * @param {{employee:{status:boolean,hireDate?:any,effectiveStopDate?:any,branchId?:number|null}, month:number, year:number,
 *          rowDates:Set<string>, today:string, isWeekendDay:(dateStr:string)=>boolean, isHolidayOn:(dateStr:string, branchId:any)=>boolean}} p
 */
function virtualAbsentDates({ employee, month, year, rowDates, today, isWeekendDay, isHolidayOn }) {
  const out = [];
  const stop = hireDateStr(employee.effectiveStopDate);
  if (employee.status === false && !stop) return out;   // stopped with no recorded stop date: not guessed at
  const hire = hireDateStr(employee.hireDate);
  const daysInMonth = moment(`${year}-${pad(month)}-01`).daysInMonth();
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${pad(month)}-${pad(d)}`;
    if (ds >= today) break;                              // only strictly past days: today (still in progress) and the future never count
    if (rowDates.has(ds)) continue;                      // a stored row is the truth — it decides, not this function
    if (hire && ds < hire) continue;                     // before employment
    if (stop && ds >= stop) continue;                    // the stop date itself is the first excluded day (same convention as payroll eligibility)
    if (new Date(`${ds}T12:00:00`).getDay() === 5 || isWeekendDay(ds)) continue;   // Friday is the permanent weekly off
    if (isHolidayOn(ds, employee.branchId)) continue;
    out.push(ds);
  }
  return out;
}

module.exports = { preHireDaysInMonth, prorationFactor, virtualAbsentDates };
