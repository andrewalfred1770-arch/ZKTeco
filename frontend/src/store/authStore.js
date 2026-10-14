import { create } from 'zustand';
import api, { setAuthToken, setUnauthorizedHandler, setSessionBlocked } from '../lib/api';
import { setSocketAuthToken, setSocketUnauthorizedHandler } from '../lib/socket';
import { listUnsavedWork } from '../lib/unsavedWork';

// EP-011 — Manager Edition auth. Server edition never mounts LoginScreen or
// calls login()/hydrate(), so this store stays inert there — token/user stay
// null forever, matching AUTH_ENABLED=false's "everything passes through
// unchanged" behavior (backend/src/middleware/auth.js).
//
// GET /api/auth/me (backend/src/routes/auth.js) already reports whether the
// connected server has auth turned on at all — hydrate()/checkAuthRequired()
// use that to decide whether Manager needs to show a login screen in the
// first place, rather than assuming every server requires it.
// Text shown on the login screen after a session ended. Only the backend's own fixed Arabic messages are expected; anything
// that is not a short plain string, or that looks like it contains a JWT, is replaced by the generic message so a token can
// never end up on screen.
const GENERIC_SESSION_MESSAGE = 'انتهت جلسة الدخول أو لم تعد صالحة — الرجاء تسجيل الدخول من جديد';
function safeSessionMessage(m) {
  if (typeof m !== 'string') return GENERIC_SESSION_MESSAGE;
  const t = m.trim();
  if (!t || t.length > 200 || /eyJ[\w-]+\.[\w-]+\.[\w-]*/.test(t)) return GENERIC_SESSION_MESSAGE;
  return t;
}

const useAuthStore = create((set, get) => ({
  user: null,
  token: null,
  sessionMessage: null, // why the user is back on the login screen (expired / invalid / deactivated session), or null
  // Unsaved-edit protection (lib/unsavedWork.js): labels (never values) of the screens that held unsaved edits when the session
  // ended. While non-empty the gates keep those screens MOUNTED under the login overlay so nothing typed is lost; it is cleared on
  // a successful re-login by the same user, or by discardUnsaved(). expiredUserId = whose edits they are. appEpoch is the React
  // key of the app subtree: bumping it remounts every screen (that is what "discard" means).
  unsavedLabels: [],
  expiredUserId: null,
  appEpoch: 0,
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

  /**
   * A protected request was answered 401 although this client held a token: the session is over. Sign out locally (the
   * ManagerGate / ServerAuthGate then render LoginScreen, no restart needed) and remember why. Idempotent: the burst of
   * parallel requests that all fail with 401 triggers ONE sign-out — once the token is gone the rest return immediately.
   */
  handleSessionExpired(serverMessage) {
    if (!get().token) return;
    const unsavedLabels = listUnsavedWork();   // evaluated once, right now: labels only
    const expiredUserId = get().user && get().user.id !== undefined ? get().user.id : null;
    setAuthToken(null);
    setSocketAuthToken(null);
    setSessionBlocked(true);   // no mutation leaves the client until the user has signed in again
    set({ token: null, user: null, authEnabled: true, sessionMessage: safeSessionMessage(serverMessage), unsavedLabels, expiredUserId });
    if (window.electron?.session) Promise.resolve(window.electron.session.clear()).catch(() => {});
  },

  /** The user chose to give up the unsaved edits kept in memory: remount every screen empty and fall back to the plain login view. */
  discardUnsaved() {
    set({ unsavedLabels: [], expiredUserId: null, appEpoch: get().appEpoch + 1 });
  },

  /** Probes the connected server's /api/auth/me — tells us if login is required at all. */
  async checkAuthRequired() {
    try {
      // Short, non-retried probe: an unreachable server must fail fast (the
      // caller's background loop retries with backoff) instead of holding the
      // UI on the default 15s timeout x 3 attempts.
      const { data } = await api.get('/auth/me', { timeout: 5000, _noRetry: true });
      set({ authEnabled: !!data.authEnabled, user: data.user || null });
    } catch (err) {
      if (err.response?.status === 401) {
        const hadToken = !!get().token;   // a saved session that no longer works -> say so on the login screen
        setAuthToken(null);
        setSocketAuthToken(null);
        set({ token: null, user: null, authEnabled: true, ...(hadToken ? { sessionMessage: safeSessionMessage(err.response?.data?.error) } : {}) });
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
    // Edits kept in memory belong to the account that was signed in. Same account -> resume (screens untouched, the user presses
    // Save again; nothing is re-sent automatically). A different account -> never let the old drafts be saved under it: remount.
    setSessionBlocked(false);
    const prev = get();
    const sameUser = prev.unsavedLabels.length === 0 || (prev.expiredUserId !== null && prev.expiredUserId === data.user?.id);
    set({
      token: data.token, user: data.user, authEnabled: true, sessionMessage: null,
      unsavedLabels: [], expiredUserId: null, appEpoch: sameUser ? prev.appEpoch : prev.appEpoch + 1,
    });
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

setUnauthorizedHandler((message) => useAuthStore.getState().handleSessionExpired(message));
// A live-connection handshake refused because the account/token is no longer valid (e.g. deactivated while the app sat idle) ends the
// session the same way an HTTP 401 does.
setSocketUnauthorizedHandler((message) => useAuthStore.getState().handleSessionExpired(message));

export default useAuthStore;
