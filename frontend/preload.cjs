// Preload runs as CommonJS (Electron requirement)
// Must use .cjs extension when package.json has "type":"module"
const { contextBridge, ipcRenderer } = require('electron');

// EP-003 Hybrid Client/Server — resolved once, synchronously, before the page
// loads. Mirrors the existing static `backendPort` field: the frontend reads
// this once at import time (see src/lib/api.js, src/lib/socket.js) and never
// needs to know whether it's Local Mode (backendBaseUrl === http://localhost:5000)
// or Server Mode (backendBaseUrl === the configured remote) — same connection
// layer, same abstraction, either way.
const backendBaseUrl = ipcRenderer.sendSync('connection:get-effective-base-url-sync');

contextBridge.exposeInMainWorld('electron', {
  isElectron:  true,
  backendPort: 5000,
  backendBaseUrl,
  minimize:    () => ipcRenderer.send('app:minimize'),
  maximize:    () => ipcRenderer.send('app:maximize'),
  close:       () => ipcRenderer.send('app:close'),
  quit:        () => ipcRenderer.send('app:quit'),
  relaunch:    () => ipcRenderer.send('app:relaunch'),
  version:     () => ipcRenderer.invoke('app:version'),
  isDev:       () => ipcRenderer.invoke('app:is-dev'),
  buildMarker: () => ipcRenderer.invoke('app:build-marker'),
  // Connection Layer (EP-003) — Connection Settings page IPC bridge.
  connection: {
    getSettings: () => ipcRenderer.invoke('connection:get-settings'),
    setSettings: (patch) => ipcRenderer.invoke('connection:set-settings', patch),
    test:        (candidate) => ipcRenderer.invoke('connection:test', candidate),
  },
  // Session persistence (EP-011 Manager Edition auth) — encrypted JWT storage.
  session: {
    save:  (token) => ipcRenderer.invoke('session:save', token),
    load:  () => ipcRenderer.invoke('session:load'),
    clear: () => ipcRenderer.invoke('session:clear'),
  },
  // Export an HTML document to PDF via Chromium's print engine (real Arabic shaping)
  exportPDF:   (payload) => ipcRenderer.invoke('pdf:export', payload),
  // Send HTML to the native Windows printer dialog (bypasses window.open() which is blocked)
  printHTML:   (payload) => ipcRenderer.invoke('print:html', payload),
  onMessage:   (cb) => ipcRenderer.on('main:message', (_e, msg) => cb(msg)),
  getReadyState: () => ipcRenderer.invoke('system:get-ready-state'),
  // Chromium trace capture — observational only, evidence collection for the
  // AG Grid blank-cell rendering investigation. Not wired to any UI; invoke
  // manually (e.g. from DevTools console: window.electron.startTrace()).
  startTrace:  () => ipcRenderer.invoke('tracing:start'),
  stopTrace:   () => ipcRenderer.invoke('tracing:stop'),
  // Production Flight Recorder — observational only, evidence collection for
  // the AG Grid blank-row/blank-cell investigation. getSystemInfo() is a
  // read-only query; saveFlightRecording() writes an already-assembled JSON
  // evidence package built by the renderer's passive recorder to disk.
  getSystemInfo:       () => ipcRenderer.invoke('system:info'),
  saveFlightRecording: (payload) => ipcRenderer.invoke('flightRecorder:save', payload),
  // Temporary verification channel — forwards renderer console lines into
  // main.log so the Flight Recorder's own behavior can be checked from the
  // log file without attaching devtools. Read-only forwarding, fire-and-forget.
  debugLog:            (level, ...args) => ipcRenderer.send('renderer:log', { level, args }),
  onDebugExportFlightRecorder: (cb) => ipcRenderer.on('debug:export-flight-recorder', cb),
  // Enterprise Auto Update System (EP-001) — Update Center IPC bridge.
  updater: {
    check:       () => ipcRenderer.invoke('updater:check'),
    download:    () => ipcRenderer.invoke('updater:download'),
    install:     () => ipcRenderer.invoke('updater:install'),
    getState:    () => ipcRenderer.invoke('updater:get-state'),
    getSettings: () => ipcRenderer.invoke('updater:get-settings'),
    setSettings: (patch) => ipcRenderer.invoke('updater:set-settings', patch),
    onState:     (cb) => {
      const listener = (_e, s) => cb(s);
      ipcRenderer.on('updater:state', listener);
      return () => ipcRenderer.removeListener('updater:state', listener);
    },
    onProgress:  (cb) => {
      const listener = (_e, p) => cb(p);
      ipcRenderer.on('updater:progress', listener);
      return () => ipcRenderer.removeListener('updater:progress', listener);
    },
  },
});
