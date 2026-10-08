/**
 * staleGuard — keeps an OLDER server response from overwriting NEWER screen state.
 *
 * Why this exists: the attendance / payroll screens fetch data from several
 * independent triggers (first load, month/date/employee change, live-sync events
 * from realtime punches and recalculations, manual save follow-ups). Those GETs
 * can finish in a different order than they started. Without a guard the page
 * applies whichever response lands LAST, so a slow, older response can:
 *   - replace the grid of the month/employee the user just switched TO with the
 *     one they switched FROM, and
 *   - put a pre-save snapshot over a row the user just saved (the edit appears to
 *     "disappear" although the database is correct).
 *
 * Model (per page instance, no global state):
 *   - A logical clock orders everything. A request records the clock value at
 *     which it STARTED (start()/startOne()).
 *   - key identifies WHAT the screen is showing (month|year|dept, date, employee…).
 *     A response whose key is no longer the current key is dropped (accept()/
 *     keyMatches()).
 *   - Full loads are latest-wins: once a load that started later has been applied,
 *     an older one is dropped (accept()).
 *   - Rows are protected individually. Each row remembers the clock value of the
 *     data currently on screen (origin). A response row replaces the shown row
 *     only if its request started no earlier than that origin, and never while the
 *     user has an edit on that row in flight (claim()/isStale()). A save stamps its
 *     row when its result is applied (markFresh()), so every request that began
 *     before the save is ignored for that row — while the rest of the same
 *     response still refreshes normally. Refreshes are never blocked or delayed.
 *
 * Nothing here retries, delays or issues requests, and it never touches a write.
 */
import { useRef } from 'react';

export function createStaleGuard() {
  let clock = 0;
  let seq = 0;
  let appliedSeq = 0;
  let key = '';
  const origin = new Map();    // rowId -> clock of the data currently shown
  const editing = new Map();   // rowId -> number of edits in flight

  const guard = {
    setKey(k) { key = k; },
    getKey() { return key; },

    /**
     * A FULL load is starting (latest-wins, key-checked). Pass the key of the
     * parameters THIS request is made for (taken from the calling closure, not
     * from the guard): a callback captured before the user switched month/date/
     * employee then carries its own, now-obsolete key and is dropped on arrival.
     */
    start(k = key) { return { seq: ++seq, clock: ++clock, key: k }; },
    /** A targeted (per-row/employee) refresh is starting (key-checked + row-protected only). */
    startOne(k = key) { return { seq: 0, clock: ++clock, key: k }; },

    /** Is `t` still the most recently started full load? (cosmetic: loading flags) */
    isLatest(t) { return t.seq === seq; },
    /** Is the screen still showing what `t` was fetched for? */
    keyMatches(t) { return t.key === key; },
    /** May a FULL load's response be applied? Drops other-key and superseded responses. */
    accept(t) {
      if (t.key !== key || t.seq < appliedSeq) return false;
      appliedSeq = t.seq;
      return true;
    },

    beginEdit(ids) {
      for (const id of ids) if (id != null) editing.set(id, (editing.get(id) || 0) + 1);
    },
    endEdit(ids) {
      for (const id of ids) {
        if (id == null) continue;
        const n = (editing.get(id) || 0) - 1;
        if (n > 0) editing.set(id, n); else editing.delete(id);
      }
    },
    /** A save's result is being applied: it is now the newest data for these rows. */
    markFresh(ids) {
      const c = ++clock;
      for (const id of ids) if (id != null) origin.set(id, c);
    },

    /** Would applying a row from the response for request `t` overwrite newer data? */
    isStale(id, t) {
      if (id == null) return false;
      return (editing.get(id) || 0) > 0 || t.clock < (origin.get(id) ?? 0);
    },
    /**
     * Classify the rows of an accepted response: returns the Set of ids that must
     * KEEP their current on-screen version, and stamps every other row as having
     * come from this request.
     */
    claim(rows, t, idOf = (r) => r.id) {
      const keep = new Set();
      for (const r of rows) {
        const id = idOf(r);
        if (id == null) continue;
        if (guard.isStale(id, t)) keep.add(id);
        else origin.set(id, t.clock);
      }
      return keep;
    },
  };
  return guard;
}

/** Per-component guard whose key tracks the current screen parameters. */
export function useStaleGuard(key) {
  const ref = useRef(null);
  if (ref.current === null) ref.current = createStaleGuard();
  ref.current.setKey(key);
  return ref.current;
}

// ── Pure merge helpers (used by the pages, and exercised directly by the tests) ──

/** Replace the shown list by `incoming`, but keep the current version of every id in `keep`. */
export function keepCurrentRows(prev, incoming, keep, idOf = (r) => r.id) {
  if (!keep || keep.size === 0) return incoming;
  const prevById = new Map(prev.map((r) => [idOf(r), r]));
  return incoming.map((r) => {
    const id = idOf(r);
    return keep.has(id) && prevById.has(id) ? prevById.get(id) : r;
  });
}

/**
 * Monthly page, per-employee refresh: replace ONLY the successfully fetched
 * employees' rows (keeping the current version of any row in `keep`). An employee
 * whose fetch FAILED is simply absent from `fetched` and is left untouched — a
 * failed refresh must never remove rows from the screen.
 *
 * @param prev     current rows
 * @param fetched  [{ employeeId, rows: [...] }] — successful fetches only
 */
export function mergeEmployeeRows(prev, fetched, keep, idOf = (r) => r.id) {
  const touched = new Set(fetched.map((f) => f.employeeId));
  const prevById = new Map(prev.map((r) => [idOf(r), r]));
  const incoming = fetched.flatMap((f) => f.rows).map((r) => {
    const id = idOf(r);
    return keep && keep.has(id) && prevById.has(id) ? prevById.get(id) : r;
  });
  return [...prev.filter((r) => !touched.has(r.employeeId)), ...incoming];
}
