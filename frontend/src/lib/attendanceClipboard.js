/**
 * attendanceClipboard.js — shared copy/paste logic for every editable
 * attendance grid (Daily, Monthly, Employee Movement).
 *
 * PURE logic, no React, no network. It decides WHICH values may travel from
 * one attendance row to another and builds the request bodies for the SAME
 * endpoints the inline grids already use:
 *   PUT /attendance/daily/:id            (checkIn / checkOut / status / workedMinutes)
 *   PUT /attendance/:id/manual-penalty   (late / early / overtime overrides)
 * so server-side validation, locks, calculation and audit are never bypassed.
 *
 * Never copied: employee id / name / code, the date, record id, audit
 * metadata, or any computed field (deductions, amounts, net effect…).
 * The target row's employee and date are always kept — they are not part of
 * the request body at all (the record is addressed by the target's own id).
 */
import { ACTOR, HHMM_RE, OVERRIDE_FIELD_MAP, toHHMM, normalizeDailyUpdate } from './attendanceUtils';

/** Fields that can be pasted. `lockedOnHoliday` mirrors the grids: on an
 *  official-holiday row only the status cell is editable. */
export const PASTE_FIELD_KEYS = [
  'checkIn', 'checkOut', 'status', 'workedMinutes',
  'effectiveLatePenalty', 'effectiveEarlyPenalty', 'effectiveOvertimeUnits',
];
const DAILY_KEYS = new Set(['checkIn', 'checkOut', 'status', 'workedMinutes']);
const HOLIDAY_LOCKED = new Set(['checkIn', 'checkOut', 'workedMinutes', ...Object.keys(OVERRIDE_FIELD_MAP)]);

/** Same set the server accepts for manual status overrides (validated again server-side). */
export const PASTE_STATUSES = ['present', 'late', 'early_leave', 'absent', 'half_day'];

export const isFieldLocked = (key, target) => !!(target?.isHoliday && HOLIDAY_LOCKED.has(key));

/** Snapshot ONLY the pasteable values of a row. `fallbackDate` is used when
 *  the row has no `date` (the Daily page keeps the date in page state). */
export function buildClip(row, fallbackDate) {
  if (!row) return null;
  return {
    sourceName: row.employeeName,
    sourceCode: row.employeeCode,
    sourceDate: row.date || fallbackDate || '',
    checkIn: toHHMM(row.checkIn),
    checkOut: toHHMM(row.checkOut),
    status: row.status,
    workedMinutes: row.workedMinutes ?? 0,
    effectiveLatePenalty: row.effectiveLatePenalty ?? 0,
    effectiveEarlyPenalty: row.effectiveEarlyPenalty ?? 0,
    effectiveOvertimeUnits: row.effectiveOvertimeUnits ?? 0,
  };
}

/** Why `target` cannot receive a paste, or null when it can. */
export function pasteBlockReason(clip, target, editMode = true) {
  if (!clip) return 'لا توجد حركة منسوخة';
  if (!editMode) return 'وضع القراءة فقط';
  if (!target?.id) return 'حدّد حركة واحدة لها سجل للصق عليها';
  return null;
}

/**
 * Turn the user's picked field keys into request bodies for `target`.
 * Returns { dailyBody, penaltyBody, reason } or { error }.
 * Unknown keys, and keys locked on a holiday row, are dropped (never sent).
 */
export function buildPasteRequests(clip, keys, target) {
  if (!clip || !target?.id) return { error: 'لا يمكن اللصق' };
  const picked = new Set((keys || []).filter(k => PASTE_FIELD_KEYS.includes(k) && !isFieldLocked(k, target)));
  if (!picked.size) return { error: 'لا توجد حقول للصق' };

  const dailyBody = {};
  if (picked.has('checkIn'))       dailyBody.checkIn = clip.checkIn || '';
  if (picked.has('checkOut'))      dailyBody.checkOut = clip.checkOut || '';
  if (picked.has('status'))        dailyBody.status = clip.status;
  if (picked.has('workedMinutes')) dailyBody.workedMinutes = clip.workedMinutes;
  for (const k of ['checkIn', 'checkOut']) {
    if (dailyBody[k] && !HHMM_RE.test(dailyBody[k])) return { error: 'صيغة الوقت غير صحيحة (HH:mm)' };
  }
  if ('status' in dailyBody && !PASTE_STATUSES.includes(dailyBody.status)) return { error: 'حالة غير قابلة للصق' };

  const penaltyBody = {};
  for (const [field, overrideKey] of Object.entries(OVERRIDE_FIELD_MAP)) {
    if (!picked.has(field)) continue;
    const n = Number(clip[field]) || 0;
    if (n < 0) return { error: 'القيمة يجب أن تكون رقمًا موجبًا' };
    penaltyBody[overrideKey] = n;
  }
  const reason = `نسخ/لصق حركة يدوية من ${clip.sourceName} (${clip.sourceDate})`;
  return { dailyBody, penaltyBody, reason };
}

/**
 * Execute a paste through `api` (the app's axios client). Time/status/worked
 * minutes go in one PUT, overrides in a second; the LAST successful response
 * is returned as `updated` even if the second call fails, so the caller can
 * show what the server actually saved.
 * Returns { updated, error? }.
 */
export async function pasteIntoRow(api, clip, keys, target) {
  const built = buildPasteRequests(clip, keys, target);
  if (built.error) return { updated: null, error: built.error };
  const { dailyBody, penaltyBody, reason } = built;
  let updated = null;
  try {
    if (Object.keys(dailyBody).length) {
      const res = await api.put(`/attendance/daily/${target.id}`, {
        ...dailyBody, reason, modifiedByName: ACTOR, source: 'inline-grid',
      });
      updated = normalizeDailyUpdate(res.data);
    }
    if (Object.keys(penaltyBody).length) {
      const res = await api.put(`/attendance/${target.id}/manual-penalty`, {
        ...penaltyBody, overrideReason: reason, modifiedByName: ACTOR, source: 'inline-grid',
      });
      updated = normalizeDailyUpdate(res.data);
    }
  } catch (err) {
    return { updated, error: err?.response?.data?.error || 'فشل لصق الحركة' };
  }
  return { updated };
}

// ── Tiny shared store so a copy on one page can be pasted on another ───────
let _clip = null;
const _subs = new Set();
export const getClip = () => _clip;
export const setClip = (c) => { _clip = c; _subs.forEach(f => f()); };
export const subscribeClip = (f) => { _subs.add(f); return () => _subs.delete(f); };
