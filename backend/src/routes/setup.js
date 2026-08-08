/**
 * /api/setup — Database Configuration Wizard backend (EP-010.1).
 *
 * Lets a non-technical user fix a bad DATABASE_URL from the UI instead of
 * hand-editing %APPDATA%/PETSHROW ERP/.env. Three endpoints:
 *   GET  /current         — current (non-secret) connection fields, to pre-fill the form
 *   POST /test-connection — tries a CANDIDATE connection, never touches the live app pool
 *   POST /save            — re-validates, persists to the existing EP-010 .env location,
 *                            then asks the process to restart (Electron auto-respawns it;
 *                            see frontend/electron/backend.js RESTART_REQUIRED handling)
 *
 * Deliberately unauthenticated: these routes exist specifically for the case
 * where the DB (and therefore any DB-backed login) is unreachable, mirroring
 * why /api/health and /api/startup-status are also unauthenticated. The
 * middleware below closes this surface automatically the moment the main
 * app's DB connection is healthy — no changes to the auth system itself.
 */
const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { PrismaClient } = require('@prisma/client');
const { checkDbConnection, classifyDbError } = require('../utils/prisma');
const { getConfigDir } = require('../utils/configDir');
const logger = require('../utils/logger');
const rateLimiter = require('../middleware/rateLimiter');

function currentEnvPath() {
  return process.env.DOTENV_CONFIG_PATH || path.join(getConfigDir(), '.env');
}

function buildDatabaseUrl({ host, port, database, username, password }, { fastTimeout = false } = {}) {
  const auth = password
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}`
    : encodeURIComponent(username);
  const base = `mysql://${auth}@${host}:${port}/${database}`;
  // Prisma's default TCP connect timeout is tens of seconds — far too long
  // for a "Test Connection" button to stay responsive against a genuinely
  // unreachable host. Only the throwaway test client gets this; the URL
  // that's actually persisted to .env never has it, so the real running
  // app's connection retains normal (patient) timeout behavior.
  return fastTimeout ? `${base}?connect_timeout=5` : base;
}

/** Parses mysql://user[:pass]@host:port/db — returns null fields it can't read. */
function parseDatabaseUrl(url) {
  try {
    const u = new URL(url);
    return {
      host: u.hostname || null,
      port: u.port || '3306',
      database: (u.pathname || '').replace(/^\//, '') || null,
      username: decodeURIComponent(u.username || '') || null,
      // password is intentionally never returned
    };
  } catch {
    return { host: null, port: '3306', database: null, username: null };
  }
}

/**
 * Tests a CANDIDATE connection string using an independent, throwaway
 * PrismaClient — never the shared getPrisma() singleton, so a bad candidate
 * can never disturb the app's real connection pool. Always disconnected
 * before returning, success or failure.
 */
async function testCandidate(fields) {
  const url = buildDatabaseUrl(fields, { fastTimeout: true });
  const testClient = new PrismaClient({ datasources: { db: { url } } });
  try {
    await testClient.$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: classifyDbError(err) };
  } finally {
    await testClient.$disconnect().catch(() => {});
  }
}

function validateFields(body) {
  const { host, port, database, username } = body || {};
  if (!host || !port || !database || !username) {
    return 'host, port, database, and username are required';
  }
  return null;
}

// Self-disabling: once the main app's own DB connection is healthy, this
// entire router 403s — closes the surface automatically, no auth-system
// involvement, and guarantees the wizard flow can never re-point an
// already-working install at a different database.
router.use(async (_req, res, next) => {
  const healthy = await checkDbConnection();
  if (healthy) {
    return res.status(403).json({ error: 'Database already configured and connected — setup is disabled.' });
  }
  next();
});

router.get('/current', (_req, res) => {
  try {
    const envPath = currentEnvPath();
    const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const parsed = dotenv.parse(raw);
    res.json(parseDatabaseUrl(parsed.DATABASE_URL || ''));
  } catch (err) {
    logger.warn(`[Setup] /current read failed: ${err.message}`);
    res.json({ host: null, port: '3306', database: null, username: null });
  }
});

// M1 hardening: this router is unauthenticated by design (see the module
// doc comment — it must work before any DB-backed login is possible) and
// self-disables the instant the real app's DB is healthy (router.use()
// above). The residual exposure is narrow — only reachable during an actual
// DB-down window on a network-reachable backend — but within that window
// /test-connection lets a caller supply an arbitrary host:port and get back
// a coarse signal (auth-failed vs unreachable vs database-missing) about
// what's listening there: a low-bandwidth internal-network/port oracle.
// Rate-limiting doesn't change WHO can call this (no auth/trust-model
// decision made here) — it just makes host/port scanning through it
// impractically slow, the same defense-in-depth /auth/login already uses.
router.post('/test-connection', rateLimiter(10, 60_000), async (req, res) => {
  const invalid = validateFields(req.body);
  if (invalid) return res.status(400).json({ error: invalid });
  const { host, port, database, username, password } = req.body;
  const result = await testCandidate({ host, port, database, username, password: password || '' });
  res.json(result);
});

// Same rationale as /test-connection above — /save already requires a
// successful testCandidate() against a REAL reachable database before it
// writes anything, so it's not itself a blind probe, but it's still the
// destructive endpoint of this narrow window and gets the same throttle.
router.post('/save', rateLimiter(5, 60_000), async (req, res) => {
  const invalid = validateFields(req.body);
  if (invalid) return res.status(400).json({ error: invalid });
  const { host, port, database, username, password } = req.body;

  const test = await testCandidate({ host, port, database, username, password: password || '' });
  if (!test.ok) {
    return res.status(400).json({ error: 'Connection test failed — configuration was not saved', reason: test.reason });
  }

  const envPath = currentEnvPath();
  try {
    const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const parsed = dotenv.parse(raw);
    parsed.DATABASE_URL = buildDatabaseUrl({ host, port, database, username, password: password || '' });
    const dir = path.dirname(envPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const content = Object.entries(parsed).map(([k, v]) => `${k}="${v}"`).join('\n') + '\n';
    fs.writeFileSync(envPath, content, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    logger.error(`[Setup] Failed to write configuration: ${err.message}`);
    return res.status(500).json({ error: 'Failed to save configuration' });
  }

  logger.info('[Setup] Database configuration updated — restarting');
  res.json({ ok: true, restarting: true });

  // Respond first (client needs the HTTP response), then restart. Calls the
  // SAME graceful-shutdown function index.js uses for SIGTERM/SIGINT/stdin
  // "shutdown" — required('../index') is lazy (deferred to request time, not
  // module load) specifically to avoid a circular-require with index.js,
  // which itself requires this router. process.kill(pid,'SIGTERM') to self
  // was tested and does NOT reliably fire the SIGTERM handler on Windows, so
  // shutdown() is invoked directly rather than via a signal. The stdout
  // marker lets Electron's backend.js (EP-010.1) distinguish "restart me,
  // config changed" from a real app-quit, since both otherwise look
  // identical (clean exit, code 0).
  setTimeout(() => {
    console.log('[Setup] RESTART_REQUIRED');
    const { shutdown } = require('../index');
    shutdown('database-config-updated');
  }, 300);
});

module.exports = router;
