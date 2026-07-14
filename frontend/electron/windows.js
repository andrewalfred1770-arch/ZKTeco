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

  // Passive evidence signal for the Flight Recorder — BrowserWindow focus
  // state is not observable from the renderer's own document.hasFocus() in
  // every case, so push it explicitly. Read-only forwarding, no behavior change.
  mainWindow.on('focus', () => mainWindow?.webContents.send('main:message', { type: 'window:focus', timestamp: Date.now() }));
  mainWindow.on('blur',  () => mainWindow?.webContents.send('main:message', { type: 'window:blur',  timestamp: Date.now() }));

  return mainWindow;
}
