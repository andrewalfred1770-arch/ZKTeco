import { app, ipcMain } from 'electron';
import electronUpdater from 'electron-updater';
import { IS_DEV } from './constants.js';
import { state } from './state.js';
import { readSettings, writeSettings } from './updateSettings.js';

const { autoUpdater } = electronUpdater;

// ─── Enterprise Auto Update System (EP-001) ───────────────────────────────────
// Wraps electron-updater with app-controlled download/install (never fires
// without the renderer asking, except when the user's own "Automatic
// Download" setting is on) and forwards every lifecycle event to the Update
// Center UI. Never throws past this module — an update failure must never
// take the ERP down; it only ever disables itself for that check.

let updateInfo = null;      // latest available UpdateInfo from electron-updater
let downloadedInfo = null;  // set once update-downloaded fires
let checking = false;
let downloading = false;
let lastError = null;
let periodicTimer = null;

const log = (...args) => console.log('[Updater]', ...args);

function send(channel, payload) {
  const win = state.mainWindow;
  if (win && !win.isDestroyed()) {
    try { win.webContents.send(channel, payload); } catch {}
  }
}

function getStatePayload() {
  return {
    currentVersion: app.getVersion(),
    checking,
    downloading,
    updateInfo: updateInfo ? {
      version: updateInfo.version,
      releaseDate: updateInfo.releaseDate || null,
      releaseNotes: typeof updateInfo.releaseNotes === 'string' ? updateInfo.releaseNotes : '',
      size: (updateInfo.files || []).reduce((sum, f) => sum + (f.size || 0), 0) || null,
    } : null,
    downloaded: !!downloadedInfo,
    downloadedVersion: downloadedInfo?.version || null,
    lastError,
    settings: readSettings(),
  };
}

function broadcastState() { send('updater:state', getStatePayload()); }

async function checkForUpdates() {
  if (IS_DEV) { log('No Update — skipped (dev mode has no packaged feed)'); return; }
  if (checking || downloading) return;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    checking = false;
    lastError = String(err?.message || err);
    log('Update Failed:', lastError);
    broadcastState();
  }
}

async function startDownload() {
  if (IS_DEV || !updateInfo || downloading || downloadedInfo) return;
  try {
    downloading = true;
    lastError = null;
    log('Download Started:', updateInfo.version);
    broadcastState();
    await autoUpdater.downloadUpdate();
  } catch (err) {
    downloading = false;
    lastError = String(err?.message || err);
    log('Update Failed:', lastError);
    broadcastState();
  }
}

function schedulePeriodicCheck(settings) {
  if (periodicTimer) { clearInterval(periodicTimer); periodicTimer = null; }
  if (!IS_DEV && settings.checkMode === 'automatic') {
    periodicTimer = setInterval(() => checkForUpdates(), 6 * 60 * 60 * 1000); // every 6h
  }
}

function registerIpc() {
  ipcMain.handle('updater:check', async () => { await checkForUpdates(); return getStatePayload(); });
  ipcMain.handle('updater:download', async () => { await startDownload(); return getStatePayload(); });
  ipcMain.handle('updater:install', () => {
    if (!downloadedInfo) return { ok: false, error: 'no update downloaded yet' };
    log('Install Started');
    app.isQuitting = true;
    // (isSilent, isForceRunAfter) — show the NSIS install UI, relaunch after.
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { ok: true };
  });
  ipcMain.handle('updater:get-state', () => getStatePayload());
  ipcMain.handle('updater:get-settings', () => readSettings());
  ipcMain.handle('updater:set-settings', (_e, patch) => {
    const merged = writeSettings(patch || {});
    if (Object.prototype.hasOwnProperty.call(patch || {}, 'feedUrl')) {
      applyFeedUrl(merged);
    }
    schedulePeriodicCheck(merged);
    broadcastState();
    return merged;
  });
}

function applyFeedUrl(settings) {
  if (!settings.feedUrl) return;
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: settings.feedUrl, channel: 'latest' });
    log('Feed URL overridden:', settings.feedUrl);
  } catch (err) {
    log('setFeedURL failed:', err.message);
  }
}

export function initUpdater() {
  // Security: only ever talk to the configured update source, verify the
  // downloaded package against the checksum embedded in latest.yml (built-in
  // to electron-updater), and never install anything the metadata parse or
  // checksum check rejects — electron-updater refuses the file automatically
  // in that case and emits 'error' below instead of installing it.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // ONE-RELEASE MIGRATION EXCEPTION — RESOLVED in 1.1.2. The 1.1.1 release
  // reset the product version scheme from calendar versioning (20.26.11) to
  // semver, which semver reads as a downgrade; allowDowngrade=true was
  // switched on for that single migration release only, so existing
  // 20.26.11 installs could still discover and pull 1.1.1 through
  // electron-updater instead of being silently stranded. As planned in the
  // 1.1.1-era TODO, this reverts to false here in the first release after
  // 1.1.1 (the fleet is presumed off the calendar scheme by now) — do not
  // re-enable without separate approval.
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.logger = {
    info:  (...a) => log(...a),
    warn:  (...a) => console.warn('[Updater]', ...a),
    error: (...a) => console.error('[Updater]', ...a),
    debug: () => {},
  };

  const settings = readSettings();
  applyFeedUrl(settings);

  autoUpdater.on('checking-for-update', () => {
    checking = true; lastError = null;
    log('Update Check Started');
    broadcastState();
  });

  autoUpdater.on('update-available', (info) => {
    checking = false;
    updateInfo = info;
    downloadedInfo = null;
    log('Update Available:', info.version);
    broadcastState();
    if (readSettings().downloadMode === 'automatic') startDownload();
  });

  autoUpdater.on('update-not-available', () => {
    checking = false;
    updateInfo = null;
    log('No Update');
    broadcastState();
  });

  autoUpdater.on('download-progress', (progress) => {
    downloading = true;
    log(`Download % ${progress.percent?.toFixed?.(1) ?? progress.percent}`);
    send('updater:progress', progress);
  });

  autoUpdater.on('update-downloaded', (info) => {
    downloading = false;
    downloadedInfo = info;
    log('Download Completed:', info.version);
    log('Install Completed'); // package staged; actual install runs on quitAndInstall
    broadcastState();
  });

  autoUpdater.on('error', (err) => {
    checking = false;
    downloading = false;
    lastError = String(err?.message || err);
    log('Update Failed:', lastError);
    broadcastState();
  });

  registerIpc();
  schedulePeriodicCheck(settings);

  // Never block startup: first check fires a few seconds after the window is
  // already interactive, well after the splash/backend readiness sequence.
  if (!IS_DEV && settings.checkMode === 'automatic') {
    setTimeout(() => checkForUpdates(), 8000);
  }
}
