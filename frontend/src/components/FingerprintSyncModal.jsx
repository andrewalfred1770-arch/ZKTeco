/**
 * FingerprintSyncModal — the synchronization center for a fingerprint pull.
 *
 * Presentation only. Every number, step and percentage rendered here comes
 * from a real backend checkpoint delivered by `useFingerprintSyncWorkflow`;
 * this component never invents a count, a ratio or a step. Where the backend
 * genuinely cannot report a total (the ZK protocol does not expose the
 * device's buffer size ahead of a full pull) the UI says so with an
 * indeterminate sweep instead of a fabricated percentage.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Wifi, Database, RefreshCw, CalendarClock, CheckCircle2, XCircle,
  AlertTriangle, Fingerprint, Loader2, ScrollText,
} from 'lucide-react';
import Dialog from './ui/Dialog';

// ── Backend step vocabulary ───────────────────────────────────────────────
// zktecoService.js emits these exact `device:sync-step` names. The timeline
// below collapses connecting+connected into one visible row (they are two
// phases of one user-visible action) — the underlying events are untouched.
const BACKEND_SEQUENCE = ['connecting', 'connected', 'reading', 'saving', 'updating-attendance', 'refreshing-dashboard'];

const TIMELINE = [
  { key: 'connect',    label: 'الاتصال بالجهاز',   Icon: Wifi,          steps: ['connecting', 'connected'] },
  { key: 'reading',    label: 'قراءة السجلات',     Icon: Fingerprint,   steps: ['reading'] },
  { key: 'saving',     label: 'حفظ البيانات',      Icon: Database,      steps: ['saving'] },
  { key: 'attendance', label: 'تحديث الحضور',      Icon: CalendarClock, steps: ['updating-attendance'] },
  { key: 'dashboard',  label: 'تحديث لوحة التحكم', Icon: RefreshCw,     steps: ['refreshing-dashboard'] },
];

// Each step owns a percentage band. Inside a band whose event carries a real
// countable ratio (saving/updating-attendance both report processed/total)
// the bar advances smoothly as that real ratio grows. Reading has no
// countable total, so it renders indeterminate rather than parking on a
// made-up number.
const STEP_BANDS = {
  connecting: [0, 5],
  connected: [5, 10],
  reading: [10, 55],
  saving: [55, 80],
  'updating-attendance': [80, 95],
  'refreshing-dashboard': [95, 99],
};

// Only these steps report a real processed/total pair.
const COUNTABLE_STEPS = new Set(['saving', 'updating-attendance']);

// `saving` counts fingerprint punches; `updating-attendance` counts
// employee/day pairs. Labelling both "بصمة" would misreport what the number
// actually measures.
const UNIT_LABEL = { saving: 'بصمة', 'updating-attendance': 'يوم' };

function countsFor(step, detail) {
  if (!detail || !COUNTABLE_STEPS.has(step)) return null;
  if (typeof detail.total !== 'number' || detail.total <= 0) return null;
  const current = Math.min(detail.processed ?? 0, detail.total);
  return { current, total: detail.total, unit: UNIT_LABEL[step] || 'سجل' };
}

const num = (v) => Number(v ?? 0).toLocaleString('en-US');

function fmtClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function useElapsed(startedAt, active) {
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!active || !startedAt) return undefined;
    setElapsedMs(Date.now() - startedAt);
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 500);
    return () => clearInterval(id);
  }, [active, startedAt]);
  return elapsedMs;
}

/**
 * Eases the *display* of an already-known real value toward its target so
 * counters don't jump. The target is always a real backend number and the
 * tween snaps exactly onto it — it smooths rendering, it does not predict.
 */
