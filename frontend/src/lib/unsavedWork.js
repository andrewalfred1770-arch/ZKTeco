/**
 * unsavedWork.js — in-memory registry of screens that currently hold unsaved edits.
 *
 * Purpose: when the session expires (HTTP 401) the login gate normally replaces the whole app, unmounting every screen and
 * silently throwing away whatever the user was typing. A screen that has unsaved work registers a PROBE here (a function that
 * answers "is anything unsaved right now?"); authStore consults the probes at the moment the session ends and, if any answers
 * yes, keeps the screens mounted under the login overlay so the edits survive until the user re-authenticates or explicitly
 * discards them.
 *
 * Privacy: the registry stores only a label and a function. It never reads, copies or persists field values, and nothing here
 * touches localStorage / sessionStorage / the URL / logs. Probes are evaluated lazily, only when a session ends.
 */
const probes = new Map();   // id -> { label, isDirty }

/** Registers a probe. Returns an unregister function (safe to call twice, never removes a newer probe with the same id). */
export function registerUnsavedProbe(id, label, isDirty) {
  const entry = { label: String(label || id), isDirty };
  probes.set(id, entry);
  return () => { if (probes.get(id) === entry) probes.delete(id); };
}

/** Labels (never values) of the screens that report unsaved work right now. A throwing probe counts as "nothing unsaved". */
export function listUnsavedWork() {
  const out = [];
  for (const { label, isDirty } of probes.values()) {
    try { if (isDirty()) out.push(label); } catch { /* a broken probe must never break session handling */ }
  }
  return out;
}

export const hasUnsavedWork = () => listUnsavedWork().length > 0;

/**
 * Called before the app navigates away from the current screen. Returns true when it is fine to go: nothing is unsaved, or the user
 * confirmed. The prompt names the screens (labels only). `confirmFn` is injectable for tests; the default is window.confirm.
 */
export function confirmLeaveIfUnsaved(confirmFn) {
  const labels = listUnsavedWork();
  if (!labels.length) return true;
  const ask = confirmFn || ((m) => (typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(m) : true));
  return !!ask(`لديك تعديلات غير محفوظة (${labels.join('، ')}). إذا غادرت هذه الشاشة ستُفقد. هل تريد المغادرة؟`);
}

/**
 * True when a failed request means "the session ended", i.e. the server answered 401 to a request that carried a token, or the API
 * client refused to send a mutation because the session had already ended (err.isSessionExpired). 403, 5xx and network errors are
 * NOT session loss. Screens use this to keep (and flag as unsaved) an edit that was in flight instead of silently reverting it.
 */
export function isSessionLostError(err) {
  return !!err && (err.isSessionExpired === true || (!!err.response && err.response.status === 401));
}

/** test helper */
export function _resetUnsavedProbes() { probes.clear(); }
