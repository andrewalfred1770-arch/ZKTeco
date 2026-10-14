/**
 * lockedPunchConflict.js — "a manual lock is hiding raw fingerprint punches".
 *
 * A daily row with manualEdit=true is skipped by every automatic recompute (attendanceEngine.processDate). That is
 * deliberate — HR's values win — but it also means a real punch that arrives AFTER the lock never reaches the row.
 * These helpers decide, for one locked row and the valid raw punches of the same day, how many punches the row does
 * not account for, so the engine, the sync/realtime paths and the monthly view all use the SAME rule and the user
 * can be told instead of silently seeing an absent day next to a punch.
 *
 * A punch is "accounted for" when the row's own times cover it:
 *   - row has neither check-in nor check-out  -> every raw punch is unaccounted for;
 *   - row has both                            -> punches outside [checkIn, checkOut] are unaccounted for;
 *   - row has a check-in only                 -> punches later than it are unaccounted for (a missing check-out);
 *   - row has a check-out only                -> punches earlier than it are unaccounted for (a missing check-in).
 * An HR-corrected time inside the raw punches' span is not a conflict (the correction is the point of the lock).
 *
 * Arrival awareness: when the row already carries HR times, HR has looked at the day, so a punch that was STORED BEFORE the
 * row was last written (createdAt <= row.updatedAt) was seen and deliberately overridden (e.g. check-in moved later,
 * check-out trimmed) — it is not reported. Only punches that arrived AFTER the last write can be news to HR. A row with
 * no times at all (absent beside a punch) is reported whatever the arrival time. Punches given as bare times, or rows
 * without updatedAt, carry no arrival information and are treated conservatively (reported).
 * Pure, minute precision, no I/O.
 */

const minuteOf = (d) => Math.floor(new Date(d).getTime() / 60000);

// punch = a bare time (Date / ISO string / ms)  OR  { timestamp, createdAt } (createdAt = when the punch was stored)
function normPunch(p) {
  if (p && typeof p === 'object' && !(p instanceof Date) && 'timestamp' in p) {
    return { t: minuteOf(p.timestamp), created: p.createdAt ? new Date(p.createdAt).getTime() : null };
  }
  return { t: minuteOf(p), created: null };
}

/** @param {{checkIn?:Date|null, checkOut?:Date|null, updatedAt?:Date|null}} row  @param {Array} punches  @returns {number} */
function countUnreflectedPunches(row, punches) {
  const list = (punches || []).map(normPunch).filter((p) => Number.isFinite(p.t));
  if (!list.length) return 0;
  const ci = row && row.checkIn ? minuteOf(row.checkIn) : null;
  const co = row && row.checkOut ? minuteOf(row.checkOut) : null;
  if (ci == null && co == null) return list.length;                       // absent beside a punch: always reported
  const written = row && row.updatedAt ? new Date(row.updatedAt).getTime() : null;
  const isNews = (p) => written == null || p.created == null || p.created > written;
  let outside;
  if (ci != null && co != null) { const lo = Math.min(ci, co), hi = Math.max(ci, co); outside = (p) => p.t < lo || p.t > hi; }
  else if (ci != null) outside = (p) => p.t > ci;
  else outside = (p) => p.t < co;
  return list.filter((p) => outside(p) && isNews(p)).length;
}

/**
 * Sync summary for a list of { employeeId, dateStr, ignoredPunches } skips (one per locked day that hid punches).
 * warning is null when nothing was hidden — the only case in which a sync may be reported as a plain success.
 */
function summarizeLockedSkips(skips) {
  const list = skips || [];
  const punches = list.reduce((n, x) => n + (x.ignoredPunches || 0), 0);
  const warning = list.length
    ? `${punches} punch(es) on ${list.length} locked day(s) were stored but NOT applied to attendance (manual lock) — restore automatic calculation for those days`
    : null;
  return { days: list.length, punches, warning };
}

module.exports = { countUnreflectedPunches, summarizeLockedSkips };
