/**
 * migrateAndSeed.js — idempotent DB bootstrap (EP-007 Tasks 4, 5, 6, 12).
 *
 * Three independent steps (see the section below): database reachability,
 * `prisma migrate deploy` (runs on EVERY startup — Prisma's migration history
 * is the sole authority for schema state), and a one-time baseline seed.
 * backend/.initialized.json only records that seeding completed (and that a
 * deploy once succeeded, for log wording); it never decides whether migrations
 * run. The outcome is a BootstrapResult (bootstrapResult.js) that the caller
 * must honor — a failed migration or unreachable database blocks startup.
 *
 * Only the two baseline/config seeders are ever run automatically:
 * seed-rules.js, seed-company-settings.js. prisma/seed.js
 * (fake demo employees + randomly generated attendance) is a developer/demo
 * tool only — it is intentionally NEVER invoked here, since auto-seeding
 * fictional employees into a real customer's database would be wrong.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { logInit } = require('./firstRunLog');
const { checkDbConnection, getPrisma } = require('../utils/prisma');
const { getConfigDir, BACKEND_ROOT } = require('../utils/configDir');
const { STAGE, REASON, SEED, ready, blocked } = require('./bootstrapResult');

// EP-010: the marker is runtime STATE (must survive Portable re-extraction),
// so it lives in the persistent config dir. The seeder scripts below are
// CODE, not state — they stay relative to BACKEND_ROOT (resources/backend),
// which is exactly where they're packaged.
const MARKER_PATH = path.join(getConfigDir(), '.initialized.json');

const BASELINE_SEEDERS = [
  path.join(BACKEND_ROOT, 'prisma', 'seed-rules.js'),
  path.join(BACKEND_ROOT, 'prisma', 'seed-company-settings.js'),
];

function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(MARKER_PATH, 'utf8'));
  } catch {
    return { migrated: false, seeded: false };
  }
}

function writeMarker(patch) {
  const merged = { ...readMarker(), ...patch, updatedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(MARKER_PATH, JSON.stringify(merged, null, 2), 'utf8');
  } catch {
    // Non-fatal — worst case the next startup re-checks (migrate/seed are
    // idempotent anyway) instead of skipping.
  }
  return merged;
}

// Strips anything that could be a credential/secret out of diagnostic text
// before it's ever passed to logInit() (firstRunLog.js does no redaction of
// its own — callers are solely responsible, per its own header comment).
// Covers: connection-string user:pass@ segments (any scheme, e.g.
// mysql://user:pass@host), and password=/pwd=/--password=/PRIVATE KEY-style
// key=value or CLI-flag patterns Prisma/mysql tooling commonly emit in
// error output.
function redactSecrets(text) {
  if (!text) return text;
  return String(text)
    .replace(/(:\/\/[^:@/\s]+:)[^@\s]+(@)/gi, '$1***$2')
    .replace(/(--password=|password\s*[:=]\s*["']?)[^\s"'&]+/gi, '$1***')
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gi, '***REDACTED PRIVATE KEY***');
}

// Formats an execFileSync CatchError's diagnostic fields (message, captured
// stderr/stdout, exit status/signal) into one redacted, single-purpose log
// line — never the raw error object, so nothing unredacted can slip through
// via console.log(err) or similar.
function describeExecError(err) {
  const parts = [redactSecrets(err.message || String(err))];
  if (err.status !== undefined && err.status !== null) parts.push(`exitCode=${err.status}`);
  if (err.signal) parts.push(`signal=${err.signal}`);
  const stderr = err.stderr && err.stderr.length ? redactSecrets(err.stderr.toString()).trim() : '';
  const stdout = err.stdout && err.stdout.length ? redactSecrets(err.stdout.toString()).trim() : '';
  if (stderr) parts.push(`stderr="${stderr}"`);
  if (stdout) parts.push(`stdout="${stdout}"`);
  return parts.join(' | ');
}

/** Runs `prisma migrate deploy` in-process via Node (no npx/shell needed). Returns its stdout. */
function runMigrateDeploy() {
  const prismaCli = require.resolve('prisma/build/index.js');
  return execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: BACKEND_ROOT,
    env: process.env,
    stdio: 'pipe',
    timeout: 60000,
  });
}

