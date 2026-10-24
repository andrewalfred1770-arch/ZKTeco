/**
 * postSaveSummary.js — turns what the server ACTUALLY answered to an attendance save into the statements the post-save dialog
 * shows. Pure (no React, no network, no clock): every sentence is derived from a field of the response, and a statement the
 * response cannot support is never produced.
 *
 * The three manual-edit endpoints (PUT /attendance/daily/:id, PUT /attendance/:id/manual-penalty, PUT /attendance/:id/absence-type)
 * answer with the saved attendance row plus the outcome of the payroll recalculation they ran AFTER the attendance commit:
 *     payroll          the recalculated Payroll row (only when calculatePayroll really returned one)
 *     payrollError     the failure message when the recalculation threw (attendance is still saved)
 *     payrollProtected 'finalized' | 'paid' when the month is closed and the recalculation was deliberately skipped
 *     unchanged        true when the request changed nothing (nothing was saved, nothing recalculated)
 * "Attendance saved" therefore never implies "payroll updated": the payroll line is decided from those fields only.
 */

export const FIELD_LABELS = {
  checkIn: 'وقت الحضور',
  checkOut: 'وقت الانصراف',
  status: 'الحالة',
  workedMinutes: 'ساعات العمل',
  effectiveLatePenalty: 'خصم التأخير',
  effectiveEarlyPenalty: 'خصم الانصراف المبكر',
  effectiveOvertimeUnits: 'الإضافي',
  absence: 'نوع الغياب / أيام الخصم',
  penalty: 'التعديل اليدوي المتقدم',
};
const OVERRIDE_FIELDS = new Set(['effectiveLatePenalty', 'effectiveEarlyPenalty', 'effectiveOvertimeUnits']);
const STATUS_AR = { present: 'حاضر', late: 'متأخر', absent: 'غائب', early_leave: 'انصراف مبكر', weekend: 'إجازة أسبوعية', holiday: 'عطلة' };
const CLOSED = { finalized: 'معتمد', paid: 'مدفوع' };

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const money = (v) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');

/** @returns {{state:'recalculated'|'protected'|'failed'|'none'|'unverified', tone:'success'|'warning'|'error', text:string, detail?:string}} */
export function describePayrollOutcome(resp, rowDate) {
  const r = resp || {};
  if (typeof r.payrollError === 'string' && r.payrollError) {
    return { state: 'failed', tone: 'error', text: 'فشلت إعادة احتساب الراتب — الحضور محفوظ لكن الراتب لم يُحدَّث.', detail: `السبب: ${r.payrollError}. أعد الاحتساب من صفحة الرواتب.` };
  }
  if (r.payrollProtected) {
    const label = CLOSED[r.payrollProtected] || r.payrollProtected;
    return { state: 'protected', tone: 'warning', text: `لم يُعاد احتساب الراتب لأنه ${label}.`, detail: 'المبالغ المعتمدة كما هي ولم تتغيّر.' };
  }
  const p = r.payroll;
  if (p && typeof p === 'object') {
    if (CLOSED[p.status]) {
      // The month was closed between the check and the write: the engine left the row untouched and handed it back.
      return { state: 'protected', tone: 'warning', text: `لم يُعاد احتساب الراتب لأنه ${CLOSED[p.status]}.`, detail: 'المبالغ المعتمدة كما هي ولم تتغيّر.' };
    }
    if (rowDate && /^\d{4}-\d{2}-\d{2}$/.test(rowDate)) {
      const y = Number(rowDate.slice(0, 4)); const m = Number(rowDate.slice(5, 7));
      if (Number(p.month) !== m || Number(p.year) !== y) {
        return { state: 'unverified', tone: 'warning', text: 'لم يُتأكد من إعادة احتساب راتب هذا الشهر.', detail: 'رد الخادم يخص شهرًا مختلفًا.' };
      }
    }
    if (Number.isFinite(num(p.netSalary))) {
      return {
        state: 'recalculated', tone: 'success',
        text: 'اكتملت إعادة احتساب الراتب (مسودة).',
        detail: `صافي الراتب بعد الاحتساب: ${money(p.netSalary)} — أيام الغياب: ${p.absentDays ?? '—'}.`,
      };
    }
    return { state: 'unverified', tone: 'warning', text: 'لم يُتأكد من نتيجة إعادة احتساب الراتب.', detail: 'رد الخادم لا يتضمن مبالغ الراتب.' };
  }
  if ('payroll' in r && r.payroll === null) {
    return { state: 'none', tone: 'warning', text: 'لا يوجد سجل راتب لهذا الشهر لهذا الموظف — لم يُنشأ ولم يُحدَّث أي راتب.' };
  }
  return { state: 'unverified', tone: 'warning', text: 'لم يُتأكد من حالة الراتب — لم يُرجع الخادم نتيجة إعادة الاحتساب.' };
}

