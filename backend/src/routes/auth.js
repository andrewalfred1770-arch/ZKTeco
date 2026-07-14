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
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { getPrisma }    = require('../utils/prisma');
const { authenticate, JWT_SECRET } = require('../middleware/auth');
const rateLimiter      = require('../middleware/rateLimiter');

const prisma     = getPrisma();
const JWT_EXPIRES= process.env.JWT_EXPIRES || '8h';

// ── Login ─────────────────────────────────────────────────────────────────────
// Rate-limited: max 10 attempts per minute per IP
router.post('/login', rateLimiter(10, 60_000), async (req, res) => {
  const { username, password } = req.body || {};

  if (!username?.trim() || !password) {
    return res.status(400).json({ error: 'username و password مطلوبان' });
  }

  try {
    const user = await prisma.user.findUnique({
      where:  { username: username.trim() },
      select: { id: true, username: true, name: true, role: true, active: true, password: true },
    });

    // Constant-time comparison even on missing user (mitigates user-enumeration timing)
    const sentinel = '$2a$10$CwTycUXWue0Thq9StjUM0uSmx0Y.v8Ml2y2DJX7.TiWNTTYKnvUkq';
    const hash     = user?.password ?? sentinel;
    const valid    = await bcrypt.compare(password, hash);

    if (!user || !user.active || !valid) {
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
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
    res.status(500).json({ error: err.message });
  }
});

// ── Me — verify current token ─────────────────────────────────────────────────
router.get('/me', authenticate, (req, res) => {
  if (process.env.AUTH_ENABLED !== 'true') {
    return res.json({ authEnabled: false, user: null });
  }
  res.json({ authEnabled: true, user: req.user });
});

// ── Logout — client clears the token; this is a no-op acknowledgement ────────
router.post('/logout', (_req, res) => res.json({ ok: true }));

module.exports = router;
