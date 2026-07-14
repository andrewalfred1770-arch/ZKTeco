/**
 * DevicesPage — Enterprise Fingerprint Device Management & Monitoring
 *
 * Features:
 *  - KPI cards (total, online, offline, last sync, total logs)
 *  - AG Grid table with real-time status badges
 *  - Add/Edit drawer with full settings (syncInterval, autoSync, deviceNumber)
 *  - Manual sync, ping, delete per device
 *  - Sync-all button
 *  - Sync logs history panel (collapsible)
 *  - Socket.IO live status updates
 */

import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { AgGridReact } from 'ag-grid-react';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';
import {
  Wifi, WifiOff, RefreshCw, Plus, Play, Loader2,
  Activity, Server, Clock, Database, Zap, AlertTriangle,
  CheckCircle, XCircle, ChevronDown, ChevronUp, Trash2,
  Edit3, X, Save, Radio, History, Signal, RotateCcw,
  Layers, Link2, Link2Off, Stethoscope,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { getSocket } from '../lib/socket';
import api, { LONG_OP } from '../lib/api';
import { useTheme } from '../contexts/ThemeContext';
import { AG_GRID_LOCALE_AR } from '../lib/agGridLocale';
import { westernDigits, fmtDateTime } from '../lib/formatters';
import { ENTERPRISE_DEFAULT_COL_DEF, ENTERPRISE_GRID_PROPS } from '../lib/gridDefaults';

// ── Helpers ────────────────────────────────────────────────────────────────────
const W = v => westernDigits(String(v ?? 0));

function fmtAgo(isoDate) {
  if (!isoDate) return '—';
  const secs = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
  if (secs < 60)   return `منذ ${W(secs)} ث`;
  if (secs < 3600) return `منذ ${W(Math.floor(secs / 60))} د`;
  if (secs < 86400) return `منذ ${W(Math.floor(secs / 3600))} س`;
  return `منذ ${W(Math.floor(secs / 86400))} يوم`;
}

function fmtDatetime(isoDate) {
  if (!isoDate) return '—';
  const d = new Date(isoDate);
  const pad = n => String(n).padStart(2, '0');
  const h = d.getHours(), m = d.getMinutes();
  const ampm = h >= 12 ? 'م' : 'ص';
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())}  ${pad(h12)}:${pad(m)} ${ampm}`;
}

function fmtDuration(ms) {
  if (!ms) return '—';
  if (ms < 1000) return `${W(ms)} ms`;
  return `${W((ms/1000).toFixed(1))} s`;
}

// ── Status badge ──────────────────────────────────────────────────────────────
const STATUS_CFG = {
  online:  { label: 'متصل',    color: '#22c55e', bg: 'rgba(34,197,94,0.13)',   dot: '#22c55e', pulse: true  },
  offline: { label: 'غير متصل', color: '#6b7280', bg: 'rgba(107,114,128,0.1)', dot: '#6b7280', pulse: false },
  syncing: { label: 'مزامنة',  color: '#f59e0b', bg: 'rgba(245,158,11,0.13)', dot: '#f59e0b', pulse: true  },
  error:   { label: 'خطأ',     color: '#ef4444', bg: 'rgba(239,68,68,0.13)',  dot: '#ef4444', pulse: false },
};

// ── Realtime listener badge (CMD_REG_EVENT live connection) ──────────────────
const REALTIME_CFG = {
  connected:      { label: 'مباشر',        color: '#22c55e', bg: 'rgba(34,197,94,0.13)',  pulse: true  },
  reconnecting:   { label: 'إعادة اتصال',  color: '#f59e0b', bg: 'rgba(245,158,11,0.13)', pulse: true  },
  connecting:     { label: 'جاري الاتصال', color: '#f59e0b', bg: 'rgba(245,158,11,0.13)', pulse: true  },
  paused:         { label: 'مزامنة جارية', color: '#6366f1', bg: 'rgba(99,102,241,0.13)', pulse: true  },
  'missed-events':{ label: 'فقدان أحداث', color: '#ef4444', bg: 'rgba(239,68,68,0.13)',  pulse: true  },
  disconnected:   { label: 'غير مفعّل',    color: '#6b7280', bg: 'rgba(107,114,128,0.1)', pulse: false },
};

function RealtimeBadge({ status, detail }) {
  const cfg = REALTIME_CFG[status] || REALTIME_CFG.disconnected;

  const lines = [];
  if (detail?.lastRealtimePunchAt) lines.push(`آخر بصمة مباشرة: ${fmtDateTime(new Date(detail.lastRealtimePunchAt))}`);
  if (detail?.connectedAt) lines.push(`متصل منذ: ${fmtDateTime(new Date(detail.connectedAt))}`);
  if (detail?.lastHeartbeat) lines.push(`آخر نبضة: ${fmtDateTime(new Date(detail.lastHeartbeat))}`);
  if (detail?.eventLatencyMs != null) lines.push(`زمن وصول آخر حدث: ${W(detail.eventLatencyMs)}ms`);
  if (detail?.reconnectCount != null) lines.push(`عدد إعادات الاتصال: ${W(detail.reconnectCount)}`);
  const title = lines.join('\n') || undefined;

  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 600,
      color: cfg.color, background: cfg.bg, cursor: title ? 'help' : 'default',
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%', background: cfg.color,
        animation: cfg.pulse ? 'pulse-dot 0.8s ease-in-out infinite' : 'none',
      }} />
      {cfg.label}
    </span>
  );
}

function StatusBadge({ status }) {
  const cfg = STATUS_CFG[status] || STATUS_CFG.offline;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 9px', borderRadius: 99, fontSize: 11, fontWeight: 700,
      background: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.color}30`,
      fontFamily: 'Cairo, sans-serif',
    }}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%',
        background: cfg.dot, flexShrink: 0,
        boxShadow: cfg.pulse ? `0 0 6px ${cfg.dot}` : 'none',
        animation: cfg.pulse ? 'pulse-dot 1.5s ease-in-out infinite' : 'none',
      }} />
      {cfg.label}
    </span>
  );
}

// ── Sync status badge ─────────────────────────────────────────────────────────
const SYNC_STATUS_CFG = {
  success:  { label: 'نجح',     color: '#22c55e', bg: 'rgba(34,197,94,0.1)'   },
  failed:   { label: 'فشل',     color: '#ef4444', bg: 'rgba(239,68,68,0.1)'   },
  running:  { label: 'جاري',    color: '#f59e0b', bg: 'rgba(245,158,11,0.1)'  },
  partial:  { label: 'جزئي',    color: '#a78bfa', bg: 'rgba(167,139,250,0.1)' },
};