function useAnimatedNumber(target) {
  const [shown, setShown] = useState(target);
  const frameRef = useRef(null);
  const fromRef = useRef(target);
  useEffect(() => {
    const from = fromRef.current;
    if (from === target) return undefined;
    const startedAt = performance.now();
    const DURATION = 320;
    const tick = (now) => {
      const t = Math.min(1, (now - startedAt) / DURATION);
      const eased = 1 - (1 - t) ** 3;
      const value = t === 1 ? target : Math.round(from + (target - from) * eased);
      fromRef.current = value;
      setShown(value);
      if (t < 1) frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [target]);
  return shown;
}

const KEYFRAMES = `
@keyframes fp-sweep      { 0%{transform:translateX(-40%);width:28%} 50%{transform:translateX(140%);width:46%} 100%{transform:translateX(260%);width:28%} }
@keyframes fp-shimmer    { 0%{transform:translateX(-100%)} 100%{transform:translateX(300%)} }
@keyframes fp-rise       { from{opacity:0;transform:translateY(10px) scale(0.985)} to{opacity:1;transform:none} }
@keyframes fp-fade       { from{opacity:0} to{opacity:1} }
@keyframes fp-pulse-ring { 0%{transform:scale(.85);opacity:.55} 70%{transform:scale(1.35);opacity:0} 100%{opacity:0} }
@keyframes fp-pop        { 0%{transform:scale(.4);opacity:0} 60%{transform:scale(1.08)} 100%{transform:scale(1);opacity:1} }
@keyframes fp-draw       { to{stroke-dashoffset:0} }
@keyframes fp-spin       { to{transform:rotate(360deg)} }
.fp-panel   { animation: fp-rise .34s cubic-bezier(.22,.9,.32,1) both; }
.fp-section { animation: fp-fade .3s ease both; }
.fp-spin    { animation: fp-spin 1s linear infinite; }
@media (prefers-reduced-motion: reduce) {
  .fp-panel, .fp-section { animation: none; }
}
`;

export default function FingerprintSyncModal({ state, onClose, onRetry, onViewLogs, devices }) {
  const {
    open, phase, currentStep, stepDetail, error, result,
    startedAt, socketStatus, deviceName, recordsRead,
  } = state;

  const running = phase === 'running';
  const elapsedMs = useElapsed(startedAt, running);

  // Device identity: the name arrives on the step events themselves; the
  // address is only shown when the host page already has the device list
  // loaded — this modal never fetches, and never guesses an address.
  const device = useMemo(() => {
    if (!Array.isArray(devices) || devices.length === 0) return null;
    const byId = stepDetail?.deviceId != null && devices.find((d) => d.id === stepDetail.deviceId);
    if (byId) return byId;
    const byName = deviceName && devices.find((d) => d.name === deviceName);
    return byName || (devices.length === 1 ? devices[0] : null);
  }, [devices, stepDetail?.deviceId, deviceName]);

  if (!open) return null;

  const counts = countsFor(currentStep, stepDetail);
  const band = STEP_BANDS[currentStep] || [0, 5];
  const ratio = counts ? counts.current / counts.total : null;
  const determinate = !running || ratio !== null;
  const pct = running ? Math.round(band[0] + (band[1] - band[0]) * (ratio ?? 0)) : 100;

  const activeIndex = TIMELINE.findIndex((t) => t.steps.includes(currentStep));
  const backendIndex = BACKEND_SEQUENCE.indexOf(currentStep);

  const accent = phase === 'error' ? '#ef4444'
    : phase === 'partial' ? '#f59e0b'
    : phase === 'success' ? '#22c55e'
    : '#2F81F7';

  return (
    <>
      <style>{KEYFRAMES}</style>
      <Dialog
        open={open}
        onClose={onClose}
        closeOnOverlay={!running}
        showClose={false}
        maxWidth={480}
        className="fp-panel"
        overlayStyle={{ background: 'rgba(6,10,20,0.72)' }}
        panelStyle={{
          borderRadius: 20,
          background: 'linear-gradient(165deg, rgba(255,255,255,0.055), rgba(255,255,255,0.015) 42%), var(--surface, #111927)',
          boxShadow: '0 40px 110px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.03) inset',
          fontFamily: 'Cairo, sans-serif',
        }}
        contentStyle={{ padding: 0 }}
      >
        <div aria-busy={running} style={{ position: 'relative' }}>
          {/* Accent hairline — the one element that carries state colour across
              every phase, so the transition between phases reads as continuous. */}
          <div style={{
            position: 'absolute', insetInline: 0, top: 0, height: 3,
            background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
            opacity: 0.9, transition: 'background .45s ease',
            borderRadius: '22px 22px 0 0',
          }} />

          <div style={{ padding: '20px 20px 16px' }}>
            {running && (
              <RunningView
                accent={accent}
                deviceName={deviceName}
                device={device}
                socketStatus={socketStatus}
                counts={counts}
                recordsRead={recordsRead}
                determinate={determinate}
                pct={pct}
                elapsedMs={elapsedMs}
                activeIndex={activeIndex}
                backendIndex={backendIndex}
                currentStep={currentStep}
                stepDetail={stepDetail}
              />
            )}

            {(phase === 'success' || phase === 'partial') && result && (
              <CompletedView
                phase={phase}
                result={result}
                deviceName={deviceName}
                onClose={onClose}
                onViewLogs={onViewLogs}
              />
            )}

            {phase === 'error' && (
              <ErrorView error={error} deviceName={deviceName} onClose={onClose} onRetry={onRetry} />
            )}
          </div>
        </div>
      </Dialog>
    </>
  );
}

/* ── Running ──────────────────────────────────────────────────────────── */

function RunningView({
  accent, deviceName, device, socketStatus, counts, recordsRead,
  determinate, pct, elapsedMs, activeIndex, backendIndex, currentStep, stepDetail,
}) {
  const connected = backendIndex >= 1;
  const shownCurrent = useAnimatedNumber(counts ? counts.current : recordsRead);
  const remaining = counts ? counts.total - counts.current : null;

  return (
    <div className="fp-section">
      <Header
        accent={accent}
        icon={<Fingerprint style={{ width: 24, height: 24, color: accent }} />}
        pulse
        title="جاري سحب البصمات"
        subtitle="جارٍ مزامنة جهاز البصمة..."
      />

      {/* Device identity strip */}
      <div style={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
        padding: '7px 11px', marginBottom: 14,
        borderRadius: 10,
        background: 'var(--surface-2, rgba(255,255,255,0.035))',
        border: '1px solid var(--border-2, rgba(255,255,255,0.05))',
      }}>
        <Chip label={deviceName || device?.name || 'جهاز البصمة'} strong />
        {device?.ipAddress && <Chip label={device.ipAddress} mono />}
        <div style={{ marginInlineStart: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: connected ? '#22c55e' : '#f59e0b',
            boxShadow: `0 0 0 3px ${connected ? 'rgba(34,197,94,0.16)' : 'rgba(245,158,11,0.16)'}`,
          }} />
          <span style={{ fontSize: 11.5, fontWeight: 700, color: connected ? '#22c55e' : '#f59e0b' }}>
            {connected ? 'متصل' : 'جارٍ الاتصال'}
          </span>
        </div>
      </div>

      {/* Primary progress */}
      <div style={{ marginBottom: 14 }}>
        <div style={{
          position: 'relative', height: 9, borderRadius: 999, overflow: 'hidden',
          background: 'var(--surface-3, rgba(255,255,255,0.05))',
          border: '1px solid var(--border-2, rgba(255,255,255,0.06))',
        }}>
          {determinate ? (
            <div style={{
              height: '100%', width: `${pct}%`, borderRadius: 999,
              background: 'linear-gradient(90deg,#1F6FEB,#2F81F7 55%,#7dd3fc)',
              boxShadow: '0 0 18px rgba(47,129,247,0.45)',
              transition: 'width .5s cubic-bezier(.22,.9,.32,1)',
              position: 'relative', overflow: 'hidden',
            }}>
              <span style={{
                position: 'absolute', insetBlock: 0, width: '30%',
                background: 'linear-gradient(90deg,transparent,rgba(255,255,255,0.35),transparent)',
                animation: 'fp-shimmer 1.8s ease-in-out infinite',
              }} />
            </div>
          ) : (
            // No countable total for this step — an honest sweep instead of a
            // fabricated percentage.
            <div style={{
              position: 'absolute', insetBlock: 0, insetInlineStart: 0, borderRadius: 999,
              background: 'linear-gradient(90deg,#1F6FEB,#7dd3fc)',
              boxShadow: '0 0 18px rgba(47,129,247,0.45)',
              animation: 'fp-sweep 1.5s ease-in-out infinite',
            }} />
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 9 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
            {counts ? (
              <>
                {num(shownCurrent)}
                <span style={{ color: 'var(--text-3)', fontWeight: 600 }}> / {num(counts.total)} </span>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-3)' }}>{counts.unit}</span>
              </>
            ) : (
              <>
                {num(shownCurrent)}
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-3)' }}> بصمة حتى الآن</span>
              </>
            )}
          </div>
          <div style={{ fontSize: 21, fontWeight: 800, color: accent, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.5px' }}>
            {determinate ? `${pct}%` : '···'}
          </div>
        </div>
      </div>

      {/* Live statistics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 8, marginBottom: 14 }}>
        <Stat label="إجمالي البصمات" value={counts ? num(counts.total) : '—'} />
        <Stat label="تم القراءة" value={num(counts ? counts.current : recordsRead)} tone="#2F81F7" />
        <Stat label="المتبقي" value={remaining == null ? '—' : num(remaining)} />
        <Stat label="المدة" value={fmtClock(elapsedMs)} mono />
      </div>

      {/* Workflow timeline */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {TIMELINE.map((row, i) => (
          <TimelineRow
            key={row.key}
            row={row}
            isLast={i === TIMELINE.length - 1}
            status={activeIndex < 0 ? 'pending' : i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'pending'}
            detail={i === activeIndex ? stepDetailText(row, currentStep, stepDetail, recordsRead) : null}
          />
        ))}
      </div>

      {socketStatus && socketStatus !== 'connected' && (
        <div style={{
          marginTop: 12, padding: '7px 10px', borderRadius: 9, fontSize: 11, fontWeight: 600,
          color: '#f59e0b', background: 'rgba(245,158,11,0.09)', border: '1px solid rgba(245,158,11,0.22)',
        }}>
          انقطع البث المباشر مؤقتاً — المزامنة مستمرة على الخادم وستظهر النتيجة عند اكتمالها
        </div>
      )}
    </div>
  );
}

function stepDetailText(row, currentStep, detail, recordsRead) {
  if (row.key === 'connect') return currentStep === 'connected' ? 'تم' : 'جارٍ الاتصال...';
  if (row.key === 'reading') {
    if (detail?.pass) return `تمريرة ${detail.pass}/${detail.maxPasses} — ${num(detail.recordsSoFar ?? recordsRead)} سجل`;
    return 'جارٍ التنفيذ...';
  }
  const counts = countsFor(currentStep, detail);
  if (counts) return `${num(counts.current)} / ${num(counts.total)}`;
  return 'جارٍ التنفيذ...';
}

function TimelineRow({ row, status, detail, isLast }) {
  const done = status === 'done';
  const active = status === 'active';
  const color = done ? '#22c55e' : active ? '#2F81F7' : 'var(--text-3, #5a6b85)';

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      {/* marker + connector rail */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', alignSelf: 'stretch' }}>
        <div style={{
          position: 'relative', flexShrink: 0,
          width: 19, height: 19, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: `1.5px solid ${done ? '#22c55e' : active ? '#2F81F7' : 'var(--border, #233047)'}`,
          background: done ? '#22c55e' : active ? 'rgba(47,129,247,0.12)' : 'transparent',
          transition: 'background .35s ease, border-color .35s ease',
        }}>
          {active && (
            <span style={{
              position: 'absolute', inset: -2, borderRadius: '50%',
              border: '2px solid #2F81F7', animation: 'fp-pulse-ring 1.6s ease-out infinite',
            }} />
          )}
          {done && <CheckCircle2 style={{ width: 11, height: 11, color: '#fff' }} strokeWidth={3} />}
          {active && <Loader2 className="fp-spin" style={{ width: 10, height: 10, color: '#2F81F7' }} />}
        </div>
        {!isLast && (
          <div style={{
            width: 2, flex: 1, minHeight: 10, marginBlock: 2, borderRadius: 2,
            background: done ? '#22c55e' : 'var(--border, #233047)',
            opacity: done ? 0.55 : 1, transition: 'background .35s ease',
          }} />
        )}
      </div>

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 7, paddingBottom: isLast ? 0 : 9, minWidth: 0 }}>
        <row.Icon style={{ width: 13, height: 13, color, flexShrink: 0, opacity: done || active ? 1 : 0.55 }} />
        <span style={{
          fontSize: 12.5, fontWeight: active ? 800 : 600,
          color: active ? 'var(--text)' : done ? 'var(--text-2, #a9b6cb)' : 'var(--text-3, #5a6b85)',
          transition: 'color .3s ease',
        }}>
          {row.label}
        </span>
        {(detail || done) && (
          <span style={{
            marginInlineStart: 'auto', fontSize: 11, fontWeight: 700,
            color: done ? '#22c55e' : '#79C0FF', fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}>
            {done ? 'تم' : detail}
          </span>
        )}
      </div>
    </div>
  );
}

/* ── Completed ────────────────────────────────────────────────────────── */

function CompletedView({ phase, result, deviceName, onClose, onViewLogs }) {
  const success = phase === 'success';
  return (
    <div className="fp-section">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', marginBottom: 16 }}>
        <div style={{
          position: 'relative', width: 62, height: 62, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12,
          background: success ? 'rgba(34,197,94,0.12)' : 'rgba(245,158,11,0.12)',
          border: `1px solid ${success ? 'rgba(34,197,94,0.3)' : 'rgba(245,158,11,0.3)'}`,
          animation: 'fp-pop .45s cubic-bezier(.2,1.1,.4,1) both',
        }}>
          {success ? <DrawnCheck /> : <AlertTriangle style={{ width: 28, height: 28, color: '#f59e0b' }} />}
        </div>
        <div style={{ fontSize: 16.5, fontWeight: 800, color: 'var(--text)' }}>
          {success ? 'تمت المزامنة بنجاح' : 'اكتملت المزامنة جزئياً'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
          {deviceName ? `${deviceName} · ` : ''}
          {result.deviceCount > 1 ? `${num(result.deviceCount)} أجهزة` : 'جهاز البصمة'}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 8, marginBottom: 8 }}>
        <Stat label="تم تحميلها" value={num(result.downloaded)} big />
        <Stat label="تم استيرادها" value={num(result.imported)} tone="#22c55e" big />
        <Stat label="مكررة" value={num(result.duplicates)} big />
        <Stat label="فاشلة" value={num(result.failed)} tone={result.failed > 0 ? '#f87171' : undefined} big />
      </div>
      <Stat label="المدة" value={fmtClock(result.duration)} mono />

      {!success && result.reason && (
        <div style={{
          marginTop: 10, padding: '8px 10px', borderRadius: 9, fontSize: 11.5,
          color: '#fbbf24', background: 'rgba(245,158,11,0.09)', border: '1px solid rgba(245,158,11,0.22)',
        }}>
          {result.reason}
        </div>
      )}

      <div style={{ display: 'flex', gap: 9, marginTop: 16 }}>
        <button onClick={onClose} className="btn-secondary" style={{ flex: 1, justifyContent: 'center' }}>
          إغلاق
        </button>
        {onViewLogs && (
          <button onClick={onViewLogs} className="btn-primary" style={{ flex: 1, justifyContent: 'center', gap: 7 }}>
            <ScrollText style={{ width: 15, height: 15 }} /> عرض السجلات
          </button>
        )}
      </div>
    </div>
  );
}

function DrawnCheck() {
  return (
    <svg width="40" height="40" viewBox="0 0 52 52" fill="none" aria-hidden="true">
      <circle
        cx="26" cy="26" r="22" stroke="#22c55e" strokeWidth="3" strokeLinecap="round"
        style={{ strokeDasharray: 140, strokeDashoffset: 140, animation: 'fp-draw .55s cubic-bezier(.65,0,.35,1) .1s forwards' }}
      />
      <path
        d="M16 27.5 L23 34 L37 19" stroke="#22c55e" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"
        style={{ strokeDasharray: 42, strokeDashoffset: 42, animation: 'fp-draw .38s cubic-bezier(.65,0,.35,1) .5s forwards' }}
      />
    </svg>
  );
}

/* ── Error ────────────────────────────────────────────────────────────── */

function ErrorView({ error, deviceName, onClose, onRetry }) {
  return (
    <div className="fp-section">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', marginBottom: 16 }}>
        <div style={{
          width: 62, height: 62, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12,
          background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)',
          animation: 'fp-pop .4s cubic-bezier(.2,1.1,.4,1) both',
        }}>
          <XCircle style={{ width: 29, height: 29, color: '#ef4444' }} />
        </div>
        <div style={{ fontSize: 16.5, fontWeight: 800, color: 'var(--text)' }}>فشلت المزامنة</div>
        {deviceName && (
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>{deviceName}</div>
        )}
      </div>

      <div style={{
        padding: '10px 12px', borderRadius: 11, fontSize: 12, lineHeight: 1.65,
        color: '#fca5a5', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.24)',
      }}>
        <div style={{ fontSize: 10.5, fontWeight: 800, color: '#f87171', marginBottom: 4 }}>سبب الخطأ</div>
        {error}
      </div>

      <div style={{ display: 'flex', gap: 9, marginTop: 16 }}>
        <button onClick={onClose} className="btn-secondary" style={{ flex: 1, justifyContent: 'center' }}>
          إغلاق
        </button>
        <button onClick={onRetry} className="btn-primary" style={{ flex: 1, justifyContent: 'center', gap: 7 }}>
          <RefreshCw style={{ width: 15, height: 15 }} /> إعادة المحاولة
        </button>
      </div>
    </div>
  );
}

