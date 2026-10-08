/**
 * Business validation for rule values — the reject-and-explain gate between
 * the Attendance Settings / Rules UI and the engines.
 *
 * Policy: NEVER silently auto-correct. An invalid configuration is rejected
 * with a message that names every violation and exactly what must be fixed.
 * The engines assume whatever is stored here is valid — this module is the
 * only thing standing between an admin typo and a wrong salary.
 *
 * validateRuleValue(rule, value, allRules) → [] when valid, otherwise an
 * array of human-readable (Arabic) violation strings.
 */

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const timeToMin = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

// number-type rules that must never be negative (all of them today — deductions,
// multipliers, grace minutes, counts; none has a meaningful negative value)
const NON_NEGATIVE_NUMBER = new Set([
  'late_grace', 'late_limit', 'early_leave_grace', 'overtime_rounding',
  'overtime_minimum', 'overtime_multiplier', 'overtime_cap_hours',
  'friday_ot_multiplier', 'holiday_ot_multiplier', 'late_penalty_per_minute',
  'early_leave_penalty', 'month_days',
  'work_hours_per_day', 'annual_leave_days', 'sick_leave_days',
  'holiday_pay_multiplier', 'weekend_work_multiplier',
]);

// sane upper bounds — generous enough for any real business, tight enough to
// catch fat-fingered values (e.g. 99999 units) before they reach payroll
const NUMBER_MAX = {
  late_grace: 480, late_limit: 480, early_leave_grace: 480,
  overtime_minimum: 1440, overtime_cap_hours: 24, overtime_rounding: 60,
  overtime_multiplier: 10, friday_ot_multiplier: 10, holiday_ot_multiplier: 10,
  holiday_pay_multiplier: 10, weekend_work_multiplier: 10,
  late_penalty_per_minute: 100, early_leave_penalty: 100,
  month_days: 31, work_hours_per_day: 24,
  annual_leave_days: 365, sick_leave_days: 365,
};

// D7 (approved): the standard overtime rate is 1.5 (1 overtime hour = 1.5 hours of pay) and a
// multiplier of 0 is NOT allowed — it would record overtime hours that are never paid. Only "must be
// greater than zero" is enforced here; the lowest acceptable positive value is still an open
// business decision (R2), so no other minimum is invented.
const MUST_BE_POSITIVE = new Set([
  'overtime_multiplier', 'friday_ot_multiplier', 'holiday_ot_multiplier', 'weekend_work_multiplier',
]);

// weekend_days (E9): the engine's isWeekend() understands day numbers 0-6 (0=Sun..6=Sat) and English
// day names (abbreviated or full, any case). Anything else used to be silently ignored — a typo meant
// "no weekend". Keep this list in step with rulesEngine.WEEKDAY_INDEX.
const WEEKDAY_TOKENS = new Set([
  '0', '1', '2', '3', '4', '5', '6',
  'sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat',
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
]);

/** Validate weekend_days. '' (no automatic weekly off-day) is valid. Returns violation strings. */
function validateWeekendDays(label, v) {
  const bad = v.split(',').map(s => s.trim()).filter(s => s !== '')
    .filter(s => !WEEKDAY_TOKENS.has(s.toLowerCase()));
  if (!bad.length) return [];
  return [`${label}: القيمة "${bad.join('، ')}" غير صالحة — المسموح: أرقام الأيام 0-6 (0=الأحد … 6=السبت) أو أسماء الأيام (sun, mon, tue, wed, thu, fri, sat) مفصولة بفواصل، أو فارغ لعدم وجود إجازة أسبوعية ثابتة`];
}

const MAX_TIER_UNITS = 24; // deduction units are hours-equivalent; > a full day is a typo

