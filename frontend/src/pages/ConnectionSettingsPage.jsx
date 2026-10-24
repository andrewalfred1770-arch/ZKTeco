import React, { useEffect, useState } from 'react';
import {
  Wifi, Server, HardDrive, Loader2, CheckCircle2, XCircle, Info,
  Save, RotateCcw, PlugZap, Globe, Lock, DatabaseBackup, Download,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { isStandalone, isManager } from '../lib/edition';

// ─── Connection Layer settings (EP-003 Hybrid Client/Server) ─────────────────
// Electron-only page: the mode/serverUrl decide whether this desktop install
// spawns its own backend (Local Mode) or connects to an existing one over the
// network (Server Mode). The frontend never talks to this state directly
// outside this page — src/lib/api.js and socket.js just read
// window.electron.backendBaseUrl, which main process resolves once at startup.
// A saved change only takes effect after restart, same as Update Center prefs.

function ResultRow({ label, state }) {
  // state: true | false | null (unknown/not-applicable) | 'auth_required'
  // (server + network are healthy — Socket.IO just correctly requires login
  // before this pre-login probe can hold a real-time connection open)
  const icon = state === true
    ? <CheckCircle2 style={{ width: 15, height: 15, color: '#10b981' }} />
    : state === 'auth_required'
      ? <Info style={{ width: 15, height: 15, color: '#1E7A34' }} />
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

// Phase 29 — Web Client: this page is inherently pinned to whatever server
// served it (see src/lib/api.js — a plain browser falls back to a
// same-origin relative baseURL). There is deliberately no "connect to a
// different server" field here: accepting an arbitrary cross-origin URL
// from the page would require relaxing the backend's CORS allowlist to
// match, which is a real security regression (see F2 in the Phase 25
// audit) for a convenience the web deployment model doesn't need — the web
// client is meant to be served BY the server it talks to (Section 19).
// This view is read-only: it reports the effective (same-origin) server
// and lets the manager verify reachability, matching Section 22's
// Connected/Server-unavailable requirement without exposing internals.
const REQUIRED_API_VERSION = 1; // mirrors frontend/electron/constants.js

function BrowserConnectionView() {
  const [testing, setTesting] = useState(false);
  const [result, setResult]   = useState(null);

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const { data } = await api.get('/health');
      const remoteApiVersion = data?.apiVersion ?? null;
      setResult({
        reachable: true,
        dbConnected: data?.db === 'connected',
        remoteVersion: data?.version || null,
        remoteApiVersion,
        versionCompatible: remoteApiVersion == null ? null : remoteApiVersion === REQUIRED_API_VERSION,
      });
      toast.success('الاتصال ناجح');
    } catch (err) {
      setResult({ reachable: false, error: 'تعذّر الوصول إلى الخادم' });
      toast.error('تعذّر الوصول إلى الخادم');
    } finally {
      setTesting(false);
    }
  };

  useEffect(() => { runTest(); }, []);

  return (
    <div className="flex flex-col gap-4" dir="rtl">
      <div className="page-header">
        <h1 className="page-title">إعدادات الاتصال</h1>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card p-5 flex flex-col gap-3">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: 'var(--text-1)' }}>
            <Globe style={{ width: 16, height: 16, color: 'var(--accent)' }} />
            خادم PETSHROW
          </h3>
          <p style={{ fontSize: 12, color: 'var(--text-3)' }}>
            نسخة الويب متصلة دائماً بالخادم الذي قدّم هذه الصفحة — لا يمكن تغييره من هنا.
          </p>
          <div style={{ fontSize: 12, color: 'var(--text-2)', direction: 'ltr', textAlign: 'right', wordBreak: 'break-all' }}>
            {window.location.origin}
          </div>
          <button className="btn-secondary text-xs justify-center" onClick={runTest} disabled={testing} style={{ marginTop: 4 }}>
            {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wifi className="w-3.5 h-3.5" />}
            اختبار الاتصال
          </button>
        </div>
        <div className="card p-5 flex flex-col gap-2">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: 'var(--text-1)', marginBottom: 4 }}>
            <Wifi style={{ width: 16, height: 16, color: '#34d399' }} />
            حالة الاتصال
          </h3>
          {testing && !result && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0' }}>
              <Loader2 style={{ width: 14, height: 14, color: 'var(--accent)', animation: 'spin 1s linear infinite' }} />
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>جاري الفحص...</span>
            </div>
          )}
          {result && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <ResultRow label="الخادم قابل للوصول" state={result.reachable} />
              <ResultRow label="قاعدة البيانات متصلة" state={result.reachable ? result.dbConnected : null} />
              <ResultRow label="الإصدار متوافق" state={result.versionCompatible} />
              {result.error && <span style={{ fontSize: 11, color: '#f87171' }}>{result.error}</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Mac Standalone — locked local-only panel + Backups ──────────────────────
// Standalone can never switch to server/remote/LAN mode (see electron/
// connectionSettings.js — enforced main-process-side regardless of what this
// UI shows), so there is deliberately no mode toggle or serverUrl field here
// at all — showing a disabled version of the Server-edition controls would
// imply a choice that doesn't actually exist.
function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function StandaloneBackupsPanel() {
  const [backups, setBackups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    setLoading(true);
    window.electron.backup.list()
      .then(setBackups)
      .catch(() => toast.error('فشل تحميل قائمة النسخ الاحتياطية'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  const runBackup = async () => {
    setBusy(true);
    try {
      const r = await window.electron.backup.create();
      if (r.ok) { toast.success('تم إنشاء نسخة احتياطية جديدة'); refresh(); }
      else toast.error(r.error || 'فشل إنشاء النسخة الاحتياطية');
    } catch {
      toast.error('فشل إنشاء النسخة الاحتياطية');
    } finally { setBusy(false); }
  };

  const runRestore = async (path) => {
    if (!window.confirm('استعادة هذه النسخة ستستبدل البيانات الحالية بالكامل (سيتم أخذ نسخة أمان تلقائياً أولاً). هل تريد المتابعة؟')) return;
    setBusy(true);
    try {
      const r = await window.electron.backup.restore(path);
      if (r.ok) toast.success('تمت الاستعادة بنجاح — يُنصح بإعادة تشغيل التطبيق');
      else toast.error(r.error || 'فشلت عملية الاستعادة');
      refresh();
    } catch {
      toast.error('فشلت عملية الاستعادة');
    } finally { setBusy(false); }
  };

  return (
    <div className="card p-5 flex flex-col gap-3">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: 'var(--text-1)' }}>
        <DatabaseBackup style={{ width: 16, height: 16, color: '#34d399' }} />
        النسخ الاحتياطي لقاعدة البيانات
      </h3>
      <p style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
        نسخة احتياطية كاملة يومية تلقائية، بالإضافة إلى إمكانية أخذ نسخة يدوية في أي وقت.
      </p>
      <button className="btn-primary text-xs justify-center" onClick={runBackup} disabled={busy}>
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <DatabaseBackup className="w-3.5 h-3.5" />}
        نسخة احتياطية الآن
      </button>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4, maxHeight: 240, overflow: 'auto' }}>
        {loading && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>جاري التحميل...</span>}
        {!loading && backups.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>لا توجد نسخ احتياطية بعد</span>}
        {backups.map((b) => (
          <div key={b.path} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)',
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 11.5, color: 'var(--text-1)' }}>{new Date(b.createdAt).toLocaleString('ar-EG')}</span>
              <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{formatBytes(b.sizeBytes)}</span>
            </div>
            <button className="btn-secondary text-xs" onClick={() => runRestore(b.path)} disabled={busy}
              style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Download style={{ width: 12, height: 12 }} /> استعادة
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function StandaloneConnectionView() {
  return (
    <div className="flex flex-col gap-6" style={{ flex: 1, overflow: 'auto', minHeight: 0 }} dir="rtl">
      <div className="page-header">
        <div>
          <h1 className="page-title">إعدادات الاتصال</h1>
          <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
            PETSHROW ERP — إصدار Mac Standalone
          </p>
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card p-5 flex flex-col gap-3">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: 'var(--text-1)' }}>
            <Lock style={{ width: 16, height: 16, color: 'var(--accent)' }} />
            محلي بالكامل — يُدار تلقائياً
          </h3>
          <p style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.7 }}>
            هذا الإصدار يشغّل الخادم وقاعدة البيانات على هذا الجهاز فقط، ولا يمكن توصيله بخادم آخر عبر الشبكة أو الإنترنت أو Tailscale.
            لا حاجة لأي إعداد يدوي.
          </p>
        </div>
        <StandaloneBackupsPanel />
      </div>
    </div>
  );
}

