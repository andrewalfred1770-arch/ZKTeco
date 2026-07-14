/**
 * TimeCellEditor — AG-Grid inline cell editor using a native `<input type="time">`
 * popup ("time picker inline" per the spreadsheet-editing spec).
 *
 * Returns an "HH:mm" string (or '' when cleared) regardless of the underlying
 * field's storage shape:
 *  - checkIn/checkOut are already "HH:mm" strings in the grid's row data (the
 *    GET /attendance/daily list formats them server-side) → pass
 *    `cellEditorParams:{mode:'datetime'}` (default), which also tolerates a raw
 *    ISO datetime/Date as a fallback.
 *  - duration fields (e.g. workedMinutes) store integer minutes → pass
 *    `cellEditorParams:{mode:'minutes'}` so the editor seeds from minutesToTime().
 *
 * The caller's onCellEditingStopped handler converts the returned "HH:mm" back
 * to whatever shape the API expects (checkIn/checkOut take "HH:mm" directly;
 * workedMinutes goes through timeToMinutes()).
 */
import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { minutesToTime } from '../../lib/formatters';

const HHMM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

function valueToHHMM(value, mode) {
  if (mode === 'minutes') {
    if (value == null) return '';
    return minutesToTime(value);
  }
  // datetime mode
  if (!value) return '';
  const s = String(value);
  if (HHMM_RE.test(s)) {
    const [h, m] = s.split(':');
    return `${h.padStart(2, '0')}:${m}`;
  }
  // fallback: raw ISO datetime / Date
  try {
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch { return ''; }
}

const TimeCellEditor = forwardRef((props, ref) => {
  const { mode = 'datetime', value } = props;
  const [text, setText] = useState(() => valueToHHMM(value, mode));
  const inputRef = useRef(null);

  useImperativeHandle(ref, () => ({
    getValue: () => text,
    isCancelBeforeStart: () => false,
    isCancelAfterEnd: () => false,
    afterGuiAttached: () => {
      inputRef.current?.focus();
      inputRef.current?.showPicker?.();
    },
  }));

  return (
    <input
      ref={inputRef}
      type="time"
      value={text}
      onChange={e => setText(e.target.value)}
      style={{
        width: '100%', height: '100%', border: 'none', outline: 'none',
        background: 'var(--surface)', color: 'var(--text)',
        fontFamily: 'Consolas,monospace', fontSize: '12.5px',
        textAlign: 'center', direction: 'ltr', padding: '0 6px',
      }}
    />
  );
});

export default TimeCellEditor;