const DAY_END_MIN = 23 * 60 + 59;
const DEFAULT_WORK_START_MIN = 9 * 60;   // the engine's own default (rulesEngine DEFAULT_RULES.work_start)
const minToTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// D6 / R1 (final business decision): the late_rules must cover `work_start → 23:59` with NO gap.
//   - coverage starts at work_start (tiers may start earlier; they may not start later)
//   - coverage continues through 23:59 (so a manual check-in after the attendance window is priced too)
// Gaps / overlaps / ordering between the tiers themselves are reported by validateTiers().
// Nothing is ever extended or defaulted to fill a hole — an incomplete table is rejected.
function lateCoverageErrors(label, sortedTiers, workStartMin) {
  const errs = [];
  const first = sortedTiers[0];
  const lastTier = sortedTiers.reduce((a, t) => (timeToMin(t.toTime) >= timeToMin(a.toTime) ? t : a), sortedTiers[0]);
  if (timeToMin(first.fromTime) > workStartMin) {
    errs.push(`${label}: يجب أن تبدأ التغطية عند بداية الدوام (${minToTime(workStartMin)}) أو قبلها — أول شريحة تبدأ عند ${first.fromTime} والوقت بينهما بلا قاعدة تأخير`);
  }
  if (timeToMin(lastTier.toTime) < DAY_END_MIN) {
    errs.push(`${label}: يجب أن تستمر التغطية حتى 23:59 — آخر شريحة تنتهي عند ${lastTier.toTime} والحضور بعدها بلا قاعدة تأخير`);
  }
  return errs;
}

/** The currently ACTIVE, well-formed late_rules from the rules list as a sorted tier array, or null (none / empty / malformed). */
function currentLateTiers(allRules) {
  const r = (allRules || []).find(x => x.key === 'late_rules' && x.isActive);
  if (!r || !r.value) return null;
  try {
    const t = JSON.parse(r.value);
    if (!Array.isArray(t) || !t.length) return null;
    if (!t.every(x => x && TIME_RE.test(x.fromTime || '') && TIME_RE.test(x.toTime || ''))) return null;
    return [...t].sort((a, b) => timeToMin(a.fromTime) - timeToMin(b.fromTime));
  } catch { return null; }
}

/** Validate a tier array (late_rules / early_rules). Returns violation strings. */
function validateTiers(key, value, allRules) {
  const label = key === 'late_rules' ? 'قواعد التأخير' : 'قواعد الانصراف المبكر';
  let tiers;
  try { tiers = JSON.parse(value); }
  catch { return [`${label}: القيمة ليست JSON صالحاً`]; }
  if (!Array.isArray(tiers)) return [`${label}: يجب أن تكون قائمة شرائح [من - إلى - وحدات]`];
  if (tiers.length === 0) return [`${label}: القائمة فارغة — أضف شريحة واحدة على الأقل أو عطّل القاعدة بدلاً من حفظ قائمة فارغة`];

  const errors = [];
  tiers.forEach((t, i) => {
    const n = i + 1;
    if (!t || typeof t !== 'object') { errors.push(`${label} — شريحة ${n}: بنية غير صالحة`); return; }
    if (!TIME_RE.test(t.fromTime || '')) errors.push(`${label} — شريحة ${n}: وقت البداية "${t.fromTime ?? ''}" غير صالح (المطلوب HH:MM بين 00:00 و 23:59)`);
    if (!TIME_RE.test(t.toTime || ''))   errors.push(`${label} — شريحة ${n}: وقت النهاية "${t.toTime ?? ''}" غير صالح (المطلوب HH:MM بين 00:00 و 23:59)`);
    if (t.units == null || typeof t.units !== 'number' || !Number.isFinite(t.units)) {
      errors.push(`${label} — شريحة ${n}: عدد الوحدات مفقود أو غير رقمي`);
    } else {
      if (!Number.isInteger(t.units)) errors.push(`${label} — شريحة ${n}: عدد الوحدات (${t.units}) يجب أن يكون عدداً صحيحاً`);
      if (t.units < 0) errors.push(`${label} — شريحة ${n}: عدد الوحدات (${t.units}) لا يمكن أن يكون سالباً — قيمة سالبة تعني إضافة راتب بدل خصم`);
      if (t.units > MAX_TIER_UNITS) errors.push(`${label} — شريحة ${n}: عدد الوحدات (${t.units}) يتجاوز الحد الأقصى المعقول (${MAX_TIER_UNITS})`);
    }
  });
  if (errors.length) return errors; // range checks below need well-formed tiers

  tiers.forEach((t, i) => {
    const n = i + 1;
    const from = timeToMin(t.fromTime), to = timeToMin(t.toTime);
    if (from > to) errors.push(`${label} — شريحة ${n}: البداية (${t.fromTime}) بعد النهاية (${t.toTime}) — صحّح ترتيب الوقتين`);
    else if (from === to) errors.push(`${label} — شريحة ${n}: البداية والنهاية متطابقتان (${t.fromTime}) — الشريحة لا تغطي أي وقت`);
  });
  if (errors.length) return errors;

  const sorted = [...tiers].sort((a, b) => timeToMin(a.fromTime) - timeToMin(b.fromTime));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], cur = sorted[i];
    const prevTo = timeToMin(prev.toTime), curFrom = timeToMin(cur.fromTime);
    if (curFrom <= prevTo) {
      const word = (curFrom === timeToMin(prev.fromTime) && timeToMin(cur.toTime) === prevTo) ? 'مكررة مع' : 'تتداخل مع';
      errors.push(`${label}: الشريحة (${cur.fromTime} → ${cur.toTime}) ${word} الشريحة (${prev.fromTime} → ${prev.toTime}) — يجب أن تبدأ كل شريحة بعد نهاية السابقة بدقيقة على الأقل`);
    } else if (curFrom > prevTo + 1) {
      errors.push(`${label}: فجوة بين نهاية الشريحة (${prev.toTime}) وبداية الشريحة (${cur.fromTime}) — الوقت داخل الفجوة لن يُطبَّق عليه أي خصم`);
    }
  }

  // Cross-field reachability — a tier no punch can ever reach is a config the
  // admin believes exists but never fires.
  const other = (k) => {
    const r = (allRules || []).find(x => x.key === k && x.isActive);
    return r && TIME_RE.test(r.value || '') ? timeToMin(r.value) : null;
  };
  if (key === 'late_rules') {
    // (The former "tier starts after the check-in window = unreachable" error is gone: the final rule requires
    //  coverage through 23:59, so tiers after the window are required, and they price manually entered check-ins.)
    const workStart = other('work_start') ?? DEFAULT_WORK_START_MIN;
    errors.push(...lateCoverageErrors(label, sorted, workStart));
  }
  if (key === 'early_rules') {
    const workEnd = other('work_end') ?? timeToMin('17:00');
    sorted.forEach(t => {
      if (timeToMin(t.fromTime) > workEnd) {
        errors.push(`${label}: الشريحة (${t.fromTime} → ${t.toTime}) تبدأ بعد نهاية الدوام — الانصراف بعد نهاية الدوام ليس انصرافاً مبكراً`);
      }
    });
  }
  return errors;
}

