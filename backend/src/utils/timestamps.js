/**
 * timestamps.js — punch-timestamp sanity validation.
 *
 * ZKTeco devices with a dead RTC battery or factory-reset clock emit garbage
 * timestamps (1999-epoch records were found in this very DB; a future-dated
 * clock is equally possible). Garbage timestamps are poison:
 *  - a FUTURE timestamp advances Device.lastSuccessfulTimestamp, after which
 *    the incremental checkpoint window filters out every real record forever
 *    (permanent, silent ingestion stall);
 *  - an ANCIENT timestamp, once relinked to an employee, makes the relink
 *    recalculator walk day-by-day from 1999 → today (a recalc storm that
 *    blocks the sync pipeline for hours).
 *
 * Every ingestion path (realtime punch, recovery pull, relink recalc range)
 * must validate through here. Rejected punches are logged loudly — they are
 * a device-health signal, not noise.
 */

// Oldest punch the system will accept. Predates any real deployment data.
const MIN_VALID_TS = new Date('2020-01-01T00:00:00Z');
// Allow modest device-clock skew ahead of server time, nothing more.
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000; // +24h

function isValidPunchTimestamp(ts) {
  if (!(ts instanceof Date) || isNaN(ts.getTime())) return false;
  if (ts < MIN_VALID_TS) return false;
  if (ts.getTime() > Date.now() + MAX_FUTURE_SKEW_MS) return false;
  return true;
}

/** Clamp an arbitrary date range to the valid punch window (for recalc loops). */
function clampToValidRange(from, to) {
  const now = new Date(Date.now() + MAX_FUTURE_SKEW_MS);
  let f = from instanceof Date ? from : new Date(from);
  let t = to instanceof Date ? to : new Date(to);
  if (isNaN(f.getTime()) || f < MIN_VALID_TS) f = MIN_VALID_TS;
  if (isNaN(t.getTime()) || t > now) t = now;
  return { from: f, to: t };
}

module.exports = { isValidPunchTimestamp, clampToValidRange, MIN_VALID_TS, MAX_FUTURE_SKEW_MS };
