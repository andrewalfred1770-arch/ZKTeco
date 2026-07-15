// EF-008 Phase 4: shared mutable state for the three variables that are
// genuinely read/written across multiple split files (verified by tracing
// every reference in the original electron.js before this split):
//   - mainWindow: written by windows.js, read by splash.js/tray.js/ipc.js/lifecycle.js
//   - backendProcess/backendReady: written by backend.js AND lifecycle.js
// `tray` and `splashWindow` are each read only within their own owning file
// (tray.js / splash.js respectively) and stay as local variables there —
// routing them through this shared object would be unnecessary indirection.
export const state = {
  mainWindow: null,
  backendProcess: null,
  backendReady: false,
  // EP-003 Hybrid Client/Server: resolved once at startup (see lifecycle.js)
  // from connectionSettings.js and never mutated mid-session — switching
  // modes takes effect on next launch, same as Update Center settings.
  connectionMode: 'local',
  backendBaseUrl: null,
  // EP-010.1: set when the backend's stdout emits the Database Setup
  // Wizard's restart marker — tells the exit handler in backend.js to
  // restart despite a clean (code 0, SIGTERM) exit, which otherwise looks
  // identical to a real app-quit and is deliberately never auto-restarted.
  pendingConfigRestart: false,
};
