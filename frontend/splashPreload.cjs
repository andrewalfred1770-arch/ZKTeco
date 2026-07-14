// EF-007.1: minimal preload for the splash window only. Exposes just the one
// channel the splash's inline script needs (startup progress updates) — no
// Node/electron API surface reaches the splash's HTML content itself.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splash', {
  onProgress: (cb) => ipcRenderer.on('progress', (_e, data) => cb(data)),
});
