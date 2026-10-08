const { getPrisma } = require('../utils/prisma');
const ruleStore = require('../services/ruleStore');
const logger = require('../utils/logger');
const prisma = getPrisma();

const DEFAULT_RULES = {
  // ── Shift timing ──────────────────────────────────────────────────────────────
  work_start: '09:00',
  work_end:   '17:00',
  checkin_window_start: '05:00',
  checkin_window_end:   '12:00',

  // ── Grace / thresholds ────────────────────────────────────────────────────────
  late_grace:        '0',   // minutes: an arrival later than this is marked "late" (STATUS only — the penalty always comes from late_rules)
  // DEPRECATED — not read by attendanceEngine (see ruleDependencyMap.js: entry([], [])).
  // Kept seeded only so existing DB rows / audit history are unaffected.
  late_limit:        '0',
  early_leave_grace: '0',
  // Removed: min_work_hours, mark_absent_below, break_minutes, half_day_deduction (2026-06-22)

  // ── Late penalty rule tiers (JSON, absolute check-in times) ─────────────────
  // [{fromTime:"09:00",toTime:"09:20",units:0},{fromTime:"09:21",toTime:"09:35",units:1},...]
  // empty → policyEngine DEFAULT_LATE_RULES (9 AM shift tiers)
  late_rules: '',

  // ── Early leave penalty tiers (JSON, absolute check-out times) ───────────────
  // [{fromTime:"13:00",toTime:"13:59",units:4},{fromTime:"14:00",toTime:"14:59",units:3},...]
  // empty → policyEngine DEFAULT_EARLY_CHECKOUT_RULES
  // Early leave rule tiers (JSON, absolute checkout times) — [{fromTime,toTime,units},...]
  // Empty → policyEngine DEFAULT_EARLY_CHECKOUT_RULES
  early_rules: '',

  // ── Overtime ──────────────────────────────────────────────────────────────────
  overtime_minimum:    '50',   // minimum before any OT counts: weekday = rounded OT hours x 60; weekend/holiday = raw worked minutes (see attendanceEngine)
  overtime_multiplier: '1.5',  // pay multiplier for OT
  overtime_cap_hours:  '0',    // daily cap (0 = no cap)
  // friday_ot_multiplier / holiday_ot_multiplier: deliberately NOT defaulted here.
  // payrollEngine reads `rules.friday_ot_multiplier || otMultiplier` — that fallback
  // only works if the key is truly absent (undefined) while the rule is inactive.
  // A hardcoded default here would permanently shadow the fallback, silently
  // freezing Friday/Holiday OT pay even after the general overtime_multiplier
  // changes (the certified production defect this fixed). Leave unset when
  // inactive so an active DB row wins and an inactive one lets payroll fall
  // through to the general overtime_multiplier.
  // NOT consumed by any engine — the OT-hour floor is fixed at 60 minutes
  // (see ruleDependencyMap.js: entry([], [])). Kept seeded only for compat.
  overtime_rounding:   '50',

  // ── Weekend ───────────────────────────────────────────────────────────────────
  // Company policy (2026-06): Friday is a special overtime workday; Saturday is
  // a normal workday. Neither is off by default — override from the UI.
  weekend_days:       '',      // e.g. 'fri', 'sat', 'fri,sat'
  friday_is_weekend:  'false', // true → Friday = non-working day

  // ── Absence ───────────────────────────────────────────────────────────────────
  late_penalty_per_minute:'0',   // legacy per-minute rate (superseded by tiers)
};

// Boolean rule values. ruleValidation.js (case 'boolean') accepts true/false/1/0/'' in any case, so every
// engine reader must understand the SAME set — otherwise a value the validator accepted (e.g. '1')
// would silently be read as false.
function isRuleTrue(v) {
  return ['true', '1'].includes(String(v ?? '').trim().toLowerCase());
}