function valueLines(row, field, requested) {
  const out = [];
  const t = (v) => (v ? String(v) : '—');
  const general = !field || field === 'penalty' || field === 'absence';
  if (general || field === 'checkIn' || field === 'checkOut' || field === 'workedMinutes' || field === 'status') {
    out.push(`الحضور: ${t(row.checkIn)} — الانصراف: ${t(row.checkOut)} — الحالة: ${STATUS_AR[row.status] || row.status || '—'}`);
  }
  if (general || OVERRIDE_FIELDS.has(field)) {
    out.push(`خصم التأخير: ${row.effectiveLatePenalty ?? 0} — خصم الانصراف: ${row.effectiveEarlyPenalty ?? 0} — الإضافي: ${row.effectiveOvertimeUnits ?? 0}`);
  }
  if (row.isAbsent) out.push(`غياب: ${row.absenceType || '—'} — أيام الخصم: ${row.penaltyDays ?? '—'}`);
  if (OVERRIDE_FIELDS.has(field) && (requested === null || requested === '')) out.unshift('أُعيدت القيمة إلى الحساب التلقائي (أُلغي التجاوز اليدوي).');
  else if (OVERRIDE_FIELDS.has(field) && requested !== undefined && Number(requested) === 0) out.unshift('أُعفي الخصم (القيمة اليدوية = 0).');
  return out;
}

/**
 * @param {object} resp   the PUT response body (normalized or raw)
 * @param {{field?:string|null, requested?:any, rowDate?:string, employeeName?:string}} [ctx]
 * @returns {null | object}  null when the server reported nothing changed (no dialog: nothing was saved, nothing recalculated)
 */
export function summarizeSave(resp, ctx = {}) {
  if (!resp || typeof resp !== 'object' || resp.id == null) return null;
  if (resp.unchanged === true) return null;
  const field = ctx.field || null;
  const date = ctx.rowDate || '';
  const payroll = describePayrollOutcome(resp, date);
  const ignored = Number(resp.ignoredPunches) || 0;
  const tone = payroll.tone === 'error' ? 'error' : (payroll.tone === 'warning' || ignored > 0 ? 'warning' : 'success');
  return {
    kind: 'saved',
    employee: ctx.employeeName || resp.employeeName || '',
    date,
    field: FIELD_LABELS[field] || 'التعديل',
    lines: valueLines(resp, field, ctx.requested),
    payroll,
    warning: ignored > 0 ? `${ignored} بصمة خام من الجهاز لم تُطبَّق على هذا اليوم لأن السجل معدّل يدويًا (حُفظت في سجل البصمات).` : null,
    tone,
  };
}

/**
 * A save that did NOT complete. outcome: 'rejected' (the server answered with an error) | 'unknown' (no reply: it may or may not
 * have been saved) | 'not-applied' (session lost: nothing went through). Payroll is never claimed in any of these.
 */
