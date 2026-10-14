/**
 * TimeCellEditor — AG-Grid inline cell editor using a native `<input type="time">`
 * popup ("time picker inline" per the spreadsheet-editing spec).
 *
 * A plain TEXT field (not the native <input type="time"> picker): typing and pasting work like a spreadsheet cell, and the
 * value is read by the same strict parser the grid's paste uses (lib/timeInput.js) — "9:00", "0900", "09:00 AM", "٩:٠٠ ص"
 * all commit as "09:00". Text that is not a valid time is committed AS TYPED so the page's own validation rejects it with a
 * message instead of the edit silently turning into some other time. (The native picker popup took focus away from the
 * grid, which could end the edit before the chosen value had been committed.)
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
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { minutesToTime } from '../../lib/formatters';
import { parseTimeInput } from '../../lib/timeInput';

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
  const { mode = 'datetime', value, onValueChange, eventKey } = props;
  // Typing straight onto a focused cell (Excel style) starts the edit WITH that first character instead of losing it;
  // Backspace/Delete starts from an empty field. Double-click / F2 / Enter seed the current value and select it.
  const typedStart = (typeof eventKey === 'string' && eventKey.length === 1 && /[0-9٠-٩۰-۹]/.test(eventKey)) ? eventKey
    : (eventKey === 'Backspace' || eventKey === 'Delete') ? '' : null;
  const [text, setText] = useState(() => (typedStart !== null ? typedStart : valueToHHMM(value, mode)));
  const inputRef = useRef(null);

  const updateText = t => {
    setText(t);
    // Under gridOptions.reactiveCustomComponents the grid reads the edited
    // value off this callback (not the ref's getValue()) when it resolves
    // the cell editor as a reactive proxy — without this call the commit
    // always sees the original, unmodified value.
    const p = parseTimeInput(t);
    onValueChange?.(p.ok ? p.value : (p.empty ? '' : t.trim()));
  };

  useImperativeHandle(ref, () => ({
    getValue: () => { const p = parseTimeInput(text); return p.ok ? p.value : (p.empty ? '' : text.trim()); },
    isCancelBeforeStart: () => false,
    isCancelAfterEnd: () => false,
    afterGuiAttached: () => {
      inputRef.current?.focus();
      if (typedStart === null) inputRef.current?.select?.();
    },
  }));

  // AG Grid only invokes the afterGuiAttached() above for plain JS editors;
  // for React editors it's proxied through reactiveCustomComponents' method
  // registration, which this ref-based editor never wires up — so focus
  // silently never lands on the input. Mount-time focus works regardless of
  // that wiring and is what actually puts the cursor in the field.
  useEffect(() => {
    inputRef.current?.focus();
    if (typedStart === null) inputRef.current?.select?.();
    else { const n = inputRef.current?.value?.length ?? 0; inputRef.current?.setSelectionRange?.(n, n); }
    if (typedStart) onValueChange?.(typedStart);   // the typed first character is already part of the edit
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="text"
      placeholder="HH:mm"
      autoComplete="off"
      spellCheck={false}
      value={text}
      onChange={e => updateText(e.target.value)}
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

