import { useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import { getSocket } from '../lib/socket';
import { createGuardedReload } from './liveSyncGuard';

/**
 * Subscribes a page to live "new biometric data arrived" events from the
 * backend so Raw Logs / Movement / Attendance Daily / Payroll reflect new
 * punches automatically — without a manual refresh.
 *
 * Backend emits (zktecoService.js / relinkService.js / realtimeListenerService.js):
 *  - device:synced     → a device sync finished (success OR partial) and may
 *                          have ingested new attendance_logs rows
 *  - relink:done       → orphaned logs were re-linked to employees and
 *                          attendance_daily/payroll were regenerated
 *                          (relink:start/progress toasts deliberately live in
 *                          DevicesPage.jsx instead of here — every current
 *                          caller of this hook passes silent:true, which would
 *                          make a toast added here permanently invisible;
 *                          DevicesPage is also where the relink is actually
 *                          triggered/watched — see Certification HIGH#7)
 *  - attendance:processed → today's attendance was recalculated (10-min
 *                          scheduler OR an instant per-employee recalc after
 *                          a realtime punch)
 *  - attendance:realtime  → a punch was just received live from a device
 *                          (CMD_REG_EVENT). Always reload — covers punches
 *                          for zkUserIds with no linked employee yet, which
 *                          never trigger attendance:processed.
 *
 * Mirrors the proven `device:synced → loadAll()` pattern from DevicesPage and
 * the `useRulesLiveSync` hook.
 *
 * @param {() => void} reload - the page's existing data-loading callback
 * @param {object} [opts]
 * @param {boolean} [opts.silent=false] - suppress the toast (still reloads)
 * @param {import('react').MutableRefObject<number>} [opts.isBusyRef] - a ref
 *   whose `.current` is nonzero while the page has an edit/save in flight.
 *   While truthy, this hook defers the reload instead of swapping rowData
 *   mid-edit — see liveSyncGuard.js for why this exists.
 */
export function useDeviceLiveSync(reload, opts = {}) {
  const { silent = false, isBusyRef } = opts;
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    const socket = getSocket();
    const guard = createGuardedReload(reloadRef, isBusyRef);

    // Trailing debounce: a recovery sync emits device:synced + relink:done +
    // attendance:processed back-to-back, and a morning rush is a punch every
    // few seconds — each used to trigger a FULL page reload. One coalesced
    // reload ~400ms after the last event is enough for "live".
    let reloadTimer = null;
    const requestReload = () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        guard.request();
      }, 400);
    };

    const onSynced = ({ name, newLogs, partial } = {}) => {
      if (!silent && newLogs) {
        toast.success(
          partial
            ? `🔄 ${newLogs} سجل جديد من "${name || 'الجهاز'}" (مزامنة جزئية)`
            : `✅ ${newLogs} سجل جديد من "${name || 'الجهاز'}"`,
          { id: 'device-live-sync' },
        );
      }
      requestReload();
    };

    const onRelinkDone = ({ totalLinked } = {}) => {
      if (!totalLinked) return;
      requestReload();
    };

    // Inline grid edits (manual-edit / manual-penalty / absence-type) already
    // apply the update via the page's own row-replacement state update — a
    // full reload would cancel any concurrent edit and reset scroll. Only
    // reload for external sources (scheduler, recovery sync, rules recalc)
    // that the page did not initiate.
    const INLINE_SOURCES = ['manual-edit', 'manual-penalty', 'absence-type'];
    const onProcessed = ({ source } = {}) => {
      if (INLINE_SOURCES.includes(source)) return;
      requestReload();
    };

    const onRealtime = ({ employeeName, duplicate } = {}) => {
      if (!silent && employeeName && !duplicate) {
        toast.success(`📡 بصمة جديدة: ${employeeName}`, { id: `rt-${employeeName}`, duration: 2500 });
      }
      requestReload();
    };

    socket.on('device:synced', onSynced);
    socket.on('relink:done', onRelinkDone);
    socket.on('attendance:processed', onProcessed);
    socket.on('attendance:realtime', onRealtime);

    return () => {
      socket.off('device:synced', onSynced);
      socket.off('relink:done', onRelinkDone);
      socket.off('attendance:processed', onProcessed);
      socket.off('attendance:realtime', onRealtime);
      if (reloadTimer) clearTimeout(reloadTimer);
      guard.cleanup();
    };
  }, [silent]);
}
