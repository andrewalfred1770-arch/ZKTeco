/**
 * cleanupExecuteError.js — the cleanup /execute 409 "the data changed since the preview" case.
 * Server: HTTP 409 + { code: 'CLEANUP_DATA_CHANGED' } after a full rollback (nothing was deleted). The page must drop the stale preview
 * and send the operator back to a fresh preview. Pure helper — no network.
 */
export const STALE_PREVIEW_MESSAGE = 'تغيّرت البيانات منذ المعاينة — لم يُحذف أي شيء. أجرِ معاينة جديدة قبل التنفيذ.';

export function isStalePreviewError(err) {
  const res = err && err.response;
  return !!res && res.status === 409 && !!res.data && res.data.code === 'CLEANUP_DATA_CHANGED';
}
