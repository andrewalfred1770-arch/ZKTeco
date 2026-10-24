/**
 * placeholderDay.js — saving a manual edit on a calendar day that has NO AttendanceDaily row yet (Employee Movement).
 *
 * THE BUG THIS FIXES. GET /attendance/movement lists every calendar day of the month, but a day for which nothing ever created an
 * AttendanceDaily row comes back with `id: null` (the "placeholder" row). Rows are only created by the engine: processToday() (today
 * only, from the sync scheduler), processDate() for days with raw punches, or an explicit month processing. So for an employee who
 * worked several days before being enrolled on the fingerprint device — no punches, never processed — the days before enrollment have
 * no row. The grid nevertheless showed those cells as editable, but every save path started with `if (!rowData?.id) return;`: the typed
 * time was accepted by the cell and then silently dropped (no request, no message, gone after refresh). The only manual-edit endpoint,
 * PUT /attendance/daily/:id, addresses a row by id, so there was nothing to call.
 *
 * THE FIX (no backend or API change). Before saving, make the row exist, using endpoints that already exist:
 *   1. POST /attendance/process { employeeId, date }  — the engine creates the day's row exactly as it would for any day (idempotent:
 *      one row per employee+date, serialized by the server's per-day lock),
 *   2. GET  /attendance/movement { employeeId, month } — read the stored row (and its id) back,
 * then the page swaps the placeholder for the stored row and runs the ORDINARY edit on it: the same PUT /daily/:id, validation, audit,
 * manualEdit lock, payroll recalculation and duplicate protection as every other manual edit. AttendanceDaily stays the single source
 * of truth; nothing is written client-side.
 *
 * Concurrent edits of the same placeholder day (the operator Tab-s from check-in to check-out) share ONE materialization.
 */

/** A day the server has no AttendanceDaily row for (Movement's `id: null`), and that we can address by employee + date. */
export function isPlaceholderDay(row) {
  return !!row && (row.id === null || row.id === undefined) && row.employeeId !== null && row.employeeId !== undefined && typeof row.date === 'string' && row.date.length === 10;
}

/** The grid's own row key for a placeholder (the same fallback EmployeeMovementPage.getRowId uses). */
export const placeholderKey = (row) => `${row.employeeId}-${row.date}`;

const samePlaceholder = (r, row) => isPlaceholderDay(r) && r.employeeId === row.employeeId && r.date === row.date;

/** rows with the placeholder for (employeeId, date) replaced by the stored row. Other rows (including other placeholders) are untouched. */
export function replacePlaceholder(rows, fresh) {
  return (rows || []).map((r) => (samePlaceholder(r, fresh) ? fresh : r));
}

/** rows with one field of the placeholder for (employeeId, date) set to `value` (used to restore a typed cell). */
export function setPlaceholderField(rows, row, field, value) {
  return (rows || []).map((r) => (samePlaceholder(r, row) ? { ...r, [field]: value } : r));
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The same input checks the ordinary edit applies, evaluated BEFORE anything is created on the server, so an invalid value never
 * leaves a placeholder row behind. Returns the Arabic error text, or null when the value is acceptable.
 */
export function validatePlaceholderEdit(field, newValue, { hhmmFields = [], overrideFields = [] } = {}) {
  if (hhmmFields.includes(field) && newValue && !HHMM_RE.test(newValue)) return 'صيغة الوقت غير صحيحة (HH:mm)';
  if (overrideFields.includes(field) && newValue !== null && newValue !== undefined && newValue !== '') {
    const n = Number(newValue);
    if (!Number.isFinite(n) || n < 0) return 'القيمة يجب أن تكون رقمًا موجبًا';
  }
  return null;
}

/** An edit that changes nothing must not create a row. */
export function isNoopPlaceholderEdit(newValue, oldValue) {
  const empty = (v) => v === null || v === undefined || v === '';
  if (empty(newValue) && empty(oldValue)) return true;
  return newValue === oldValue;
}

/**
 * Creates (if needed) and returns the stored row for one employee+day.
 * `http` is the app's api client (baseURL already ends with /api). Throws on any failure — the caller decides how to report it.
 */
export async function materializeDay(http, { employeeId, date }) {
  await http.post('/attendance/process', { employeeId, date });
  const { data } = await http.get('/attendance/movement', { params: { employeeId, month: date.slice(0, 7) } });
  const row = ((data && data.days) || []).find((d) => d.date === date && d.employeeId === employeeId);
  if (!row || row.id === null || row.id === undefined) {
    const err = new Error('تعذّر إنشاء سجل الحضور لهذا اليوم');
    err.code = 'ROW_NOT_CREATED';
    throw err;
  }
  return row;
}

/** One materialization per employee+day at a time: concurrent callers share the same promise. */
export function createDayMaterializer(http) {
  const pending = new Map();
  return {
    ensure(row) {
      const key = placeholderKey(row);
      if (pending.has(key)) return pending.get(key);
      const p = materializeDay(http, { employeeId: row.employeeId, date: row.date }).finally(() => { pending.delete(key); });
      pending.set(key, p);
      return p;
    },
    pendingCount: () => pending.size,
  };
}
