/**
 * Live Business Rule Validation for the Attendance Settings page.
 *
 * Mirrors backend/src/utils/ruleValidation.js — the backend remains the
 * authoritative gate (it re-validates every save), this copy exists so the
 * user sees violations WHILE editing, before pressing Save.
 *
 * Policy: never auto-correct. Return errors (block save) and warnings
 * (allow save), each naming exactly what must be fixed.
 *
 * validateAttendanceConfig({ vals, lateTiers, earlyTiers })
 *   → { errors: string[], warnings: string[] }
 */

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const timeToMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

const MAX_TIER_UNITS = 24;

// Keep in step with backend/src/utils/ruleValidation.js (WEEKDAY_TOKENS / validateWeekendDays).
const WEEKDAY_TOKENS = new Set([
  '0', '1', '2', '3', '4', '5', '6',
  'sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat',
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
]);

const DAY_END_MIN = 23 * 60 + 59;
const minToTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// D6 / R1 (final business decision) — identical to backend ruleValidation.js lateCoverageErrors():
// late_rules must cover work_start → 23:59 with no gap. Never extended / defaulted automatically.
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

function validateTierList(label, tiers, { errors, warnings }) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    errors.push(`${label}: القائمة فارغة — أضف شريحة واحدة على الأقل أو عطّل القاعدة بدلاً من حفظ قائمة فارغة`);
    return null;
  }
  let structuralOk = true;
  tiers.forEach((t, i) => {
    const n = i + 1;
    if (!TIME_RE.test(t?.fromTime || '')) { errors.push(`${label} — شريحة ${n}: وقت البداية "${t?.fromTime ?? ''}" غير صالح (المطلوب HH:MM بين 00:00 و 23:59)`); structuralOk = false; }
    if (!TIME_RE.test(t?.toTime || ''))   { errors.push(`${label} — شريحة ${n}: وقت النهاية "${t?.toTime ?? ''}" غير صالح (المطلوب HH:MM بين 00:00 و 23:59)`); structuralOk = false; }
    const u = Number(t?.units);
    if (t?.units == null || t?.units === '' || !Number.isFinite(u)) { errors.push(`${label} — شريحة ${n}: عدد الوحدات مفقود أو غير رقمي`); structuralOk = false; }
    else {
      if (!Number.isInteger(u)) { errors.push(`${label} — شريحة ${n}: عدد الوحدات (${u}) يجب أن يكون عدداً صحيحاً`); structuralOk = false; }
      if (u < 0) { errors.push(`${label} — شريحة ${n}: عدد الوحدات (${u}) لا يمكن أن يكون سالباً — قيمة سالبة تعني إضافة راتب بدل خصم`); structuralOk = false; }
      if (u > MAX_TIER_UNITS) { errors.push(`${label} — شريحة ${n}: عدد الوحدات (${u}) يتجاوز الحد الأقصى المعقول (${MAX_TIER_UNITS})`); structuralOk = false; }
    }
  });
  if (!structuralOk) return null;

  tiers.forEach((t, i) => {
    const n = i + 1, from = timeToMin(t.fromTime), to = timeToMin(t.toTime);
    if (from > to) { errors.push(`${label} — شريحة ${n}: البداية (${t.fromTime}) بعد النهاية (${t.toTime}) — صحّح ترتيب الوقتين`); structuralOk = false; }
    else if (from === to) { errors.push(`${label} — شريحة ${n}: البداية والنهاية متطابقتان (${t.fromTime}) — الشريحة لا تغطي أي وقت`); structuralOk = false; }
  });
  if (!structuralOk) return null;

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
  return sorted;
}

