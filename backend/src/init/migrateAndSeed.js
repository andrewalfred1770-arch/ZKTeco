/**
 * migrateAndSeed.js — idempotent DB bootstrap (EP-007 Tasks 4, 5, 6, 12).
 *
 * Marker file backend/.initialized.json gates each phase so a normal
 * (already-configured) startup never re-shells into `prisma migrate deploy`
 * or the seed scripts — both are also independently idempotent by design
 * (migrate deploy only applies pending migrations; the three baseline
 * seeders below upsert-by-key and only touch fields not already user-edited),
 * so the marker is a fast-path, not the only safety net.
 *
 * Only the three baseline/config seeders are ever run automatically:
 * seed-rules.js, seed-company-settings.js, seed-policy.js. prisma/seed.js
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

// EP-010: the marker is runtime STATE (must survive Portable re-extraction),
// so it lives in the persistent config dir. The seeder scripts below are
// CODE, not state — they stay relative to BACKEND_ROOT (resources/backend),
// which is exactly where they're packaged.
const MARKER_PATH = path.join(getConfigDir(), '.initialized.json');

const BASELINE_SEEDERS = [
  path.join(BACKEND_ROOT, 'prisma', 'seed-rules.js'),
  path.join(BACKEND_ROOT, 'prisma', 'seed-company-settings.js'),
  path.join(BACKEND_ROOT, 'prisma', 'seed-policy.js'),
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

/** Runs `prisma migrate deploy` in-process via Node (no npx/shell needed). */
function runMigrateDeploy() {
  const prismaCli = require.resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
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

/**
 * Verifies the DB is reachable, then (once, idempotently) applies pending
 * migrations and seeds baseline config — never throws, never crashes the
 * process; any failure is logged as a friendly message and the marker is
 * left unset so the next startup retries.
 */
async function runMigrationsAndSeed() {
  logInit('Connecting database...');
  const dbUp = await checkDbConnection();
  if (!dbUp) {
    logInit('Database unavailable — please verify MySQL is running and DATABASE_URL in backend/.env is correct. Will retry on next startup.');
    return { ok: false, reason: 'db-unreachable' };
  }

  const marker = readMarker();

  if (!marker.migrated) {
    try {
      logInit('Applying database migrations...');
      runMigrateDeploy();
      writeMarker({ migrated: true });
      logInit('Database migrations applied.');
    } catch (err) {
      // The friendly status line stays first (unchanged) — the diagnostic
      // line right after it is the actual failure detail (message/exit
      // status/signal/stderr/stdout), passed through redactSecrets() first
      // so credentials/DATABASE_URL passwords/private keys never reach the
      // log, only the failure shape itself (needed to tell a missing-binary
      // error apart from a real connection/timeout/schema error).
      logInit('Database migration failed — please check that MySQL is reachable and DATABASE_URL is correct. Will retry on next startup.');
      logInit(`[DIAGNOSTIC] migrate deploy error: ${describeExecError(err)}`);
      return { ok: false, reason: 'migrate-failed' };
    }
  }

  if (!marker.seeded) {
    try {
      const empty = await isDatabaseEmpty();
      if (empty) {
        logInit('Seeding default configuration (rules, company settings, attendance policy)...');
        for (const seeder of BASELINE_SEEDERS) runSeeder(seeder);
        logInit('Default configuration seeded.');
      } else {
        logInit('Existing data found — skipping baseline seeding.');
      }
      writeMarker({ seeded: true });
    } catch (err) {
      logInit('Baseline seeding failed — the application can still run, but default rules/company settings may be incomplete.');
      return { ok: false, reason: 'seed-failed' };
    }
  }

  return { ok: true };
}

module.exports = { runMigrationsAndSeed };
