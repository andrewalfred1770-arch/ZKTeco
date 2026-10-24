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

// Business dates are server-local calendar days — pin the zone BEFORE anything
// formats/compares a date (a host west of UTC otherwise shifts every day back).
require('./utils/businessTimezone').applyBusinessTimezone();

const express   = require('express');
const cors      = require('cors');
const http      = require('http');
const path      = require('path');
const { Server }= require('socket.io');
const logger    = require('./utils/logger');

// ─── Security gate (config/securityConfig.js) ────────────────────────────────
// Decided BEFORE anything else loads or can listen: with authentication disabled the API may only bind
// to loopback; an explicit non-loopback HOST is refused. Exit code 78 (EXIT_STARTUP_BLOCKED) so the
// Electron shell does NOT keep restarting a configuration error every few seconds.
const { AUTH_ENABLED, AUTH_STATUS, AUTH_RAW } = require('./middleware/auth');
const { resolveSecureHost, resolveTrustProxy } = require('./config/securityConfig');
const { isSkipSchedulerInstance } = require('./middleware/deviceOpsGuard');
const secureBind = resolveSecureHost({ authEnabled: AUTH_ENABLED, authStatus: AUTH_STATUS, authRaw: AUTH_RAW, host: process.env.HOST });
if (!secureBind.ok) {
  try { require('fs').writeSync(2, secureBind.error.message + '\n'); } catch { /* stderr unavailable */ }
  logger.error(secureBind.error.message);
  process.exit(require('./init/bootstrapResult').EXIT_STARTUP_BLOCKED);
}
secureBind.warnings.forEach((w) => logger.warn(w));
// Reverse-proxy trust: OFF unless TRUST_PROXY=loopback AND this backend itself listens on loopback (a local TLS proxy in front). Never broader.
const trustProxy = resolveTrustProxy({ raw: process.env.TRUST_PROXY, host: secureBind.host });
if (!trustProxy.ok) {
  try { require('fs').writeSync(2, trustProxy.error.message + '\n'); } catch { /* stderr unavailable */ }
  logger.error(trustProxy.error.message);
  process.exit(require('./init/bootstrapResult').EXIT_STARTUP_BLOCKED);
}
trustProxy.warnings.forEach((w) => logger.warn(w));
// LAN "no login" mode: only when auth is OFF behind the local HTTPS proxy (TRUST_PROXY=loopback). 'desktop' (no TRUST_PROXY) and
// 'authenticated' (AUTH_ENABLED=true) are untouched. The allowlist file is read here, once; any problem = refuse to start (fail closed).
const { resolveLanClientPolicy } = require('./config/securityConfig');
let lanAllowedText = null; let lanAllowedFileError;
if (!AUTH_ENABLED && trustProxy.value === 'loopback' && process.env.ALLOWED_CLIENT_IPS_FILE) {
  try { lanAllowedText = require('fs').readFileSync(process.env.ALLOWED_CLIENT_IPS_FILE, 'utf8'); } catch (e) { lanAllowedFileError = e && e.code ? e.code : 'read error'; }
}
const lanPolicy = resolveLanClientPolicy({
  authEnabled: AUTH_ENABLED, trustProxyValue: trustProxy.value, host: secureBind.host, allowedText: lanAllowedText,
  allowedFileError: lanAllowedFileError, proxyKey: process.env.PROXY_SHARED_SECRET, skipScheduler: isSkipSchedulerInstance(),
});
if (!lanPolicy.ok) {
  try { require('fs').writeSync(2, lanPolicy.error.message + '\n'); } catch { /* stderr unavailable */ }
  logger.error(lanPolicy.error.message);
  process.exit(require('./init/bootstrapResult').EXIT_STARTUP_BLOCKED);
}
lanPolicy.warnings.forEach((w) => logger.warn(w));
const lanNoLogin = lanPolicy.mode === 'lan-nologin';
const { startSyncScheduler, stopSyncScheduler } = require('./services/syncScheduler');
const realtimeListener = require('./services/realtimeListenerService');
const historicalRebuildService = require('./services/historicalRebuildService');
const { disconnectPrisma } = require('./utils/prisma');
const startup = require('./init/startupState');
const { sendError, validateQueryIds } = require('./utils/apiError');
const { STAGE, EXIT_STARTUP_BLOCKED } = require('./init/bootstrapResult');
const { API_VERSION } = require('./apiVersion');
const { version: APP_VERSION } = require('../package.json');

const app    = express();
if (trustProxy.value) app.set('trust proxy', trustProxy.value);   // 'loopback' only: req.ip / req.secure come from the local proxy's X-Forwarded-* headers
const server = http.createServer(app);
const isProd = process.env.NODE_ENV === 'production';

