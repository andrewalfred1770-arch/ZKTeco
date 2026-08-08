/**
 * Input — shared text-field primitive. Wraps the existing `.input` class
 * (index.css — already token-driven border/background/focus) and adds a
 * consistent label/hint/error layout so pages stop hand-rolling their own.
 */
import React, { useId } from 'react';

export default function Input({
  label,
  error,
  hint,
  icon,
  className = '',
  style,
  id,
  ...rest
}) {
  const autoId = useId();
  const inputId = id || autoId;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
      {label && <label htmlFor={inputId} className="label">{label}</label>}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        {icon && (
          <span style={{
            position: 'absolute', insetInlineStart: 10,
            display: 'flex', color: 'var(--text-3)', pointerEvents: 'none',
          }}>
            {icon}
          </span>
        )}
        <input
          id={inputId}
          className={`input ${className}`}
          style={{
            paddingInlineStart: icon ? 32 : undefined,
            borderColor: error ? 'var(--status-absent)' : undefined,
            ...style,
          }}
          aria-invalid={error ? 'true' : undefined}
          {...rest}
        />
      </div>
      {error ? (
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--status-absent)', fontWeight: 600 }}>{error}</span>
      ) : hint ? (
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-3)' }}>{hint}</span>
      ) : null}
    </div>
  );
}