/* ── Shared bits ──────────────────────────────────────────────────────── */

function Header({ accent, icon, title, subtitle, pulse }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
      <div style={{
        position: 'relative', width: 46, height: 46, borderRadius: 14, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--accent-soft, rgba(47,129,247,0.12))',
        border: `1px solid ${accent}33`,
      }}>
        {pulse && (
          <span style={{
            position: 'absolute', inset: 0, borderRadius: 14,
            border: `2px solid ${accent}`, animation: 'fp-pulse-ring 2s ease-out infinite',
          }} />
        )}
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', letterSpacing: '-0.2px' }}>{title}</div>
        <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>{subtitle}</div>
      </div>
    </div>
  );
}

function Chip({ label, strong, mono }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: strong ? 800 : 600,
      color: strong ? 'var(--text)' : 'var(--text-2, #a9b6cb)',
      padding: '2px 8px', borderRadius: 6,
      background: 'var(--surface-3, rgba(255,255,255,0.05))',
      border: '1px solid var(--border-2, rgba(255,255,255,0.05))',
      fontVariantNumeric: mono ? 'tabular-nums' : undefined,
      direction: mono ? 'ltr' : undefined,
    }}>
      {label}
    </span>
  );
}

function Stat({ label, value, tone, mono, big }) {
  return (
    <div style={{
      padding: big ? '10px 11px' : '8px 9px', borderRadius: 10,
      background: 'var(--surface-2, rgba(255,255,255,0.035))',
      border: '1px solid var(--border-2, rgba(255,255,255,0.05))',
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', marginBottom: 4 }}>{label}</div>
      <div style={{
        fontSize: big ? 19 : 15, fontWeight: 800,
        color: tone || 'var(--text)',
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: mono ? '0.5px' : '-0.3px',
        direction: mono ? 'ltr' : undefined,
        textAlign: mono ? 'start' : undefined,
      }}>
        {value}
      </div>
    </div>
  );
}
