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
  'absence_deduct_days', 'early_leave_penalty', 'month_days',
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
  absence_deduct_days: 30, month_days: 31, work_hours_per_day: 24,
  annual_leave_days: 365, sick_leave_days: 365,
};

const MAX_TIER_UNITS = 24; // deduction units are hours-equivalent; > a full day is a typo

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
    const winEnd = other('checkin_window_end');
    if (winEnd !== null) {
      sorted.forEach(t => {
        if (timeToMin(t.fromTime) > winEnd) {
          errors.push(`${label}: الشريحة (${t.fromTime} → ${t.toTime}) تقع بعد نهاية نافذة الحضور (${(allRules.find(x => x.key === 'checkin_window_end') || {}).value}) — لا يمكن لأي بصمة حضور الوصول إليها؛ عدّل النافذة أو احذف الشريحة`);
        }
      });
    }
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
      return [];
    }
    case 'number':
    case 'percentage': {
      const n = Number(v);
      if (v.trim() === '' || !Number.isFinite(n)) return [`${label}: "${v}" ليس رقماً صالحاً`];
      if (NON_NEGATIVE_NUMBER.has(rule.key) && n < 0) return [`${label}: القيمة (${n}) لا يمكن أن تكون سالبة`];
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
