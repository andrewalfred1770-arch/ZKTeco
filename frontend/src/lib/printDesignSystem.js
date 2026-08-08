/**
 * printDesignSystem.js — PETSHROW ERP single source of truth for print/PDF
 * visual tokens and page geometry.
 *
 * Every printable surface (table reports via reportTemplate.js, the Print
 * Preview workspace, and the payslip documents — SalaryCard/CompactSalarySheet
 * via FinalSalaryModal) reads its colors/spacing/radius/shadow/paper geometry
 * from here instead of hand-copying values, so "the same report design"
 * across the app is a structural guarantee, not a convention two files have
 * to independently remember to keep in sync.
 *
 * Values below are relocated, not redesigned — they are the exact palette
 * and geometry reportTemplate.js already shipped (its own header calls the
 * table-report design "v2.5, 10/10 target"). Nothing here changes what any
 * existing report looks like on its own; it only makes the tokens shared.
 */

// ── Color / ink / surface palette ───────────────────────────────────────────
export const COLORS = {
  p:   '#17325C',  // primary navy   – headings, borders, totals
  a:   '#2563EB',  // accent blue    – numeric highlights
  suc: '#16A34A',  // success        – present, positive
  wrn: '#F59E0B',  // warning        – late, attention
  dng: '#DC2626',  // danger         – absent, deductions
  pur: '#7C3AED',  // purple         – overtime, special

  bg:    '#FFFFFF',
  soft:  '#EAF2FF',  // period strip • table header • totals row
  softStrong: '#EEF5FF', // totals row fill — one step stronger than soft
  alt:   '#F8FAFC',  // alternating table row
  panel: '#F2F7FE',  // header info panel

  i1: '#1F2937',   // primary body text
  i2: '#374151',   // secondary text
  i3: '#6B7280',   // labels, captions, muted
  i4: '#9CA3AF',   // faint – row numbers, icons

  bd:   '#D8E2EE',  // outer border
  bd2:  '#C3D5E8',  // inner thead cell separator
  hair: '#D9E2EC',  // header hairline / divider
  cardBorder: '#E5E7EB',
  brandInk: '#0F274B',  // letterhead heading ink — reportTemplate.js's .dh-title/.dh-brand-name/.dh-meta-value
};

/** Same six accent colors as reportTemplate.js's `.dh-kpi.c-*` rules —
 *  exported so any React-rendered card (SalaryCard's Kpi, etc.) can pick the
 *  identical hex instead of re-deciding its own KPI palette. */
export const KPI_ACCENTS = {
  blue: '#2563EB', green: '#16A34A', red: '#DC2626',
  amber: '#F97316', purple: '#7C3AED', teal: '#0D9488',
};

// ── Spacing scale (4 · 8 · 12 · 16 · 20 · 24 · 32) ──────────────────────────
export const SPACING = {
  sp1: 4, sp2: 8, sp3: 12, sp4: 10, sp5: 14, sp6: 24, sp7: 32,
  rhythm: 9, // gap between the 4 letterhead sections
};

// ── Component tokens ─────────────────────────────────────────────────────────
export const RADIUS = { card: 12, kpi: 8, meta: 10, chip: 6 };
export const SHADOW = {
  card: '0 2px 4px rgba(15,39,75,0.07), 0 1px 2px rgba(15,39,75,0.05)',
};
export const TABLE_RHYTHM = {
  ch: 10,  // cell horizontal padding
  cv: 8,   // cell vertical padding
  rh: 38,  // body row min-height
  thh: 52, // thead row height
};

/** The exact :root token block reportTemplate.js's <style> already emits —
 *  relocated here so it is generated in exactly one place. */
export function tokensCSS() {
  return `:root{
  --p:${COLORS.p};--a:${COLORS.a};--suc:${COLORS.suc};--wrn:${COLORS.wrn};--dng:${COLORS.dng};--pur:${COLORS.pur};
  --bg:${COLORS.bg};--soft:${COLORS.soft};--alt:${COLORS.alt};--panel:${COLORS.panel};
  --i1:${COLORS.i1};--i2:${COLORS.i2};--i3:${COLORS.i3};--i4:${COLORS.i4};
  --bd:${COLORS.bd};--bd2:${COLORS.bd2};
  --sp1:${SPACING.sp1}px;--sp2:${SPACING.sp2}px;--sp3:${SPACING.sp3}px;--sp4:${SPACING.sp4}px;--sp5:${SPACING.sp5}px;--sp6:${SPACING.sp6}px;--sp7:${SPACING.sp7}px;
  --sg:var(--sp4);--bw:1px;
  --ch:${TABLE_RHYTHM.ch}px;--cv:${TABLE_RHYTHM.cv}px;--rh:${TABLE_RHYTHM.rh}px;--thh:${TABLE_RHYTHM.thh}px;
}
:root{
  --hair:${COLORS.hair};--card-bd:${COLORS.cardBorder};--card-shadow:${SHADOW.card};
  --rhythm:${SPACING.rhythm}px;--soft-strong:${COLORS.softStrong};
}`;
}

// ── Paper geometry ───────────────────────────────────────────────────────────
// One definition per paper size: the CSS `size` keyword Chromium understands
// natively, and its real mm dimensions (portrait) — used by reportTemplate.js
// for the @page rule and by PrintPreviewModal.jsx for the on-screen page box.
export const PAPER_SIZES = {
  A4:     { keyword: 'A4',     mm: { w: 210,   h: 297 } },
  Letter: { keyword: 'letter', mm: { w: 215.9, h: 279.4 } },
  Legal:  { keyword: 'legal',  mm: { w: 215.9, h: 355.6 } },
};
export const PAPER_SIZE_KEYWORDS = Object.fromEntries(
  Object.entries(PAPER_SIZES).map(([k, v]) => [k, v.keyword])
);
export const PAPER_MM = Object.fromEntries(
  Object.entries(PAPER_SIZES).map(([k, v]) => [k, v.mm])
);

// Print-time margin presets (mm). "normal" is the exact value every report
// shipped with before print-experience settings existed.
export const MARGIN_PRESETS = {
  normal: { v: 10, h: 8 },
  narrow: { v: 6,  h: 5 },
  wide:   { v: 16, h: 14 },
};

export const MM_TO_PX = 3.7795275591; // 96dpi

// ── Shared @page footer content ─────────────────────────────────────────────
/**
 * Builds the left-side @page footer string every printed document uses:
 * company identity + contact + optional custom footer text. Pagination
 * ("صفحة N من M") is a separate, unchanged @bottom-right rule in each
 * document — this only covers the identity/branding half.
 * `brand.printFooterText` (Company Settings → إعدادات الطباعة → نص تذييل
 * الطباعة) is appended when set — previously collected but never rendered
 * anywhere; this is the one place it now feeds every document's footer.
 */
export function buildFooterLeft(brand = {}, meta = {}) {
  const contact = meta.printContactText || brand.printContactText || '';
  const custom  = brand.printFooterText || '';
  return [brand.name, contact, custom].filter(Boolean).join('  ·  ');
}
