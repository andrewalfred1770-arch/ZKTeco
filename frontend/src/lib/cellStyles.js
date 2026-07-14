/**
 * Theme-aware AG Grid cell style helpers.
 * Call with isLight from useTheme() to get readable colors in both themes.
 *
 * All values use CSS variables so they adapt automatically, but we also
 * provide explicit contrast-safe overrides for the light theme.
 */

/** Base monospace style for numbers.
 *  `.ag-cell` is a flex row; `direction:ltr` keeps digits/colons rendering
 *  left-to-right (e.g. "08:00", "1,234") while `justifyContent:flex-end`
 *  pins the value to the right edge so numeric columns line up with the
 *  right-aligned Arabic text columns (no more column drift). */
export const NUM = {
  textAlign:      'right',
  direction:      'ltr',
  justifyContent: 'flex-end',
  fontFamily:  'Consolas, monospace',
  fontVariantNumeric: 'tabular-nums lining-nums',
  fontWeight:  '600',
};

export const CENTER = { justifyContent: 'center', textAlign: 'center' };

/** Employee name — bold, primary color */
export const nameCell = () => ({
  color:       'var(--c-name)',
  fontWeight:  '700',
  fontFamily:  'Cairo, sans-serif',
});

/** Code / ZK ID — monospace, muted (right-aligned like all data columns) */
export const codeCell = () => ({
  ...NUM,
  color:       'var(--c-code)',
  fontSize:    '11.5px',
  letterSpacing: '0.04em',
});

/** Department / Branch — secondary text */
export const deptCell = () => ({
  color:       'var(--c-dept)',
  fontFamily:  'Cairo, sans-serif',
  fontWeight:  '500',
  fontSize:    '12px',
});

/** Salary / money — bold monospace */
export const moneyCell = (value) => ({
  ...NUM,
  color:       Number(value) > 0 ? 'var(--c-money)' : 'var(--c-muted)',
  fontWeight:  Number(value) > 0 ? '700' : '500',
});

/** Overtime hours — purple tint when > 0 */
export const otCell = (value) => ({
  ...NUM,
  color:       Number(value) > 0 ? 'var(--c-ot)' : 'var(--c-muted)',
  fontWeight:  Number(value) > 0 ? '700' : '400',
});

/** Late / penalty — amber/orange */
export const penaltyCell = (value) => ({
  ...NUM,
  color:       Number(value) > 0 ? 'var(--c-penalty)' : 'var(--c-muted)',
  fontWeight:  Number(value) > 0 ? '700' : '400',
});

/** Check-in / check-out time */
export const timeCell = (value) => ({
  ...NUM,
  color:       value ? 'var(--c-time)' : 'var(--c-muted)',
  fontWeight:  '600',
});

/** Net salary — cyan accent */
export const netCell = () => ({
  ...NUM,
  color:       'var(--c-net)',
  fontWeight:  '800',
  fontSize:    '13px',
  borderLeft:  '2px solid rgba(37,99,235,0.25)',
});

/** Presence count / green */
export const presentCell = (value) => ({
  ...NUM,
  color:       Number(value) > 0 ? 'var(--c-green)' : 'var(--c-muted)',
  fontWeight:  '700',
});

/** Absence count / red */
export const absentCell = (value) => ({
  ...NUM,
  color:       Number(value) > 0 ? 'var(--c-red)' : 'var(--c-muted)',
  fontWeight:  '700',
});

/** Generic muted value (dash / zero) */
export const mutedCell = () => ({
  color:       'var(--c-muted)',
  fontWeight:  '400',
});

/** Row index column */
export const rowNumCell = () => ({
  color:       'var(--c-muted)',
  fontSize:    '11px',
  justifyContent: 'center',
  fontFamily:  'Consolas, monospace',
});
