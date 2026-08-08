import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { DownloadCloud, RotateCcw } from 'lucide-react';

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ─── Enterprise Auto Update System (EP-001) ───────────────────────────────────
// Global, page-less update UX: an actionable toast when a new version is
// found, a floating progress dialog while it downloads, and a persistent
// restart prompt once the download completes. Mounted once in App.jsx so it
// works from anywhere in the app — there is no dedicated Update Center page.
export default function UpdateNotifications() {
  const [progress, setProgress] = useState(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const updater = window?.electron?.updater;
    if (!updater) return;
    const notifiedVersions = new Set();

    const offState = updater.onState((s) => {
      setDownloading(!!s.downloading);
      if (!s.downloading) setProgress(null);

      if (s.updateInfo && !s.downloaded && !notifiedVersions.has(s.updateInfo.version)) {
        notifiedVersions.add(s.updateInfo.version);
        toast((t) => (
          <div dir="rtl" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontWeight: 600 }}>يتوفر إصدار جديد {s.updateInfo.version}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => { updater.download(); toast.dismiss(t.id); }}
                style={{ padding: '5px 12px', borderRadius: 6, background: '#2563eb', color: '#fff', border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
              >
                تحديث الآن
              </button>
              <button
                onClick={() => toast.dismiss(t.id)}
                style={{ padding: '5px 12px', borderRadius: 6, background: 'transparent', color: '#94a3b8', border: '1px solid #374151', fontSize: 12, cursor: 'pointer' }}
              >
                لاحقًا
              </button>
            </div>
          </div>
        ), { duration: 15000 });
      }

      if (s.downloaded) {
        toast((t) => (
          <div dir="rtl" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontWeight: 600 }}>تم تنزيل التحديث {s.downloadedVersion} — أعد التشغيل للتثبيت</span>
            <button
              onClick={() => { updater.install(); toast.dismiss(t.id); }}
              style={{ padding: '5px 12px', borderRadius: 6, background: '#16a34a', color: '#fff', border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              إعادة التشغيل الآن
            </button>
          </div>
        ), { id: 'update-downloaded', duration: Infinity });
      }
    });

    const offProgress = updater.onProgress((p) => setProgress(p));

    return () => { offState?.(); offProgress?.(); };
  }, []);

  if (!downloading) return null;

  const pct = progress?.percent ? Math.round(progress.percent) : 0;

  return (
    <div
      dir="rtl"
      style={{
        position: 'fixed', bottom: 20, left: 20, zIndex: 99998,
        background: '#1f2937', border: '1px solid #374151', borderRadius: 10,
        padding: '12px 14px', width: 260, boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        display: 'flex', flexDirection: 'column', gap: 8, fontFamily: 'Cairo, sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#e5e7eb', fontSize: 12, fontWeight: 600 }}>
        <DownloadCloud style={{ width: 14, height: 14, color: '#79C0FF', flexShrink: 0 }} />
        جاري تنزيل التحديث... {pct}%
      </div>
      <div style={{ height: 6, borderRadius: 3, background: '#21262D', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: '#2F81F7', transition: 'width 0.2s' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#9ca3af' }}>
        <span>{formatBytes(progress?.transferred)} / {formatBytes(progress?.total)}</span>
        <RotateCcw style={{ width: 11, height: 11, opacity: 0.5 }} />
      </div>
    </div>
  );
}
