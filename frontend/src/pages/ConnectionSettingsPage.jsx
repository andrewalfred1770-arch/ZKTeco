import React, { useEffect, useState } from 'react';
import {
  Wifi, Server, HardDrive, Loader2, CheckCircle2, XCircle,
  Save, RotateCcw, PlugZap,
} from 'lucide-react';
import toast from 'react-hot-toast';

// ─── Connection Layer settings (EP-003 Hybrid Client/Server) ─────────────────
// Electron-only page: the mode/serverUrl decide whether this desktop install
// spawns its own backend (Local Mode) or connects to an existing one over the
// network (Server Mode). The frontend never talks to this state directly
// outside this page — src/lib/api.js and socket.js just read
// window.electron.backendBaseUrl, which main process resolves once at startup.
// A saved change only takes effect after restart, same as Update Center prefs.

function ResultRow({ label, state }) {
  // state: true | false | null (unknown/not-applicable)
  const icon = state === true
    ? <CheckCircle2 style={{ width: 15, height: 15, color: '#10b981' }} />
    : state === false
      ? <XCircle style={{ width: 15, height: 15, color: '#ef4444' }} />
      : <span style={{ width: 15, height: 15, display: 'inline-block', textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>—</span>;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
      {icon}
      <span style={{ fontSize: 13, color: 'var(--text-2)' }}>{label}</span>
    </div>
  );
}

export default function ConnectionSettingsPage() {
  const isElectron = !!window.electron?.isElectron;

  const [mode, setMode]           = useState('local');
  const [serverUrl, setServerUrl] = useState('');
  const [savedMode, setSavedMode] = useState('local');
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [testing, setTesting]     = useState(false);
  const [result, setResult]       = useState(null);

  useEffect(() => {
    if (!isElectron) { setLoading(false); return; }
    window.electron.connection.getSettings()
      .then((s) => {
        setMode(s.mode || 'local');
        setServerUrl(s.serverUrl || '');
        setSavedMode(s.mode || 'local');
      })
      .catch(() => toast.error('فشل تحميل إعدادات الاتصال'))
      .finally(() => setLoading(false));
  }, [isElectron]);

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const r = await window.electron.connection.test({ mode, serverUrl });
      setResult(r);
      if (!r.reachable) toast.error('تعذّر الوصول إلى الخادم');
      else if (r.versionCompatible === false) toast('الخادم متصل لكن الإصدار غير متوافق', { icon: '⚠️' });
      else toast.success('الاتصال ناجح');
    } catch (err) {
      toast.error('فشل اختبار الاتصال');
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (mode === 'server' && !serverUrl.trim()) {
      toast.error('يجب إدخال عنوان الخادم أولاً');
      return;
    }
    setSaving(true);
    try {
      await window.electron.connection.setSettings({ mode, serverUrl: serverUrl.trim() });
      setSavedMode(mode);
      toast.success('تم حفظ الإعدادات — أعد تشغيل التطبيق لتطبيق التغييرات');
    } catch {
      toast.error('فشل الحفظ');
    } finally {
      setSaving(false);
    }
  };

  const restartNow = () => window.electron.relaunch();

  if (!isElectron) {
    return (
      <div className="flex flex-col gap-4" dir="rtl">
        <div className="page-header">
          <h1 className="page-title">إعدادات الاتصال</h1>
        </div>
        <div className="card p-5">
          <p style={{ fontSize: 13, color: 'var(--text-3)' }}>
            هذه الصفحة متاحة فقط داخل تطبيق سطح المكتب.
          </p>
        </div>
      </div>
    );
  }

  const modeChangedPendingRestart = savedMode !== mode;

  return (
    <div className="flex flex-col gap-6" style={{ flex: 1, overflow: 'auto', minHeight: 0 }} dir="rtl">
      <div className="page-header">
        <div>
          <h1 className="page-title">إعدادات الاتصال</h1>
          <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
            وضع محلي (يشغّل الخادم على هذا الجهاز) أو وضع خادم (اتصال بخادم موجود على الشبكة)
          </p>
        </div>
        {loading && <Loader2 className="w-5 h-5 animate-spin text-blue-400" />}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* ── Mode + URL ────────────────────────────────────────────────── */}
        <div className="card p-5 flex flex-col gap-4">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: 'var(--text-1)' }}>
            <PlugZap style={{ width: 16, height: 16, color: '#79C0FF' }} />
            وضع التشغيل
          </h3>

          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={() => setMode('local')}
              style={{
                flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                padding: '14px 10px', borderRadius: 10, cursor: 'pointer',
                background: mode === 'local' ? 'rgba(47,129,247,0.12)' : 'var(--surface-2)',
                border: mode === 'local' ? '1.5px solid #2F81F7' : '1px solid var(--border)',
              }}
            >
              <HardDrive style={{ width: 20, height: 20, color: mode === 'local' ? '#79C0FF' : 'var(--text-3)' }} />
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-1)' }}>محلي</span>
              <span style={{ fontSize: 10.5, color: 'var(--text-3)', textAlign: 'center' }}>يشغّل التطبيق الخادم تلقائياً</span>
            </button>
            <button
              onClick={() => setMode('server')}
              style={{
                flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                padding: '14px 10px', borderRadius: 10, cursor: 'pointer',
                background: mode === 'server' ? 'rgba(47,129,247,0.12)' : 'var(--surface-2)',
                border: mode === 'server' ? '1.5px solid #2F81F7' : '1px solid var(--border)',
              }}
            >
              <Server style={{ width: 20, height: 20, color: mode === 'server' ? '#79C0FF' : 'var(--text-3)' }} />
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-1)' }}>خادم</span>
              <span style={{ fontSize: 10.5, color: 'var(--text-3)', textAlign: 'center' }}>اتصال بخادم موجود على الشبكة</span>
            </button>
          </div>

          {mode === 'server' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-3)' }}>عنوان الخادم</label>
              <input
                className="input text-sm"
                placeholder="http://192.168.1.10:5000"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                dir="ltr"
                style={{ textAlign: 'left' }}
              />
              <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                أمثلة: http://192.168.1.10:5000 · http://server.company.local:5000 · https://erp.company.com
              </span>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button className="btn-secondary text-xs flex-1 justify-center" onClick={runTest} disabled={testing}>
              {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wifi className="w-3.5 h-3.5" />}
              اختبار الاتصال
            </button>
            <button className="btn-primary text-xs flex-1 justify-center" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              حفظ
            </button>
          </div>

          {modeChangedPendingRestart === false && savedMode && (
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
              الوضع الحالي الفعّال: <strong>{savedMode === 'server' ? 'خادم' : 'محلي'}</strong>
            </div>
          )}

          <button className="btn-secondary text-xs justify-center" onClick={restartNow} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <RotateCcw className="w-3.5 h-3.5" /> إعادة تشغيل التطبيق الآن
          </button>
        </div>

        {/* ── Test results ──────────────────────────────────────────────── */}
        <div className="card p-5 flex flex-col gap-2">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: 'var(--text-1)', marginBottom: 4 }}>
            <Wifi style={{ width: 16, height: 16, color: '#34d399' }} />
            نتيجة الفحص
          </h3>

          {!result && !testing && (
            <p style={{ fontSize: 12, color: 'var(--text-3)' }}>اضغط "اختبار الاتصال" لفحص الوضع الحالي.</p>
          )}

          {testing && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0' }}>
              <Loader2 style={{ width: 14, height: 14, color: '#79C0FF', animation: 'spin 1s linear infinite' }} />
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>جاري الفحص...</span>
            </div>
          )}

          {result && !testing && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <ResultRow label="الخادم قابل للوصول" state={result.reachable} />
              <ResultRow label="قاعدة البيانات متصلة" state={result.reachable ? result.dbConnected : null} />
              <ResultRow label="Socket.IO متصل" state={result.reachable ? result.socketConnected : null} />
              <ResultRow label="الإصدار متوافق" state={result.versionCompatible} />
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-3)', display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span dir="ltr" style={{ textAlign: 'right' }}>العنوان: {result.baseUrl}</span>
                {result.remoteVersion && <span>إصدار الخادم: {result.remoteVersion} (بروتوكول {result.remoteApiVersion ?? '—'})</span>}
                {result.error && <span style={{ color: '#f87171' }}>{result.error}</span>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
