/**
 * DebouncedInput — drop-in <input> for search boxes whose consumer does heavy
 * work per change (re-filtering a multi-thousand-row AG Grid, re-rendering a
 * whole page).
 *
 * The text the user types is held in LOCAL state, so every keystroke echoes
 * instantly and costs one tiny re-render of just this input. The parent's
 * `onCommit(value)` — the part that actually filters the grid — fires once the
 * user pauses typing for `delay` ms, so a burst of keystrokes (or a run of
 * backspaces) causes ONE grid refresh instead of one per key.
 *
 * Emptying the box commits almost immediately (CLEAR_DELAY, just long enough for
 * the cleared text to paint first); Enter and blur commit at once, so clearing
 * restores the full list right away and nothing typed is ever left un-applied.
 * A change made from outside (a clear button, a filter reset/preset) always
 * wins over any text still waiting to commit.
 *
 * Search is local everywhere it is used, so there is no request to cancel and
 * no stale response that could overwrite a newer one: only the latest committed
 * value is ever applied.
 */
import React, { useEffect, useRef, useState } from 'react';

// Restoring a large unfiltered list is the heaviest commit; let the keystroke's
// own repaint (the box visibly emptying) happen before doing it.
const CLEAR_DELAY = 30;

export default function DebouncedInput({ value = '', onCommit, delay = 120, onKeyDown, onBlur, ...rest }) {
  const [local, setLocal] = useState(value);
  const timer = useRef(null);
  const committed = useRef(value);          // last value the parent is known to hold
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  // External change (clear button, reset, preset) replaces whatever is typed.
  useEffect(() => {
    if (value !== committed.current) {
      clearTimeout(timer.current);
      committed.current = value;
      setLocal(value);
    }
  }, [value]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const flush = (v) => {
    clearTimeout(timer.current);
    if (v !== committed.current) {
      committed.current = v;
      onCommitRef.current(v);
    }
  };

  return (
    <input
      {...rest}
      value={local}
      onChange={(e) => {
        const v = e.target.value;
        setLocal(v);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => flush(v), v === '' ? CLEAR_DELAY : delay);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') flush(e.currentTarget.value);
        if (onKeyDown) onKeyDown(e);
      }}
      onBlur={(e) => {
        flush(e.currentTarget.value);
        if (onBlur) onBlur(e);
      }}
    />
  );
}
