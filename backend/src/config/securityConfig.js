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

/**
 * Reverse-proxy trust (Express "trust proxy"). The ONLY accepted value is the literal "loopback": the backend then believes
 * X-Forwarded-For / X-Forwarded-Proto ONLY when the TCP peer is itself on loopback (a TLS proxy on this same PC). Anything a
 * LAN client sends in those headers is ignored, because its peer address is not loopback.
 *   - unset / "" / "false" / "0" / "off"  -> off (default; every deployment today)
 *   - "loopback" + a loopback bind (HOST=127.0.0.1)  -> on
 *   - "loopback" + any other bind address -> REFUSED (the proxy could not be local, so the setting makes no sense)
 *   - any other value ("true", "1", an address list...) -> ignored with a warning: broad trust would let any client spoof its IP
 * @param {{raw:*, host:string}} cfg  raw = process.env.TRUST_PROXY, host = the address the backend will bind
 * @returns {{ok:boolean, value:false|'loopback', warnings:string[], error:{code:string,message:string}|null}}
 */
function resolveTrustProxy({ raw, host } = {}) {
  const warnings = [];
  if (raw === undefined || raw === null) return { ok: true, value: false, warnings, error: null };
  const v = unquote(raw).toLowerCase();
  if (v === '' || v === 'false' || v === '0' || v === 'off') return { ok: true, value: false, warnings, error: null };
  if (v === 'loopback') {
    if (!isLoopbackHost(host)) {
      return {
        ok: false, value: false, warnings,
        error: {
          code: 'UNSAFE_TRUST_PROXY',
          message: `[SECURITY] Refusing to start: TRUST_PROXY=loopback requires the backend to listen on loopback behind a local reverse proxy, but it would listen on "${host}". ` +
            'Set HOST=127.0.0.1 (proxy on this PC) or remove TRUST_PROXY.',
        },
      };
    }
    warnings.push('[SECURITY] TRUST_PROXY=loopback: client address and scheme are taken from X-Forwarded-* ONLY for requests arriving from a proxy on this PC (loopback).');
    return { ok: true, value: 'loopback', warnings, error: null };
  }
  warnings.push(`[SECURITY] TRUST_PROXY="${String(v).slice(0, 24)}" is not accepted (only "loopback"): proxy trust stays OFF.`);
  return { ok: true, value: false, warnings, error: null };
}

/* ── LAN "no login" mode (allowlisted devices behind the local HTTPS proxy) ───────────────────────────────────────────────────────────
 * The ONLY configuration in which this applies: authentication OFF + TRUST_PROXY=loopback + a loopback bind — i.e. a backend that sits
 * behind Caddy on this PC. The Windows desktop backend never has TRUST_PROXY, so it stays exactly as it was ('desktop'); a backend with
 * AUTH_ENABLED=true keeps its logins ('authenticated'). In 'lan-nologin' mode the backend fails closed: no allowlist file, an empty or
 * invalid list, no proxy key, or a scheduler-owning instance (SKIP_SCHEDULER!=true) means it refuses to start.
 */
const MAX_ALLOWED_CLIENTS = 64;
const LABEL_MAX = 40;

/** '::ffff:192.168.1.5' / '[::ffff:…]' / ' 192.168.1.5 ' → '192.168.1.5' (anything else is returned trimmed). */
function normalizeClientIp(raw) {
  let s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s.toLowerCase().startsWith('::ffff:')) s = s.slice(7);
  return s;
}

