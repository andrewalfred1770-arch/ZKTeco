/**
 * loopbackOnly.js — accept a request only when the TCP peer is this machine.
 *
 * Used for endpoints that must work before any login is possible (the database setup wizard) but must never be
 * reachable by another computer on the LAN once the backend listens on a network interface.
 *
 * The decision uses the socket's remote address ONLY. Forwarded headers (X-Forwarded-For, Forwarded, X-Real-IP)
 * are client-controlled and are deliberately ignored, and `req.ip` is not used because it would honour them if a
 * `trust proxy` setting were ever added. A request that cannot be positively identified as loopback is refused.
 *
 * Recognised loopback peers: 127.0.0.0/8, ::1 (and its long form), and IPv4-mapped forms (::ffff:127.x.x.x).
 * A request that arrives on this PC's own LAN address (e.g. http://192.168.1.145:5000 from the same PC) is NOT
 * loopback and is refused — the Electron app talks to http://localhost:<port>, which is.
 */

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

function loopbackOnly() {
  return (req, res, next) => {
    const peer = req && req.socket ? req.socket.remoteAddress : undefined;
    if (isLoopbackAddress(peer)) return next();
    return res.status(403).json({ error: 'Setup is available only from the machine the server runs on.' });
  };
}

module.exports = { loopbackOnly, isLoopbackAddress };
