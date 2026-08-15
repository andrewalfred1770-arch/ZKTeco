import { app } from 'electron';

// EP-011 — Manager Edition / Mac Standalone Edition: the main process's
// counterpart to src/lib/edition.js. Unlike the renderer bundle (which bakes
// VITE_EDITION in at build time), the main process files are not run through
// Vite, so this reads the packaged app's identity instead:
//   - Packaged: electron-builder.manager.json / electron-builder.standalone.json
//     set extraMetadata.name to PACKAGED_MANAGER_NAME / PACKAGED_STANDALONE_NAME,
//     which electron-builder writes into the packaged app.asar's package.json —
//     Electron's app.getName() reads it from there. The Server build's
//     package.json "name" (petshrow-erp) never matches either, so a Server
//     installer can never resolve to 'manager' or 'standalone' by accident.
//   - Dev mode: there's one shared package.json, so `npm run electron:dev`
//     has no packaged name to read — use `EDITION=manager` / `EDITION=standalone`
//     in the dev script as the explicit override instead.
const PACKAGED_MANAGER_NAME    = 'petshrow-erp-manager';
const PACKAGED_STANDALONE_NAME = 'petshrow-erp-standalone';

export const EDITION =
  (process.env.EDITION === 'standalone' || app.getName() === PACKAGED_STANDALONE_NAME) ? 'standalone' :
  (process.env.EDITION === 'manager'    || app.getName() === PACKAGED_MANAGER_NAME)    ? 'manager' :
  'server';

export const isManager    = EDITION === 'manager';
export const isStandalone = EDITION === 'standalone';
export const isServer     = EDITION === 'server';
