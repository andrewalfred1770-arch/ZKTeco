import React, { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, AlertTriangle, Wifi, ArrowRight, Printer, Users, UserX, Clock } from 'lucide-react';
import { BarChart, Bar, XAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useNavigate } from 'react-router-dom';
import api, { LONG_OP } from '../lib/api';
import toast from 'react-hot-toast';
import { westernDigits, fmtTime, fmtPenaltyUnits, fmtOvertimeUnits, STATUS_LABELS } from '../lib/formatters';
import { useTheme } from '../contexts/ThemeContext';
import { useRulesLiveSync } from '../hooks/useRulesLiveSync';
import { useDeviceLiveSync } from '../hooks/useDeviceLiveSync';
import PrintPreviewModal from '../components/PrintPreviewModal';
import { useCompanyBrand } from '../lib/branding';

const W = (v) => westernDigits(String(v ?? 0));
const DAY_AR = { Mon:'إثنين', Tue:'ثلاثاء', Wed:'أربعاء', Thu:'خميس', Fri:'جمعة', Sat:'سبت', Sun:'أحد' };

function Metric({ label, value, sub, accent, color }) {
  return (
    <div className="metric" style={{ '--m-accent': accent, '--m-color': color, flex:1 }}>
      <span className="metric-label">{label}</span>
      <span className="metric-value">{W(value)}</span>
      {sub && <span className="metric-sub">{sub}</span>}
    </div>
  );
}

function StatusPill({ value }) {
  const s = STATUS_LABELS[value];
  if (!s) return <span style={{ color:'var(--c-muted)' }}>—</span>;
  return (
    <span style={{ display:'inline-flex', padding:'1px 8px', borderRadius:4, fontSize:11, fontWeight:700,
      color:s.color, background:s.bg, border:`1px solid ${s.color}40` }}>{s.ar}</span>
  );
}

