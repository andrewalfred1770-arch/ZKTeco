import React, { useState } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Users, CalendarDays, CalendarRange,
  DollarSign, Settings, FileText, BookOpen, Building2,
  ChevronRight, PanelLeftClose, ShieldCheck, UserSquare2,
  Sun, Moon, Monitor as MonitorIcon, Fingerprint, Trash2, SlidersHorizontal,
  PlugZap,
} from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';
import { useCompanyBrand } from '../lib/branding';

// ─── Navigation tree ──────────────────────────────────────────────────────────
const NAV = [
  { id: 'overview', label: 'عام', items: [
    { to: '/dashboard', icon: LayoutDashboard, label: 'الرئيسية' },
  ]},
  { id: 'attendance', label: 'الحضور', items: [
    { to: '/attendance/daily',       icon: CalendarDays,  label: 'الحضور اليومي'  },
    { to: '/attendance/monthly',     icon: CalendarRange, label: 'التقرير الشهري' },
    { to: '/attendance/movement',    icon: UserSquare2,   label: 'حركة الموظف' },
    { to: '/attendance/logs',        icon: FileText,      label: 'السجلات الخام' },
  ]},
  { id: 'payroll', label: 'الرواتب', items: [
    { to: '/payroll', icon: DollarSign, label: 'المرتبات' },
  ]},
  { id: 'admin', label: 'الإدارة', items: [
    { to: '/employees',        icon: Users,          label: 'الموظفين'  },
    { to: '/devices',          icon: Fingerprint,    label: 'أجهزة البصمة', badge: 'ZK' },
    { to: '/holidays',         icon: BookOpen,       label: 'الإجازات'  },
  ]},
  { id: 'policies', label: 'السياسات والإعدادات', items: [
    { to: '/attendance/settings', icon: SlidersHorizontal, label: 'إعدادات الحضور' },
    { to: '/rules',               icon: ShieldCheck,       label: 'محرك القواعد', badge: 'ERP' },
    { to: '/maintenance/cleanup', icon: Trash2,            label: 'تنظيف الحركات', badge: 'ERP' },
    { to: '/settings/company',    icon: Building2,         label: 'بيانات الشركة' },
    { to: '/settings/connection', icon: PlugZap,           label: 'إعدادات الاتصال', badge: 'ERP' },
    { to: '/settings',            icon: Settings,          label: 'الإعدادات' },
  ]},
];

