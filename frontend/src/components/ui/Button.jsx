/**
 * Button — shared control for the Enterprise Design System. Wraps the
 * existing `.btn-*` color/hover classes (index.css) and threads sizing
 * through the spacing/typography token scale instead of ad-hoc px, so
 * every button in a future page migration shares one source of truth.
 */
import React from 'react';
import Spinner from './Spinner';

const VARIANT_CLASS = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
  success: 'btn-success',
  warning: 'btn-warning',
};

const SIZE_STYLE = {
  sm: { padding: 'var(--space-1) var(--space-3)', fontSize: 'var(--text-xs)', gap: 'var(--space-1)' },
  md: { padding: 'var(--space-2) var(--space-4)', fontSize: 'var(--text-sm)', gap: 'var(--space-2)' },
  lg: { padding: 'var(--space-3) var(--space-5)', fontSize: 'var(--text-md)', gap: 'var(--space-2)' },
};

export default function Button({
  variant = 'primary',
  size = 'md',
  icon,
  iconPosition = 'start',
  loading = false,
  disabled = false,
  fullWidth = false,
  children,
  className = '',
  style,
  type = 'button',
  ...rest
}) {
  const variantClass = VARIANT_CLASS[variant] || VARIANT_CLASS.primary;
  const sizeStyle = SIZE_STYLE[size] || SIZE_STYLE.md;
  const isDisabled = disabled || loading;

  return (
    <button
      type={type}
      disabled={isDisabled}
      className={`${variantClass} press ${className}`}
      style={{ ...sizeStyle, width: fullWidth ? '100%' : undefined, ...style }}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size="sm" tone="currentColor" /> : (icon && iconPosition === 'start' ? icon : null)}
      {children}
      {!loading && icon && iconPosition === 'end' ? icon : null}
    </button>
  );
}
