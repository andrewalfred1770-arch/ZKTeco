/**
 * Card — shared elevated-surface primitive. Wraps the existing `.card` /
 * `.card-sheet` / `.glass-card` classes (index.css, already token-driven
 * for background/border/shadow) and adds token-driven padding + optional
 * header/footer strips instead of every page hand-rolling its own.
 */
import React from 'react';

const VARIANT_CLASS = {
  default: 'card',
  sheet: 'card-sheet',
  glass: 'glass-card',
};

const PADDING = {
  none: '0',
  sm: 'var(--space-3)',
  md: 'var(--space-4)',
  lg: 'var(--space-6)',
};

export default function Card({
  variant = 'default',
  padding = 'md',
  header,
  footer,
  children,
  className = '',
  style,
  contentStyle,
  ...rest
}) {
  const variantClass = VARIANT_CLASS[variant] || VARIANT_CLASS.default;
  return (
    <div className={`${variantClass} ${className}`} style={style} {...rest}>
      {header && <div className="panel-head">{header}</div>}
      <div style={{ padding: PADDING[padding] ?? PADDING.md, ...contentStyle }}>
        {children}
      </div>
      {footer && (
        <div style={{
          padding: 'var(--space-3) var(--space-4)',
          borderTop: '1px solid var(--border-2)',
        }}>
          {footer}
        </div>
      )}
    </div>
  );
}
