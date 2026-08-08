/**
 * Spinner — token-driven loading indicator. Reuses the existing global
 * `spin` keyframe (index.css) rather than declaring its own.
 */
import React from 'react';

const SIZE_PX = { sm: 14, md: 18, lg: 24 };

export default function Spinner({ size = 'md', tone, className = '', style }) {
  const px = typeof size === 'number' ? size : (SIZE_PX[size] || SIZE_PX.md);
  return (
    <span
      className={className}
      role="status"
      aria-label="جارٍ التحميل"
      style={{
        display: 'inline-block',
        width: px, height: px,
        border: '2px solid var(--border)',
        borderInlineStart: `2px solid ${tone || 'var(--accent)'}`,
        borderRadius: 'var(--radius-full)',
        animation: 'spin 0.7s linear infinite',
        flexShrink: 0,
        ...style,
      }}
    />
  );
}
