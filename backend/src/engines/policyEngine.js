/**
 * Attendance Policy Engine
 * ========================
 * Enterprise-grade attendance rule calculator.
 *
 * Formulas (all times in minutes from midnight):
 *
 * ┌─ Morning OT ───────────────────────────────────────────────────────────┐
 * │  If checkIn >= shiftStart → 0                                          │
 * │  Else: floor(max(0, (shiftStart - max(checkIn, morningOTStart)) + T) / 60) │
 * │  where T = otToleranceMin (default 10)                                 │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ Evening OT ───────────────────────────────────────────────────────────┐
 * │  If checkOut <= shiftEnd → 0                                           │
 * │  Else: floor(max(0, (min(checkOut, eveningOTEnd) - shiftEnd) + T) / 60) │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ Late Penalty (default rules) ─────────────────────────────────────────┐
 * │  ≤ 9:20   (≤ 560 min) → 0 units                                       │
 * │  9:21–9:35  (561–575) → 1 unit                                        │
 * │  9:36–9:50  (576–590) → 2 units                                       │
 * │  9:51–10:15 (591–615) → 3 units                                       │
 * │  10:16–12:00 (616–720) → 4 units                                      │
 * │  > 12:00   (> 720)    → 8 units (full day)                            │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ Early Checkout (default rules) ───────────────────────────────────────┐
 * │  13:00–13:59 (780–839) → 4 units                                      │
 * │  14:00–14:59 (840–899) → 3 units                                      │
 * │  15:00–15:49 (900–949) → 2 units                                      │
 * │  15:50–16:54 (950–1014) → 1 unit                                      │
 * │  ≥ 16:55   (≥ 1015)   → 0 units                                       │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * 1 deduction unit = 1 hour salary deduction
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────
function timeToMinutes(hhmm) {
  if (!hhmm) return 0;
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function minutesToTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.abs(minutes % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ─── Default penalty rules ────────────────────────────────────────────────────
const DEFAULT_LATE_RULES = [
  { fromMinute: 0,   toMinute: 560,  deductionUnits: 0, label: '≤ 9:20 — لا خصم'       },
  { fromMinute: 561, toMinute: 575,  deductionUnits: 1, label: '9:21–9:35 — خصم 1'     },
  { fromMinute: 576, toMinute: 590,  deductionUnits: 2, label: '9:36–9:50 — خصم 2'     },
  { fromMinute: 591, toMinute: 615,  deductionUnits: 3, label: '9:51–10:15 — خصم 3'   },
  { fromMinute: 616, toMinute: 720,  deductionUnits: 4, label: '10:16–12:00 — خصم 4'  },
  { fromMinute: 721, toMinute: 9999, deductionUnits: 8, label: '> 12:00 — يوم كامل'   },
];

const DEFAULT_EARLY_CHECKOUT_RULES = [
  { fromMinute: 780,  toMinute: 839,  deductionUnits: 4, label: '1 PM–2 PM — خصم 4'   },
  { fromMinute: 840,  toMinute: 899,  deductionUnits: 3, label: '2 PM–3 PM — خصم 3'   },
  { fromMinute: 900,  toMinute: 949,  deductionUnits: 2, label: '3 PM–3:49 PM — خصم 2' },
  { fromMinute: 950,  toMinute: 1014, deductionUnits: 1, label: '3:50–4:54 PM — خصم 1' },
  { fromMinute: 1015, toMinute: 9999, deductionUnits: 0, label: '≥ 4:55 PM — لا خصم'  },
];

// ─── Core calculators ─────────────────────────────────────────────────────────

/**
 * ONE rounding implementation for "raw overtime-eligible minutes → whole
 * hours". Adds the configured tolerance before flooring, so a trailing
 * partial hour within the tolerance window is credited as a full hour.
 * Used by calcMorningOT, calcEveningOT, and attendanceEngine's
 * weekend/holiday all-day-OT path — previously the weekend/holiday path
 * floored raw minutes with no tolerance, silently under-crediting a
 * trailing partial hour relative to the weekday paths. Unified here so
 * the same worked-minutes remainder is rounded identically everywhere.
 *
 * @param {number} rawMinutes   - overtime-eligible minutes (pre-tolerance)
 * @param {number} toleranceMin - tolerance minutes added before flooring
 * @returns {number}            - whole overtime hours
 */
