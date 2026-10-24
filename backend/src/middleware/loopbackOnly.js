/**
 * loopbackOnly.js — accept a request only when it came DIRECTLY from a program on this machine.
 *
 * Used for endpoints that must work before any login is possible (the database setup wizard) but must never be
 * reachable by another computer on the LAN once the backend listens on a network interface.
 *
 * A loopback TCP peer alone is NOT proof of a local caller: the local TLS proxy (Caddy) also connects from 127.0.0.1, so
 * every LAN browser request forwarded by it has a loopback peer. A request is therefore "direct local" only when ALL hold:
 *   1. the TCP peer (socket.remoteAddress — never req.ip, never a header) is loopback;
 *   2. it carries none of the headers a reverse proxy adds (X-Forwarded-*, Forwarded, X-Real-IP, Via, the CheckIn proxy key).
 *      Their ABSENCE is not trusted on its own — it is only one of the conditions — but their PRESENCE always refuses, so a
 *      proxy that forwards a LAN client can never be mistaken for the desktop app;
 *   3. the Host header names a loopback host (localhost / 127.x / ::1) — a LAN browser reaches the proxy by its LAN name or
 *      address, and a DNS-rebinding page on this PC presents its own domain, so both are refused.
 * The Electron app talks to http://localhost:<port> / http://127.0.0.1:<port> without a proxy, which satisfies all three.
 *
 * KNOWN LIMIT: another local PROCESS (or a proxy configured to strip these headers and rewrite Host) is still indistinguishable
 * from the desktop app. Closing that needs a per-launch secret shared by Electron and the backend — see the design note in
 * SECURITY_REMEDIATION_1.1.5.md (F1); it changes the setup workflow, so it is not implemented here.
 */
const { isLoopbackHost } = require('../config/securityConfig');

// Headers that only a proxy (or a client imitating one) sends. Lower-case, as Node exposes them.
const PROXY_HEADERS = [
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-forwarded-server',
  'forwarded', 'x-real-ip', 'x-original-forwarded-for', 'x-client-ip', 'true-client-ip', 'cf-connecting-ip', 'via',
  'x-checkin-proxy-key',
];

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  let a = address.trim().toLowerCase();
  if (!a) return false;
  if (a.startsWith('::ffff:')) a = a.slice(7);                 // IPv4-mapped IPv6
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
  const m = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  return o.every((n) => n >= 0 && n <= 255) && o[0] === 127;
}

/** Host header -> hostname without port ('' when malformed). "[::1]:5000" -> "::1", "localhost:5000" -> "localhost". */
function hostnameOfHostHeader(value) {
  if (typeof value !== 'string') return '';
  const v = value.trim();
  if (!v || /[\s/@\\,]/.test(v)) return '';
  if (v.startsWith('[')) { const end = v.indexOf(']'); return end > 0 ? v.slice(1, end) : ''; }
  const colon = v.lastIndexOf(':');
  return colon === -1 ? v : v.slice(0, colon);
}

/** { ok:boolean, reason:string } — pure; reads only the socket peer and the request headers. */
function evaluateDirectLocal(req) {
  const peer = req && req.socket ? req.socket.remoteAddress : undefined;
  if (!isLoopbackAddress(peer)) return { ok: false, reason: 'peer-not-loopback' };
  const headers = (req && req.headers) || {};
  if (PROXY_HEADERS.some((h) => headers[h] !== undefined)) return { ok: false, reason: 'proxied-request' };
  if (!isLoopbackHost(hostnameOfHostHeader(headers.host))) return { ok: false, reason: 'non-loopback-host' };
  return { ok: true, reason: 'direct-local' };
}

function isDirectLocalRequest(req) { return evaluateDirectLocal(req).ok; }

function loopbackOnly() {
  return (req, res, next) => {
    if (isDirectLocalRequest(req)) return next();
    return res.status(403).json({ error: 'Setup is available only from the machine the server runs on.' });
  };
}

module.exports = { loopbackOnly, isLoopbackAddress, isDirectLocalRequest, evaluateDirectLocal, hostnameOfHostHeader, PROXY_HEADERS };
