import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  RefreshCw, ArrowRight, Printer, UserX, Clock, Fingerprint, Loader2,
  Percent, Zap, UserCheck, Users, CalendarDays,
} from 'lucide-react';
import { BarChart, Bar, XAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useNavigate } from 'react-router-dom';
import api, { LONG_OP } from '../lib/api';
import toast from 'react-hot-toast';
import { westernDigits, fmtTime, fmtPenaltyUnits, fmtOvertimeUnits, STATUS_LABELS } from '../lib/formatters';
import { useTheme } from '../contexts/ThemeContext';
import { useRulesLiveSync } from '../hooks/useRulesLiveSync';
import { useDeviceLiveSync } from '../hooks/useDeviceLiveSync';
import { useFingerprintSyncWorkflow } from '../hooks/useFingerprintSyncWorkflow';
import PrintPreviewModal from '../components/PrintPreviewModal';
import FingerprintSyncModal from '../components/FingerprintSyncModal';
import {
  DeviceStatusCompact, DeviceMonitoringTable, FingerprintStatsGrid, LatestFingerprintsTable,
} from '../components/DeviceMonitoringPanel';
import { useCompanyBrand } from '../lib/branding';
import useAuthStore from '../store/authStore';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Select from '../components/ui/Select';

const GAP = 16; // spec: 16px grid gap / card padding throughout this page

const W = (v) => westernDigits(String(v ?? 0));
const DAY_AR = { Mon:'إثنين', Tue:'ثلاثاء', Wed:'أربعاء', Thu:'خميس', Fri:'جمعة', Sat:'سبت', Sun:'أحد' };

