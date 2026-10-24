// Shared check for the generated legacy-Mac main bundle (electron.mojave.cjs). That file is a build OUTPUT of electron.js, so a stale
// copy silently lacks later main-process features. The shared preload.cjs exposes `setup.request`, which needs the `setup:request`
// handler AND the backend secret hand-off in the main process; a bundle without them would leave the Database Setup Wizard broken.
// Used by build-mojave-main.mjs (right after bundling) and verify-mojave-main.mjs (before packaging).

/** String literals that only exist in the bundle if the setup-auth main-process code was bundled in. */
export const REQUIRED_MARKERS = [
  'setup:request',                    // IPC channel (ipc.js)
  'setup-secret ',                    // stdin hand-off line (setupAuth.js)
  'HANDOFF_ACK',                      // acknowledgement parsing (setupAuth.js)
  'checkin-setup-handoff-ack-v1',     // acknowledgement tag derivation
  'x-checkin-setup-mac',              // request signing
  'SETUP_ADOPTED_BACKEND',            // adopted-backend detection (setupBridge.js)
];

/** @returns {{ok:boolean, missing:string[]}} */
export function checkBundleText(text) {
  const t = typeof text === 'string' ? text : '';
  const missing = REQUIRED_MARKERS.filter((m) => !t.includes(m));
  return { ok: t.length > 0 && missing.length === 0, missing };
}
