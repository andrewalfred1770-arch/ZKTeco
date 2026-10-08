/**
 * period.js — strict month/year parsing for payroll requests (F-13).
 *
 * `parseInt(month) || currentMonth` turned every bad value into something else:
 * month=13 queried a month that cannot exist and answered 200 with an empty
 * result; month=1.5 or "6abc" were silently read as 1 and 6; month=0 or a
 * non-numeric value silently became the current month. A value that is PRESENT
 * must now be a valid whole number (month 1-12, year as a 4-digit 2000-2100,
 * the same range the advances API accepts); an ABSENT one still defaults to the
 * current period exactly as before.
 */
const present = (v) => v !== undefined && v !== null && v !== '';

function parsePeriod(month, year, now = new Date()) {
  let m = now.getMonth() + 1;
  let y = now.getFullYear();
  if (present(month)) {
    const s = String(month).trim();
    if (!/^\d{1,2}$/.test(s) || +s < 1 || +s > 12) {
      return { error: 'الشهر غير صالح — يجب أن يكون رقمًا صحيحًا من 1 إلى 12', code: 'INVALID_PERIOD' };
    }
    m = +s;
  }
  if (present(year)) {
    const s = String(year).trim();
    if (!/^\d{4}$/.test(s) || +s < 2000 || +s > 2100) {
      return { error: 'السنة غير صالحة', code: 'INVALID_PERIOD' };
    }
    y = +s;
  }
  return { m, y };
}

module.exports = { parsePeriod };