export function summarizeSaveFailure(outcome, err, ctx = {}) {
  const reason = (err && err.response && err.response.data && err.response.data.error) || (err && err.message) || '';
  const attendanceText = outcome === 'unknown'
    ? 'لم يُتأكد هل حُفظ التعديل — انقطع الاتصال بالخادم.'
    : outcome === 'not-applied'
      ? 'التعديل لم يُحفظ — انتهت الجلسة.'
      : 'فشل حفظ تعديل الحضور.';
  return {
    kind: 'failed', outcome,
    employee: ctx.employeeName || '', date: ctx.rowDate || '',
    field: FIELD_LABELS[ctx.field] || 'التعديل',
    lines: reason ? [`السبب: ${reason}`] : [],
    attendanceText,
    payroll: { state: 'not-attempted', tone: 'warning', text: 'لم يُعاد احتساب الراتب لأن حفظ الحضور لم يُؤكَّد.' },
    warning: null,
    tone: outcome === 'unknown' ? 'warning' : 'error',
  };
}

/**
 * The ONE small, non-blocking toast that replaces the old post-save result dialog. Same source of truth as that dialog was:
 * only what the server's answer proves (summarizeSave). Failed saves are NOT handled here — the edit handler already toasts those
 * (session lost / connection lost / server error) — and an "unchanged" answer produces no entry at all, hence no toast.
 *
 * Nothing is hidden by dropping the modal: a payroll recalculation that FAILED is an error toast, a closed (finalized / paid) month that
 * was deliberately NOT recalculated, a month with no payroll row, an unverifiable answer and ignored raw punches are warning toasts.
 * Only the all-clear case (attendance saved AND payroll really recalculated) is a plain success toast.
 *
 * @param {object[]} entries  summarizeSave()/summarizeSaveFailure() results that finished close together (coalesced by the caller)
 * @returns {null | {level:'success'|'warning'|'error', message:string}}
 */
export function buildSaveToast(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.kind === 'saved');
  if (!list.length) return null;
  const t = tallyEntries(list);
  const many = list.length > 1;
  const what = many ? `تم حفظ ${t.saved} تعديلات` : `تم حفظ ${list[0].field || 'التعديل'}`;
  const problems = [];
  let level = 'success';
  if (t.payrollFailed > 0) {
    problems.push(`فشلت إعادة احتساب الراتب${many ? ` (${t.payrollFailed})` : ''} — الحضور محفوظ، أعد الاحتساب لاحقًا`);
    level = 'error';
  }
  if (t.protected > 0) { problems.push(`الراتب معتمد/مدفوع — لم يُعاد احتسابه${many ? ` (${t.protected})` : ''}`); if (level !== 'error') level = 'warning'; }
  if (t.none > 0) { problems.push(`لا يوجد سجل راتب لهذا الشهر${many ? ` (${t.none})` : ''}`); if (level !== 'error') level = 'warning'; }
  if (t.unverified > 0) { problems.push(`لم يُتأكد من تحديث الراتب${many ? ` (${t.unverified})` : ''}`); if (level !== 'error') level = 'warning'; }
  if (t.ignoredPunches > 0) { problems.push('بصمات خام لم تُطبَّق لأن السجل معدّل يدويًا'); if (level !== 'error') level = 'warning'; }
  if (!problems.length) return { level: 'success', message: `${what} وأُعيد احتساب ${many ? 'الرواتب' : 'الراتب'}` };
  const done = many && t.recalculated > 0 ? `، أُعيد احتساب ${t.recalculated}` : '';
  return { level, message: `${what}${done} — ${problems.join(' — ')}` };
}

/** Aggregate for the dialog header when several saves were coalesced. */
export function tallyEntries(entries) {
  const t = { total: entries.length, saved: 0, failed: 0, recalculated: 0, protected: 0, payrollFailed: 0, none: 0, unverified: 0, ignoredPunches: 0 };
  for (const e of entries) {
    if (e.kind === 'failed') { t.failed++; continue; }
    t.saved++;
    const s = e.payroll && e.payroll.state;
    if (s === 'recalculated') t.recalculated++;
    else if (s === 'protected') t.protected++;
    else if (s === 'failed') t.payrollFailed++;
    else if (s === 'none') t.none++;
    else t.unverified++;
    if (e.warning) t.ignoredPunches++;
  }
  return t;
}
