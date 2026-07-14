/**
 * rateLimiter.js — simple in-memory sliding-window rate limiter.
 *
 * Requires no external package.
 * Intended for the /api/auth/login endpoint to prevent brute-force
 * credential attacks when AUTH_ENABLED=true.
 *
 * Usage:
 *   const rateLimiter = require('./rateLimiter');
 *   router.post('/login', rateLimiter(10, 60_000), handler);
 *
 * @param {number} max       Maximum requests per window
 * @param {number} windowMs  Window size in milliseconds
 */
module.exports = function rateLimiter(max = 10, windowMs = 60_000) {
  const store = new Map(); // ip → [timestamp, ...]

  // Prune old entries every 5 minutes to prevent unbounded memory growth
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, times] of store) {
      const pruned = times.filter(t => t > cutoff);
      if (pruned.length === 0) store.delete(ip);
      else store.set(ip, pruned);
    }
  }, 5 * 60_000).unref(); // .unref() so the interval doesn't block process exit

  return (req, res, next) => {
    const ip  = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const cutoff = now - windowMs;
    const times = (store.get(ip) || []).filter(t => t > cutoff);

    if (times.length >= max) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(429).json({
        error: 'طلبات كثيرة جداً — حاول مرة أخرى بعد دقيقة',
      });
    }

    times.push(now);
    store.set(ip, times);
    next();
  };
};