/**
 * Shift length in minutes, substituting `overrideValue` for `overrideKey`
 * (the field being edited) and reading the other side from allRules.
 * Returns null when either endpoint is missing/invalid.
 */
function shiftLengthWith(overrideKey, overrideValue, allRules) {
  const get = (k) => {
    if (k === overrideKey) return TIME_RE.test(overrideValue || '') ? timeToMin(overrideValue) : null;
    const r = (allRules || []).find(x => x.key === k);
    return r && TIME_RE.test(r.value || '') ? timeToMin(r.value) : null;
  };
  const start = get('work_start'), end = get('work_end');
  return (start != null && end != null && end > start) ? end - start : null;
}

/**
 * Validate a rule's new value. `rule` is the existing DB row (key/type/name),
 * `allRules` is the full rules list for cross-field checks (optional).
 * Returns an array of violation messages; empty array = valid.
 */
function validateRuleValue(rule, value, allRules) {
  const v = value == null ? '' : String(value);
  const label = rule.name || rule.key;

  if (rule.key === 'late_rules' || rule.key === 'early_rules') {
    return validateTiers(rule.key, v, allRules);
  }
  if (rule.key === 'weekend_days') {
    return validateWeekendDays(label, v);
  }

  switch (rule.type) {
    case 'time': {
      if (!TIME_RE.test(v)) return [`${label}: "${v}" ليس وقتاً صالحاً — المطلوب HH:MM بين 00:00 و 23:59`];
      // start < end for both time pairs (checked from whichever side is being edited)
      const PAIRS = {
        work_start: ['work_end', 'start'], work_end: ['work_start', 'end'],
        checkin_window_start: ['checkin_window_end', 'start'], checkin_window_end: ['checkin_window_start', 'end'],
      };
      if (rule.key in PAIRS) {
        const [otherKey, side] = PAIRS[rule.key];
        const other = (allRules || []).find(x => x.key === otherKey);
        if (other && TIME_RE.test(other.value || '')) {
          const start = side === 'start' ? timeToMin(v) : timeToMin(other.value);
          const end   = side === 'end'   ? timeToMin(v) : timeToMin(other.value);
          if (start >= end) {
            const startV = side === 'start' ? v : other.value, endV = side === 'end' ? v : other.value;
            return rule.key.startsWith('checkin')
              ? [`${label}: بداية نافذة الحضور (${startV}) يجب أن تسبق نهايتها (${endV})`]
              : [`${label}: بداية الدوام (${startV}) يجب أن تسبق نهايته (${endV})`];
          }
        }
      }
      // shift length change must not leave late_grace >= the new shift length
      if (rule.key === 'work_start' || rule.key === 'work_end') {
        const shiftLen = shiftLengthWith(rule.key, v, allRules);
        const graceRule = (allRules || []).find(x => x.key === 'late_grace');
        const grace = graceRule ? Number(graceRule.value) : NaN;
        if (shiftLen != null && Number.isFinite(grace) && grace >= shiftLen) {
          return [`${label}: مدة الدوام الجديدة (${shiftLen} دقيقة) أقصر من فترة السماح للتأخير (${grace} دقيقة) — قلّل فترة السماح أولاً`];
        }
      }
      // D6 / R1: a change to work_start (coverage start) or work_end / the attendance window must not leave the
      // saved late_rules without full coverage of work_start → 23:59. Rejected, never auto-extended or defaulted:
      // the user fixes the late rules first, then saves the conflicting setting.
      if (rule.key === 'work_start' || rule.key === 'work_end' || rule.key === 'checkin_window_start' || rule.key === 'checkin_window_end') {
        const lateTiers = currentLateTiers(allRules);
        if (lateTiers) {
          const wsRule = (allRules || []).find(x => x.key === 'work_start' && x.isActive);
          const prospectiveStart = rule.key === 'work_start' ? timeToMin(v)
            : (wsRule && TIME_RE.test(wsRule.value || '') ? timeToMin(wsRule.value) : DEFAULT_WORK_START_MIN);
          const errs = lateCoverageErrors('قواعد التأخير المحفوظة', lateTiers, prospectiveStart);
          if (errs.length) {
            return [`${label}: لا يمكن حفظ هذا التعديل لأنه يترك قواعد التأخير بلا تغطية كاملة من بداية الدوام حتى 23:59 — ${errs.join(' | ')} — عدّل قواعد التأخير أولاً ثم احفظ هذا الإعداد`];
          }
        }
      }
      return [];
    }
    case 'number':
    case 'percentage': {
      const n = Number(v);
      if (v.trim() === '' || !Number.isFinite(n)) return [`${label}: "${v}" ليس رقماً صالحاً`];
      if (NON_NEGATIVE_NUMBER.has(rule.key) && n < 0) return [`${label}: القيمة (${n}) لا يمكن أن تكون سالبة`];
      if (MUST_BE_POSITIVE.has(rule.key) && n <= 0) {
        return [`${label}: القيمة (${n}) يجب أن تكون أكبر من صفر — مضاعف الإضافي لا يمكن أن يكون صفراً (المعيار 1.5)`];
      }
      // late_grace must stay shorter than the configured shift length
      if (rule.key === 'late_grace') {
        const shiftLen = shiftLengthWith(null, null, allRules);
        if (shiftLen != null && n >= shiftLen) {
          return [`${label}: فترة السماح (${n} دقيقة) أطول من مدة الدوام نفسها (${shiftLen} دقيقة)`];
        }
      }
      if (rule.type === 'percentage' && (n < 0 || n > 100)) return [`${label}: النسبة (${n}) يجب أن تكون بين 0 و 100`];
      const max = NUMBER_MAX[rule.key];
      if (max != null && n > max) return [`${label}: القيمة (${n}) تتجاوز الحد الأقصى المعقول (${max})`];
      if ((rule.key === 'month_days' || rule.key === 'work_hours_per_day') && n <= 0) {
        return [`${label}: القيمة يجب أن تكون أكبر من صفر — القسمة على صفر تُفسد حساب الرواتب`];
      }
      return [];
    }
    case 'boolean':
      if (!['true', 'false', '1', '0', ''].includes(v.trim().toLowerCase())) {
        return [`${label}: "${v}" ليست قيمة منطقية صالحة (true/false)`];
      }
      return [];
    default:
      // text / formula — formula cycles are already validated separately in
      // routes/rules.js
      return [];
  }
}

module.exports = { validateRuleValue };
