import { useMemo } from 'react';
import useCompanySettingsStore, { resolveCompanyAssetUrl } from '../store/companySettingsStore';

/**
 * PETSHROW — Central Branding (DEFAULT / fallback values)
 * The live, user-editable source of truth is the "بيانات الشركة" Company
 * Settings store (see `useCompanyBrand` below) — these constants are only
 * the seed values / safety fallback shown before the first fetch resolves
 * or for any field the user has left empty.
 */
export const BRAND = {
  // Primary mark
  name:        'PETSHROW',
  mark:        'P',                 // monogram for the logo tile
  company:     'PETSHROW',          // shown as company name on every report
  product:     'PETSHROW ERP',
  productAr:   'PETSHROW — نظام تخطيط موارد المؤسسات',

  // Taglines
  tagline:     'إدارة الموارد البشرية والرواتب',
  taglineEn:   'Enterprise Resource Planning',
  module:      'الحضور والرواتب',

  // Meta
  version:     '1.2.2',
  buildMarker: 'BUILD: 2026-08-17-release-1.2.2-version-bump',
  copyright:   `© ${new Date().getFullYear()} PETSHROW ERP`,

  // Brand colors (kept in sync with the enterprise palette in index.css)
  primary:     '#2563eb',
  primaryDark: '#1d4ed8',
  ink:         '#0b1a35',
};

/** Filename-safe brand prefix for exported files (CSV/PDF/Excel). */
export const FILE_PREFIX = 'PETSHROW';

/**
 * useCompanyBrand — the live brand object every screen should read from.
 * Merges the runtime "بيانات الشركة" settings (Sidebar/Header/Login/Reports/
 * Print/PDF/Payroll/Attendance — everything) over the static BRAND defaults,
 * so the UI never flashes blank and never breaks on an empty field.
 *
 * `logoUrl`/`stampUrl`/`loginBackgroundUrl`/`printHeaderUrl` are absolute,
 * loadable URLs (or '' when no image has been uploaded — render the `mark`
 * monogram as a fallback in that case).
 */
export function useCompanyBrand() {
  const settings   = useCompanySettingsStore((s) => s.settings);
  const fetchError = useCompanySettingsStore((s) => s.fetchError);

  return useMemo(() => {
    const s = settings || {};
    const nameAr = s.company_name_ar || BRAND.name;
    return {
      name:        nameAr,
      nameAr,
      nameEn:      s.company_name_en || BRAND.name,
      mark:        BRAND.mark,
      company:     nameAr,
      product:     BRAND.product,
      productAr:   BRAND.productAr,
      description: s.company_description || BRAND.tagline,
      tagline:     s.company_description || BRAND.tagline,
      taglineEn:   BRAND.taglineEn,
      module:      BRAND.module,
      address:     s.company_address || '',
      phone:       s.company_phone || '',
      email:       s.company_email || '',
      version:     BRAND.version,
      buildMarker: BRAND.buildMarker,
      copyright:   `© ${new Date().getFullYear()} ${nameAr}`,
      primary:     BRAND.primary,
      primaryDark: BRAND.primaryDark,
      ink:         BRAND.ink,

      logoUrl:            resolveCompanyAssetUrl(s.logo_url),
      loginBackgroundUrl: resolveCompanyAssetUrl(s.login_background_url),
      stampUrl:           resolveCompanyAssetUrl(s.stamp_url),
      printHeaderUrl:     resolveCompanyAssetUrl(s.print_header_url),
      printHeaderText:    s.print_header_text || '',
      // Optional, like printHeaderText above — an unset footer text must not
      // silently inject a copyright line into every printed document's
      // footer (nothing else in the app currently reads this field, so there
      // is no other consumer relying on the BRAND.copyright fallback).
      printFooterText:    s.print_footer_text || '',
      printContactText:   s.print_contact_text || [s.company_address, s.company_phone, s.company_email].filter(Boolean).join(' · '),
      fetchError,
    };
  }, [settings, fetchError]);
}

export default BRAND;
