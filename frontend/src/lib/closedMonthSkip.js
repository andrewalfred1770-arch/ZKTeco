/**
 * closedMonthSkip.js — Arabic notice for "attendance processing skipped closed-month days".
 * The backend (attendanceEngine closed-payroll evidence-loss guard) leaves a stored attendance row untouched when the employee-month's
 * payroll is finalized/paid and the raw punches behind it are gone; it reports `skippedClosedPayroll: [{employeeId, month, year,
 * payrollStatus, days: ['YYYY-MM-DD', ...]}]`. Pure display helper — no network, no side effects.
 */
export function closedSkipSummary(list) {
  const items = Array.isArray(list) ? list : [];
  const employeeMonths = items.length;
  const days = items.reduce((n, it) => n + (Array.isArray(it?.days) ? it.days.length : 0), 0);
  return { employeeMonths, days };
}

/** Message for a toast / banner, or null when nothing was skipped. */
export function closedSkipMessage(list) {
  const { employeeMonths, days } = closedSkipSummary(list);
  if (!employeeMonths) return null;
  return `تم تخطي ${days} يوم لـ ${employeeMonths} موظف-شهر بمرتب معتمد/مدفوع: سجلات الحضور المخزّنة بقيت كما هي لأن البصمات الخام لها غير موجودة، ولم يتغيّر أي مرتب.`;
}