function hoursWithTolerance(rawMinutes, toleranceMin = 10) {
  return Math.floor(Math.max(0, rawMinutes + toleranceMin) / 60);
}

/**
 * Morning overtime: time worked BEFORE shift start.
 * Earliest counted minute = morningOTStart (default 06:00 = 360)
 *
 * @param {number} checkInMin   - check-in minutes from midnight
 * @param {object} policy       - policy config object
 * @returns {number}            - whole overtime hours
 */
function calcMorningOT(checkInMin, policy = {}) {
  const shiftStart    = timeToMinutes(policy.shiftStartTime   || '09:00');  // 540
  const morningStart  = timeToMinutes(policy.morningOTStart   || '06:00');  // 360
  const tolerance     = (policy.otToleranceMin ?? 10);

  if (checkInMin >= shiftStart) return 0;

  const rawMinutes = Math.max(0, shiftStart - Math.max(checkInMin, morningStart));
  return hoursWithTolerance(rawMinutes, tolerance);
}

/**
 * Evening overtime: time worked AFTER shift end.
 * Latest counted minute = eveningOTEnd (default 23:59 = 1439)
 *
 * @param {number} checkOutMin  - check-out minutes from midnight
 * @param {object} policy       - policy config object
 * @returns {number}            - whole overtime hours
 */
function calcEveningOT(checkOutMin, policy = {}) {
  const shiftEnd    = timeToMinutes(policy.shiftEndTime || '17:00');  // 1020
  const maxEnd      = timeToMinutes(policy.eveningOTEnd || '23:59');  // 1439
  const tolerance   = (policy.otToleranceMin ?? 10);

  if (checkOutMin <= shiftEnd) return 0;

  const rawMinutes = Math.max(0, Math.min(checkOutMin, maxEnd) - shiftEnd);
  return hoursWithTolerance(rawMinutes, tolerance);
}

/**
 * Late arrival penalty — table lookup, sorted ascending by fromMinute.
 *
 * @param {number} checkInMin     - check-in minutes from midnight
 * @param {Array}  penaltyRules   - Array of {fromMinute, toMinute, deductionUnits, type}
 * @returns {number}              - deduction units
 */
function calcLatePenalty(checkInMin, penaltyRules) {
  const rules = penaltyRules && penaltyRules.length > 0
    ? penaltyRules.filter(r => r.type === 'late' || !r.type)
    : DEFAULT_LATE_RULES;

  const sorted = [...rules].sort((a, b) => a.fromMinute - b.fromMinute);
  for (const rule of sorted) {
    const to = rule.toMinute === -1 ? 9999 : rule.toMinute;
    if (checkInMin >= rule.fromMinute && checkInMin <= to) {
      return Number(rule.deductionUnits || 0);
    }
  }
  return 0;
}

/**
 * Early checkout penalty — table lookup, sorted ascending by fromMinute.
 *
 * @param {number} checkOutMin    - check-out minutes from midnight
 * @param {Array}  penaltyRules   - Array of {fromMinute, toMinute, deductionUnits, type}
 * @returns {number}              - deduction units
 */
function calcEarlyCheckout(checkOutMin, penaltyRules) {
  const rules = penaltyRules && penaltyRules.length > 0
    ? penaltyRules.filter(r => r.type === 'early_checkout' || !r.type)
    : DEFAULT_EARLY_CHECKOUT_RULES;

  if (!rules.length) return 0;

  const sorted = [...rules].sort((a, b) => a.fromMinute - b.fromMinute);
  for (const rule of sorted) {
    const to = rule.toMinute === -1 ? 9999 : rule.toMinute;
    if (checkOutMin >= rule.fromMinute && checkOutMin <= to) {
      return Number(rule.deductionUnits || 0);
    }
  }
  return 0;
}

/**
 * Overtime bonus units — table lookup, sorted ascending by fromMinute.
 * Mirrors calcEarlyCheckout but for type='overtime' rules: graduated
 * checkout-time thresholds → bonus units (1 unit = 1 hour salary).
 *
 * Returns `null` when no overtime rules are configured for this policy —
 * callers fall back to the hour-based `overtimeHours` in that case, so
 * behavior is unchanged until an admin adds overtime rules.
 *
 * @param {number} checkOutMin    - check-out minutes from midnight
 * @param {Array}  penaltyRules   - Array of {fromMinute, toMinute, deductionUnits, type}
 * @returns {number|null}         - bonus units, or null if no 'overtime' rules exist
 */
