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
// ── Reconnection after a SERVER-FORCED disconnect ──────────────────────────────────────────────────────────────────────
// socket.io-client retries transport failures by itself, but it never retries when the SERVER ends the session ("io server
// disconnect": the revalidation guard dropped the socket) or when a middleware refuses the handshake. Without this the client stayed
// disconnected for the rest of the session — and, since connection status "disconnected" blocks writes, the user could not save
// anything. This scheduler retries with exponential backoff (1 s, 2 s, 4 s ... capped at 30 s, plus up to 20% jitter so a whole LAN
// does not reconnect in the same instant after a server restart). Exactly one retry can be pending at any time.
export function createReconnectScheduler({
  baseMs = 1000, factor = 2, maxMs = 30000, jitter = 0.2, random = Math.random,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
} = {}) {
  let attempt = 0;
  let timer = null;
  const history = [];   // delays handed out (diagnostics / tests)
  const delayFor = (n) => Math.min(maxMs, Math.min(maxMs, baseMs * Math.pow(factor, n)) * (1 + jitter * random()));
  return {
    /** Arms ONE retry; further calls while it is pending are ignored. Returns true when a new timer was created. */
    schedule(fn) {
      if (timer !== null) return false;
      const d = Math.round(delayFor(attempt));
      attempt++;
      history.push(d); if (history.length > 50) history.shift();
      timer = setTimeoutFn(() => { timer = null; fn(); }, d);
      return true;
    },
    cancel() { if (timer !== null) { clearTimeoutFn(timer); timer = null; } },
    reset() { attempt = 0; },
    state() { return { attempt, pending: timer !== null, history: [...history] }; },
  };
}
let reconnect = createReconnectScheduler();
/** test hook: swap the backoff policy (tiny delays). Cancels any pending retry of the previous scheduler. */
export function __setReconnectPolicyForTests(policy) { reconnect.cancel(); reconnect = createReconnectScheduler(policy); }
export function __reconnectState() { return reconnect.state(); }

// The server answers a handshake with one of its own fixed messages. These mean "your session is not valid" (missing / bad / expired
// token, account missing or deactivated): retrying cannot help and must not loop — the user has to sign in again. Anything else
// (for example "could not verify the account" while the database is briefly unavailable, or NOT_READY) is transient and is retried.
const AUTH_REFUSAL = /^(غير مصرح|token غير صالح|انتهت صلاحية|الحساب غير موجود)/;
let socketUnauthorizedHandler = null;
/** authStore registers this (it imports this module, so the dependency is injected, not imported). */
export function setSocketUnauthorizedHandler(fn) { socketUnauthorizedHandler = fn; }

function scheduleReconnect() {
  setConnectionStatus('reconnecting');
  reconnect.schedule(() => { if (socket) socket.connect(); });
}

let authToken = null;
export function setSocketAuthToken(token) {
  const changed = token !== authToken;
  authToken = token;
  if (changed) { reconnect.cancel(); reconnect.reset(); }   // an identity change supersedes any pending retry of the old one
  // The shared socket is created at app start, before anyone has logged in. When authentication is on the server refuses
  // it, and socket.io does NOT retry a middleware rejection on its own — so without this the socket would stay down for
  // the whole session after a successful login (no live updates). A token change is an identity change: drop the current
  // connection (it was authorised for the OLD identity) and connect again, which re-evaluates the auth function above.
  if (changed && socket) { socket.disconnect(); socket.connect(); }
}

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
  reconnect.cancel();
  reconnect.reset();
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
      reconnect.cancel();
      reconnect.reset();
      setConnectionStatus("connected");
    });

    socket.on("disconnect", (reason) => {
      console.log("[SOCKET] DISCONNECT", reason);
      setConnectionStatus("disconnected");
      // "io server disconnect" = the server ended this session; socket.io will NOT reconnect by itself. Transport losses
      // are retried by socket.io's own manager, and "io client disconnect" is ours (token change) which reconnects itself.
      if (reason === "io server disconnect") scheduleReconnect();
    });

    socket.on("connect_error", (err) => {
      const message = String((err && err.message) || "");
      console.error("[SOCKET] CONNECT_ERROR", message);
      if (AUTH_REFUSAL.test(message)) {
        // The session is not valid: stop (no retry loop), stay "disconnected" so writes stay blocked, and — only if this client
        // actually held a token — hand over to the session-expired flow (login screen). Re-authenticating sets a new token, which
        // reconnects through setSocketAuthToken().
        reconnect.cancel();
        setConnectionStatus("disconnected");
        if (authToken && socketUnauthorizedHandler) { try { socketUnauthorizedHandler(message); } catch { /* never break the socket */ } }
        return;
      }
      // Middleware refusals that are NOT about the session (e.g. "could not verify the account") leave socket.io inactive: retry with backoff.
      if (socket && socket.active === false) scheduleReconnect();
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