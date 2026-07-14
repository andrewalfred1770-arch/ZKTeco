import { Tray, Menu, nativeImage, app } from 'electron';
import { existsSync } from 'fs';
import { APP_NAME } from './constants.js';
import { state } from './state.js';

let tray = null;

// ─── Debug menu — temporary, Flight Recorder verification only ───────────────
// "Export Flight Recorder Now" triggers an immediate manual export of the
// current ring buffer without waiting for a trigger condition. Read-only
// dispatch: sends an IPC message the renderer already listens for
// (onDebugExportFlightRecorder in preload.cjs) and calls
// flightRecorder.manualCapture() itself — this menu never touches state.
export function buildDebugMenu() {
  const template = [
    {
      label: 'Debug',
      submenu: [
        {
          label: 'Export Flight Recorder Now',
          accelerator: 'CmdOrCtrl+Shift+F9',
          click: () => { state.mainWindow?.webContents.send('debug:export-flight-recorder'); },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── System tray ─────────────────────────────────────────────────────────────
export function createTray(paths) {
  let icon = nativeImage.createEmpty();
  try {
    if (existsSync(paths.trayPng)) {
      icon = nativeImage.createFromPath(paths.trayPng).resize({ width: 16, height: 16 });
    }
  } catch {}

  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'فتح البرنامج',
      click: () => { state.mainWindow?.show(); state.mainWindow?.focus(); state.mainWindow?.maximize(); },
    },
    { type: 'separator' },
    {
      label: 'إغلاق البرنامج',
      click: () => { app.isQuitting = true; app.quit(); },
    },
  ]));
  tray.on('double-click', () => { state.mainWindow?.show(); state.mainWindow?.focus(); });
}
