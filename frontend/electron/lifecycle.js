import { app } from 'electron';
import { existsSync } from 'fs';
import { join } from 'path';
import { IS_DEV, BUILD_MARKER } from './constants.js';
import { state } from './state.js';
import { getPaths } from './paths.js';
import { killStaleBackend, startBackend, fetchStartupStatus, requestBackendShutdown } from './backend.js';
import { createSplash, closeSplash, markSplashStep, isSplashStepDone, notifyRenderer } from './splash.js';
import { createMainWindow } from './windows.js';
import { buildDebugMenu, createTray } from './tray.js';
import { initUpdater } from './updater.js';
import { readConnectionSettings, getEffectiveBackendBaseUrl, isSelfPointingServerUrl } from './connectionSettings.js';
import { isStandalone } from './edition.js';
import { ensureDataDir, startMysql, waitForReady as waitForMysqlReady, getConnectionEnv, requestMysqlShutdown } from './mysqlManager.js';
import { createBackup, shouldRunScheduledBackup } from './standaloneBackup.js';

// ─── Single instance lock ─────────────────────────────────────────────────────
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  console.log('[Electron] Another instance detected — quitting');
  app.quit();
} else {
  app.on('second-instance', () => {
    state.mainWindow?.show();
    state.mainWindow?.focus();
    state.mainWindow?.maximize();
  });
}

