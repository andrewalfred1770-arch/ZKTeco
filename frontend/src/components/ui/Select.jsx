/**
 * Select — shared native-select primitive. Wraps the existing
 * `select.input` class (index.css — already carries the dark-mode custom
 * caret + focus ring) and adds the same label/hint/error layout as Input.
 */
import React, { useId } from 'react';

export default function Select({
  label,
  error,
  hint,
  options,
  placeholder,
  className = '',
  style,
  id,
  children,
  ...rest
}) {
  const autoId = useId();
  const selectId = id || autoId;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
      {label && <label htmlFor={selectId} className="label">{label}</label>}
      <select
        id={selectId}
        className={`input ${className}`}
        style={{ borderColor: error ? 'var(--status-absent)' : undefined, ...style }}
        aria-invalid={error ? 'true' : undefined}
        {...rest}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options
          ? options.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))
          : children}
      </select>
      {error ? (
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--status-absent)', fontWeight: 600 }}>{error}</span>
      ) : hint ? (
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-3)' }}>{hint}</span>
      ) : null}
    </div>
  );
}
