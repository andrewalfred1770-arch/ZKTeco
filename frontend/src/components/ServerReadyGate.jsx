import React, { useEffect, useState } from 'react';

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
            background: status === 'unreachable' ? 'rgba(239,68,68,0.95)' : 'rgba(37,99,235,0.95)',
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

  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 16,
      background: 'var(--bg, #0b1220)', color: 'var(--text, #e2e8f0)', zIndex: 9999,
    }}>
      {status === 'checking' ? (
        <>
          <div style={{
            width: 36, height: 36, borderRadius: '50%',
            border: '3px solid rgba(148,163,184,0.25)', borderTopColor: '#3b82f6',
            animation: 'spin 0.8s linear infinite',
          }} />
          <div style={{ fontSize: 13, color: 'var(--text-3, #94a3b8)' }}>جاري الاتصال بالخادم...</div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 14, fontWeight: 700 }}>تعذر الوصول إلى الخادم</div>
          <div style={{ fontSize: 12, color: 'var(--text-3, #94a3b8)', textAlign: 'center', maxWidth: 320 }}>
            لا يزال البرنامج يحاول الاتصال بالخادم في الخلفية. إذا استمرت المشكلة تحقّق من إعدادات الاتصال.
          </div>
          <button
            onClick={recheck}
            style={{
              padding: '8px 20px', borderRadius: 8, border: '1px solid #2563eb',
              background: '#1d4ed8', color: '#fff', fontSize: 13, cursor: 'pointer',
            }}
          >
            إعادة المحاولة الآن
          </button>
        </>
      )}
      <style>{'@keyframes spin { to { transform: rotate(360deg); } }'}</style>
    </div>
  );
}
