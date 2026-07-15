import { create } from 'zustand';
import api, { setAuthToken } from '../lib/api';
import { setSocketAuthToken } from '../lib/socket';

// EP-011 — Manager Edition auth. Server edition never mounts LoginScreen or
// calls login()/hydrate(), so this store stays inert there — token/user stay
// null forever, matching AUTH_ENABLED=false's "everything passes through
// unchanged" behavior (backend/src/middleware/auth.js).
//
// GET /api/auth/me (backend/src/routes/auth.js) already reports whether the
// connected server has auth turned on at all — hydrate()/checkAuthRequired()
// use that to decide whether Manager needs to show a login screen in the
// first place, rather than assuming every server requires it.
const useAuthStore = create((set, get) => ({
  user: null,
  token: null,
  authEnabled: null, // null = not probed yet; true/false once known
  hydrated: false,

  /** Restore a persisted session (if any) on Manager startup. */
  async hydrate() {
    let token = null;
    if (window.electron?.session) {
      const { token: saved } = await window.electron.session.load();
      token = saved || null;
    }
    if (token) {
      setAuthToken(token);
      setSocketAuthToken(token);
      set({ token });
    }
    await get().checkAuthRequired();
    set({ hydrated: true });
  },

  /** Probes the connected server's /api/auth/me — tells us if login is required at all. */
  async checkAuthRequired() {
    try {
      const { data } = await api.get('/auth/me');
      set({ authEnabled: !!data.authEnabled, user: data.user || null });
    } catch (err) {
      if (err.response?.status === 401) {
        setAuthToken(null);
        setSocketAuthToken(null);
        set({ token: null, user: null, authEnabled: true });
      } else {
        // Server unreachable/misconfigured — leave authEnabled unknown so the
        // caller doesn't wrongly gate on a login screen it can't fulfil yet.
        set({ authEnabled: null });
      }
    }
  },

  async login(username, password) {
    const { data } = await api.post('/auth/login', { username, password });
    setAuthToken(data.token);
    setSocketAuthToken(data.token);
    set({ token: data.token, user: data.user, authEnabled: true });
    if (window.electron?.session) await window.electron.session.save(data.token);
    return data;
  },

  async logout() {
    setAuthToken(null);
    setSocketAuthToken(null);
    set({ token: null, user: null });
    if (window.electron?.session) await window.electron.session.clear();
    try { await api.post('/auth/logout'); } catch { /* stateless JWT — nothing to clean up server-side */ }
  },
}));

export default useAuthStore;
