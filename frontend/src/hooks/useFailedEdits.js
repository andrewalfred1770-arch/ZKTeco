import { useMemo, useRef, useState } from 'react';
import { createFailedEdits } from '../lib/failedEdits';
import { useUnsavedWork } from './useUnsavedWork';

/**
 * Grid-page wrapper around lib/failedEdits.js.
 *   const failed = useFailedEdits({ id: 'attendance-daily-failed', label: '…', gridRef });
 * Returns the registry API plus:
 *   cellClassRules   merge into the grid's defaultColDef so a failed cell is outlined (class cell-paste-failed, see index.css)
 *   busyRef          a ref-like object that is "busy" while a save is in flight OR an unsaved failed edit exists — pass it to the live-sync
 *                    hooks so a background reload cannot wipe a cell that still holds an unsaved value
 *   count / unknown / retrying for the banner (unknown = edits whose server outcome could not be confirmed)
 *   resync           optional page loader, called after the user discards edits that may in fact have been saved on the server
 * The screen also registers an unsaved-work probe, so if the session ends again the page stays mounted under the login overlay.
 */
export function useFailedEdits({ id, label, gridRef, editCountRef, revert, resync }) {
  const [, setTick] = useState(0);
  const holder = useRef(null);
  const resyncRef = useRef(resync);
  resyncRef.current = resync;   // always the page's latest loader (no stale closure)
  if (!holder.current) {
    holder.current = createFailedEdits({
      onDiscardUnknown: () => { if (resyncRef.current) resyncRef.current(); },
      onChange: () => {
        setTick((n) => n + 1);
        const api = gridRef.current && gridRef.current.api;
        if (api && !(api.isDestroyed && api.isDestroyed())) api.refreshCells({ force: false, suppressFlash: true });
      },
      revert: revert || ((e) => {
        const api = gridRef.current && gridRef.current.api;
        const node = api && api.getRowNode && api.getRowNode(String(e.rowId));
        if (node) node.setDataValue(e.field, e.oldValue);
      }),
    });
  }
  const store = holder.current;
  useUnsavedWork(id, label, () => store.size() > 0);
  const cellClassRules = useMemo(() => ({
    'cell-paste-failed': (p) => !!p.data && !!p.colDef && store.has(p.data.id, p.colDef.field),
  }), [store]);
  const busyRef = useMemo(() => ({ get current() { return (editCountRef ? editCountRef.current : 0) > 0 || store.size() > 0; } }), [store, editCountRef]);
  return Object.assign(store, { cellClassRules, busyRef, count: store.size(), unknown: store.unknownCount(), retrying: store.isRetrying() });
}
