/**
 * auth.js — Authentication & Authorization middleware
 *
 * Behaviour is controlled by AUTH_ENABLED in .env:
 *
 *   AUTH_ENABLED=false (default)
 *     All requests pass through unchanged — existing Electron desktop
 *     behaviour preserved. No JWT required.
 *
 *   AUTH_ENABLED=true
 *     Every request to a protected route must carry:
 *       Authorization: Bearer <jwt>
 *     Tokens are issued by POST /api/auth/login.
 *     Role-based access is enforced by authorize().
 *
 * This design means the codebase supports both modes with a single env
 * variable flip — no code changes needed to enable LAN/Cloud security.
 */
const jwt = require('jsonwebtoken');

const INSECURE_DEFAULT_SECRET = 'petshrow-erp-desktop-insecure-default';

const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const JWT_SECRET   = process.env.JWT_SECRET   || INSECURE_DEFAULT_SECRET;

// Hard production gate: refuse to start with auth enabled but no real secret
// configured — a missing/default secret would let anyone mint valid admin JWTs.
if (AUTH_ENABLED && (!process.env.JWT_SECRET || process.env.JWT_SECRET === INSECURE_DEFAULT_SECRET)) {
  console.error('[SECURITY] AUTH_ENABLED=true requires a real JWT_SECRET in .env — refusing to start with the insecure default.');
  process.exit(1);
}

/**
 * Verify Bearer JWT when AUTH_ENABLED=true.
 * Attaches decoded payload to req.user.
 */
function authenticate(req, res, next) {
  if (!AUTH_ENABLED) return next();

  const header = req.headers['authorization'];
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'غير مصرح — يجب تسجيل الدخول أولاً' });
  }

  const token = header.slice(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    const msg = err.name === 'TokenExpiredError'
      ? 'انتهت صلاحية الجلسة — الرجاء تسجيل الدخول من جديد'
      : 'token غير صالح';
    return res.status(401).json({ error: msg });
  }
}

/**
 * Enforce role membership when AUTH_ENABLED=true.
 * authorize() with no args = any authenticated user.
 * authorize('admin') = admin only.
 * authorize('admin','hr') = admin or hr.
 */
function authorize(...roles) {
  return (req, res, next) => {
    if (!AUTH_ENABLED) return next();
    if (!req.user) return res.status(401).json({ error: 'غير مصرح' });
    if (roles.length && !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'غير مخول لهذا الإجراء' });
    }
    next();
  };
}

module.exports = { authenticate, authorize, AUTH_ENABLED, JWT_SECRET };
