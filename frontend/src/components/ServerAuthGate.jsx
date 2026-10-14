import React, { useEffect, useState } from 'react';
import useAuthStore from '../store/authStore';
import LoginScreen from './LoginScreen';
import { gateView } from '../lib/authGate';

// Server edition — login gate for its OWN backend.
//
// The Server edition runs the backend on the same PC. While that backend has authentication disabled (the default
// single-machine setup) nothing changes: the app renders exactly as before and never shows a login. When the
// backend reports authEnabled:true (GET /api/auth/me, via authStore.checkAuthRequired) and there is no session
// token, LoginScreen is shown instead of the app, so the server PC's own window can sign in the same way a
// Manager client does. The backend still enforces authentication and roles on every request; this gate only
// provides the UI to obtain a token.
//
// If the session ENDS while screens hold unsaved edits (lib/unsavedWork.js), the app stays mounted under the login overlay
// (gateView 'app+login') so the edits survive until the user signs in again (same account) or explicitly discards them.
// The children live in a fragment keyed by appEpoch: bumping it (discard / different account) is what remounts them empty.
//
// "Unknown" (the backend is still starting, or unreachable) renders the app, as before: ServerReadyGate owns the
// starting/unreachable states. The probe keeps retrying with a growing delay until the backend answers, so a
// backend that comes up with authentication enabled is picked up without a restart.
//
// Manager edition does not use this component (it has its own gate, ManagerGate in App.jsx).
export default function ServerAuthGate({ children }) {
  const hydrate = useAuthStore((s) => s.hydrate);
  const hydrated = useAuthStore((s) => s.hydrated);
  const authEnabled = useAuthStore((s) => s.authEnabled);
  const token = useAuthStore((s) => s.token);
  const unsavedLabels = useAuthStore((s) => s.unsavedLabels);
  const appEpoch = useAuthStore((s) => s.appEpoch);
  const checkAuthRequired = useAuthStore((s) => s.checkAuthRequired);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => { hydrate(); }, [hydrate]);

  useEffect(() => {
    if (!hydrated || authEnabled !== null) return undefined;
    let cancelled = false;
    const delay = Math.min(1000 * Math.pow(1.5, attempt), 10000);
    const timer = setTimeout(async () => {
      await checkAuthRequired();
      if (!cancelled) setAttempt((n) => n + 1);
    }, delay);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [hydrated, authEnabled, attempt, checkAuthRequired]);

  const view = gateView({ authEnabled, token, unsavedCount: (unsavedLabels || []).length });
  if (view === 'login') return <LoginScreen />;
  return (
    <>
      <React.Fragment key={appEpoch}>{children}</React.Fragment>
      {view === 'app+login' && <LoginScreen />}
    </>
  );
}
