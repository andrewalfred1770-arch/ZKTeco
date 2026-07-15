// EP-007: self-initializing config — if backend/.env doesn't exist yet
// (fresh install), generate one (random JWT_SECRET, localhost/env-derived
// DATABASE_URL) BEFORE dotenv loads anything. No-op, synchronous, and
// idempotent when .env already exists — never touches an already-configured
// install.
const { ensureEnvFile } = require('./init/generateEnv');
ensureEnvFile(process.env.DOTENV_CONFIG_PATH);

// Load .env from custom path (set by Electron) or default location
const dotenvPath = process.env.DOTENV_CONFIG_PATH;
require('dotenv').config(dotenvPath ? { path: dotenvPath } : {});

const express   = require('express');
const cors      = require('cors');
const http      = require('http');
const path      = require('path');
const { Server }= require('socket.io');
const logger    = require('./utils/logger');
const { startSyncScheduler, stopSyncScheduler } = require('./services/syncScheduler');
const realtimeListener = require('./services/realtimeListenerService');
const historicalRebuildService = require('./services/historicalRebuildService');
const { disconnectPrisma } = require('./utils/prisma');
const { API_VERSION } = require('./apiVersion');
const { version: APP_VERSION } = require('../package.json');

const app    = express();
const server = http.createServer(app);
const isProd = process.env.NODE_ENV === 'production';

// CORS: allow all *localhost* origins in desktop mode (packaged Electron
// sends no Origin header; dev-mode Electron loads the Vite dev server at
// http://localhost:<port>, which does send one); restrict to CORS_ORIGINS in
// LAN mode. EF-007.3: desktop mode previously reflected ANY origin — this
// let any webpage open in the user's regular browser reach the API, since
// AUTH_ENABLED=false leaves authorize()/authenticate() as no-ops (by design
// for this trust model — unchanged here). Restricting desktop mode to
// no-origin + localhost closes that path without touching auth or breaking
// either packaged or dev-mode Electron.
const AUTH_ENABLED  = process.env.AUTH_ENABLED === 'true';
const corsAllowList = (process.env.CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const isLocalhostOrigin = (origin) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

function corsOriginCheck(origin, cb) {
  // No-origin requests: Electron renderer, curl, health-check — always allow
  if (!origin) return cb(null, true);
  // Desktop mode: allow only localhost (packaged/dev Electron, local tooling)
  if (!AUTH_ENABLED) return isLocalhostOrigin(origin) ? cb(null, true) : cb(new Error(`CORS: origin ${origin} not allowed`));
  // LAN/Cloud mode: only explicitly listed origins
  if (corsAllowList.includes(origin)) return cb(null, true);
  cb(new Error(`CORS: origin ${origin} not allowed`));
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: corsOriginCheck, methods: ['GET', 'POST'], credentials: true },
  pingTimeout: 60000,
});

// EP-011: Socket.IO connections bypass Express middleware entirely, so
// AUTH_ENABLED must be enforced separately here — mirrors
// middleware/auth.js's authenticate() exactly (same JWT_SECRET, same
// Bearer-style token, same no-op when AUTH_ENABLED=false). A Manager Client
// sends its token via the `auth` option on the client socket
// (frontend/src/lib/socket.js); Local Mode's desktop socket connections never
// set one and are unaffected while AUTH_ENABLED stays false (the default).
{
  const jwt = require('jsonwebtoken');
  const { AUTH_ENABLED, JWT_SECRET } = require('./middleware/auth');
  io.use((socket, next) => {
    if (!AUTH_ENABLED) return next();
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('غير مصرح — يجب تسجيل الدخول أولاً'));
    try {
      socket.user = jwt.verify(token, JWT_SECRET);
      next();
    } catch {
      next(new Error('token غير صالح'));
    }
  });
}

// ─── Security ─────────────────────────────────────────────────────────────────
app.use(require('./middleware/securityHeaders'));

