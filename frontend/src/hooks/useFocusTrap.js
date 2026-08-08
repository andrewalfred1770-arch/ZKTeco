import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * useFocusTrap — shared accessibility behavior for every dialog/drawer/
 * full-screen-workspace overlay in the app (Phase 13.9). Attach the
 * returned ref to the overlay's outer, keyboard-focusable container:
 *  - moves focus into the container the moment it opens (`active` becomes
 *    true) — onto the first focusable element, or the container itself if
 *    it has none
 *  - traps Tab/Shift+Tab navigation within the container while open, so a
 *    keyboard user can never tab out to the page behind it
 *  - restores focus to whatever element had it right before the dialog
 *    opened (the trigger button, typically) once `active` becomes false —
 *    only if that element still exists in the DOM
 *
 * Deliberately does NOT handle Escape or overlay-click-to-close — those are
 * dismissal-policy decisions each caller/primitive already makes for itself
 * (e.g. Dialog/Drawer's `closeOnOverlay`, or a caller that must never be
 * dismissed by Escape, like a mandatory setup wizard). This hook only ever
 * manages focus, never triggers a close.
 *
 * @param {boolean} active - true while the dialog/drawer/overlay is open
 * @returns {React.RefObject<HTMLElement>}
 */
export function useFocusTrap(active) {
  const containerRef = useRef(null);
  const previouslyFocused = useRef(null);

  useEffect(() => {
    if (!active) return undefined;

    previouslyFocused.current = document.activeElement;

    const container = containerRef.current;

    // Deferred one tick: the container is often still mid-mount (a
    // conditional `if (!open) return null` just resolved to true) when this
    // effect runs, so querying for focusable children synchronously can
    // miss content that hasn't painted yet.
    const focusTimer = setTimeout(() => {
      if (!container) return;
      // Respect a field's own `autoFocus` (e.g. AbsenceTypeModal's custom-
      // days input) — React applies that synchronously on mount, before
      // this deferred tick runs, so if focus already landed inside the
      // container we don't fight it by jumping to the first element instead.
      if (container.contains(document.activeElement) && document.activeElement !== container) return;
      const first = container.querySelector(FOCUSABLE_SELECTOR);
      (first || container).focus();
    }, 0);

    const onKeyDown = (e) => {
      if (e.key !== 'Tab' || !container) return;
      const focusables = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR))
        .filter((el) => el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    container?.addEventListener('keydown', onKeyDown);

    return () => {
      clearTimeout(focusTimer);
      container?.removeEventListener('keydown', onKeyDown);
      if (previouslyFocused.current && document.body.contains(previouslyFocused.current)) {
        previouslyFocused.current.focus();
      }
    };
  }, [active]);

  return containerRef;
}
