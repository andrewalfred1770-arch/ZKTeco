// healthProbe.js - bounded GET probes for the Connection Settings "Test Connection" flow (and Server Mode's health check).
//
// Why this exists: Node's `http` module cannot open an https:// URL (it throws ERR_INVALID_PROTOCOL before any request is sent), so a
// server address such as https://192.168.1.145 (the LAN HTTPS proxy) always showed "cannot reach the server". The right transport is
// chosen from the URL scheme:
//   http://   -> Node `http` (unchanged behaviour)
//   https://  -> Electron's `net` module (Chromium network stack): FULL certificate verification against the Windows trust store.
//                A private CA must therefore be installed in Windows (Trusted Root) - the certificate is never waived: this module has no
//                switch that turns verification off, no handler that overrides a failed verification and no ignore-flag.
// Certificate problems are reported as a specific, readable error (untrusted CA / wrong name / expired) instead of a generic failure.
//
// This module has NO static dependency on `electron` (it is imported lazily by the default https requester), so it can be unit-tested
// with plain Node; `deps.httpGet` / `deps.httpsGet` let the tests inject the transports.
import http from 'http';

/** 'http' | 'https' | null for anything else (including unparsable values). */
export function pickClient(url) {
  try {
    const p = new URL(url).protocol;
    return p === 'http:' ? 'http' : p === 'https:' ? 'https' : null;
  } catch { return null; }
}

const TLS_RULES = [
  { code: 'CERT_UNTRUSTED', re: /ERR_CERT_AUTHORITY_INVALID|ERR_CERT_ROOT_NOT_TRUSTED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT/i,
    message: 'شهادة الخادم غير موثوقة على هذا الجهاز — ثبّت شهادة الـ CA الخاصة بالخادم في Windows (Trusted Root Certification Authorities) ثم أعد الاختبار' },
  { code: 'CERT_NAME_MISMATCH', re: /ERR_CERT_COMMON_NAME_INVALID|ERR_CERT_NAME_MISMATCH|ERR_TLS_CERT_ALTNAME_INVALID|ERR_CERT_AUTHORITY_INVALID.*NAME/i,
    message: 'شهادة الخادم لا تطابق العنوان المُدخل — استخدم نفس العنوان المكتوب في الشهادة' },
  { code: 'CERT_EXPIRED', re: /ERR_CERT_DATE_INVALID|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID/i,
    message: 'شهادة الخادم منتهية الصلاحية أو غير سارية بعد' },
  { code: 'CERT_REVOKED', re: /ERR_CERT_REVOKED|CERT_REVOKED/i, message: 'شهادة الخادم ملغاة' },
  { code: 'TLS_ERROR', re: /ERR_CERT_|ERR_SSL_|ERR_TLS|SSL routines|EPROTO|CERT_/i, message: 'تعذّر إنشاء اتصال TLS آمن مع الخادم' },
];

/** Maps a transport error to { errorCode, error, errorDetail }. Non-TLS errors keep their original message (as before). */
export function describeError(err) {
  const raw = [err && err.code, err && err.message].filter(Boolean).join(' ');
  for (const r of TLS_RULES) if (r.re.test(raw)) return { errorCode: r.code, error: r.message, errorDetail: (err && err.message) || String(err) };
  const msg = (err && err.message) || String(err || 'unknown error');
  return { errorCode: null, error: msg, errorDetail: msg };
}

// ── transports ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Node http GET -> { status, body }; rejects on socket errors and on timeout ('timeout'). */
export function nodeHttpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = http.get(url, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }).on('error', reject);
    } catch (e) { reject(e); return; }
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(Object.assign(new Error('timeout'), { code: 'PROBE_TIMEOUT' })); });
  });
}