app.use(cors({ origin: corsOriginCheck, credentials: true }));

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => { req.io = io; next(); });

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/employees',    require('./routes/employees'));
app.use('/api/adjustments', require('./routes/adjustments'));
app.use('/api/devices',     require('./routes/devices'));
app.use('/api/attendance',  require('./routes/attendance'));
app.use('/api/payroll',     require('./routes/payroll'));
app.use('/api/departments', require('./routes/departments'));
app.use('/api/branches',    require('./routes/branches'));
app.use('/api/companies',   require('./routes/companies'));
app.use('/api/rules',       require('./routes/rules'));
app.use('/api/reports',     require('./routes/reports'));
app.use('/api/advances',    require('./routes/advances'));
app.use('/api/holidays',    require('./routes/holidays'));
app.use('/api/cleanup',     require('./routes/cleanup'));
app.use('/api/dashboard',   require('./routes/dashboard'));
app.use('/api/settings/company', require('./routes/settings-company'));
app.use('/api/audit-logs',      require('./routes/audit'));
app.use('/api/auth',            require('./routes/auth'));
app.use('/api/setup',           require('./routes/setup'));

// Serve uploaded company branding assets (logo/login background/stamp/print header)
// EP-010: served from the persistent config dir (same location companySettingsStore.js
// writes to) — falls back to the pre-EP-010 backend-relative path when CONFIG_DIR
// is unset (Server Mode/dev).
const { getConfigDir } = require('./utils/configDir');
app.use('/uploads', express.static(path.join(getConfigDir(), 'uploads')));

// ─── Health check ─────────────────────────────────────────────────────────────
// Reuses the shared Prisma singleton — the previous implementation created and
// discarded a full PrismaClient (its own pool) on EVERY call, and Electron
// polls this endpoint every 300ms during startup.
const { checkDbConnection, getLastDbErrorReason } = require('./utils/prisma');
app.get('/api/health', async (_req, res) => {
  const ok = await checkDbConnection();
  const body = {
    status: ok ? 'ok' : 'starting',
    db: ok ? 'connected' : 'disconnected',
    timestamp: new Date(),
    version: APP_VERSION,      // product release version (informational)
    apiVersion: API_VERSION,   // contract version — used by clients for compatibility checks
  };
  // Additive only — never sent when connected. A fixed, safe category (never
  // the raw error/connection string) so "db:disconnected" is diagnosable
  // from the API response alone: 'auth-failed' | 'unreachable' |
  // 'database-missing' | 'unknown'.
  if (!ok) body.dbError = getLastDbErrorReason();
  res.status(ok ? 200 : 503).json(body);
});

// ─── Startup status (for Electron's functional splash) ───────────────────────
// Cheap, polled every ~300ms during startup — reports real progress instead of
// a fake animated bar: DB connectivity, whether the background services
// (sync scheduler + realtime listeners) have been launched, and how many
// fingerprint devices have an active realtime connection.
const startupState = { dbConnected: false, servicesStarted: false };
app.get('/api/startup-status', async (_req, res) => {
  if (!startupState.dbConnected) {
    startupState.dbConnected = await checkDbConnection().catch(() => false);
  }
  const devices = { total: 0, connected: 0 };
  try {
    const status = realtimeListener.getStatus();
    const ids = Object.keys(status);
    devices.total = ids.length;
    devices.connected = ids.filter((id) => status[id].status === 'connected').length;
  } catch {}
  res.json({
    dbConnected: startupState.dbConnected,
    servicesStarted: startupState.servicesStarted,
    devices,
  });
});

// Serve frontend static build (when FRONTEND_DIST is provided by Electron)
const frontendDist = process.env.FRONTEND_DIST;
if (frontendDist) {
  app.use(express.static(frontendDist, {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    },
  }));
  // SPA fallback — serve index.html for all non-API routes
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

// 404 for unmatched API routes
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  logger.error(err.message, { stack: err.stack });
  res.status(err.status || 500).json({ error: err.message || 'خطأ في الخادم' });
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  logger.info(`[SOCKET] client connected: ${socket.id}`);
  socket.on('disconnect', (reason) => logger.info(`[SOCKET] client disconnected: ${socket.id} (${reason})`));
});

// ─── Uncaught error handlers ──────────────────────────────────────────────────
// Winston's printf format drops object meta — interpolate message+stack into
// the log string so these are identifiable (previously printed as blank).
function describeError(err) {
  if (!err) return String(err);
  const msg = err.message || err.err?.message
    || (() => { try { return JSON.stringify(err); } catch { return String(err); } })();
  return err.stack ? `${msg}\n${err.stack}` : msg;
}
process.on('uncaughtException',  (err) => logger.error(`Uncaught exception: ${describeError(err)}`));
process.on('unhandledRejection', (err) => logger.error(`Unhandled rejection: ${describeError(err)}`));

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 5000;
// EP-009: default bind changed from 127.0.0.1 to 0.0.0.0 — the previous
// loopback-only default made the backend unreachable from other devices on
// the LAN (e.g. a macOS client in Server Mode), since 127.0.0.1 only accepts
// connections originating from the same machine. 0.0.0.0 listens on every
// network interface, which still includes localhost/127.0.0.1 — so local
// Electron/dev usage is unaffected. Still fully overridable via HOST for a
// deployment that wants to bind to one specific interface instead.
const HOST = process.env.HOST || '0.0.0.0';

