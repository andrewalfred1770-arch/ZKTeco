/**
 * configDir.js — persistent configuration root (EP-010).
 *
 * Electron's main process (frontend/electron/backend.js) sets CONFIG_DIR to
 * the persistent %APPDATA%/PETSHROW ERP/ directory before spawning this
 * backend in Local Mode, so .env/logs/backups/exports/uploads survive a
 * Portable re-extraction or a Setup reinstall (both of which discard
 * anything left inside resources/backend).
 *
 * When CONFIG_DIR is unset — Server Mode, `npm run dev`, tests — this falls
 * back to exactly the pre-EP-010 behavior (backend root), so nothing changes
 * for any environment that doesn't opt in.
 */
const path = require('path');

const BACKEND_ROOT = path.join(__dirname, '..', '..');

function getConfigDir() {
  return process.env.CONFIG_DIR || BACKEND_ROOT;
}

module.exports = { getConfigDir, BACKEND_ROOT };
