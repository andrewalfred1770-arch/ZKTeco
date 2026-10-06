/**
 * businessTimezone — pins the process timezone so business dates cannot shift
 * with the host OS timezone.
 *
 * Architecture: a "business date" is the SERVER-LOCAL calendar day. DATE
 * columns are stored/read as UTC-midnight Dates (`new Date('YYYY-MM-DD')`) and
 * are formatted/compared through local-time getters and moment (`moment(d)
 * .format('YYYY-MM-DD')`, `fmtDate`, `getDay()`, `startOf('day')`). That is
 * correct whenever the server's UTC offset is >= 0 (UTC, Cairo, Riyadh, London,
 * Auckland — all verified identical), because a UTC-midnight Date is still the
 * same calendar day locally. West of UTC (UTC-1 .. UTC-12, e.g. a host in New
 * York / Los Angeles) the same Date reads as the PREVIOUS local day, so every
 * daily/monthly/movement/payroll view shifts back a day and month ranges lose
 * their first day.
 *
 * Fix at the root instead of at ~60 call sites: if the host zone is west of UTC
 * at any time of the year, run the process on the business timezone instead.
 *   BUSINESS_TZ  explicit IANA zone (e.g. "Africa/Cairo") — always applied.
 *   (default)    host zone kept when its offset is >= 0 all year (unchanged
 *                behaviour for every supported deployment); otherwise
 *                "Africa/Cairo" (the deployment's business timezone).
 * Must run before any module formats or compares dates.
 */
const DEFAULT_BUSINESS_TZ = 'Africa/Cairo';

function isValidZone(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

// True if the process is currently west of UTC at any point of the year.
function hostIsWestOfUtc() {
  const y = new Date().getFullYear();
  return [0, 3, 6, 9].some((m) => new Date(y, m, 1).getTimezoneOffset() > 0);
}

function applyBusinessTimezone(env = process.env) {
  const requested = (env.BUSINESS_TZ || '').trim();
  let target = null; let reason = null;
  if (requested) {
    if (isValidZone(requested)) { target = requested; reason = 'BUSINESS_TZ'; }
    else console.warn(`[TZ] BUSINESS_TZ="${requested}" is not a valid IANA timezone — ignored`);
  }
  if (!target && hostIsWestOfUtc()) { target = DEFAULT_BUSINESS_TZ; reason = 'host timezone is west of UTC (unsupported for business dates)'; }
  if (target && env.TZ !== target) {
    env.TZ = target;
    // Node re-reads TZ on assignment; make sure it took effect.
    new Date(0).getTimezoneOffset();
    console.log(`[TZ] business timezone pinned to ${target} (${reason})`);
  }
  return { tz: env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone, pinned: !!target };
}

module.exports = { applyBusinessTimezone, hostIsWestOfUtc, DEFAULT_BUSINESS_TZ };
