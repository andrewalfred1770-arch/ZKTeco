/**
 * bootstrapResult.js — the typed contract between the database bootstrap
 * (init/migrateAndSeed.js → init/index.js) and the application lifecycle
 * (src/index.js).
 *
 * A BootstrapResult is always one of:
 *
 *   { ok: true,  stage: 'ready',    reason: null,   seed: 'done'|'skipped'|'failed' }
 *   { ok: false, stage: 'database' | 'migration' | 'bootstrap', reason, detail? }
 *
 * `ok` answers exactly ONE question: "is the database reachable and its schema
 * fully migrated, so the application may start?". Seeding is deliberately NOT
 * part of that answer — it is reported separately in `seed` — and the
 * `.initialized.json` marker never contributes to it (Prisma's own migration
 * history is the only authority for schema state).
 *
 * No caller may discard a result: src/index.js is the single consumer and
 * refuses to start the application (scheduler, device listeners, background
 * jobs, Socket.IO clients, business routes) unless `ok` is true.
 */

/** Process exit status for "the application was deliberately not started because
 *  its database is not in a verified-good state" (EX_CONFIG, sysexits.h).
 *  MUST stay in sync with BACKEND_EXIT_STARTUP_BLOCKED in frontend/electron/constants.js,
 *  which uses it to avoid auto-restarting a backend that will only fail the same way. */
const EXIT_STARTUP_BLOCKED = 78;

const STAGE = Object.freeze({
  READY:     'ready',
  DATABASE:  'database',    // database unreachable — schema state unknown
  MIGRATION: 'migration',   // reachable, but `prisma migrate deploy` failed
  BOOTSTRAP: 'bootstrap',   // unexpected exception in the bootstrap itself
});

const REASON = Object.freeze({
  DB_UNREACHABLE: 'db-unreachable',
  MIGRATE_FAILED: 'migrate-failed',
  UNEXPECTED:     'unexpected-error',
});

const SEED = Object.freeze({ DONE: 'done', SKIPPED: 'skipped', FAILED: 'failed' });

function ready({ seed = SEED.SKIPPED } = {}) {
  return { ok: true, stage: STAGE.READY, reason: null, seed };
}

function blocked(stage, reason, detail = null) {
  const r = { ok: false, stage, reason };
  if (detail) r.detail = String(detail).slice(0, 500);   // callers pass already-redacted text only
  return r;
}

module.exports = { EXIT_STARTUP_BLOCKED, STAGE, REASON, SEED, ready, blocked };
