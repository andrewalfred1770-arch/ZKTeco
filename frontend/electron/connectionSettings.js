import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { BACKEND_PORT } from './constants.js';
import { isManager, isStandalone } from './edition.js';

// ─── Connection Layer settings (EP-003 Hybrid Client/Server) ─────────────────
// mode:      'local'  — Electron spawns and owns a backend process on this
//                        machine (100% today's Server-edition behavior, and
//                        its default).
//            'server' — Electron does NOT spawn a backend; the frontend talks
//                        to an existing backend reachable at serverUrl. This
//                        is the ONLY mode a Manager build can meaningfully
//                        run in — Manager installs never bundle backend/, so
//                        a 'local' default would spawn nothing and dead-end.
// serverUrl: full base URL of the remote backend, e.g.
//            "http://192.168.1.10:5000" or "https://erp.company.com".
// Persisted the same way updateSettings.js persists Update Center prefs:
// a small JSON file under userData/config, independent of the DB — it must
// be readable before the DB/backend even exists yet.
//
// EP-011: default mode is edition-aware (Server keeps 'local' unchanged;
// Manager defaults to 'server' so a first launch with no saved settings
// still lands on the connect-to-a-server path instead of trying — and
// failing — to spawn a backend that was never packaged).
// Mac Standalone: ALWAYS 'local' — there is no server/remote mode for this
// edition at all (see readConnectionSettings() below, which hard-pins it
// even against a tampered/legacy settings file on disk).
const DEFAULTS = {
  mode: isStandalone ? 'local' : (isManager ? 'server' : 'local'),
  serverUrl: '',
};

function settingsFile() {
  const dir = join(app.getPath('userData'), 'config');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'connection-settings.json');
}

export function readConnectionSettings() {
  // Mac Standalone MUST NEVER run in anything but local mode — reject any
  // persisted 'server' value outright, whether from a hand-edited file, a
  // pre-Standalone install's leftover settings, or a future regression that
  // reintroduces a mode toggle for this edition. No disk read below this
  // point can override it.
  if (isStandalone) return { ...DEFAULTS };
  try {
    const p = settingsFile();
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      return { ...DEFAULTS, ...raw };
    }
  } catch (err) {
    console.warn('[Connection] settings read failed, using defaults:', err.message);
  }
  return { ...DEFAULTS };
}

export function writeConnectionSettings(patch) {
  // Same rule as the read side: Standalone silently drops any attempt to
  // persist a non-local mode or a serverUrl instead of writing it to disk —
  // there is deliberately no remote-mode toggle for this edition to reach.
  if (isStandalone) {
    if (patch?.mode && patch.mode !== 'local') {
      console.warn('[Connection] Standalone edition — ignoring attempt to set mode:', patch.mode);
    }
    return { ...DEFAULTS };
  }
  const merged = { ...readConnectionSettings(), ...patch };
  try {
    writeFileSync(settingsFile(), JSON.stringify(merged, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Connection] settings write failed:', err.message);
  }
  return merged;
}

// Strips a trailing slash so "${base}/api/..." never ends up with "//api/...".
function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/** Single source of truth for "where does the frontend talk to the backend". */
export function getEffectiveBackendBaseUrl(settings = readConnectionSettings()) {
  if (settings.mode === 'server' && settings.serverUrl) {
    return normalizeBaseUrl(settings.serverUrl);
  }
  return `http://localhost:${BACKEND_PORT}`;
}

export { normalizeBaseUrl };
