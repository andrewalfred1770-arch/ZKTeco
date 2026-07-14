/**
 * liveSyncGuard — shared "don't reload while the user is mid-edit" gate for
 * every socket-driven live-sync hook (useRulesLiveSync, useDeviceLiveSync).
 *
 * ROOT CAUSE this fixes: live-sync hooks call a page's `load()` on server-
 * pushed events (rules:changed, recalc:done, device:synced,
 * attendance:realtime — the last one fires on every single punch) completely
 * independently of what the user is doing. `load()` replaces the grid's
 * entire rowData array with fresh objects from the server. If that swap
 * lands while a cell is being edited or its save is in flight, AG Grid must
 * reconcile the whole grid against the incoming data mid-edit — which is the
 * mechanism behind rows disappearing / cells going blank / status badges
 * flashing away during inline editing.
 *
 * Three pages (AttendanceDaily/Monthly, EmployeeMovement) independently
 * hand-rolled a local `editCountRef` + `pendingReloadRef` pair inside their
 * own load() to work around this. Two pages (Payroll, Rules) never got that
 * guard, so the bug reproduced there — because the fix was copy-pasted, not
 * shared. This module is the ONE place that logic now lives; every live-sync
 * hook call site just passes its `isBusyRef` (a ref whose `.current` is a
 * truthy/nonzero count while any edit or save is in flight for that page).
 */
export function createGuardedReload(reloadRef, isBusyRef) {
  let pending = false;
  let pollTimer = null;

  const clearPoll = () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  };

  const fire = () => {
    pending = false;
    clearPoll();
    reloadRef.current?.();
  };

  const request = () => {
    if (isBusyRef?.current) {
      // Edit/save in flight — defer, then poll until the page goes idle.
      pending = true;
      if (!pollTimer) {
        pollTimer = setInterval(() => {
          if (!isBusyRef?.current && pending) fire();
        }, 250);
      }
      return;
    }
    fire();
  };

  const cleanup = () => { clearPoll(); pending = false; };

  return { request, cleanup };
}
