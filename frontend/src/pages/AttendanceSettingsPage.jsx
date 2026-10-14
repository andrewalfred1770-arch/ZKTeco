/**
 * AttendanceSettingsPage — professional attendance rules configuration.
 *
 * Rule tiers use ABSOLUTE check-in / check-out times (same format as the
 * underlying policyEngine.js DEFAULT_LATE_RULES / DEFAULT_EARLY_CHECKOUT_RULES).
 * Tiers are stored in the DB Rule table under keys `late_rules` / `early_rules`
 * as JSON [{fromTime:"HH:MM", toTime:"HH:MM", units:N}, ...].
 * When empty → engine falls back to DEFAULT_LATE_RULES / DEFAULT_EARLY_CHECKOUT_RULES.
 *
 * On save → PUT /api/rules/:id triggers ruleChanged() which:
 *   1. Invalidates ruleStore cache (immediate)
 *   2. Emits rules:changed over socket (all clients)
 *   3. Schedules recalc of current month automatically
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Clock, TrendingUp, UserX, Calendar, RefreshCw,
  Save, Plus, Trash2, AlertTriangle, CheckCircle, Loader2,
  GripVertical, Info, Zap,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useUnsavedWork } from '../hooks/useUnsavedWork';
import { isSessionLostError } from '../lib/unsavedWork';
import { describeSaveFailure } from '../lib/saveFailure';
import api, { LONG_OP } from '../lib/api';
import { todayStr } from '../lib/businessDate';
import { useRulesLiveSync } from '../hooks/useRulesLiveSync';
import { getSocket } from '../lib/socket';
import { validateAttendanceConfig } from '../lib/attendanceConfigValidator';
import { nextTier, coverage, to12h } from '../lib/tierEditing';

// ── Default tiers (mirrors policyEngine.js) ───────────────────────────────────
export const DEFAULT_LATE_TIERS = [
  { fromTime: '09:00', toTime: '09:20', units: 0 },
  { fromTime: '09:21', toTime: '09:35', units: 1 },
  { fromTime: '09:36', toTime: '09:50', units: 2 },
  { fromTime: '09:51', toTime: '10:15', units: 3 },
  { fromTime: '10:16', toTime: '12:00', units: 4 },
  { fromTime: '12:01', toTime: '23:59', units: 8 },
];

export const DEFAULT_EARLY_TIERS = [
  { fromTime: '13:00', toTime: '13:59', units: 4 },
  { fromTime: '14:00', toTime: '14:59', units: 3 },
  { fromTime: '15:00', toTime: '15:49', units: 2 },
  { fromTime: '15:50', toTime: '16:54', units: 1 },
  { fromTime: '16:55', toTime: '23:59', units: 0 },
];

// ── Keys managed by this page ─────────────────────────────────────────────────
const ALL_KEYS = [
  'work_start', 'work_end', 'checkin_window_start', 'checkin_window_end',
  'late_grace', 'early_leave_grace',
  'late_rules', 'early_rules',
  'overtime_minimum', 'overtime_multiplier', 'overtime_cap_hours',
  'friday_ot_multiplier', 'holiday_ot_multiplier',
  'weekend_days', 'friday_is_weekend',
];

// Rules that live in the 'overtime' category (seed-rules.js). Anything else on this page is 'attendance'.
const OVERTIME_KEYS = ['overtime_minimum', 'overtime_multiplier', 'overtime_cap_hours', 'friday_ot_multiplier', 'holiday_ot_multiplier'];
const ruleCategoryFor = (key) => (OVERTIME_KEYS.includes(key) ? 'overtime' : 'attendance');

// Plain-language summary of a recalc result: real counts, and the finalized/paid payrolls it skipped.
// Older responses may omit the failure counters — treat a missing/invalid one as 0.
const failCount = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : 0);
const recalcHasFailures = (r) => !!r && (failCount(r.attendanceFailed) > 0 || failCount(r.payrollFailed) > 0);

function formatRecalcSummary(r) {
  if (!r) return 'تمت إعادة الاحتساب';
  const parts = [`نطاق: ${r.employeeCount ?? 0} موظف`, `${r.dayCount ?? 0} يوم`];
  if (r.payrollRecalculated != null) parts.push(`${r.payrollRecalculated} كشف راتب`);
  let msg = `${recalcHasFailures(r) ? 'اكتملت إعادة الاحتساب مع أخطاء' : 'تمت إعادة الاحتساب'}: ${parts.join(' · ')}`;
  const skipped = r.protectedPayroll || [];
  if (skipped.length) msg += ` — تم تخطي ${skipped.length} كشف راتب نهائي/مدفوع (لم يُعدَّل)`;
  if (failCount(r.attendanceFailed)) msg += ` — فشل احتساب الحضور لـ ${failCount(r.attendanceFailed)} يوم/موظف`;
  if (failCount(r.payrollFailed)) msg += ` — فشل احتساب ${failCount(r.payrollFailed)} كشف راتب`;
  return msg;
}

// Green toast only when nothing failed; any attendance/payroll failure is a visible error.
function toastRecalcResult(r) {
  if (recalcHasFailures(r)) toast.error(`⚠ ${formatRecalcSummary(r)} — راجع السجلات`, { duration: 12000 });
  else toast.success(`✓ ${formatRecalcSummary(r)}`, { duration: 8000 });
}

// Post-save recalc outcome tracker, keyed by the server's `recalcRunId`. Every rule save returns the id of
// the run that covers it (saves in one debounce window share one id); a terminal event is accepted ONLY
// when its id is one we are tracking, so a run already in flight, an unrelated run, or a stale/mismatched
// event can never be shown as this save's result. Each id settles exactly once (first terminal event wins;
// duplicates and late opposite signals are dropped). Terminal events that arrive BEFORE their id is
// registered (response slower than the socket) are kept in a small bounded buffer and resolved on arm().
// No timers: an id settles on its own done/failed event, or all pending ids settle on a lost connection.
function createRecalcTracker({ onDone, onFailed, onDisconnected }) {
  const pending = new Set();
  const seen = new Map();   // runId -> { kind, payload, claimed }  (bounded, oldest dropped)
  const SEEN_MAX = 50;
  const remember = (id, entry) => {
    if (seen.has(id)) return;
    seen.set(id, entry);
    if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value);
  };
  const deliver = (kind, payload) => { if (kind === 'done') onDone(payload); else onFailed(); };
  const terminal = (kind, ev) => {
    const id = ev && ev.recalcRunId;
    if (!id) return;                                   // untagged event: cannot be attributed
    if (pending.delete(id)) {
      remember(id, { kind, payload: ev, claimed: true });
      deliver(kind, ev);
    } else {
      remember(id, { kind, payload: ev, claimed: false });
    }
  };
  return {
    get pendingCount() { return pending.size; },
    // runIds = ids the server returned for this save. Returns how many are now awaiting an outcome.
    arm(runIds) {
      let armed = 0;
      for (const id of runIds || []) {
        if (!id || pending.has(id)) continue;
        const prior = seen.get(id);
        if (prior && prior.claimed) continue;           // that run's outcome was already reported once
        if (prior) { prior.claimed = true; deliver(prior.kind, prior.payload); }   // outcome already arrived
        else { pending.add(id); armed++; }
      }
      return armed;
    },
    done(r) { terminal('done', r); },
    failed(e) { terminal('failed', e); },
    disconnected() { if (pending.size) { pending.clear(); onDisconnected(); } },
    reset() { pending.clear(); seen.clear(); },
  };
}

const DEFAULTS = {
  work_start: '09:00', work_end: '17:00',
  checkin_window_start: '05:00', checkin_window_end: '12:00',
  late_grace: '0', early_leave_grace: '0',
  late_rules: '', early_rules: '',
  overtime_minimum: '50', overtime_multiplier: '1.5',
  overtime_cap_hours: '0', friday_ot_multiplier: '1.5',
  holiday_ot_multiplier: '1.5',
  weekend_days: '', friday_is_weekend: 'true',
};

// ── Time-rule table editor ────────────────────────────────────────────────────
function RuleTable({ tiers, onChange, defaultTiers, label, requireDayEnd = false }) {
  const update = (i, field, val) =>
    onChange(tiers.map((t, idx) => idx === i ? { ...t, [field]: val } : t));
  const remove = (i) => onChange(tiers.filter((_, idx) => idx !== i));
  // The new row starts right after the last covered minute and runs to 23:59 (lib/tierEditing.js), so a table that ends at, say,
  // 16:00 is extended in one click instead of by hand-editing a full-day row that overlaps everything.
  const add = () => onChange([...tiers, nextTier(tiers)]);
  const cov = coverage(tiers);
  const reset = () => onChange([...defaultTiers]);

  return (
    <div>
      {/* Column headers */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 100px 36px', gap: '4px 8px', marginBottom: 4, paddingRight: 4 }}>
        {['من (وقت الدخول)', 'إلى', 'ساعات الخصم', ''].map(h => (
          <span key={h} style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-3)', textAlign: h === 'ساعات الخصم' ? 'center' : 'right' }}>{h}</span>
        ))}
      </div>

      {/* Rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {tiers.map((tier, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 100px 36px', gap: '4px 8px', alignItems: 'center' }}>
            <input type="time" value={tier.fromTime} onChange={e => update(i, 'fromTime', e.target.value)}
              className="input text-sm py-1" dir="ltr" style={{ minWidth: 0 }} />
            <input type="time" value={tier.toTime} onChange={e => update(i, 'toTime', e.target.value)}
              className="input text-sm py-1" dir="ltr" style={{ minWidth: 0 }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="number" min="0" max="10" step="0.5" value={tier.units}
                onChange={e => update(i, 'units', Number(e.target.value))}
                className="input text-sm py-1 text-center" style={{ width: '100%' }} />
              <span style={{ fontSize: 11, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>ساعة</span>
            </div>
            <button onClick={() => remove(i)}
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--c-red)', padding: '4px', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              title="حذف هذه الشريحة">
              <Trash2 style={{ width: 14, height: 14 }} />
            </button>
          </div>
        ))}
      </div>

      {/* Coverage: the late table must reach 23:59 (same rule the server enforces). Shown, never auto-fixed. */}
      {requireDayEnd && cov.lastTo && !cov.reachesDayEnd && (
        <p data-testid="tier-coverage-hint" role="status" style={{ fontSize: 12, color: '#b45309', margin: '8px 0 0', lineHeight: 1.6 }}>
          ⚠ التغطية تنتهي عند <b dir="ltr">{cov.lastTo}</b> ({to12h(cov.lastTo)}) — الحضور بعد هذا الوقت بلا قاعدة تأخير، والحفظ يتطلب تغطية حتى 23:59.
          اضغط «إضافة شريحة» لإضافة شريحة تبدأ بعدها مباشرة وتمتد حتى 23:59، ثم راجع ساعات الخصم.
        </p>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button onClick={add}
          style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px', fontSize: 12.5, fontWeight: 600, border: '1px dashed var(--border)', borderRadius: 6, background: 'transparent', cursor: 'pointer', color: 'var(--accent)' }}>
          <Plus style={{ width: 13, height: 13 }} /> إضافة شريحة
        </button>
        <button onClick={reset}
          style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px', fontSize: 12.5, fontWeight: 600, border: '1px solid var(--border)', borderRadius: 6, background: 'transparent', cursor: 'pointer', color: 'var(--text-2)' }}>
          <RefreshCw style={{ width: 12, height: 12 }} /> إعادة الافتراضي
        </button>
      </div>
    </div>
  );
}

