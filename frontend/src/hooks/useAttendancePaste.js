/**
 * useAttendancePaste — one copy/paste workflow for every editable attendance
 * grid. The page supplies the currently selected rows and three lifecycle
 * callbacks; saving goes through lib/attendanceClipboard.pasteIntoRow, i.e.
 * the same endpoints/validation/audit as inline cell edits.
 *
 *   selected    array of selected grid rows (copy/paste needs exactly one)
 *   fallbackDate  date string when rows carry no `date` (Daily page)
 *   editMode    false → paste disabled (read-only mode)
 *   onBegin(t)  before saving (block background reloads, mark row busy)
 *   onSaved(updatedRow, target)  server's final row after a (partial) save
 *   onEnd(t)    always, after saving
 */
import { useCallback, useState, useSyncExternalStore } from 'react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import {
  buildClip, getClip, setClip, subscribeClip, pasteBlockReason, pasteIntoRow,
} from '../lib/attendanceClipboard';

export function useAttendancePaste({ selected, fallbackDate, editMode = true, onBegin, onSaved, onEnd }) {
  const clip = useSyncExternalStore(subscribeClip, getClip);
  const [target, setTarget] = useState(null);
  const [saving, setSaving] = useState(false);

  const single = selected?.length === 1 ? selected[0] : null;
  const canCopy = !!single;
  const blockReason = pasteBlockReason(clip, single, editMode);
  const canPaste = !blockReason;

  const copy = useCallback(() => {
    if (!single) return;
    setClip(buildClip(single, fallbackDate));
    toast.success(`تم نسخ حركة ${single.employeeName}`);
  }, [single, fallbackDate]);

  const openPaste = useCallback(() => { if (canPaste) setTarget(single); }, [canPaste, single]);
  const close = useCallback(() => { if (!saving) setTarget(null); }, [saving]);

  const apply = useCallback(async (keys) => {
    const t = target;
    if (!t?.id || !clip || !keys.length) return;
    setSaving(true);
    onBegin?.(t);
    try {
      const { updated, error } = await pasteIntoRow(api, clip, keys, t);
      if (updated) onSaved?.(updated, t);
      if (error) toast.error(error);
      else { toast.success('تم لصق الحركة'); setTarget(null); }
    } finally {
      onEnd?.(t);
      setSaving(false);
    }
  }, [target, clip, onBegin, onSaved, onEnd]);

  return {
    clip, canCopy, canPaste, blockReason, copy, openPaste,
    modalProps: { open: !!target, onClose: close, onApply: apply, saving, clip, target },
  };
}
