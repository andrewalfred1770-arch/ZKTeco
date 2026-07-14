// EF-008 Phase 5 / Finding #5: single canonical source for Arabic month
// names, replacing the copy previously duplicated inline in payroll.js
// (verified byte-identical to the frontend's copies before this
// consolidation — see frontend/src/lib/constants.js for the frontend side).
const MONTHS_AR = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];

module.exports = { MONTHS_AR };
