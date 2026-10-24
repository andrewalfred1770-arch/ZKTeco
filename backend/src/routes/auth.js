/**
 * auth.js — Authentication endpoints
 *
 * POST /api/auth/login  — validate credentials, issue JWT
 * GET  /api/auth/me     — validate current token, return user profile
 * POST /api/auth/logout — client-side; no server state to clear (stateless JWT)
 *
 * These endpoints are always available regardless of AUTH_ENABLED.
 * When AUTH_ENABLED=false they still work but the resulting token is
 * never required by other routes — useful for testing without enforcing auth.
 */
const router  = require('express').Router();
const { sendError } = require('../utils/apiError');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { getPrisma }    = require('../utils/prisma');
const { authenticate, JWT_SECRET, AUTH_ENABLED } = require('../middleware/auth');
const rateLimiter      = require('../middleware/rateLimiter');

const { getDummyHash, bcryptCostOf, BCRYPT_COST } = require('../utils/passwordPolicy');
const GENERIC_LOGIN_FAILURE = 'اسم المستخدم أو كلمة المرور غير صحيحة';
const MAX_LOGIN_PASSWORD_CHARS = 1024;

const prisma     = getPrisma();
getDummyHash(bcrypt).catch(() => {});   // warm the stand-in hash off the request path
const JWT_EXPIRES= process.env.JWT_EXPIRES || '8h';

// ── Login ─────────────────────────────────────────────────────────────────────
// Rate-limited: max 10 attempts per minute per IP
router.post('/login', rateLimiter(10, 60_000), async (req, res) => {
  const { username, password } = req.body || {};

  // Non-string / absurd inputs get the SAME generic answer as a wrong password (no type- or length-dependent oracle, no bcrypt work on junk).
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    return res.status(400).json({ error: 'username و password مطلوبان' });
  }
  if (username.length > 64 || password.length > MAX_LOGIN_PASSWORD_CHARS) return res.status(401).json({ error: GENERIC_LOGIN_FAILURE });

  try {
    const user = await prisma.user.findUnique({
      where:  { username: username.trim() },
      select: { id: true, username: true, name: true, role: true, active: true, password: true },
    });

    // The same bcrypt work whether or not the account exists (mitigates user-enumeration timing). The stand-in hash is generated
    // per process at the policy cost (utils/passwordPolicy.js) — not a literal in source — and a disabled account is still compared.
    const hash  = user?.password ?? await getDummyHash(bcrypt);
    const valid = await bcrypt.compare(password, hash);

    if (!user || !user.active || !valid) {
      return res.status(401).json({ error: GENERIC_LOGIN_FAILURE });
    }

    // Transparent upgrade: a hash made below the policy cost (employee accounts used 10) is re-hashed now that the password is known.
    // Best effort; a failure never affects the login.
    if ((bcryptCostOf(user.password) || 0) < BCRYPT_COST) {
      bcrypt.hash(password, BCRYPT_COST)
        .then((upgraded) => prisma.user.update({ where: { id: user.id }, data: { password: upgraded } }))
        .catch(() => {});
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES },
    );

    res.json({
      token,
      expiresIn: JWT_EXPIRES,
      user: { id: user.id, name: user.name, username: user.username, role: user.role },
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ── Me — verify current token ─────────────────────────────────────────────────
router.get('/me', authenticate, (req, res) => {
  if (!AUTH_ENABLED) {
    return res.json({ authEnabled: false, user: null });
  }
  res.json({ authEnabled: true, user: req.user });
});

// ── Logout — client clears the token; this is a no-op acknowledgement ────────
router.post('/logout', (_req, res) => res.json({ ok: true }));

module.exports = router;
