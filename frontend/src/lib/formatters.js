/**
 * ERP Formatters — Guaranteed Western/Latin numerals (0-9)
 *
 * Strategy (defence-in-depth):
 *  1. Manual regex formatting — no toLocaleString() with Arabic locale
 *  2. westernDigits() strip — converts any Arabic-Indic that slipped through
 *  3. CSS font-variant-numeric in index.css — browser-level prevention
 */

// ─── Nuclear option: strip Arabic-Indic digits from any string ──────────────
// Eastern Arabic-Indic:  ٠١٢٣٤٥٦٧٨٩  (U+0660–U+0669)
// Extended Arabic-Indic: ۰۱۲۳۴۵۶۷۸۹  (U+06F0–U+06F9)
export function westernDigits(value) {
  return String(value ?? '')
    .replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x0660)
    .replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x06F0);
}

// ─── Read a nested field by dotted path: getNestedValue(row, 'employee.name') ──
export function getNestedValue(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((acc, key) => acc?.[key], obj);
}

// ─── Internal manual formatter — bypasses locale entirely ────────────────────
function _fmt(n, decimals = 0, showZero = false) {
  const num = Number(n);
  if (isNaN(num)) return null;
  if (!showZero && num === 0 && decimals === 0) return null;
  const abs   = Math.abs(num);
  const fixed = abs.toFixed(decimals);
  const [int, dec] = fixed.split('.');
  const intStr = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign   = num < 0 ? '-' : '';
  const result = sign + intStr + (decimals > 0 && dec ? '.' + dec : '');
  // Safety: strip any Arabic digits (shouldn't be any, but just in case)
  return westernDigits(result);
}

// ─── Time ─────────────────────────────────────────────────────────────────────
/**
 * "08:00" | ISO datetime | Date → "08:00 AM" (12-hour, Western digits)
 */
export function fmtTime(value) {
  if (!value) return '—';
  let h, m;
  try {
    if (value instanceof Date) {
      h = value.getHours(); m = value.getMinutes();
    } else if (typeof value === 'string' && value.includes('T')) {
      const d = new Date(value);
      h = d.getHours(); m = d.getMinutes();
    } else if (typeof value === 'string' && value.includes(':')) {
      [h, m] = value.split(':').map(Number);
    } else {
      return westernDigits(String(value));
    }
  } catch { return '—'; }
  if (isNaN(h) || isNaN(m)) return '—';
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12  = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${String(h12).padStart(2,'0')}:${String(m).padStart(2,'0')} ${ampm}`;
}

// ─── Date ─────────────────────────────────────────────────────────────────────
/** Any date → "YYYY-MM-DD" */
export function fmtDate(value) {
  if (!value) return '—';
  try {
    if (value instanceof Date) return value.toISOString().split('T')[0];
    const s = String(value);
    return s.includes('T') ? s.split('T')[0] : s.split('T')[0];
  } catch { return '—'; }
}

/** Full datetime → "2026-06-03  08:00 AM" */
export function fmtDateTime(value) {
  if (!value) return '—';
  return `${fmtDate(value)}  ${fmtTime(value)}`;
}

// ─── Integers ─────────────────────────────────────────────────────────────────
/** 12500 → "12,500" | 0 / null → "—" */
export function fmtInt(n) {
  return _fmt(n, 0) ?? '—';
}

/** 12500 → "12,500" | 0 → "0" (always shows) */
export function fmtIntZero(n) {
  return _fmt(n, 0, true) ?? '0';
}

// ─── Decimals ─────────────────────────────────────────────────────────────────
/** 8.5 → "8.50" | 0 / null → "—" */
export function fmtDec(n, decimals = 2) {
  if (n == null || Number(n) === 0) return '—';
  return _fmt(n, decimals) ?? '—';
}

// ─── Money / Currency ─────────────────────────────────────────────────────────
/**
 * Integer-only money (no fractions anywhere in payroll, by request).
 * 12500.75  → "12,501"
 * 3000.00   → "3,000"
 * 0         → "0"
 * null      → "—"
 * Rounds with Math.round, always Western digits, thousands separators.
 */
export function fmtMoney(n) {
  if (n == null) return '—';
  const num = Number(n);
  if (isNaN(num)) return '—';
  return _fmt(Math.round(num), 0, true) ?? '0';
}

/**
 * displayNetSalary — the ONE presentation-layer implementation of "displayed
 * Net Salary" (EF-019.1). EF-019 proved computePayroll()'s `netSalary` is
 * mathematically exact and identical everywhere it's returned (Payroll API,
 * /final-sheet API); the only divergence found was screens independently
 * re-deriving a display value from separately-rounded sub-components (basic/
 * OT/deductions/advances, or an itemized late/early/absence/condition/manual
 * breakdown) — each screen picked a different set of components, so the
 * accumulated rounding remainder differed between screens by ±1 on a small
 * number of rows. The fix is not a different formula; it's rounding the
 * SAME already-correct number exactly once, in exactly one place. Every
 * consumer (Payroll Grid, Salary Card, Final Salary Modal, Compact Salary
 * Sheet, Print Preview, PDF, Excel) must call this on the raw `netSalary`
 * field from the API — never recompute it from components.
 */
export function displayNetSalary(netSalary) {
  return Math.round(Number(netSalary) || 0);
}

/**
 * Compact money — no decimals unless necessary.
 * 12500.00 → "12,500"  |  12500.54 → "12,500.54"
 */
export function fmtMoneyCompact(n) {
  if (n == null) return '—';
  const num = Number(n);
  if (isNaN(num)) return '—';
  const d = num % 1 === 0 ? 0 : 2;
  return _fmt(n, d, true) ?? '—';
}

// ═══════════════════════════════════════════════════════════════════════════
//  GLOBAL TIME SYSTEM  —  HR/accounting users think in hours & minutes,
//  never raw minute counts. Store minutes internally, show HH:mm / "Xس Yد".
// ═══════════════════════════════════════════════════════════════════════════

/**
 * minutes → "HH:mm" clock-style string (Western digits).
 *   561 → "09:21"   |   135 → "02:15"   |   0 → "00:00"
 * Use for clock-of-day values. Pass {dash:true} to render 0/empty as "—".
 */
export function minutesToTime(minutes, { dash = false } = {}) {
  const m = Number(minutes);
  if (isNaN(m) || (dash && m === 0)) return dash ? '—' : '00:00';
  const sign = m < 0 ? '-' : '';
  const abs  = Math.abs(Math.round(m));
  const h    = Math.floor(abs / 60);
  const mm   = abs % 60;
  return westernDigits(`${sign}${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
}

/**
 * Flexible parser → integer minutes. Accepts what HR users actually type:
 *   "2:30" → 150 | "09:15" → 555 | "1h 20m" → 80 | "2h" → 120 | "45m" → 45
 *   "1 ساعة 30 دقيقة" → 90 | "90" → 90 | 90 → 90
 * Returns null when it can't parse anything meaningful.
 */
export function timeToMinutes(input) {
  if (input == null || input === '') return null;
  if (typeof input === 'number') return Math.round(input);
  let s = westernDigits(String(input).trim().toLowerCase());
  if (!s) return null;

  // "HH:mm" clock form
  if (s.includes(':')) {
    const [h, m] = s.split(':');
    const hh = parseInt(h, 10) || 0;
    const mm = parseInt(m, 10) || 0;
    return hh * 60 + mm;
  }

  // "1h 20m" / "2h" / "45m" / Arabic "ساعة"/"دقيقة"
  const hMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours|س|ساعة|ساعات)/);
  const mMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes|د|دقيقة|دقائق)/);
  if (hMatch || mMatch) {
    const h = hMatch ? parseFloat(hMatch[1]) : 0;
    const m = mMatch ? parseFloat(mMatch[1]) : 0;
    return Math.round(h * 60 + m);
  }

  // Bare number → treat as minutes
  const n = parseFloat(s);
  return isNaN(n) ? null : Math.round(n);
}

