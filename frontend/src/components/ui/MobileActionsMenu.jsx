/**
 * MobileActionsMenu — compact "⋮ المزيد" overflow menu for secondary page
 * actions on mobile. Desktop keeps its existing full button row (callers
 * render this only inside a `md:hidden` wrapper); this component doesn't
 * make that decision itself — it's a pure list-of-actions dropdown.
 *
 * Every action stays fully functional — this only changes where it's
 * reachable from, never what it does.
 *
 * Positioning: rendered through a portal into document.body as
 * `position: fixed`, with its on-screen coordinates computed from the
 * trigger's and the menu's own real `getBoundingClientRect()` — not a
 * hardcoded `inset-inline-*` guess. A CSS-only anchor (e.g.
 * `insetInlineEnd: 0`) breaks for exactly the case this menu exists for:
 * a trigger button sitting near the trailing edge of a narrow phone
 * screen, where "anchor to the trigger's own edge" pushes the menu's
 * opposite edge straight off the viewport. Computing pixel coordinates
 * directly, then clamping them to the viewport, is correct regardless of
 * where the trigger sits, RTL/LTR, or how wide the menu's content is —
 * and the portal means no ancestor's `overflow: hidden` can clip it either.
 */
import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical } from 'lucide-react';

const MARGIN = 8; // minimum breathing room from any viewport edge

export default function MobileActionsMenu({ actions }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null); // null until measured — avoids a flash at (0,0)
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  // Measure AFTER the (invisible) menu has a real box to read, then place
  // it — this is what makes the math correct instead of guessed.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const t = trigger.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Horizontal: default to aligning the menu's trailing edge with the
    // trigger's trailing edge (RTL: trigger's LEFT edge, since that's the
    // side the ⋮ button's own leading content faces) — but clamp so it
    // never crosses either viewport boundary, regardless of which side
    // the trigger happens to sit near.
    let left = t.left; // menu's left edge starts at trigger's left edge
    if (left + m.width > vw - MARGIN) left = vw - MARGIN - m.width; // would overflow right → pull back
    if (left < MARGIN) left = MARGIN; // would overflow left → clamp

    // Vertical: prefer opening below the trigger; flip above it if there
    // isn't enough room below.
    let top = t.bottom + 6;
    if (top + m.height > vh - MARGIN) top = t.top - m.height - 6;
    if (top < MARGIN) top = MARGIN;

    setPos({ left, top });
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      const inTrigger = rootRef.current && rootRef.current.contains(e.target);
      const inMenu = menuRef.current && menuRef.current.contains(e.target);
      if (!inTrigger && !inMenu) { setOpen(false); setPos(null); }
    };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); setPos(null); } };
    const onViewportChange = () => { setOpen(false); setPos(null); }; // resize/scroll invalidates the measured position
    document.addEventListener('mousedown', onDocClick);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open]);

  const visibleActions = actions.filter(a => a && a.hidden !== true);
  if (!visibleActions.length) return null;

  const menu = open && (
    <div
      ref={menuRef}
      role="menu"
      dir="rtl"
      style={{
        position: 'fixed',
        left: pos ? pos.left : -9999,
        top: pos ? pos.top : -9999,
        visibility: pos ? 'visible' : 'hidden', // hidden-but-measurable first pass, no flash
        zIndex: 'var(--z-dropdown)',
        minWidth: 190, maxWidth: 'calc(100vw - 16px)', padding: 6, borderRadius: 10,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', gap: 2,
      }}
    >
      {visibleActions.map((a, i) => (
        <button
          key={a.key || i}
          role="menuitem"
          type="button"
          disabled={a.disabled}
          onClick={() => { setOpen(false); setPos(null); a.onClick?.(); }}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, width: '100%',
            padding: '9px 10px', borderRadius: 7, border: 'none', background: 'transparent',
            color: a.danger ? '#ef4444' : 'var(--text)', fontSize: 13, fontWeight: 600,
            cursor: a.disabled ? 'not-allowed' : 'pointer', opacity: a.disabled ? 0.5 : 1,
            textAlign: 'inherit',
          }}
        >
          {a.icon}
          {a.label}
        </button>
      ))}
    </div>
  );

  return (
    <div ref={rootRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="المزيد من الإجراءات"
        className="touch-target"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 36, height: 36, borderRadius: 8,
          border: '1px solid var(--border)', background: 'var(--surface-2)',
          color: 'var(--text-2)', cursor: 'pointer',
        }}
      >
        <MoreVertical style={{ width: 17, height: 17 }} />
      </button>

      {menu && createPortal(menu, document.body)}
    </div>
  );
}
