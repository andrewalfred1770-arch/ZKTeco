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

function validateTierList(label, tiers, { errors, warnings }) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    errors.push(`${label}: القائمة فارغة — أضف شريحة واحدة على الأقل`);
    return null;
  }
  let structuralOk = true;
  tiers.forEach((t, i) => {
    const n = i + 1;
    if (!TIME_RE.test(t?.fromTime || '')) { errors.push(`${label} — شريحة ${n}: وقت البداية "${t?.fromTime ?? ''}" غير صالح (HH:MM)`); structuralOk = false; }
    if (!TIME_RE.test(t?.toTime || ''))   { errors.push(`${label} — شريحة ${n}: وقت النهاية "${t?.toTime ?? ''}" غير صالح (HH:MM)`); structuralOk = false; }
    const u = Number(t?.units);
    if (t?.units == null || t?.units === '' || !Number.isFinite(u)) { errors.push(`${label} — شريحة ${n}: عدد الوحدات مفقود أو غير رقمي`); structuralOk = false; }
    else {
      if (!Number.isInteger(u)) { errors.push(`${label} — شريحة ${n}: الوحدات (${u}) يجب أن تكون عدداً صحيحاً`); structuralOk = false; }
      if (u < 0) { errors.push(`${label} — شريحة ${n}: وحدات سالبة (${u}) غير مسموحة — خصم سالب يعني إضافة راتب`); structuralOk = false; }
      if (u > MAX_TIER_UNITS) { errors.push(`${label} — شريحة ${n}: الوحدات (${u}) تتجاوز الحد الأقصى (${MAX_TIER_UNITS})`); structuralOk = false; }
    }
  });
  if (!structuralOk) return null;

  tiers.forEach((t, i) => {
    const n = i + 1, from = timeToMin(t.fromTime), to = timeToMin(t.toTime);
    if (from > to) { errors.push(`${label} — شريحة ${n}: البداية (${t.fromTime}) بعد النهاية (${t.toTime})`); structuralOk = false; }
    else if (from === to) { errors.push(`${label} — شريحة ${n}: البداية والنهاية متطابقتان (${t.fromTime}) — الشريحة لا تغطي أي وقت`); structuralOk = false; }
  });
  if (!structuralOk) return null;

  const sorted = [...tiers].sort((a, b) => timeToMin(a.fromTime) - timeToMin(b.fromTime));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], cur = sorted[i];
    const prevTo = timeToMin(prev.toTime), curFrom = timeToMin(cur.fromTime);
    if (curFrom === timeToMin(prev.fromTime) && timeToMin(cur.toTime) === prevTo) {
      errors.push(`${label}: شريحة مكررة (${cur.fromTime} → ${cur.toTime})`);
    } else if (curFrom <= prevTo) {
      errors.push(`${label}: الشريحة (${cur.fromTime} → ${cur.toTime}) تتداخل مع (${prev.fromTime} → ${prev.toTime}) — يجب أن تبدأ بعد نهاية السابقة بدقيقة`);
    } else if (curFrom > prevTo + 1) {
      errors.push(`${label}: فجوة بين ${prev.toTime} و ${cur.fromTime} — الوقت داخل الفجوة بلا خصم`);
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
  const numRanges = {
    late_grace: [0, 480], early_leave_grace: [0, 480],
    overtime_minimum: [0, 1440], overtime_multiplier: [0, 10],
    overtime_cap_hours: [0, 24], friday_ot_multiplier: [0, 10],
    holiday_ot_multiplier: [0, 10], absence_deduct_days: [0, 30],
  };
  for (const [key, [lo, hi]] of Object.entries(numRanges)) {
    const v = String(vals[key] ?? '').trim();
    const n = Number(v);
    if (v === '' || !Number.isFinite(n)) errors.push(`${labelOf(key)}: "${v}" ليس رقماً صالحاً`);
    else if (n < lo) errors.push(`${labelOf(key)}: القيمة (${n}) لا يمكن أن تكون أقل من ${lo}`);
    else if (n > hi) errors.push(`${labelOf(key)}: القيمة (${n}) تتجاوز الحد الأقصى المعقول (${hi})`);
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

  // ── Cross-field: reachability + coverage ────────────────────────────────
  if (lateSorted && times.checkin_window_end != null) {
    lateSorted.forEach(t => {
      if (timeToMin(t.fromTime) > times.checkin_window_end) {
        errors.push(`قواعد التأخير: الشريحة (${t.fromTime} → ${t.toTime}) غير قابلة للتحقق — نافذة الحضور تنتهي عند ${vals.checkin_window_end}؛ عدّل النافذة أو احذف الشريحة`);
      }
    });
    const lastTo = timeToMin(lateSorted[lateSorted.length - 1].toTime);
    if (lastTo < times.checkin_window_end) {
      warnings.push(`قواعد التأخير تنتهي عند ${lateSorted[lateSorted.length - 1].toTime} بينما نافذة الحضور تمتد حتى ${vals.checkin_window_end} — الحضور بينهما بلا خصم`);
    }
    if (times.work_start != null && timeToMin(lateSorted[0].fromTime) > times.work_start) {
      warnings.push(`قواعد التأخير تبدأ عند ${lateSorted[0].fromTime} بعد بداية الدوام (${vals.work_start}) — الفترة بينهما بلا قاعدة`);
    }
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
    holiday_ot_multiplier: 'معامل أوفرتايم العطلات', absence_deduct_days: 'خصم الغياب (أيام)',
  }[key] || key;
}
