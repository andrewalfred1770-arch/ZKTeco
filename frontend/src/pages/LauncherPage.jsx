import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  Users, Fingerprint, CalendarCheck, CalendarRange, Wallet, BarChart3, Settings, Wrench,
} from 'lucide-react';
import '../styles/checkin-launcher.css';
import { CheckInLogo } from '../components/brand/CheckInLogo';
import LauncherHero from '../components/launcher/LauncherHero';
import { isManager } from '../lib/edition';
import { useTheme } from '../contexts/ThemeContext';
import BRAND from '../lib/branding';

// Every card is a plain link to an EXISTING route: the launcher adds a front door, it does not replace or hide any navigation.
// `serverOnly` follows the sidebar rule (device configuration is not offered on a Manager client).
export const LAUNCHER_MODULES = [
  { id: 'employees', to: '/employees',            icon: Users,         label: 'الموظفون',           hint: 'بيانات الموظفين والأقسام والورديات' },
  { id: 'devices',   to: '/devices',              icon: Fingerprint,   label: 'أجهزة البصمة',        hint: 'الأجهزة والمزامنة والحالة', serverOnly: true },
  { id: 'daily',     to: '/attendance/daily',     icon: CalendarCheck, label: 'الحضور والانصراف',    hint: 'السجل اليومي والتعديل اليدوي' },
  { id: 'monthly',   to: '/attendance/monthly',   icon: CalendarRange, label: 'الدوام الشهري',       hint: 'التقرير الشهري لكل موظف' },
  { id: 'payroll',   to: '/payroll',              icon: Wallet,        label: 'المرتبات',            hint: 'الرواتب والسلف والخصومات' },
  { id: 'reports',   to: '/dashboard',            icon: BarChart3,     label: 'التقارير',            hint: 'لوحة المؤشرات والطباعة والتصدير' },
  { id: 'settings',  to: '/settings',             icon: Settings,      label: 'الإعدادات',           hint: 'إعدادات النظام والشركة والقواعد' },
  { id: 'tools',     to: '/maintenance/cleanup',  icon: Wrench,        label: 'أدوات الصيانة',       hint: 'تنظيف الحركات وأدوات الإدارة' },
];

export function visibleLauncherModules(manager = isManager) {
  return LAUNCHER_MODULES.filter((m) => !m.serverOnly || !manager);
}

export default function LauncherPage() {
  const modules = visibleLauncherModules();
  const { isLight } = useTheme();   // the wordmark needs its dark-on-light colours on the light theme
  return (
    <div className="ci-stage ci-anim" dir="rtl" style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 'clamp(12px, 3vw, 28px)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'clamp(16px, 4vw, 40px)', marginBottom: 22 }}>
        <div style={{ flex: '1 1 280px', minWidth: 0 }}>
          <CheckInLogo height={44} animate onLight={isLight} />
          <div style={{ marginTop: 14, fontSize: 11.5, letterSpacing: '0.14em', color: 'var(--text-3)', direction: 'ltr', textAlign: 'start' }}>ATTENDANCE &amp; WORKFORCE MANAGEMENT</div>
          <h1 style={{ marginTop: 6, fontSize: 'var(--text-xl, 19px)', fontWeight: 700, color: 'var(--text)' }}>{BRAND.appNameAr}</h1>
          <p style={{ marginTop: 6, fontSize: 'var(--text-sm, 12.5px)', color: 'var(--text-3)', maxWidth: 420, lineHeight: 1.6 }}>
            اختر وحدة للبدء. القائمة الجانبية تبقى متاحة دائمًا لكل الصفحات.
          </p>
        </div>
        <div style={{ flex: '1 1 300px', display: 'flex', justifyContent: 'center' }}><LauncherHero /></div>
      </div>

      <nav aria-label="وحدات CheckIn" className="ci-grid">
        {modules.map((m, i) => {
          const Icon = m.icon;
          return (
            <NavLink key={m.id} to={m.to} className="ci-card" style={{ '--i': i }}>
              <span className="ci-card-icon"><Icon style={{ width: 20, height: 20 }} aria-hidden="true" /></span>
              <h3>{m.label}</h3>
              <p>{m.hint}</p>
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}
