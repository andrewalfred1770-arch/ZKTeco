import { join, resolve } from 'path';
import { app } from 'electron';
import { IS_DEV, FRONTEND_ROOT, APP_NAME } from './constants.js';
import { isStandalone } from './edition.js';

// Mac Standalone gets its OWN Application Support folder name, deliberately
// distinct from the Server edition's "PETSHROW ERP" — a Mac that somehow
// also has a Server-edition install must never share (or corrupt) its
// managed-MySQL data directory, backups, or config with this one.
const STANDALONE_APP_NAME = 'PETSHROW ERP Standalone';

// ─── Persistent config directory (EP-010) ────────────────────────────────────
// Explicitly %APPDATA%/PETSHROW ERP/ (or ~/Library/Application Support/PETSHROW
// ERP[ Standalone]/ on macOS) — independent of Electron's own
// app.getPath('userData') (which already resolves to a differently-cased
// folder for Chromium's own profile/cache data). A Portable build extracts
// to a new temp folder on every launch, and a Setup reinstall can replace
// resources/ entirely — anything living inside resources/backend is not
// survivable across either. This directory is outside both, so .env/logs/
// backups/exports/uploads persist regardless of how the app was launched.
export function getPersistentConfigDir() {
  return join(app.getPath('appData'), isStandalone ? STANDALONE_APP_NAME : APP_NAME);
}

// ─── Standalone-only data layout ──────────────────────────────────────────────
// Everything the managed local MySQL instance and the backup/restore engine
// need, all rooted under the SAME persistent Application Support folder as
// the rest of Standalone's config (see getPersistentConfigDir above) — never
// inside the .app bundle, so app updates can never delete it.
export function getStandaloneDataPaths() {
  const root = getPersistentConfigDir();
  return {
    root,
    databaseDir: join(root, 'database'),
    mysqlDataDir: join(root, 'database', 'mysql'),
    mysqlCredentialsFile: join(root, 'config', 'mysql-credentials.json'),
    backupsDir: join(root, 'backups'),
    exportsDir: join(root, 'exports'),
    logsDir: join(root, 'logs'),
    tempDir: join(root, 'temp'),
    initMarkerFile: join(root, '.initialized.json'),
  };
}

// Arch-specific bundled MySQL binaries directory, packaged by
// electron-builder.standalone.json's extraResources (resources/mysql/${arch}).
// Dev mode has no packaged resources — callers must handle a null return.
export function getMysqlBinDir() {
  if (IS_DEV) return null;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return join(process.resourcesPath, 'mysql', arch, 'bin');
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
