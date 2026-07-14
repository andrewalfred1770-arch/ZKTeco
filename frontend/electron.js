/**
 * Electron main process — Optimized for fast startup (3-8s target)
 * Key: BrowserWindow created IN PARALLEL with backend health check.
 *      The React app renders immediately; APIs load async in the background.
 *
 * EF-008 Phase 4: this file is now a thin bootstrap. All implementation lives
 * in ./electron/*.js, split by responsibility (see EF-008 Phase 4 certification
 * for the full map). Import order below matches the original file's top-to-
 * bottom execution order exactly:
 *   1. observability.js — pipe-teardown guards, file log, exception handlers
 *      (side effects that must be installed before anything else can throw)
 *   2. ipc.js — registers every ipcMain handler (was top-level in the
 *      original file, registered before the single-instance lock / 'ready')
 *   3. lifecycle.js — single-instance lock + all app.on(...) registrations
 *      (splash/window/tray/backend orchestration happens inside 'ready')
 */
import './electron/observability.js';
import './electron/ipc.js';
import './electron/lifecycle.js';
