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
import { isManager } from '../lib/edition';

// ─── Navigation tree ──────────────────────────────────────────────────────────
// EP-011: `serverOnly: true` marks an item as server-admin functionality that
// doesn't belong on a Manager Client — device *configuration* (only the
// Server machine's zktecoService.js can reach a device's LAN segment), and
// the Connection Settings page (Manager's connection is set once via the
// mandatory ConnectionWizard on first run, not an optional settings toggle
// alongside "spawn a local backend"). Filtered out below, per edition.
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
    { to: '/devices',          icon: Fingerprint,    label: 'أجهزة البصمة', badge: 'ZK', serverOnly: true },
    { to: '/holidays',         icon: BookOpen,       label: 'الإجازات'  },
  ]},
  { id: 'policies', label: 'السياسات والإعدادات', items: [
    { to: '/attendance/settings', icon: SlidersHorizontal, label: 'إعدادات الحضور' },
    { to: '/rules',               icon: ShieldCheck,       label: 'محرك القواعد', badge: 'ERP' },
    { to: '/maintenance/cleanup', icon: Trash2,            label: 'تنظيف الحركات', badge: 'ERP' },
    { to: '/settings/company',    icon: Building2,         label: 'بيانات الشركة' },
    { to: '/settings/connection', icon: PlugZap,           label: 'إعدادات الاتصال', badge: 'ERP', serverOnly: true },
    { to: '/settings',            icon: Settings,          label: 'الإعدادات' },
  ]},
]
  .map((group) => ({ ...group, items: group.items.filter((item) => !item.serverOnly || !isManager) }))
  .filter((group) => group.items.length > 0);

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
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md font-semibold transition-colors"
            style={{ fontSize:14, background: active ? 'var(--accent-2)' : 'transparent', color: btnColor }}>
            <Icon style={{ width:16, height:16 }} />
            <span className="hidden lg:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Sidebar nav link ────────────────────────────────────────────────────────
