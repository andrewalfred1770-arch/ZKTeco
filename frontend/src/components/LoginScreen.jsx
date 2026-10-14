import React, { useState } from 'react';
import { LogIn, Loader2, XCircle, UserRound, KeyRound } from 'lucide-react';
import useAuthStore from '../store/authStore';
import { useCompanyBrand } from '../lib/branding';
import { useTheme } from '../contexts/ThemeContext';

// ─── Manager Edition — Login gate (EP-011) ────────────────────────────────────
// Shown when connected to a server that reports authEnabled:true (see
// authStore.checkAuthRequired, backed by the existing GET /api/auth/me) and no
// valid session is loaded yet. Manager has no local authentication of its own
// — this form only ever calls the server's existing POST /api/auth/login.
export default function LoginScreen() {
  const { isLight } = useTheme();
  const brand = useCompanyBrand();
  const login = useAuthStore((s) => s.login);
  const sessionMessage = useAuthStore((s) => s.sessionMessage);
  const unsavedLabels = useAuthStore((s) => s.unsavedLabels) || [];
  const discardUnsaved = useAuthStore((s) => s.discardUnsaved);
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
        zIndex: 3000, padding: 16, overflow: 'hidden',
      }}
      dir="rtl"
    >
      {/* Hero backdrop — the uploaded login image, if any, kept deliberately
          faint (low opacity + blur + a full theme-colored wash on top) so it
          reads as ambience, not a photo the login form sits "on top of".
          Never a heavy background per the branding rules. */}
      {brand.loginBackgroundUrl && (
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0,
          backgroundImage:
            `linear-gradient(color-mix(in srgb, var(--bg) 90%, transparent), color-mix(in srgb, var(--bg) 90%, transparent)), url(${brand.loginBackgroundUrl})`,
          backgroundSize: 'cover', backgroundPosition: 'center',
          filter: 'blur(3px) saturate(0.85)',
          maskImage: 'radial-gradient(80% 70% at 50% 38%, #000 0%, transparent 100%)',
          WebkitMaskImage: 'radial-gradient(80% 70% at 50% 38%, #000 0%, transparent 100%)',
        }} />
      )}
      <form onSubmit={submit} style={{
        position: 'relative', zIndex: 1,
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 14, padding: 28, width: '100%', maxWidth: 380,
        boxShadow: '0 24px 70px rgba(0,0,0,0.35)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 20 }}>
          <div style={{
            width: 46, height: 46, borderRadius: 11, flexShrink: 0, overflow: 'hidden',
            background: brand.logoUrl ? 'var(--surface-2)' : (isLight ? 'rgba(59,130,246,0.12)' : 'rgba(47,129,247,0.12)'),
            border: '1px solid ' + (isLight ? 'rgba(59,130,246,0.3)' : 'rgba(47,129,247,0.3)'),
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {brand.logoUrl
              ? <img src={brand.logoUrl} alt={brand.name} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              : <LogIn style={{ width: 21, height: 21, color: isLight ? '#60a5fa' : '#79C0FF' }} />}
          </div>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: 17, fontWeight: 800, color: 'var(--text-1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{brand.name}</h2>
            <p style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>تسجيل الدخول · {brand.product}</p>
          </div>
        </div>

        {sessionMessage && (
          <div role="alert" data-testid="session-message" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderRadius: 8, marginBottom: 14,
            background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.35)' }}>
            <XCircle style={{ width: 15, height: 15, color: '#d97706', flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: '#b45309', fontWeight: 600 }}>{sessionMessage}</span>
          </div>
        )}

        {unsavedLabels.length > 0 && (
          <div role="alert" data-testid="unsaved-notice" style={{ padding: '9px 12px', borderRadius: 8, marginBottom: 14,
            background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.30)', fontSize: 12, color: 'var(--text-2)', lineHeight: 1.7 }}>
            <div style={{ fontWeight: 700 }}>لديك تعديلات غير محفوظة ({unsavedLabels.join('، ')})</div>
            <div>سُجّل الخروج قبل حفظها، لكنها ما زالت محفوظة في الذاكرة خلف هذه الشاشة. سجّل الدخول بالحساب نفسه لمتابعتها ثم اضغط «حفظ» من جديد — لن يُعاد إرسال أي شيء تلقائياً. تسجيل الدخول بحساب مختلف يتجاهل هذه التعديلات.</div>
            <button type="button" data-testid="discard-unsaved" onClick={discardUnsaved}
              style={{ marginTop: 6, fontSize: 11.5, fontWeight: 700, color: '#ef4444', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}>
              تجاهل التعديلات غير المحفوظة
            </button>
          </div>
        )}

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
