const { getPrisma } = require('../utils/prisma');
const ruleStore = require('../services/ruleStore');
const prisma = getPrisma();

const DEFAULT_RULES = {
  // ── Shift timing ──────────────────────────────────────────────────────────────
  work_start: '09:00',
  work_end:   '17:00',
  checkin_window_start: '05:00',
  checkin_window_end:   '12:00',

  // ── Grace / thresholds ────────────────────────────────────────────────────────
  late_grace:        '0',   // minutes: no penalty below this lateness
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
  overtime_minimum:    '50',   // min OT minutes before counting any OT
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
  absence_deduct_days:    '1',   // default penalty days when no absenceType set
  late_penalty_per_minute:'0',   // legacy per-minute rate (superseded by tiers)
};

async function getRules(branchId, departmentId, employeeId) {
  const rows = await prisma.attendanceRule.findMany({
    where: {
      OR: [
        { branchId: null, departmentId: null, employeeId: null },
        { branchId },
        { departmentId },
        ...(employeeId ? [{ employeeId }] : []),
      ],
    },
    orderBy: { id: 'asc' },
  });

  // Precedence: hardcoded defaults → Dynamic Rules Engine (DB) → legacy scoped overrides.
  // The Dynamic Rules table is seeded with the same keys/values as DEFAULT_RULES, so
  // results are unchanged until a rule is edited from the Rules page.
  const dynamic = await ruleStore.getRuleMap().catch(() => ({}));
  const rules = { ...DEFAULT_RULES, ...dynamic };

  // The Dynamic Rules table is now the GLOBAL source of truth, so legacy global
  // rows (no branch/dept/employee) are ignored here. Legacy rows are only used
  // for branch → department → employee scoped overrides (most specific wins).
  for (const row of rows.filter(r => r.branchId && !r.departmentId && !r.employeeId)) {
    rules[row.ruleKey] = row.ruleValue;
  }
  for (const row of rows.filter(r => r.departmentId && !r.employeeId)) {
    rules[row.ruleKey] = row.ruleValue;
  }
  for (const row of rows.filter(r => r.employeeId)) {
    rules[row.ruleKey] = row.ruleValue;
  }

  return rules;
}

function parseTime(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function calcOvertimeHours(overtimeMinutes, rounding) {
  if (overtimeMinutes < rounding) return 0;
  return Math.floor(overtimeMinutes / rounding);
}

function isWeekend(date, weekendDays) {
  // '' (no automatic weekly off-day) must parse to [] — Number('') is 0, not NaN,
  // so empty segments are dropped BEFORE the Number() conversion or '' would
  // incorrectly become day 0 (Sunday).
  const days = (weekendDays || '').split(',').map(s => s.trim()).filter(s => s !== '').map(Number);
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

module.exports = { getRules, parseTime, calcOvertimeHours, isWeekend, isHoliday };
