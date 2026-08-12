const moment = require('moment');

// ─── Shared Month Range utility (EF-008 Phase 2 / Finding #3) ────────────────
// Single source of truth for month-boundary construction, replacing what was
// previously ~11 independently-duplicated implementations across routes/
// engines/services. Two constructions exist below because they are NOT
// interchangeable — swapping one for the other silently shifts query
// boundaries by the server's UTC offset:
//   - `new Date(`${y}-${m}-01`)` (date-only ISO string) is parsed by native
//     Date as UTC midnight.
//   - `moment(`${y}-${m}-01`)` (same string) is parsed by moment as LOCAL
//     midnight.
// Each function here reproduces exactly the construction its call sites
// already used, verified site-by-site before this consolidation — see the
// EF-008 Phase 2 certification for the full list.

/**
 * [startDate, endDate] as native Date objects for a given year/month (1-12).
 * Matches the `new Date(\`${y}-${m}-01\`)` + `moment(startDate).endOf('month').toDate()`
 * construction previously duplicated identically across payrollEngine.js,
 * attendance.js, reports.js, and payroll.js.
 */
function monthRange(year, month) {
  const startDate = new Date(`${year}-${String(month).padStart(2, '0')}-01`);
  const endDate = moment(startDate).endOf('month').toDate();
  return { startDate, endDate };
}

/**
 * Moment start/end-of-month for a given year/month (1-12), as moment objects
 * for callers that chain further (e.g. clamping against "today", stepping
 * day-by-day). Matches the moment-string-parse construction already used by
 * attendanceEngine.processMonth and advances.js's recalcForAdvance.
 */
function monthRangeMoment(year, month) {
  const start = moment(`${year}-${String(month).padStart(2, '0')}-01`);
  const end = start.clone().endOf('month');
  return { start, end };
}

/** Moment start/end-of-month for the month containing `date`. */
function monthRangeForDate(date) {
  const start = moment(date).startOf('month');
  const end = start.clone().endOf('month');
  return { start, end };
}

/** Moment start/end-of-month for the current calendar month. */
function currentMonthRange() {
  return monthRangeForDate(moment());
}

/**
 * Native Date for "today", in the server's LOCAL calendar day, constructed
 * the same UTC-midnight-of-Y-M-D way `monthRange()` builds its own dates —
 * NOT a raw `new Date()` (UTC-anchored), which can disagree with the local
 * calendar day by up to 24h on a server running outside UTC (this one runs
 * at UTC+3). Comparing a raw `new Date()` against `monthRange()`'s dates
 * would be exactly the kind of mismatch that risks an off-by-one-day bug.
 */
function todayDate() {
  return new Date(moment().format('YYYY-MM-DD'));
}

/**
 * Effective end-of-range Date for a monthly day-by-day view (Phase 23.4):
 * the full month for a past month, but never later than today for the
 * current (or a future) month — a day that hasn't happened yet has no
 * attendance to show. For a future month this naturally yields
 * effectiveEnd < the month's startDate, which callers can pass straight
 * into a `{gte: startDate, lte: effectiveEnd}` filter — Prisma/MySQL return
 * an empty set for an inverted range, which is exactly "no future days".
 * Single shared boundary so every consumer of the same query result (a
 * statement table, its KPI totals, its print output) can never disagree.
 */
function getEffectiveMonthEndDate(year, month) {
  const { endDate } = monthRange(year, month);
  const today = todayDate();
  return endDate < today ? endDate : today;
}

module.exports = { monthRange, monthRangeMoment, monthRangeForDate, currentMonthRange, todayDate, getEffectiveMonthEndDate };
