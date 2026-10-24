/**
 * corsPolicy.js — which browser Origins may call the API / Socket.IO.
 *
 * Two deployments, two policies (the mode is decided by AUTH_ENABLED, parsed once in middleware/auth.js):
 *   - Desktop (authentication OFF): the backend is bound to loopback only (config/securityConfig.js), so the only legitimate
 *     browser origins are loopback ones (dev-mode Electron / Vite on http://localhost:<port>). Private-LAN addresses,
 *     single-label names (SERVER-PC) and .local / .lan names are REJECTED: nothing on the network can reach this backend, and a
 *     page on such an origin must never be able to drive an unauthenticated API through the user's own browser.
 *   - LAN server (authentication ON): only the exact origins listed in CORS_ORIGINS (e.g. https://192.168.1.20:8443 behind the
 *     local TLS proxy). No pattern matching, no wildcard.
 * A request with NO Origin header (packaged Electron renderer, curl, health checks) is not a cross-origin browser request and
 * is passed through; authentication, not CORS, protects it. Forwarded headers (X-Forwarded-*, Forwarded, X-Original-Host) play no
 * role here: the decision uses only the Origin header value.
 *
 * Pure functions, no I/O — unit-testable (tests/consistency/cors-policy.test.js).
 */
'use strict';

const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

/** True for http(s)://localhost | 127.0.0.1 | [::1] with an optional port — and nothing else. */
function isLoopbackOrigin(origin) {
  return typeof origin === 'string' && LOOPBACK_ORIGIN.test(origin);
}

/**
 * Parse CORS_ORIGINS into exact, normalised origins. Entries that are not a bare http(s) origin
 * (wildcards, paths, queries, credentials, other schemes) are dropped and reported.
 * @returns {{origins:string[], rejected:string[]}}
 */
function parseCorsOrigins(raw) {
  const origins = [];
  const rejected = [];
  String(raw || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((entry) => {
    let u;
    try { u = new URL(entry); } catch { rejected.push(entry); return; }
    const bare = (u.protocol === 'http:' || u.protocol === 'https:') && !entry.includes('*') &&
      !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash && !/\/$/.test(entry);
    if (!bare) { rejected.push(entry); return; }
    if (!origins.includes(u.origin)) origins.push(u.origin);
  });
  return { origins, rejected };
}

/**
 * @param {{authEnabled:boolean, allowList?:string[]}} cfg
 * @returns {(origin:string|undefined, cb:Function)=>void}  the `origin` option for cors() and socket.io
 */
function createCorsOriginCheck({ authEnabled, allowList = [], proxyNoLogin = false } = {}) {
  const deny = (origin) => Object.assign(new Error(`CORS: origin ${origin} not allowed`), { status: 403 });
  return function corsOriginCheck(origin, cb) {
    if (!origin) return cb(null, true);
    // LAN no-login mode (config/securityConfig.js#resolveLanClientPolicy → 'lan-nologin'): the page is served by this backend through the
    // local HTTPS proxy, so the exact CORS_ORIGINS entries are the only browser origins — never loopback/wildcards, never anything else.
    if (!authEnabled && proxyNoLogin) return allowList.includes(origin) ? cb(null, true) : cb(deny(origin));
    if (!authEnabled) return isLoopbackOrigin(origin) ? cb(null, true) : cb(deny(origin));
    return allowList.includes(origin) ? cb(null, true) : cb(deny(origin));
  };
}

module.exports = { isLoopbackOrigin, parseCorsOrigins, createCorsOriginCheck };
