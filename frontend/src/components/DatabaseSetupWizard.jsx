import React, { useEffect, useRef, useState } from 'react';
import { Database, CheckCircle2, XCircle, Loader2, Save, RotateCcw, PlugZap } from 'lucide-react';
import api from '../lib/api';

// ─── Database Configuration Wizard (EP-010.1) ────────────────────────────────
// Lets a non-technical user fix a bad DATABASE_URL from the UI instead of
// hand-editing %APPDATA%/PETSHROW ERP/.env. Zero Electron-specific code —
// pure fetch-via-axios + React, so it works identically whether this bundle
// is loaded inside Electron (Windows/macOS/future Linux) or a plain browser
// against a Server Mode backend. Mounted once at the App root (see App.jsx),
// always polling /api/health in the background; renders nothing when the
// database is connected, so an already-configured install never sees it.

const REASON_LABELS = {
  'auth-failed':      { text: 'فشل التحقق من بيانات الدخول — Authentication Failed', icon: XCircle },
  'unreachable':      { text: 'الخادم غير متاح — Server Unreachable',                icon: XCircle },
  'database-missing': { text: 'قاعدة البيانات غير موجودة — Database Not Found',       icon: XCircle },
  'unknown':          { text: 'فشل الاتصال — Connection Failed',                     icon: XCircle },
};

const HEALTH_POLL_MS = 4000;
const RESTART_POLL_MS = 1500;
const RESTART_TIMEOUT_MS = 60000;

function ResultBanner({ result }) {
  if (!result) return null;
  if (result.ok) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 8,
        background: 'rgba(16,185,129,0.10)', border: '1px solid rgba(16,185,129,0.3)' }}>
        <CheckCircle2 style={{ width: 16, height: 16, color: '#10b981', flexShrink: 0 }} />
        <span style={{ fontSize: 13, color: '#10b981', fontWeight: 600 }}>✓ تم الاتصال بنجاح — Connected</span>
      </div>
    );
  }
  const meta = REASON_LABELS[result.reason] || REASON_LABELS.unknown;
  const Icon = meta.icon;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 8,
      background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}>
      <Icon style={{ width: 16, height: 16, color: '#ef4444', flexShrink: 0 }} />
      <span style={{ fontSize: 13, color: '#f87171', fontWeight: 600 }}>{meta.text}</span>
    </div>
  );
}

