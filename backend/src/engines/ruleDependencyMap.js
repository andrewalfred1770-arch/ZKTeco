/**
 * ruleDependencyMap.js — static map of "this rule key feeds these engines and
 * shows up on these screens".
 *
 * Built FROM the actual wiring in attendanceEngine.js / payrollEngine.js /
 * rulesEngine.js (not invented up front) — it's the "Full Dependency Mapping"
 * the rules engine needs so:
 *   1) recalcEngine can scope its work precisely instead of guessing, and
 *   2) RuleDrawer can show editors a real "🔗 يؤثر على:" impact list.
 *
 * Keep this in sync whenever a new rule key is wired into a calculation —
 * it's the single registry that both consumers read from.
 */
const ATTENDANCE_SCREENS = ['الحضور اليومي', 'الحضور الشهري', 'حركة الموظف', 'البصمات'];
const PAYROLL_SCREENS    = ['كشف المرتبات', 'الإضافي', 'الاستقطاعات'];
const ALL_SCREENS        = [...ATTENDANCE_SCREENS, ...PAYROLL_SCREENS, 'الرئيسية', 'التقارير'];

function entry(engines, affects) { return { engines, affects }; }

module.exports = {
  // ── Attendance ───────────────────────────────────────────────────────────
  work_start:          entry(['attendance'], ATTENDANCE_SCREENS),
  work_end:            entry(['attendance'], ATTENDANCE_SCREENS),
  late_grace:          entry(['attendance'], ATTENDANCE_SCREENS),
  // ⚠️ late_limit is DEPRECATED and NOT consumed — attendanceEngine.computeDerivedFields
  // intentionally never reads it (the Late Rules tier table's own fromTime boundaries
  // already encode any grace threshold; a separate late_limit gate used to silently
  // conflict with tier matches — see the certified production defect this fixed).
  // Kept in the DB for backward-compat/audit history only. Hidden from the default
  // Rules UI (RulesPage.INERT_KEYS) and badged "غير مُفعّل" when shown via showAdvanced.
  late_limit:          entry([], []),
  // min_work_hours, mark_absent_below, break_minutes removed 2026-06-22
  early_leave_grace:   entry(['attendance'], ATTENDANCE_SCREENS),
  weekend_days:        entry(['attendance', 'payroll'], ALL_SCREENS),
  friday_is_weekend:   entry(['attendance', 'payroll'], ALL_SCREENS),
  checkin_window_start: entry(['attendance'], ATTENDANCE_SCREENS),
  checkin_window_end:   entry(['attendance'], ATTENDANCE_SCREENS),

  // ── Overtime ──────────────────────────────────────────────────────────────
  // ⚠️ overtime_start is NOT consumed in practice — attendanceEngine.computeDerivedFields
  // resolves the evening-OT boundary as `policyConfig.shiftEndTime || legacyRules.overtime_start
  // || '17:00'`, and shiftEndTime (from work_end, always configured) is truthy in every real
  // configuration, so the fallback to this key is unreachable. Not seeded by default and not
  // rendered by the standard Rules UI; kept only so an existing DB row (if any) doesn't error.
  overtime_start:          entry([], []),
  // ⚠️ overtime_rounding is NOT yet consumed — the policy engine's OT-hour floor is fixed at 60
  // minutes, and re-deriving it from this rule would silently change every existing OT amount
  // the moment it's wired (the seeded default '50' ≠ the hardcoded 60). Left as configuration only.
  overtime_rounding:       entry([], []),
  overtime_minimum:        entry(['attendance', 'payroll'], [...ATTENDANCE_SCREENS, ...PAYROLL_SCREENS]),
  overtime_multiplier:     entry(['payroll'], PAYROLL_SCREENS),
  overtime_cap_hours:      entry(['attendance', 'payroll'], [...ATTENDANCE_SCREENS, ...PAYROLL_SCREENS]),
  friday_ot_multiplier:    entry(['payroll'], PAYROLL_SCREENS),
  holiday_ot_multiplier:   entry(['payroll'], PAYROLL_SCREENS),

  // ── Deductions ────────────────────────────────────────────────────────────
  late_penalty_per_minute: entry(['payroll'], PAYROLL_SCREENS),
  absence_deduct_days:     entry(['payroll'], PAYROLL_SCREENS),
  early_leave_penalty:     entry(['payroll'], PAYROLL_SCREENS),
  // half_day_deduction removed 2026-06-22
  advance_max_percent:     entry(['payroll'], ['السلف', ...PAYROLL_SCREENS]),

  // ── Payroll ───────────────────────────────────────────────────────────────
  month_days:               entry(['payroll'], PAYROLL_SCREENS),
  working_days_per_month:   entry([], []),
  work_hours_per_day:       entry(['payroll'], PAYROLL_SCREENS),
  day_rate_formula:         entry(['payroll'], PAYROLL_SCREENS),
  hour_rate_formula:        entry(['payroll'], PAYROLL_SCREENS),

  // ── Leaves (configuration only — see Rule.description for status) ────────
  annual_leave_days:   entry([], []),
  sick_leave_days:     entry([], []),

  // ── Shifts ────────────────────────────────────────────────────────────────
  // night_shift_start/_bonus are evaluated against stored check-in times during payroll calculation
  night_shift_start:  entry(['payroll'], PAYROLL_SCREENS),
  night_shift_bonus:  entry(['payroll'], PAYROLL_SCREENS),

  // ── Holidays ──────────────────────────────────────────────────────────────
  holiday_pay_multiplier:  entry(['payroll'], PAYROLL_SCREENS),
  weekend_work_multiplier: entry(['payroll'], PAYROLL_SCREENS),
};
