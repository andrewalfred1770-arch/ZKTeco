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
 *
 * Two defenses against blank thumbnails (see PrintPreviewModal's height
 * effect for the full root-cause writeup):
 *   1. `ready` — the parent only flips this true once the source document's
 *      images have finished loading and layout has settled, so we never
 *      render thumbnails against a too-early, too-short measurement.
 *   2. Per-page bounds check below — even with `ready`, a page whose slice
 *      starts at/after the real measured content height is skipped rather
 *      than rendered as blank white.
 */
import React from 'react';

const THUMB_W = 120;

// Chromium will not reliably paint an <iframe> that is scaled down from the
// OUTSIDE (a `transform:scale()` on the iframe element itself) once the
// scale factor is this extreme (~0.11 for a 120px-wide thumbnail of a
// ~1000px page) and the iframe's own layout height is large (a full
// multi-row report, thousands of px tall): the frame silently painted
// blank white in testing even though its contentDocument had real, fully
// laid-out content (table rows present at the expected coordinates,
// fonts/images loaded) — moving/scrolling/observing did not help, so this
// isn't a one-off timing race, it reproduces every time at this scale.
// Fix: do the scale+crop INSIDE the iframe's own document instead (a
// `transform` on its `<body>`, injected into the srcDoc) and size the
// <iframe> element itself at the final small thumbnail dimensions with no
// external transform at all — ordinary same-size iframe rendering, which
// Chromium paints reliably regardless of how small the thumbnail is.
// Thumbnails are ~120px wide — the embedded @font-face rules (Cairo + IBM
// Plex, base64 woff2, several hundred KB) buy pixel-perfect glyph shaping
// that's invisible at this scale, but each thumbnail iframe is its own
// browsing context so it has to independently parse and decode that whole
// payload. With up to MAX_RENDERED thumbnails rendered at once, that's real
// duplicated CPU/memory for a decorative nav strip. Stripping @font-face
// from the thumbnail's own copy only (never from the shared previewHTML
// used by the actual preview pane, browser print, and PDF export) falls
// back to a generic sans-serif for the tiny thumbnail text — layout,
// columns, and colors (the whole point of a "film-strip" thumbnail) are
// unaffected.
const FONT_FACE_RE = /@font-face\s*\{[^}]*\}/g;

function buildThumbSrcDoc(previewHTML, pageWidthPx, pageHeightPx, thumbScale, pageIndex) {
  const translateY = -(pageIndex - 1) * pageHeightPx;
  const style = `<style>
html,body{margin:0!important;padding:0!important;overflow:hidden!important;}
body{width:${pageWidthPx}px;transform:scale(${thumbScale}) translateY(${translateY}px);transform-origin:top right;}
</style>`;
  const lightweightHTML = previewHTML.replace(FONT_FACE_RE, '');
  const headCloseIdx = lightweightHTML.indexOf('</head>');
  return headCloseIdx === -1
    ? lightweightHTML
    : lightweightHTML.slice(0, headCloseIdx) + style + lightweightHTML.slice(headCloseIdx);
}

export default function PrintThumbnails({ previewHTML, pageWidthPx, pageHeightPx, contentHeightPx, pageCount, currentPage, ready, onNavigate }) {
  const thumbScale = pageWidthPx > 0 ? THUMB_W / pageWidthPx : 1;
  const thumbH = Math.round(pageHeightPx * thumbScale);

  // Cap real thumbnails rendered — a few extra offscreen iframes are cheap,
  // dozens are not (each does a full layout pass of the whole document).
  const MAX_RENDERED = 12;
  // Only pages whose slice actually starts before the real measured content
  // ends are real pages — this is what keeps the thumbnail count matching
  // the true document length even if the height/pageCount estimate ever
  // drifts by a fraction of a row.
  const pages = ready
    ? Array.from({ length: pageCount }, (_, i) => i + 1)
        .filter(p => (p - 1) * pageHeightPx < contentHeightPx)
    : [];

  if (!ready) {
    return (
      <div style={{ width: 148, flexShrink: 0, borderInlineStart: '1px solid var(--border)', background: 'var(--surface)', overflowY: 'auto', padding: '14px 14px' }}>
        <p style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 12 }}>
          الصفحات
        </p>
        <p style={{ fontSize: 11, color: 'var(--text-3)' }}>جاري التحضير...</p>
      </div>
    );
  }

  return (
    <div style={{ width: 148, flexShrink: 0, borderInlineStart: '1px solid var(--border)', background: 'var(--surface)', overflowY: 'auto', padding: '14px 14px' }}>
      <p style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 12 }}>
        الصفحات {pages.length > 1 ? `(${pages.length})` : ''}
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
                  <iframe title={`thumb-${p}`} srcDoc={buildThumbSrcDoc(previewHTML, pageWidthPx, pageHeightPx, thumbScale, p)} scrolling="no" tabIndex={-1}
                    style={{
                      position: 'absolute', top: 0, insetInlineEnd: 0, border: 'none', pointerEvents: 'none',
                      width: THUMB_W, height: thumbH,
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