/** Exact dotted IPv4 (no leading zeros, 0-255). Returns the 4 octets or null. */
function parseStrictIPv4(s) {
  const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(String(s));
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/** A single LAN host address: RFC 1918, not a network (.0) or broadcast (.255) address. Loopback / link-local / public / 0.0.0.0 → false. */
function isApprovableLanIPv4(s) {
  const o = parseStrictIPv4(s);
  if (!o) return false;
  if (o[3] === 0 || o[3] === 255) return false;
  return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
}

/** The trusted network may never be broader than a /24 (256 addresses): a /16 or /8 would trust far more than one Wi-Fi network. */
const MIN_PREFIX = 24;

const ipv4ToInt = (o) => (((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0);
const prefixMask = (prefix) => (prefix === 0 ? 0 : ((0xFFFFFFFF << (32 - prefix)) >>> 0));
const isPrivateOctets = (o) => o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);

/**
 * One allowlist entry: `a.b.c.d` (a single host, = /32) or `a.b.c.d/nn` (a network). Strict on purpose:
 *   - RFC 1918 private addresses only (10/8, 172.16/12, 192.168/16); loopback, link-local, public, 0.0.0.0 are refused;
 *   - the prefix is a plain integer MIN_PREFIX..32 (a /16, /8 or /0 is refused, "/024" is refused);
 *   - a network must be written as its network address (192.168.1.0/24, not 192.168.1.5/24), so a typo can never silently widen it;
 *   - a /32 host cannot be a .0 or .255 address; hostnames, wildcards, ranges and IPv6 are not entries.
 * @returns {{ok:true, ip:string, prefix:number, base:number, mask:number, cidr:string, size:number} | {ok:false, error:string}}
 */
function parseAllowedEntry(body) {
  const m = /^([0-9.]+)(?:\/(0|[1-9]\d?))?$/.exec(String(body));
  if (!m) return { ok: false, error: 'is not an IPv4 address or an IPv4 network like 192.168.1.0/24' };
  const o = parseStrictIPv4(m[1]);
  if (!o) return { ok: false, error: 'is not a valid IPv4 address' };
  if (!isPrivateOctets(o)) return { ok: false, error: 'is not a private LAN address (10.x, 172.16-31.x, 192.168.x only)' };
  const prefix = m[2] === undefined ? 32 : Number(m[2]);
  if (prefix > 32) return { ok: false, error: 'has an impossible prefix length' };
  if (prefix < MIN_PREFIX) return { ok: false, error: `is broader than /${MIN_PREFIX} (the widest trusted network allowed)` };
  const n = ipv4ToInt(o); const mask = prefixMask(prefix); const base = (n & mask) >>> 0;
  if (prefix === 32) { if (o[3] === 0 || o[3] === 255) return { ok: false, error: 'is a network/broadcast address, not a host' }; }
  else if (base !== n) {
    const b = [(base >>> 24) & 255, (base >>> 16) & 255, (base >>> 8) & 255, base & 255].join('.');
    return { ok: false, error: `has host bits set - write the network address (${b}/${prefix})` };
  }
  return { ok: true, ip: m[1], prefix, base, mask, cidr: `${m[1]}/${prefix}`, size: 2 ** (32 - prefix) };
}

/**
 * Parse the allowed-clients file. One entry per line:  192.168.1.0/24   # Office Wi-Fi     or     192.168.1.50   # one phone
 * `#` starts a comment; the comment on an entry line is its label (≤40 chars of letters/digits/space/._-). Entries are single hosts or
 * networks no broader than /24 (see parseAllowedEntry); overlapping or duplicate entries are errors. Returns every problem (the caller
 * refuses to start on any).
 * @returns {{entries:{ip:string,prefix:number,base:number,mask:number,cidr:string,label:string}[], errors:string[]}}
 */
function parseAllowedClients(text) {
  const entries = []; const errors = [];
  // a leading UTF-8 byte-order mark (Notepad adds one) must not turn a valid first line into an error
  String(text === undefined || text === null ? '' : text).replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
    const no = i + 1;
    const hash = line.indexOf('#');
    const body = (hash === -1 ? line : line.slice(0, hash)).trim();
    if (!body) return;
    const label = hash === -1 ? '' : line.slice(hash + 1).trim();
    const e = parseAllowedEntry(body);
    if (!e.ok) { errors.push(`line ${no}: "${body.slice(0, 40)}" ${e.error}`); return; }
    if (label && (label.length > LABEL_MAX || !/^[\p{L}\p{N} ._-]+$/u.test(label))) { errors.push(`line ${no}: label must be at most ${LABEL_MAX} characters of letters, digits, space . _ -`); return; }
    const last = e.base + e.size - 1;
    const clash = entries.find((x) => e.base <= x.base + x.size - 1 && x.base <= last);
    if (clash) { errors.push(`line ${no}: ${e.cidr} overlaps ${clash.cidr} (list each network or host once)`); return; }
    entries.push({ ip: e.ip, prefix: e.prefix, base: e.base, mask: e.mask, size: e.size, cidr: e.cidr, label });
  });
  if (entries.length > MAX_ALLOWED_CLIENTS) errors.push(`more than ${MAX_ALLOWED_CLIENTS} entries`);
  return { entries, errors };
}

