import React from 'react';
import logoUrl from '../../assets/brand/checkin-logo.png';

/**
 * CheckIn logo — the approved fingerprint + check mark, used as the exact supplied artwork (transparent PNG master in
 * src/assets/brand/, never redrawn). The charcoal fingerprint disappears on dark surfaces, so in the dark theme (and wherever
 * `plated` is set) the mark sits on a white rounded tile — the same treatment as the application / tray icon.
 */
export const BRAND_COLORS = {
  charcoal: '#293438', charcoalDeep: '#20282B', green: '#4FBF6B', greenDark: '#3FA85C', greenStrong: '#1E7A34', greenTint: '#E9F4EC',
  surface: '#FFFFFF', border: '#E5E7EB', textMuted: '#6B7280',
  text: '#F5F5F5', darkBorder: '#2D2D2D',
  success: '#4FBF6B', warning: '#F59E0B', error: '#EF4444',
};

/** The symbol alone. `plated`: true = always on the white tile, false = bare, undefined = tile in the dark theme only. */
export function CheckInMark({ size = 32, plated, animate = false, title = 'CheckIn', className = '', style }) {
  const cls = ['ci-mark', animate ? 'ci-mark-animate' : '', plated === true ? 'ci-mark--plated' : plated === undefined ? 'ci-mark--auto' : '', className].filter(Boolean).join(' ');
  return (
    <img
      src={logoUrl} alt={title} width={size} height={size} draggable={false} className={cls}
      style={{ width: size, height: size, display: 'block', flex: 'none', ...style }}
    />
  );
}

/** Symbol + real-text wordmark. `onLight` switches the wordmark to dark-on-light colours. */
export function CheckInLogo({ height = 32, onLight = false, plated, animate = false, className = '', style }) {
  const word = onLight ? BRAND_COLORS.charcoal : BRAND_COLORS.text;
  const accent = onLight ? BRAND_COLORS.greenStrong : BRAND_COLORS.green;
  return (
    <span
      className={`ci-logo ${className}`.trim()} dir="ltr"
      style={{ display: 'inline-flex', alignItems: 'center', gap: Math.round(height * 0.22), lineHeight: 1, ...style }}
    >
      <CheckInMark size={height} plated={plated} animate={animate} title="" />
      <span
        style={{
          fontFamily: 'var(--font-brand, Cairo, "Segoe UI", sans-serif)', fontWeight: 700,
          fontSize: Math.round(height * 0.6), letterSpacing: '0.01em', color: word,
        }}
      >
        Check<span style={{ color: accent }}>In</span>
      </span>
    </span>
  );
}

export default CheckInLogo;
