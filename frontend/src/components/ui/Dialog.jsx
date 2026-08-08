/**
 * Dialog — shared centered-modal primitive for the Enterprise Design
 * System. Presentation only: owns the overlay, elevation, header/footer
 * chrome, ESC-to-close and click-outside-to-close. Callers own all
 * content and all business logic.
 */
import React, { useEffect, useId } from 'react';
import { X } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap';

export default function Dialog({
  open,
  onClose,
  title,
  footer,
  children,
  maxWidth = 480,
  closeOnOverlay = true,
  showClose = true,
  panelStyle,
  overlayStyle,
  contentStyle,
  className = '',
}) {
  // Phase 13.9: Escape only ever closes a dialog that's already dismissible
  // by other means (closeOnOverlay/showClose reflect the same "can this be
  // cancelled" decision the caller already made) — never adds a NEW way to
  // dismiss something that wasn't dismissible before.
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

  const hasHeader = Boolean(title || showClose);

  const scrimClose = (e) => {
    if (e.target === e.currentTarget && closeOnOverlay) onClose?.();
  };

  return (
    <div
      onClick={scrimClose}
      className="overlay-fade"
      style={{
        position: 'fixed', inset: 0, zIndex: 'var(--z-modal-backdrop)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        background: 'rgba(6,10,20,0.6)',
        backdropFilter: 'blur(8px) saturate(120%)',
        WebkitBackdropFilter: 'blur(8px) saturate(120%)',
        ...overlayStyle,
      }}
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        dir="rtl"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        className={`dialog-pop ${className}`}
        style={{
          position: 'relative', width: '100%', maxWidth, maxHeight: '92vh',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          borderRadius: 'var(--radius-xl)',
          border: '1px solid var(--border)',
          background: 'var(--surface-2)',
          boxShadow: 'var(--shadow-lg)',
          zIndex: 'var(--z-modal)',
          fontFamily: 'var(--font-ui)',
          outline: 'none',
          ...panelStyle,
        }}
      >
        {hasHeader && (
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

        <div style={{ flex: 1, overflowY: 'auto', padding: hasHeader ? '18px 20px' : 0, ...contentStyle }}>
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
