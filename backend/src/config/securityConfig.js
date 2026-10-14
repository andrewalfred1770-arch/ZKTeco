/**
 * securityConfig.js — the ONE place that decides (a) whether authentication is enabled and
 * (b) which network interface the backend may listen on.
 *
 * Policy (Phase 25.1 F2, restored):
 *   - AUTH_ENABLED is true ONLY for the value "true" (case-insensitive, surrounding whitespace /
 *     quotes ignored). "false" and an unset variable mean disabled (the single-machine desktop
 *     default). Any OTHER value is "invalid": it is treated as disabled — never as enabled — and
 *     reported loudly, so a typo can never open a LAN-reachable API (see the bind rules below).
 *   - Authentication DISABLED  → the API may only listen on loopback. HOST unset → 127.0.0.1.
 *     An explicit non-loopback HOST (0.0.0.0, a LAN address, a hostname…) is REFUSED at startup.
 *   - Authentication ENABLED   → LAN deployment as before: HOST unset → 0.0.0.0, or any explicit HOST.
 *     (middleware/auth.js additionally refuses to start without a real JWT_SECRET.)
 *
 * Pure functions, no I/O, no side effects — unit-testable and shared by index.js, middleware/auth.js
 * and routes/auth.js. frontend/electron/backend.js carries a small mirror of parseAuthEnabled();
 * a scratch parity test compares the two against the real dotenv parser.
 */

const LOOPBACK_DEFAULT = '127.0.0.1';
const LAN_DEFAULT = '0.0.0.0';

/** Strip one pair of matching surrounding quotes, then trim. */
function unquote(raw) {
  const s = String(raw).trim();
  const m = s.match(/^(["'])(.*)\1$/);
  return (m ? m[2] : s).trim();
}

/**
 * @param {*} raw  process.env.AUTH_ENABLED (or any value)
 * @returns {{enabled:boolean, status:'enabled'|'disabled'|'unset'|'invalid', raw:string}}
 */
function parseAuthEnabled(raw) {
  if (raw === undefined || raw === null) return { enabled: false, status: 'unset', raw: '' };
  const v = unquote(raw).toLowerCase();
  if (v === '') return { enabled: false, status: 'unset', raw: '' };
  if (v === 'true') return { enabled: true, status: 'enabled', raw: v };
  if (v === 'false') return { enabled: false, status: 'disabled', raw: v };
  return { enabled: false, status: 'invalid', raw: v.slice(0, 24) };
}

/** True only for addresses that cannot be reached from another machine. */
function isLoopbackHost(host) {
  if (host === undefined || host === null) return false;
  let h = unquote(host).toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (h.startsWith('::ffff:')) h = h.slice(7);                 // IPv4-mapped IPv6
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  return o.every((n) => n >= 0 && n <= 255) && o[0] === 127;
}

/**
 * Decide the bind address.
 * @param {{authEnabled:boolean, authStatus?:string, authRaw?:string, host?:string}} cfg
 * @returns {{ok:boolean, host:string|null, exposure:'loopback'|'network', warnings:string[], error:{code:string,message:string}|null}}
 */
function resolveSecureHost({ authEnabled, authStatus, authRaw, host } = {}) {
  const requested = host === undefined || host === null ? '' : unquote(host);
  const warnings = [];

  if (authStatus === 'invalid') {
    warnings.push(
      `[SECURITY] AUTH_ENABLED="${authRaw}" is not a recognized value (use true or false). ` +
      'It is being treated as FALSE: authentication is OFF and the API is restricted to this machine.',
    );
  }

  if (authEnabled) {
    // Intended LAN deployment: explicit host honoured, default stays LAN-reachable.
    return { ok: true, host: requested || LAN_DEFAULT, exposure: isLoopbackHost(requested || LAN_DEFAULT) ? 'loopback' : 'network', warnings, error: null };
  }

  if (requested && !isLoopbackHost(requested)) {
    return {
      ok: false, host: null, exposure: 'network', warnings,
      error: {
        code: 'UNSAFE_BIND',
        message:
          `[SECURITY] Refusing to start: authentication is DISABLED (AUTH_ENABLED=${authStatus === 'unset' ? 'unset' : authRaw || 'false'}) ` +
          `but HOST="${requested}" would expose the whole API (employees, attendance, payroll) to the network with no login. ` +
          'Fix ONE of: (1) single-machine use — remove HOST or set HOST=127.0.0.1; ' +
          '(2) LAN/server use — set AUTH_ENABLED=true and a real JWT_SECRET in the .env file, then create user accounts.',
      },
    };
  }

  warnings.push(
    '[SECURITY] Authentication is DISABLED (AUTH_ENABLED is not "true"): every API request is accepted without a login. ' +
    `The API is therefore bound to loopback only (${requested || LOOPBACK_DEFAULT}) and is reachable from this machine only; ` +
    'LAN / Manager clients cannot connect. To serve LAN clients set AUTH_ENABLED=true and a real JWT_SECRET in the .env file.',
  );
  return { ok: true, host: requested || LOOPBACK_DEFAULT, exposure: 'loopback', warnings, error: null };
}

module.exports = { parseAuthEnabled, isLoopbackHost, resolveSecureHost, LOOPBACK_DEFAULT, LAN_DEFAULT };