function SideLink({ item, collapsed }) {
  const [hovered, setHovered] = useState(false);
  const { isLight } = useTheme();
  return (
    <NavLink to={item.to} title={collapsed ? item.label : undefined}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={({ isActive }) => (isLight ? {
        /* ── Light theme: restored to the original PETSHROW sidebar identity
           (always-dark-navy chrome, blue glow accent) — independent of the
           tokenized dark-theme styling below. ── */
        position: 'relative', display: 'flex', alignItems: 'center', gap: 10,
        padding: collapsed ? '8px 0' : '8px 12px', borderRadius: 7, marginBottom: 2,
        fontWeight: isActive ? 800 : 500, fontSize: 13.5,
        transition: 'background 0.15s, color 0.15s',
        background: isActive ? 'rgba(59,130,246,0.28)' : hovered ? 'rgba(255,255,255,0.07)' : 'transparent',
        color: isActive ? '#dbeafe' : 'rgba(226,232,240,0.72)',
        justifyContent: collapsed ? 'center' : 'flex-start',
        textDecoration: 'none',
        letterSpacing: isActive ? '-0.01em' : 'normal',
      } : {
        position: 'relative', display: 'flex', alignItems: 'center', gap: 10,
        padding: collapsed ? '9px 0' : '8px 12px', borderRadius: 8, marginBottom: 2,
        fontWeight: isActive ? 700 : 500, fontSize: 13.5,
        transition: 'background var(--motion-fast) cubic-bezier(.2,0,0,1), color var(--motion-fast) cubic-bezier(.2,0,0,1)',
        background: isActive ? 'var(--sidebar-surface-active)' : hovered ? 'var(--sidebar-surface-hover)' : 'transparent',
        color: isActive ? 'var(--sidebar-text-primary)' : 'var(--sidebar-text-secondary)',
        justifyContent: collapsed ? 'center' : 'flex-start',
        textDecoration: 'none',
        letterSpacing: isActive ? '-0.01em' : 'normal',
      })}>
      {({ isActive }) => (
        <>
          {/* Active accent bar — right side in RTL */}
          {isActive && (
            <span style={isLight ? {
              position:'absolute', right:0, top:4, bottom:4, width:4,
              borderRadius:'2px 0 0 2px', background:'#60a5fa',
              boxShadow:'0 0 12px rgba(96,165,250,0.7)',
            } : {
              position:'absolute', right:-1, top:5, bottom:5, width:2,
              borderRadius:'2px 0 0 2px', background:'var(--sidebar-accent)',
            }} />
          )}
          <item.icon style={isLight ? {
            width:16, height:16, flexShrink:0,
            color: isActive ? '#93c5fd' : 'rgba(226,232,240,0.55)',
            filter: isActive ? 'drop-shadow(0 0 5px rgba(96,165,250,0.55))' : 'none',
          } : {
            width:16, height:16, flexShrink:0,
            color: isActive ? 'var(--sidebar-icon-active)' : hovered ? 'var(--sidebar-text-primary)' : 'var(--sidebar-icon)',
          }} />
          {!collapsed && (
            <span style={{ flex:1, display:'flex', alignItems:'center', gap:6, minWidth:0 }}>
              <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.label}</span>
              {item.badge && (
                <span style={isLight ? {
                  fontSize:9, fontWeight:800, padding:'1px 5px', borderRadius:4, lineHeight:'15px', flexShrink:0,
                  background: item.badge === 'ERP' ? '#6d28d9' : item.badge === 'ZK' ? '#0891b2' : '#059669',
                  color:'#fff',
                } : {
                  fontSize:9, fontWeight:800, padding:'1px 5px', borderRadius:4, lineHeight:'15px', flexShrink:0,
                  background: item.badge === 'ERP' ? 'rgba(165,148,249,0.20)' : item.badge === 'ZK' ? 'rgba(88,166,255,0.20)' : 'rgba(63,185,80,0.20)',
                  color: item.badge === 'ERP' ? '#C7BBFF' : item.badge === 'ZK' ? '#93C5FD' : '#6EE096',
                  border: '1px solid ' + (item.badge === 'ERP' ? 'rgba(165,148,249,0.35)' : item.badge === 'ZK' ? 'rgba(88,166,255,0.35)' : 'rgba(63,185,80,0.35)'),
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

      {/* ═══ Sidebar — restored original PETSHROW Light Theme identity: the
          sidebar was always dark-navy chrome regardless of app theme; the
          Dark Theme keeps its current tokenized styling untouched. ═══ */}
      <aside style={{
        width: collapsed ? '58px' : '212px',
        background: isLight ? '#0b1220' : 'var(--sidebar-background)',
        borderLeft: '1px solid ' + (isLight ? 'rgba(255,255,255,0.06)' : 'var(--sidebar-border)'),
        transition: 'width 0.2s cubic-bezier(0.4,0,0.2,1)',
        flexShrink: 0, display: 'flex', flexDirection: 'column',
      }}>
        {/* Logo — premium branding area: larger identity tile, clearer name/
            tagline hierarchy, a soft brand-tinted backdrop behind the tile
            instead of a flat cell, so the company mark reads as the header
            of the whole sidebar rather than just another nav row. */}
        <div style={{
          display:'flex', alignItems:'center', gap:11, padding: collapsed ? '16px 0' : '18px 14px',
          borderBottom:'1px solid ' + (isLight ? 'rgba(255,255,255,0.06)' : 'var(--sidebar-border)'), flexShrink:0,
          justifyContent: collapsed ? 'center' : 'flex-start',
          background: isLight ? 'linear-gradient(180deg,rgba(59,130,246,0.07),transparent)' : 'linear-gradient(180deg,rgba(47,129,247,0.08),transparent)',
        }}>
          <div style={{
            width:40, height:40, borderRadius:11, flexShrink:0, overflow:'hidden',
            background: brand.logoUrl ? 'rgba(255,255,255,0.04)' : (isLight ? 'linear-gradient(135deg,#3b82f6 0%,#1d4ed8 100%)' : 'linear-gradient(135deg,#2F81F7 0%,#1F6FEB 100%)'),
            display:'flex', alignItems:'center', justifyContent:'center',
            fontWeight:900, fontSize:21, color:'#fff', fontFamily:'Cairo,sans-serif',
            boxShadow: brand.logoUrl ? '0 2px 12px rgba(0,0,0,0.25)' : '0 2px 12px rgba(37,99,235,0.45)',
            border: brand.logoUrl ? '1px solid rgba(255,255,255,0.08)' : 'none',
          }}>
            {brand.logoUrl
              ? <img src={brand.logoUrl} alt={brand.name} style={{ width:'100%', height:'100%', objectFit:'contain' }} />
              : brand.mark}
          </div>
          {!collapsed && (
            <div style={{ lineHeight:1.25, minWidth:0 }}>
              <p style={{ color: isLight ? '#fff' : 'var(--sidebar-text-primary)', fontWeight:800, fontSize:16, letterSpacing:'0.04em', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{brand.name}</p>
              <p style={{ color: isLight ? 'rgba(148,163,184,0.75)' : 'var(--sidebar-text-muted)', fontSize:10.5, marginTop:1, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', direction:'ltr', textAlign:'left' }}>{brand.taglineEn}</p>
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav style={{ flex:1, overflowY:'auto', padding:'8px 8px', scrollbarWidth:'thin' }}>
          {NAV.map(group => (
            <div key={group.id} style={{ marginBottom:14 }}>
              {!collapsed && (
                <p style={isLight ? {
                  padding:'0 11px', marginBottom:5, fontSize:9.5, fontWeight:700, letterSpacing:'0.09em', textTransform:'uppercase',
                  color:'rgba(148,163,184,0.55)', borderTop:'1px solid rgba(255,255,255,0.04)', paddingTop:10, marginTop:2,
                } : {
                  padding:'0 11px', marginBottom:6, fontSize:9.5, fontWeight:700, letterSpacing:'0.09em', textTransform:'uppercase',
                  color:'var(--sidebar-text-muted)', borderTop:'1px solid var(--sidebar-border)', paddingTop:12, marginTop:4,
                }}>
                  {group.label}
                </p>
              )}
              {group.items.map(item => <SideLink key={item.to} item={item} collapsed={collapsed} />)}
            </div>
          ))}
        </nav>

        {/* Footer */}
        {!collapsed && (
          <div style={{ padding:'9px 14px', borderTop:'1px solid ' + (isLight ? 'rgba(255,255,255,0.05)' : 'var(--sidebar-border)'), flexShrink:0 }}>
            <p style={{ textAlign:'center', fontSize:9.5, color: isLight ? 'rgba(148,163,184,0.4)' : 'var(--sidebar-text-muted)', letterSpacing:'0.03em' }}>
              {brand.product} · v{brand.version}
            </p>
            {brand.buildMarker && (
              <p style={{ textAlign:'center', fontSize:8.5, color: isLight ? 'rgba(148,163,184,0.28)' : 'rgba(154,169,196,0.35)', letterSpacing:'0.03em', marginTop:2 }}>
                {brand.buildMarker}
              </p>
            )}
          </div>
        )}
      </aside>

      {/* ═══ Main ═══ */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>

        {/* Topbar — sized by min-height + padding, not a hard pixel height, so
            it settles near the enterprise ~72px target on typical desktop
            windows (Windows 10/11, macOS) without a Windows-specific
            magic number; content/OS font metrics can grow it further. */}
        <header style={{
          minHeight:64, display:'flex', alignItems:'center', justifyContent:'space-between',
          padding:'14px 22px', flexShrink:0, background:'var(--surface)',
          borderBottom:'1px solid var(--border)',
        }}>
          <div style={{ display:'flex', alignItems:'center', gap:14 }}>
            <button onClick={() => setCollapsed(!collapsed)}
              style={{ padding:9, borderRadius:8, border:'1px solid var(--border)', cursor:'pointer', background:'var(--surface-2)', color:'var(--text-2)', display:'flex' }}>
              {collapsed ? <ChevronRight style={{ width:18, height:18 }} /> : <PanelLeftClose style={{ width:18, height:18 }} />}
            </button>
            <span style={{ fontSize:15, color:'var(--text-2)', fontWeight:500 }}>
              {new Date().toLocaleDateString('ar-EG', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}
            </span>
          </div>

          <div style={{ display:'flex', alignItems:'center', gap:14 }}>
            <ThemeSwitcher />
            <div style={{ display:'flex', alignItems:'center', gap:7, padding:'8px 14px', borderRadius:8, fontSize:14, fontWeight:700,
              background: isLight ? 'rgba(5,150,105,0.09)' : 'rgba(16,185,129,0.10)',
              border: isLight ? '1px solid rgba(5,150,105,0.30)' : '1px solid rgba(16,185,129,0.25)',
              color: isLight ? '#065f46' : '#10b981' }}>
              <span style={{ width:8, height:8, borderRadius:'50%', background: isLight ? '#059669' : '#10b981', boxShadow:'0 0 5px rgba(16,185,129,0.6)', flexShrink:0 }} />
              النظام يعمل
            </div>
          </div>
        </header>

        {/* Company data fetch failed (server/auth error) — must read as a
            connection problem, never be mistaken for genuine first-run. */}
        {brand.fetchError && (
          <div style={{ padding:'8px 16px', background:'rgba(220,38,38,0.10)', borderBottom:'1px solid rgba(220,38,38,0.28)', display:'flex', alignItems:'center', gap:10, flexShrink:0 }}>
            <span style={{ fontSize:13, color:'#991b1b', fontWeight:600, flex:1 }}>
              ⚠ تعذر تحميل بيانات الشركة من الخادم — تحقق من الاتصال بالخادم المركزي.
            </span>
          </div>
        )}

        {/* First-run: no company configured (only when the API call itself
            succeeded and genuinely returned an empty company). */}
        {!brand.fetchError && brand.address === '' && brand.phone === '' && brand.nameAr === 'PETSHROW' && (
          <div style={{ padding:'8px 16px', background:'rgba(245,158,11,0.10)', borderBottom:'1px solid rgba(245,158,11,0.28)', display:'flex', alignItems:'center', gap:10, flexShrink:0 }}>
            <span style={{ fontSize:13, color:'#92400e', fontWeight:600, flex:1 }}>
              ⚠ لم يتم إعداد بيانات الشركة بعد — يرجى إعداد الشركة قبل استخدام النظام.
            </span>
            <a href="#/settings/company" style={{ fontSize:12, fontWeight:700, color: isLight ? '#1d4ed8' : '#1F6FEB', textDecoration:'none', background:'rgba(29,78,216,0.08)', padding:'4px 10px', borderRadius:5, border:'1px solid rgba(29,78,216,0.2)' }}>
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
