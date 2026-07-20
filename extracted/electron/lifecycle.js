import { appendFileSync } from 'fs';
import { app } from 'electron';
import { existsSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { IS_DEV, BUILD_MARKER } from './constants.js';
import { state } from './state.js';
import { getPaths } from './paths.js';
import { killStaleBackend, startBackend, fetchStartupStatus, requestBackendShutdown } from './backend.js';
import { createSplash, closeSplash, markSplashStep, isSplashStepDone, notifyRenderer } from './splash.js';
import { createMainWindow } from './windows.js';
import { buildDebugMenu, createTray } from './tray.js';
import { initUpdater } from './updater.js';
import { readConnectionSettings, getEffectiveBackendBaseUrl } from './connectionSettings.js';

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
  const connectionSettings = readConnectionSettings();
  state.connectionMode  = connectionSettings.mode === 'server' ? 'server' : 'local';
  state.backendBaseUrl  = getEffectiveBackendBaseUrl(connectionSettings);
  console.log(`[Electron] Connection mode: ${state.connectionMode} → ${state.backendBaseUrl}`);

  // 1. Splash — instant, functional checklist (real status, no fake progress)
  createSplash();

  // 2. Main window — created + shown immediately. Frontend content loads
  //    async in the background; this call does NOT block on it.
  appendFileSync("C:\\temp\\electron-trace.txt", "BEFORE\n");

await createMainWindow(paths);

appendFileSync("C:\\temp\\electron-trace.txt", "AFTER\n");
  buildDebugMenu();

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
          const { readdirSync } = await import('fs');
          const jsEntry = readdirSync(assetsDir).find(f => /^index-.*\.js$/.test(f));
          if (jsEntry) {
            bundleFile = jsEntry;
            const { createHash } = await import('crypto');
            bundleHash = createHash('md5').update(readFileSync(join(assetsDir, jsEntry))).digest('hex');
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
  if (state.connectionMode === 'local') {
    (async () => {
      await killStaleBackend();
      startBackend(paths);
    })().catch(err => console.error('[Electron] backend init error:', err.message));
  } else {
    console.log('[Electron] Server Mode — skipping local backend spawn, connecting to', state.backendBaseUrl);
  }

  // 5. Readiness poller — drives the splash checklist AND the Progressive
  //    App Readiness events (UI / Backend / Realtime / Device). Polls
  //    /api/startup-status every 300ms; closes the splash once everything
  //    that *can* be ready is ready, or after HARD_TIMEOUT_MS regardless —
  //    a slow/offline fingerprint device must never hold the splash open.
  const HARD_TIMEOUT_MS = 6000;
  const POLL_MS = 300;
  let backendNotified = false, realtimeNotified = false, deviceNotified = false;

  const pollReadiness = async () => {
    const elapsed = Date.now() - t0;
    const status = await fetchStartupStatus(400, state.backendBaseUrl);

    if (status) {
      if (status.dbConnected) markSplashStep(1, true);
      if (status.servicesStarted) markSplashStep(2, true);

      if (status.dbConnected && !backendNotified) {
        backendNotified = true;
        state.backendReady = true;
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

    if ((coreReady && isSplashStepDone(0)) || elapsed > HARD_TIMEOUT_MS) {
      if (elapsed > HARD_TIMEOUT_MS && !coreReady) {
        console.warn('[Electron] Startup hard-timeout reached — closing splash, services continue in background');
        if (state.connectionMode === 'server' && !backendNotified) {
          console.warn(`[Electron] Server Mode: never reached ${state.backendBaseUrl} — check Connection Settings`);
          notifyRenderer('connection-unreachable');
        }
      }
      notifyRenderer('system-ready');
      closeSplash();
      console.log(`[Electron] Total startup: ${Date.now() - t0}ms`);
      return;
    }
    setTimeout(pollReadiness, POLL_MS);
  };
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
app.on('before-quit', (e) => {
  app.isQuitting = true;

  // Graceful, deterministic backend shutdown:
  //  1. hold the quit, ask the backend to shut down via stdin ("shutdown"),
  //  2. backend stops crons + listeners, closes the server, flushes Prisma,
  //  3. on child exit (or after a 4s ceiling) finish quitting; force-kill
  //     only as the last resort. If the pipe is already dead (backend crashed
  //     or mid-restart), skip the write entirely and just finish.
  const p = state.backendProcess;
  if (p && !backendShutdownDone && p.exitCode === null) {
    e.preventDefault();
    console.log('[Electron] Before-quit: requesting graceful backend shutdown');

    const finish = () => {
      if (backendShutdownDone) return;
      backendShutdownDone = true;
      state.backendProcess = null;
      app.quit();
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
  } else {
    console.log('[Electron] Before-quit: no live backend to stop');
  }
});