// CORS (config/corsPolicy.js): desktop mode (authentication OFF, loopback-only bind) accepts only loopback browser origins;
// LAN-server mode (authentication ON) accepts only the exact origins in CORS_ORIGINS. Private-LAN IPs, single-label names and
// .local/.lan names are NOT trusted implicitly. Requests without an Origin header (packaged Electron, curl) pass through.
// AUTH_ENABLED: parsed once in middleware/auth.js (imported above) — never re-read from process.env here.
const { parseCorsOrigins, createCorsOriginCheck } = require('./config/corsPolicy');
const corsConfig = parseCorsOrigins(process.env.CORS_ORIGINS);
corsConfig.rejected.forEach((e) => logger.warn(`[SECURITY] CORS_ORIGINS entry "${String(e).slice(0, 80)}" ignored: only exact http(s)://host[:port] origins are accepted (no wildcard, path or credentials).`));
const corsOriginCheck = createCorsOriginCheck({ authEnabled: AUTH_ENABLED, allowList: corsConfig.origins, proxyNoLogin: lanNoLogin });
const { createClientGate, createEngineAllowRequest } = require('./middleware/clientAllowlist');

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: corsOriginCheck, methods: ['GET', 'POST'], credentials: true },
  pingTimeout: 60000,
  // LAN no-login mode: an unapproved device cannot even open an Engine.IO session (checked on every handshake / upgrade).
  ...(lanNoLogin ? { allowRequest: createEngineAllowRequest(lanPolicy, logger) } : {}),
});

// Readiness first: while the application is not READY (bootstrap blocked) no
// realtime client may connect — registered before the auth middleware below.
io.use((_socket, next) => (startup.isReady() ? next() : next(new Error('NOT_READY'))));

// EP-011: Socket.IO connections bypass Express middleware entirely, so
// AUTH_ENABLED must be enforced separately here — mirrors
// middleware/auth.js's authenticate() exactly (same JWT_SECRET, same
// Bearer-style token, same no-op when AUTH_ENABLED=false). A Manager Client
// sends its token via the `auth` option on the client socket
// (frontend/src/lib/socket.js); Local Mode's desktop socket connections never
// set one and are unaffected while AUTH_ENABLED stays false (the default).
{
  // Same token check AND the same "account still exists and is active" check as the HTTP middleware.
  const { authenticateSocket } = require('./middleware/auth');
  io.use(authenticateSocket);
}

// F7: with authentication on, broadcasts (attendance, device, rules, cleanup, settings … events) are delivered only to the 'staff'
// room (admin/hr). Every emitter calls io.emit(), so this one line scopes them all. See services/socketScopes.js.
const socketScopes = require('./services/socketScopes');
socketScopes.installScopedEmit(io, AUTH_ENABLED);
io.on('connection', (socket) => { socketScopes.joinScopes(socket, AUTH_ENABLED); });

// Connected sockets are re-checked periodically (deactivated / deleted / re-roled users are disconnected; see
// services/socketSessionGuard.js). One shared unref'd timer, a no-op when authentication is disabled, stopped on shutdown.
const socketSessionGuard = require('./services/socketSessionGuard').createSocketSessionGuard({ io });
socketSessionGuard.start();
// An HTTP request that proves an account is invalid also ends that user's live sockets immediately (no waiting for the next tick).
require('./middleware/auth').onAccountRejected((userId) => socketSessionGuard.dropUser(userId, 'http-rejected'));

// ─── Security ─────────────────────────────────────────────────────────────────
if (lanNoLogin) app.use(createClientGate(lanPolicy, logger));   // FIRST: before headers, CORS, static files and every router
if (lanNoLogin) app.use(require('./middleware/lanLocalOnlyOps').lanLocalOnlyOps());   // setup + data purge stay with the server PC, never a LAN client
app.use(require('./middleware/securityHeaders'));

app.use(cors({ origin: corsOriginCheck, credentials: true }));

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => { req.io = io; next(); });

// Liveness ≠ readiness: until bootstrap has verified the database schema every
// business route answers 503; only /health, /startup-status and /setup stay open.
app.use('/api', startup.startupGate);
app.use('/api', validateQueryIds);

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
// F8: only the branding images are public; cache.json (all company settings), tmp-* files and any other internal file answer 404.
app.use('/uploads', require('./middleware/uploadsGuard').uploadsGuard(),
  express.static(path.join(getConfigDir(), 'uploads'), { dotfiles: 'ignore', index: false, redirect: false, extensions: false }));