// ─── Rules lookup ─────────────────────────────────────────────────────────────
// D1 (approved): ALL rules are GLOBAL — there is no branch / department / employee scope.
// Precedence is simply: hardcoded defaults → Dynamic Rules (the `rules` table, via ruleStore).
//
// R4 (approved): the legacy `attendance_rules` table used to add branch → department → employee overrides
// here. Those scoped overrides are no longer applied, and legacy GLOBAL rows were already ignored, so the
// legacy table has no effect on any calculation. (The two old lookups also disagreed about scope when a row
// named several scopes; there is now nothing left to disagree about.) The table itself is untouched — see
// backend/scripts/reconcile-legacy-attendance-rules.js for the read-only reconciliation report. The
// (branchId, departmentId, employeeId) parameters are kept so every existing caller keeps working.
//
// One-time diagnostic: if scoped legacy rows exist in a database, say so in the log (they are IGNORED) so a
// controlled migration can deal with them. Diagnostic only — it can never affect or fail a calculation.
let legacyScopedCheck = null;
function noteLegacyScopedRules() {
  if (legacyScopedCheck) return;
  legacyScopedCheck = (async () => {
    try {
      const n = await prisma.attendanceRule.count({
        where: { OR: [{ branchId: { not: null } }, { departmentId: { not: null } }, { employeeId: { not: null } }] },
      });
      if (n > 0) logger.warn(`[RULES] ${n} legacy scoped attendance_rules row(s) exist and are IGNORED (rules are global-only). Run scripts/reconcile-legacy-attendance-rules.js and migrate them deliberately.`);
    } catch { /* diagnostic only */ }
  })();
}

async function getRules(_branchId, _departmentId, _employeeId) {
  noteLegacyScopedRules();
  const dynamic = await ruleStore.getRuleMap().catch(() => ({}));
  return { ...DEFAULT_RULES, ...dynamic };
}

// ─── Batched rules lookup (Perf Batch 1) ────────────────────────────────────
// Same output as calling getRules() once per employee, but with ONE cached ruleStore lookup for the whole
// batch. Rules are global, so every employee gets (a fresh copy of) the same object. Returns a
// Map<employeeId, rulesObject>.
async function getRulesBatch(employees) {
  noteLegacyScopedRules();
  const dynamic = await ruleStore.getRuleMap().catch(() => ({}));
  const baseRules = { ...DEFAULT_RULES, ...dynamic };
  const result = new Map();
  for (const emp of employees) result.set(emp.id, { ...baseRules });
  return result;
}

function parseTime(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function calcOvertimeHours(overtimeMinutes, rounding) {
  if (overtimeMinutes < rounding) return 0;
  return Math.floor(overtimeMinutes / rounding);
}

// weekend_days is stored in two formats and BOTH must be understood:
//   - numeric day indexes (legacy / seed): '5', '5,6'   (0=Sun .. 6=Sat)
//   - day names written by the Attendance Settings page: 'fri', 'sat', 'fri,sat'
// Before names were handled they went through Number() → NaN and silently never
// matched, so choosing Friday/Saturday in the UI had no effect.
const WEEKDAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function isWeekend(date, weekendDays) {
  // '' (no automatic weekly off-day) must parse to [] — empty segments are
  // dropped first, or '' would incorrectly become day 0 (Sunday).
  const days = (weekendDays || '').split(',').map(s => s.trim().toLowerCase()).filter(s => s !== '')
    .map(s => (/^\d+$/.test(s) ? Number(s) : WEEKDAY_INDEX[s.slice(0, 3)]));
  return days.includes(date.getDay());
}

async function isHoliday(date, branchId) {
  const src = new Date(date);
  // Holiday.date is stored at UTC midnight (date-only strings parse as UTC).
  // setHours(0,0,0,0) truncates in the SERVER's local timezone instead, which
  // shifts the comparison timestamp whenever the server isn't UTC (e.g.
  // Asia/Riyadh, UTC+3) — the exact-match query below would then never find
  // any holiday at all. Rebuild the truncated date from UTC components so the
  // comparison always matches the UTC-midnight value the row was stored with.
  const d = new Date(Date.UTC(src.getUTCFullYear(), src.getUTCMonth(), src.getUTCDate()));
  const holiday = await prisma.holiday.findFirst({
    where: {
      date: d,
      OR: [{ branchId }, { branchId: null }],
    },
  });
  return !!holiday;
}

module.exports = { getRules, getRulesBatch, parseTime, calcOvertimeHours, isWeekend, isHoliday, isRuleTrue };