function SyncStatusBadge({ status }) {
  const cfg = SYNC_STATUS_CFG[status] || SYNC_STATUS_CFG.running;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '2px 8px', borderRadius: 99, fontSize: 10.5, fontWeight: 700,
      background: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.color}30`,
    }}>
      {cfg.label}
    </span>
  );
}

// ── KPI Card ──────────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, icon: Icon, color, loading }) {
  const { isLight } = useTheme();
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '14px 18px', borderRadius: 12,
      background: 'var(--surface)',
      border: `1.5px solid ${isLight ? '#e2e8f0' : '#1a3454'}`,
      boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
    }}>
      <div style={{
        padding: 10, borderRadius: 10,
        background: color + (isLight ? '22' : '18'),
        flexShrink: 0,
      }}>
        <Icon style={{ width: 20, height: 20, color }} />
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <p style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 2, fontFamily: 'Cairo, sans-serif' }}>{label}</p>
        {loading
          ? <div style={{ height: 22, width: 60, borderRadius: 4, background: 'var(--surface-2)', animation: 'pulse 1.5s infinite' }} />
          : <p style={{ fontSize: 20, fontWeight: 800, color: 'var(--text)', fontFamily: 'Consolas, monospace', lineHeight: 1 }}>{W(value)}</p>
        }
        {sub && <p style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 3 }}>{sub}</p>}
      </div>
    </div>
  );
}

// ── Device Form Drawer ─────────────────────────────────────────────────────────
function DeviceDrawer({ open, onClose, onSaved, device, branches }) {
  const { isLight } = useTheme();
  const empty = { name: '', ipAddress: '', port: '4370', branchId: '', deviceNumber: '1', syncInterval: '5', autoSync: true, enabled: true };
  const [form,    setForm]    = useState(empty);
  const [saving,  setSaving]  = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  useEffect(() => {
    setTestResult(null);
    if (device) {
      setForm({
        name:         device.name,
        ipAddress:    device.ipAddress,
        port:         String(device.port),
        branchId:     String(device.branchId),
        deviceNumber: String(device.deviceNumber || 1),
        syncInterval: String(device.syncInterval || 5),
        autoSync:     device.autoSync !== false,
        enabled:      device.enabled  !== false,
      });
    } else {
      setForm(empty);
    }
  }, [device, open]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      const { data } = await api.post('/devices/test-connection', {
        ipAddress: form.ipAddress, port: parseInt(form.port),
      });
      setTestResult(data);
      if (data.success) toast.success(`✅ الجهاز متصل — زمن الاستجابة: ${data.latency}ms`);
      else               toast.error('❌ فشل الاتصال: ' + (data.error || 'غير معروف'));
    } catch {
      setTestResult({ success: false, error: 'فشل الطلب' });
    } finally { setTesting(false); }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        name:         form.name,
        ipAddress:    form.ipAddress,
        port:         parseInt(form.port) || 4370,
        branchId:     parseInt(form.branchId),
        deviceNumber: parseInt(form.deviceNumber) || 1,
        syncInterval: parseInt(form.syncInterval) || 5,
        autoSync:     form.autoSync,
        enabled:      form.enabled,
      };
      if (device) await api.put(`/devices/${device.id}`, payload);
      else        await api.post('/devices', payload);
      toast.success(device ? 'تم تحديث الجهاز' : 'تم إضافة الجهاز');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'فشل الحفظ');
    } finally { setSaving(false); }
  };

  if (!open) return null;

  const surface  = isLight ? '#fff'    : '#0b1628';
  const surface2 = isLight ? '#f8fafc' : '#0f1e35';
  const border   = isLight ? '#e2e8f0' : '#1a3454';
  const textMain = isLight ? '#0f172a' : '#eef2ff';
  const textSub  = isLight ? '#64748b' : '#64748b';

  return (
    <>
      {/* Overlay */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 9000,
          background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(3px)',
        }}
      />
      {/* Drawer */}
      <div
        dir="rtl"
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0,
          width: 420, zIndex: 9001,
          background: surface,
          borderLeft: `2px solid ${border}`,
          display: 'flex', flexDirection: 'column',
          boxShadow: '-8px 0 40px rgba(0,0,0,0.35)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '14px 20px',
          background: isLight ? '#0f2040' : '#070f1d',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Server style={{ color: '#bfdbfe', width: 18, height: 18 }} />
            <span style={{ color: '#fff', fontWeight: 700, fontSize: 14, fontFamily: 'Cairo, sans-serif' }}>
              {device ? 'تعديل الجهاز' : 'إضافة جهاز بصمة'}
            </span>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: 6, color: '#94a3b8', cursor: 'pointer', padding: '5px 8px' }}
          >
            <X style={{ width: 16, height: 16 }} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSave} style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Name */}
          <div>
            <label style={{ fontSize: 12, color: textSub, fontWeight: 600, display: 'block', marginBottom: 5, fontFamily: 'Cairo, sans-serif' }}>
              اسم الجهاز *
            </label>
            <input
              className="input" required
              value={form.name}
              onChange={e => set('name', e.target.value)}
              placeholder="مثال: بوابة الدخول الرئيسية"
              style={{ width: '100%' }}
            />
          </div>

          {/* IP + Port */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px', gap: 10 }}>
            <div>
              <label style={{ fontSize: 12, color: textSub, fontWeight: 600, display: 'block', marginBottom: 5, fontFamily: 'Cairo, sans-serif' }}>
                عنوان IP *
              </label>
              <input
                className="input" required dir="ltr"
                value={form.ipAddress}
                onChange={e => set('ipAddress', e.target.value)}
                placeholder="192.168.1.201"
                style={{ width: '100%', textAlign: 'left', fontFamily: 'Consolas, monospace' }}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: textSub, fontWeight: 600, display: 'block', marginBottom: 5, fontFamily: 'Cairo, sans-serif' }}>
                Port
              </label>
              <input
                className="input" type="number" dir="ltr"
                value={form.port}
                onChange={e => set('port', e.target.value)}
                style={{ width: '100%', textAlign: 'center', fontFamily: 'Consolas, monospace' }}
              />
            </div>
          </div>

          {/* Test connection */}
          <div>
            <button
              type="button"
              onClick={handleTest}
              disabled={testing || !form.ipAddress}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                fontFamily: 'Cairo, sans-serif', cursor: 'pointer',
                background: 'rgba(59,130,246,0.1)',
                border: '1px solid rgba(59,130,246,0.3)',
                color: '#60a5fa', width: '100%', justifyContent: 'center',
              }}
            >
              {testing
                ? <Loader2 style={{ width: 14, height: 14, animation: 'spin 1s linear infinite' }} />
                : <Signal style={{ width: 14, height: 14 }} />
              }
              {testing ? 'جاري الاختبار...' : 'اختبار الاتصال'}
            </button>
            {testResult && (
              <div style={{
                marginTop: 8, padding: '8px 12px', borderRadius: 8, fontSize: 12,
                background: testResult.success ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                color:      testResult.success ? '#22c55e'              : '#ef4444',
                border:     `1px solid ${testResult.success ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                {testResult.success
                  ? <CheckCircle style={{ width: 13, height: 13 }} />
                  : <XCircle     style={{ width: 13, height: 13 }} />
                }
                {testResult.success
                  ? `الاتصال ناجح — زمن الاستجابة: ${testResult.latency}ms`
                  : (testResult.error || 'فشل الاتصال')}
              </div>
            )}
          </div>

          {/* Branch */}
          <div>
            <label style={{ fontSize: 12, color: textSub, fontWeight: 600, display: 'block', marginBottom: 5, fontFamily: 'Cairo, sans-serif' }}>
              الفرع *
            </label>
            <select
              className="input" required
              value={form.branchId}
              onChange={e => set('branchId', e.target.value)}
              style={{ width: '100%' }}
            >
              <option value="">-- اختر الفرع --</option>
              {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>

          {/* Device Number */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={{ fontSize: 12, color: textSub, fontWeight: 600, display: 'block', marginBottom: 5, fontFamily: 'Cairo, sans-serif' }}>
                رقم الجهاز
              </label>
              <input
                className="input" type="number" min="1"
                value={form.deviceNumber}
                onChange={e => set('deviceNumber', e.target.value)}
                style={{ width: '100%', fontFamily: 'Consolas, monospace' }}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: textSub, fontWeight: 600, display: 'block', marginBottom: 5, fontFamily: 'Cairo, sans-serif' }}>
                فترة المزامنة (دقيقة)
              </label>
              <input
                className="input" type="number" min="1" max="60"
                value={form.syncInterval}
                onChange={e => set('syncInterval', e.target.value)}
                style={{ width: '100%', fontFamily: 'Consolas, monospace' }}
              />
            </div>
          </div>

          {/* Toggles */}
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 12,
            padding: '14px 16px', borderRadius: 10,
            background: surface2, border: `1px solid ${border}`,
          }}>
            {[
              { key: 'autoSync', label: 'مزامنة تلقائية',   sub: `كل ${form.syncInterval || 5} دقيقة` },
              { key: 'enabled',  label: 'الجهاز مفعّل',      sub: 'إلغاء التفعيل يوقف جميع العمليات'   },
            ].map(({ key, label, sub }) => (
              <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <p style={{ fontSize: 13, fontWeight: 600, color: textMain, fontFamily: 'Cairo, sans-serif' }}>{label}</p>
                  <p style={{ fontSize: 11, color: textSub }}>{sub}</p>
                </div>
                <button
                  type="button"
                  onClick={() => set(key, !form[key])}
                  style={{
                    width: 44, height: 24, borderRadius: 99, border: 'none', cursor: 'pointer',
                    background: form[key] ? '#2563eb' : (isLight ? '#cbd5e1' : '#1a3454'),
                    position: 'relative', transition: 'background 0.2s', flexShrink: 0,
                  }}
                >
                  <span style={{
                    position: 'absolute', top: 3,
                    right: form[key] ? 3 : 21,
                    width: 18, height: 18, borderRadius: '50%',
                    background: '#fff',
                    transition: 'right 0.2s',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                  }} />
                </button>
              </div>
            ))}
          </div>

          {/* Spacer */}
          <div style={{ flex: 1 }} />
        </form>

        {/* Footer buttons */}
        <div style={{
          padding: '14px 20px',
          borderTop: `1px solid ${border}`,
          display: 'flex', gap: 10,
          background: surface, flexShrink: 0,
        }}>
          <button
            type="submit"
            form="device-form-inner"
            onClick={handleSave}
            disabled={saving}
            style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              padding: '9px 0', borderRadius: 8, border: 'none',
              background: '#2563eb', color: '#fff',
              fontSize: 13, fontWeight: 700, fontFamily: 'Cairo, sans-serif', cursor: 'pointer',
            }}
          >
            {saving ? <Loader2 style={{ width: 14, height: 14, animation: 'spin 1s linear infinite' }} /> : <Save style={{ width: 14, height: 14 }} />}
            {saving ? 'جاري الحفظ...' : 'حفظ الجهاز'}
          </button>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '9px 20px', borderRadius: 8,
              border: `1px solid ${border}`, background: 'transparent',
              color: textSub, fontSize: 13, fontFamily: 'Cairo, sans-serif', cursor: 'pointer',
            }}
          >
            إلغاء
          </button>
        </div>
      </div>
    </>
  );
}