// ─── Health check ─────────────────────────────────────────────────────────────
// Reuses the shared Prisma singleton — the previous implementation created and
// discarded a full PrismaClient (its own pool) on EVERY call, and Electron
// polls this endpoint every 300ms during startup.
const { checkDbConnection, getLastDbErrorReason } = require('./utils/prisma');
const { isDirectLocalRequest } = require('./middleware/loopbackOnly');
const { shapeHealth, shapeStartupStatus } = require('./utils/statusDisclosure');
app.get('/api/health', async (req, res) => {
  const ok = await checkDbConnection();
  const ready = startup.isReady();
  // 200 only when the database is reachable AND bootstrap verified the schema
  // (READY). A blocked bootstrap is never "healthy", whatever the connection says.
  const healthy = ok && ready;
  const body = {
    status: healthy ? 'ok' : (ready ? 'starting' : 'blocked'),
    db: ok ? 'connected' : 'disconnected',
    ready,
    timestamp: new Date(),
    version: APP_VERSION,      // product release version (informational)
    apiVersion: API_VERSION,   // contract version — used by clients for compatibility checks
    // Boolean only — never the JWT secret or any credential. Lets Electron's
    // killStaleBackend() tell an already-running process apart from one still
    // carrying a stale AUTH_ENABLED value from before a persistent-config
    // edit, instead of blindly adopting whatever answers on the port.
    authEnabled: AUTH_ENABLED,
  };
  // Additive only — never sent when connected. A fixed, safe category (never
  // the raw error/connection string) so "db:disconnected" is diagnosable
  // from the API response alone: 'auth-failed' | 'unreachable' |
  // 'database-missing' | 'unknown'.
  if (!ok) body.dbError = getLastDbErrorReason();
  // Why the application is not ready: phase + stage + reason only (no detail).
  if (!ready) body.startup = startup.describe();
  // F9: the diagnostic extras above go only to the desktop shell on this PC; any other caller gets the minimal connect-time view.
  res.status(healthy ? 200 : 503).json(shapeHealth(body, isDirectLocalRequest(req)));
});