// Six equal KPI cards (Row 1): border-radius 12px, thin border, soft shadow,
// colored vertical accent, large bold value, small muted description, small
// icon. Padding/value use clamp() (min, viewport-relative, max) instead of a
// fixed px so the same card reads correctly from a MacBook Air 13" window up
// to a 1920px Windows monitor — never a fixed Windows-tuned number.
function KpiCard({ icon: Icon, label, value, sub, accent, color, isLight }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8, minWidth: 0,
      padding: 'clamp(16px, 2vh, 24px) clamp(14px, 1.2vw, 18px)', borderRadius: 12,
      background: 'var(--surface)', border: '1px solid var(--border)',
      boxShadow: 'var(--shadow-card)', borderInlineStart: `4px solid ${accent}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.3, color: 'var(--text-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        {Icon && <Icon style={{ width: 20, height: 20, color: accent, flexShrink: 0 }} />}
      </div>
      <span style={{
        fontFamily: 'var(--font-num)', fontWeight: 800, fontSize: 'clamp(28px, 2.2vw, 36px)', lineHeight: 1.05,
        color: isLight ? color : 'var(--text)', fontVariantNumeric: 'tabular-nums lining-nums',
      }}>
        {W(value)}
      </span>
      {sub && <span style={{ fontSize: 13, lineHeight: 1.3, color: 'var(--text-3)' }}>{sub}</span>}
    </div>
  );
}

function StatusPill({ value }) {
  const s = STATUS_LABELS[value];
  if (!s) return <span style={{ color:'var(--c-muted)' }}>—</span>;
  return (
    <span className="badge" style={{ color:s.color, background:s.bg, border:`1px solid ${s.color}40` }}>{s.ar}</span>
  );
}

export default function DashboardPage() {
  const { isLight } = useTheme();
  const navigate = useNavigate();
  const brand = useCompanyBrand();

  // Same hook + modal AttendanceDailyPage uses for "سحب البصمات" — no
  // separate sync implementation for the Dashboard. `run()`'s own
  // synchronous runningRef guard (see useFingerprintSyncWorkflow.js) is what
  // actually prevents a duplicate request from this button; the disabled
  // attribute below is the visible reflection of that same guard, not a
  // second, independent lock.
  const fpSync = useFingerprintSyncWorkflow();
  const fpSyncing = fpSync.state.phase === 'running';
  // Mirrors the backend's authorize('admin','hr') on POST /devices/sync-all
  // (zktecoService.js is unauthenticated no-op in Desktop Mode, matching
  // AUTH_ENABLED=false everywhere else in this app) — this button is the
  // first place in the frontend that gates on role, so it's spelled out
  // rather than assumed: when auth is off, everyone already has this access
  // server-side, so hiding it client-side would just be theater.
  const { authEnabled, user } = useAuthStore();
  const canDownloadFingerprints = !authEnabled || ['admin', 'hr'].includes(user?.role);

  const [data,         setData]         = useState(null);
  const [devices,      setDevices]      = useState([]);
  const [roster,       setRoster]       = useState([]);
  const [departments,  setDepartments]  = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [syncing,      setSyncing]      = useState(false);
  const [deviceEvents, setDeviceEvents] = useState([]);
  const [syncLogs,     setSyncLogs]     = useState([]);

  // Department filter
  const [deptFilter, setDeptFilter] = useState('');

  // Print state
  const [printOpen, setPrintOpen]   = useState(false);
  const [printType, setPrintType]   = useState('attendance_daily');

  const today = new Date().toISOString().split('T')[0];
  const todayAr = new Date().toLocaleDateString('ar-EG', { weekday:'long', day:'numeric', month:'long', year:'numeric' });

  const load = async () => {
    lastLoadRef.current = Date.now();
    try {
      const [d, dv, ros, depts, evRes, syncLogsRes] = await Promise.all([
        api.get('/dashboard'),
        api.get('/devices'),
        api.get('/attendance/daily', { params: { date: today } }).catch(() => ({ data: [] })),
        api.get('/departments').catch(() => ({ data: [] })),
        // Device Monitoring widget data — reuses existing endpoints only
        // (see DeviceMonitoringPanel doc comment). Gated behind the same
        // admin/hr role check as the fingerprint-download button since this
        // endpoint carries the same authorize('admin','hr') on the backend.
        canDownloadFingerprints
          ? api.get('/attendance/logs', { params: { limit: 10 } }).catch(() => ({ data: { logs: [] } }))
          : Promise.resolve({ data: { logs: [] } }),
        api.get('/devices/sync-logs/recent', { params: { limit: 30 } }).catch(() => ({ data: [] })),
      ]);
      setData(d.data);
      setDevices(dv.data);
      setRoster(ros.data || []);
      setDepartments(depts.data || []);
      setDeviceEvents(evRes.data?.logs || []);
      setSyncLogs(syncLogsRes.data || []);
    } catch { toast.error('تعذر تحميل البيانات'); }
    finally { setLoading(false); }
  };

  // EP-014: the 60s interval is a fallback safety net, not a primary refresh
  // path — the two live-sync hooks below already reload on every relevant
  // socket event. Without this guard, a socket-triggered load() moments
  // before the interval tick caused two back-to-back full refetches of all 4
  // endpoints. The interval now only fires if nothing has reloaded recently.
  const lastLoadRef = useRef(0);
  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (Date.now() - lastLoadRef.current > 20000) load();
    }, 60000);
    return () => clearInterval(t);
  }, []);
  useRulesLiveSync(load, { silent: true });
  useDeviceLiveSync(load, { silent: true });

  const syncAll = async () => {
    setSyncing(true);
    try {
      await Promise.all(devices.filter(d => d.enabled).map(d => api.post(`/devices/${d.id}/sync`, null, LONG_OP).catch(() => {})));
      toast.success('تمت مزامنة الأجهزة'); load();
    } catch { toast.error('فشل المزامنة'); }
    finally { setSyncing(false); }
  };

  // Filter roster by department
  const filteredRoster = useMemo(() => {
    if (!deptFilter) return roster;
    const deptName = departments.find(d => String(d.id) === deptFilter)?.name;
    if (!deptName) return roster;
    return roster.filter(r => r.department === deptName);
  }, [roster, deptFilter, departments]);

  // Alerts from filtered roster
  const alerts = useMemo(() => [...filteredRoster]
    .filter(r => r.isAbsent || (r.effectiveLatePenalty||0) > 0 || (r.effectiveOvertimeUnits||0) > 0)
    .sort((a, b) => {
      const sev = r => r.isAbsent ? 3 : (r.effectiveLatePenalty||0) > 0 ? 2 : 1;
      return sev(b) - sev(a) || (b.effectiveLatePenalty||0) - (a.effectiveLatePenalty||0);
    }), [filteredRoster]);

  // Pass full dept-filtered roster; modal's filteredData handles type-specific sub-filtering.
  const printData = filteredRoster;

  // ── Device Monitoring widget derived data ──────────────────────────────
  const deviceMonitoringEvents = useMemo(() => deviceEvents.map(log => ({
    id: log.id,
    employeeName: log.employee?.name || 'غير مرتبط',
    timestamp: log.timestamp,
    isManual: log.source && log.source !== 'device',
  })), [deviceEvents]);
  const deviceTotalLogs = useMemo(
    () => devices.reduce((s, d) => s + (d.rawLogCount ?? d.totalLogsCount ?? 0), 0),
    [devices]
  );
  const startOfToday = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, [today]);
  const deviceImportedToday = useMemo(() =>
    syncLogs
      .filter(l => l.status === 'success' && new Date(l.startedAt) >= startOfToday)
      .reduce((s, l) => s + (l.newLogs || 0), 0),
  [syncLogs, startOfToday]);
  const deviceFailedToday = useMemo(() =>
    syncLogs.filter(l => l.status === 'failed' && new Date(l.startedAt) >= startOfToday).length,
  [syncLogs, startOfToday]);

  const openPrint = (type) => {
    setPrintType(type);
    setPrintOpen(true);
  };

  const present = data?.present ?? 0;
  const total   = data?.totalEmployees ?? 0;
  const rate    = total ? Math.round((present / total) * 100) : 0;

  // KPI metrics — filter by dept when active (use roster counts)
  const { deptPresent, deptAbsent, deptLate, deptOT } = useMemo(() => {
    let present = 0, absent = 0, late = 0, ot = 0;
    for (const r of filteredRoster) {
      // isAbsent is the single canonical absence flag — a checkIn-only or
      // checkOut-only day is present, not absent, so this must not re-derive
      // presence from checkIn alone (was silently excluding checkOut-only
      // employees from this KPI count).
      if (!r.isAbsent) present++;
      if (r.isAbsent || r.status === 'absent') absent++;
      if ((r.effectiveLatePenalty||0) > 0) late++;
      if ((r.effectiveOvertimeUnits||0) > 0) ot++;
    }
    return { deptPresent: present, deptAbsent: absent, deptLate: late, deptOT: ot };
  }, [filteredRoster]);

  // Metric strip accent/value colors — the original PETSHROW Light Theme
  // used a fixed vivid palette here (independent of the semantic status
  // tokens used elsewhere), so Light restores those exact literals; Dark
  // keeps the new token-driven palette introduced by the design system pass.
  // Order fixed per spec Row 1: Attendance % → Overtime → Late → Absent → Present → Total.
  const metrics = deptFilter ? [
    { label:'نسبة الحضور', icon:Percent,    value:`${W(filteredRoster.length ? Math.round(deptPresent/filteredRoster.length*100) : 0)}%`, accent: isLight ? '#0ea5e9' : 'var(--c-net)', color: isLight ? '#0ea5e9' : 'var(--c-net)' },
    { label:'الإضافي',     icon:Zap,        value:deptOT,                      accent: isLight ? '#8b5cf6' : 'var(--status-overtime)', color: isLight ? '#8b5cf6' : 'var(--status-overtime)' },
    { label:'المتأخرون',   icon:Clock,      value:deptLate,                    accent: isLight ? '#f59e0b' : 'var(--status-late)',     color: isLight ? '#f59e0b' : 'var(--status-late)' },
    { label:'الغياب',      icon:UserX,      value:deptAbsent,                  accent: isLight ? '#ef4444' : 'var(--status-absent)',   color: isLight ? '#ef4444' : 'var(--status-absent)' },
    { label:'حضور اليوم', icon:UserCheck,  value:deptPresent,                 accent: isLight ? '#10b981' : 'var(--status-present)',  color: isLight ? '#10b981' : 'var(--status-present)' },
    { label:'الموظفون',    icon:Users,      value:filteredRoster.length,       accent: isLight ? '#3b82f6' : 'var(--accent)',          color: isLight ? 'var(--text)' : 'var(--text)' },
  ] : [
    { label:'نسبة الحضور',      icon:Percent,   value:`${W(rate)}%`,   accent: isLight ? '#0ea5e9' : 'var(--c-net)',           color: isLight ? '#0ea5e9' : 'var(--c-net)' },
    { label:'الإضافي',          icon:Zap,       value:data?.overtime,  accent: isLight ? '#8b5cf6' : 'var(--status-overtime)', color: isLight ? '#8b5cf6' : 'var(--status-overtime)', sub:'موظف' },
    { label:'المتأخرون',        icon:Clock,     value:data?.late,      accent: isLight ? '#f59e0b' : 'var(--status-late)',     color: isLight ? '#f59e0b' : 'var(--status-late)' },
    { label:'الغياب',          icon:UserX,     value:data?.absent,    accent: isLight ? '#ef4444' : 'var(--status-absent)',   color: isLight ? '#ef4444' : 'var(--status-absent)' },
    { label:'حضور اليوم',      icon:UserCheck, value:present,         accent: isLight ? '#10b981' : 'var(--status-present)',  color: isLight ? '#10b981' : 'var(--status-present)', sub:`${W(data?.onTime ?? 0)} في الوقت` },
    { label:'إجمالي الموظفين', icon:Users,     value:total,          accent: isLight ? '#3b82f6' : 'var(--accent)',          color: isLight ? 'var(--text)' : 'var(--text)' },
  ];

  const weeklyData = useMemo(
    () => (data?.weeklyData || []).map(d => ({ ...d, day: DAY_AR[d.day] || d.day })),
    [data?.weeklyData]
  );

  // Print meta
  const printMeta = {
    period: todayAr,
    dept: deptFilter ? departments.find(d => String(d.id) === deptFilter)?.name : undefined,
    generatedBy: 'مدير النظام',
    brand,
  };

  // Restored to the app's original control scale (~40-44px tall, 14px label)
  // — the compact pass had shrunk these to var(--text-xs)/4px padding.
  const PRINT_BTN_SIZE = { fontSize:14, fontWeight:700, padding:'12px 18px', borderRadius:'var(--radius)' };

  const liveSyncing = fpSync.state.phase === 'running';

  return (
    <div style={{ position:'relative', display:'flex', flexDirection:'column', flex:1, minHeight:0, overflow:'hidden' }}>
      {/* Brand watermark — identity without distraction: a single large,
          near-invisible (3%) mark fixed to a corner, never over interactive
          content (zIndex below the scrolling content layer, pointer-events
          off). Text/data readability is untouched. */}
      {brand.logoUrl && (
        <img src={brand.logoUrl} alt="" aria-hidden="true" style={{
          position:'absolute', insetInlineEnd:8, bottom:8, width:260, height:260,
          objectFit:'contain', opacity:0.035, pointerEvents:'none', zIndex:0,
          filter: isLight ? 'none' : 'grayscale(1) brightness(3)',
        }} />
      )}
      <div style={{ position:'relative', zIndex:1, display:'flex', flexDirection:'column', gap:GAP, direction:'rtl', flex:1, overflowY:'auto', minHeight:0 }}>

      {/* ── Dashboard title + subtitle (system status / theme / date already
          live in the shared app header — Layout.jsx) ─────────────────────── */}
      <div className="page-header" style={{ marginBottom:0 }}>
        <div>
          <h1 className="page-title" style={{ fontSize:'clamp(24px, 2.4vw, 34px)' }}>لوحة التحكم</h1>
          <p style={{ fontSize:13, color:'var(--text-3)', marginTop:4 }}>
            {todayAr} · متابعة فورية
          </p>
        </div>
      </div>

      <FingerprintSyncModal
        state={fpSync.state}
        onClose={fpSync.close}
        onRetry={fpSync.retry}
        devices={devices}
        onViewLogs={() => { fpSync.close(); navigate('/attendance/logs'); }}
      />

      {/* ── Action bar: Fingerprint Sync, Device Sync, Print ×3, then
          Department Filter, then Date ─────────────────────────────────────── */}
      <Card padding="md" style={{ borderRadius:12 }} contentStyle={{ display:'flex', alignItems:'center', gap:'var(--space-2)', flexWrap:'wrap' }}>
        {canDownloadFingerprints && (
          <Button
            variant="primary"
            size="lg"
            onClick={() => fpSync.run({ endpoint: '/devices/sync-all', reload: load })}
            disabled={fpSyncing}
            icon={fpSyncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Fingerprint className="w-4 h-4" />}
          >
            {fpSyncing ? 'جاري سحب البصمات...' : 'سحب البصمات'}
          </Button>
        )}
        <Button variant="secondary" size="lg" onClick={syncAll} disabled={syncing}
          icon={<RefreshCw className={syncing ? 'w-4 h-4 animate-spin' : 'w-4 h-4'} />}>
          {syncing ? 'جاري المزامنة...' : 'مزامنة الأجهزة'}
        </Button>
        <Button variant="ghost" onClick={() => openPrint('attendance_dashboard')}
          icon={<Printer className="w-4 h-4" />}
          style={{ ...PRINT_BTN_SIZE, background: isLight ? 'rgba(16,185,129,0.12)' : 'var(--status-present-bg)', color: isLight ? '#10b981' : 'var(--status-present)', border: '1px solid ' + (isLight ? 'rgba(16,185,129,0.3)' : 'color-mix(in srgb, var(--status-present) 30%, transparent)') }}>
          طباعة الحضور
        </Button>
        <Button variant="ghost" onClick={() => openPrint('attendance_daily_absent')}
          icon={<UserX className="w-4 h-4" />}
          style={{ ...PRINT_BTN_SIZE, background: isLight ? 'rgba(239,68,68,0.12)' : 'var(--status-absent-bg)', color: isLight ? '#ef4444' : 'var(--status-absent)', border: '1px solid ' + (isLight ? 'rgba(239,68,68,0.3)' : 'color-mix(in srgb, var(--status-absent) 30%, transparent)') }}>
          طباعة الغياب
        </Button>
        <Button variant="ghost" onClick={() => openPrint('attendance_daily_late')}
          icon={<Clock className="w-4 h-4" />}
          style={{ ...PRINT_BTN_SIZE, background: isLight ? 'rgba(245,158,11,0.12)' : 'var(--status-late-bg)', color: isLight ? '#f59e0b' : 'var(--status-late)', border: '1px solid ' + (isLight ? 'rgba(245,158,11,0.3)' : 'color-mix(in srgb, var(--status-late) 30%, transparent)') }}>
          طباعة المتأخرين
        </Button>

        <span style={{ width:1, alignSelf:'stretch', background:'var(--border)', margin:'0 2px' }} />

        <div style={{ display:'flex', alignItems:'center', gap:'var(--space-2)' }}>
          <label style={{ fontSize:14, color:'var(--text-3)', whiteSpace:'nowrap' }}>القسم</label>
          <Select
            value={deptFilter}
            onChange={e => setDeptFilter(e.target.value)}
            placeholder="كل الأقسام"
            options={departments.map(d => ({ value:d.id, label:d.name }))}
            style={{ minHeight:40, fontSize:14, minWidth:170 }}
          />
          {deptFilter && (
            <button
              onClick={() => setDeptFilter('')}
              style={{ fontSize:13, color:'var(--accent)', background:'none', border:'none', cursor:'pointer', padding:'var(--space-1) var(--space-2)' }}
            >
              × مسح الفلتر
            </button>
          )}
        </div>

        {/* Date — the dashboard is a real-time "today" view (/api/dashboard
            has no date parameter), so this reflects that rather than
            offering a date range the backend can't actually serve. */}
        <div title="لوحة التحكم تعرض بيانات اليوم الحالي فقط" style={{
          display:'flex', alignItems:'center', gap:8, marginInlineStart:'auto', minHeight:40,
          padding:'8px 14px', borderRadius:'var(--radius-sm)', border:'1px solid var(--border)', background:'var(--surface-2)',
        }}>
          <CalendarDays style={{ width:16, height:16, color:'var(--text-3)' }} />
          <span style={{ fontSize:14, fontWeight:600, color:'var(--text-2)', fontVariantNumeric:'tabular-nums' }}>{today}</span>
        </div>

        <span style={{ fontSize:13, color:'var(--text-3)' }}>
          {filteredRoster.length > 0 && `${W(filteredRoster.length)} موظف`}
        </span>
      </Card>

      {/* ── Row 1: six equal KPI cards ──────────────────────────────────────── */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(6, minmax(0,1fr))', gap:GAP }}>
        {metrics.map(m => <KpiCard key={m.label} {...m} isLight={isLight} />)}
      </div>

      {/* ── Main grid: Left (~33%, compact/top-aligned) | Center+Right (stretched
          to fill the remaining viewport height so the alerts table grows
          naturally instead of the left column dictating row height) ──────── */}
      <div style={{ display:'grid', gridTemplateColumns:'minmax(0,1fr) minmax(0,2fr)', gridTemplateRows:'1fr', gap:GAP, flex:1, minHeight:0 }}>

        {/* Left column — compact, top-aligned; never taller than the center table */}
        <div style={{ display:'flex', flexDirection:'column', gap:GAP, alignSelf:'start', minWidth:0 }}>

          {/* Card 1: Attendance Last 7 Days — compact bar chart. The plot area
              sizes off clamp()+vh (a floor, a viewport-relative middle, a
              ceiling) and ResponsiveContainer fills it at 100%, instead of a
              hardcoded pixel height that would over/under-fill on a MacBook
              Air 13" vs a 1920px external monitor. */}
          <Card padding="none" style={{ overflow:'hidden', borderRadius:12 }} header={<span className="panel-title" style={{ fontSize:16 }}>الحضور — آخر 7 أيام</span>}>
            <div style={{ padding:'14px 14px 8px', minHeight:150, height:'clamp(150px, 20vh, 200px)' }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={weeklyData} barGap={3} barCategoryGap="32%">
                  <XAxis dataKey="day" tick={{ fontSize:12, fill:'var(--text-2)' }} axisLine={false} tickLine={false} />
                  <Tooltip cursor={{ fill:'var(--accent-soft)' }}
                    contentStyle={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius-sm)', fontSize:13, direction:'rtl' }}
                    labelStyle={{ color:'var(--text-2)' }}
                    formatter={(v, n) => [W(v), n === 'present' ? 'حاضر' : 'غائب']} />
                  <Bar dataKey="present" name="present" fill={isLight ? '#3b82f6' : 'var(--accent)'} radius={[3,3,0,0]} isAnimationActive={false} />
                  <Bar dataKey="absent"  name="absent"  fill={isLight ? '#e11d48' : 'var(--status-absent)'} radius={[3,3,0,0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>

          {/* Card 2: Device Status — min-height keeps its designed proportion
              even with a single device (a maxHeight alone would collapse to
              fit just the content); the max-height cap is the "only when
              necessary" case — it exists to stop the card growing unbounded
              if many devices are ever added, not to force a Windows number. */}
          <Card padding="md" style={{ overflow:'hidden', borderRadius:12 }} header={
            <>
              <span className="panel-title" style={{ fontSize:16 }}>حالة الجهاز</span>
              <span style={{ fontSize:13, fontWeight:700, padding:'var(--space-1) var(--space-2)', borderRadius:'var(--radius-full)', background:'var(--accent-soft)', color:'var(--accent)' }}>
                {W(data?.devices?.online ?? 0)} / {W(data?.devices?.total ?? 0)} متصل
              </span>
            </>
          }>
            <div style={{ minHeight:70, maxHeight:160, overflow:'auto' }}>
              <DeviceStatusCompact devices={devices} liveSyncing={liveSyncing} />
            </div>
          </Card>

          {/* Card 3: Device Monitoring — same min/max-height rationale as Card 2 */}
          <Card padding="none" style={{ overflow:'hidden', borderRadius:12 }} header={
            <>
              <span className="panel-title" style={{ fontSize:16 }}>مراقبة الأجهزة</span>
              <button onClick={() => navigate('/devices')}
                style={{ display:'flex', alignItems:'center', gap:'var(--space-1)', fontSize:13, fontWeight:600, color:'var(--accent)', background:'none', border:'none', cursor:'pointer' }}>
                عرض الكل <ArrowRight className="w-4 h-4" />
              </button>
            </>
          }>
            <div style={{ minHeight:132, maxHeight:220, overflow:'auto' }}>
              <DeviceMonitoringTable devices={devices} />
            </div>
          </Card>
        </div>

        {/* Center + right-inside region — stretched to the full row height */}
        <div style={{ display:'grid', gridTemplateColumns:'minmax(0,2.2fr) minmax(0,1fr)', gridTemplateRows:'1fr', gap:GAP, minHeight:0 }}>

          {/* Center: Today's Employee Alerts — fills the remaining height naturally */}
          <Card padding="none" style={{ overflow:'hidden', borderRadius:12, display:'flex', flexDirection:'column', minHeight:0 }}
            contentStyle={{ flex:1, display:'flex', flexDirection:'column', minHeight:0, padding:0 }}
            header={
            <>
              <span className="panel-title" style={{ fontSize:16 }}>
                تنبيهات الموظفين اليوم
                {deptFilter && <span style={{ fontSize:13, fontWeight:600, color:'var(--accent)', marginRight:6 }}>
                  — {departments.find(d => String(d.id) === deptFilter)?.name}
                </span>}
              </span>
              <button onClick={() => navigate('/attendance/daily')}
                style={{ display:'flex', alignItems:'center', gap:'var(--space-1)', fontSize:13, fontWeight:600, color:'var(--accent)', background:'none', border:'none', cursor:'pointer' }}>
                عرض الكل <ArrowRight className="w-4 h-4" />
              </button>
            </>
          }>
            <div style={{ flex:1, overflow:'auto', minHeight:0 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width:36 }}>#</th>
                    <th>الموظف</th>
                    <th>القسم</th>
                    <th style={{ width:80 }}>الحضور</th>
                    <th style={{ width:74 }}>التأخير</th>
                    <th style={{ width:74 }}>الإضافي</th>
                    <th style={{ width:78 }}>الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.length === 0 ? (
                    <tr><td colSpan={7} style={{ textAlign:'center', padding:'34px 0', color:'var(--text-3)' }}>
                      لا توجد تنبيهات — جميع الموظفين منتظمون اليوم
                    </td></tr>
                  ) : alerts.map((r, i) => (
                    <tr key={r.id || i} className={r.isAbsent ? 'row-absent' : (r.effectiveLatePenalty||0)>0 ? 'row-late' : 'row-overtime'}>
                      <td className="num" style={{ color:'var(--text-3)' }}>{W(i+1)}</td>
                      <td style={{ fontWeight:700, color: r.isAbsent ? 'var(--row-absent-name)' : 'var(--c-name)' }}>{r.employeeName}</td>
                      <td style={{ color:'var(--text-2)' }}>{r.department || '—'}</td>
                      <td className="num" style={{ color:'var(--c-time)' }}>{r.checkIn ? fmtTime(r.checkIn) : '—'}</td>
                      <td className="num" style={{ color:(r.effectiveLatePenalty||0)>0?'var(--c-penalty)':'var(--c-muted)' }}>{fmtPenaltyUnits(r.effectiveLatePenalty)}</td>
                      <td className="num" style={{ color:(r.effectiveOvertimeUnits||0)>0?'var(--c-ot)':'var(--c-muted)' }}>{fmtOvertimeUnits(r.effectiveOvertimeUnits)}</td>
                      <td><StatusPill value={r.isAbsent ? 'absent' : r.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Right-inside column: Fingerprint Statistics (natural, content-sized
              height via flexShrink:0 — no hardcoded number) + Latest 10
              Fingerprints (flex:1 fills whatever height remains) */}
          <div style={{ display:'flex', flexDirection:'column', gap:GAP, minWidth:0, minHeight:0 }}>
            <Card padding="md" style={{ overflow:'hidden', borderRadius:12, flexShrink:0 }} header={<span className="panel-title" style={{ fontSize:16 }}>إحصائيات البصمات</span>}>
              <FingerprintStatsGrid
                totalLogs={deviceTotalLogs}
                importedToday={deviceImportedToday}
                failedToday={deviceFailedToday}
              />
            </Card>

            <Card padding="none" style={{ overflow:'hidden', borderRadius:12, display:'flex', flexDirection:'column', flex:1, minHeight:0 }}
              contentStyle={{ flex:1, display:'flex', flexDirection:'column', minHeight:0, padding:0 }}
              header={<span className="panel-title" style={{ fontSize:16 }}>أحدث 10 بصمات</span>}>
              <div style={{ flex:1, overflow:'auto', minHeight:0 }}>
                <LatestFingerprintsTable events={deviceMonitoringEvents} />
              </div>
            </Card>
          </div>
        </div>
      </div>
      </div>

      {/* Print Preview Modal */}
      <PrintPreviewModal
        isOpen={printOpen}
        onClose={() => setPrintOpen(false)}
        data={printData}
        reportType={printType}
        title={
          printType === 'attendance_daily_absent' ? 'تقرير الغياب اليومي' :
          printType === 'attendance_daily_late'   ? 'تقرير المتأخرين اليومي' :
          'تقرير الحضور اليومي'
        }
        meta={printMeta}
        orientation="portrait"
      />
    </div>
  );
}
