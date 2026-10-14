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
const { parseAuthEnabled } = require('../config/securityConfig');

const INSECURE_DEFAULT_SECRET = 'petshrow-erp-desktop-insecure-default';

// The ONE parse of AUTH_ENABLED (config/securityConfig.js): enabled only for "true" (any case);
// unset / "false" / any unrecognized value = disabled, and index.js then restricts the API to loopback.
const AUTH_CONFIG  = parseAuthEnabled(process.env.AUTH_ENABLED);
const AUTH_ENABLED = AUTH_CONFIG.enabled;
const AUTH_STATUS  = AUTH_CONFIG.status;
const AUTH_RAW     = AUTH_CONFIG.raw;
const JWT_SECRET   = process.env.JWT_SECRET   || INSECURE_DEFAULT_SECRET;

// Hard production gate: refuse to start with auth enabled but no real secret
// configured — a missing/default secret would let anyone mint valid admin JWTs.
// Exit 78 (= EXIT_STARTUP_BLOCKED in init/bootstrapResult.js / BACKEND_EXIT_STARTUP_BLOCKED in
// frontend/electron/constants.js): a permanent configuration error, so the Electron shell must NOT
// restart-loop it. The message never contains the secret value.
if (AUTH_ENABLED && (!process.env.JWT_SECRET || process.env.JWT_SECRET === INSECURE_DEFAULT_SECRET)) {
  console.error('[SECURITY] AUTH_ENABLED=true requires a real JWT_SECRET in .env — refusing to start with the insecure default.');
  process.exit(78);
}

// A JWT is stateless: its signature stays valid until it expires, even after the account behind it was deactivated or
// deleted. Every protected request therefore also checks the account itself — the same `users.active` flag the login
// already enforces — with ONE primary-key lookup. No new table, schema or revocation list; re-activating the account
// makes its still-unexpired token work again. A failing lookup fails CLOSED (error response, never a pass-through).
const INACTIVE_ACCOUNT_MESSAGE = 'الحساب غير موجود أو معطّل — الرجاء تسجيل الدخول من جديد أو مراجعة المسؤول';

// Listeners told when an HTTP request has just PROVEN (the lookup succeeded) that an account is missing, inactive or role-less.
// index.js uses it to disconnect that user's live sockets at once (services/socketSessionGuard.js dropUser). A lookup that merely
// FAILED (database error) never fires it: that is an infrastructure problem, not a confirmed invalid session.
const accountRejectedListeners = new Set();
function onAccountRejected(fn) { accountRejectedListeners.add(fn); return () => accountRejectedListeners.delete(fn); }
function notifyAccountRejected(id) {
  for (const fn of accountRejectedListeners) { try { fn(id); } catch { /* a listener must never affect the response */ } }
}

// Returns the account ({ id, active, role }) when it exists AND is active, otherwise null.
async function loadActiveAccount(decoded) {
  if (!decoded || !Number.isInteger(decoded.id)) return null;
  const { getPrisma } = require('../utils/prisma');   // lazy: keeps this module free of an early database import
  const user = await getPrisma().user.findUnique({ where: { id: decoded.id }, select: { id: true, active: true, role: true } });
  return user && user.active ? user : null;
}

/** Verifies the Bearer JWT. Returns { decoded } or { status, error }. Shared by HTTP and the Socket.IO handshake. */
function verifyToken(token) {
  try {
    return { decoded: jwt.verify(token, JWT_SECRET) };
  } catch (err) {
    return {
      status: 401,
      error: err.name === 'TokenExpiredError' ? 'انتهت صلاحية الجلسة — الرجاء تسجيل الدخول من جديد' : 'token غير صالح',
    };
  }
}

/**
 * Verify Bearer JWT when AUTH_ENABLED=true and that its account still exists and is active.
 * Attaches decoded payload to req.user. Verified once per request (a router-level and a route-level
 * authenticate on the same request do not look the account up twice).
 */
async function authenticate(req, res, next) {
  if (!AUTH_ENABLED) return next();
  if (req._accountVerified) return next();

  const header = req.headers['authorization'];
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'غير مصرح — يجب تسجيل الدخول أولاً' });
  }

  const v = verifyToken(header.slice(7));
  if (v.error) return res.status(v.status).json({ error: v.error });

  let account;
  try {
    account = await loadActiveAccount(v.decoded);
  } catch (err) {
    return require('../utils/apiError').sendError(res, err);
  }
  // The role comes from the account record that was just loaded (users.role), NEVER from the JWT claim: a claim is frozen at login
  // and would let a demoted user keep their old privileges until the token expires (up to JWT_EXPIRES). A record with no usable
  // role cannot be authorized, so it is refused rather than falling back to the claim. authorize() reads req.user.role, so every
  // role check downstream sees the current role, and the single lookup is shared by all authenticate/authorize calls of the request.
  if (!account || !account.role) {
    notifyAccountRejected(v.decoded.id);
    return res.status(401).json({ error: INACTIVE_ACCOUNT_MESSAGE });
  }

  req.user = { ...v.decoded, role: account.role };
  req._accountVerified = true;
  next();
}

/**
 * Socket.IO handshake: same token + account check as authenticate() (Socket.IO bypasses Express middleware).
 * Applies to NEW connections; a socket that is already connected keeps its connection until it drops.
 */
async function authenticateSocket(socket, next) {
  if (!AUTH_ENABLED) return next();
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('غير مصرح — يجب تسجيل الدخول أولاً'));
  const v = verifyToken(token);
  if (v.error) return next(new Error(v.error));
  let account;
  try {
    account = await loadActiveAccount(v.decoded);
  } catch {
    return next(new Error('تعذّر التحقق من الحساب'));
  }
  if (!account || !account.role) return next(new Error(INACTIVE_ACCOUNT_MESSAGE));
  // The socket is labelled with the account's CURRENT role from the database (not the possibly stale JWT claim), so
  // services/socketSessionGuard.js can later detect a role change by comparing against the database again.
  socket.user = { ...v.decoded, role: account.role };
  next();
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

module.exports = { authenticate, authenticateSocket, onAccountRejected, authorize, AUTH_ENABLED, AUTH_STATUS, AUTH_RAW, JWT_SECRET };
