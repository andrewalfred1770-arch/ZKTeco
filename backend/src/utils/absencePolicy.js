// Automatic-absence policy (P2-05 decision D5, approved).
//
// An absent day that HR has not classified — no punch and no absence type assigned — is treated as
// `with_permission` with a FIXED penalty of one salary day. There is no configurable default: the former
// per-company "default absence days" setting was removed (P2-05 decision R3).
//
// An absence HR *did* classify keeps its explicit AttendanceDaily.penaltyDays (with_permission = 1,
// without_permission = 2, custom = any value, including an explicit 0).
//
// This module is the single place that fact is written down. Payroll (the deduction),
// buildAttendanceRow (what every grid displays) and the Movement summary all go through it, so the
// number shown on screen is the number deducted.

const AUTOMATIC_ABSENCE_TYPE = 'with_permission';
const AUTOMATIC_ABSENCE_PENALTY_DAYS = 1;

/** Salary days deducted for an ABSENT day row (explicit penaltyDays wins, else the fixed automatic 1 day). */
function effectiveAbsencePenaltyDays(row) {
  return row && row.penaltyDays != null ? row.penaltyDays : AUTOMATIC_ABSENCE_PENALTY_DAYS;
}

/** Absence type shown for an ABSENT day row (HR-assigned type, else the automatic "with permission"). */
function effectiveAbsenceType(row) {
  return (row && row.absenceType) || AUTOMATIC_ABSENCE_TYPE;
}

module.exports = {
  AUTOMATIC_ABSENCE_TYPE,
  AUTOMATIC_ABSENCE_PENALTY_DAYS,
  effectiveAbsencePenaltyDays,
  effectiveAbsenceType,
};
