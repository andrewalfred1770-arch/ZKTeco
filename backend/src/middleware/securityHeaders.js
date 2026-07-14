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
 */
module.exports = function securityHeaders(_req, res, next) {
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
  // Remove Express fingerprint
  res.removeHeader('X-Powered-By');
  next();
};
