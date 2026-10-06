import { app, ipcMain, shell, session } from 'electron';
import { IS_DEV, FRONTEND_URL } from './constants.js';
import { state } from './state.js';

// ─── Electron security layer (P3-09) ──────────────────────────────────────────
// The renderer talks to the main server over plain HTTP/API + Socket.IO by
// design (LAN / Mac client → remote server), so NOTHING here restricts which
// backend URL the app may reach — it only controls (a) which pages may drive
// privileged IPC, (b) where a window may navigate, and (c) the shape of the
// data a renderer may hand to the main process.

const MAX_HTML_BYTES = 50 * 1024 * 1024;

/** True for http(s) URLs only (the sole schemes ever handed to the OS shell). */
export function isHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { const p = new URL(value).protocol; return p === 'http:' || p === 'https:'; } catch { return false; }
}

// A sender is trusted only if it is the main window's own top-level frame
// showing OUR app (file:// bundle in production, the Vite origin in dev). The
// hidden PDF/print windows, any child window and any foreign page are refused.
export function isTrustedSender(e) {
  try {
    const main = state.mainWindow;
    if (!main || main.isDestroyed() || e.sender !== main.webContents) return false;
    const frame = e.senderFrame;
    if (!frame || frame.parent) return false;               // top-level frame only
    const url = new URL(frame.url);
    if (IS_DEV) return url.origin === new URL(FRONTEND_URL).origin;
    return url.protocol === 'file:';
  } catch { return false; }
}

const reject = (channel) => new Error(`IPC ${channel}: untrusted sender`);

/** ipcMain.handle with sender validation. */
export function secureHandle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!isTrustedSender(e)) { console.warn(`[Security] blocked IPC invoke "${channel}" from untrusted sender`); throw reject(channel); }
    return fn(e, ...args);
  });
}

/** ipcMain.on with sender validation (sync callers get null back). */
export function secureOn(channel, fn) {
  ipcMain.on(channel, (e, ...args) => {
    if (!isTrustedSender(e)) { console.warn(`[Security] blocked IPC send "${channel}" from untrusted sender`); e.returnValue = null; return; }
    fn(e, ...args);
  });
}

// ─── Input validators (throw → the invoke rejects, nothing is executed) ──────
export function asHtml(html) {
  if (typeof html !== 'string' || html.length === 0) throw new Error('html must be a non-empty string');
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) throw new Error('html too large');
  return html;
}
export function asBool(v, dflt) { return typeof v === 'boolean' ? v : dflt; }
export function asCopies(v) {
  if (v === undefined || v === null) return undefined;
  if (!Number.isInteger(v) || v < 1 || v > 99) throw new Error('copies must be an integer 1-99');
  return v;
}
export function asString(v, max, label = 'value') {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new Error(`${label} must be a string up to ${max} chars`);
  return v;
}
export function asConnectionPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('settings must be an object');
  const out = {};
  if ('mode' in patch) {
    if (patch.mode !== 'local' && patch.mode !== 'server') throw new Error('mode must be "local" or "server"');
    out.mode = patch.mode;
  }
  if ('serverUrl' in patch) {
    if (patch.serverUrl !== '' && !isHttpUrl(patch.serverUrl)) throw new Error('serverUrl must be an http(s) URL');
    out.serverUrl = patch.serverUrl;
  }
  return out;
}
export function asUpdaterPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('settings must be an object');
  const out = {};
  if ('checkMode' in patch) { if (!['automatic', 'manual'].includes(patch.checkMode)) throw new Error('bad checkMode'); out.checkMode = patch.checkMode; }
  if ('downloadMode' in patch) { if (!['automatic', 'notify'].includes(patch.downloadMode)) throw new Error('bad downloadMode'); out.downloadMode = patch.downloadMode; }
  if ('feedUrl' in patch) {
    if (patch.feedUrl !== null && patch.feedUrl !== '' && !isHttpUrl(patch.feedUrl)) throw new Error('feedUrl must be an http(s) URL');
    out.feedUrl = patch.feedUrl;
  }
  return out;
}

// ─── Window / session guards ──────────────────────────────────────────────────
function sameAppPage(currentUrl, targetUrl) {
  try {
    const c = new URL(currentUrl); const t = new URL(targetUrl);
    if (IS_DEV) return c.origin === t.origin;
    return c.protocol === 'file:' && t.protocol === 'file:' && c.pathname === t.pathname;
  } catch { return false; }
}

export function installSecurityGuards() {
  app.on('web-contents-created', (_e, contents) => {
    // No <webview> anywhere in the app.
    contents.on('will-attach-webview', (ev) => ev.preventDefault());

    // A window may only (re)load its own app page; http(s) links go to the OS
    // browser, everything else (file:, custom schemes, javascript:) is dropped.
    const guard = (ev, url) => {
      if (sameAppPage(contents.getURL(), url)) return;
      ev.preventDefault();
      if (isHttpUrl(url)) shell.openExternal(url);
      else console.warn('[Security] blocked navigation to', String(url).slice(0, 120));
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);

    contents.setWindowOpenHandler(({ url }) => {
      if (isHttpUrl(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
  });

  // The app needs no camera/mic/geolocation/notification/etc. Clipboard write
  // (copy buttons) and fullscreen stay available.
  const ALLOWED = new Set(['clipboard-sanitized-write', 'fullscreen']);
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED.has(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission));
  });
}
