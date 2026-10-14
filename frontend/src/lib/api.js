import axios from 'axios';
import toast from 'react-hot-toast';
import { shouldBlockWrites } from './socket';

// Connection Layer (EP-003 Hybrid Client/Server): window.electron.backendBaseUrl
// is resolved once by the main process (Local Mode → localhost, Server Mode →
// the configured remote server) and exposed synchronously via preload.cjs —
// this file never needs to know which one it is. Falls back to the legacy
// backendPort field, then to a relative path for plain-browser/vite-preview mode.
const backendBase = window.electron?.backendBaseUrl
  ?? (window.electron?.backendPort ? `http://localhost:${window.electron.backendPort}` : '');

const api = axios.create({
  baseURL: `${backendBase}/api`,
  // Normal CRUD reads/writes. Long-running operations (device sync,
  // recalculation, cleanup, month processing) must pass LONG_OP — a device
  // convergence pull alone can take minutes, and the old global 5s timeout
  // made the UI report failure while the backend kept working.
  timeout: 15000,
});

// EP-011 — Manager Edition auth. Kept as a module-local variable (not read
// from authStore directly) so this file never imports the store — authStore
// imports api.js to make requests, and a two-way import would be circular.
// authStore calls setAuthToken() whenever the token changes (login/logout/
// hydrate); every request past that point picks up the current value.
let authToken = null;
export function setAuthToken(token) { authToken = token; }

// Expired / invalid / deactivated session. The backend answers 401 to any protected request whose token no longer works
// (expired JWT, bad signature, account deactivated or deleted). authStore registers a handler here that signs the user
// out locally so the gate shows the login screen again — registered (not imported) because authStore imports this file.
// Only a request that actually CARRIED a token can mean "your session ended"; 401s on pre-login calls, on the login
// request itself (wrong password) and on the /auth/me probe (owned by authStore.checkAuthRequired) are not handled here.
// 403 (authorization denied) is deliberately not an authentication failure and is never handled here.
let unauthorizedHandler = null;
export function setUnauthorizedHandler(fn) { unauthorizedHandler = fn; }

// While the session is over (authStore raises this when a 401 ends it, and lowers it only after a successful login) screens that stay
// mounted under the login overlay must not fire MUTATIONS with no valid session: they would only bounce off the server, and a stale
// operation must never be sent once the user signs back in. Reads still go out (they are harmless); /auth/* is never blocked.
let sessionBlocked = false;
export function setSessionBlocked(v) { sessionBlocked = !!v; }
const isAuthEndpoint = (url) => /\/auth\/(login|me|logout)(\?|$)/.test(String(url || ''));

// EP-025 — Enterprise Connection Recovery: block writes (not reads) while the
// shared socket reports the backend is down, instead of letting them fail
// individually mid-flight against a dead connection. Mutates `config` (not a
// fresh object) and tags it `_noRetry` so the response interceptor's retry
// branch below — which only knows how to retry a REAL network error — doesn't
// also fire on this synchronous, pre-network rejection.
api.interceptors.request.use((config) => {
  const method = (config.method || 'get').toLowerCase();
  if (sessionBlocked && !['get', 'head', 'options'].includes(method) && !isAuthEndpoint(config.url)) {
    const err = new Error('Session expired: the request was not sent');
    err.isSessionExpired = true;
    err.config = config;
    config._noRetry = true;
    return Promise.reject(err);
  }
  if (method !== 'get' && shouldBlockWrites()) {
    toast.error('لا يمكن الحفظ الآن — جارٍ إعادة الاتصال بالخادم', { id: 'write-blocked-offline' });
    config._noRetry = true;
    const err = new Error('Write blocked: backend connection is down');
    err.isConnectionBlocked = true;
    err.config = config;
    return Promise.reject(err);
  }
  if (authToken) config.headers.Authorization = `Bearer ${authToken}`;
  config._hadToken = !!authToken;
  return config;
});

/** Per-request override for known long-running endpoints (sync/recalc/cleanup). */
export const LONG_OP = { timeout: 10 * 60 * 1000 }; // 10 min — matches backend SYNC_TIMEOUT_MS

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 800;

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const config = err.config || {};

    if (err.response && err.response.status === 401 && config._hadToken && unauthorizedHandler && !isAuthEndpoint(config.url)) {
      try { unauthorizedHandler(err.response.data && err.response.data.error); } catch { /* never let session handling mask the original error */ }
    }

    // Only retry network errors (no response) — never retry 4xx/5xx (those are
    // intentional server responses that the caller must handle).
    const isNetworkError = !err.response;
    const retryCount = config._retryCount ?? 0;
    // Only idempotent reads are replayed. A write that failed with no response
    // (e.g. a timeout) may already have been applied by the server, so
    // re-sending it automatically could create a duplicate — the caller/user
    // decides instead.
    const isIdempotent = ['get', 'head', 'options'].includes((config.method || 'get').toLowerCase());

    if (isNetworkError && isIdempotent && retryCount < MAX_RETRIES && !config._noRetry) {
      config._retryCount = retryCount + 1;
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * config._retryCount));
      return api(config);
    }

    return Promise.reject(err);
  }
);

export default api;
