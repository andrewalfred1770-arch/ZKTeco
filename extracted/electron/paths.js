import { join, resolve } from 'path';
import { app } from 'electron';
import { IS_DEV, FRONTEND_ROOT, APP_NAME } from './constants.js';

// ─── Persistent config directory (EP-010) ────────────────────────────────────
// Explicitly %APPDATA%/PETSHROW ERP/ — independent of Electron's own
// app.getPath('userData') (which already resolves to a differently-cased
// folder for Chromium's own profile/cache data). A Portable build extracts
// to a new temp folder on every launch, and a Setup reinstall can replace
// resources/ entirely — anything living inside resources/backend is not
// survivable across either. This directory is outside both, so .env/logs/
// backups/exports/uploads persist regardless of how the app was launched.
export function getPersistentConfigDir() {
  return join(app.getPath('appData'), APP_NAME);
}

// ─── Paths ────────────────────────────────────────────────────────────────────
export function getPaths() {
  if (IS_DEV) {
    return {
      backendEntry:  resolve(FRONTEND_ROOT, '../backend/src/index.js'),
      backendCwd:    resolve(FRONTEND_ROOT, '../backend'),
      envFile:       resolve(FRONTEND_ROOT, '../backend/.env'),
      configDir:     null,   // dev mode keeps using the source tree, unchanged
      legacyEnvFile: null,
      frontendDist:  null,
      iconPng:       join(FRONTEND_ROOT, 'assets', 'icon.png'),
      trayPng:       join(FRONTEND_ROOT, 'assets', 'tray.png'),
    };
  }
  const res = process.resourcesPath;
  const configDir = getPersistentConfigDir();
  return {
    backendEntry:  join(res, 'backend', 'src', 'index.js'),
    backendCwd:    join(res, 'backend'),
    envFile:       join(configDir, '.env'),
    configDir,
    // Pre-EP-010 (or a stale Portable temp extraction's) location — checked
    // once at startup for a one-time migration, never read again after that.
    legacyEnvFile: join(res, 'backend', '.env'),
    frontendDist:  join(res, 'frontend', 'dist'),
    iconPng:       join(FRONTEND_ROOT, 'assets', 'icon.png'),
    trayPng:       join(FRONTEND_ROOT, 'assets', 'tray.png'),
  };
}
