import { io as socketIO } from 'socket.io-client';

// Connection Layer (EP-003 Hybrid Client/Server): same backendBaseUrl
// resolution as lib/api.js — Local Mode or Server Mode, the socket connects
// to whichever backend the main process resolved at startup. Shared here so
// every page that needs live updates reuses ONE connection instead of
// opening a new socket per mounted page.
const backendBase = window.electron?.backendBaseUrl
  ?? (window.electron?.backendPort ? `http://localhost:${window.electron.backendPort}` : 'http://localhost:5000');

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

/** Lazily create (once) and return the shared Socket.IO client. */
export function getSocket() {
  if (!socket) {
    socket = socketIO(backendBase, {
      transports: ['websocket', 'polling'],
      auth: () => (authToken ? { token: authToken } : {}),
      // Explicit values for socket.io-client's own defaults — documents the
      // reconnection policy rather than changing it (reconnection:true,
      // delay 1000ms→5000ms backoff are what the client already did
      // implicitly). Infinity matches a long-running desktop app: there is
      // no reasonable point at which this app should stop trying to reach
      // its own backend.
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    socket.on('connect',          () => setConnectionStatus('connected'));
    socket.on('disconnect',       () => setConnectionStatus('reconnecting'));
    socket.on('reconnect_attempt',() => setConnectionStatus('reconnecting'));
    socket.on('reconnect',        () => setConnectionStatus('connected'));
    socket.on('connect_error',    () => setConnectionStatus('reconnecting'));
  }
  return socket;
}
