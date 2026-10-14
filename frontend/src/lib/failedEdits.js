/**
 * failedEdits.js — in-memory registry of grid cell edits that were typed but NOT confirmed saved.
 *
 * A grid cell edit is optimistic: AG Grid commits the typed value, the page sends the PUT, and on failure the page used to revert the
 * cell. What is right depends on WHAT the failure tells us about the server (classifyFailure):
 *
 *   'rejected'    the server ANSWERED with an error (validation, 4xx/5xx). Nothing to keep: revert and show the reason (long-standing
 *                 behaviour).
 *   'not-applied' the session ended: HTTP 401 (the server refused before processing) or the client refused to send (api.js). It is
 *                 CERTAIN that nothing was applied. The typed value is kept and flagged; a retry is safe.
 *   'unknown'     no answer at all (network error / timeout / connection reset). The server MAY have applied the change and only the
 *                 reply was lost. Reverting the cell would show a value that may be wrong, so the typed value is kept and flagged as
 *                 "not confirmed". Whether re-sending is safe depends on the mutation:
 *                   - idempotent (it sets an absolute value: grid cells on Daily/Movement/Payroll): a user-clicked retry is allowed;
 *                   - NOT idempotent (the payroll "advances" edit creates a delta record): the entry is flagged requiresConfirm and
 *                     retryAll() will not re-send it unless the user explicitly confirms it (default: declined).
 *
 * Rules enforced here:
 *  - nothing is cleared except by a confirmed successful save (clear(), called by the page's save path after the server answered)
 *    or an explicit discard();
 *  - nothing is ever re-sent automatically: retryAll() runs only from the user's click, is serial and non-reentrant, and it only
 *    re-runs the page's own save function for entries still registered; an entry counts as saved only if that function cleared it;
 *  - discarding an entry whose outcome was 'unknown' asks the page to re-read the server (onDiscardUnknown): the discarded value may
 *    in fact have been saved, so the grid must not be left showing the old value as if it were the truth;
 *  - values live in memory only. No storage, no logging, no URLs.
 */
import { isSessionLostError } from './unsavedWork';

const keyOf = (rowId, field) => `${rowId}:${field}`;

const NETWORK_CODES = new Set(['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ERR_CONNECTION_RESET']);

/** 'not-applied' | 'unknown' | 'rejected' — see the header. */
export function classifyFailure(err) {
  if (isSessionLostError(err)) return 'not-applied';
  if (!err || err.response) return 'rejected';                                   // the server answered (or this is not a request error)
  if (err.code === 'ERR_CANCELED') return 'rejected';
  if (err.request || (typeof err.code === 'string' && NETWORK_CODES.has(err.code))) return 'unknown';
  return 'rejected';
}

/** The explicit-confirmation gate for retrying an edit that may already have been applied. Declined when no UI is available. */
export function confirmUnsafeRetry(entry) {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return false;
  const who = entry && entry.label ? ` (${entry.label})` : '';
  return !!window.confirm(`تعذّر التأكد هل وصل هذا التعديل إلى الخادم${who}: قد يكون حُفظ فعلاً.\nإعادة الإرسال قد تُكرِّر العملية.\nهل تريد إعادة الإرسال؟`);
}

export function createFailedEdits({ onChange = () => {}, revert = () => {}, onDiscardUnknown = () => {} } = {}) {
  const map = new Map();
  let retrying = false;
  const changed = () => { try { onChange(); } catch { /* UI refresh must never break the registry */ } };
  return {
    /** Remember (or replace with the newest value) an unsaved edit. entry: { rowId, field, value, oldValue, label, outcome?, requiresConfirm?, bulk? } */
    keep(entry) { map.set(keyOf(entry.rowId, entry.field), { outcome: 'not-applied', requiresConfirm: false, ...entry }); changed(); },
    /** Forget one edit — call ONLY after the server confirmed the save. */
    clear(rowId, field) { if (map.delete(keyOf(rowId, field))) changed(); },
    has(rowId, field) { return map.has(keyOf(rowId, field)); },
    size() { return map.size; },
    /** How many remembered edits may already be on the server (outcome unknown). */
    unknownCount() { let n = 0; for (const e of map.values()) if (e.outcome === 'unknown') n++; return n; },
    entries() { return [...map.values()]; },
    isRetrying() { return retrying; },
    /**
     * Re-run the page's own save for every remembered edit, one at a time. `retryOne(entry)` must go through the normal save path (the
     * same validation, the same PUT) and clear the entry on confirmed success. An entry that may already be applied AND is not
     * idempotent (requiresConfirm) is re-sent only if `confirmUnsafe(entry)` returns true; otherwise it stays registered untouched.
     * Returns { skipped } when a pass is already running, else { remaining, declined }.
     */
    async retryAll(retryOne, { confirmUnsafe = confirmUnsafeRetry } = {}) {
      if (retrying) return { skipped: 'busy' };
      retrying = true; changed();
      let declined = 0;
      try {
        for (const e of [...map.values()]) {
          if (!map.has(keyOf(e.rowId, e.field))) continue;          // saved or replaced meanwhile
          if (e.requiresConfirm) {
            let yes = false;
            try { yes = !!(await confirmUnsafe(e)); } catch { yes = false; }
            if (!yes) { declined++; continue; }
          }
          try { await retryOne(e); } catch { /* the entry stays registered */ }
        }
      } finally { retrying = false; changed(); }
      return { remaining: map.size, declined };
    },
    /** The user gave the unsaved edits up: forget them and let the page restore the previous cell values. */
    discard() {
      const list = [...map.values()];
      map.clear(); changed();
      for (const e of list) {
        if (e.bulk) continue;                                    // a bulk row never showed the typed value: nothing to restore
        try { revert(e); } catch { /* ignore a row that no longer exists */ }
      }
      const unknown = list.filter((e) => e.outcome === 'unknown');
      if (unknown.length) { try { onDiscardUnknown(unknown); } catch { /* ignore */ } }
      return list.length;
    },
  };
}

/**
 * The catch-branch decision shared by every grid page.
 *   not-applied (session lost) -> retain the typed value, remember the edit, tell the user it is NOT saved             => 'kept'
 *   unknown (no reply)         -> retain the typed value, remember it as NOT CONFIRMED (+ requiresConfirm unless the
 *                                 mutation is `idempotent`), tell the user it may or may not have been saved            => 'kept-unknown'
 *   rejected                   -> tell the user why it failed and restore the previous value (long-standing behaviour) => 'reverted'
 */
export function handleEditFailure({ failed, err, entry, retain, revert, notifyKept, notifyUnknown, notifyFailed, idempotent = false }) {
  const kind = classifyFailure(err);
  if (kind === 'not-applied') {
    try { retain(entry); } catch { /* ignore */ }
    failed.keep({ ...entry, outcome: 'not-applied', requiresConfirm: false });
    notifyKept(entry);
    return 'kept';
  }
  if (kind === 'unknown') {
    try { retain(entry); } catch { /* ignore */ }
    failed.keep({ ...entry, outcome: 'unknown', requiresConfirm: !idempotent });
    (notifyUnknown || notifyKept)(entry);
    return 'kept-unknown';
  }
  notifyFailed(err);
  revert(entry);
  return 'reverted';
}
