/**
 * Tooltip — shared hover/focus tooltip primitive for the Enterprise Design
 * System. CSS-positioned, no portal. Built as a primitive only — not wired
 * into any page yet (Phase 2 rollout, per the phased scope).
 */
import React, { useId, useRef, useState } from 'react';

const SIDE_STYLE = {
  top:    { bottom: '100%', insetInlineStart: '50%', transform: 'translateX(-50%) translateY(-6px)', marginBottom: 6 },
  bottom: { top: '100%', insetInlineStart: '50%', transform: 'translateX(-50%) translateY(6px)', marginTop: 6 },
  start:  { insetInlineEnd: '100%', top: '50%', transform: 'translateY(-50%) translateX(-6px)', marginInlineEnd: 6 },
  end:    { insetInlineStart: '100%', top: '50%', transform: 'translateY(-50%) translateX(6px)', marginInlineStart: 6 },
};

export default function Tooltip({ label, children, side = 'top', delay = 300 }) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef(null);
  const id = useId();

  const show = () => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setVisible(true), delay);
  };
  const hide = () => {
    clearTimeout(timerRef.current);
    setVisible(false);
  };

  if (!label) return children;

  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      aria-describedby={visible ? id : undefined}
    >
      {children}
      {visible && (
        <span
          id={id}
          role="tooltip"
          className="tooltip-pop"
          style={{
            position: 'absolute', zIndex: 'var(--z-tooltip)',
            whiteSpace: 'nowrap', pointerEvents: 'none',
            padding: '5px 9px', borderRadius: 'var(--radius-sm)',
            background: 'var(--surface-4)', color: 'var(--text)',
            fontSize: 'var(--text-xs)', fontWeight: 600,
            border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)',
            ...SIDE_STYLE[side],
          }}
        >
          {label}
        </span>
      )}
    </span>
  );
}