// ─── Startup status (for Electron's functional splash) ───────────────────────
// Cheap, polled every ~300ms during startup — reports real progress instead of
// a fake animated bar: DB connectivity, whether the background services
// (sync scheduler + realtime listeners) have been launched, and how many
// fingerprint devices have an active realtime connection.
const startupState = startup.state;   // { phase, failure, servicesStarted }
let dbConnectedLatched = false;
app.get('/api/startup-status', async (req, res) => {
  const ready = startup.isReady();
  // dbConnected is the readiness signal Electron's splash gates on, so it is
  // only ever true for a READY application — a reachable database behind a
  // blocked (unverified-schema) bootstrap must not look like a started backend.
  if (ready && !dbConnectedLatched) {
    dbConnectedLatched = await checkDbConnection().catch(() => false);
  }
  const devices = { total: 0, connected: 0 };
  try {
    const status = realtimeListener.getStatus();
    const ids = Object.keys(status);
    devices.total = ids.length;
    devices.connected = ids.filter((id) => status[id].status === 'connected').length;
  } catch {}
  res.json(shapeStartupStatus({
    dbConnected: ready && dbConnectedLatched,
    servicesStarted: ready && startupState.servicesStarted,
    devices,
    ready,
    ...(ready ? {} : { startup: startup.describe() }),
  }, isDirectLocalRequest(req)));
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
// Single classification point shared with every route (utils/apiError.js): client
// mistakes → 4xx, server faults → 500, never raw Prisma/internal text.
app.use((err, _req, res, _next) => {
  sendError(res, err);
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  logger.info(`[SOCKET] CONNECT ${socket.id}`);

  socket.conn.on("upgrade", () => {
    logger.info(`[ENGINE] UPGRADE ${socket.id}`);
  });

  socket.conn.on("close", (reason) => {
    logger.warn(`[ENGINE] CLOSE ${socket.id} reason=${reason}`);
  });

  socket.on("disconnect", (reason) => {
    logger.warn(`[SOCKET] DISCONNECT ${socket.id} reason=${reason}`);
  });
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
// SECURITY (Phase 25.1 F2 restored): binding IS now coupled to authentication — see the security gate near
// the top of this file and config/securityConfig.js. Auth disabled → loopback only (HOST unset =
// 127.0.0.1; an explicit LAN HOST aborts startup). Auth enabled → HOST unset = 0.0.0.0 (LAN server).
const HOST = secureBind.host;

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

// ─── Application lifecycle ────────────────────────────────────────────────────
//
//   load env → [module load: Express/Socket.IO objects, routers — nothing listens,
//   nothing runs] → bootstrap (database reachable → `prisma migrate deploy` →
//   independent baseline seed) → ONLY IF the bootstrap result is ok:
//   listen → mark READY → services (scheduler, device listeners, crons,
//   interrupted-rebuild resume).
//
// The bootstrap result is authoritative (init/bootstrapResult.js). A failed
// migration is never started over: no listener, no scheduler, no device
// connection, no background job — the process exits with EXIT_STARTUP_BLOCKED.
// An unreachable database gets a deliberately LIMITED listener (liveness,
// readiness and the Database Setup Wizard only — see init/startupState.js),
// because repairing DATABASE_URL from the UI needs a live backend; it is never
// READY and never starts a service. Neither case retries in the background:
// the next application restart re-runs the bootstrap.
const { runFirstRunInit } = require('./init');

async function exitStartupBlocked() {
  try { await disconnectPrisma(); } catch { /* exiting anyway */ }
  await new Promise((r) => setTimeout(r, 300));   // let the log transports flush
  process.exit(EXIT_STARTUP_BLOCKED);
}

function blockStartup(boot) {
  startup.markBlocked(boot);
  logger.error(`[STARTUP-BLOCKED] stage=${boot.stage} reason=${boot.reason} — application NOT started: no scheduler, no device listeners, no background jobs`);

  if (boot.stage === STAGE.DATABASE) {
    server.listen(PORT, HOST, () => {
      logger.warn(`[STARTUP-BLOCKED] limited recovery mode on ${HOST}:${PORT} — only /api/health, /api/startup-status and /api/setup are served; restart the application to retry`);
    });
    return;
  }
  // Schema state is failed or unverified — fail closed, never serve.
  exitStartupBlocked();
}

function startApplication() {
  server.listen(PORT, HOST, () => {
    logger.info(`Server running on ${HOST}:${PORT} [${isProd ? 'production' : 'development'}]`);
    startup.markReady();

    // Refresh the company-settings snapshot (cache.json, read by the Electron
    // splash) — a DB read, so only after the schema is verified.
    require('./services/companySettingsStore').refreshSnapshot().catch(() => {});

    // Background services start only here: the schema was verified before
    // listen() was called. setImmediate lets this callback return first.
    // syncScheduler is the SINGLE owner of attendance processing crons — the
    // old separate attendanceProcessor (a duplicate 15-min processToday path
    // racing the scheduler's 10-min one) has been removed.
    setImmediate(() => {
      // Phase 31: SKIP_SCHEDULER=true lets a second backend process share the
      // same production MySQL database (same DATABASE_URL) purely as an
      // API/auth endpoint — e.g. the public-tunnel instance — without also
      // starting a second set of ZKTeco device TCP connections and
      // attendance-processing crons. syncScheduler is already documented
      // above as the SINGLE owner of that work; running it twice against one
      // DB would mean duplicate device connections and racing recalculation
      // jobs, not just wasted work. Unset (default) is byte-for-byte the
      // existing single-instance behavior — every current deployment is
      // unaffected.
      if (isSkipSchedulerInstance()) {
        logger.info('[SKIP_SCHEDULER] set — this instance will not start ZKTeco listeners or attendance crons (API/auth only)');
        startupState.servicesStarted = true;
        return;
      }

      try { startSyncScheduler(io); }
      catch (err) { logger.error('SyncScheduler error:', err.message); }
      finally { startupState.servicesStarted = true; }

      // Crash safety: resume any historical rebuild job left 'running' by a
      // process that died mid-run (see historicalRebuildService.js).
      historicalRebuildService.resumeInterruptedJobs(io)
        .catch((err) => logger.error(`[HIST-REBUILD] resume error: ${err.message}`));
    });
  });
}

(async () => {
  const boot = await runFirstRunInit();
  if (!boot.ok) return blockStartup(boot);
  if (boot.seed === 'failed') logger.warn('[STARTUP] baseline seed incomplete — application starting; seeding retries on next startup');
  startApplication();
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

  try { socketSessionGuard.stop(); } catch {}
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
    // Line protocol from the Electron main process: "shutdown", and ONE "setup-secret <value>" hand-off per launch (utils/setupAuth.js).
    // The hand-off line is consumed here and never logged or echoed.
    const setupAuth = require('./utils/setupAuth');
    const feedStdin = require('./utils/stdinCommands').createStdinCommandParser({
      handleHandoffLine: (line) => setupAuth.handleStdinLine(line),   // acknowledges on stdout with a one-way tag, never the secret
      onShutdown: () => shutdown('stdin command'),
    });
    process.stdin.on('data', feedStdin);
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
