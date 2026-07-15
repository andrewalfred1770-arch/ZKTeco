import React, { useState } from 'react';
import { LogIn, Loader2, XCircle, UserRound, KeyRound } from 'lucide-react';
import useAuthStore from '../store/authStore';

// ─── Manager Edition — Login gate (EP-011) ────────────────────────────────────
// Shown when connected to a server that reports authEnabled:true (see
// authStore.checkAuthRequired, backed by the existing GET /api/auth/me) and no
// valid session is loaded yet. Manager has no local authentication of its own
// — this form only ever calls the server's existing POST /api/auth/login.
export default function LoginScreen() {
  const login = useAuthStore((s) => s.login);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setSubmitting(true);
    setError(null);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err.response?.data?.error || 'فشل تسجيل الدخول');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'var(--bg)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 3000, padding: 16,
      }}
      dir="rtl"
    >
      <form onSubmit={submit} style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 14, padding: 28, width: '100%', maxWidth: 380,
        boxShadow: '0 24px 70px rgba(0,0,0,0.35)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, flexShrink: 0,
            background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <LogIn style={{ width: 20, height: 20, color: '#60a5fa' }} />
          </div>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-1)' }}>تسجيل الدخول</h2>
            <p style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>PETSHROW ERP Manager</p>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 5 }}>
              <UserRound style={{ width: 13, height: 13 }} /> اسم المستخدم
            </label>
            <input
              className="input text-sm" dir="ltr" style={{ textAlign: 'left' }}
              value={username} onChange={(e) => setUsername(e.target.value)}
              autoFocus autoComplete="username"
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 5 }}>
              <KeyRound style={{ width: 13, height: 13 }} /> كلمة المرور
            </label>
            <input
              className="input text-sm" dir="ltr" style={{ textAlign: 'left' }}
              type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
        </div>

        {error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderRadius: 8, marginTop: 14,
            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}>
            <XCircle style={{ width: 15, height: 15, color: '#ef4444', flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: '#f87171', fontWeight: 600 }}>{error}</span>
          </div>
        )}

        <button type="submit" className="btn-primary text-sm justify-center" style={{ width: '100%', marginTop: 18 }} disabled={submitting}>
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
          دخول
        </button>
      </form>
    </div>
  );
}
