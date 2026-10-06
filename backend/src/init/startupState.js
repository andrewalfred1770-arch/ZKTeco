/**
 * startupState.js — the application's readiness state (liveness ≠ readiness).
 *
 *   initializing → ready      bootstrap verified the schema, the app is serving
 *   initializing → blocked    bootstrap could not verify the database/schema
 *
 * "Alive" (a process answering HTTP) is deliberately separate from "ready"
 * (database reachable AND fully migrated AND business services allowed to
 * run). While not ready, startupGate() answers every business route with 503
 * and only the liveness/readiness/recovery routes stay reachable.
 *
 * Process-local, in-memory, owned by src/index.js. Nothing else writes it.
 */
const state = { phase: 'initializing', failure: null, servicesStarted: false };

function markReady() { state.phase = 'ready'; state.failure = null; }

/** @param {{stage:string, reason:string}} result a failed BootstrapResult */
function markBlocked(result) {
  state.phase = 'blocked';
  state.failure = { stage: result.stage, reason: result.reason };
}

const isReady = () => state.phase === 'ready';

/** Safe-to-expose summary (never contains connection strings or error text). */
function describe() {
  return { phase: state.phase, ...(state.failure ? { stage: state.failure.stage, reason: state.failure.reason } : {}) };
}

// Reachable while NOT ready: liveness/readiness reporting, and the Database
// Setup Wizard (EP-010.1) — the only way to repair an unreachable database
// from the UI, which needs a live backend by design.
const OPEN_WHEN_NOT_READY = [/^\/health$/, /^\/startup-status$/, /^\/setup(\/|$)/];

/** Express middleware mounted on /api before every router. */
function startupGate(req, res, next) {
  if (isReady() || OPEN_WHEN_NOT_READY.some((re) => re.test(req.path))) return next();
  res.status(503).json({
    error: 'الخادم غير جاهز — تعذّرت تهيئة قاعدة البيانات عند بدء التشغيل',
    code: 'APP_NOT_READY',
    ...describe(),
  });
}

module.exports = { state, markReady, markBlocked, isReady, describe, startupGate };
