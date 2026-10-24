/**
 * accountLifecycle.js — keeps users.active consistent with the employee a login account belongs to (F4).
 *
 * Rules (no schema change, no deletion):
 *   - Only an account whose role is 'employee' is touched. An admin/hr account that happens to be linked to an employee row is a
 *     staff account and must never be disabled by archiving/deleting a person (it could lock the last administrator out).
 *   - The account is DEACTIVATED (active=false), never deleted: audit rows and history keep their references.
 *   - Re-activating an employee does NOT re-enable the account automatically: nothing records whether it was disabled by this
 *     rule or by an administrator, so re-enabling is a deliberate decision (see the remediation report, "needs approval").
 *   - Employee.userId is UNIQUE, so an account is never shared between employees.
 * Disabled accounts are refused on the next request (middleware/auth.js#authenticate loads users.active every time) and at login
 * (routes/auth.js), and the socket guard disconnects their live sockets.
 */

/**
 * @param {{user:{updateMany:Function}}} db  prisma client or transaction client
 * @param {number|null|undefined} userId     Employee.userId
 * @returns {Promise<number>} accounts deactivated (0 or 1)
 */
async function deactivateEmployeeAccount(db, userId) {
  if (!Number.isInteger(userId)) return 0;
  const r = await db.user.updateMany({ where: { id: userId, role: 'employee', active: true }, data: { active: false } });
  return r && r.count ? r.count : 0;
}

module.exports = { deactivateEmployeeAccount };
