/**
 * init/index.js — first-run initialization orchestrator (EP-007).
 *
 * Called once from backend/src/index.js and awaited before anything is
 * started. Returns a BootstrapResult (bootstrapResult.js) — it NEVER throws and
 * NEVER hides a failure: an unreachable database, a failed migration, or an
 * unexpected exception all come back as `{ ok:false, stage, reason }`, and
 * the caller (src/index.js) is the single place that decides what that means
 * for the process. Nothing here starts any service.
 */
const { ensureFolders } = require('./ensureFolders');
const { runMigrationsAndSeed, redactSecrets } = require('./migrateAndSeed');
const { logInit } = require('./firstRunLog');
const { STAGE, REASON, blocked } = require('./bootstrapResult');

async function runFirstRunInit() {
  logInit('Initializing...');

  // Folder creation is not schema state — a failure here is logged, not fatal.
  try {
    ensureFolders();
  } catch (err) {
    logInit(`Could not prepare data folders (${redactSecrets(err && err.message)}) — continuing.`);
  }

  let result;
  try {
    result = await runMigrationsAndSeed();
  } catch (err) {
    // Unexpected (the steps catch their own expected failures). Fail closed:
    // never let an unknown bootstrap state look like a successful one.
    const detail = redactSecrets(err && err.message) || 'unknown error';
    logInit(`Initialization failed unexpectedly: ${detail}`);
    result = blocked(STAGE.BOOTSTRAP, REASON.UNEXPECTED, detail);
  }

  if (result.ok) logInit(result.seed === 'failed' ? 'Initialization completed (baseline seed incomplete — will retry on next startup).' : 'Initialization completed.');
  else logInit(`Initialization BLOCKED (${result.stage}: ${result.reason}) — the application will not start normally.`);
  return result;
}

module.exports = { runFirstRunInit };