// ─── Theme switcher ───────────────────────────────────────────────────────────
function ThemeSwitcher() {
  const { theme, setTheme, isLight } = useTheme();
  const options = [
    { id: 'light',  icon: Sun,         label: 'فاتح'   },
    { id: 'dark',   icon: Moon,        label: 'داكن'   },
    { id: 'system', icon: MonitorIcon, label: 'تلقائي' },
  ];
  const containerStyle = isLight
    ? { background: '#f1f5f9', border: '1px solid #b8c6db', borderRadius: 8 }
    : { background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8 };
  return (
    <div className="flex items-center rounded-lg overflow-hidden gap-px p-0.5" style={containerStyle}>
      {options.map(({ id, icon: Icon, label }) => {
        const active = theme === id;
        const btnColor = active
          ? '#fff'
          : isLight ? '#1e3a5f' : 'rgba(255,255,255,0.65)';
        return (
          <button key={id} onClick={() => setTheme(id)} title={label}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md font-semibold transition-colors"
            style={{ fontSize:12.5, background: active ? 'var(--accent-2)' : 'transparent', color: btnColor }}>
            <Icon style={{ width:14, height:14 }} />
            <span className="hidden lg:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Sidebar nav link ────────────────────────────────────────────────────────
function SideLink({ item, collapsed }) {
  return (
    <NavLink to={item.to} title={collapsed ? item.label : undefined}
      style={({ isActive }) => ({
        position: 'relative', display: 'flex', alignItems: 'center', gap: 10,
        padding: collapsed ? '8px 0' : '8px 12px', borderRadius: 7, marginBottom: 2,
        fontWeight: isActive ? 800 : 500, fontSize: 13.5,
        transition: 'background 0.15s, color 0.15s',
        background: isActive ? 'rgba(59,130,246,0.30)' : 'transparent',
        color: isActive ? '#dbeafe' : 'rgba(226,232,240,0.72)',
        justifyContent: collapsed ? 'center' : 'flex-start',
        textDecoration: 'none',
        letterSpacing: isActive ? '-0.01em' : 'normal',
      })}>
      {({ isActive }) => (
        <>
          {/* Active accent bar — right side in RTL, 4px with glow */}
          {isActive && (
            <span style={{
              position:'absolute', right:0, top:4, bottom:4, width:4,
              borderRadius:'2px 0 0 2px', background:'#60a5fa',
              boxShadow:'0 0 12px rgba(96,165,250,0.7)',
            }} />
          )}
          <item.icon style={{
            width:16, height:16, flexShrink:0,
            color: isActive ? '#93c5fd' : 'rgba(226,232,240,0.55)',
            filter: isActive ? 'drop-shadow(0 0 5px rgba(96,165,250,0.55))' : 'none',
          }} />
          {!collapsed && (
            <span style={{ flex:1, display:'flex', alignItems:'center', gap:6 }}>
              {item.label}
              {item.badge && (
                <span style={{
                  fontSize:9, fontWeight:800, padding:'1px 5px', borderRadius:4, lineHeight:'15px',
                  background: item.badge === 'ERP' ? '#6d28d9' : item.badge === 'ZK' ? '#0891b2' : '#059669',
                  color:'#fff',
                }}>{item.badge}</span>
              )}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

// ─── Main Layout ──────────────────────────────────────────────────────────────
export default function Layout() {
  const [collapsed, setCollapsed] = useState(false);
  const brand = useCompanyBrand();
  const { isLight } = useTheme();

  return (
    <div style={{ display:'flex', height:'100vh', overflow:'hidden', background:'var(--bg)' }} dir="rtl">

      {/* ═══ Sidebar ═══ */}
      <aside style={{
        width: collapsed ? '58px' : '212px', background: 'var(--sidebar)',
        borderLeft: '1px solid rgba(255,255,255,0.06)',
        transition: 'width 0.2s cubic-bezier(0.4,0,0.2,1)',
        flexShrink: 0, display: 'flex', flexDirection: 'column',
      }}>
        {/* Logo */}
        <div style={{
          display:'flex', alignItems:'center', gap:10, padding: collapsed ? '14px 0' : '14px 14px',
          borderBottom:'1px solid rgba(255,255,255,0.06)', flexShrink:0,
          justifyContent: collapsed ? 'center' : 'flex-start',
        }}>
          <div style={{
            width:34, height:34, borderRadius:9, flexShrink:0, overflow:'hidden',
            background: brand.logoUrl ? 'transparent' : 'linear-gradient(135deg,#3b82f6 0%,#1d4ed8 100%)',
            display:'flex', alignItems:'center', justifyContent:'center',
            fontWeight:900, fontSize:19, color:'#fff', fontFamily:'Cairo,sans-serif',
            boxShadow: brand.logoUrl ? 'none' : '0 2px 10px rgba(37,99,235,0.4)',
          }}>
            {brand.logoUrl
              ? <img src={brand.logoUrl} alt={brand.name} style={{ width:'100%', height:'100%', objectFit:'contain' }} />
              : brand.mark}
          </div>
          {!collapsed && (
            <div style={{ lineHeight:1.2 }}>
              <p style={{ color:'#fff', fontWeight:800, fontSize:15, letterSpacing:'0.06em' }}>{brand.name}</p>
              <p style={{ color:'rgba(148,163,184,0.7)', fontSize:10 }}>{brand.taglineEn}</p>
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav style={{ flex:1, overflowY:'auto', padding:'8px 8px', scrollbarWidth:'thin' }}>
          {NAV.map(group => (
            <div key={group.id} style={{ marginBottom:14 }}>
              {!collapsed && (
                <p style={{ padding:'0 11px', marginBottom:5, fontSize:9.5, fontWeight:700, letterSpacing:'0.09em', textTransform:'uppercase', color:'rgba(148,163,184,0.55)', borderTop:'1px solid rgba(255,255,255,0.04)', paddingTop:10, marginTop:2 }}>
                  {group.label}
                </p>
              )}
              {group.items.map(item => <SideLink key={item.to} item={item} collapsed={collapsed} />)}
            </div>
          ))}
        </nav>

        {/* Footer */}
        {!collapsed && (
          <div style={{ padding:'9px 14px', borderTop:'1px solid rgba(255,255,255,0.05)', flexShrink:0 }}>
            <p style={{ textAlign:'center', fontSize:9.5, color:'rgba(148,163,184,0.4)', letterSpacing:'0.03em' }}>
              {brand.product} · v{brand.version}
            </p>
            {brand.buildMarker && (
              <p style={{ textAlign:'center', fontSize:8.5, color:'rgba(148,163,184,0.28)', letterSpacing:'0.03em', marginTop:2 }}>
                {brand.buildMarker}
              </p>
            )}
          </div>
        )}
      </aside>

      {/* ═══ Main ═══ */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>

        {/* Topbar */}
        <header style={{
          height:48, display:'flex', alignItems:'center', justifyContent:'space-between',
          padding:'0 16px', flexShrink:0, background:'var(--surface)',
          borderBottom:'1px solid var(--border)',
        }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <button onClick={() => setCollapsed(!collapsed)}
              style={{ padding:6, borderRadius:6, border:'1px solid var(--border)', cursor:'pointer', background:'var(--surface-2)', color:'var(--text-2)', display:'flex' }}>
              {collapsed ? <ChevronRight style={{ width:16, height:16 }} /> : <PanelLeftClose style={{ width:16, height:16 }} />}
            </button>
            <span style={{ fontSize:13.5, color:'var(--text-2)', fontWeight:500 }}>
              {new Date().toLocaleDateString('ar-EG', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}
            </span>
          </div>

          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <ThemeSwitcher />
            <div style={{ display:'flex', alignItems:'center', gap:6, padding:'5px 11px', borderRadius:6, fontSize:12.5, fontWeight:700,
              background: isLight ? 'rgba(5,150,105,0.09)' : 'rgba(16,185,129,0.10)',
              border: isLight ? '1px solid rgba(5,150,105,0.30)' : '1px solid rgba(16,185,129,0.25)',
              color: isLight ? '#065f46' : '#10b981' }}>
              <span style={{ width:7, height:7, borderRadius:'50%', background: isLight ? '#059669' : '#10b981', boxShadow:'0 0 5px rgba(16,185,129,0.6)', flexShrink:0 }} />
              النظام يعمل
            </div>
          </div>
        </header>

        {/* First-run: no company configured */}
        {!brand.name || brand.name === 'PETSHROW' ? null : null}
        {brand.address === '' && brand.phone === '' && brand.nameAr === 'PETSHROW' && (
          <div style={{ padding:'8px 16px', background:'rgba(245,158,11,0.10)', borderBottom:'1px solid rgba(245,158,11,0.28)', display:'flex', alignItems:'center', gap:10, flexShrink:0 }}>
            <span style={{ fontSize:13, color:'#92400e', fontWeight:600, flex:1 }}>
              ⚠ لم يتم إعداد بيانات الشركة بعد — يرجى إعداد الشركة قبل استخدام النظام.
            </span>
            <a href="#/settings/company" style={{ fontSize:12, fontWeight:700, color:'#1d4ed8', textDecoration:'none', background:'rgba(29,78,216,0.08)', padding:'4px 10px', borderRadius:5, border:'1px solid rgba(29,78,216,0.2)' }}>
              فتح إعدادات الشركة
            </a>
          </div>
        )}

        {/* Page content — flex column so child pages can fill remaining height */}
        <main style={{
          flex: 1, minHeight: 0,
          overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
          padding: 'var(--pad-page)',
          background: 'var(--bg)',
        }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
