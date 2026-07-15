import React, { useState } from 'react';
import { Server, CheckCircle2, XCircle, Loader2, PlugZap, ArrowRight } from 'lucide-react';

// ─── Manager Edition — First-Run Connection Wizard (EP-011) ──────────────────
// Mandatory gate shown when a Manager build has no saved server address yet.
// Deliberately thin: every capability here already exists and is exercised by
// ConnectionSettingsPage.jsx's 'server' mode — this component reuses the exact
// same IPC bridge (window.electron.connection.*) rather than adding a second
// implementation. Once Connect succeeds, connection-settings.json is written
// to the same persistent config path Local Mode has always used
// (%APPDATA%/PETSHROW ERP/config on Windows, ~/Library/Application Support/
// PETSHROW ERP/config on macOS — see electron/connectionSettings.js), and the
// app relaunches so lifecycle.js picks up the new mode from a clean start.

function ResultRow({ label, state }) {
  const icon = state === true
    ? <CheckCircle2 style={{ width: 15, height: 15, color: '#10b981' }} />
    : state === false
      ? <XCircle style={{ width: 15, height: 15, color: '#ef4444' }} />
      : <span style={{ width: 15, height: 15, display: 'inline-block', textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>—</span>;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' }}>
      {icon}
      <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{label}</span>
    </div>
  );
}

export default function ConnectionWizard() {
  const [serverUrl, setServerUrl] = useState('');
  const [testing, setTesting]     = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [result, setResult]       = useState(null);
  const [error, setError]         = useState(null);

  const runTest = async () => {
    if (!serverUrl.trim()) { setError('أدخل عنوان الخادم أولاً'); return; }
    setError(null);
    setTesting(true);
    setResult(null);
    try {
      const r = await window.electron.connection.test({ mode: 'server', serverUrl: serverUrl.trim() });
      setResult(r);
      if (!r.reachable) setError('تعذّر الوصول إلى الخادم — تحقق من العنوان والشبكة');
    } catch {
      setError('فشل اختبار الاتصال');
    } finally {
      setTesting(false);
    }
  };

  const connect = async () => {
    setConnecting(true);
    setError(null);
    try {
      await window.electron.connection.setSettings({ mode: 'server', serverUrl: serverUrl.trim() });
      // Same pattern as Connection Settings' mode switch — a saved connection
      // target only takes effect from a clean process start, so relaunch
      // immediately rather than trying to hot-swap api.js/socket.js's
      // already-resolved backendBaseUrl.
      window.electron.relaunch();
    } catch {
      setError('فشل حفظ إعدادات الاتصال');
      setConnecting(false);
    }
  };

  const canConnect = result?.reachable === true;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 3000, padding: 16,
      }}
      dir="rtl"
    >
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 14, padding: 28, width: '100%', maxWidth: 480,
        boxShadow: '0 24px 70px rgba(0,0,0,0.55)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, flexShrink: 0,
            background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Server style={{ width: 20, height: 20, color: '#60a5fa' }} />
          </div>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-1)' }}>الاتصال بخادم PETSHROW ERP</h2>
            <p style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>PETSHROW ERP Manager — Connect to Server</p>
          </div>
        </div>

        <p style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.6, margin: '10px 0 18px' }}>
          هذا الجهاز عبارة عن عميل (Manager) ولا يحتوي على قاعدة بيانات خاصة به. أدخل عنوان خادم PETSHROW ERP المشغّل على الشبكة.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
          <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-3)' }}>عنوان الخادم — Server Address</label>
          <input
            className="input text-sm"
            dir="ltr"
            style={{ textAlign: 'left' }}
            placeholder="http://192.168.1.145:5000"
            value={serverUrl}
            onChange={(e) => { setServerUrl(e.target.value); setResult(null); }}
          />
          <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
            مثال: http://192.168.1.145:5000 · أو https://erp.company.com
          </span>
        </div>

        {error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderRadius: 8, marginBottom: 10,
            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}>
            <XCircle style={{ width: 15, height: 15, color: '#ef4444', flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: '#f87171', fontWeight: 600 }}>{error}</span>
          </div>
        )}

        {result && (
          <div style={{ padding: '4px 2px 8px', borderTop: '1px solid var(--border)', marginBottom: 4 }}>
            <ResultRow label="الخادم قابل للوصول" state={result.reachable} />
            <ResultRow label="قاعدة البيانات متصلة" state={result.reachable ? result.dbConnected : null} />
            <ResultRow label="Socket.IO متصل" state={result.reachable ? result.socketConnected : null} />
            <ResultRow label="الإصدار متوافق" state={result.versionCompatible} />
            {result.remoteVersion && (
              <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 4 }}>
                إصدار الخادم: {result.remoteVersion} (بروتوكول {result.remoteApiVersion ?? '—'})
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="btn-secondary text-xs flex-1 justify-center" onClick={runTest} disabled={testing || connecting}>
            {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlugZap className="w-3.5 h-3.5" />}
            اختبار الاتصال
          </button>
          <button className="btn-primary text-xs flex-1 justify-center" onClick={connect} disabled={!canConnect || connecting}>
            {connecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
            اتصال
          </button>
        </div>
      </div>
    </div>
  );
}