// ─── App lifecycle — PARALLEL STARTUP ────────────────────────────────────────
app.on('ready', async () => {
  console.log("READY 1");

  if (!gotInstanceLock) {
    console.log("READY LOCK FAILED");
    return;
  }

  console.log("READY 2");
  // 'ready' still fires after app.quit() from a failed single-instance lock.
  // Without this guard, the losing instance's killStaleBackend() can ping the
  // PRIMARY instance's backend (1s timeout) and taskkill it on a slow reply —
  // e.g. mid-sync while the event loop is stalled parsing a device buffer.
  if (!gotInstanceLock) return;

  const t0    = Date.now();
  const paths = getPaths();

  // 0. Resolve Local vs Server mode (EP-003 Hybrid Client/Server) — read once,
  //    for the whole session. Local Mode (default) is byte-identical to the
  //    pre-EP-003 startup flow below. Server Mode skips spawning a backend
  //    entirely and points every downstream check at the configured remote.
  console.log('[Startup] loading connection settings');
  // Root cause of the old two-read guard's occasional wrong answer: right
  // after a prior instance's process handle closes (e.g. a rapid kill +
  // relaunch), a read of connection-settings.json can transiently observe
  // stale/incoherent OS-level file-cache state for one read and settle to
  // the true on-disk content shortly after — reproduced live where the file
  // said 'local' throughout, yet a same-tick reread once returned 'server'.
  // Trusting "whichever read came last" (the old guard) is exactly wrong
  // for this failure mode, since the bad value can just as easily land on
  // the second read as the first. Server Mode with no backend spawned is
  // the worst possible outcome (the app is unusable), so resolution here is
  // deliberately asymmetric and local-biased: three independent reads, each
  // separated by a short settling delay, and 'server' is only trusted if
  // ALL three agree — any disagreement at all falls back to 'local', the
  // safe default that always spawns a backend.
  const reads = [readConnectionSettings()];
  await new Promise((r) => setTimeout(r, 50));
  reads.push(readConnectionSettings());
  await new Promise((r) => setTimeout(r, 50));
  reads.push(readConnectionSettings());

  const modes = reads.map((r) => r.mode);
  const unanimousServer = modes.every((m) => m === 'server');
  if (!unanimousServer && modes.some((m) => m === 'server')) {
    console.warn(`[Startup] connection mode disagreement across reads (${modes.join(', ')}) — forcing local (safe default)`);
  }
  const resolvedSettings = unanimousServer ? reads[reads.length - 1] : { ...reads[reads.length - 1], mode: 'local' };

  // Self-pointing guard: Server Mode aimed at this same machine (localhost,
  // 127.0.0.1/::1, or one of this machine's own interface IPs) can never
  // work — this instance never spawns a backend in Server Mode, so it would
  // just poll a URL nothing is listening on. Force local instead, which does
  // spawn one. Must run before the spawn-skip decision below.
  if (resolvedSettings.mode === 'server' && isSelfPointingServerUrl(resolvedSettings.serverUrl)) {
    console.warn(`[Startup] Server Mode serverUrl (${resolvedSettings.serverUrl}) points at this machine — forcing local mode`);
    resolvedSettings.mode = 'local';
  }

  state.connectionMode  = resolvedSettings.mode === 'server' ? 'server' : 'local';
  state.backendBaseUrl  = getEffectiveBackendBaseUrl(resolvedSettings);
  console.log(`[Startup] resolved mode=${state.connectionMode}`);
  console.log(`[Electron] Connection mode: ${state.connectionMode} → ${state.backendBaseUrl}`);

  // 1. Splash — instant, functional checklist (real status, no fake progress)
  createSplash();

  // 2. Main window — created + shown immediately. Frontend content loads
  //    async in the background; this call does NOT block on it.
 console.log("BEFORE createMainWindow");
createMainWindow(paths);
console.log("AFTER createMainWindow");
  // 3. Tray — fast, no I/O
  createTray(paths);

  // 3.5. Auto Update System (EP-001) — registers IPC + electron-updater
  //      listeners only; the actual network check is deferred (see
  //      updater.js) so it never competes with startup for I/O.
  try { initUpdater(); } catch (err) { console.error('[Electron] updater init failed:', err.message); }

  // ─── Startup diagnostics — proves which build is actually loaded at runtime ──
  // (executable path, app.asar path, frontend bundle hash, timestamp). Printed
  // to the console/log on every launch so a stale-build question can be
  // answered by reading the log instead of guessing. Runs in the background —
  // hashing the bundle must never delay the window appearing.
  (async () => {
    try {
      const appAsarPath = IS_DEV ? null : join(process.resourcesPath, 'app.asar');
      let bundleHash = null, bundleFile = null;
      if (paths.frontendDist) {
        const assetsDir = join(paths.frontendDist, 'assets');
        if (existsSync(assetsDir)) {
          const { readdir, readFile } = await import('fs/promises');
          const files = await readdir(assetsDir);
          const jsEntry = files.find(f => /^index-.*\.js$/.test(f));
          if (jsEntry) {
            bundleFile = jsEntry;
            const { createHash } = await import('crypto');
            bundleHash = createHash('md5').update(await readFile(join(assetsDir, jsEntry))).digest('hex');
          }
        }
      }
      console.log('═══════════════════════════════════════════════════════════');
      console.log('[Startup Diagnostics]');
      console.log(`  buildMarker    : ${BUILD_MARKER}`);
      console.log(`  executablePath : ${process.execPath}`);
      console.log(`  appAsarPath    : ${appAsarPath || '(dev mode — no asar)'}`);
      console.log(`  frontendDist   : ${paths.frontendDist || '(dev — served by Vite)'}`);
      console.log(`  bundleFile     : ${bundleFile || '—'}`);
      console.log(`  bundleHashMd5  : ${bundleHash || '—'}`);
      console.log(`  appVersion     : ${app.getVersion()}`);
      console.log(`  startupTime    : ${new Date().toISOString()}`);
      console.log('═══════════════════════════════════════════════════════════');
    } catch (e) { console.log('[Startup Diagnostics] failed:', e.message); }
  })();

  // 4. Backend lifecycle — fully decoupled from the window. Stale-process
  //    cleanup + spawn happen in the background; the window is already on
  //    screen and interactive regardless of how long this takes.
  //    Server Mode (EP-003): Electron never spawns a backend here — the
  //    configured remote server is expected to already be running. The
  //    readiness poller below still confirms it's actually reachable.
  if (state.connectionMode === 'local' && isStandalone) {
    console.log('[Startup] Mac Standalone — starting managed local MySQL');
    (async () => {
      await killStaleBackend(paths);
      let bootstrap;
      try {
        bootstrap = ensureDataDir();
      } catch (err) {
        console.error('[Electron] MySQL data directory initialization failed:', err.message);
        notifyRenderer('mysql-init-failed', { error: err.message });
        return; // do NOT proceed to spawn the backend against a DB that doesn't exist
      }
      state.mysqlCreds = bootstrap.creds;
      startMysql(bootstrap);
      const ready = await waitForMysqlReady();
      if (!ready) {
        console.error('[Electron] Managed MySQL did not become ready in time');
        notifyRenderer('mysql-init-failed', { error: 'MySQL did not become ready' });
        return;
      }
      console.log('[Electron] Managed MySQL ready — starting backend');
      notifyRenderer('mysql-ready');
      startBackend(paths, getConnectionEnv(bootstrap.creds));

      // Scheduled full-database backup, checked once/hour in-process (same
      // in-process-timer style as updater.js's own periodic checks) — never
      // relies on an OS-level cron the app can't guarantee exists on a bare
      // Mac.
      setInterval(async () => {
        try {
          if (state.mysqlCreds && shouldRunScheduledBackup()) {
            console.log('[Backup] running scheduled backup');
            await createBackup(state.mysqlCreds, { reason: 'scheduled' });
          }
        } catch (err) {
          console.error('[Backup] scheduled backup failed:', err.message);
        }
      }, 60 * 60 * 1000);
    })().catch(err => console.error('[Electron] Standalone init error:', err.message));
  } else if (state.connectionMode === 'local') {
    console.log('[Startup] backend starting');
    (async () => {
      await killStaleBackend(paths);
      startBackend(paths);
    })().catch(err => console.error('[Electron] backend init error:', err.message));
  } else {
    console.log('[Startup] backend starting — Server Mode, using remote', state.backendBaseUrl);
    console.log('[Electron] Server Mode — skipping local backend spawn, connecting to', state.backendBaseUrl);
  }

  // 5. Readiness poller — drives the splash checklist AND the Progressive
  //    App Readiness events (UI / Backend / Realtime / Device). Polls
  //    /api/startup-status every 300ms; closes the splash once everything
  //    that *can* be ready is ready, or after SPLASH_TIMEOUT_MS regardless —
  //    a slow/offline fingerprint device must never hold the splash open.
  //
  //    SPLASH_TIMEOUT_MS is cosmetic only — it closes the splash window and
  //    hands off to the renderer's own "connecting" spinner (ServerReadyGate),
  //    it is NOT a failure signal. A slow-but-healthy backend/MySQL cold
  //    start (observed: first launch after boot can legitimately take longer
  //    than 6s for MySQL to accept connections) must never be reported to the
  //    user as "تعذر الوصول إلى الخادم" just because the splash's own display
  //    budget ran out. UNREACHABLE_TIMEOUT_MS is the real failure threshold —
  //    only once startup has made no progress for this much longer does the
  //    renderer get told the backend is unreachable, and pollUntilBackendReady
  //    keeps polling forever afterward so a late-arriving backend still
  //    resolves automatically with no manual retry.
  const SPLASH_TIMEOUT_MS = 6000;
  const UNREACHABLE_TIMEOUT_MS = 20000;
  const POLL_MS = 300;
  let backendNotified = false, realtimeNotified = false, deviceNotified = false, unreachableNotified = false;

  const pollReadiness = async () => {
    const elapsed = Date.now() - t0;
    const status = await fetchStartupStatus(400, state.backendBaseUrl);

    if (status) {
      if (status.dbConnected) markSplashStep(1, true);
      if (status.servicesStarted) markSplashStep(2, true);

      if (status.dbConnected && !backendNotified) {
        backendNotified = true;
        state.backendReady = true;
        console.log('[Startup] health OK');
        console.log('[Startup] database connected');
        console.log('[Startup] server READY');
        console.log('[Startup] socket READY'); // Socket.IO shares the same HTTP server/port as the REST API just proven reachable above — no separate probe needed.
        console.log(`[Electron] Backend ready in ${Date.now() - t0}ms`);
        notifyRenderer('backend-ready');
        // Dev mode: reload so the React app picks up live data once the
        // backend is actually answering. Prod loads once and fetches on mount.
        if (IS_DEV && state.mainWindow && !state.mainWindow.isDestroyed()) {
          state.mainWindow.webContents.reload();
        }
      }

      if (status.servicesStarted && !realtimeNotified) {
        realtimeNotified = true;
        notifyRenderer('realtime-ready');
      }

      // No device configured = nothing to wait for; otherwise wait for at
      // least one realtime connection, but never longer than the hard cap.
      const deviceUp = status.devices.total === 0 || status.devices.connected > 0;
      if (deviceUp) markSplashStep(3, true);
      if (deviceUp && !deviceNotified) {
        deviceNotified = true;
        notifyRenderer('device-ready');
      }
    }

    const coreReady = isSplashStepDone(1) && isSplashStepDone(2) && isSplashStepDone(3);
    if (coreReady) markSplashStep(4, true);

    if ((coreReady && isSplashStepDone(0)) || elapsed > SPLASH_TIMEOUT_MS) {
      if (elapsed > SPLASH_TIMEOUT_MS && !coreReady) {
        console.warn('[Electron] Startup splash timeout reached — closing splash, backend still starting in background');
        if (!backendNotified) {
          // Cosmetic close only — do NOT tell the renderer the backend is
          // unreachable here. The renderer falls back to its own "connecting"
          // spinner (ServerReadyGate) until either 'backend-ready' or the
          // real failure signal below arrives from pollUntilBackendReady.
          pollUntilBackendReady();
        }
      }
      console.log('[Startup] releasing renderer bootstrap');
      notifyRenderer('system-ready');
      closeSplash();
      console.log(`[Electron] Total startup: ${Date.now() - t0}ms`);
      return;
    }
    setTimeout(pollReadiness, POLL_MS);
  };

  // Runs only if the splash's cosmetic timeout is hit before the backend
  // answers. The splash/checklist UI is already gone at this point (see
  // above); this keeps checking /api/startup-status at a relaxed interval so
  // a slow (not dead) backend still reaches every waiting renderer gate once
  // it genuinely comes up — with NO manual retry needed. Only once
  // UNREACHABLE_TIMEOUT_MS has passed with still no dbConnected does it tell
  // the renderer the backend is unreachable (once — via unreachableNotified),
  // and even then polling continues forever afterward so a backend that
  // finally comes up later still auto-resolves to 'backend-ready'.
  const BACKGROUND_POLL_MS = 1000;
  const pollUntilBackendReady = async () => {
    if (backendNotified) return;
    const status = await fetchStartupStatus(400, state.backendBaseUrl);
    if (status?.dbConnected) {
      backendNotified = true;
      state.backendReady = true;
      console.log('[Startup] health OK');
      console.log('[Startup] database connected');
      console.log('[Startup] server READY');
      console.log('[Startup] socket READY');
      console.log(`[Electron] Backend ready in ${Date.now() - t0}ms (after initial timeout)`);
      notifyRenderer('backend-ready');
      return;
    }

    if (!unreachableNotified && Date.now() - t0 > UNREACHABLE_TIMEOUT_MS) {
      unreachableNotified = true;
      console.warn(`[Startup] backend not ready after ${UNREACHABLE_TIMEOUT_MS}ms — signalling renderer, continuing to poll in background`);
      notifyRenderer('backend-unreachable');
      if (state.connectionMode === 'server') {
        console.warn(`[Electron] Server Mode: never reached ${state.backendBaseUrl} — check Connection Settings`);
        notifyRenderer('connection-unreachable');
      }
    }

    setTimeout(pollUntilBackendReady, BACKGROUND_POLL_MS);
  };

  console.log('[Startup] waiting for health');
  pollReadiness();
});

