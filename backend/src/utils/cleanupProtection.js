/**
 * cleanupProtection.js — THE one definition of "protected" attendance rows for the Data Cleanup tool.
 *
 * A daily row is PROTECTED (never deleted by cleanup, whatever the client sends) when it carries data a human entered and
 * that cannot be rebuilt from the raw fingerprint logs:
 *   - manualEdit = true                          (HR-locked times/status — written only by the manual-edit routes)
 *   - manualLate/Early/Condition/OvertimeUnits   (explicit manual penalty / overtime overrides, 0 included)
 *   - manualPenaltyReason / At / By / ByName     (who/why of a manual penalty)
 *   - absenceReason / absenceSetBy / absenceSetAt
 *       Only PUT /attendance/:id/absence-type and POST /attendance/bulk-mark-unauthorized write these (routes/attendance/manual.js),
 *       and the engine's upsert never touches them (DAILY_RESET does not list them), so a non-null value is proof of a human
 *       action. `absenceType` alone is NOT protective: the engine auto-fills 'with_permission' on every absent row.
 *   - a linked AttendanceAdjustment, in ANY approval status
 *
 * The same field lists build (a) the Prisma `where` used by preview/backup and (b) the SQL used by the delete, so the two cannot
 * drift apart. Column names equal the Prisma field names for these columns (no @map). Pure functions, no I/O.
 */

const MANUAL_UNIT_FIELDS = ['manualLatePenaltyUnits', 'manualEarlyPenaltyUnits', 'manualConditionUnits', 'manualOvertimeUnits'];
const MANUAL_PENALTY_META_FIELDS = ['manualPenaltyReason', 'manualPenaltyAt', 'manualPenaltyBy', 'manualPenaltyByName'];
const ABSENCE_META_FIELDS = ['absenceReason', 'absenceSetBy', 'absenceSetAt'];
const NULLABLE_PROTECTIVE_FIELDS = [...MANUAL_UNIT_FIELDS, ...MANUAL_PENALTY_META_FIELDS, ...ABSENCE_META_FIELDS];

/** Fields to `select` when classifying rows in JS (summaries). */
const PROTECTION_SELECT = {
  id: true, employeeId: true, date: true, manualEdit: true,
  ...Object.fromEntries(NULLABLE_PROTECTIVE_FIELDS.map((f) => [f, true])),
  adjustment: { select: { id: true } },
};

/** Prisma where: the row IS protected. */
function protectedDailyWhere() {
  return {
    OR: [
      { manualEdit: true },
      ...NULLABLE_PROTECTIVE_FIELDS.map((f) => ({ [f]: { not: null } })),
      { adjustment: { isNot: null } },
    ],
  };
}

/** Prisma where: the row is NOT protected (explicit conjunction — no NOT(...) over nullable columns). */
function unprotectedDailyWhere() {
  return {
    manualEdit: false,
    ...Object.fromEntries(NULLABLE_PROTECTIVE_FIELDS.map((f) => [f, null])),
    adjustment: { is: null },
  };
}

/**
 * SQL equivalent of unprotectedDailyWhere() for the table alias `d` (attendance_daily) LEFT JOINed to `a` (attendance_adjustments).
 * Built only from the constant lists above — never from request data.
 */
function unprotectedDailySqlCondition() {
  return ['d.manualEdit = 0', ...NULLABLE_PROTECTIVE_FIELDS.map((f) => `d.${f} IS NULL`), 'a.id IS NULL'].join(' AND ');
}

/** Categories a row belongs to (a row can be in several). */
function categoriesOf(row) {
  const cats = [];
  if (row.adjustment) cats.push('adjustment');
  if (row.manualEdit) cats.push('manualEdit');
  if (MANUAL_UNIT_FIELDS.some((f) => row[f] !== null && row[f] !== undefined)
    || MANUAL_PENALTY_META_FIELDS.some((f) => row[f] !== null && row[f] !== undefined)) cats.push('manualPenalty');
  if (ABSENCE_META_FIELDS.some((f) => row[f] !== null && row[f] !== undefined)) cats.push('absenceMetadata');
  return cats;
}

/**
 * Summarise protected rows WITHOUT double counting: every row is counted once in `total` and once in `byPrimary`
 * (first matching category in priority order); `overlapping` counts rows per category and CAN sum to more than `total`.
 */
function summarizeProtectedRows(rows) {
  const order = ['adjustment', 'manualEdit', 'manualPenalty', 'absenceMetadata'];
  const byPrimary = Object.fromEntries(order.map((k) => [k, 0]));
  const overlapping = Object.fromEntries(order.map((k) => [k, 0]));
  for (const r of rows) {
    const cats = categoriesOf(r);
    if (!cats.length) continue;
    byPrimary[order.find((k) => cats.includes(k))]++;
    cats.forEach((c) => { overlapping[c]++; });
  }
  return { total: rows.length, byPrimary, overlapping };
}

module.exports = {
  NULLABLE_PROTECTIVE_FIELDS, PROTECTION_SELECT,
  protectedDailyWhere, unprotectedDailyWhere, unprotectedDailySqlCondition, categoriesOf, summarizeProtectedRows,
};
