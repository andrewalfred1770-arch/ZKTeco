/**
 * securityHeaders.js
 *
 * Applies defensive HTTP headers on every response.
 * Safe to enable in all modes — adds no authentication requirement,
 * changes no business behaviour, and is invisible to clients that
 * don't inspect headers.
 *
 * References:
 *   OWASP Secure Headers Project
 *   https://owasp.org/www-project-secure-headers/
 *
 * F-14 — Content-Security-Policy and Strict-Transport-Security
 *
 * Deployment modes this has to coexist with:
 *   - Local desktop (Electron): the renderer is loaded from a file:// URL, so a
 *     response header from this server never governs it; it only governs what
 *     Express itself serves. The renderer talks to http://127.0.0.1:<port>.
 *   - LAN server / browser clients: the SPA is served by Express over plain HTTP
 *     (FRONTEND_DIST) and calls the API + Socket.IO on the same origin.
 *   - Vite dev: the page is served by Vite, not by this server.
 *
 * CSP — a policy the built React/Vite bundle satisfies as-is (module scripts from
 * the same origin, no eval, no inline <script>):
 *   - script-src 'self'               bundled JS only (no inline / eval)
 *   - style-src 'self' 'unsafe-inline' React `style={}` props and AG Grid inject inline styles
 *   - img/font-src 'self' data: blob:  uploaded logos, inlined assets, print thumbnails
 *   - connect-src 'self' ws: wss:      the API and Socket.IO (WebSocket) on this origin
 *   - frame-src 'self' blob: data: about:  print-preview iframes (srcDoc)
 *   - object-src 'none', base-uri 'self', form-action 'self', frame-ancestors 'none'
 * It deliberately does NOT use `upgrade-insecure-requests` (it would break the
 * plain-HTTP LAN deployment) and sets no Cross-Origin-Resource-Policy / COOP
 * (they would block the file:// renderer from loading uploaded images).
 * Set SECURITY_CSP=off to drop the CSP header without a code change.
 *
 * HSTS is emitted ONLY on a connection that is genuinely HTTPS (req.secure).
 * Sending it over plain HTTP is ignored by browsers at best and, behind a TLS
 * proxy that is later removed, would lock clients out — so the plain-HTTP LAN
 * deployment never receives it, and HTTPS is never forced.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-src 'self' blob: data: about:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const HSTS = 'max-age=15552000';   // 180 days, no includeSubDomains / preload

module.exports = function securityHeaders(req, res, next) {
  // Prevent MIME-type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Disallow framing (clickjacking mitigation)
  res.setHeader('X-Frame-Options', 'DENY');
  // Legacy XSS filter (belt-and-suspenders for older browsers)
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // Limit referrer information leakage
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Restrict browser feature access
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (String(process.env.SECURITY_CSP || '').toLowerCase() !== 'off') {
    res.setHeader('Content-Security-Policy', CSP);
  }
  if (req && req.secure === true) {
    res.setHeader('Strict-Transport-Security', HSTS);
  }
  // Remove Express fingerprint
  res.removeHeader('X-Powered-By');
  next();
};

module.exports.CSP = CSP;