// ── Live test simulator ───────────────────────────────────────────────────────
function LiveTest({ lateTiers, earlyTiers }) {
  function timeToMin(hhmm) {
    if (!hhmm) return 0;
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  }
  function lookupLate(checkInTime) {
    const min = timeToMin(checkInTime);
    for (const t of lateTiers) {
      if (min >= timeToMin(t.fromTime) && min <= timeToMin(t.toTime)) return t.units;
    }
    return '—';
  }
  function lookupEarly(checkOutTime) {
    const min = timeToMin(checkOutTime);
    for (const t of earlyTiers) {
      if (min >= timeToMin(t.fromTime) && min <= timeToMin(t.toTime)) return t.units;
    }
    return '—';
  }

  const lateTests  = [['09:25','1 unit expected'],['09:45','2 units'],['10:05','3 units'],['12:15','8 units']];
  const earlyTests = [['13:30','4 units'],['14:30','3 units'],['15:30','2 units'],['16:30','1 unit']];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      <div>
        <p style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-2)', marginBottom: 8 }}>اختبار التأخير</p>
        {lateTests.map(([time, exp]) => {
          const result = lookupLate(time);
          const pass = result !== '—';
          return (
            <div key={time} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', marginBottom: 3, borderRadius: 6, background: 'var(--surface-2)', fontSize: 12.5 }}>
              <span style={{ fontFamily: 'Consolas', color: 'var(--c-time)', minWidth: 42 }}>{time}</span>
              <span style={{ color: 'var(--text-3)', flex: 1, fontSize: 11 }}>{exp}</span>
              <span style={{ fontWeight: 700, color: pass ? 'var(--status-present)' : 'var(--c-red)', minWidth: 60, textAlign: 'center' }}>
                {result} {pass ? '✓' : '✗'}
              </span>
            </div>
          );
        })}
      </div>
      <div>
        <p style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-2)', marginBottom: 8 }}>اختبار الانصراف المبكر</p>
        {earlyTests.map(([time, exp]) => {
          const result = lookupEarly(time);
          const pass = result !== '—';
          return (
            <div key={time} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', marginBottom: 3, borderRadius: 6, background: 'var(--surface-2)', fontSize: 12.5 }}>
              <span style={{ fontFamily: 'Consolas', color: 'var(--c-ot)', minWidth: 42 }}>{time}</span>
              <span style={{ color: 'var(--text-3)', flex: 1, fontSize: 11 }}>{exp}</span>
              <span style={{ fontWeight: 700, color: pass ? 'var(--status-present)' : 'var(--c-red)', minWidth: 60, textAlign: 'center' }}>
                {result} {pass ? '✓' : '✗'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Card wrapper ──────────────────────────────────────────────────────────────
function Card({ title, subtitle, icon: Icon, accent = 'var(--accent)', badge, badgeColor, children }) {
  const bc = badgeColor || accent;
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', boxShadow: 'var(--shadow-card)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: `${accent}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon style={{ width: 16, height: 16, color: accent }} />
        </div>
        <div style={{ flex: 1 }}>
          <p style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)', margin: 0 }}>{title}</p>
          {subtitle && <p style={{ fontSize: 11.5, color: 'var(--text-3)', margin: '1px 0 0' }}>{subtitle}</p>}
        </div>
        {badge && (
          <span style={{ fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 99, background: `${bc}18`, color: bc, border: `1px solid ${bc}35` }}>{badge}</span>
        )}
      </div>
      <div style={{ padding: '16px' }}>
        {children}
      </div>
    </div>
  );
}

// ── Field-level activation badge ─────────────────────────────────────────────
// Shows whether this specific rule key is active in DB (engine uses it)
// or falls back to the hardcoded DEFAULT_RULES value.
function ActiveBadge({ ruleKey, ruleMap }) {
  const isActive = ruleMap[ruleKey]?.isActive === true;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      fontSize: 10.5, fontWeight: 700, padding: '1px 7px', borderRadius: 99,
      background: isActive ? 'rgba(22,163,74,0.10)' : 'rgba(245,158,11,0.10)',
      border: `1px solid ${isActive ? 'rgba(22,163,74,0.30)' : 'rgba(245,158,11,0.35)'}`,
      color: isActive ? '#15803d' : '#92400e',
    }}>
      {isActive ? '✓ مفعّل' : '⚠ يستخدم القيمة الافتراضية'}
    </span>
  );
}

function Field({ label, hint, children, horizontal, ruleKey, ruleMap }) {
  return (
    <div style={{ display: 'flex', flexDirection: horizontal ? 'row' : 'column', gap: horizontal ? 12 : 5, alignItems: horizontal ? 'center' : 'flex-start' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-2)', whiteSpace: 'nowrap' }}>{label}</label>
        {ruleKey && ruleMap && <ActiveBadge ruleKey={ruleKey} ruleMap={ruleMap} />}
      </div>
      {children}
      {hint && <span style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5 }}>{hint}</span>}
    </div>
  );
}

// min={null} = no lower attribute (used for "must be greater than zero" fields, which HTML min cannot express).
function NumInput({ value, onChange, min = 0, max = 100, step = 0.5, width = 100 }) {
  return (
    <input type="number" min={min ?? undefined} max={max} step={step} value={value}
      onChange={e => onChange(e.target.value)}
      className="input text-sm py-1.5" style={{ width }} />
  );
}

function SegBtn({ options, value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
      {options.map(([val, label]) => (
        <button key={val} onClick={() => onChange(val)}
          style={{ padding: '5px 12px', borderRadius: 6, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid', transition: 'all 0.12s',
            background:  value === val ? 'var(--accent)'      : 'var(--surface-2)',
            borderColor: value === val ? 'var(--accent)'      : 'var(--border)',
            color:       value === val ? '#fff'               : 'var(--text-2)',
          }}>{label}</button>
      ))}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function AttendanceSettingsPage() {
  const [ruleMap,    setRuleMap]    = useState({});
  const [vals,       setVals]       = useState({ ...DEFAULTS });
  const [lateTiers,  setLateTiers]  = useState([...DEFAULT_LATE_TIERS]);
  const [earlyTiers, setEarlyTiers] = useState([...DEFAULT_EARLY_TIERS]);
  const [dirty,      setDirty]      = useState(false);
  // If the session ends while settings are unsaved, the app keeps this screen mounted under the login overlay (lib/unsavedWork.js).
  useUnsavedWork('attendance-settings', 'إعدادات الحضور', () => dirty);
  const submitting = useRef(false);   // a second Save while one is running does nothing (no duplicated mutations)
  const dirtyRef = useRef(false); dirtyRef.current = dirty;
  // Live rule updates (another window's save, a recalculation) must not overwrite what the user is typing: while edits are unsaved the
  // reload is deferred (useRulesLiveSync polls this) and happens once they are saved or discarded.
  const unsavedBusyRef = useMemo(() => ({ get current() { return dirtyRef.current; } }), []);
  const [saving,     setSaving]     = useState(false);
  const [loading,    setLoading]    = useState(true);
  const [recalcFrom, setRecalcFrom] = useState('');
  const [recalcTo,   setRecalcTo]   = useState('');
  const [recalcBusy, setRecalcBusy] = useState(false);
  const [showLiveTest, setShowLiveTest] = useState(false);
  const savedRef = useRef({ ...DEFAULTS });
  const recalcTrackerRef = useRef(null);
  if (!recalcTrackerRef.current) {
    recalcTrackerRef.current = createRecalcTracker({
      onDone: toastRecalcResult,
      onFailed: () => toast.error('⚠ فشلت إعادة الاحتساب التلقائية بعد الحفظ — القواعد حُفظت لكن السجلات لم تُحتسب. أعد الاحتساب يدوياً أو راجع السجلات', { duration: 12000 }),
      onDisconnected: () => toast.error('⚠ انقطع الاتصال قبل ظهور نتيجة إعادة الاحتساب — تحقق من حالة السجلات وأعد المحاولة عند الحاجة', { duration: 12000 }),
    });
  }

  // The post-save auto-recalc runs in the background; report its real result when it finishes.
  useEffect(() => {
    const socket = getSocket();
    const t = recalcTrackerRef.current;
    const onDone = (r) => t.done(r);
    const onFailed = (e) => t.failed(e);
    const onDisconnect = () => t.disconnected();
    socket.on('recalc:done', onDone);
    socket.on('recalc:failed', onFailed);
    socket.on('disconnect', onDisconnect);
    return () => {
      socket.off('recalc:done', onDone); socket.off('recalc:failed', onFailed);
      socket.off('disconnect', onDisconnect);
      t.reset();
    };
  }, []);

  const load = useCallback(async () => {
    try {
      // All categories: the overtime rules live under 'overtime', so a category filter would miss them
      // and the save would create duplicates instead of updating the existing rows.
      const { data } = await api.get('/rules');
      const map = {}, merged = { ...DEFAULTS };
      for (const r of data) {
        if (!ALL_KEYS.includes(r.key)) continue;
        // Duplicate keys: the active row is the one the engines read; otherwise keep the first.
        if (map[r.key] && (map[r.key].isActive || !r.isActive)) continue;
        map[r.key] = { id: r.id, isActive: r.isActive };
        if (r.value != null && r.value !== '') merged[r.key] = r.value;
      }
      // Friday is a PERMANENT weekly off (not configurable): the page always shows/saves 'true'. The
      // saved snapshot keeps the stored value, so a stale stored 'false' is corrected on the next save.
      const storedFriday = merged.friday_is_weekend;
      merged.friday_is_weekend = 'true';
      setRuleMap(map);
      setVals(merged);
      savedRef.current = { ...merged, friday_is_weekend: storedFriday };

      // Parse tier JSON
      try {
        const lt = merged.late_rules ? JSON.parse(merged.late_rules) : null;
        if (lt?.length) setLateTiers(lt);
        else setLateTiers([...DEFAULT_LATE_TIERS]);
      } catch { setLateTiers([...DEFAULT_LATE_TIERS]); }
      // Parse tier JSON
      try {
        const et = merged.early_rules ? JSON.parse(merged.early_rules) : null;
        if (et?.length) setEarlyTiers(et);
        else setEarlyTiers([...DEFAULT_EARLY_TIERS]);
      } catch { setEarlyTiers([...DEFAULT_EARLY_TIERS]); }

      setDirty(false);
    } catch { toast.error('تعذر تحميل إعدادات الحضور'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const today = todayStr();
    setRecalcFrom(`${today.slice(0, 7)}-01`);
    setRecalcTo(today);
  }, [load]);

  useRulesLiveSync(load, { silent: true, isBusyRef: unsavedBusyRef });

  const set = (key, val) => { setVals(p => ({ ...p, [key]: val })); setDirty(true); };

  // Live validation — recomputed on every edit, no Save needed. Errors block
  // Save entirely (the backend re-validates and would reject anyway); warnings
  // inform but allow saving. Never auto-corrects: the user fixes their input.
  const validation = useMemo(
    () => validateAttendanceConfig({ vals, lateTiers, earlyTiers }),
    [vals, lateTiers, earlyTiers],
  );
  const hasErrors = validation.errors.length > 0;

  const saveAll = async () => {
    if (submitting.current) return;
    if (hasErrors) {
      toast.error('لا يمكن الحفظ — صحّح أخطاء الإعدادات المعروضة أولاً');
      return;
    }
    submitting.current = true;
    setSaving(true);
    try {
      const toSave = {
        ...vals,
        late_rules:  JSON.stringify(lateTiers),
        early_rules: JSON.stringify(earlyTiers),
      };

      let saved = 0;
      let scheduled = 0;   // saves the server confirmed scheduled a recalculation
      const runIds = new Set();   // ids of the runs covering them (saves in one debounce window share one)
      const errs = [];
      let sessionLostErr = null;   // a rejected key because the SESSION ended (not because the value is invalid)

      // D6/R1: every PUT is validated against the CURRENT saved rules. The saved late_rules must always cover
      // work_start → 23:59, so when work_start moves EARLIER the (already-validated) late rules that start earlier
      // are saved first; when it moves later or stays, work_start goes first. Never reordered otherwise.
      const orderedKeys = [...ALL_KEYS];
      if (String(toSave.work_start) < String(savedRef.current.work_start)) {
        orderedKeys.splice(orderedKeys.indexOf('late_rules'), 1);
        orderedKeys.splice(orderedKeys.indexOf('work_start'), 0, 'late_rules');
      }
      for (const key of orderedKeys) {
        const newVal = String(toSave[key] ?? '');
        if (newVal === String(savedRef.current[key] ?? '') && key !== 'late_rules' && key !== 'early_rules') continue;

        const ex = ruleMap[key];
        try {
          if (ex?.id) {
            const { data: pr } = await api.put(`/rules/${ex.id}`, { value: newVal, isActive: true, changedByName: 'مدير النظام' });
            if (pr?.recalcScheduled !== false) scheduled++;   // older backend (no field) = assume scheduled
            if (pr?.recalcRunId) runIds.add(pr.recalcRunId);
          } else {
            const { data: cr } = await api.post('/rules', {
              name: key, key,
              category: ruleCategoryFor(key),
              type: (key.endsWith('_rules') || key === 'weekend_days') ? 'text' : (key.endsWith('_start') || key.endsWith('_end') || key === 'work_start' || key === 'work_end' || key.includes('window')) ? 'time' : 'number',
              value: newVal, isActive: true, changedByName: 'مدير النظام',
            });
            setRuleMap(m => ({ ...m, [key]: { id: cr.id, isActive: true } }));
            if (cr?.recalcScheduled !== false) scheduled++;
            if (cr?.recalcRunId) runIds.add(cr.recalcRunId);
          }
          saved++;
        } catch (err) { if (isSessionLostError(err)) sessionLostErr = err; errs.push(`${key}: ${err?.response?.data?.error || err.message}`); }
      }

      // Armed even when some saves were rejected: the accepted ones still triggered a recalculation.
      // If the socket is already down no outcome can arrive, so say so now instead of waiting.
      let awaiting = recalcTrackerRef.current.arm([...runIds]) > 0;
      if (awaiting && !getSocket().connected) {
        recalcTrackerRef.current.disconnected();   // shows the connection warning
        awaiting = false;                          // ...so the save toast must not also promise a result
      }
      if (errs.length) {
        // Surface the REAL backend error(s) — not a generic "check your values"
        // message. Each entry is already "<key>: <actual backend error>".
        // A lost session rejects every remaining key the same way: say so ONCE, clearly, instead of one error per key.
        if (sessionLostErr) toast.error(describeSaveFailure(sessionLostErr), { duration: 9000 });
        else errs.forEach(e => toast.error(e, { duration: 6000 }));
      }
      else {
        toast.success(awaiting
          ? `✓ حُفظت ${saved} قاعدة — جاري إعادة احتساب الشهر الحالي، ستظهر النتيجة عند الانتهاء`
          : scheduled > 0
            ? `✓ حُفظت ${saved} قاعدة — ستُعاد الحسابات تلقائياً`
            : `✓ حُفظت ${saved} قاعدة — لا يلزم إعادة احتساب`);
        savedRef.current = { ...toSave };
        setDirty(false);
      }
      // Server values are re-read ONLY after a fully successful save. After a rejected / partial save the typed values stay exactly as the
      // user left them (Save stays enabled to retry): reloading here used to overwrite them and clear the dirty flag, losing the edits.
      if (!errs.length) await load();
    } catch (err) { toast.error(describeSaveFailure(err)); }
    finally { submitting.current = false; setSaving(false); }
  };

  const runRecalc = async () => {
    if (!recalcFrom || !recalcTo) return toast.error('حدد نطاق التاريخ');
    setRecalcBusy(true);
    try {
      const { data } = await api.post('/rules/recalculate-full', { from: recalcFrom, to: recalcTo }, LONG_OP);
      toastRecalcResult(data);
    } catch (err) { toast.error(err?.response?.data?.error || 'فشلت إعادة الاحتساب'); }
    finally { setRecalcBusy(false); }
  };

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 10 }}>
      <Loader2 style={{ width: 24, height: 24, animation: 'spin 1s linear infinite', color: 'var(--accent)' }} />
      <span style={{ color: 'var(--text-2)' }}>جاري تحميل إعدادات الحضور...</span>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, overflowY: 'auto', minHeight: 0, paddingBottom: 24 }} dir="rtl">

      {/* ── Header ────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">إعدادات الحضور والانصراف</h1>
          <p style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 3 }}>
            جميع التغييرات تؤثر فوراً على محرك الحضور والرواتب — الشهر الحالي يُعاد احتسابه تلقائياً
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={() => setShowLiveTest(s => !s)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: '1px solid var(--border)', background: showLiveTest ? 'var(--accent-soft)' : 'var(--surface)', color: showLiveTest ? 'var(--accent)' : 'var(--text-2)' }}>
            <Zap style={{ width: 14, height: 14 }} /> اختبار مباشر
          </button>
          <button onClick={saveAll} disabled={saving || !dirty || hasErrors}
            style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 20px', borderRadius: 7, fontSize: 13.5, fontWeight: 700, cursor: (dirty && !hasErrors) ? 'pointer' : 'not-allowed', border: 'none',
              background: (dirty && !hasErrors) ? 'var(--accent)' : 'var(--surface-2)', color: (dirty && !hasErrors) ? '#fff' : 'var(--text-3)' }}>
            {saving ? <Loader2 style={{ width: 15, height: 15, animation: 'spin 1s linear infinite' }} />
                    : <Save style={{ width: 15, height: 15 }} />}
            {saving ? 'جاري الحفظ...' : hasErrors ? 'صحّح الأخطاء أولاً' : dirty ? 'حفظ التغييرات' : 'لا توجد تغييرات'}
          </button>
        </div>
      </div>

      {dirty && (
        <div style={{ padding: '9px 14px', borderRadius: 7, background: 'rgba(245,158,11,0.09)', border: '1px solid rgba(245,158,11,0.28)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertTriangle style={{ width: 14, height: 14, color: '#d97706', flexShrink: 0 }} />
          <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>يوجد تغييرات غير محفوظة — احفظ لتطبيقها على الحضور والرواتب فوراً.</span>
        </div>
      )}

      {/* ── Live validation status — errors block Save, warnings inform ── */}
      {validation.errors.length > 0 && (
        <div style={{ padding: '10px 14px', borderRadius: 7, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <AlertTriangle style={{ width: 14, height: 14, color: '#dc2626', flexShrink: 0 }} />
            <span style={{ fontSize: 12.5, fontWeight: 700, color: '#dc2626' }}>
              🔴 إعدادات غير صالحة — لن يتم الحفظ حتى تصحيح ما يلي:
            </span>
          </div>
          <ul style={{ margin: 0, paddingRight: 26, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {validation.errors.map((e, i) => (
              <li key={i} style={{ fontSize: 12, color: 'var(--text-2)' }}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {validation.errors.length === 0 && validation.warnings.length > 0 && (
        <div style={{ padding: '10px 14px', borderRadius: 7, background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.25)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Info style={{ width: 14, height: 14, color: '#d97706', flexShrink: 0 }} />
            <span style={{ fontSize: 12.5, fontWeight: 700, color: '#d97706' }}>🟡 تنبيهات — الحفظ ممكن لكن راجع ما يلي:</span>
          </div>
          <ul style={{ margin: 0, paddingRight: 26, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {validation.warnings.map((w, i) => (
              <li key={i} style={{ fontSize: 12, color: 'var(--text-2)' }}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {dirty && validation.errors.length === 0 && validation.warnings.length === 0 && (
        <div style={{ padding: '8px 14px', borderRadius: 7, background: 'rgba(34,197,94,0.07)', border: '1px solid rgba(34,197,94,0.25)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <CheckCircle style={{ width: 14, height: 14, color: '#16a34a', flexShrink: 0 }} />
          <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>🟢 الإعدادات صالحة — جاهزة للحفظ.</span>
        </div>
      )}

      {/* ── Live test panel ───────────────────────────────────────────── */}
      {showLiveTest && (
        <Card title="اختبار القواعد مباشرة" icon={Zap} accent="#7c3aed" subtitle="يُحاكي نتيجة القواعد الحالية قبل الحفظ">
          <LiveTest lateTiers={lateTiers} earlyTiers={earlyTiers} />
        </Card>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(480px, 100%), 1fr))', gap: 16, alignItems: 'start' }}>

        {/* ── 1. Shift Timing — ONLY shift boundaries ────────────────── */}
        <Card title="توقيت الدوام" icon={Clock} accent="#1d4ed8" subtitle="الوقت الرسمي لبداية ونهاية الوردية"
          badge={ruleMap.work_start?.isActive ? 'القواعد المحفوظة' : 'القواعد الافتراضية'}
          badgeColor={ruleMap.work_start?.isActive ? '#15803d' : '#1d4ed8'}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px' }}>
            <Field label="بداية الدوام" ruleKey="work_start" ruleMap={ruleMap}>
              <input type="time" value={vals.work_start} onChange={e => set('work_start', e.target.value)} className="input text-sm py-1.5" dir="ltr" />
            </Field>
            <Field label="نهاية الدوام" ruleKey="work_end" ruleMap={ruleMap}>
              <input type="time" value={vals.work_end} onChange={e => set('work_end', e.target.value)} className="input text-sm py-1.5" dir="ltr" />
            </Field>
            <Field label="نافذة الدخول — بداية" hint="أقدم وقت يُعتبر بصمة دخول" ruleKey="checkin_window_start" ruleMap={ruleMap}>
              <input type="time" value={vals.checkin_window_start} onChange={e => set('checkin_window_start', e.target.value)} className="input text-sm py-1.5" dir="ltr" />
            </Field>
            <Field label="نافذة الدخول — نهاية" hint="آخر وقت يُعتبر بصمة دخول" ruleKey="checkin_window_end" ruleMap={ruleMap}>
              <input type="time" value={vals.checkin_window_end} onChange={e => set('checkin_window_end', e.target.value)} className="input text-sm py-1.5" dir="ltr" />
            </Field>
          </div>
        </Card>

        {/* ── 2. Late Rules ────────────────────────────────────────────── */}
        <Card title="قواعد التأخير" icon={Clock} accent="#b45309"
          subtitle="جدول ساعات الخصم حسب وقت الحضور — 1 ساعة خصم = ساعة راتب"
          badge={ruleMap.late_rules?.isActive ? '✓ القواعد المحفوظة' : '⚡ القواعد الافتراضية'}
          badgeColor={ruleMap.late_rules?.isActive ? '#15803d' : '#1d4ed8'}>
          <div style={{ marginBottom: 12 }}>
            <Field label="دقائق السماح للتأخير" horizontal ruleKey="late_grace" ruleMap={ruleMap}>
              <NumInput value={vals.late_grace} onChange={v => set('late_grace', v)} min={0} max={480} step="any" width={80} />
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>دقيقة (الحضور خلالها لا يُعدّ تأخيراً)</span>
            </Field>
          </div>
          <RuleTable
            tiers={lateTiers}
            onChange={t => { setLateTiers(t); setDirty(true); }}
            defaultTiers={DEFAULT_LATE_TIERS}
            requireDayEnd
            label="قواعد التأخير"
          />
          <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 6, background: 'rgba(180,83,9,0.06)', border: '1px solid rgba(180,83,9,0.15)', fontSize: 11.5, color: 'var(--text-3)' }}>
            <strong style={{ color: 'var(--text-2)' }}>ملاحظة:</strong> هذه الأوقات مطلقة (وقت الحضور الفعلي). كل شريحة تحدد ساعات الخصم المقابلة. يجب أن تغطي القواعد كل الوقت من بداية الدوام حتى 23:59 بلا فجوات.
          </div>
        </Card>

        {/* ── 3. Early Leave Rules ─────────────────────────────────────── */}
        <Card title="قواعد الانصراف المبكر" icon={Clock} accent="#7c3aed"
          subtitle="جدول ساعات الخصم حسب وقت الانصراف — 1 ساعة خصم = ساعة راتب"
          badge={ruleMap.early_rules?.isActive ? '✓ القواعد المحفوظة' : '⚡ القواعد الافتراضية'}
          badgeColor={ruleMap.early_rules?.isActive ? '#15803d' : '#1d4ed8'}>
          <div style={{ marginBottom: 12 }}>
            <Field label="دقائق السماح للانصراف المبكر" horizontal ruleKey="early_leave_grace" ruleMap={ruleMap}>
              <NumInput value={vals.early_leave_grace} onChange={v => set('early_leave_grace', v)} min={0} max={480} step="any" width={80} />
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>دقيقة</span>
            </Field>
          </div>
          <RuleTable
            tiers={earlyTiers}
            onChange={t => { setEarlyTiers(t); setDirty(true); }}
            defaultTiers={DEFAULT_EARLY_TIERS}
            label="قواعد الانصراف المبكر"
          />
          <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 6, background: 'rgba(124,58,237,0.06)', border: '1px solid rgba(124,58,237,0.15)', fontSize: 11.5, color: 'var(--text-3)' }}>
            <strong style={{ color: 'var(--text-2)' }}>ملاحظة:</strong> هذه الأوقات مطلقة (وقت الانصراف الفعلي). كل شريحة تحدد ساعات الخصم المقابلة.
          </div>
        </Card>

        {/* ── 4. Overtime ──────────────────────────────────────────────── */}
        <Card title="قواعد الإضافي" icon={TrendingUp} accent="#6d28d9" subtitle="الحد الأدنى والمضاعفات">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px' }}>
            <Field label="الحد الأدنى للإضافي (دقيقة)" hint="لا تُحسب ساعات إضافية دون هذا الحد. في أيام العمل يُقارَن بالإضافي بعد تقريبه لساعات كاملة (الساعة = 60 دقيقة)، وفي الإجازات الأسبوعية والرسمية يُقارَن بدقائق العمل الفعلية في اليوم" ruleKey="overtime_minimum" ruleMap={ruleMap}>
              <NumInput value={vals.overtime_minimum} onChange={v => set('overtime_minimum', v)} min={0} max={1440} step="any" width={90} />
            </Field>
            <Field label="مضاعف الإضافي" hint="1.5 = مرة ونصف الأجر الساعي — يجب أن يكون أكبر من صفر" ruleKey="overtime_multiplier" ruleMap={ruleMap}>
              <NumInput value={vals.overtime_multiplier} onChange={v => set('overtime_multiplier', v)} min={null} max={10} step="any" width={90} />
            </Field>
            <Field label="الحد الأقصى اليومي للإضافي (ساعة)" hint="0 = بلا حد" ruleKey="overtime_cap_hours" ruleMap={ruleMap}>
              <NumInput value={vals.overtime_cap_hours} onChange={v => set('overtime_cap_hours', v)} min={0} max={24} step="any" width={90} />
            </Field>
            <Field label="مضاعف إضافي الجمعة" ruleKey="friday_ot_multiplier" ruleMap={ruleMap}>
              <NumInput value={vals.friday_ot_multiplier} onChange={v => set('friday_ot_multiplier', v)} min={null} max={10} step="any" width={90} />
            </Field>
            <Field label="مضاعف إضافي الإجازات الرسمية" ruleKey="holiday_ot_multiplier" ruleMap={ruleMap}>
              <NumInput value={vals.holiday_ot_multiplier} onChange={v => set('holiday_ot_multiplier', v)} min={null} max={10} step="any" width={90} />
            </Field>
          </div>
        </Card>

        {/* ── 5. Weekend ───────────────────────────────────────────────── */}
        <Card title="إعدادات نهاية الأسبوع" icon={Calendar} accent="#0369a1" subtitle="تحديد أيام الراحة الأسبوعية">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field label="يوم الجمعة" ruleKey="friday_is_weekend" ruleMap={ruleMap}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>
                إجازة أسبوعية دائمة — بدون بصمات: لا غياب ولا خصم · مع بصمات: كل الساعات إضافي (ثابت، لا يمكن تغييره)
              </span>
            </Field>
            <Field label="أيام الإجازة الأسبوعية الثابتة" ruleKey="weekend_days" ruleMap={ruleMap}>
              <SegBtn
                options={[['','لا يوجد'],['fri','الجمعة'],['sat','السبت'],['fri,sat','الجمعة + السبت']]}
                value={vals.weekend_days || ''}
                onChange={v => set('weekend_days', v)}
              />
            </Field>
          </div>
        </Card>

        {/* ── 6. Absence ───────────────────────────────────────────────── */}
        <Card title="قواعد الغياب" icon={UserX} accent="#dc2626" subtitle="أيام الخصم حسب نوع الغياب">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              {[
                { label: 'غياب بإذن', days: '1 يوم', color: '#15803d', bg: 'rgba(22,163,74,0.08)' },
                { label: 'غياب بدون إذن', days: '2 أيام', color: '#dc2626', bg: 'rgba(220,38,38,0.08)' },
                { label: 'مخصص', days: 'يحدده المستخدم', color: '#1d4ed8', bg: 'rgba(29,78,216,0.08)' },
              ].map(t => (
                <div key={t.label} style={{ padding: '10px 12px', borderRadius: 8, background: t.bg, border: `1px solid ${t.color}25`, textAlign: 'center' }}>
                  <p style={{ fontSize: 12, fontWeight: 700, color: t.color, margin: 0 }}>{t.label}</p>
                  <p style={{ fontSize: 13.5, fontWeight: 800, color: 'var(--text)', margin: '4px 0 0' }}>{t.days}</p>
                </div>
              ))}
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--text-3)', display: 'flex', alignItems: 'flex-start', gap: 6, margin: 0 }}>
              <Info style={{ width: 12, height: 12, flexShrink: 0, marginTop: 2, color: 'var(--accent)' }} />
              اليوم بلا بصمة ولم يُحدَّد نوع غيابه يُحتسب تلقائياً «غياب بإذن» بخصم يوم واحد ثابت. ولتغيير النوع أو عدد الأيام اضبطه من شاشة الحضور اليومي أو الشهري على سجل الغياب نفسه.
            </p>
          </div>
        </Card>

        {/* ── 7. Recalculation ─────────────────────────────────────────── */}
        <Card title="إعادة احتساب تاريخية" icon={RefreshCw} accent="#059669" subtitle="إعادة بناء بيانات الحضور والرواتب لفترة سابقة">
          <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 12, lineHeight: 1.65 }}>
            تغيير أي قاعدة يُعيد احتساب <strong>الشهر الحالي تلقائياً</strong>.
            استخدم هذه الأداة لإعادة احتساب فترة تاريخية بعد تعديل قواعد بشكل رجعي.
          </p>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
            <Field label="من تاريخ">
              <input type="date" value={recalcFrom} onChange={e => setRecalcFrom(e.target.value)} className="input text-sm py-1.5" dir="ltr" style={{ width: 145 }} />
            </Field>
            <Field label="إلى تاريخ">
              <input type="date" value={recalcTo} onChange={e => setRecalcTo(e.target.value)} className="input text-sm py-1.5" dir="ltr" style={{ width: 145 }} />
            </Field>
            <button onClick={runRecalc} disabled={recalcBusy}
              style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 18px', borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: 'pointer', border: 'none', background: '#059669', color: '#fff', opacity: recalcBusy ? 0.7 : 1, marginBottom: 1 }}>
              {recalcBusy ? <Loader2 style={{ width: 14, height: 14, animation: 'spin 1s linear infinite' }} />
                          : <RefreshCw style={{ width: 14, height: 14 }} />}
              {recalcBusy ? 'جاري الاحتساب...' : 'إعادة الاحتساب'}
            </button>
          </div>
        </Card>

      </div>
    </div>
  );
}