function runSeeder(scriptPath) {
  execFileSync(process.execPath, [scriptPath], {
    cwd: BACKEND_ROOT,
    env: process.env,
    stdio: 'pipe',
    timeout: 30000,
  });
}

/** True when the schema has no company rows yet — i.e. genuinely empty. */
async function isDatabaseEmpty() {
  const prisma = getPrisma();
  const count = await prisma.company.count();
  return count === 0;
}

// ─── The bootstrap is three INDEPENDENT steps ────────────────────────────────
//   1. checkDatabase()    — is the database reachable?
//   2. applyMigrations()  — `prisma migrate deploy`. Prisma's own
//                           _prisma_migrations table is the ONLY authority for
//                           schema state; the marker is never consulted to decide
//                           whether to run it, and is written only AFTER a
//                           successful deploy (informational: log wording).
//   3. runSeedStep()      — one-time baseline seed, gated by marker.seeded only.
// Steps 1–2 decide whether the application may start (see bootstrapResult.js);
// step 3 cannot influence that decision and cannot mark migrations done.

/** Step 1. Returns a blocked result, or null when the database is reachable. */
async function checkDatabase() {
  logInit('Connecting database...');
  if (await checkDbConnection()) return null;
  logInit('Database unavailable — please verify MySQL is running and DATABASE_URL in backend/.env is correct. The application will NOT start normally; restart to retry.');
  return blocked(STAGE.DATABASE, REASON.DB_UNREACHABLE);
}

/**
 * Step 2. Runs on EVERY startup — `prisma migrate deploy` is a no-op when
 * nothing is pending, and it is the only way an update that ships a new
 * migration ever reaches an existing install (the marker lives in the
 * persistent config dir and survives updates). Returns a blocked result, or
 * null once the schema is verified up to date.
 */
function applyMigrations(marker) {
  try {
    logInit(marker.migrated ? 'Checking for pending database migrations...' : 'Applying database migrations...');
    const deployOut = String(runMigrateDeploy() || '');
    if (!marker.migrated) writeMarker({ migrated: true });   // only after a successful deploy
    logInit(/No pending migrations/i.test(deployOut) ? 'Database schema is up to date.' : 'Database migrations applied.');
    return null;
  } catch (err) {
    // The friendly status line stays first — the diagnostic line right after
    // it is the actual failure detail (message/exit status/signal/stderr/
    // stdout), passed through redactSecrets() first so credentials/DATABASE_URL
    // passwords/private keys never reach the log.
    const detail = describeExecError(err);
    logInit('Database migration failed — please check that MySQL is reachable and DATABASE_URL is correct. The application will NOT start; fix the cause and restart to retry.');
    logInit(`[DIAGNOSTIC] migrate deploy error: ${detail}`);
    return blocked(STAGE.MIGRATION, REASON.MIGRATE_FAILED, detail);
  }
}

/** Step 3. Never throws; reports 'done' | 'skipped' | 'failed'. */
async function runSeedStep(marker) {
  if (marker.seeded) return SEED.SKIPPED;
  try {
    const empty = await isDatabaseEmpty();
    if (empty) {
      logInit('Seeding default configuration (rules, company settings)...');
      for (const seeder of BASELINE_SEEDERS) runSeeder(seeder);
      logInit('Default configuration seeded.');
    } else {
      logInit('Existing data found — skipping baseline seeding.');
    }
    writeMarker({ seeded: true });
    return empty ? SEED.DONE : SEED.SKIPPED;
  } catch (err) {
    logInit('Baseline seeding failed — the application can still run, but default rules/company settings may be incomplete. Seeding will be retried on next startup.');
    return SEED.FAILED;
  }
}

/**
 * Runs the bootstrap and returns a BootstrapResult (see bootstrapResult.js).
 * Never throws for expected failures; the caller MUST honor `result.ok`.
 */
async function runMigrationsAndSeed() {
  const dbBlock = await checkDatabase();
  if (dbBlock) return dbBlock;

  const marker = readMarker();

  const migrationBlock = applyMigrations(marker);
  if (migrationBlock) return migrationBlock;     // never reaches the seed step

  return ready({ seed: await runSeedStep(marker) });
}

module.exports = { runMigrationsAndSeed, redactSecrets };
