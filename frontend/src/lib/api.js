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

// EP-025 — Enterprise Connection Recovery: block writes (not reads) while the
// shared socket reports the backend is down, instead of letting them fail
// individually mid-flight against a dead connection. Mutates `config` (not a
// fresh object) and tags it `_noRetry` so the response interceptor's retry
// branch below — which only knows how to retry a REAL network error — doesn't
// also fire on this synchronous, pre-network rejection.
api.interceptors.request.use((config) => {
  const method = (config.method || 'get').toLowerCase();
  if (method !== 'get' && shouldBlockWrites()) {
    toast.error('لا يمكن الحفظ الآن — جارٍ إعادة الاتصال بالخادم', { id: 'write-blocked-offline' });
    config._noRetry = true;
    const err = new Error('Write blocked: backend connection is down');
    err.isConnectionBlocked = true;
    err.config = config;
    return Promise.reject(err);
  }
  if (authToken) config.headers.Authorization = `Bearer ${authToken}`;
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

    // Only retry network errors (no response) — never retry 4xx/5xx (those are
    // intentional server responses that the caller must handle).
    const isNetworkError = !err.response;
    const retryCount = config._retryCount ?? 0;

    if (isNetworkError && retryCount < MAX_RETRIES && !config._noRetry) {
      config._retryCount = retryCount + 1;
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * config._retryCount));
      return api(config);
    }

    return Promise.reject(err);
  }
);

export default api;
