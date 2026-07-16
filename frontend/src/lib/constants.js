// EF-008 Phase 5 / Finding #5: single canonical source for Arabic month
// names, replacing 5 identical copies previously duplicated across
// PayrollPage.jsx, HolidaysPage.jsx, EmployeeMovementPage.jsx,
// AttendanceMonthlyPage.jsx, and FinalSalaryModal.jsx (verified byte-
// identical before this consolidation).
export const MONTHS_AR = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];

// EP-024.2: single canonical year-range provider, replacing hardcoded
// [2024,2025,2026,2027] duplicated in PayrollPage.jsx and
// AttendanceMonthlyPage.jsx — that array silently stopped extending once the
// current year passed 2027. Dynamic: always current year ± N.
export function getYearRange(back = 2, forward = 2) {
  const y = new Date().getFullYear();
  const years = [];
  for (let i = y - back; i <= y + forward; i++) years.push(i);
  return years;
}
