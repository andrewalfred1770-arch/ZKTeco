// Generic manual-edit audit trail. One row per changed field — used by
// PUT /attendance/daily/:id (attendance overrides), PUT /payroll/:id
// (bonus / manual deduction adjustment), and POST/DELETE /advances.
const { getPrisma } = require('./prisma');
const logger = require('./logger');

const prisma = getPrisma();

/**
 * @param {object} opts
 * @param {number} opts.employeeId
 * @param {number|null} [opts.attendanceDailyId]
 * @param {number|null} [opts.payrollId]
 * @param {string} opts.fieldName
 * @param {*} [opts.oldValue]
 * @param {*} [opts.newValue]
 * @param {string|null} [opts.reason]
 * @param {number} [opts.userId]
 * @param {string} [opts.userName]
 * @param {string} [opts.userRole]
 * @param {string} [opts.source] - origin of the edit, e.g. 'inline-grid', 'modal'
 */
async function writeAudit({
  employeeId, attendanceDailyId = null, payrollId = null,
  fieldName, oldValue = null, newValue = null, reason = null,
  userId = 0, userName = 'HR', userRole = 'hr', source = 'inline-grid',
}) {
  const row = await prisma.manualEditAuditLog.create({
    data: {
      employeeId,
      attendanceDailyId,
      payrollId,
      fieldName,
      oldValue: oldValue != null ? String(oldValue) : null,
      newValue: newValue != null ? String(newValue) : null,
      reason,
      modifiedBy: userId,
      modifiedByName: userName,
      modifiedByRole: userRole,
      source,
    },
  });

  logger.info(
    `[AUDIT-WRITE] employee=${employeeId} field=${fieldName} ` +
    `old=${oldValue ?? '—'} new=${newValue ?? '—'} by=${userName}` +
    (attendanceDailyId ? ` attendanceDailyId=${attendanceDailyId}` : '') +
    (payrollId ? ` payrollId=${payrollId}` : '') +
    (reason ? ` reason="${reason}"` : '')
  );

  return row;
}

// ─── Verified manual-edit resolution (EF-014) ─────────────────────────────────
// Root cause: PUT /attendance/daily/:id always marks a row manualEdit=true
// via processDate({manual}), even on a no-op save where no AUDITED_FIELD
// actually changed value — that route's own audit-write is correctly
// conditional per-field, so such a row ends up manualEdit=true with ZERO
// ManualEditAuditLog rows (live-verified: 10 of 82 manualEdit=true rows in
// production had no audit entry, no approved adjustment, and no manual
// override units). Since attendanceEngine.js's DB column must stay untouched
// (it protects the row from automatic reprocessing — a separate, correct
// concern), every read path instead resolves the DISPLAYED manual-edit state
// from real evidence: an audit log entry, an approved adjustment, or a set
// manual override unit. Batched — one query per record set, not per row.
async function resolveVerifiedManualEditIds(recordIds) {
  if (!recordIds.length) return new Set();
  const rows = await prisma.manualEditAuditLog.findMany({
    where: { attendanceDailyId: { in: recordIds } },
    select: { attendanceDailyId: true },
    distinct: ['attendanceDailyId'],
  });
  return new Set(rows.map(r => r.attendanceDailyId));
}

/** True only if `rec.manualEdit` is backed by real evidence — see resolveVerifiedManualEditIds. */
function hasVerifiedManualEdit(rec, verifiedIds, hasApprovedAdjustment) {
  if (!rec?.manualEdit) return false;
  if (verifiedIds.has(rec.id)) return true;
  if (hasApprovedAdjustment) return true;
  if (rec.manualLatePenaltyUnits != null || rec.manualEarlyPenaltyUnits != null
    || rec.manualOvertimeUnits != null) return true;
  return false;
}

module.exports = { writeAudit, resolveVerifiedManualEditIds, hasVerifiedManualEdit };
