/**
 * bulkApply.js — the decision logic of Employee Movement's "apply the same edit to every selected row" fan-out.
 *
 * Before: every per-row failure was swallowed (a bare catch) and the page ALWAYS toasted "applied to N rows" with N counting only the
 * rows that happened to succeed — a partial failure looked like a success and the failed rows were forgotten.
 *
 * Now each row returns an honest status, and the failed ones are remembered:
 *   ok        the server confirmed it (any remembered failure for the cell is cleared — only now)
 *   skipped   nothing was sent (the page had nothing to save for that row)
 *   kept      the session ended (certainly not applied) or no reply arrived (may have been applied): the intended value is remembered
 *             in the failed-edits registry (bulk: true) for an explicit user retry. The row's displayed value is untouched — a bulk
 *             row never showed the typed value, so there is nothing to revert and nothing is lost. The PUT sets an absolute value, so
 *             re-sending it cannot duplicate anything.
 *   rejected  the server answered with an error: reported with its reason, not retried automatically (it would fail the same way).
 */
import { classifyFailure } from './failedEdits';

/**
 * Save one bulk row. `save(row)` is the page's own request (resolves to the updated row, or null when nothing was sent).
 * Returns { status, updated?, kind?, message? }; never throws.
 */
export async function runBulkRow({ row, field, newValue, save, failed }) {
  try {
    const updated = await save(row);
    if (!updated) return { status: 'skipped' };
    failed.clear(row.id, field);   // confirmed by the server
    return { status: 'ok', updated };
  } catch (err) {
    const kind = classifyFailure(err);
    if (kind === 'rejected') return { status: 'rejected', message: (err && err.response && err.response.data && err.response.data.error) || '' };
    failed.keep({
      rowId: row.id, field, value: newValue, oldValue: row[field], label: row.employeeName, bulk: true,
      outcome: kind === 'unknown' ? 'unknown' : 'not-applied', requiresConfirm: false,
    });
    return { status: 'kept', kind };
  }
}

/** Fold per-row results (the primary row, which already succeeded, counts as one ok) into a tally. */
export function tallyBulk(results) {
  const t = { ok: 1, skipped: 0, kept: 0, keptUnknown: 0, rejected: 0, reason: '' };
  for (const r of results) {
    if (r.status === 'ok') t.ok++;
    else if (r.status === 'skipped') t.skipped++;
    else if (r.status === 'kept') { t.kept++; if (r.kind === 'unknown') t.keptUnknown++; }
    else { t.rejected++; if (!t.reason && r.message) t.reason = r.message; }
  }
  t.total = results.length + 1;
  return t;
}

/** { type: 'success' | 'error', text } — success ONLY when every row was confirmed saved. */
export function summarizeBulk(t) {
  if (t.kept === 0 && t.rejected === 0 && t.skipped === 0) return { type: 'success', text: `تم تطبيق القيمة على ${t.ok} سجل` };
  const parts = [`تم الحفظ لـ ${t.ok} من ${t.total} سجل`];
  if (t.kept) {
    parts.push(t.keptUnknown
      ? `${t.kept} لم يُحفظ أو لم يُتأكد من حفظه (انتهت الجلسة أو انقطع الاتصال) — قيمها محفوظة في الشريط أعلى الجدول لإعادة المحاولة`
      : `${t.kept} لم يُحفظ لانتهاء الجلسة — قيمها محفوظة في الشريط أعلى الجدول لإعادة المحاولة`);
  }
  if (t.rejected) parts.push(`${t.rejected} رفضها الخادم${t.reason ? ` (${t.reason})` : ''} — بقيت قيمها السابقة`);
  if (t.skipped) parts.push(`${t.skipped} لم يُرسل لها شيء`);
  return { type: 'error', text: parts.join(' — ') };
}
