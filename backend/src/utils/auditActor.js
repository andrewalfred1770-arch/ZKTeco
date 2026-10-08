/**
 * auditActor.js — the ONE place an audit row's "who did this" is decided.
 *
 * Audit-writing routes used to copy `modifiedBy / modifiedByName / modifiedByRole`
 * (and the adjustment equivalents) straight from the request body, so any client
 * could record an edit as someone else. The authenticated session is now the
 * authoritative source:
 *
 *   - AUTH_ENABLED=true  → req.user (verified JWT) wins; every claimed value in the
 *                          body is ignored, including a forged id / name / role.
 *   - AUTH_ENABLED=false → there is no authenticated identity (the desktop build's
 *                          intentional behaviour), so the label the app itself sends
 *                          is kept, sanitised, falling back to the route's default.
 *                          Authentication is NOT made mandatory by this module.
 */
const MAX_LEN = 100;

function cleanStr(v) {
  return typeof v === 'string' ? v.trim().slice(0, MAX_LEN) : '';
}

/**
 * @param {object} req
 * @param {{id?:*, name?:*, role?:*}} [claimed]  actor fields taken from the request body
 * @param {{id?:*, name?:*, role?:*}} [defaults] per-route fallbacks (null is a valid fallback)
 * @returns {{id:*, name:*, role:*}}
 */
function resolveActor(req, claimed = {}, defaults = {}) {
  const dflt = {
    id: defaults.id !== undefined ? defaults.id : 0,
    name: defaults.name !== undefined ? defaults.name : 'HR',
    role: defaults.role !== undefined ? defaults.role : 'hr',
  };
  const u = req && req.user;
  if (u) {
    const uid = Number(u.id);
    return {
      id: Number.isInteger(uid) && uid >= 0 ? uid : dflt.id,
      name: cleanStr(u.name) || cleanStr(u.username) || dflt.name,
      role: cleanStr(u.role) || dflt.role,
    };
  }
  const c = claimed || {};
  const cid = Number(c.id);
  const hasId = c.id !== undefined && c.id !== null && c.id !== '' && Number.isInteger(cid) && cid >= 0;
  return {
    id: hasId ? cid : dflt.id,
    name: cleanStr(c.name) || dflt.name,
    role: cleanStr(c.role) || dflt.role,
  };
}

/** For the routes that name their actor fields modifiedBy / modifiedByName / modifiedByRole. */
function modifier(req, defaults) {
  const b = req.body || {};
  const a = resolveActor(req, { id: b.modifiedBy, name: b.modifiedByName, role: b.modifiedByRole }, defaults);
  return { modifiedBy: a.id, modifiedByName: a.name, modifiedByRole: a.role };
}

module.exports = { resolveActor, modifier };