export function validateAttendanceConfig({ vals, lateTiers, earlyTiers }) {
  const errors = [], warnings = [];
  const ctx = { errors, warnings };

  // ── Scalar time fields ──────────────────────────────────────────────────
  const times = {};
  for (const key of ['work_start', 'work_end', 'checkin_window_start', 'checkin_window_end']) {
    const v = String(vals[key] ?? '');
    if (!TIME_RE.test(v)) errors.push(`${labelOf(key)}: "${v}" ليس وقتاً صالحاً (HH:MM)`);
    else times[key] = timeToMin(v);
  }
  if (times.work_start != null && times.work_end != null && times.work_start >= times.work_end) {
    errors.push(`بداية الدوام (${vals.work_start}) يجب أن تسبق نهايته (${vals.work_end})`);
  }
  if (times.checkin_window_start != null && times.checkin_window_end != null
      && times.checkin_window_start >= times.checkin_window_end) {
    errors.push(`بداية نافذة الحضور (${vals.checkin_window_start}) يجب أن تسبق نهايتها (${vals.checkin_window_end})`);
  }

  // ── Scalar numeric fields ───────────────────────────────────────────────
  // Exactly the backend's rules (ruleValidation.js): same bounds, same wording. `positive` = must be
  // greater than zero (D7 — the overtime multipliers can never be 0); `min` = inclusive minimum.
  const numRules = {
    late_grace:            { max: 480 },
    early_leave_grace:     { max: 480 },
    overtime_minimum:      { max: 1440 },
    overtime_cap_hours:    { max: 24 },
    overtime_multiplier:   { max: 10, positive: true },
    friday_ot_multiplier:  { max: 10, positive: true },
    holiday_ot_multiplier: { max: 10, positive: true },
  };
  for (const [key, { min, max, positive }] of Object.entries(numRules)) {
    const v = String(vals[key] ?? '').trim();
    const n = Number(v);
    if (v === '' || !Number.isFinite(n)) errors.push(`${labelOf(key)}: "${v}" ليس رقماً صالحاً`);
    else if (n < 0) errors.push(`${labelOf(key)}: القيمة (${n}) لا يمكن أن تكون سالبة`);
    else if (positive && n <= 0) errors.push(`${labelOf(key)}: القيمة (${n}) يجب أن تكون أكبر من صفر — مضاعف الإضافي لا يمكن أن يكون صفراً (المعيار 1.5)`);
    else if (min != null && n < min) errors.push(`${labelOf(key)}: القيمة (${n}) أقل من الحد الأدنى المسموح (${min})`);
    else if (n > max) errors.push(`${labelOf(key)}: القيمة (${n}) تتجاوز الحد الأقصى المعقول (${max})`);
  }
  // weekend_days (E9): a value the engine would silently ignore is rejected, like the backend does.
  {
    const bad = String(vals.weekend_days ?? '').split(',').map(s => s.trim()).filter(s => s !== '')
      .filter(s => !WEEKDAY_TOKENS.has(s.toLowerCase()));
    if (bad.length) errors.push(`أيام الإجازة الأسبوعية: القيمة "${bad.join('، ')}" غير صالحة — المسموح: أرقام الأيام 0-6 (0=الأحد … 6=السبت) أو أسماء الأيام (sun, mon, tue, wed, thu, fri, sat) مفصولة بفواصل، أو فارغ لعدم وجود إجازة أسبوعية ثابتة`);
  }
  // grace vs shift length
  if (times.work_start != null && times.work_end != null) {
    const shiftLen = times.work_end - times.work_start;
    const grace = Number(vals.late_grace);
    if (Number.isFinite(grace) && grace >= shiftLen) {
      errors.push(`فترة السماح (${grace} دقيقة) أطول من مدة الدوام نفسها (${shiftLen} دقيقة)`);
    }
  }

  // ── Tier tables ─────────────────────────────────────────────────────────
  const lateSorted  = validateTierList('قواعد التأخير', lateTiers, ctx);
  const earlySorted = validateTierList('قواعد الانصراف المبكر', earlyTiers, ctx);

  // ── Cross-field: late-rule coverage (D6/R1) — a hard ERROR (blocks Save), same as the backend ──
  // (The former "tier after the check-in window is unreachable" error is gone: coverage through 23:59 now
  //  REQUIRES tiers after the window — they price manually entered check-ins.)
  if (lateSorted && times.work_start != null) {
    errors.push(...lateCoverageErrors('قواعد التأخير', lateSorted, times.work_start));
  }
  if (earlySorted && times.work_end != null) {
    earlySorted.forEach(t => {
      if (timeToMin(t.fromTime) > times.work_end) {
        errors.push(`قواعد الانصراف المبكر: الشريحة (${t.fromTime} → ${t.toTime}) تبدأ بعد نهاية الدوام (${vals.work_end}) — الانصراف بعد نهاية الدوام ليس مبكراً`);
      }
    });
    const firstFrom = timeToMin(earlySorted[0].fromTime);
    if (times.work_start != null && firstFrom > times.work_start + 60) {
      warnings.push(`قواعد الانصراف المبكر تبدأ عند ${earlySorted[0].fromTime} — الانصراف قبل ذلك (مبكر جداً) سيمر بلا خصم`);
    }
  }

  return { errors, warnings };
}

function labelOf(key) {
  return {
    work_start: 'بداية الدوام', work_end: 'نهاية الدوام',
    checkin_window_start: 'بداية نافذة الحضور', checkin_window_end: 'نهاية نافذة الحضور',
    late_grace: 'فترة السماح للتأخير', early_leave_grace: 'فترة السماح للانصراف المبكر',
    overtime_minimum: 'الحد الأدنى للأوفرتايم', overtime_multiplier: 'معامل الأوفرتايم',
    overtime_cap_hours: 'سقف الأوفرتايم اليومي', friday_ot_multiplier: 'معامل أوفرتايم الجمعة',
    holiday_ot_multiplier: 'معامل أوفرتايم العطلات',
  }[key] || key;
}
