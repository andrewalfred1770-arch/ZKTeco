/**
 * Drawer — shared side-anchored panel primitive for the Enterprise Design
 * System. Mirrors the overlay+header+scroll-body+footer shape already
 * duplicated independently in ManualPenaltyModal / ManualEditDrawer /
 * RuleDrawer, so migrating those in Phase 2 is a drop-in swap of their
 * outer wrapper only. Not migrated in this phase.
 */
import React, { useEffect, useId } from 'react';
import { X } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap';

export default function Drawer({
  open,
  onClose,
  title,
  footer,
  children,
  width = 480,
  side = 'left', // matches the existing drawer convention in this app
  closeOnOverlay = true,
  showClose = true,
  panelStyle,
  contentStyle,
  className = '',
}) {
  // Phase 13.9: same "only dismiss if already dismissible" rule as Dialog.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && closeOnOverlay) onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeOnOverlay, onClose]);

  const titleId = useId();
  const containerRef = useFocusTrap(open);

  if (!open) return null;

  const scrimClose = (e) => {
    if (e.target === e.currentTarget && closeOnOverlay) onClose?.();
  };

  return (
    <div
      onClick={scrimClose}
      className="overlay-fade"
      style={{
        position: 'fixed', inset: 0, zIndex: 'var(--z-modal-backdrop)',
        background: 'rgba(6,10,20,0.55)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
      }}
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        dir="rtl"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        className={`drawer-slide-in ${className}`}
        style={{
          position: 'fixed', top: 0, bottom: 0, [side]: 0,
          width: `min(${typeof width === 'number' ? `${width}px` : width}, 100vw)`,
          display: 'flex', flexDirection: 'column',
          background: 'var(--surface-2)',
          borderInlineStart: '1px solid var(--border)',
          boxShadow: 'var(--shadow-lg)',
          zIndex: 'var(--z-drawer)',
          fontFamily: 'var(--font-ui)',
          outline: 'none',
          '--drawer-offset': side === 'left' ? '-16px' : '16px',
          ...panelStyle,
        }}
      >
        {(title || showClose) && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 12, padding: '16px 20px',
            borderBottom: '1px solid var(--border-2)', flexShrink: 0,
          }}>
            {title
              ? <div id={titleId} style={{ fontSize: 'var(--text-lg)', fontWeight: 800, color: 'var(--text)' }}>{title}</div>
              : <span />}
            {showClose && (
              <button
                type="button"
                onClick={() => onClose?.()}
                className="press"
                aria-label="إغلاق"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 28, height: 28, borderRadius: 'var(--radius-sm)', flexShrink: 0,
                  background: 'transparent', border: 'none', color: 'var(--text-3)', cursor: 'pointer',
                }}
              >
                <X style={{ width: 'var(--icon-sm)', height: 'var(--icon-sm)' }} />
              </button>
            )}
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px', ...contentStyle }}>
          {children}
        </div>

        {footer && (
          <div style={{
            display: 'flex', gap: 9, padding: '14px 20px',
            borderTop: '1px solid var(--border-2)', flexShrink: 0,
          }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