// Attached before the async init gap below so it's guaranteed live before
// .listen() is actually called (event listeners are safe to attach any time
// before the event can fire — this is unchanged from before, only moved a
// few lines earlier to stay ahead of the new `await` below).
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`Port ${PORT} already in use. Is another instance running?`);
    process.exit(1);
  }
  logger.error('Server error:', err);
});

// EP-007: first-run initialization (folders, migrations, baseline seed) runs
// and is awaited BEFORE the port opens — nothing answers /api/* until this
// resolves, which is what makes Electron's existing /api/startup-status poll
// (unchanged) correctly wait for initialization too. Never throws/crashes:
// on failure the server still starts so /api/health can report real status.
const { runFirstRunInit } = require('./init');

(async () => {
  await runFirstRunInit();

  server.listen(PORT, HOST, () => {
    logger.info(`Server running on ${HOST}:${PORT} [${isProd ? 'production' : 'development'}]`);

    // Start background services with delay to allow DB to be ready.
    // syncScheduler is the SINGLE owner of attendance processing crons — the
    // old separate attendanceProcessor (a duplicate 15-min processToday path
    // racing the scheduler's 10-min one) has been removed.
    setTimeout(() => {
      try { startSyncScheduler(io); }
      catch (err) { logger.error('SyncScheduler error:', err.message); }
      finally { startupState.servicesStarted = true; }

      // Crash safety: resume any historical rebuild job left 'running' by a
      // process that died mid-run (see historicalRebuildService.js).
      historicalRebuildService.resumeInterruptedJobs(io)
        .catch((err) => logger.error(`[HIST-REBUILD] resume error: ${err.message}`));
    }, 2000);
  });
})();

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// Deterministic teardown order: stop producing new work (crons), drop device
// sessions cleanly (listeners + their reconnect timers), stop accepting HTTP,
// flush the DB pool, exit. Triggered by:
//  - SIGTERM/SIGINT (dev, Unix-like environments)
//  - the literal line "shutdown" on stdin — Windows has no real signals
//    (child.kill('SIGTERM') is a hard TerminateProcess there), so the Electron
//    main writes this command and only force-kills if we fail to exit in time.
let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[SHUTDOWN] starting graceful shutdown (${reason})`);

  // Hard ceiling — never let a stuck teardown keep the process alive forever.
  const failsafe = setTimeout(() => {
    logger.error('[SHUTDOWN] teardown exceeded 5s — forcing exit');
    process.exit(1);
  }, 5000);
  failsafe.unref();

  try { stopSyncScheduler(); } catch (err) { logger.warn(`[SHUTDOWN] scheduler stop failed: ${err.message}`); }
  try { realtimeListener.stopAll(); } catch (err) { logger.warn(`[SHUTDOWN] listener stop failed: ${err.message}`); }
  try { io.close(); } catch {}
  await new Promise((resolve) => server.close(resolve));
  await disconnectPrisma();

  logger.info('[SHUTDOWN] complete — exiting');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
if (process.stdin && !process.stdin.destroyed) {
  try {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      if (String(chunk).trim().split(/\r?\n/).includes('shutdown')) shutdown('stdin command');
    });
    process.stdin.on('error', () => {});
    // Don't let an open stdin keep the event loop alive on its own.
    process.stdin.resume();
    if (typeof process.stdin.unref === 'function') process.stdin.unref();
  } catch { /* stdin unavailable (detached) — signals still work */ }
}

// `shutdown` is exported so routes/setup.js (EP-010.1 Database Setup Wizard)
// can trigger the exact same graceful teardown after writing a new .env,
// without relying on cross-process signals — process.kill(pid,'SIGTERM')
// to self was verified NOT to reliably fire the SIGTERM handler on Windows
// (consistent with the stdin-shutdown workaround above), so calling this
// function directly is the only dependable way to self-restart.
module.exports = { app, io, shutdown };