export default function DashboardPage() {
  const { isLight } = useTheme();
  const navigate = useNavigate();
  const brand = useCompanyBrand();

  const [data,        setData]        = useState(null);
  const [devices,     setDevices]     = useState([]);
  const [roster,      setRoster]      = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [syncing,     setSyncing]     = useState(false);

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
      const [d, dv, ros, depts] = await Promise.all([
        api.get('/dashboard'),
        api.get('/devices'),
        api.get('/attendance/daily', { params: { date: today } }).catch(() => ({ data: [] })),
        api.get('/departments').catch(() => ({ data: [] })),
      ]);
      setData(d.data);
      setDevices(dv.data);
      setRoster(ros.data || []);
      setDepartments(depts.data || []);
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

  const metrics = deptFilter ? [
    { label:'الموظفون',    value:filteredRoster.length,       accent:'#3b82f6', color:'var(--text)' },
    { label:'حضور اليوم', value:deptPresent,                 accent:'#10b981', color:'#10b981' },
    { label:'الغياب',      value:deptAbsent,                  accent:'#ef4444', color:'#ef4444' },
    { label:'المتأخرون',   value:deptLate,                    accent:'#f59e0b', color:'#f59e0b' },
    { label:'الإضافي',     value:deptOT,                      accent:'#8b5cf6', color:'#8b5cf6' },
    { label:'نسبة الحضور', value:`${W(filteredRoster.length ? Math.round(deptPresent/filteredRoster.length*100) : 0)}%`, accent:'#0ea5e9', color:'#0ea5e9' },
  ] : [
    { label:'إجمالي الموظفين', value:total,          accent:'#3b82f6', color:'var(--text)' },
    { label:'حضور اليوم',      value:present,         accent:'#10b981', color:'#10b981', sub:`${W(data?.onTime ?? 0)} في الوقت` },
    { label:'الغياب',          value:data?.absent,    accent:'#ef4444', color:'#ef4444' },
    { label:'المتأخرون',        value:data?.late,      accent:'#f59e0b', color:'#f59e0b' },
    { label:'الإضافي',          value:data?.overtime,  accent:'#8b5cf6', color:'#8b5cf6', sub:'موظف' },
    { label:'نسبة الحضور',      value:`${W(rate)}%`,   accent:'#0ea5e9', color:'#0ea5e9' },
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

  const PRINT_BTN = { display:'flex', alignItems:'center', gap:5, fontSize:11, fontWeight:700, cursor:'pointer', padding:'5px 10px', borderRadius:7, border:'none' };

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
      <div style={{ position:'relative', zIndex:1, display:'flex', flexDirection:'column', gap:'var(--gap)', direction:'rtl', flex:1, overflowY:'auto', minHeight:0 }}>

      {/* Header */}
      <div className="page-header" style={{ marginBottom:0 }}>
        <div>
          <h1 className="page-title">لوحة التحكم</h1>
          <p style={{ fontSize:12, color:'var(--text-3)', marginTop:2 }}>
            {todayAr} · متابعة فورية
          </p>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
          {/* Print buttons */}
          <button onClick={() => openPrint('attendance_dashboard')}
            style={{ ...PRINT_BTN, background:'rgba(16,185,129,0.12)', color:'#10b981', border:'1px solid rgba(16,185,129,0.3)' }}>
            <Printer style={{ width:13, height:13 }} /> طباعة الحضور
          </button>
          <button onClick={() => openPrint('attendance_daily_absent')}
            style={{ ...PRINT_BTN, background:'rgba(239,68,68,0.12)', color:'#ef4444', border:'1px solid rgba(239,68,68,0.3)' }}>
            <UserX style={{ width:13, height:13 }} /> طباعة الغياب
          </button>
          <button onClick={() => openPrint('attendance_daily_late')}
            style={{ ...PRINT_BTN, background:'rgba(245,158,11,0.12)', color:'#f59e0b', border:'1px solid rgba(245,158,11,0.3)' }}>
            <Clock style={{ width:13, height:13 }} /> طباعة المتأخرين
          </button>
          <button onClick={syncAll} disabled={syncing} className="btn-primary text-xs py-1.5 px-3.5">
            <RefreshCw className="w-3.5 h-3.5" style={{ animation: syncing ? 'spin 1s linear infinite' : 'none' }} />
            {syncing ? 'جاري المزامنة...' : 'مزامنة الأجهزة'}
          </button>
        </div>
      </div>

      {/* Filters bar: date label + dept + branch */}
      <div className="card p-2.5" style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
        <span style={{ fontSize:12, fontWeight:600, color:'var(--text-2)', paddingRight:4 }}>
          {today}
        </span>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <label style={{ fontSize:12, color:'var(--text-3)', whiteSpace:'nowrap' }}>القسم</label>
          <select
            className="input text-xs py-1 w-40"
            value={deptFilter}
            onChange={e => setDeptFilter(e.target.value)}
          >
            <option value="">كل الأقسام</option>
            {departments.map(d => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
        {deptFilter && (
          <button
            onClick={() => setDeptFilter('')}
            style={{ fontSize:11, color:'var(--accent)', background:'none', border:'none', cursor:'pointer', padding:'2px 6px' }}
          >
            × مسح الفلتر
          </button>
        )}
        <span style={{ fontSize:11, color:'var(--text-3)', marginRight:'auto' }}>
          {filteredRoster.length > 0 && `${W(filteredRoster.length)} موظف`}
        </span>
      </div>

      {/* Metric strip */}
      <div className="card" style={{ display:'flex', flexWrap:'wrap', padding:0, overflow:'hidden' }}>
        {metrics.map((m, i) => (
          <div key={m.label} style={{ flex:'1 1 150px', borderRight: i ? '1px solid var(--border)' : 'none' }}>
            <Metric {...m} />
          </div>
        ))}
      </div>

      {/* Body grid */}
      <div style={{ display:'grid', gridTemplateColumns:'minmax(0,1.6fr) minmax(0,1fr)', gap:'var(--gap)', alignItems:'start' }}>

        {/* Alerts table */}
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">
              تنبيهات الموظفين اليوم
              {deptFilter && <span style={{ fontSize:11, fontWeight:600, color:'var(--accent)', marginRight:6 }}>
                — {departments.find(d => String(d.id) === deptFilter)?.name}
              </span>}
            </span>
            <button onClick={() => navigate('/attendance/daily')}
              style={{ display:'flex', alignItems:'center', gap:4, fontSize:11, fontWeight:600, color:'var(--accent)', background:'none', border:'none', cursor:'pointer' }}>
              عرض الكل <ArrowRight style={{ width:12, height:12 }} />
            </button>
          </div>
          <div style={{ maxHeight:420, overflow:'auto' }}>
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
        </div>

        {/* Right column */}
        <div style={{ display:'flex', flexDirection:'column', gap:'var(--gap)' }}>

          {/* Weekly compact bar */}
          <div className="panel">
            <div className="panel-head"><span className="panel-title">الحضور — آخر 7 أيام</span></div>
            <div style={{ padding:'10px 8px 4px' }}>
              <ResponsiveContainer width="100%" height={132}>
                <BarChart data={weeklyData} barGap={3} barCategoryGap="32%">
                  <XAxis dataKey="day" tick={{ fontSize:10.5, fill:'var(--text-2)' }} axisLine={false} tickLine={false} />
                  <Tooltip cursor={{ fill:'var(--accent-soft)' }}
                    contentStyle={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:6, fontSize:11, direction:'rtl' }}
                    labelStyle={{ color:'var(--text-2)' }}
                    formatter={(v, n) => [W(v), n === 'present' ? 'حاضر' : 'غائب']} />
                  <Bar dataKey="present" name="present" fill="#3b82f6" radius={[3,3,0,0]} isAnimationActive={false} />
                  <Bar dataKey="absent"  name="absent"  fill={isLight ? '#e11d48' : '#f43f5e'} radius={[3,3,0,0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Devices table */}
          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">حالة الأجهزة</span>
              <span style={{ fontSize:11, fontWeight:700, padding:'1px 8px', borderRadius:99, background:'var(--accent-soft)', color:'var(--accent)' }}>
                {W(data?.devices?.online ?? 0)} / {W(data?.devices?.total ?? 0)} متصل
              </span>
            </div>
            <div style={{ maxHeight:230, overflow:'auto' }}>
              {devices.length === 0 ? (
                <div style={{ textAlign:'center', padding:'26px 0', color:'var(--text-3)' }}>
                  <Wifi style={{ width:26, height:26, margin:'0 auto 6px', color:'var(--text-3)' }} />
                  <p style={{ fontSize:12 }}>لا توجد أجهزة مضافة</p>
                </div>
              ) : (
                <table className="data-table">
                  <thead><tr><th>الجهاز</th><th>IP</th><th style={{ width:70 }}>الحالة</th></tr></thead>
                  <tbody>
                    {devices.map(d => {
                      const online = d.status === 'online';
                      return (
                        <tr key={d.id}>
                          <td style={{ fontWeight:600 }}>
                            <span style={{ display:'inline-block', width:7, height:7, borderRadius:'50%', marginLeft:6, background: online?'#10b981':'#64748b' }} />
                            {d.name}
                          </td>
                          <td className="num" style={{ color:'var(--text-2)' }}>{d.ipAddress}:{d.port}</td>
                          <td><span className={online ? 'badge badge-green' : 'badge badge-gray'}>{online ? 'متصل' : 'غير متصل'}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
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
