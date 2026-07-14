import { join, resolve } from 'path';
import { IS_DEV, FRONTEND_ROOT } from './constants.js';

// ─── Paths ────────────────────────────────────────────────────────────────────
export function getPaths() {
  if (IS_DEV) {
    return {
      backendEntry: resolve(FRONTEND_ROOT, '../backend/src/index.js'),
      backendCwd:   resolve(FRONTEND_ROOT, '../backend'),
      envFile:      resolve(FRONTEND_ROOT, '../backend/.env'),
      frontendDist: null,
      iconPng:      join(FRONTEND_ROOT, 'assets', 'icon.png'),
      trayPng:      join(FRONTEND_ROOT, 'assets', 'tray.png'),
    };
  }
  const res = process.resourcesPath;
  return {
    backendEntry: join(res, 'backend', 'src', 'index.js'),
    backendCwd:   join(res, 'backend'),
    envFile:      join(res, 'backend', '.env'),
    frontendDist: join(res, 'frontend', 'dist'),
    iconPng:      join(FRONTEND_ROOT, 'assets', 'icon.png'),
    trayPng:      join(FRONTEND_ROOT, 'assets', 'tray.png'),
  };
}
