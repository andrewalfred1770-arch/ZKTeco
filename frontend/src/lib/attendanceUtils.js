/**
 * attendanceUtils.js — shared attendance page utilities
 *
 * Extracted from AttendanceDailyPage, AttendanceMonthlyPage, EmployeeMovementPage.
 * Three pages had identical copies of every symbol in this file.
 *
 * DO NOT add business logic here.
 * These are display/normalization helpers only.
 */

// ── Actor identity ──────────────────────────────────────────────────────────
/** System actor name written to audit logs on inline edits. */
export const ACTOR = 'مدير النظام';

// ── Validation regex ────────────────────────────────────────────────────────
/** HH:mm 24-hour time format validator. */
export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ── Override field map ──────────────────────────────────────────────────────
/**
 * Maps the grid's editable effective-penalty column fields to the backend's
 * manual-override field names (PUT /attendance/:id/manual-penalty).
 */
export const OVERRIDE_FIELD_MAP = {
  effectiveLatePenalty:   'manualLatePenaltyUnits',
  effectiveEarlyPenalty:  'manualEarlyPenaltyUnits',
  effectiveOvertimeUnits: 'manualOvertimeUnits',
};

// ── Time helpers ────────────────────────────────────────────────────────────
/**
 * Convert any time value → "HH:mm" string, or null.
 *
 * Handles three input shapes:
 *   - Already-formatted "HH:mm" string (buildDailyResponseRow sends these)
 *     → passed through unchanged
 *   - Date object or ISO string
 *     → formatted to "HH:mm"
 *   - null / undefined / empty
 *     → returns null
 */
export function toHHMM(v) {
  if (!v) return null;
  if (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v)) return v;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── PUT response normalizer — FORMATTING ONLY ───────────────────────────────
/**
 * buildDailyResponseRow() on the backend already returns a COMPLETE row —
 * id, employeeId, employeeName, employeeCode, department, branch, date, and
 * every canonical attendance value (status, isWeekend, isHoliday,
 * effectiveLatePenalty, effectiveEarlyPenalty, effectiveOvertimeUnits,
 * effectiveTotalDeductionUnits, workedMinutes, overtimeHours, ...). This
 * function does display formatting ONLY (HH:mm time strings) — it must
 * never compute, derive, or fall back to a recalculated value. The result
 * is used as-is to fully REPLACE the matching row via replaceAttendanceRow();
 * nothing here participates in a merge.
 */
export function normalizeDailyUpdate(updated) {
  return {
    ...updated,
    checkIn:  toHHMM(updated.checkIn),
    checkOut: toHHMM(updated.checkOut),
  };
}

// ── Single row-update pipeline ──────────────────────────────────────────────
/**
 * The ONE way any attendance grid (Daily, Monthly, Movement) applies a PUT
 * response to its row list. Full immutable replacement of the matching row
 * — never a partial spread-merge, never a recomputation. The backend
 * response (already run through normalizeDailyUpdate for display formatting)
 * is the complete, final row.
 */
export function replaceAttendanceRow(rows, updatedRow) {
  return rows.map(r => (r.id === updatedRow.id ? updatedRow : r));
}

// ── Concurrent-edit-safe row apply ──────────────────────────────────────────
/**
 * A PUT response reflects the backend's row state at the moment THAT request
 * was processed. If a sibling field on the same row is still saving when this
 * response arrives (e.g. the user tabbed to the next editable cell before the
 * previous save resolved — the normal Excel-style flow `tabToNextCell` is
 * built for), the response is a stale snapshot that predates the sibling
 * edit. Blindly replacing the whole row (replaceAttendanceRow) would silently
 * revert that in-flight sibling field AND hand AG Grid a new row object
 * reference while it may still be reconciling an open editor on that same
 * row — the mechanism behind rows/cells transiently going blank mid-edit.
 *
 * When `rowHasOtherFieldsInFlight` is true, apply ONLY the field this
 * response is actually authoritative for; leave every other field as-is
 * (the sibling save's own apply — or the caller's post-drain reload — is
 * responsible for reconciling the rest). When false, no concurrent write
 * exists for this row and the full snapshot is safe to trust as before.
 */
export function applyRowFieldUpdate(rows, updatedRow, field, rowHasOtherFieldsInFlight) {
  return rows.map(r => {
    if (r.id !== updatedRow.id) return r;
    return rowHasOtherFieldsInFlight ? { ...r, [field]: updatedRow[field] } : updatedRow;
  });
}
