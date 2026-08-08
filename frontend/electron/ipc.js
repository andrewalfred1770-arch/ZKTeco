import { app, ipcMain, dialog, shell, contentTracing, BrowserWindow, safeStorage } from 'electron';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, readFileSync } from 'fs';
import os from 'os';
import { join } from 'path';
import { io as socketIOClient } from 'socket.io-client';
import { IS_DEV, BUILD_MARKER, REQUIRED_API_VERSION } from './constants.js';
import { state } from './state.js';
import { fetchHealth } from './backend.js';
import { readConnectionSettings, writeConnectionSettings, getEffectiveBackendBaseUrl } from './connectionSettings.js';

// ─── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.on('app:minimize', () => state.mainWindow?.minimize());
ipcMain.on('app:maximize', () =>
  state.mainWindow?.isMaximized() ? state.mainWindow.unmaximize() : state.mainWindow.maximize()
);
ipcMain.on('app:close', () => state.mainWindow?.hide());
ipcMain.on('app:quit',  () => { app.isQuitting = true; app.quit(); });
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:is-dev',  () => IS_DEV);
ipcMain.handle('app:build-marker', () => BUILD_MARKER);
// Restarts the whole app so a saved Connection Settings change (Local ⇄
// Server) takes effect — mode is only resolved once, at startup (lifecycle.js).
ipcMain.on('app:relaunch', () => { app.relaunch(); app.exit(0); });

// ─── Connection Layer (EP-003 Hybrid Client/Server) ──────────────────────────
// The renderer never talks to these settings directly — it only ever calls
// the backend through window.electron.backendBaseUrl (set once at preload
// load from the sync getter below). These handlers exist solely for the
// Connection Settings page to read/write the persisted mode + test reachability
// of either the current settings or a candidate (not-yet-saved) one.
ipcMain.handle('connection:get-settings', () => readConnectionSettings());

ipcMain.handle('connection:set-settings', (_e, patch) => writeConnectionSettings(patch));

// Synchronous by design: preload.cjs reads this once, before the page loads,
// to expose a single static `backendBaseUrl` string — mirrors the existing
// static `backendPort` field so frontend/src/lib/api.js and socket.js don't
// need to change their "read once at import time" pattern.
ipcMain.on('connection:get-effective-base-url-sync', (e) => {
  e.returnValue = state.backendBaseUrl || getEffectiveBackendBaseUrl();
});

// ─── Session persistence (EP-011 Manager Edition auth) ───────────────────────
// Persists the JWT issued by POST /api/auth/login so a Manager Client doesn't
// force a fresh login on every launch. Encrypted at rest via Electron's
// safeStorage (OS credential vault — DPAPI on Windows, Keychain on macOS),
// stored next to connection-settings.json under the same persistent config
// directory. Never falls back to plaintext: if safeStorage isn't available on
// this OS/config, session:save silently no-ops and the renderer just prompts
// for login again on the next launch — no on-disk token in that case at all.
function sessionFile() {
  const dir = join(app.getPath('userData'), 'config');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'session.enc');
}

ipcMain.handle('session:save', (_e, token) => {
  if (!token || !safeStorage.isEncryptionAvailable()) return { ok: false };
  try {
    writeFileSync(sessionFile(), safeStorage.encryptString(token));
    return { ok: true };
  } catch (err) {
    console.warn('[Session] save failed:', err.message);
    return { ok: false };
  }
});

ipcMain.handle('session:load', () => {
  try {
    const p = sessionFile();
    if (!existsSync(p) || !safeStorage.isEncryptionAvailable()) return { token: null };
    const token = safeStorage.decryptString(readFileSync(p));
    return { token: token || null };
  } catch (err) {
    console.warn('[Session] load failed:', err.message);
    return { token: null };
  }
});

ipcMain.handle('session:clear', () => {
  try {
    const p = sessionFile();
    if (existsSync(p)) unlinkSync(p);
    return { ok: true };
  } catch (err) {
    console.warn('[Session] clear failed:', err.message);
    return { ok: false };
  }
});

function testSocketReachable(baseUrl, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    let sock;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { sock?.close(); } catch {}
      resolve(ok);
    };
    try {
      sock = socketIOClient(baseUrl, { transports: ['websocket', 'polling'], reconnection: false, timeout: timeoutMs });
      sock.on('connect', () => finish(true));
      sock.on('connect_error', () => finish(false));
    } catch { finish(false); return; }
    setTimeout(() => finish(false), timeoutMs);
  });
}

// Tests a candidate {mode, serverUrl} pair WITHOUT saving it — lets the
// Connection Settings page show live Backend/DB/Socket.IO/Version results
// before the user commits to Save + Restart.
ipcMain.handle('connection:test', async (_e, { mode, serverUrl } = {}) => {
  const baseUrl = getEffectiveBackendBaseUrl({ mode: mode || 'local', serverUrl: serverUrl || '' });
  const health = await fetchHealth(baseUrl, 4000);
  const socketConnected = health.ok ? await testSocketReachable(baseUrl, 3000) : false;
  const remoteApiVersion = health.body?.apiVersion ?? null;
  return {
    baseUrl,
    reachable: health.ok,
    dbConnected: health.body?.db === 'connected',
    socketConnected,
    remoteVersion: health.body?.version || null,
    remoteApiVersion,
    requiredApiVersion: REQUIRED_API_VERSION,
    versionCompatible: remoteApiVersion == null ? null : remoteApiVersion === REQUIRED_API_VERSION,
    error: health.ok ? null : (health.error || `HTTP ${health.status ?? 'no response'}`),
  };
});

