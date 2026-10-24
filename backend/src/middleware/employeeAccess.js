/**
 * employeeAccess.js — read-view scoping for employee data.
 *
 * Owner decision: every user of the application may VIEW attendance and salary data of other employees, and there is no login in the
 * intended deployment (AUTH_ENABLED=false => every caller is treated as staff and nothing below changes any response). This module
 * therefore does NOT restrict who may read; it only withholds what the decision did not cover from a caller who is authenticated but
 * is not admin/hr (only possible when AUTH_ENABLED=true): editor identities and reasons on attendance rows, and an employee's personal
 * identifiers (national id, phone, e-mail) and linked login account.
 *
 *   viewerScope            — Express middleware; sets req.restrictedView = true for a non-staff authenticated caller.
 *   redactEmployeeForViewer(emp, req) — returns emp unchanged for staff / no-auth, otherwise without the fields above.
 */
const { AUTH_ENABLED } = require('./auth');

const STAFF_ROLES = ['admin', 'hr'];
const isStaff = (req, enabled = AUTH_ENABLED) => !enabled || (!!req.user && STAFF_ROLES.includes(req.user.role));

function viewerScope(req, _res, next) {
  req.restrictedView = !isStaff(req);
  next();
}

const PERSONAL_FIELDS = ['nationalId', 'phone', 'email', 'user'];
function redactEmployeeForViewer(emp, req, enabled = AUTH_ENABLED) {
  if (!emp || isStaff(req, enabled)) return emp;
  const out = { ...emp };
  for (const k of PERSONAL_FIELDS) delete out[k];
  return out;
}

module.exports = { viewerScope, redactEmployeeForViewer, isStaff, STAFF_ROLES, PERSONAL_FIELDS };
