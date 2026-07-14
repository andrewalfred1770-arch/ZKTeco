import { useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import { getSocket } from '../lib/socket';
import { createGuardedReload } from './liveSyncGuard';

/**
 * Subscribes a rule-dependent page to live "rule changed → recalculated"
 * events from the backend (recalcEngine + the rules routes emit these — see
 * backend/src/routes/rules.js `ruleChanged()`).
 *
 * Mirrors the proven `device:synced → loadAll()` pattern already used in
 * DevicesPage, just generalized across every screen whose numbers are
 * derived from the Rules Engine — so editing a rule reflects everywhere
 * instantly, with no manual refresh.
 *
 * @param {() => void} reload - the page's existing data-loading callback
 *   (e.g. the `load` from `useCallback(async () => {...}, [])`)
 * @param {object} [opts]
 * @param {boolean} [opts.silent=false] - suppress the "🔄 جاري إعادة الاحتساب" /
 *   "✅ تم التحديث" toasts (still reloads). Use when a page already shows its
 *   own progress UI.
 * @param {import('react').MutableRefObject<number>} [opts.isBusyRef] - a ref
 *   whose `.current` is nonzero while the page has an edit/save in flight
 *   (e.g. its `editCountRef`). While truthy, this hook defers the reload
 *   instead of swapping rowData mid-edit — see liveSyncGuard.js for why.
 */
export function useRulesLiveSync(reload, opts = {}) {
  const { silent = false, isBusyRef } = opts;
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    const socket = getSocket();
    let toastId;
    const guard = createGuardedReload(reloadRef, isBusyRef);

    // Trailing debounce — multiple recalc:done events (scoped recalcs fired
    // per branch/department) collapse into a single page reload.
    let reloadTimer = null;
    const requestReload = () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        guard.request();
      }, 400);
    };

    const onChanged = ({ keys }) => {
      if (!silent) {
        toastId = toast.loading(
          `🔄 جاري إعادة الاحتساب — تم تعديل: ${(keys || []).join('، ') || 'القواعد'}…`,
          { id: 'rules-recalc' },
        );
      }
      // Reload immediately on rules:changed so the Rules list / any rule-dependent
      // page reflects the new rule state without waiting for recalc:done (~2s delay).
      requestReload();
    };

    const onDone = ({ employeeCount, dayCount }) => {
      if (!silent) {
        toast.success(`✅ تم تحديث الحسابات تلقائيًا (${employeeCount || 0} موظف × ${dayCount || 0} يوم)`, { id: 'rules-recalc' });
      }
      // Reload again after recalc:done — attendance/payroll data is now fresh.
      requestReload();
    };

    socket.on('rules:changed', onChanged);
    socket.on('recalc:done', onDone);

    return () => {
      socket.off('rules:changed', onChanged);
      socket.off('recalc:done', onDone);
      if (toastId) toast.dismiss(toastId);
      if (reloadTimer) clearTimeout(reloadTimer);
      guard.cleanup();
    };
  }, [silent]);
}
