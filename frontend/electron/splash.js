import { state as sharedState } from './state.js';

// ─── Startup readiness tracker ────────────────────────────────────────────────
// This module used to also own the startup splash window (a small card with a
// logo and a checklist of technical steps, shown above an empty full-screen
// window). That window is gone: the main window is now created hidden and
// windows.js revealMainWindow() shows it once startup is ready (or the readiness
// budget runs out and the in-app ServerReadyGate takes over).
//
// What remains is the real-readiness bookkeeping lifecycle.js's poller relies on
// — deliberately unchanged, including the function names, so the readiness
// decision logic is byte-identical to before. Every index maps 1:1 to a real,
// independently-observable signal (see markSplashStep call sites):
//   0 = renderer did-finish-load            1 = /api/startup-status → dbConnected
//   2 = sync scheduler + realtime started   3 = realtime device link (or none configured)
//   4 = aggregate: every step above complete
const splashState = [false, false, false, false, false];

export function markSplashStep(i, done = true) {
  if (splashState[i] === done) return;
  splashState[i] = done;
}

// Read-only accessor — lifecycle.js's readiness poller checks specific step
// indices (splashState[0]/[1]/[2]/[3]) to decide when all core steps are done.
export function isSplashStepDone(i) {
  return splashState[i];
}

// ─── Progressive App Readiness — broadcast to the renderer ───────────────────
// UI / Backend / Realtime / Device readiness are independent states. The
// renderer can subscribe via window.electron.onMessage and is never blocked
// waiting for any of these — they're informational.
export function notifyRenderer(state) {
  if (!sharedState.mainWindow || sharedState.mainWindow.isDestroyed()) return;
  sharedState.mainWindow.webContents.send('main:message', { type: 'app:ready-state', state, timestamp: Date.now() });
}
