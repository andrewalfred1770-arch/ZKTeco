/**
 * lanLocalOnlyOps.js — operations a LAN client may never perform in LAN no-login mode.
 *
 * In that mode (AUTH_ENABLED=false behind the local HTTPS proxy) every client inside the approved network can use the application's
 * permissions without a login — that is the owner's decision. Two groups of operations are NOT part of what a LAN client needs and are
 * kept for the person at the server PC (a direct local request, which carries no req.lanClient):
 *   - /api/setup/*    database connection setup (additionally protected by the per-launch secret, utils/setupAuth.js)
 *   - /api/cleanup/*  permanent data purge / backups download
 * (Device administration is already refused on this instance by middleware/deviceOpsGuard.js.)
 * The decision uses req.lanClient, which only middleware/clientAllowlist.js sets, after the proxy key + address allowlist passed.
 * Mounted ONLY in LAN no-login mode, right after the client gate; any other mode is byte-for-byte unchanged.
 */
const LOCAL_ONLY = /^\/api\/(?:setup|cleanup)(?:\/|$)/i;

function isLocalOnlyPath(p) { return LOCAL_ONLY.test(String(p || '').split('?')[0]); }

function lanLocalOnlyOps() {
  return (req, res, next) => {
    if (req.lanClient && isLocalOnlyPath(req.originalUrl || req.url)) {
      return res.status(403).json({ error: 'هذه العملية متاحة من جهاز الخادم فقط' });
    }
    next();
  };
}

module.exports = { lanLocalOnlyOps, isLocalOnlyPath };