function calcOvertimeUnits(checkOutMin, penaltyRules) {
  const rules = (penaltyRules || []).filter(r => r.type === 'overtime');
  if (!rules.length) return null;

  const sorted = [...rules].sort((a, b) => a.fromMinute - b.fromMinute);
  for (const rule of sorted) {
    const to = rule.toMinute === -1 ? 9999 : rule.toMinute;
    if (checkOutMin >= rule.fromMinute && checkOutMin <= to) {
      return Number(rule.deductionUnits || 0);
    }
  }
  return 0;
}

// ─── Deduction money calculation ──────────────────────────────────────────────
/**
 * Convert deduction units to money.
 * 1 unit = 1 hour salary.
 *
 * @param {number} units       - total deduction units
 * @param {number} hourlyRate  - employee hourly rate
 * @returns {number}           - deduction amount
 */
function unitsToMoney(units, hourlyRate) {
  return Math.round(units * hourlyRate * 100) / 100;
}

// ─── Tier-based penalty calculators (relative minutes from shift boundary) ────
// These supersede the absolute-time DEFAULT_LATE_RULES when `late_tiers` /
// `early_leave_tiers` rules are configured in the DB. Tiers are stored as
// JSON: [{from:0, to:15, units:0}, {from:16, to:30, units:1}, ...].
// `from`/`to` are RELATIVE minutes of lateness / early-leave (not absolute time).
// This makes them shift-agnostic — they work correctly for any shift start/end.

const DEFAULT_LATE_TIERS = [
  { from: 0,   to: 15,   units: 0 },
  { from: 16,  to: 30,   units: 1 },
  { from: 31,  to: 60,   units: 2 },
  { from: 61,  to: 9999, units: 3 },
];

const DEFAULT_EARLY_LEAVE_TIERS = [
  { from: 0,   to: 15,   units: 0 },
  { from: 16,  to: 60,   units: 1 },
  { from: 61,  to: 9999, units: 2 },
];

/**
 * Tier-based late penalty using relative late minutes.
 * @param {number} lateMinutes - minutes late (checkIn - work_start), already clamped ≥ 0
 * @param {Array|null} tiers   - [{from, to, units}] or null → DEFAULT_LATE_TIERS
 */
function calcLatePenaltyByMinutes(lateMinutes, tiers) {
  const rules = (tiers && tiers.length > 0) ? tiers : DEFAULT_LATE_TIERS;
  const sorted = [...rules].sort((a, b) => a.from - b.from);
  for (const tier of sorted) {
    if (lateMinutes >= tier.from && lateMinutes <= (tier.to ?? 9999)) {
      return Number(tier.units || 0);
    }
  }
  return 0;
}

/**
 * Tier-based early leave penalty using relative early-leave minutes.
 * @param {number} earlyMinutes - minutes early (work_end - checkOut), clamped ≥ 0
 * @param {Array|null} tiers    - [{from, to, units}] or null → DEFAULT_EARLY_LEAVE_TIERS
 */
function calcEarlyLeavePenaltyByMinutes(earlyMinutes, tiers) {
  const rules = (tiers && tiers.length > 0) ? tiers : DEFAULT_EARLY_LEAVE_TIERS;
  const sorted = [...rules].sort((a, b) => a.from - b.from);
  for (const tier of sorted) {
    if (earlyMinutes >= tier.from && earlyMinutes <= (tier.to ?? 9999)) {
      return Number(tier.units || 0);
    }
  }
  return 0;
}

module.exports = {
  timeToMinutes,
  minutesToTime,
  hoursWithTolerance,
  calcMorningOT,
  calcEveningOT,
  calcLatePenalty,
  calcEarlyCheckout,
  calcOvertimeUnits,
  calcLatePenaltyByMinutes,
  calcEarlyLeavePenaltyByMinutes,
  unitsToMoney,
  DEFAULT_LATE_RULES,
  DEFAULT_EARLY_CHECKOUT_RULES,
  DEFAULT_LATE_TIERS,
  DEFAULT_EARLY_LEAVE_TIERS,
};