/** Electron `net` (Chromium) GET -> { status, body }. Full TLS verification with the Windows trust store; nothing is overridden. */
export async function electronNetGet(url, timeoutMs) {
  const { net } = await import('electron');
  return new Promise((resolve, reject) => {
    let done = false; let req;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => { try { req && req.abort(); } catch { /* already finished */ } finish(reject, Object.assign(new Error('timeout'), { code: 'PROBE_TIMEOUT' })); }, timeoutMs);
    try {
      req = net.request({ method: 'GET', url });
      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => finish(resolve, { status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (e) => finish(reject, e));
      });
      req.on('error', (e) => finish(reject, e));
      req.end();
    } catch (e) { finish(reject, e); }
  });
}

function clientFor(url, deps) {
  const kind = pickClient(url);
  if (kind === 'http') return (deps && deps.httpGet) || nodeHttpGet;
  if (kind === 'https') return (deps && deps.httpsGet) || electronNetGet;
  return null;
}

// ── health ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** GET <baseUrl>/api/health. Never throws. Same result shape as before, plus errorCode / errorDetail for TLS problems. */
export async function fetchHealth(baseUrl, timeoutMs = 3000, deps) {
  const url = `${baseUrl}/api/health`;
  const get = clientFor(url, deps);
  if (!get) return { ok: false, status: null, body: null, error: 'Invalid server URL (http:// or https:// required)', errorCode: 'INVALID_URL' };
  try {
    const r = await get(url, timeoutMs);
    let body = null;
    try { body = JSON.parse(r.body); } catch { /* not JSON */ }
    if (body === null) return { ok: false, status: r.status, body: null };
    return { ok: r.status === 200, status: r.status, body };
  } catch (e) {
    const d = describeError(e);
    return { ok: false, status: null, body: null, error: d.error, errorCode: d.errorCode, errorDetail: d.errorDetail };
  }
}

// ── startup status ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** GET <baseUrl>/api/startup-status -> the parsed JSON, or null on ANY failure (bad URL, refused, timeout, certificate problem, non-JSON). Never throws. */
export async function fetchStartupStatus(baseUrl, timeoutMs = 400, deps) {
  const url = `${baseUrl}/api/startup-status`;
  const get = clientFor(url, deps);
  if (!get) return null;
  try {
    const r = await get(url, timeoutMs);
    try { return JSON.parse(r.body); } catch { return null; }
  } catch { return null; }
}

// ── Socket.IO reachability over https ───────────────────────────────────────────────────────────────────────────────────────
// socket.io-client (Node) would verify the certificate with Node's own CA bundle, NOT the Windows store, so it cannot be used for a
// private CA. For https the probe performs the Engine.IO polling handshake through the same verified transport instead: a 200 whose body
// is the Engine.IO "open" packet proves the Socket.IO endpoint answers through the proxy. Whether a login is required comes from the
// health answer (authEnabled), exactly the condition under which the socket middleware rejects an anonymous client.
const ENGINE_OPEN = /^\d*0\{[^]*"sid"\s*:/;

/** Resolves { status, detail } with the same status vocabulary as the Node socket probe. */
export async function probeSocketHandshake(baseUrl, timeoutMs = 8000, health = null, deps) {
  const url = `${baseUrl}/socket.io/?EIO=4&transport=polling`;
  const get = clientFor(url, deps);
  if (!get) return { status: 'network_error', detail: 'Invalid server URL (http:// or https:// required)' };
  try {
    const r = await get(url, timeoutMs);
    if (r.status === 200 && ENGINE_OPEN.test(r.body || '')) {
      return health && health.body && health.body.authEnabled === true
        ? { status: 'auth_required', detail: 'Socket.IO endpoint reachable; the server requires a login' }
        : { status: 'connected', detail: null };
    }
    if (r.status === 200) return { status: 'network_error', detail: 'unexpected response from the Socket.IO endpoint' };
    return { status: 'transport_error', detail: `HTTP ${r.status}` };
  } catch (e) {
    const d = describeError(e);
    if (d.error === 'timeout') return { status: 'timeout', detail: 'Socket.IO connection timed out' };
    if (/ECONNREFUSED|ERR_CONNECTION_REFUSED/i.test(d.errorDetail)) return { status: 'connection_refused', detail: 'connection refused' };
    return { status: 'transport_error', detail: d.error };
  }
}
