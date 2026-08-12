import { io as socketIO } from 'socket.io-client';

// Connection Layer (EP-003 Hybrid Client/Server): same backendBaseUrl
// resolution as lib/api.js — Local Mode or Server Mode, the socket connects
// to whichever backend the main process resolved at startup. Shared here so
// every page that needs live updates reuses ONE connection instead of
// opening a new socket per mounted page.
//
// Phase 29 — plain-browser (Web Client) fallback: previously hardcoded to
// 'http://localhost:5000', which only ever worked for local dev against the
// default port. A Web Client build served from (and meant to talk to)
// whatever host/port actually hosts it must default to same-origin, exactly
// like lib/api.js's empty-string fallback — socket.io-client connects to the
// current page's origin when given an empty string.
const backendBase = window.electron?.backendBaseUrl
  ?? (window.electron?.backendPort ? `http://localhost:${window.electron.backendPort}` : '');

let socket = null;

// EP-011 — Manager Edition auth. Same module-local pattern as lib/api.js
// (authStore calls setSocketAuthToken() on login/logout/hydrate). `auth` is
// passed as a function so socket.io-client re-evaluates it on every
// (re)connect attempt — the token is always current even if it's set after
// the socket already exists, or refreshed after a reconnect.
let authToken = null;
export function setSocketAuthToken(token) { authToken = token; }

// EP-014 — connection-lifecycle tracking. Previously nothing in the app
// listened for connect/disconnect/reconnect at all, so a dropped backend
// connection was silently invisible to the user (individual pages only ever
// noticed once a specific socket event failed to arrive). Small pub/sub
// singleton, same pattern as this module's own lazy-singleton style —
// ConnectionStatusBanner.jsx is the only current subscriber.
let connectionStatus = 'connecting'; // 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
const statusListeners = new Set();
function setConnectionStatus(next) {
  console.log(`[SOCKET] STATUS ${connectionStatus} -> ${next}`);

  if (connectionStatus === next) return;

  connectionStatus = next;
  statusListeners.forEach((fn) => fn(connectionStatus));
}
export function getConnectionStatus() { return connectionStatus; }
/** Returns an unsubscribe function. Calls `fn` once immediately with the current status. */
export function subscribeConnectionStatus(fn) {
  statusListeners.add(fn);
  fn(connectionStatus);
  return () => statusListeners.delete(fn);
}

// EP-025 — single source of truth for "is it safe to write right now",
// reused by api.js's request interceptor instead of duplicating the
// connection-state check there.
export function shouldBlockWrites() {
  return connectionStatus === 'reconnecting' || connectionStatus === 'disconnected';
}

// EP-025 — manual retry (banner click). socket.io-client's own reconnection
// manager already retries forever with backoff; calling connect() while it's
// mid-backoff makes it attempt right now instead of waiting out the delay.
// A no-op if already connected/connecting.
export function retryConnectionNow() {
  getSocket().connect();
}
/** Lazily create (once) and return the shared Socket.IO client. */
export function getSocket() {
  console.log("[SOCKET] getSocket() called");

  if (!socket) {
    console.log("[SOCKET] creating socket");
    console.log("[SOCKET] backendBase =", backendBase);

    socket = socketIO(backendBase, {
      // socket.io-client (v4) calls a function-valued `auth` option AS
      // `auth(callback)` and only sends the CONNECT packet from inside that
      // callback (see socket.io-client/build/esm/socket.js#onopen) — it never
      // reads a return value. Must call `cb(...)`, not `return ...`.
      auth: (cb) => cb(authToken ? { token: authToken } : {}),
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    socket.on("connect", () => {
      console.log("[SOCKET] CONNECT", socket.id);
      setConnectionStatus("connected");
    });

    socket.on("disconnect", (reason) => {
      console.log("[SOCKET] DISCONNECT", reason);
      setConnectionStatus("disconnected");
    });

    socket.on("connect_error", (err) => {
      console.error("[SOCKET] CONNECT_ERROR", err.message);
    });

    socket.io.on("reconnect_attempt", (n) => {
      console.log("[SOCKET] RECONNECT_ATTEMPT", n);
      setConnectionStatus("reconnecting");
    });

    socket.io.on("reconnect", (n) => {
      console.log("[SOCKET] RECONNECTED", n);
      setConnectionStatus("connected");
    });

    socket.io.on("reconnect_error", (err) => {
      console.error("[SOCKET] RECONNECT_ERROR", err.message);
    });

    socket.io.on("error", (err) => {
      console.error("[SOCKET] MANAGER_ERROR", err);
    });
  }

  return socket;
}