/**
 * ★ THE canonical duration formatter — minutes → "HH:mm" (zero-padded, Western
 *   digits). One shared implementation used EVERYWHERE durations are displayed
 *   (attendance, payroll OT, late, early leave, working hours, movement, policy
 *   simulator, rules previews, summary cards, grid cells, reports).
 *     150 → "02:30"   |   15 → "00:15"   |   770 → "12:50"   |   5 → "00:05"
 *     0  → "00:00"    |  -90 → "-01:30"
 */
export function minutesToHHMM(minutes = 0) {
  const m = Number(minutes);
  if (isNaN(m)) return '00:00';
  const sign = m < 0 ? '-' : '';
  const abs  = Math.abs(Math.round(m));
  const h    = Math.floor(abs / 60);
  const mm   = abs % 60;
  return westernDigits(`${sign}${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
}

/**
 * minutes → "HH:mm" duration. The canonical way to show ANY elapsed-time field.
 *   135 → "02:15"  |  60 → "01:00"  |  45 → "00:45"  |  0/null → "—"
 * Pass {zero:'00:00'} to render empty values as a real clock instead of a dash.
 */
export function formatDuration(minutes, { zero = '—' } = {}) {
  const m = Number(minutes);
  if (isNaN(m) || m === 0) return zero;
  return minutesToHHMM(m);
}

/** hours (float) → "HH:mm" duration. For OT / worked-hours columns. 8.5 → "08:30". */
export function formatHours(hours, opts) {
  const h = Number(hours);
  if (isNaN(h) || h === 0) return opts?.zero ?? '—';
  return formatDuration(Math.round(h * 60), opts);
}

// ─── Units (legacy names kept; now route through the time system) ─────────────
/** worked minutes → "HH:mm" duration, e.g. 480 → "08:00". */
export function fmtWorkedHours(minutes) {
  return formatDuration(minutes);
}

/** OT hours (float) → "HH:mm" duration, e.g. 1.5 → "01:30". */
export function fmtOTHours(n) {
  return formatHours(n);
}

/** late / early-leave minutes → "HH:mm" duration, e.g. 35 → "00:35". */
export function fmtMinutes(n) {
  return formatDuration(n);
}

/**
 * Deduction Hours — canonical display for late/early-leave/penalty deductions.
 * 1 unit = 1 deduction hour = 1 hour salary deducted.
 *   1   → "1 ساعة"   |  5   → "5 ساعات"
 *   0.5 → "0.5 ساعة" |  0/null → "—"
 */
export function fmtPenaltyUnits(n) {
  const v = Number(n);
  if (isNaN(v) || v === 0) return '—';
  const display = Number.isInteger(v) ? westernDigits(String(v)) : westernDigits(v.toFixed(1));
  const label = v === 1 ? 'ساعة' : v <= 2 ? 'ساعتان' : 'ساعات';
  return `${display} ${label}`;
}

/**
 * Policy Engine / manual overtime units → "+N إضافي" (canonical overtime display).
 *   1 → "+1 إضافي"  |  2.5 → "+2.5 إضافي"  |  0/null → "—"
 * Mirrors AttendanceDaily.effectiveOvertimeUnits directly — no UI-side recalculation.
 */
export function fmtOvertimeUnits(n) {
  const v = Number(n);
  if (isNaN(v) || v === 0) return '—';
  const display = Number.isInteger(v) ? v : westernDigits(v.toFixed(1));
  return `+${display} إضافي`;
}

// ─── Editable numeric cell display (Presentation Layer only) ────────────────
// Wraps any existing formatter so an EDITABLE numeric grid cell shows "0"
// only for null/undefined/'' (a genuinely EMPTY value). A real numeric 0 is
// NOT empty — it is passed through to the original formatter unchanged, so
// columns whose existing formatter already renders 0 as "—" (by design)
// keep doing exactly that; only the missing-value case changes. Purely
// additive: never touches the wrapped formatter itself — reports, print,
// CSV and Excel export keep calling fmtPenaltyUnits/fmtOvertimeUnits/etc.
// directly and are byte-for-byte unaffected.
export function fmtEditableZero(value, formatterFn) {
  if (value === null || value === undefined || value === '') return '0';
  return formatterFn(value);
}

/** 0.87 → "87%" (fraction) */
export function fmtPercent(n, decimals = 0) {
  if (n == null) return '—';
  return `${_fmt(Number(n) * 100, decimals) ?? '0'}%`;
}

// ─── Manual-override tooltip (EF-018) ────────────────────────────────────────
// One shared builder for the tooltip shown on any manually-overridden grid
// value — no badge/dot/pill, the value's text color is the only indicator;
// this is the explanation surfaced on hover.
export function manualOverrideTooltip(by, at) {
  const lines = ['تم تعديل هذه القيمة يدوياً'];
  if (by) lines.push(`• Modified By: ${by}`);
  if (at) {
    const d = new Date(at);
    if (!isNaN(d)) lines.push(`• Modified At: ${d.toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' })}`);
  }
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
//  UNIFIED NAMED FORMATTERS  —  the canonical API for all ERP tables/forms.
//  (Thin, stable aliases over the battle-tested implementations above.)
// ═══════════════════════════════════════════════════════════════════════════
export const formatTime    = fmtTime;                       // clock "08:00 AM"
export const formatMoney   = fmtMoney;                      // accounting "12,500"
export const formatNumber  = (n) => fmtIntZero(n);          // "1,234"
export const formatPercent = (n, d = 0) =>                  // 25 → "25%", 0.25? pass fraction*100
  n == null ? '—' : `${_fmt(Number(n), d) ?? '0'}%`;

// ─── Status labels (Arabic text + theme-aware colors via CSS variables) ──────────
// Colors resolve to --status-* CSS vars defined per theme in index.css:
//   Dark: bright/saturated (readable on dark row backgrounds)
//   Light: darker/deeper (WCAG AA on white — min 4.5:1 contrast)
export const STATUS_LABELS = {
  present:     { ar: 'حاضر',          color: 'var(--status-present)',        bg: 'var(--status-present-bg)'        },
  late:        { ar: 'متأخر',          color: 'var(--status-late)',           bg: 'var(--status-late-bg)'           },
  absent:      { ar: 'غائب',           color: 'var(--status-absent)',         bg: 'var(--status-absent-bg)'         },
  early_leave: { ar: 'انصراف مبكر',   color: 'var(--status-early-leave)',    bg: 'var(--status-early-leave-bg)'    },
  // half_day removed 2026-06-22 — no longer produced by the attendance engine
  weekend:     { ar: 'إجازة أسبوعية', color: 'var(--status-weekend)',        bg: 'var(--status-weekend-bg)'        },
  holiday:     { ar: 'عطلة رسمية',    color: 'var(--status-holiday)',        bg: 'var(--status-holiday-bg)'        },
};
