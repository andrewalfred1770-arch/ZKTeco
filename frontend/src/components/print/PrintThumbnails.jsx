/**
 * PrintThumbnails — the right rail of the Print workspace.
 * Real per-page content, not generic placeholder tiles: each thumbnail is
 * the SAME rendered document in a small clipped iframe, scaled down and
 * shifted to that page's vertical slice (the standard "film-strip" CSS
 * technique) — so what you see is genuinely what that page contains.
 *
 * Page count is an ESTIMATE (measured content height ÷ computed printable
 * page height). Browsers don't expose real pagination for arbitrary HTML
 * without actually printing it, so a `page-break-inside:avoid` row near a
 * boundary can shift the real cut by a line or two — same caveat every
 * browser-based print preview has before the final render.
 */
import React from 'react';

const THUMB_W = 120;

export default function PrintThumbnails({ previewHTML, pageWidthPx, pageHeightPx, contentHeightPx, pageCount, currentPage, onNavigate }) {
  const thumbScale = pageWidthPx > 0 ? THUMB_W / pageWidthPx : 1;
  const thumbH = Math.round(pageHeightPx * thumbScale);
  const iframeH = Math.max(contentHeightPx, pageHeightPx * pageCount);

  // Cap real thumbnails rendered — a few extra offscreen iframes are cheap,
  // dozens are not (each does a full layout pass of the whole document).
  const MAX_RENDERED = 12;
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);

  return (
    <div style={{ width: 148, flexShrink: 0, borderInlineStart: '1px solid var(--border)', background: 'var(--surface)', overflowY: 'auto', padding: '14px 14px' }}>
      <p style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 12 }}>
        الصفحات {pageCount > 1 ? `(${pageCount})` : ''}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
        {pages.map(p => {
          const active = p === currentPage;
          return (
            <button key={p} onClick={() => onNavigate(p)} title={`صفحة ${p}`} style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
              background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, width: '100%',
            }}>
              <div style={{
                width: THUMB_W, height: thumbH, overflow: 'hidden', position: 'relative',
                background: '#fff', borderRadius: 2,
                border: active ? '2px solid var(--accent)' : '1px solid var(--border)',
                boxShadow: active ? '0 0 0 3px var(--accent-soft)' : '0 1px 3px rgba(0,0,0,0.12)',
              }}>
                {p <= MAX_RENDERED && previewHTML && (
                  <iframe title={`thumb-${p}`} srcDoc={previewHTML} scrolling="no" tabIndex={-1}
                    style={{
                      position: 'absolute', top: 0, insetInlineEnd: 0, border: 'none', pointerEvents: 'none',
                      width: pageWidthPx, height: iframeH,
                      transform: `scale(${thumbScale}) translateY(${-(p - 1) * pageHeightPx}px)`,
                      transformOrigin: 'top right',
                    }} />
                )}
              </div>
              <span style={{ fontSize: 10.5, fontWeight: active ? 800 : 500, color: active ? 'var(--accent)' : 'var(--text-3)' }}>{p}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
