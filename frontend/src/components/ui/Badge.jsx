/**
 * Badge — shared status-pill primitive. Wraps the existing `.badge-*`
 * tone classes (index.css — already theme-split light/dark) so pages stop
 * hand-rolling their own pill markup/colors per status.
 */
import React from 'react';

const TONE_CLASS = {
  green: 'badge-green',
  red: 'badge-red',
  yellow: 'badge-yellow',
  blue: 'badge-blue',
  gray: 'badge-gray',
  purple: 'badge-purple',
};

export default function Badge({ tone = 'gray', icon, children, className = '', style, ...rest }) {
  const toneClass = TONE_CLASS[tone] || TONE_CLASS.gray;
  return (
    <span className={`badge ${toneClass} ${className}`} style={{ gap: 'var(--space-1)', ...style }} {...rest}>
      {icon}
      {children}
    </span>
  );
}
