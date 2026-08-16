import { BrowserWindow, nativeImage, dialog, shell, app } from 'electron';
import { existsSync } from 'fs';
import { join } from 'path';
import { IS_DEV, APP_NAME, FRONTEND_URL, FRONTEND_ROOT } from './constants.js';
import { state } from './state.js';
import { markSplashStep } from './splash.js';

// ─── Main window ──────────────────────────────────────────────────────────────
export async function createMainWindow(paths) {
  const iconPath = paths.iconPng;
  const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : null;
  // Prod: bail out before creating anything if the frontend bundle is missing.
  let frontendIndex = null;
  if (!IS_DEV) {
    frontendIndex = join(paths.frontendDist, 'index.html');
    if (!existsSync(frontendIndex)) {
      dialog.showErrorBox(
        'خطأ في التشغيل — Frontend Missing',
        `لم يتم العثور على ملفات الواجهة في:\n${frontendIndex}\n\nأعد تثبيت التطبيق.`
      );
      app.quit();
      return null;
    }
  }

  const mainWindow = state.mainWindow = new BrowserWindow({
    width: 1440, height: 900,
    minWidth: 1100, minHeight: 680,
    show: false,
    backgroundColor: '#020817',
    title: APP_NAME,
    autoHideMenuBar: true,
    icon: icon || undefined,
    webPreferences: {
      preload:         join(FRONTEND_ROOT, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration:  false,
      spellcheck:       false,
      // Force Western numerals — override Blink's locale shaping
      v8CacheOptions:   'bypassHeatCheck',
    },
  });

  // ── Instant Window ───────────────────────────────────────────────────────
  // Show the (still-empty, backgroundColor-filled) window immediately — do
  // NOT wait for the frontend bundle, backend, DB, sockets, or device
  // listeners. The functional splash stays alwaysOnTop above it until real
  // readiness signals (or the hard timeout) close it.
  mainWindow.show();
  mainWindow.maximize();
  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.webContents.once('did-finish-load', () => markSplashStep(0, true));

  // Load frontend content — async, never blocks the window being visible.
  if (IS_DEV) {
    (async () => {
      try {
        await mainWindow.loadURL(FRONTEND_URL);
      } catch (err) {
        console.warn('[Electron] Vite load failed, retrying in 1.5s:', err.message);
        await new Promise(r => setTimeout(r, 1500));
        await mainWindow.loadURL(FRONTEND_URL).catch(e =>
          console.error('[Electron] Load retry failed:', e.message)
        );
      }
    })();
  } else {
    mainWindow.loadFile(frontendIndex).catch(e =>
      console.error('[Electron] loadFile failed:', e.message)
    );
  }

  mainWindow.on('close', e => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // EF-007.5: only hand off http(s) URLs to the OS shell handler — a
  // non-http(s) scheme (file:, custom app URIs, search-ms:, etc.) reaching
  // shell.openExternal is a known Windows vector for triggering unintended
  // handlers. No live window.open() call in the renderer uses a dynamic URL
  // today, but this closes the path regardless of future callers.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const scheme = new URL(url).protocol;
      if (scheme === 'http:' || scheme === 'https:') shell.openExternal(url);
    } catch { /* malformed URL — ignore */ }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('render-process-gone', (_, d) => {
    console.error('[Electron] Renderer gone:', d.reason);
    if (!app.isQuitting) setTimeout(() => mainWindow?.reload(), 2000);
  });

  // ── Asset smoke-test signal (production-asset-safety gate) ───────────────
  // did-fail-load only fires for FRAME-level navigation failures (the main
  // document or an iframe) — kept for that, but it never fires for a broken
  // subresource (a missing bundled JS/CSS/font/image referenced by an
  // already-loaded page), which is the actual broken-asset case this gate
  // exists to catch. -3 (ERR_ABORTED) is excluded — that's the code a
  // routine cancelled/superseded in-page navigation reports, not a real
  // resource failure.
  //
  // Diagnosed live (2026-08-16) via CDP against a deliberately-broken
  // packaged JS bundle: the browser-generated "Failed to load resource"
  // notice is NOT delivered through webContents' 'console-message' event
  // (that only reliably carries JS-originated console.*() calls) — it
  // surfaces through the CDP Log/Network domains instead, which Electron
  // does not forward as a plain webContents event. session.webRequest.
  // onErrorOccurred is the documented, reliable Electron API for this: it
  // fires for ANY failed network-level request — main frame or subresource,
  // JS/CSS/font/image/other — with the real net error code and URL,
  // independent of console/log routing. Confirmed live: a missing bundled
  // JS file produces exactly one onErrorOccurred call with
  // error:'net::ERR_FILE_NOT_FOUND'.
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (errorCode === -3) return;
    console.error(`[AssetSmokeTest] did-fail-load: ${errorDescription} (${errorCode}) url=${validatedURL} mainFrame=${isMainFrame}`);
  });
  // Scoped to actual packaged-asset resource types ONLY — onErrorOccurred
  // fires for every failed network-level request on this session, which
  // also includes the app's own live xhr/fetch/webSocket calls (API health
  // checks, Socket.IO) that are EXPECTED to fail transiently while the
  // backend is still starting (see lifecycle.js's own readiness polling —
  // that race is normal, not a broken asset). Confirmed live: an
  // unscoped listener produced false-positive [AssetSmokeTest] lines for
  // ERR_CONNECTION_REFUSED on /api/health and socket.io during a completely
  // healthy startup. Restricting to the resource types an asset manifest
  // entry could ever actually be (script/stylesheet/image/font/media) is
  // what makes this a broken-ASSET signal instead of generic network noise.
  const ASSET_RESOURCE_TYPES = new Set(['script', 'stylesheet', 'image', 'font', 'media']);
  mainWindow.webContents.session.webRequest.onErrorOccurred((details) => {
    if (details.error === 'net::ERR_ABORTED') return;
    if (details.url.startsWith('devtools://')) return;
    if (!ASSET_RESOURCE_TYPES.has(details.resourceType)) return;
    console.error(`[AssetSmokeTest] request failed: ${details.error} url=${details.url} resourceType=${details.resourceType}`);
  });

  // Passive evidence signal for the Flight Recorder — BrowserWindow focus
  // state is not observable from the renderer's own document.hasFocus() in
  // every case, so push it explicitly. Read-only forwarding, no behavior change.
  mainWindow.on('focus', () => mainWindow?.webContents.send('main:message', { type: 'window:focus', timestamp: Date.now() }));
  mainWindow.on('blur',  () => mainWindow?.webContents.send('main:message', { type: 'window:blur',  timestamp: Date.now() }));

  return mainWindow;
}
