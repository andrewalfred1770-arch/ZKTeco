/**
 * syncResultSummary.js — turns what the device-sync endpoints ACTUALLY answered into truthful status text.
 * Pure (no React, no network; the clock is a parameter).
 *
 * A device sync result is one of:
 *   skipped + skipReason 'DEVICE_DISABLED'      the device is disabled / missing — nothing was attempted
 *   skipped (any other reason, i.e. 'SYNC_ALREADY_RUNNING')
 *                                               another operation holds the device — nothing was attempted; the server also
 *                                               says WHO holds it (heldBy) and SINCE when (heldSince)
 *   error / success === false                   the sync ran and failed
 *   anything else                               the sync ran and succeeded
 * A skipped (busy / disabled) device is never reported as a success.
 */

const HOLDER_AR = {
  auto: 'مزامنة تلقائية',
  manual: 'مزامنة يدوية',
  'users-discovery': 'قراءة مستخدمي الجهاز',
  users: 'قراءة مستخدمي الجهاز',
  'delete-user': 'حذف مستخدم من الجهاز',
  ping: 'فحص الاتصال',
  'test-connection': 'اختبار الاتصال',
};

export const BUSY_BASE = 'الجهاز مشغول بمزامنة أخرى قيد التنفيذ حالياً';
export const DISABLED_MSG = 'الجهاز غير مفعّل أو غير موجود — فعّل الجهاز ثم أعد المحاولة';

export function classifySyncResult(r) {
  if (r && r.skipped) return r.skipReason === 'DEVICE_DISABLED' ? 'disabled' : 'busy';
  if (!r || r.error || r.success === false) return 'failed';
  return 'ok';
}

export function classifySyncResults(list) {
  const out = { ok: [], busy: [], disabled: [], failed: [], total: 0 };
  for (const r of Array.isArray(list) ? list : []) { out[classifySyncResult(r)].push(r); out.total++; }
  return out;
}

// Arabic number agreement: 1 -> singular, 2 -> dual, 3-10 -> plural, 11+ -> singular (tamyeez).
function arCount(n, one, two, few, many) {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${n} ${few}`;
  return `${n} ${many}`;
}

/** "منذ 45 ثانية" / "منذ دقيقتين" / "منذ 5 دقائق" — null when the server did not say (or the time is unusable). */
export function elapsedSince(heldSince, now = Date.now()) {
  const t = heldSince ? new Date(heldSince).getTime() : NaN;
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `منذ ${arCount(s, 'ثانية', 'ثانيتين', 'ثوانٍ', 'ثانية')}`;
  return `منذ ${arCount(Math.floor(s / 60), 'دقيقة', 'دقيقتين', 'دقائق', 'دقيقة')}`;
}

/** What currently holds ONE busy device, e.g. "مزامنة تلقائية منذ 45 ثانية"; '' when the server gave no holder. */
export function holderText(r, now = Date.now()) {
  if (!r || !r.heldBy) return '';
  const who = HOLDER_AR[r.heldBy] || String(r.heldBy);
  const since = elapsedSince(r.heldSince, now);
  return since ? `${who} ${since}` : who;
}

/** The busy sentence: the original wording, plus the holder when the server reported it. */
export function busyMessage(busyResults, now = Date.now()) {
  const list = Array.isArray(busyResults) ? busyResults : [];
  const detail = list.length === 1 ? holderText(list[0], now) : '';
  return `${BUSY_BASE}${detail ? ` (${detail})` : ''} — حاول مرة أخرى بعد قليل`;
}

/**
 * One toast for a finished sync (one or many devices):
 *   { level: 'success' | 'warning' | 'error', message }
 * success only when every device really synced; busy / disabled / failed devices are named in the message.
 */
export function buildSyncToast(list, { now = Date.now() } = {}) {
  const c = classifySyncResults(list);
  if (c.total === 0) return { level: 'warning', message: 'لا توجد أجهزة مفعّلة للمزامنة' };
  const newLogs = c.ok.reduce((s, r) => s + (Number(r.count) || 0), 0);
  if (c.ok.length === c.total) return { level: 'success', message: `تمت المزامنة — ${newLogs} حركة جديدة من ${c.total} جهاز`, newLogs };
  if (c.ok.length === 0 && c.failed.length === 0 && c.busy.length === 0) return { level: 'warning', message: DISABLED_MSG };
  if (c.ok.length === 0 && c.failed.length === 0 && c.disabled.length === 0) return { level: 'warning', message: busyMessage(c.busy, now) };

  const parts = [];
  if (c.ok.length) parts.push(`تمت مزامنة ${c.ok.length} من ${c.total} (${newLogs} حركة جديدة)`);
  if (c.busy.length) parts.push(`${c.busy.length} مشغول بمزامنة أخرى${c.busy.length === 1 && holderText(c.busy[0], now) ? ` (${holderText(c.busy[0], now)})` : ''} — لم تتم مزامنته`);
  if (c.disabled.length) parts.push(`${c.disabled.length} غير مفعّل`);
  if (c.failed.length) parts.push(`${c.failed.length} فشلت مزامنته`);
  return { level: c.failed.length && !c.ok.length ? 'error' : 'warning', message: parts.join(' — ') };
}
