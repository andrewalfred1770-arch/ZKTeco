import React, { useEffect, useState } from 'react';
import StartupScreen from './launcher/StartupScreen';

// ─── Startup readiness gate ────────────────────────────────────────────────
// Root cause of the "فشل تحميل البيانات" / "تعذر تحميل المرتبات" false
// failures on normal startup: Dashboard/Payroll/etc. all fire their initial
// load() on mount with no idea whether the backend (bundled, Local Mode —
// or remote, Server Mode) has actually answered yet. A slow-but-healthy
// backend spawn (observed: several seconds past the splash's own 6s cosmetic
// timeout) meant those requests hit connection-refused/timeout, showed a
// one-shot error toast, and never retried.
//
// This is the ONE shared gate for all of them (per the "avoid duplicate
// readiness logic" requirement) — it wraps the routed app content, not each
// page individually. Pages themselves are unchanged.
//
// Two readiness sources are combined because either alone races:
//   - getReadyState(): the CURRENT snapshot (covers the common fast case,
//     where the backend was already ready before this component mounted).
//   - onMessage('backend-ready' / 'backend-unreachable'): the live push from
//     lifecycle.js's poller (covers the slow case).
//
// 'backend-unreachable' is a genuine failure state (server never answered
// within the timeout) — it is NEVER treated as "ready", and the gate keeps
// listening afterward, since lifecycle.js keeps polling in the background
// and will still push 'backend-ready' if the backend comes up shortly after.
export default function ServerReadyGate({ children }) {
  const isElectron = !!window.electron?.isElectron;
  const [status, setStatus] = useState(isElectron ? 'checking' : 'ready');
  // 'server' once the main process reports Server Mode (remote backend that this
  // instance never spawns) — the app is then shown immediately and readiness is
  // surfaced as a non-blocking banner instead of a full-screen overlay.
  const [mode, setMode] = useState(null);

  useEffect(() => {
    if (!isElectron) return;
    let cancelled = false;

    window.electron.getReadyState?.()
      .then((s) => {
        if (cancelled) return;
        if (s?.mode) setMode(s.mode);
        if (s?.ready) setStatus('ready');
      })
      .catch(() => {});

    const unsubscribe = window.electron.onMessage((msg) => {
      if (msg?.type !== 'app:ready-state') return;
      if (msg.state === 'backend-ready') setStatus('ready');
      else if (msg.state === 'backend-unreachable') setStatus((s) => (s === 'ready' ? s : 'unreachable'));
    });

    return () => { cancelled = true; unsubscribe?.(); };
  }, [isElectron]);

  const recheck = () => {
    setStatus('checking');
    window.electron.getReadyState?.()
      .then((s) => setStatus(s?.ready ? 'ready' : 'unreachable'))
      .catch(() => setStatus('unreachable'));
  };

  // Server Mode: never hold the app behind the gate — it is rendered at once and
  // the connection state shows in a slim banner. Children stay at the same tree
  // position in every state, so they are never remounted when readiness flips.
  const showApp = status === 'ready' || mode === 'server';

  if (showApp) {
    return (
      <>
        {children}
        {status !== 'ready' && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
            padding: '6px 16px', fontSize: 12, direction: 'rtl',
            background: status === 'unreachable' ? 'rgba(239,68,68,0.95)' : 'rgba(32,40,43,0.96)',
            color: '#fff',
          }}>
            <span>
              {status === 'unreachable'
                ? 'تعذر الوصول إلى الخادم — لا يزال البرنامج يحاول الاتصال في الخلفية (تحقّق من إعدادات الاتصال)'
                : 'جاري الاتصال بالخادم...'}
            </span>
            {status === 'unreachable' && (
              <button
                onClick={recheck}
                style={{
                  padding: '2px 12px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.7)',
                  background: 'transparent', color: '#fff', fontSize: 12, cursor: 'pointer',
                }}
              >
                إعادة المحاولة الآن
              </button>
            )}
          </div>
        )}
      </>
    );
  }

  // Branded startup screen. Same two states as before ('checking' / 'unreachable'), same retry handler; the screen reports only what
  // GET /api/startup-status actually returned (see components/launcher/StartupScreen.jsx and lib/startupStages.js).
  return <StartupScreen status={status} onRetry={recheck} />;
}
