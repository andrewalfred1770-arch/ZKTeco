import React from 'react';
import { Inbox } from 'lucide-react';
import { useCompanyBrand } from '../lib/branding';

/**
 * EmptyState — the ONE shared "no data" panel for page-level empty screens
 * (an entire list/section with zero records — not per-cell inline text like
 * a single empty grid cell). Mirrors the visual language of the shared AG
 * Grid `overlayNoRowsTemplate` (gridDefaults.js) so every empty state in the
 * app — grid or plain page — reads as one consistent, quiet design instead
 * of each screen inventing its own wording/spacing.
 *
 * Brand-aware: falls back to the company's own logo/monogram when no
 * `icon` is given, so even a "no data yet" moment still feels like the
 * company's own system rather than a generic placeholder — without ever
 * being loud about it (same muted, small treatment as the grid overlay).
 *
 * @param {React.ComponentType} [icon]   lucide icon component (defaults to a
 *                                        muted inbox glyph, or the company
 *                                        logo/mark when uploaded)
 * @param {string}   title       primary message (e.g. "لا يوجد موظفون")
 * @param {string}   [subtitle]  secondary hint line
 * @param {React.ReactNode} [action]  optional button/link rendered below
 */
export default function EmptyState({ icon: Icon, title, subtitle, action }) {
  const brand = useCompanyBrand();

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      gap: 10, padding: '44px 20px', textAlign: 'center', color: 'var(--text-3)',
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: 11, flexShrink: 0, overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--surface-2)', border: '1px solid var(--border)',
      }}>
        {Icon
          ? <Icon style={{ width: 20, height: 20 }} />
          : brand.logoUrl
            ? <img src={brand.logoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', opacity: 0.6 }} />
            : <Inbox style={{ width: 20, height: 20 }} />}
      </div>
      <div>
        <p style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-2)' }}>{title}</p>
        {subtitle && <p style={{ fontSize: 11.5, marginTop: 3, opacity: 0.85 }}>{subtitle}</p>}
      </div>
      {action && <div style={{ marginTop: 4 }}>{action}</div>}
    </div>
  );
}