// ─── PDF export via Chromium print engine ─────────────────────────────────────
// Renders real HTML/CSS + embedded Arabic fonts → perfect RTL shaping, no mojibake.
ipcMain.handle('pdf:export', async (_e, { html, filename = 'PETSHROW_report', landscape = true } = {}) => {
  let pdfWin  = null;
  let tmpFile = null;
  try {
    const safe = String(filename).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'report';
    const defaultPath = join(app.getPath('documents'), `${safe}.pdf`);
    const { canceled, filePath } = await dialog.showSaveDialog(state.mainWindow, {
      title: 'حفظ التقرير PDF',
      defaultPath,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };

    // Render the document in a hidden window (temp file avoids data-URL size limits)
    tmpFile = join(os.tmpdir(), `petshrow_${Date.now()}.html`);
    writeFileSync(tmpFile, html, 'utf8');

    pdfWin = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: false, javascript: true, offscreen: false },
    });
    await pdfWin.loadFile(tmpFile);
    // Wait for the embedded fonts to be ready before printing
    try {
      await pdfWin.webContents.executeJavaScript(
        'document.fonts ? document.fonts.ready.then(()=>true) : true'
      );
    } catch {}

    const data = await pdfWin.webContents.printToPDF({
      printBackground:   true,
      landscape,
      pageSize:          'A4',
      preferCSSPageSize: true,   // honor the @page rule (A4 + margins) in the HTML
      margins:           { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 },
    });

    writeFileSync(filePath, data);
    shell.openPath(filePath);
    return { ok: true, path: filePath };
  } catch (err) {
    console.error('[PDF] export failed:', err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  } finally {
    if (pdfWin && !pdfWin.isDestroyed()) pdfWin.destroy();
    if (tmpFile) { try { unlinkSync(tmpFile); } catch {} }
  }
});

