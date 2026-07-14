import { useEffect, useRef } from 'react';

/**
 * Register a keyboard shortcut that fires a stable callback.
 *
 * @param {string}   key      - e.g. 'r', 'p', 'Escape', 'F5'
 * @param {Function} callback - called when the shortcut fires; stable via useRef
 * @param {object}   [opts]
 * @param {boolean}  [opts.ctrl]  - require Ctrl (or Cmd on Mac)
 * @param {boolean}  [opts.shift] - require Shift
 * @param {boolean}  [opts.alt]   - require Alt
 * @param {boolean}  [opts.preventDefault=true]
 */
export function useKeyboardShortcut(key, callback, { ctrl = false, shift = false, alt = false, preventDefault = true } = {}) {
  const cbRef = useRef(callback);
  useEffect(() => { cbRef.current = callback; }, [callback]);

  useEffect(() => {
    const handler = (e) => {
      if (ctrl  && !(e.ctrlKey  || e.metaKey)) return;
      if (shift && !e.shiftKey)                return;
      if (alt   && !e.altKey)                  return;
      // Ignore shortcuts while the user is typing in an input/textarea/select
      const tag = document.activeElement?.tagName;
      if (['INPUT','TEXTAREA','SELECT'].includes(tag)) return;
      if (e.key === key) {
        if (preventDefault) e.preventDefault();
        cbRef.current();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [key, ctrl, shift, alt, preventDefault]);
}