/** True when the dotted-quad `ip` lies inside the entry's network. */
function entryContains(entry, ip) {
  const o = parseStrictIPv4(ip);
  return !!o && (((ipv4ToInt(o) & entry.mask) >>> 0) === entry.base);
}

/** The proxy key is a long random token shared by Caddy (header_up) and this backend; never logged. */
function isValidProxyKey(k) { return typeof k === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(k); }

/**
 * @param {{authEnabled:boolean, trustProxyValue:false|'loopback', host:string, allowedText:string|null, allowedFileError?:string, proxyKey?:string, skipScheduler:boolean}} cfg
 * @returns {{ok:boolean, mode:'authenticated'|'desktop'|'lan-nologin', allowed:object[] (the parsed networks/hosts, see parseAllowedClients), proxyKey:string|null, warnings:string[], error:{code:string,message:string}|null}}
 */
function resolveLanClientPolicy({ authEnabled, trustProxyValue, host, allowedText, allowedFileError, proxyKey, skipScheduler } = {}) {
  const base = { allowed: [], proxyKey: null, warnings: [], error: null };
  if (authEnabled) return { ok: true, mode: 'authenticated', ...base };
  if (trustProxyValue !== 'loopback') return { ok: true, mode: 'desktop', ...base };
  const fail = (message) => ({ ok: false, mode: 'lan-nologin', ...base, error: { code: 'UNSAFE_LAN_NOLOGIN', message: `[SECURITY] Refusing to start (LAN no-login mode): ${message}` } });
  if (!isLoopbackHost(host)) return fail('the backend must listen on loopback behind the local HTTPS proxy.');
  if (!skipScheduler) return fail('SKIP_SCHEDULER=true is required (this instance must never own the ZKTeco devices).');
  if (!isValidProxyKey(proxyKey)) return fail('PROXY_SHARED_SECRET (32-128 chars of A-Z a-z 0-9 _ -) is missing or invalid.');
  if (allowedFileError) return fail(`the allowed-devices file cannot be read (${allowedFileError}).`);
  if (allowedText === null || allowedText === undefined) return fail('ALLOWED_CLIENT_IPS_FILE is not set.');
  const parsed = parseAllowedClients(allowedText);
  if (parsed.errors.length) return fail(`allowed-devices file is invalid: ${parsed.errors.slice(0, 3).join('; ')}.`);
  if (parsed.entries.length === 0) return fail('allowed-devices file lists no network or device (deny-by-default: nobody could connect).');
  const reach = parsed.entries.reduce((n, e) => n + e.size, 0);
  return {
    ok: true, mode: 'lan-nologin', allowed: parsed.entries, proxyKey, error: null,
    warnings: [`[SECURITY] LAN no-login mode: ${parsed.entries.length} allowlisted network(s)/device(s) (${parsed.entries.map((e) => e.cidr).join(', ')}, up to ${reach} addresses) have FULL access without a login; every other client is refused (proxy identity + address allowlist).`],
  };
}

module.exports = {
  parseAuthEnabled, isLoopbackHost, resolveSecureHost, resolveTrustProxy, LOOPBACK_DEFAULT, LAN_DEFAULT,
  normalizeClientIp, parseStrictIPv4, isApprovableLanIPv4, parseAllowedEntry, parseAllowedClients, entryContains, isValidProxyKey,
  resolveLanClientPolicy, MAX_ALLOWED_CLIENTS, MIN_PREFIX,
};