app.on('window-all-closed', () => {
  // Keep running in tray
});

app.on('activate', () => {
  if (state.mainWindow) { state.mainWindow.show(); state.mainWindow.focus(); }
  else createMainWindow(getPaths());
});

let backendShutdownDone = false;
let mysqlShutdownDone = false;

// Standalone-only: stop the managed mysqld AFTER the backend has fully
// exited (order matters — the backend must flush Prisma and close its pool
// before the database underneath it goes away). No-op for server/manager
// editions (mysqlShutdownDone just stays true-by-skip).
async function shutdownMysqlIfStandalone() {
  if (mysqlShutdownDone) return;
  mysqlShutdownDone = true;
  if (!isStandalone || !state.mysqlCreds || !state.mysqlProcess) return;
  console.log('[Electron] Before-quit: requesting graceful MySQL shutdown');
  const p = state.mysqlProcess;
  await Promise.race([
    requestMysqlShutdown(state.mysqlCreds),
    new Promise(r => setTimeout(r, 8000)),
  ]);
  await new Promise(resolve => {
    if (!p || p.exitCode !== null) return resolve();
    const t = setTimeout(() => {
      console.warn('[Electron] MySQL did not exit in time — force-killing');
      try { if (!p.killed && p.exitCode === null) p.kill('SIGKILL'); } catch {}
      resolve();
    }, 4000);
    p.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

app.on('before-quit', (e) => {
  app.isQuitting = true;

  // Graceful, deterministic backend shutdown:
  //  1. hold the quit, ask the backend to shut down via stdin ("shutdown"),
  //  2. backend stops crons + listeners, closes the server, flushes Prisma,
  //  3. on child exit (or after a 4s ceiling) finish quitting; force-kill
  //     only as the last resort. If the pipe is already dead (backend crashed
  //     or mid-restart), skip the write entirely and just finish.
  //  4. (Standalone only) once the backend is down, stop the managed mysqld
  //     the same way — graceful first, force-kill as the last resort.
  const p = state.backendProcess;
  if (p && !backendShutdownDone && p.exitCode === null) {
    e.preventDefault();
    console.log('[Electron] Before-quit: requesting graceful backend shutdown');

    const finish = () => {
      if (backendShutdownDone) return;
      backendShutdownDone = true;
      state.backendProcess = null;
      shutdownMysqlIfStandalone().finally(() => app.quit());
    };

    const killTimer = setTimeout(() => {
      console.warn('[Electron] Backend did not exit in 4s — force-killing');
      try { if (!p.killed && p.exitCode === null) p.kill('SIGKILL'); } catch {}
      finish();
    }, 4000);

    p.once('exit', (code) => {
      clearTimeout(killTimer);
      console.log(`[Electron] Backend exited gracefully (code ${code})`);
      finish();
    });

    if (!requestBackendShutdown()) {
      console.warn('[Electron] shutdown pipe unavailable — force-killing backend');
      clearTimeout(killTimer);
      try { if (!p.killed && p.exitCode === null) p.kill('SIGKILL'); } catch {}
      finish();
    }
  } else if (isStandalone && state.mysqlProcess && !mysqlShutdownDone) {
    e.preventDefault();
    console.log('[Electron] Before-quit: no live backend, stopping managed MySQL');
    shutdownMysqlIfStandalone().finally(() => app.quit());
  } else {
    console.log('[Electron] Before-quit: no live backend to stop');
  }
});
