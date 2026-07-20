import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ─── Update Center settings — persisted to userData, independent of the DB ───
// checkMode:    'automatic' (check on startup + every 6h) | 'manual' (user-triggered only)
// downloadMode: 'automatic' (download as soon as found)   | 'notify' (ask before downloading)
// feedUrl:      optional runtime override of the electron-builder `publish` url baked
//               into app-update.yml at build time — lets an admin repoint the update
//               server (e.g. a new internal host) without rebuilding the installer.
const DEFAULTS = {
  checkMode: 'automatic',
  downloadMode: 'notify',
  feedUrl: null,
};

function settingsFile() {
  const dir = join(app.getPath('userData'), 'config');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'update-settings.json');
}

export function readSettings() {
  try {
    const p = settingsFile();
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      return { ...DEFAULTS, ...raw };
    }
  } catch (err) {
    console.warn('[Updater] settings read failed, using defaults:', err.message);
  }
  return { ...DEFAULTS };
}

export function writeSettings(patch) {
  const merged = { ...readSettings(), ...patch };
  try {
    writeFileSync(settingsFile(), JSON.stringify(merged, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Updater] settings write failed:', err.message);
  }
  return merged;
}
