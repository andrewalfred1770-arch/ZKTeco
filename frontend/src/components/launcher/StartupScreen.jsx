import React from 'react';
import '../../styles/checkin-launcher.css';
import { CheckInLogo } from '../brand/CheckInLogo';
import LauncherHero from './LauncherHero';
import { useStartupStatus } from '../../hooks/useStartupStatus';
import { deriveStages, STEP_IDS } from '../../lib/startupStages';
import BRAND from '../../lib/branding';

const LABELS = {
  server: 'الخادم يستجيب',
  database: 'قاعدة البيانات متصلة',
  services: 'الخدمات الخلفية بدأت',
};

/**
 * Full-screen startup / connection screen (replaces the plain spinner that ServerReadyGate showed).
 * Every claim comes from the backend's own /api/startup-status answer (see lib/startupStages.js). When nothing has been verified yet
 * the bar is an honest indeterminate animation, never a percentage. `status` is the gate's own state: 'checking' | 'unreachable'.
 */
export default function StartupScreen({ status = 'checking', onRetry }) {
  const snapshot = useStartupStatus(true);
  const st = deriveStages(snapshot);
  const firstPending = STEP_IDS.find((id) => !st.done[id]);

  return (
    <div className="ci-startup ci-anim" dir="rtl" role="status" aria-live="polite">
      <div className="ci-startup-head">
        <CheckInLogo height={34} plated />
        <div style={{ textAlign: 'end', lineHeight: 1.45 }}>
          <div style={{ fontSize: 10.5, letterSpacing: '0.14em', color: 'var(--ci-muted)', direction: 'ltr' }}>ATTENDANCE &amp; WORKFORCE MANAGEMENT</div>
          <div style={{ fontSize: 12.5, color: 'var(--ci-text-2)' }}>نظام إدارة الحضور والانصراف والموارد البشرية</div>
        </div>
      </div>

      <div className="ci-startup-body">
        <LauncherHero />

        <div className="ci-steps">
          {STEP_IDS.map((id) => (
            <div key={id} className={`ci-step ${st.done[id] ? 'is-done' : (id === firstPending && status === 'checking' ? 'is-waiting' : '')}`}>
              <span className="ci-step-dot" />
              <span>{LABELS[id]}</span>
            </div>
          ))}
          {st.devices && (
            <div className="ci-step is-done" style={{ color: 'var(--ci-text-2)' }}>
              <span className="ci-step-dot" style={{ background: 'transparent', borderColor: '#475569' }} />
              <span>{st.devices.total === 0 ? 'لا توجد أجهزة بصمة مضبوطة' : `أجهزة البصمة: ${st.devices.connected} من ${st.devices.total} متصلة`}</span>
            </div>
          )}
        </div>

        {st.count === 0 && status === 'checking' ? (
          <div className="ci-seg" style={{ width: 'min(420px, 90vw)' }} aria-label="جاري التحقق"><div className="ci-indeterminate" /></div>
        ) : (
          <div className="ci-segments" aria-label={`${st.count} من ${st.total} خطوات تم التحقق منها`}>
            {STEP_IDS.map((id) => <div key={id} className={`ci-seg ${st.done[id] ? 'is-done' : ''}`}><i /></div>)}
          </div>
        )}

        {st.blocked && (
          <div style={{ fontSize: 12.5, color: 'var(--ci-warning)', textAlign: 'center', maxWidth: 420, direction: 'ltr' }}>
            Startup is blocked{st.blockedInfo.stage ? ` at "${st.blockedInfo.stage}"` : ''}{st.blockedInfo.reason ? `: ${st.blockedInfo.reason}` : ''}
          </div>
        )}

        {status === 'unreachable' && (
          <>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ci-text)' }}>تعذر الوصول إلى الخادم</div>
            <div style={{ fontSize: 12.5, color: 'var(--ci-muted)', textAlign: 'center', maxWidth: 340 }}>
              لا يزال البرنامج يحاول الاتصال بالخادم في الخلفية. إذا استمرت المشكلة تحقّق من إعدادات الاتصال.
            </div>
            <button className="ci-retry" onClick={onRetry}>إعادة المحاولة الآن</button>
          </>
        )}
      </div>

      <div style={{ padding: '10px 28px 16px', textAlign: 'center', fontSize: 10.5, color: 'var(--ci-muted)', direction: 'ltr' }}>
        {BRAND.appName}
      </div>
    </div>
  );
}
