/**
 * setupAuth.js — per-launch authorization of /api/setup/* (backend side). Counterpart: frontend/electron/setupAuth.js.
 *
 * The Electron main process generates a fresh 256-bit secret for every backend launch and writes it once to this process's stdin
 * ("setup-secret <value>"). It is kept in memory only: not in .env, not in any file, not in process.env, never logged, never returned.
 * A setup request must carry an HMAC-SHA256 (keyed with that secret) over timestamp + nonce + method + path + sha256(body):
 *   - a loopback peer, forged X-Forwarded-* / Host / proxy-key headers, or Caddy forwarding a LAN browser cannot produce it;
 *   - the secret itself never travels on the wire, so sniffing/replaying a captured request fails (timestamp window ±30 s and each
 *     nonce is accepted once; a captured request cannot be altered because the body and path are signed);
 *   - no secret configured (backend not started by Electron, stdin handoff not yet received, adopted stale process) => every
 *     request is refused (fail closed);
 *   - the MAC is compared with crypto.timingSafeEqual.
 * Every refusal is the same 403 with no detail (nothing says whether a secret exists, was wrong, expired or replayed).
 */
const crypto = require('crypto');

const HEADER_TS = 'x-checkin-setup-ts';
const HEADER_NONCE = 'x-checkin-setup-nonce';
const HEADER_MAC = 'x-checkin-setup-mac';
const WINDOW_MS = 30_000;
const NONCE_TTL_MS = 2 * WINDOW_MS + 5_000;
const MAX_NONCES = 2000;
const HANDOFF_PREFIX = 'setup-secret ';

let secret = null;
const seenNonces = new Map();   // nonce -> expiry

/** Set ONCE per process; later calls are ignored (a second value can never replace the launch secret). Returns true if it was set. */
function setLaunchSecret(value) {
  if (secret !== null) return false;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(value)) return false;
  secret = value;
  return true;
}
/** Truncated one-way tag proving to Electron that this process holds ITS secret (derivation mirrored in frontend/electron/setupAuth.js#ackTagFor). */
function ackTag() {
  return crypto.createHmac('sha256', secret).update('checkin-setup-handoff-ack-v1').digest('hex').slice(0, 32);
}
const defaultWrite = (line) => { try { process.stdout.write(line); } catch { /* no stdout: Electron then reports the hand-off as failed */ } };

/**
 * Handles one stdin line. Returns true if it was a hand-off line (consumed — callers must not log it).
 * A valid hand-off is acknowledged on stdout with the tag above; the SAME value repeated is acknowledged again (Electron retries within
 * a bound), a different value is ignored without any acknowledgement. The secret itself is never written anywhere.
 */
function handleStdinLine(line, write = defaultWrite) {
  if (typeof line !== 'string' || !line.startsWith(HANDOFF_PREFIX)) return false;
  const value = line.slice(HANDOFF_PREFIX.length).trim();
  const accepted = setLaunchSecret(value)
    || (secret !== null && value.length === secret.length && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(secret)));
  if (accepted) write('[Setup] HANDOFF_ACK ' + ackTag() + '\n');
  return true;
}
function isConfigured() { return secret !== null; }
function _resetForTests() { secret = null; seenNonces.clear(); }

const one = (v) => (typeof v === 'string' ? v : undefined);   // an array (repeated header) is not a valid value

/** Pure check. `r` = { method, path, bodyString, headers }; returns true only for a fresh, correctly keyed, never-seen request. */
function verifySetupRequest(r, now = Date.now()) {
  try {
    if (secret === null) return false;
    const h = r.headers || {};
    const ts = one(h[HEADER_TS]); const nonce = one(h[HEADER_NONCE]); const mac = one(h[HEADER_MAC]);
    if (!ts || !nonce || !mac) return false;
    if (!/^\d{10,15}$/.test(ts) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(mac)) return false;
    if (Math.abs(now - Number(ts)) > WINDOW_MS) return false;
    const bodyHash = crypto.createHash('sha256').update(r.bodyString).digest('hex');
    const msg = `${ts}\n${nonce}\n${String(r.method).toUpperCase()}\n${r.path}\n${bodyHash}`;
    const expected = crypto.createHmac('sha256', secret).update(msg).digest();
    const given = Buffer.from(mac, 'hex');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
    // Replay: only a request that PASSED the MAC consumes a nonce (an attacker cannot fill the cache with junk).
    for (const [n, exp] of seenNonces) if (exp <= now) seenNonces.delete(n);
    if (seenNonces.has(nonce) || seenNonces.size >= MAX_NONCES) return false;
    seenNonces.set(nonce, now + NONCE_TTL_MS);
    return true;
  } catch { return false; }
}

/** Express middleware for the setup router. */
function requireSetupAuth() {
  return (req, res, next) => {
    const path = String(req.originalUrl || req.url || '').split('?')[0];
    const ok = verifySetupRequest({ method: req.method, path, bodyString: JSON.stringify(req.body === undefined ? {} : req.body), headers: req.headers });
    for (const k of [HEADER_TS, HEADER_NONCE, HEADER_MAC]) delete req.headers[k];
    if (ok) return next();
    return res.status(403).json({ error: 'Setup is available only from the machine the server runs on.' });
  };
}

module.exports = { requireSetupAuth, verifySetupRequest, setLaunchSecret, handleStdinLine, ackTag, isConfigured, _resetForTests, HEADER_TS, HEADER_NONCE, HEADER_MAC, WINDOW_MS };
