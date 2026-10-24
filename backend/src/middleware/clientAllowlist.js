/**
 * clientAllowlist.js — LAN "no login" mode: only clients inside the configured trusted network(s) (or listed hosts) that arrive through the
 * local HTTPS proxy are served. No per-device registration is needed: a trusted network such as 192.168.1.0/24 (never broader than /24) covers
 * every device on that Wi-Fi/LAN.
 *
 * Applies ONLY when config/securityConfig.js#resolveLanClientPolicy says mode === 'lan-nologin' (auth off + TRUST_PROXY=loopback behind
 * Caddy). The Windows desktop backend ('desktop') and the login-protected LAN backend ('authenticated') never mount this.
 *
 * Trust model — three independent facts must all hold for a request to be served:
 *   1. the TCP peer is loopback (the proxy on this PC; the backend is also bound to 127.0.0.1, so this is defence in depth);
 *   2. the request carries the per-install proxy key (X-CheckIn-Proxy-Key) that only Caddy adds (`header_up`, overwriting anything a client
 *      sent) — so an arbitrary LOOPBACK caller (another program on this PC) is NOT trusted: without the key it is refused, and a forged
 *      X-Forwarded-For from it is worthless;
 *   3. X-Forwarded-For is exactly ONE address (Caddy overwrites it with the real TCP peer; a chain means something else wrote to it) and
 *      that address lies inside a trusted network / listed host.
 * Single exception: `GET /api/health` from a loopback peer that sends NO forwarded/proxy headers (the start-up scripts' readiness probe).
 *
 * The audit identity is req.lanClient = { ip, label, network } — the client ADDRESS (plus the label of the trusted network it matched), never a
 * person, never a client-supplied name.
 */
'use strict';

const crypto = require('crypto');
const { isLoopbackHost, normalizeClientIp, parseStrictIPv4, entryContains } = require('../config/securityConfig');

const KEY_HEADER = 'x-checkin-proxy-key';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sameKey = (a, b) => typeof a === 'string' && a.length > 0 && crypto.timingSafeEqual(sha(a), sha(b));

/**
 * Pure decision. Never throws.
 * @param {{peer:string, xff:string|string[]|undefined, key:string|string[]|undefined, method:string, path:string}} r
 * @param {{allowed:object[], proxyKey:string}} policy  allowed = the parsed trusted networks / hosts (securityConfig.parseAllowedClients)
 * @returns {{ok:boolean, reason:string, client?:{ip:string,label:string}, logIp?:string}}
 */
function evaluateClient(r, policy) {
  const peer = normalizeClientIp(r && r.peer);
  if (!isLoopbackHost(peer)) return { ok: false, reason: 'peer-not-loopback' };
  const xffRaw = Array.isArray(r.xff) ? r.xff.join(',') : r.xff;
  const keyRaw = Array.isArray(r.key) ? (r.key.length === 1 ? r.key[0] : '') : r.key;
  const noProxyHeaders = (xffRaw === undefined || xffRaw === '') && (keyRaw === undefined || keyRaw === '');
  if (noProxyHeaders && String(r.method).toUpperCase() === 'GET' && r.path === '/api/health') return { ok: true, reason: 'local-health' };
  if (!sameKey(keyRaw, policy.proxyKey)) return { ok: false, reason: 'missing-or-invalid-proxy-identity' };
  if (typeof xffRaw !== 'string' || xffRaw.includes(',')) return { ok: false, reason: 'invalid-forwarded-for' };
  const ip = normalizeClientIp(xffRaw);
  if (!parseStrictIPv4(ip)) return { ok: false, reason: 'invalid-forwarded-for' };
  const hit = policy.allowed.find((e) => entryContains(e, ip));          // a trusted network (e.g. 192.168.1.0/24) or a single listed host
  if (!hit) return { ok: false, reason: 'client-not-allowlisted', logIp: ip };
  return { ok: true, reason: 'allowed', client: { ip, label: hit.label || '', network: hit.cidr }, logIp: ip };
}

/** Throttled, secret-free deny log: one line per (reason, ip) per minute. */
function createDenyLogger(logger) {
  const seen = new Map();
  return function logDeny(reason, ip, method, path) {
    const k = `${reason}|${ip || '?'}`; const now = Date.now();
    if (seen.get(k) && now - seen.get(k) < 60000) return;
    if (seen.size > 500) seen.clear();
    seen.set(k, now);
    logger.warn(`[LAN-GATE] denied (${reason}) client=${ip || '?'} ${String(method).slice(0, 8)} ${String(path).slice(0, 120)}`);
  };
}

/** Express middleware — mount FIRST (before CORS, static files and every router). */
function createClientGate(policy, logger) {
  const logDeny = createDenyLogger(logger);
  return function clientGate(req, res, next) {
    const path = String(req.originalUrl || req.url || '').split('?')[0];
    const d = evaluateClient({ peer: req.socket && req.socket.remoteAddress, xff: req.headers['x-forwarded-for'], key: req.headers[KEY_HEADER], method: req.method, path }, policy);
    delete req.headers[KEY_HEADER];                    // the key never travels further into the app
    if (!d.ok) {
      logDeny(d.reason, d.logIp && /^\d{1,3}(\.\d{1,3}){3}$/.test(d.logIp) ? d.logIp : null, req.method, path);
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (d.client) req.lanClient = d.client;
    next();
  };
}

/** Engine.IO `allowRequest`: runs for every handshake / upgrade, so a client outside the trusted network cannot even open a socket session. */
function createEngineAllowRequest(policy, logger) {
  const logDeny = createDenyLogger(logger);
  return function allowRequest(req, cb) {
    const path = String(req.url || '').split('?')[0];
    const d = evaluateClient({ peer: req.socket && req.socket.remoteAddress, xff: req.headers['x-forwarded-for'], key: req.headers[KEY_HEADER], method: req.method, path }, policy);
    delete req.headers[KEY_HEADER];
    if (!d.ok || d.reason === 'local-health') {
      logDeny(d.reason === 'local-health' ? 'socket-without-proxy-identity' : d.reason, d.logIp || null, req.method, path);
      return cb('Forbidden', false);
    }
    req.lanClient = d.client;
    cb(null, true);
  };
}

module.exports = { evaluateClient, createClientGate, createEngineAllowRequest, KEY_HEADER };
