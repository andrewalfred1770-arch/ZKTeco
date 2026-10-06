/**
 * businessDate — the single frontend source of truth for Business Dates.
 *
 *   Business date = "YYYY-MM-DD" (calendar day in the business/server-local timezone)
 *   Instant       = ISO UTC timestamp / Date
 *
 * Rules:
 *  - Date-only arithmetic NEVER goes through a local-time Date (DST/UTC shifts).
 *    It uses integer Y/M/D or Date.UTC only, so results are timezone-independent.
 *  - Instants are converted to a business date/time using the same local
 *    timezone for BOTH date and time, so they can never disagree.
 */

const pad2 = (n) => String(n).padStart(2, '0');

function fmtYMD(y, m, d) {
  return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
}

function parseYMD(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr ?? ''));
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3] };
}

function toDate(instant) {
  const d = instant instanceof Date ? instant : new Date(instant);
  return isNaN(d.getTime()) ? null : d;
}

/** Today's business date (local calendar day) as "YYYY-MM-DD". */
export function todayStr() {
  return instantDateStr(new Date());
}

/** Add `delta` calendar days to a "YYYY-MM-DD" string. Timezone-independent. */
export function addDays(dateStr, delta) {
  const p = parseYMD(dateStr);
  if (!p) return dateStr;
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + Number(delta || 0)));
  return fmtYMD(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Business date ("YYYY-MM-DD", local calendar day) of an instant. '' if invalid. */
export function instantDateStr(instant) {
  const d = toDate(instant);
  if (!d) return '';
  return fmtYMD(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** Local clock time "HH:mm" (24h) of an instant. '' if invalid. */
export function instantTime(instant) {
  const d = toDate(instant);
  if (!d) return '';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** { from, to } "YYYY-MM-DD" bounds of a month (month is 1-12). */
export function monthBounds(year, month) {
  const y = Number(year), m = Number(month);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: fmtYMD(y, m, 1), to: fmtYMD(y, m, last) };
}