// ── Sync Logs Panel ────────────────────────────────────────────────────────────
function SyncLogsPanel({ deviceId, deviceName, isLight }) {
  const [logs,    setLogs]    = useState([]);
  const [loading, setLoading] = useState(false);
  const [open,    setOpen]    = useState(false);

  const load = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    try {
      const url = deviceId
        ? `/devices/${deviceId}/sync-logs?limit=20`
        : '/devices/sync-logs/recent?limit=40';
      const { data } = await api.get(url);
      setLogs(data);
    } catch {}
    finally { setLoading(false); }
  }, [open, deviceId]);

  useEffect(() => { load(); }, [load]);

  const border  = isLight ? '#e2e8f0' : '#1a3454';
  const surface = isLight ? '#f8fafc' : '#0b1628';

  return (
    <div style={{ border: `1px solid ${border}`, borderRadius: 10, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 16px', background: surface, border: 'none', cursor: 'pointer',
          color: isLight ? '#334155' : '#94a3b8', fontFamily: 'Cairo, sans-serif', fontSize: 13, fontWeight: 600,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <History style={{ width: 15, height: 15, color: '#60a5fa' }} />
          {deviceName ? `سجل مزامنة: ${deviceName}` : 'سجل المزامنة الأخير (جميع الأجهزة)'}
          {logs.length > 0 && open && (
            <span style={{
              background: 'rgba(59,130,246,0.15)', color: '#60a5fa',
              padding: '1px 7px', borderRadius: 99, fontSize: 10,
            }}>{logs.length}</span>
          )}
        </div>
        {open ? <ChevronUp style={{ width: 15, height: 15 }} /> : <ChevronDown style={{ width: 15, height: 15 }} />}
      </button>

      {open && (
        <div style={{ borderTop: `1px solid ${border}` }}>
          {loading ? (
            <div style={{ padding: '20px', textAlign: 'center', color: '#64748b', fontSize: 12, fontFamily: 'Cairo, sans-serif' }}>
              <Loader2 style={{ width: 16, height: 16, animation: 'spin 1s linear infinite', display: 'inline-block', marginLeft: 8 }} />
              جاري التحميل...
            </div>
          ) : logs.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: '#64748b', fontSize: 12, fontFamily: 'Cairo, sans-serif' }}>
              لا توجد سجلات مزامنة بعد
            </div>
          ) : (
            <div style={{ maxHeight: 260, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5, fontFamily: 'Cairo, sans-serif' }}>
                <thead>
                  <tr style={{ background: isLight ? '#f1f5f9' : '#0d1e38' }}>
                    {['وقت البدء', 'الجهاز', 'الحالة', 'جديد', 'إجمالي', 'المدة', 'النوع'].map(h => (
                      <th key={h} style={{
                        padding: '6px 10px', textAlign: 'right', fontWeight: 700,
                        color: isLight ? '#475569' : '#64748b',
                        borderBottom: `1px solid ${border}`,
                        whiteSpace: 'nowrap',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {logs.map(log => (
                    <tr key={log.id} style={{ borderBottom: `1px solid ${border}` }}>
                      <td style={{ padding: '5px 10px', color: isLight ? '#334155' : '#8ba3c7', whiteSpace: 'nowrap', fontFamily: 'Consolas, monospace', fontSize: 11 }}>
                        {fmtDatetime(log.startedAt)}
                      </td>
                      <td style={{ padding: '5px 10px', color: isLight ? '#0f172a' : '#dde6f8', fontWeight: 600, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {log.device?.name || `#${log.deviceId}`}
                      </td>
                      <td style={{ padding: '5px 10px' }}>
                        <SyncStatusBadge status={log.status} />
                      </td>
                      <td style={{ padding: '5px 10px', color: '#22c55e', fontFamily: 'Consolas, monospace', fontWeight: 700 }}>
                        {log.newLogs > 0 ? `+${W(log.newLogs)}` : '—'}
                      </td>
                      <td style={{ padding: '5px 10px', color: isLight ? '#64748b' : '#475569', fontFamily: 'Consolas, monospace' }}>
                        {W(log.totalLogs)}
                      </td>
                      <td style={{ padding: '5px 10px', color: '#60a5fa', fontFamily: 'Consolas, monospace', whiteSpace: 'nowrap' }}>
                        {fmtDuration(log.duration)}
                      </td>
                      <td style={{ padding: '5px 10px' }}>
                        <span style={{
                          fontSize: 10, padding: '1px 7px', borderRadius: 99,
                          background: log.triggeredBy === 'manual' ? 'rgba(168,85,247,0.1)' : 'rgba(59,130,246,0.1)',
                          color:      log.triggeredBy === 'manual' ? '#a855f7'               : '#60a5fa',
                        }}>
                          {log.triggeredBy === 'manual' ? 'يدوي' : 'تلقائي'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Relink Diagnostics Panel ──────────────────────────────────────────────────
function RelinkDiagnosticsPanel({ isLight, refreshKey }) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [open,    setOpen]    = useState(false);

  const load = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    try {
      const { data } = await api.get('/devices/relink-diagnostics');
      setData(data);
    } catch { toast.error('فشل تحميل تشخيص الربط'); }
    finally { setLoading(false); }
  }, [open]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const border  = isLight ? '#e2e8f0' : '#1a3454';
  const surface = isLight ? '#f8fafc' : '#0b1628';

  return (
    <div style={{ border: `1px solid ${border}`, borderRadius: 10, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 16px', background: surface, border: 'none', cursor: 'pointer',
          color: isLight ? '#334155' : '#94a3b8', fontFamily: 'Cairo, sans-serif', fontSize: 13, fontWeight: 600,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Stethoscope style={{ width: 15, height: 15, color: '#a78bfa' }} />
          تشخيص ربط البصمات (zkUserId)
          {data?.summary && open && (
            <>
              <span style={{
                background: 'rgba(34,197,94,0.15)', color: '#22c55e',
                padding: '1px 7px', borderRadius: 99, fontSize: 10,
              }}>مرتبط: {W(data.summary.totalLinkedLogs)}</span>
              <span style={{
                background: 'rgba(239,68,68,0.15)', color: '#ef4444',
                padding: '1px 7px', borderRadius: 99, fontSize: 10,
              }}>غير مرتبط: {W(data.summary.totalUnlinkedLogs)}</span>
            </>
          )}
        </div>
        {open ? <ChevronUp style={{ width: 15, height: 15 }} /> : <ChevronDown style={{ width: 15, height: 15 }} />}
      </button>

      {open && (
        <div style={{ borderTop: `1px solid ${border}` }}>
          {loading ? (
            <div style={{ padding: '20px', textAlign: 'center', color: '#64748b', fontSize: 12, fontFamily: 'Cairo, sans-serif' }}>
              <Loader2 style={{ width: 16, height: 16, animation: 'spin 1s linear infinite', display: 'inline-block', marginLeft: 8 }} />
              جاري التحميل...
            </div>
          ) : !data || data.rows.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: '#64748b', fontSize: 12, fontFamily: 'Cairo, sans-serif' }}>
              لا توجد بيانات بصمات بعد
            </div>
          ) : (
            <div style={{ maxHeight: 320, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5, fontFamily: 'Cairo, sans-serif' }}>
                <thead>
                  <tr style={{ background: isLight ? '#f1f5f9' : '#0d1e38' }}>
                    {['zkUserId', 'الموظف المرتبط', 'الحالة', 'سجلات مرتبطة', 'سجلات غير مرتبطة', 'الإجمالي'].map(h => (
                      <th key={h} style={{
                        padding: '6px 10px', textAlign: 'right', fontWeight: 700,
                        color: isLight ? '#475569' : '#64748b',
                        borderBottom: `1px solid ${border}`,
                        whiteSpace: 'nowrap',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map(row => (
                    <tr key={row.zkUserId} style={{ borderBottom: `1px solid ${border}` }}>
                      <td style={{ padding: '5px 10px', color: isLight ? '#0f172a' : '#dde6f8', fontWeight: 700, fontFamily: 'Consolas, monospace', direction: 'ltr', textAlign: 'right' }}>
                        {row.zkUserId}
                      </td>
                      <td style={{ padding: '5px 10px', color: isLight ? '#334155' : '#8ba3c7', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {row.employee ? `${row.employee.name}${row.employee.code ? ` (${row.employee.code})` : ''}` : '—'}
                      </td>
                      <td style={{ padding: '5px 10px' }}>
                        {row.employee ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#22c55e', fontSize: 11, fontWeight: 700 }}>
                            <Link2 style={{ width: 12, height: 12 }} /> مرتبط
                          </span>
                        ) : (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#ef4444', fontSize: 11, fontWeight: 700 }}>
                            <Link2Off style={{ width: 12, height: 12 }} /> بدون موظف
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '5px 10px', color: '#22c55e', fontFamily: 'Consolas, monospace', fontWeight: 700 }}>
                        {W(row.linkedCount)}
                      </td>
                      <td style={{ padding: '5px 10px', color: row.unlinkedCount > 0 ? '#ef4444' : 'var(--c-muted)', fontFamily: 'Consolas, monospace', fontWeight: 700 }}>
                        {W(row.unlinkedCount)}
                      </td>
                      <td style={{ padding: '5px 10px', color: isLight ? '#64748b' : '#475569', fontFamily: 'Consolas, monospace' }}>
                        {W(row.totalCount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Recovery Diagnostics Panel ─────────────────────────────────────────────────
// Background-recovery health for one device: total ingested logs, oldest/newest
// timestamps, last successful convergence pass, and a 90-day missing-day report.
// Realtime ingestion is the primary attendance source; this panel only reflects
// the secondary historical-recovery subsystem.
function RecoveryDiagnosticsPanel({ deviceId, deviceName, isLight }) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [open,    setOpen]    = useState(false);

  const load = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    try {
      const { data } = await api.get(`/devices/${deviceId}/recovery-diagnostics`);
      setData(data);
    } catch { toast.error('فشل تحميل تشخيص الاسترداد'); }
    finally { setLoading(false); }
  }, [open, deviceId]);

  useEffect(() => { load(); }, [load]);

  const border  = isLight ? '#e2e8f0' : '#1a3454';
  const surface = isLight ? '#f8fafc' : '#0b1628';

  return (
    <div style={{ border: `1px solid ${border}`, borderRadius: 10, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 16px', background: surface, border: 'none', cursor: 'pointer',
          color: isLight ? '#334155' : '#94a3b8', fontFamily: 'Cairo, sans-serif', fontSize: 13, fontWeight: 600,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Database style={{ width: 15, height: 15, color: '#facc15' }} />
          {`تشخيص الاسترداد التاريخي: ${deviceName}`}
          {data && open && (
            <span style={{
              background: data.missingDaysCount > 0 ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)',
              color:      data.missingDaysCount > 0 ? '#ef4444'              : '#22c55e',
              padding: '1px 7px', borderRadius: 99, fontSize: 10,
            }}>
              {data.missingDaysCount > 0 ? `${W(data.missingDaysCount)} يوم بدون بيانات` : 'لا فجوات'}
            </span>
          )}
        </div>
        {open ? <ChevronUp style={{ width: 15, height: 15 }} /> : <ChevronDown style={{ width: 15, height: 15 }} />}
      </button>

      {open && (
        <div style={{ borderTop: `1px solid ${border}` }}>
          {loading || !data ? (
            <div style={{ padding: '20px', textAlign: 'center', color: '#64748b', fontSize: 12, fontFamily: 'Cairo, sans-serif' }}>
              <Loader2 style={{ width: 16, height: 16, animation: 'spin 1s linear infinite', display: 'inline-block', marginLeft: 8 }} />
              جاري التحميل...
            </div>
          ) : (
            <div style={{ padding: 14, fontFamily: 'Cairo, sans-serif', fontSize: 12 }}>
              {/* Summary grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 12 }}>
                <div>
                  <div style={{ color: '#64748b', fontSize: 10.5, marginBottom: 2 }}>إجمالي السجلات</div>
                  <div style={{ color: isLight ? '#0f172a' : '#dde6f8', fontWeight: 700, fontFamily: 'Consolas, monospace' }}>{W(data.totalLogs)}</div>
                </div>
                <div>
                  <div style={{ color: '#64748b', fontSize: 10.5, marginBottom: 2 }}>أقدم سجل</div>
                  <div style={{ color: isLight ? '#334155' : '#8ba3c7', fontFamily: 'Consolas, monospace', fontSize: 11 }}>{fmtDatetime(data.oldestTimestamp)}</div>
                </div>
                <div>
                  <div style={{ color: '#64748b', fontSize: 10.5, marginBottom: 2 }}>أحدث سجل</div>
                  <div style={{ color: isLight ? '#334155' : '#8ba3c7', fontFamily: 'Consolas, monospace', fontSize: 11 }}>{fmtDatetime(data.newestTimestamp)}</div>
                </div>
                <div>
                  <div style={{ color: '#64748b', fontSize: 10.5, marginBottom: 2 }}>آخر مزامنة ناجحة</div>
                  <div style={{ color: isLight ? '#334155' : '#8ba3c7', fontFamily: 'Consolas, monospace', fontSize: 11 }}>{fmtDatetime(data.lastSuccessfulTimestamp)}</div>
                </div>
              </div>

              {/* Last convergence */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ color: '#64748b', fontSize: 10.5, marginBottom: 4 }}>آخر دورة تقارب (Convergence)</div>
                {data.lastConvergence ? (
                  <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                    <SyncStatusBadge status={data.lastConvergence.status} />
                    <span style={{ color: isLight ? '#334155' : '#8ba3c7', fontFamily: 'Consolas, monospace', fontSize: 11 }}>
                      {fmtDatetime(data.lastConvergence.completedAt || data.lastConvergence.startedAt)}
                    </span>
                    <span style={{ color: '#60a5fa', fontFamily: 'Consolas, monospace', fontSize: 11 }}>
                      {W(data.lastConvergence.convergencePasses ?? 0)} تمريرات
                    </span>
                    <span style={{ color: '#22c55e', fontFamily: 'Consolas, monospace', fontSize: 11 }}>
                      +{W(data.lastConvergence.newLogs ?? 0)} جديد
                    </span>
                    {data.lastConvergence.zkErr && (
                      <span style={{ color: '#ef4444', fontFamily: 'Consolas, monospace', fontSize: 11 }}>
                        {data.lastConvergence.zkErr}
                      </span>
                    )}
                  </div>
                ) : (
                  <span style={{ color: '#64748b' }}>لا توجد بيانات تقارب بعد</span>
                )}
              </div>

              {/* Missing days */}
              <div>
                <div style={{ color: '#64748b', fontSize: 10.5, marginBottom: 4 }}>
                  أيام بدون سجلات (آخر {W(data.recoveryWindowDays)} يوم)
                </div>
                {data.missingDays.length === 0 ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#22c55e', fontWeight: 700 }}>
                    <CheckCircle style={{ width: 13, height: 13 }} /> لا توجد فجوات في التغطية
                  </span>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 120, overflowY: 'auto' }}>
                    {data.missingDays.map(day => (
                      <span key={day} style={{
                        background: 'rgba(239,68,68,0.1)', color: '#ef4444',
                        padding: '2px 8px', borderRadius: 6, fontSize: 10.5,
                        fontFamily: 'Consolas, monospace', border: '1px solid rgba(239,68,68,0.25)',
                      }}>{day}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function DevicesPage() {
  const { agGridTheme, isLight } = useTheme();
  const [devices,   setDevices]   = useState([]);
  const [branches,  setBranches]  = useState([]);
  const [stats,     setStats]     = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [statsLoad, setStatsLoad] = useState(false);
  const [drawer,    setDrawer]    = useState(false);
  const [editing,   setEditing]   = useState(null);
  const [syncing,   setSyncing]   = useState({});
  const [pinging,   setPinging]   = useState({});
  const [syncAll,   setSyncAll]   = useState(false);
  const [deleteId,  setDeleteId]  = useState(null);
  const [relinking, setRelinking] = useState(false);
  const [relinkRefresh, setRelinkRefresh] = useState(0);
  const [liveStatus, setLiveStatus] = useState({}); // deviceId → status from socket
  const [realtimeStatus, setRealtimeStatus] = useState({}); // deviceId → realtime listener status
  const [realtimeDetail, setRealtimeDetail] = useState({}); // deviceId → full realtime telemetry
  const gridRef = useRef();

  // ── Live status override from Socket.IO ──────────────────────────────────
  // EF-001 migration: uses the shared getSocket() singleton (same connection
  // App.jsx / useDeviceLiveSync / useRulesLiveSync / DataCleanupPage already
  // use) instead of opening a second, independent connection. Every handler
  // is a named const specifically so it can be individually unregistered via
  // socket.off() on cleanup — socket.disconnect() must NEVER be called here,
  // since that would tear down the ONE shared connection every other
  // currently-mounted component (and the app-wide company-settings:changed
  // listener in App.jsx) also depends on staying alive. No event name, no
  // payload, no handler logic changed — purely a connection-source swap.
  useEffect(() => {
    const socket = getSocket();

    const onSyncing = ({ deviceId }) =>
      setLiveStatus(s => ({ ...s, [deviceId]: 'syncing' }));

    const onDeviceSynced = ({ deviceId, newLogs, duration }) => {
      setLiveStatus(s => ({ ...s, [deviceId]: 'online' }));
      if (newLogs > 0) toast.success(`مزامنة ناجحة — ${W(newLogs)} حركة جديدة (${fmtDuration(duration)})`);
      loadAll();
    };

    const onOffline = ({ deviceId }) =>
      setLiveStatus(s => ({ ...s, [deviceId]: 'offline' }));

    const onDeviceError = ({ deviceId, error }) => {
      setLiveStatus(s => ({ ...s, [deviceId]: 'error' }));
      toast.error(`خطأ جهاز: ${error}`);
    };

    const onRealtimeStatus = ({ deviceId, status }) =>
      setRealtimeStatus(s => ({ ...s, [deviceId]: status }));

    // Certification HIGH#7: these eight events were emitted by the backend but
    // had zero frontend listeners anywhere — an operator had no visibility
    // into rebuild/relink progress or device-health warnings except raw
    // backend logs. Reuses the exact toast pattern already established above
    // for device:error/device:synced on this same page. relink:start/progress
    // live here (not in the shared useDeviceLiveSync hook) because every
    // current caller of that hook passes silent:true — a toast added there
    // would never actually be visible — and because the relink action is
    // triggered from, and watched on, this exact page.
    const onRelinkStart = ({ employeeCount }) => {
      if (employeeCount) toast.loading(`جارِ إعادة ربط سجلات ${W(employeeCount)} موظف...`, { id: 'relink-progress' });
    };

    const onRelinkProgress = ({ name, count }) => {
      if (name) toast.loading(`إعادة ربط: ${name} (${W(count)} سجل)`, { id: 'relink-progress' });
    };

    // Dismisses the loading toast above. Note: this is a SEPARATE listener
    // from the one already registered in useDeviceLiveSync.js — that hook is
    // not mounted while this page is active (React Router unmounts inactive
    // routes), so it cannot dismiss a toast started here. handleRelink() (the
    // button click path) already shows its own completion toast from the
    // HTTP response directly — this listener only matters for a secondary
    // tab/window watching this page while someone else (or an auto-triggered
    // relink) runs the operation.
    const onRelinkDone = ({ totalLinked, employeesAffected } = {}) => {
      toast.dismiss('relink-progress');
      if (totalLinked > 0) {
        toast.success(`تم ربط ${W(totalLinked)} سجل بصمة بـ ${W(employeesAffected)} موظف`);
        loadAll();
      }
    };

    const onRebuildStart = ({ jobId, from, to, employeeId }) => {
      toast.loading(
        employeeId ? `جارِ إعادة بناء الحضور (موظف #${employeeId}) من ${from} إلى ${to}...` : `جارِ إعادة بناء الحضور (${from} → ${to})...`,
        { id: `rebuild-${jobId}` },
      );
    };

    const onRebuildProgress = ({ jobId, processedDates, processedEmployees, totalEmployees }) => {
      toast.loading(`إعادة البناء: ${W(processedEmployees)}/${W(totalEmployees)} موظف، ${W(processedDates)} يوم`, { id: `rebuild-${jobId}` });
    };

    const onRebuildComplete = ({ jobId, processedEmployees, processedDates, errorCount }) => {
      toast.dismiss(`rebuild-${jobId}`);
      if (errorCount > 0) {
        toast.error(`اكتملت إعادة البناء بأخطاء: ${W(errorCount)} خطأ (${W(processedEmployees)} موظف، ${W(processedDates)} يوم)`);
      } else {
        toast.success(`اكتملت إعادة بناء الحضور — ${W(processedEmployees)} موظف، ${W(processedDates)} يوم`);
      }
      loadAll();
    };

    const onGapWarning = ({ name, daysSinceLastPunch }) => {
      toast(`⚠️ لا توجد بصمات من "${name || 'الجهاز'}" منذ ${W(daysSinceLastPunch)} يوم`, { id: `gap-${name}`, duration: 6000 });
    };

    const onIntegrityWarning = ({ name, message }) => {
      toast(`⚠️ ${name ? `"${name}": ` : ''}${message}`, { id: `integrity-${name || message}`, duration: 6000 });
    };

    const onTopologyWarning = ({ duplicates }) => {
      for (const g of duplicates || []) {
        toast(`⚠️ أجهزة مكررة على ${g.endpoint}: ${g.devices.map(d => d.name).join(', ')}`, { id: `topology-${g.endpoint}`, duration: 8000 });
      }
    };

    socket.on('device:syncing', onSyncing);
    socket.on('device:synced', onDeviceSynced);
    socket.on('device:offline', onOffline);
    socket.on('device:error', onDeviceError);
    socket.on('device:realtime-status', onRealtimeStatus);
    socket.on('relink:start', onRelinkStart);
    socket.on('relink:progress', onRelinkProgress);
    socket.on('relink:done', onRelinkDone);
    socket.on('rebuild:start', onRebuildStart);
    socket.on('rebuild:progress', onRebuildProgress);
    socket.on('rebuild:complete', onRebuildComplete);
    socket.on('device:gap-warning', onGapWarning);
    socket.on('device:integrity-warning', onIntegrityWarning);
    socket.on('device:topology-warning', onTopologyWarning);

    // Realtime listener telemetry (status + lastRealtimePunchAt, reconnectCount,
    // lastHeartbeat, eventLatencyMs, ...) — fetched on load and refreshed
    // periodically since most fields don't have a dedicated socket event.
    const loadRealtimeStatus = () => {
      api.get('/devices/realtime-status')
        .then(({ data }) => {
          const devices = data?.devices || {};
          setRealtimeDetail(devices);
          setRealtimeStatus(s => ({
            ...Object.fromEntries(Object.entries(devices).map(([id, v]) => [id, v.status])),
            ...s,
          }));
        })
        .catch(() => {});
    };
    loadRealtimeStatus();
    const realtimeTimer = setInterval(loadRealtimeStatus, 20000);

    return () => {
      socket.off('device:syncing', onSyncing);
      socket.off('device:synced', onDeviceSynced);
      socket.off('device:offline', onOffline);
      socket.off('device:error', onDeviceError);
      socket.off('device:realtime-status', onRealtimeStatus);
      socket.off('relink:start', onRelinkStart);
      socket.off('relink:progress', onRelinkProgress);
      socket.off('relink:done', onRelinkDone);
      socket.off('rebuild:start', onRebuildStart);
      socket.off('rebuild:progress', onRebuildProgress);
      socket.off('rebuild:complete', onRebuildComplete);
      socket.off('device:gap-warning', onGapWarning);
      socket.off('device:integrity-warning', onIntegrityWarning);
      socket.off('device:topology-warning', onTopologyWarning);
      clearInterval(realtimeTimer);
    };
  }, []);

  // ── Load data ─────────────────────────────────────────────────────────────
  const loadAll = useCallback(async () => {
    setLoading(true);
    setStatsLoad(true);
    try {
      const [d, b, s] = await Promise.all([
        api.get('/devices'),
        api.get('/branches'),
        api.get('/devices/stats'),
      ]);
      setDevices(d.data);
      setBranches(b.data);
      setStats(s.data);
    } catch { toast.error('فشل تحميل بيانات الأجهزة'); }
    finally { setLoading(false); setStatsLoad(false); }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // ── Sync single device ────────────────────────────────────────────────────
  const handleSync = async (id) => {
    setSyncing(s => ({ ...s, [id]: true }));
    try {
      const { data } = await api.post(`/devices/${id}/sync`, null, LONG_OP);
      if (!data.error) {
        toast.success(`مزامنة ناجحة — ${W(data.count)} حركة جديدة`);
        loadAll();
      } else {
        toast.error('فشل الاتصال بالجهاز');
      }
    } catch { toast.error('فشل المزامنة'); }
    finally { setSyncing(s => ({ ...s, [id]: false })); }
  };

  // ── Sync all ──────────────────────────────────────────────────────────────
  const handleSyncAll = async () => {
    setSyncAll(true);
    try {
      const { data } = await api.post('/devices/sync-all', null, LONG_OP);
      toast.success(`مزامنة جماعية — ${W(data.totalNewLogs)} حركة جديدة من ${W(data.results?.length)} جهاز`);
      loadAll();
    } catch { toast.error('فشلت المزامنة الجماعية'); }
    finally { setSyncAll(false); }
  };

  // ── Re-link orphaned attendance logs by zkUserId ─────────────────────────
  const handleRelink = async () => {
    setRelinking(true);
    try {
      const { data } = await api.post('/devices/relink', null, LONG_OP);
      if (data.totalLinked > 0) {
        toast.success(`تم ربط ${W(data.totalLinked)} سجل بصمة بـ ${W(data.employeesAffected)} موظف، وتحديث الحضور والرواتب`);
      } else {
        toast.success('لا توجد سجلات بصمة بحاجة لإعادة ربط');
      }
      setRelinkRefresh(k => k + 1);
      loadAll();
    } catch (err) {
      toast.error(err.response?.data?.error || 'فشلت إعادة الربط');
    } finally { setRelinking(false); }
  };

  // ── Ping device ───────────────────────────────────────────────────────────
  const handlePing = async (id) => {
    setPinging(s => ({ ...s, [id]: true }));
    try {
      const { data } = await api.post(`/devices/${id}/ping`);
      if (data.online) toast.success(`✅ الجهاز متصل — زمن الاستجابة: ${W(data.latency)}ms`);
      else             toast.error('❌ الجهاز غير متصل');
      loadAll();
    } catch { toast.error('فشل اختبار الاتصال'); }
    finally { setPinging(s => ({ ...s, [id]: false })); }
  };

  // ── Delete device ─────────────────────────────────────────────────────────
  const handleDelete = async (id) => {
    try {
      const { data } = await api.delete(`/devices/${id}`);
      // Optimistically drop the row so the grid refreshes instantly, then resync.
      setDevices(prev => prev.filter(d => d.id !== id));
      setLiveStatus(s => { const n = { ...s }; delete n[id]; return n; });
      toast.success(
        data?.mode === 'hard'
          ? 'تم حذف الجهاز نهائياً'
          : `تمت أرشفة الجهاز (مع الحفاظ على ${W(data?.preservedLogs || 0)} سجل بصمة)`
      );
      setDeleteId(null);
      loadAll();
    } catch (err) {
      toast.error(err.response?.data?.error || 'فشل الحذف');
    }
  };

  // ── AG Grid columns ───────────────────────────────────────────────────────
  const NUM = { textAlign: 'right', direction: 'ltr', justifyContent: 'flex-end', fontFamily: 'Consolas,monospace' };

  const cols = useMemo(() => [
    {
      headerName: '#', valueGetter: 'node.rowIndex + 1', width: 52,
      sortable: false, filter: false, pinned: 'right', headerClass: 'ag-header-center',
      cellStyle: { ...NUM, color: 'var(--c-muted)', fontSize: 11, justifyContent: 'center' },
    },
    {
      field: 'name', headerName: 'اسم الجهاز', width: 180, pinned: 'right',
      cellStyle: { fontWeight: 700, color: 'var(--c-name)', fontFamily: 'Cairo, sans-serif' },
    },
    {
      headerName: 'الحالة', width: 115, headerClass: 'ag-header-center',
      cellRenderer: ({ data }) => {
        const status = liveStatus[data.id] || data.status || 'offline';
        return <StatusBadge status={status} />;
      },
      cellStyle: { justifyContent: 'center' },
    },
    {
      headerName: 'البث المباشر', width: 130, headerClass: 'ag-header-center',
      cellRenderer: ({ data }) => <RealtimeBadge status={realtimeStatus[data.id]} detail={realtimeDetail[data.id]} />,
      cellStyle: { justifyContent: 'center' },
    },
    {
      field: 'ipAddress', headerName: 'عنوان IP', width: 145,
      cellStyle: { ...NUM, color: 'var(--c-code)', fontSize: 12 },
      valueFormatter: p => `${p.value}:${p.data?.port}`,
    },
    {
      field: 'branch.name', headerName: 'الفرع', width: 140,
      cellStyle: { color: 'var(--c-dept)', fontFamily: 'Cairo, sans-serif', fontSize: 12 },
    },
    {
      field: 'rawLogCount', headerName: 'السجلات الخام', width: 120,
      cellStyle: { ...NUM, color: 'var(--c-val)', fontWeight: 600 },
      valueFormatter: p => W(p.value || 0),
    },
    {
      field: 'lastSync', headerName: 'آخر مزامنة', width: 150,
      cellStyle: { color: 'var(--c-time)', fontFamily: 'Consolas, monospace', fontSize: 11 },
      valueFormatter: p => fmtDatetime(p.value),
    },
    {
      field: 'lastSyncCount', headerName: 'سجلات أخر مزامنة', width: 145,
      cellStyle: p => ({ ...NUM, color: (p.value || 0) > 0 ? 'var(--c-ot)' : 'var(--c-muted)' }),
      valueFormatter: p => (p.value || 0) > 0 ? `+${W(p.value)}` : '—',
    },
    {
      field: 'syncInterval', headerName: 'الفترة', width: 90,
      cellStyle: { ...NUM, color: 'var(--c-muted)', fontSize: 11 },
      valueFormatter: p => `${W(p.value)} د`,
    },
    {
      field: 'autoSync', headerName: 'تلقائي', width: 80, headerClass: 'ag-header-center',
      cellStyle: { justifyContent: 'center' },
      cellRenderer: ({ value }) => (
        <span style={{
          fontSize: 10, padding: '2px 8px', borderRadius: 99,
          background: value ? 'rgba(34,197,94,0.1)' : 'rgba(107,114,128,0.1)',
          color:      value ? '#22c55e'             : '#6b7280',
        }}>
          {value ? 'نعم' : 'لا'}
        </span>
      ),
    },
    {
      headerName: 'إجراءات', width: 250, pinned: 'left',
      sortable: false, filter: false,
      cellRenderer: ({ data }) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, height: '100%' }}>
          {/* Sync */}
          <button
            onClick={() => handleSync(data.id)}
            disabled={syncing[data.id]}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
              cursor: 'pointer', border: '1.5px solid rgba(37,99,235,0.4)',
              background: 'rgba(37,99,235,0.1)', color: 'var(--accent)',
              fontFamily: 'Cairo, sans-serif',
            }}
          >
            {syncing[data.id]
              ? <Loader2 style={{ width: 11, height: 11, animation: 'spin 1s linear infinite' }} />
              : <Play style={{ width: 11, height: 11 }} />}
            مزامنة
          </button>
          {/* Ping */}
          <button
            onClick={() => handlePing(data.id)}
            disabled={pinging[data.id]}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '3px 9px', borderRadius: 6, fontSize: 11, fontWeight: 600,
              cursor: 'pointer', border: '1.5px solid rgba(34,197,94,0.35)',
              background: 'rgba(34,197,94,0.08)', color: '#22c55e',
              fontFamily: 'Cairo, sans-serif',
            }}
          >
            {pinging[data.id]
              ? <Loader2 style={{ width: 11, height: 11, animation: 'spin 1s linear infinite' }} />
              : <Radio style={{ width: 11, height: 11 }} />}
            اتصال
          </button>
          {/* Edit */}
          <button
            onClick={() => { setEditing(data); setDrawer(true); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '3px 9px', borderRadius: 6, fontSize: 11, fontWeight: 600,
              cursor: 'pointer', border: '1.5px solid rgba(148,163,184,0.3)',
              background: 'rgba(148,163,184,0.06)', color: 'var(--text-2)',
              fontFamily: 'Cairo, sans-serif',
            }}
          >
            <Edit3 style={{ width: 11, height: 11 }} />
            تعديل
          </button>
          {/* Delete */}
          <button
            onClick={() => setDeleteId(data.id)}
            style={{
              display: 'flex', alignItems: 'center',
              padding: '3px 7px', borderRadius: 6,
              cursor: 'pointer', border: '1.5px solid rgba(239,68,68,0.3)',
              background: 'rgba(239,68,68,0.08)', color: '#ef4444',
            }}
          >
            <Trash2 style={{ width: 11, height: 11 }} />
          </button>
        </div>
      ),
      cellStyle: { justifyContent: 'flex-start' },
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [syncing, pinging, liveStatus, realtimeStatus, realtimeDetail]);

  const defaultColDef = useMemo(() => ({ ...ENTERPRISE_DEFAULT_COL_DEF }), []);

  const getRowClass = useCallback(({ data }) => {
    if (!data) return '';
    const status = liveStatus[data.id] || data.status;
    if (status === 'online')  return 'row-present';
    if (status === 'syncing') return 'row-overtime';
    if (status === 'error')   return 'row-absent';
    return '';
  }, [liveStatus]);

  const surface = isLight ? '#fff' : '#0b1628';
  const border  = isLight ? '#e2e8f0' : '#1a3454';
  const textSub = isLight ? '#64748b' : '#64748b';

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
    <div dir="rtl" style={{ display: 'flex', flexDirection: 'column', gap: 14, height: '100%' }}>

      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Layers style={{ width: 22, height: 22, color: 'var(--accent)' }} />
            إدارة أجهزة البصمة
          </h1>
          <p style={{ fontSize: 12, color: textSub, marginTop: 4, fontFamily: 'Cairo, sans-serif' }}>
            {devices.length} جهاز مسجل · مزامنة تلقائية كل {devices[0]?.syncInterval || 5} دقيقة
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={loadAll}
            className="btn-ghost"
            style={{ padding: '7px 10px', borderRadius: 8 }}
          >
            <RefreshCw style={{ width: 15, height: 15 }} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={handleSyncAll}
            disabled={syncAll}
            className="btn-secondary"
            style={{ fontSize: 12 }}
          >
            {syncAll
              ? <Loader2 style={{ width: 13, height: 13, animation: 'spin 1s linear infinite' }} />
              : <Zap style={{ width: 13, height: 13 }} />}
            مزامنة الكل
          </button>
          <button
            onClick={handleRelink}
            disabled={relinking}
            className="btn-secondary"
            style={{ fontSize: 12 }}
            title="إعادة ربط كل سجلات البصمة القديمة بالموظفين بناءً على zkUserId دون الحاجة لسحب جديد"
          >
            {relinking
              ? <Loader2 style={{ width: 13, height: 13, animation: 'spin 1s linear infinite' }} />
              : <Link2 style={{ width: 13, height: 13 }} />}
            إعادة ربط البصمات
          </button>
          <button
            className="btn-primary"
            style={{ fontSize: 12 }}
            onClick={() => { setEditing(null); setDrawer(true); }}
          >
            <Plus style={{ width: 13, height: 13 }} />
            إضافة جهاز
          </button>
        </div>
      </div>

      {/* ── KPI Cards ────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
        <KpiCard label="إجمالي الأجهزة"  value={stats?.total}      icon={Server}   color="#3b82f6"  loading={statsLoad} />
        <KpiCard label="متصل"             value={stats?.online}     icon={Wifi}     color="#22c55e"  loading={statsLoad} sub="في الوقت الحالي" />
        <KpiCard label="غير متصل"         value={stats?.offline}    icon={WifiOff}  color="#ef4444"  loading={statsLoad} />
        <KpiCard
          label="آخر مزامنة"
          value={stats?.lastSync ? fmtAgo(stats.lastSync) : 'لم تتم'}
          icon={Clock}
          color="#f59e0b"
          loading={statsLoad}
          sub={stats?.recentSyncs ? `${W(stats.recentSyncs)} مزامنة ناجحة (24س)` : ''}
        />
        <KpiCard
          label="إجمالي السجلات الخام"
          value={stats?.totalLogs}
          icon={Database}
          color="#a78bfa"
          loading={statsLoad}
          sub="حركات بصمة محفوظة"
        />
      </div>

      {/* ── Device status strip ───────────────────────────────────────────── */}
      {devices.length > 0 && (
        <div style={{
          display: 'flex', gap: 10, padding: '10px 14px',
          background: surface, border: `1px solid ${border}`,
          borderRadius: 10, overflowX: 'auto', flexWrap: 'wrap',
        }}>
          {devices.map(d => {
            const status = liveStatus[d.id] || d.status || 'offline';
            const cfg    = STATUS_CFG[status] || STATUS_CFG.offline;
            return (
              <div
                key={d.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 12px', borderRadius: 8,
                  background: cfg.bg, border: `1px solid ${cfg.color}30`,
                  cursor: 'pointer', whiteSpace: 'nowrap',
                }}
                onClick={() => handlePing(d.id)}
                title={`${d.ipAddress}:${d.port} — نقر للاختبار`}
              >
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', background: cfg.dot, flexShrink: 0,
                  boxShadow: cfg.pulse ? `0 0 7px ${cfg.dot}` : 'none',
                  animation: cfg.pulse && status === 'syncing' ? 'pulse-dot 0.8s ease-in-out infinite' : 'none',
                }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: cfg.color, fontFamily: 'Cairo, sans-serif' }}>
                  {d.name}
                </span>
                <span style={{ fontSize: 10, color: isLight ? '#94a3b8' : '#475569', fontFamily: 'Consolas, monospace' }}>
                  {d.ipAddress}
                </span>
                {d.lastSync && (
                  <span style={{ fontSize: 10, color: isLight ? '#94a3b8' : '#3d5478' }}>
                    {fmtAgo(d.lastSync)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── AG Grid Table ─────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        <div
          className={agGridTheme}
          style={{ height: '100%', minHeight: 280 }}
        >
          <AgGridReact
            ref={gridRef}
            rowData={devices}
            columnDefs={cols}
            defaultColDef={defaultColDef}
            {...ENTERPRISE_GRID_PROPS}
            getRowClass={getRowClass}
            enableRtl={true}
            localeText={AG_GRID_LOCALE_AR}
            animateRows={false}
            rowSelection="single"
            suppressRowClickSelection
            enableCellTextSelection
            loading={loading}
            rowHeight={42}
          />
        </div>
      </div>

      {/* ── Relink Diagnostics Panel ──────────────────────────────────────── */}
      <RelinkDiagnosticsPanel isLight={isLight} refreshKey={relinkRefresh} />

      {/* ── Recovery Diagnostics Panels (per device) ───────────────────────── */}
      {devices.map(d => (
        <RecoveryDiagnosticsPanel key={d.id} deviceId={d.id} deviceName={d.name} isLight={isLight} />
      ))}

      {/* ── Sync Logs Panel ───────────────────────────────────────────────── */}
      <SyncLogsPanel deviceId={null} deviceName={null} isLight={isLight} />

      {/* ── Device Drawer ─────────────────────────────────────────────────── */}
      <DeviceDrawer
        open={drawer}
        onClose={() => setDrawer(false)}
        onSaved={loadAll}
        device={editing}
        branches={branches}
      />

      {/* ── Delete Confirm Modal ──────────────────────────────────────────── */}
      {deleteId && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 9500,
            background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setDeleteId(null)}
        >
          <div
            dir="rtl"
            style={{
              background: surface, border: `1.5px solid ${border}`,
              borderRadius: 14, padding: '24px 28px', width: 360,
              boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <div style={{ padding: 10, borderRadius: 10, background: 'rgba(239,68,68,0.12)' }}>
                <AlertTriangle style={{ width: 22, height: 22, color: '#ef4444' }} />
              </div>
              <div>
                <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', fontFamily: 'Cairo, sans-serif' }}>حذف الجهاز</p>
                <p style={{ fontSize: 12, color: textSub, marginTop: 2 }}>لا يمكن التراجع عن هذا الإجراء</p>
              </div>
            </div>
            <p style={{ fontSize: 13, color: textSub, marginBottom: 20, fontFamily: 'Cairo, sans-serif', lineHeight: 1.6 }}>
              سيتم حذف الجهاز وجميع سجلات المزامنة الخاصة به. سجلات الحضور الخام لن تُحذف.
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => handleDelete(deleteId)}
                style={{
                  flex: 1, padding: '8px 0', borderRadius: 8, border: 'none',
                  background: '#ef4444', color: '#fff',
                  fontSize: 13, fontWeight: 700, fontFamily: 'Cairo, sans-serif', cursor: 'pointer',
                }}
              >
                تأكيد الحذف
              </button>
              <button
                onClick={() => setDeleteId(null)}
                style={{
                  padding: '8px 20px', borderRadius: 8,
                  border: `1px solid ${border}`, background: 'transparent',
                  color: textSub, fontSize: 13, fontFamily: 'Cairo, sans-serif', cursor: 'pointer',
                }}
              >
                إلغاء
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
    {/* Keyframes outside the flex root so they don't add an extra flex gap */}
    <style>{`
      @keyframes pulse-dot {
        0%, 100% { opacity: 1; transform: scale(1);    }
        50%       { opacity: 0.5; transform: scale(1.3); }
      }
      @keyframes spin {
        from { transform: rotate(0deg);   }
        to   { transform: rotate(360deg); }
      }
      @keyframes pulse {
        0%, 100% { opacity: 1;   }
        50%       { opacity: 0.4; }
      }
    `}</style>
    </>
  );
}
