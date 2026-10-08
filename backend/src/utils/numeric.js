/**
 * numeric — strict parsing for money / quantity values arriving in request bodies.
 *
 * parseFloat() is a PREFIX parser, so it silently "repairs" garbage instead of
 * rejecting it: parseFloat('12abc') === 12, parseFloat('0x10') === 0 (a salary
 * silently zeroed), parseFloat('1,000') === 1. For money that is data corruption
 * with no error and no audit trail, so request money fields go through here.
 *
 * Accepted: a finite JS number, or a string holding exactly one decimal number
 * (optionally with an exponent — what <input type="number"> can legitimately
 * produce, e.g. "5000", "5000.50", ".5", "1e3"). Nothing else: no trailing text,
 * hex, thousands separators, Arabic-Indic digits, Infinity, NaN, booleans, arrays.
 */

const DECIMAL = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

// Sanity ceiling, far above any real monthly amount (the payroll grid itself
// caps edits at 100,000,000). It exists so a typo/overflow like "1e308" cannot
// reach DOUBLE arithmetic in the payroll engine and turn totals into Infinity.
const MAX_MONEY = 1e12;

/**
 * Strictly parse a non-negative amount.
 * @returns {number|null} the number, or null when the value is not a valid amount
 */
function parseMoney(value, { max = MAX_MONEY } = {}) {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && DECIMAL.test(value.trim())) n = Number(value.trim());
  else return null;
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return n;
}

/** True when the amount has at most 2 decimal places (money is kept to the cent). */
function hasMoneyPrecision(n) {
  return Number.isFinite(n) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6 * Math.max(1, Math.abs(n * 100));
}

module.exports = { parseMoney, hasMoneyPrecision, MAX_MONEY };