// ─── Server PC: the address other devices on the same LAN would open ────────────
// Read-only. Everything shown comes from main (electron/lanAddress.js) and is recomputed on every refresh, so a changed LAN address shows up
// without a restart. It never claims another device can reach the address — only that the port answers on THIS PC.
const EXCLUDED_REASON = {
  loopback: 'عنوان داخلي (loopback)', 'link-local': 'عنوان تلقائي بلا شبكة (169.254)', 'vpn-or-cgnat': 'VPN / شبكة افتراضية',
  'not-private-lan': 'ليس عنوان شبكة محلية', 'virtual-or-vpn': 'كرت افتراضي أو VPN', 'no-hardware-address': 'بلا عنوان فعلي',
  'virtual-adapter': 'كرت افتراضي', 'host-route': 'نفق نقطة-لنقطة', invalid: 'غير صالح',
};

function LanAddressCard() {
  const [info, setInfo] = useState(null);
  const [failed, setFailed] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);

  const refresh = () => window.electron.connection.getLanInfo()
    .then((r) => { setInfo(r); setFailed(false); })
    .catch(() => setFailed(true));

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, []);

  const copy = (text) => {
    navigator.clipboard.writeText(text).then(() => toast.success('تم نسخ العنوان'), () => toast.error('تعذّر النسخ'));
  };

  if (failed && !info) return null;
  if (!info || info.applicable === false) return null;

  const mono = { direction: 'ltr', textAlign: 'right', wordBreak: 'break-all', fontFamily: 'monospace' };
  const note = { fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.7 };
  const configured = info.proxy.state === 'configured';

  return (
    <div className="card p-5 flex flex-col gap-3 lg:col-span-2">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: 'var(--text-1)' }}>
        <Globe style={{ width: 16, height: 16, color: 'var(--accent)' }} />
        عنوان هذا الخادم على الشبكة المحلية
        <button className="btn-secondary text-xs" style={{ marginInlineStart: 'auto' }} onClick={refresh}>تحديث</button>
      </h3>

      {info.status === 'ok' && configured && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ ...mono, fontSize: 18, fontWeight: 800, color: 'var(--text-1)', flex: 1, minWidth: 220 }}>{info.shareUrl}</div>
            <button className="btn-primary text-xs" onClick={() => copy(info.shareUrl)}>نسخ العنوان</button>
          </div>
          <div style={note}>
            هذا العنوان مخصّص للأجهزة المصرّح لها على نفس الشبكة المحلية فقط. هو عنوان الخادم الحالي ({info.activeAddress}) ويُعاد حسابه عند كل تحديث.
          </div>
        </>
      )}

      {info.status === 'ok' && !configured && (
        <div style={{ ...note, color: '#f59e0b' }}>
          عنوان الخادم الحالي على الشبكة: <span style={mono}>{info.activeAddress}</span> — لكن لا يوجد عنوان HTTPS مُعدّ لوكيل الاتصال (CORS_ORIGINS) على هذا الجهاز،
          لذلك لا يمكن عرض رابط جاهز للمشاركة. {info.proxy.state === 'conflicting' ? 'القائمة تحتوي على أكثر من منفذ HTTPS.' : ''}
        </div>
      )}

      {info.status === 'ambiguous' && (
        <>
          <div style={{ ...note, color: '#f59e0b' }}>
            يوجد أكثر من عنوان محتمل على هذا الجهاز ولا يمكن تحديد العنوان الصحيح بأمان. اختر العنوان الذي يخص شبكة الأجهزة الأخرى:
          </div>
          {info.candidates.map((c) => (
            <div key={c.address} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11.5, color: 'var(--text-3)', minWidth: 90 }}>{c.name}</span>
              <span style={{ ...mono, flex: 1 }}>{c.url || c.address}</span>
              <button className="btn-secondary text-xs" onClick={() => copy(c.url || c.address)}>نسخ</button>
            </div>
          ))}
          {!configured && <div style={note}>لا يوجد عنوان HTTPS مُعدّ لوكيل الاتصال، لذلك تظهر العناوين بدون منفذ.</div>}
        </>
      )}

      {info.status === 'no-lan' && (
        <div style={{ ...note, color: '#f87171' }}>لم يتم العثور على عنوان شبكة محلية فعّال على هذا الجهاز (تحقق من اتصال Wi-Fi أو الكابل).</div>
      )}

      {info.originMismatch && (
        <div style={{ ...note, color: '#f59e0b' }}>
          تنبيه: العنوان الحالي غير موجود في قائمة المصادر المسموحة للخادم، وقد ترفضه المتصفحات. القائمة الحالية: <span style={mono}>{info.proxy.origins.join(' , ')}</span>.
          لا يغيّر التطبيق هذه القائمة تلقائياً — يعدّلها مسؤول النظام.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
        {info.listening === true && <span style={note}>✔ المنفذ يستجيب على هذا الجهاز نفسه.</span>}
        {info.listening === false && <span style={{ ...note, color: '#f87171' }}>✖ لا يوجد برنامج يستجيب على هذا العنوان والمنفذ على هذا الجهاز — وكيل HTTPS غير مشغّل أو يستمع على عنوان آخر.</span>}
        <span style={note}>لم يتم التحقق من الوصول من أجهزة أخرى. قد يمنعه جدار الحماية أو الراوتر أو عزل الأجهزة في الواي فاي أو قائمة العناوين المسموحة.</span>
        <span style={note}>
          <strong>localhost</strong> والمنفذ الداخلي ({info.localOnly.backendUrl}) يعملان على هذا الجهاز فقط ولا يُشاركان مع أحد.
        </span>
        <span style={note}>
          إن ظهر تحذير شهادة على جهاز آخر، يجب أن يثق ذلك الجهاز بشهادة وكيل الاتصال، وأن تحتوي الشهادة على هذا العنوان نفسه — وقد لا تصلح شهادة أُصدرت لعنوان سابق بعد تغيّره.
          التطبيق لا يثبّت شهادات ولا يعطّل التحقق منها.
        </span>
        <span style={{ ...note, color: '#f59e0b' }}>
          بدون تسجيل دخول: أي جهاز يصل إلى هذا العنوان ضمن الشبكة المسموحة يستطيع استخدام صلاحيات التطبيق (بما فيها تعديل الرواتب والحضور). تقييد الشبكة لا يحدد هوية المستخدم.
        </span>
        {info.excludedCount > 0 && (
          <span style={note}>
            <button onClick={() => setShowExcluded((v) => !v)} style={{ color: 'var(--accent)', cursor: 'pointer', background: 'none', border: 'none', padding: 0 }}>
              {showExcluded ? 'إخفاء' : 'عرض'} الواجهات المستبعدة ({info.excludedCount})
            </button>
            {showExcluded && info.excluded.map((x, i) => (
              <div key={i} style={{ direction: 'ltr', textAlign: 'right' }}>{x.name} · {x.address} · {EXCLUDED_REASON[x.reason] || x.reason}</div>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

export default function ConnectionSettingsPage() {
  const isElectron = !!window.electron?.isElectron;

  if (isElectron && isStandalone) {
    return <StandaloneConnectionView />;
  }

  // Manager clients only ever run in Server Mode (no local backend exists).
  const [mode, setMode]           = useState(isManager ? 'server' : 'local');
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
        setMode(isManager ? 'server' : (s.mode || 'local'));
        setServerUrl(s.serverUrl || '');
        setSavedMode(isManager ? 'server' : (s.mode || 'local'));
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
    if (mode === 'server') {
      let validUrl = false;
      try { validUrl = /^https?:$/.test(new URL(serverUrl.trim()).protocol); } catch { /* not a URL */ }
      if (!validUrl) {
        toast.error('عنوان غير صالح — يجب أن يبدأ بـ http:// أو https://');
        return;
      }
    }
    setSaving(true);
    try {
      await window.electron.connection.setSettings({ mode, serverUrl: serverUrl.trim() });
      setSavedMode(mode);
      if (isManager) {
        // The new address replaces the old one on disk first (setSettings throws if
        // the write fails, so we never get here with the old URL still saved), then
        // the app restarts itself so api.js / socket.js / the health checks all
        // start on it — no reinstall, no rebuild, no manual restart.
        toast.success('تم حفظ عنوان الخادم — جارٍ الاتصال بالعنوان الجديد…');
        setTimeout(() => window.electron.relaunch(), 700);
        return;
      }
      toast.success('تم حفظ الإعدادات — أعد تشغيل التطبيق لتطبيق التغييرات');
    } catch (err) {
      if (String(err?.message || '').includes('SELF_POINTING_SERVER_URL')) {
        toast.error('هذا العنوان يشير إلى هذا الجهاز نفسه — أدخل عنوان جهاز الخادم على الشبكة');
      } else {
        toast.error('فشل الحفظ');
      }
    } finally {
      setSaving(false);
    }
  };

  const restartNow = () => window.electron.relaunch();

  if (!isElectron) {
    return <BrowserConnectionView />;
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
        {loading && <Loader2 className="w-5 h-5 animate-spin text-accent" />}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* ── Mode + URL ────────────────────────────────────────────────── */}
        <div className="card p-5 flex flex-col gap-4">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: 'var(--text-1)' }}>
            <PlugZap style={{ width: 16, height: 16, color: 'var(--accent)' }} />
            وضع التشغيل
          </h3>

          <div style={{ display: 'flex', gap: 10 }}>
            {!isManager && <button
              onClick={() => setMode('local')}
              style={{
                flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                padding: '14px 10px', borderRadius: 10, cursor: 'pointer',
                background: mode === 'local' ? 'rgba(79,191,107,0.12)' : 'var(--surface-2)',
                border: mode === 'local' ? '1.5px solid #1E7A34' : '1px solid var(--border)',
              }}
            >
              <HardDrive style={{ width: 20, height: 20, color: mode === 'local' ? 'var(--accent)' : 'var(--text-3)' }} />
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-1)' }}>محلي</span>
              <span style={{ fontSize: 10.5, color: 'var(--text-3)', textAlign: 'center' }}>يشغّل التطبيق الخادم تلقائياً</span>
            </button>}
            <button
              onClick={() => setMode('server')}
              style={{
                flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                padding: '14px 10px', borderRadius: 10, cursor: 'pointer',
                background: mode === 'server' ? 'rgba(79,191,107,0.12)' : 'var(--surface-2)',
                border: mode === 'server' ? '1.5px solid #1E7A34' : '1px solid var(--border)',
              }}
            >
              <Server style={{ width: 20, height: 20, color: mode === 'server' ? 'var(--accent)' : 'var(--text-3)' }} />
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-1)' }}>خادم</span>
              <span style={{ fontSize: 10.5, color: 'var(--text-3)', textAlign: 'center' }}>اتصال بخادم موجود على الشبكة</span>
            </button>
          </div>

          {mode === 'server' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-3)' }}>عنوان الخادم</label>
              <input
                className="input text-sm"
                placeholder="https://SERVER-PC"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                dir="ltr"
                style={{ textAlign: 'left' }}
              />
              <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                الأفضل استخدام اسم جهاز الخادم (مثال: http://SERVER-PC:5000) لأن رقم IP قد يتغير · أو العنوان الذي تعرضه صفحة إعدادات الاتصال على جهاز الخادم · أو https://erp.company.com
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
              {isManager ? 'اتصال' : 'حفظ'}
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
              <Loader2 style={{ width: 14, height: 14, color: 'var(--accent)', animation: 'spin 1s linear infinite' }} />
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>جاري الفحص...</span>
            </div>
          )}

          {result && !testing && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <ResultRow label="الخادم قابل للوصول" state={result.reachable} />
              <ResultRow label="قاعدة البيانات متصلة" state={result.reachable ? result.dbConnected : null} />
              <ResultRow
                label={result.socketStatus === 'auth_required' ? 'Socket.IO يتطلب تسجيل الدخول' : 'Socket.IO متصل'}
                state={result.reachable ? (result.socketStatus === 'connected' ? true : result.socketStatus === 'auth_required' ? 'auth_required' : false) : null}
              />
              <ResultRow label="الإصدار متوافق" state={result.versionCompatible} />
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-3)', display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span dir="ltr" style={{ textAlign: 'right' }}>العنوان: {result.baseUrl}</span>
                {result.error && <span style={{ color: '#f87171' }}>{result.error}</span>}
              </div>
            </div>
          )}
        </div>

        {/* ── Server PC: shareable LAN address (local mode only, Server edition) ── */}
        {!isManager && savedMode === 'local' && mode === 'local' && <LanAddressCard />}
      </div>
    </div>
  );
}
