/**
 * statusDisclosure.js — what /api/health and /api/startup-status tell a caller (F9).
 *
 * Two audiences, decided by middleware/loopbackOnly#isDirectLocalRequest (loopback TCP peer, no proxy headers, loopback Host):
 *   - the desktop shell on this PC (Electron splash / watchdog)  -> the diagnostic detail it already consumes;
 *   - everyone else (LAN browsers through the proxy, Manager clients, scanners) -> only what a client needs to connect:
 *     status, ready, db connected/disconnected, version, apiVersion, authEnabled.
 * Never included for anyone: connection strings, host/user/database names, file paths, stack traces, secrets. The remote view also
 * omits the failure category (dbError), the startup stage/reason text, the server clock, and fingerprint-device counts.
 */

function shapeHealth(body, direct) {
  if (direct) return body;
  const { status, db, ready, version, apiVersion, authEnabled } = body;
  return { status, db, ready, version, apiVersion, authEnabled };
}

/** The remote view keeps the response SHAPE (devices:{total,connected}) so clients that read it do not break, but with no real counts. */
function shapeStartupStatus(body, direct) {
  if (direct) return body;
  const { dbConnected, servicesStarted, ready } = body;
  return { dbConnected, servicesStarted, devices: { total: 0, connected: 0 }, ready };
}

module.exports = { shapeHealth, shapeStartupStatus };
