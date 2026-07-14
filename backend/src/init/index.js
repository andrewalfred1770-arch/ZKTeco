/**
 * init/index.js — first-run initialization orchestrator (EP-007).
 *
 * Called once from backend/src/index.js, awaited before server.listen() —
 * this is what makes Electron's existing readiness poll (which already
 * waits on /api/startup-status before closing the splash) correctly wait
 * for initialization too: nothing answers on the HTTP port until this
 * resolves. No changes to Electron's lifecycle/splash code were needed.
 *
 * Never throws — a failure here is always logged as a friendly message and
 * the server still starts (so /api/health can report real status instead
 * of the process dying outright).
 */
const { ensureFolders } = require('./ensureFolders');
const { runMigrationsAndSeed } = require('./migrateAndSeed');
const { logInit } = require('./firstRunLog');

async function runFirstRunInit() {
  logInit('Initializing...');
  try {
    ensureFolders();
    await runMigrationsAndSeed();
  } catch (err) {
    // Belt-and-suspenders — migrateAndSeed already catches its own errors,
    // but nothing in this path may ever crash the process or leak a stack.
    logInit('Initialization encountered an unexpected issue — the server will continue starting; some setup steps may retry on next launch.');
  }
  logInit('Initialization completed.');
}

module.exports = { runFirstRunInit };