export default function DatabaseSetupWizard() {
  const [visible, setVisible] = useState(false);
  const [fields, setFields] = useState({ host: '', port: '3306', database: '', username: '', password: '' });
  const [prefilled, setPrefilled] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [restarting, setRestarting] = useState(false);
  const pollRef = useRef(null);

  const checkHealth = async () => {
    try {
      const { data } = await api.get('/health', { _noRetry: true });
      if (data.db === 'connected') { setVisible(false); return true; }
      return false;
    } catch (err) {
      const data = err.response?.data;
      if (data?.dbError === 'auth-failed') setVisible(true);
      return false;
    }
  };

  // Background health poll — the only thing that decides whether the wizard
  // shows at all. An already-working install always resolves db:connected on
  // the very first check, so this never renders anything for it.
  useEffect(() => {
    checkHealth();
    pollRef.current = setInterval(checkHealth, HEALTH_POLL_MS);
    return () => clearInterval(pollRef.current);
  }, []);

  // Pre-fill host/port/database/username (never password) the first time the
  // wizard becomes visible, so the common case (just the password is wrong)
  // only requires typing one field.
  useEffect(() => {
    if (!visible || prefilled) return;
    setPrefilled(true);
    api.get('/setup/current', { _noRetry: true })
      .then(({ data }) => {
        setFields(f => ({
          ...f,
          host: data.host || f.host,
          port: data.port || f.port,
          database: data.database || f.database,
          username: data.username || f.username,
        }));
      })
      .catch(() => {});
  }, [visible, prefilled]);

  const update = (key) => (e) => setFields(f => ({ ...f, [key]: e.target.value }));

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const { data } = await api.post('/setup/test-connection', fields, { _noRetry: true });
      setTestResult(data);
    } catch (err) {
      setTestResult({ ok: false, reason: err.response?.data?.reason || 'unknown' });
    } finally {
      setTesting(false);
    }
  };

  const waitForRestart = () => {
    const start = Date.now();
    const poll = async () => {
      const healthy = await checkHealth();
      if (healthy) { window.location.reload(); return; }
      if (Date.now() - start > RESTART_TIMEOUT_MS) {
        setRestarting(false);
        setSaveError('استغرقت إعادة التشغيل وقتاً طويلاً — أعد تشغيل التطبيق يدوياً إذا استمر ذلك');
        return;
      }
      setTimeout(poll, RESTART_POLL_MS);
    };
    setTimeout(poll, RESTART_POLL_MS);
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const { data } = await api.post('/setup/save', fields, { _noRetry: true });
      if (data.ok) {
        setSaving(false);
        setRestarting(true);
        waitForRestart();
      }
    } catch (err) {
      const reason = err.response?.data?.reason;
      setTestResult(reason ? { ok: false, reason } : null);
      setSaveError(err.response?.data?.error || 'فشل الحفظ');
      setSaving(false);
    }
  };

  const retry = () => { setSaveError(null); checkHealth(); };

  if (!visible) return null;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 2000, padding: 16,
      }}
      dir="rtl"
    >
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 14, padding: 24, width: '100%', maxWidth: 460,
        boxShadow: '0 24px 70px rgba(0,0,0,0.5)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 9, flexShrink: 0,
            background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Database style={{ width: 18, height: 18, color: '#60a5fa' }} />
          </div>
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-1)' }}>إعداد قاعدة البيانات</h3>
            <p style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>Database Configuration</p>
          </div>
        </div>

        <p style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.6, margin: '10px 0 16px' }}>
          تعذّر الاتصال بقاعدة البيانات ببيانات الدخول الحالية. أدخل بيانات قاعدة البيانات الصحيحة أدناه.
        </p>

        {restarting ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '24px 0' }}>
            <Loader2 style={{ width: 28, height: 28, color: '#60a5fa', animation: 'spin 1s linear infinite' }} />
            <span style={{ fontSize: 13, color: 'var(--text-2)', fontWeight: 600 }}>
              جارٍ إعادة تشغيل الخادم...
            </span>
            {saveError && <span style={{ fontSize: 12, color: '#f87171' }}>{saveError}</span>}
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ flex: 2, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-3)' }}>المضيف — Host</label>
                  <input className="input text-sm" dir="ltr" style={{ textAlign: 'left' }}
                    value={fields.host} onChange={update('host')} placeholder="localhost" />
                </div>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-3)' }}>المنفذ — Port</label>
                  <input className="input text-sm" dir="ltr" style={{ textAlign: 'left' }}
                    value={fields.port} onChange={update('port')} placeholder="3306" />
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-3)' }}>قاعدة البيانات — Database</label>
                <input className="input text-sm" dir="ltr" style={{ textAlign: 'left' }}
                  value={fields.database} onChange={update('database')} placeholder="zkteco_attendance" />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-3)' }}>اسم المستخدم — Username</label>
                <input className="input text-sm" dir="ltr" style={{ textAlign: 'left' }}
                  value={fields.username} onChange={update('username')} placeholder="root" />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-3)' }}>كلمة المرور — Password</label>
                <input className="input text-sm" dir="ltr" style={{ textAlign: 'left' }} type="password"
                  value={fields.password} onChange={update('password')} placeholder="••••••••" />
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <ResultBanner result={testResult} />
            </div>
            {saveError && (
              <p style={{ fontSize: 12, color: '#f87171', marginTop: 8 }}>{saveError}</p>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button className="btn-secondary text-xs flex-1 justify-center" onClick={retry} disabled={testing || saving}>
                <RotateCcw className="w-3.5 h-3.5" /> إعادة المحاولة
              </button>
              <button className="btn-secondary text-xs flex-1 justify-center" onClick={runTest} disabled={testing || saving}>
                {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlugZap className="w-3.5 h-3.5" />}
                اختبار الاتصال
              </button>
              <button className="btn-primary text-xs flex-1 justify-center" onClick={save} disabled={testing || saving}>
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                حفظ
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