// ─── HTML print via native Windows printer dialog ────────────────────────────
// printDocument() in printUtils.js calls window.electron.printHTML() which routes here.
// Renders the report HTML in a hidden BrowserWindow then calls webContents.print() so
// the OS native print dialog appears — no window.open() popup needed.
ipcMain.handle('print:html', async (_e, { html, landscape = true, copies } = {}) => {
  let pdfWin  = null;
  let tmpFile = null;
  try {
    tmpFile = join(os.tmpdir(), `petshrow_print_${Date.now()}.html`);
    writeFileSync(tmpFile, html, 'utf8');
    pdfWin = new BrowserWindow({
      show: false,
      parent: state.mainWindow,
      webPreferences: { sandbox: false, javascript: true },
    });
    await pdfWin.loadFile(tmpFile);
    try {
      await pdfWin.webContents.executeJavaScript(
        'document.fonts ? document.fonts.ready.then(()=>true) : true'
      );
    } catch {}
    await new Promise((resolve, reject) => {
      // `copies`, when set, only pre-fills the native dialog's copies field —
      // silent:false means the user still sees and can change it there.
      // `landscape` MUST be passed here — without it this call silently fell
      // back to whatever the OS/driver's default page orientation was, while
      // `html`'s own @page CSS (and every column width baked into it via
      // computeColumnWidths()) was built for whichever orientation the user
      // actually picked in Print Preview. webContents.print() (unlike
      // printToPDF) has no `preferCSSPageSize` to fall back on — it does not
      // read @page's orientation at all, so a Portrait document could
      // physically print onto a Landscape (or vice-versa) page: content
      // built for one page width rendered onto a page of a different width,
      // clipping one edge and leaving blank space on the other. This is
      // exactly the "table renders wide then gets clipped" defect — not a
      // column-width bug, a lost orientation flag on this one IPC call.
      //
      // `pageSize`/`margins` pin down the SAME two assumptions this sibling
      // pdf:export handler above already pins (pageSize:'A4', a zeroed
      // driver margin). Without them, webContents.print()'s native OS dialog
      // is free to default to the PRINTER DRIVER's own last-used paper size
      // and margin — e.g. a Letter-default printer (narrower than A4, common
      // on US-region driver installs) or a driver that adds its own inset
      // margin ON TOP of the one already baked into every column's width via
      // @page's own `margin` rule. Either one reproduces the exact same
      // "wide table, clipped edge" symptom as the missing `landscape` above,
      // independently of it — this is a second, separate gap in the same
      // handler, not a rediscovery of the first. `marginType:'none'` is
      // correct (not 'custom' with zeros, which some drivers still pad) —
      // the printable inset already fully lives in `html`'s own @page rule,
      // reusing the exact geometry columnLayoutEngine.js computed widths
      // against; a second, driver-level margin would shrink the printable
      // area below what the content was actually laid out for.
      const printOpts = {
        silent: false, printBackground: true, landscape,
        pageSize: 'A4', margins: { marginType: 'none' },
      };
      if (copies > 1) printOpts.copies = copies;
      pdfWin.webContents.print(printOpts, (success, errorType) => {
        if (!success && errorType !== 'cancelled') reject(new Error(errorType));
        else resolve();
      });
    });
    return { ok: true };
  } catch (err) {
    console.error('[Print] failed:', err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  } finally {
    if (pdfWin && !pdfWin.isDestroyed()) pdfWin.destroy();
    if (tmpFile) { try { unlinkSync(tmpFile); } catch {} }
  }
});

// ─── Chromium trace capture (observational only) ─────────────────────────────
// Evidence-collection for the AG Grid blank-cell rendering investigation.
// Does not run unless explicitly invoked via tracing:start/tracing:stop; does
// not alter any application behavior, timing, or execution path. Uses
// Electron's official contentTracing API (wraps Chromium's tracing
// infrastructure) — no third-party tracing library.
const TRACE_CATEGORIES = [
  'disabled-by-default-devtools.timeline',       // Layout / Paint / UpdateLayerTree / CompositeLayers
  'disabled-by-default-devtools.timeline.frame', // BeginFrame / DrawFrame, frame-sequence boundaries
  'cc',                                          // Compositor thread: commit + RasterTask
  'viz',                                         // Display compositor: SubmitCompositorFrame / DrawAndSwap (presented frame)
  'blink.user_timing',                           // performance.mark()/measure() calls from the renderer, same clock domain
  'disabled-by-default-devtools.screenshot',     // Per-frame screenshot, direct visual evidence of presented content
];
let traceActive = false;

ipcMain.handle('tracing:start', async () => {
  if (traceActive) return { ok: false, error: 'trace already recording' };
  await contentTracing.startRecording({ included_categories: TRACE_CATEGORIES });
  traceActive = true;
  console.log('[Tracing] recording started:', TRACE_CATEGORIES.join(', '));
  return { ok: true, categories: TRACE_CATEGORIES };
});

ipcMain.handle('tracing:stop', async () => {
  if (!traceActive) return { ok: false, error: 'no trace in progress' };
  const traceDir = join(app.getPath('userData'), 'tracing');
  if (!existsSync(traceDir)) mkdirSync(traceDir, { recursive: true });
  const outPath = join(traceDir, `trace-${Date.now()}.json`);
  const savedPath = await contentTracing.stopRecording(outPath);
  traceActive = false;
  console.log('[Tracing] recording stopped, saved to:', savedPath);
  return { ok: true, path: savedPath };
});

// ─── Production Flight Recorder (observational only) ─────────────────────────
// Same evidence-collection purpose as the trace-capture block above, for the
// AG Grid blank-row/blank-cell investigation. Two handlers only: report
// static system info on request, and write a renderer-assembled JSON evidence
// package to disk when the renderer's passive recorder (flightRecorder.js)
// detects a trigger condition. Neither handler alters app behavior, state, or
// timing — 'system:info' is read-only, 'flightRecorder:save' only writes the
// evidence file the renderer already built.
ipcMain.handle('system:info', async () => {
  try {
    let gpuInfo = null;
    try { gpuInfo = await app.getGPUInfo('basic'); } catch {}
    let display = null;
    try {
      const { screen } = await import('electron');
      const d = screen.getPrimaryDisplay();
      display = { size: d.size, scaleFactor: d.scaleFactor, rotation: d.rotation };
    } catch {}
    return {
      ok: true,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
      os: { platform: os.platform(), release: os.release(), arch: os.arch(), totalmem: os.totalmem(), freemem: os.freemem() },
      appVersion: app.getVersion(),
      buildMarker: BUILD_MARKER,
      gpuInfo,
      display,
      windowBounds: state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow.getBounds() : null,
      windowFocused: state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow.isFocused() : null,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('flightRecorder:save', async (_e, payload) => {
  console.log('[FlightRecorder] flightRecorder:save IPC received, event count:', payload?.events?.length ?? 'n/a');
  try {
    const dir = join(app.getPath('userData'), 'flight-recordings');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const outPath = join(dir, `flight-${Date.now()}.json`);
    writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
    console.log('[FlightRecorder] evidence written to:', outPath);
    return { ok: true, path: outPath };
  } catch (err) {
    console.error('[FlightRecorder] save failed:', err?.stack || err?.message || err);
    return { ok: false, error: String(err?.message || err), code: err?.code || null };
  }
});

// Temporary verification channel (see preload.cjs debugLog) — tees renderer
// console lines into main.log purely so Flight Recorder behavior can be
// inspected from the log file. Read-only, no state mutation.
ipcMain.on('renderer:log', (_e, { level, args } = {}) => {
  const fn = console[level] && typeof console[level] === 'function' ? level : 'log';
  try { console[fn]('[Renderer]', ...(args || [])); } catch {}
});
