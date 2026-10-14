import React, { useEffect, useRef, useState } from 'react';
import { Fingerprint, RefreshCw, Loader2, AlertTriangle, ChevronDown, ChevronUp, UserPlus } from 'lucide-react';
import api, { LONG_OP } from '../lib/api';
import { getSocket } from '../lib/socket';

/**
 * أشخاص جدد على أجهزة البصمة — people registered on a fingerprint device that have no employee in
 * PETSHROW yet. Data comes from GET /devices/new-users (derived server-side from the devices' registered-user
 * lists minus every number an employee already holds — see services/deviceUserDiscoveryService.js) and is
 * refreshed through the existing socket channel ('device-users:changed'), on reconnect, and — through
 * `reloadToken` — after the Employees page saved an employee (a plain GET: it never starts a device scan).
 *
 * The panel never creates anything itself. "إضافة موظف" hands the person to the page (`onAdd`), which opens the
 * existing employee form pre-filled; nothing is saved until the user confirms there.
 *
 * Structure: createNewUsersController() holds all fetching / refresh / collapse logic as plain JS (testable
 * without a DOM); NewDeviceUsersView is a pure presentational component; NewDeviceUsersPanel is the thin React glue.
 */

export const NO_NAME_LABEL = '— بدون اسم على الجهاز —';
const REFETCH_DEBOUNCE_MS = 400;

const PROBLEM_LABEL = {
  offline: 'غير متصل',
  busy: 'مشغول (سيُعاد المحاولة)',
  unsupported: 'لا يدعم قراءة المستخدمين',
  timeout: 'انتهت مهلة القراءة',
  error: 'تعذرت القراءة',
  not_found: 'غير موجود',
};

// Why a device id can never become an employee number (mirrors the server rule; the server's `people[].problem` wins when present).
const ID_PROBLEM_LABEL = {
  too_long: 'الرقم أطول من 9 خانات (حد جهاز البصمة) — لا يمكن إنشاء موظف به',
  has_whitespace: 'الرقم يحتوي على مسافات — لا يمكن إنشاء موظف به',
};

/** Devices whose last scan could not read users (busy is transient and not shown as a problem). */
export function deviceProblems(devices) {
  return (devices || []).filter((d) => d && PROBLEM_LABEL[d.status] && d.status !== 'busy');
}

/**
 * One entry per user id (the same id reported by several devices is ONE person). The server sends `people`; this derives the same
 * grouping from `items` for an older/partial payload so the panel never shows the same id twice.
 */
export function groupPeople(items) {
  const byId = new Map();
  for (const it of [...(items || [])].sort((a, b) => a.deviceId - b.deviceId)) {
    let p = byId.get(it.zkUserId);
    if (!p) {
      const problem = it.zkUserId.length > 9 ? 'too_long' : (/[\s​-‏‪-‮﻿]/.test(it.zkUserId) ? 'has_whitespace' : null);
      p = { key: it.zkUserId, zkUserId: it.zkUserId, name: null, addable: !problem, problem, devices: [], names: [] };
      byId.set(it.zkUserId, p);
    }
    p.devices.push({ deviceId: it.deviceId, deviceName: it.deviceName });
    if (it.name) { p.names.push({ deviceId: it.deviceId, deviceName: it.deviceName, name: it.name }); if (!p.name) p.name = it.name; }
  }
  return [...byId.values()]
    .map((p) => ({ ...p, nameConflict: new Set(p.names.map((n) => n.name.toLowerCase())).size > 1 }))
    .sort((a, b) => a.zkUserId.localeCompare(b.zkUserId, undefined, { numeric: true }));
}

/**
 * What "إضافة موظف" pre-fills in the employee form: exactly the id (and, when the device gave one, the name) the device reported.
 * Returns null for a person who cannot become an employee (id too long / contains whitespace). Nothing is saved here.
 */
export function employeePrefillFromPerson(person) {
  if (!person || person.addable === false || !person.zkUserId) return null;
  return {
    zkUserId: person.zkUserId,
    code: person.zkUserId,                       // the system keeps code and zkUserId identical (routes/employees.js resolveUnifiedNumber)
    name: person.name || '',
    deviceNames: (person.devices || []).map((d) => d.deviceName || `#${d.deviceId}`),
    nameConflict: !!person.nameConflict,
  };
}

/**
 * Framework-free controller. `onState(patch)` receives partial state; nothing is set after dispose().
 * Bursts of events collapse into one refetch; a response that arrives after dispose() is dropped.
 * Collapsing/expanding is pure UI state: toggleExpanded() performs NO request and starts NO scan.
 */
/** An HTTP timeout / lost response does NOT mean the scan failed — the server keeps scanning. */
export function isTimeoutError(err) {
  return !!err && (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || /timeout/i.test(String(err.message || '')));
}

export function createNewUsersController({ api: http, socket, onState, setTimer = setTimeout, clearTimer = clearTimeout, longOp = LONG_OP }) {
  let alive = true;
  let timer = null;
  let seq = 0;                                   // only the newest response may update state
  let expanded = true;

  async function load() {
    const mine = ++seq;
    try {
      const { data } = await http.get('/devices/new-users');
      if (alive && mine === seq) onState({ view: data, error: false, loading: false });
    } catch {
      if (alive && mine === seq) onState({ error: true, loading: false });
    }
  }
  function loadSoon() {
    if (!alive) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => { timer = null; load(); }, REFETCH_DEBOUNCE_MS);
  }
  async function scanNow() {
    if (!alive) return;
    onState({ scanning: true });
    const mine = ++seq;
    try {
      // The server answers when the (bounded) scan has finished; it may take longer than the default 15 s.
      const { data } = await http.post('/devices/new-users/scan', {}, longOp);
      if (alive && mine === seq) onState({ view: data, error: false });
    } catch (err) {
      if (!alive || mine !== seq) { /* superseded or disposed */ }
      else if (isTimeoutError(err)) loadSoon();          // scan is still running server-side: no false error, refresh when it lands
      else onState({ error: true });
    } finally {
      if (alive) onState({ scanning: false });
    }
  }
  function toggleExpanded() {
    if (!alive) return expanded;
    expanded = !expanded;
    onState({ expanded });                       // UI state only — no request, no scan
    return expanded;
  }

  socket.on('device-users:changed', loadSoon);
  socket.on('connect', loadSoon);                // after a reconnect, catch up on anything missed
  load();

  return {
    load, scanNow, toggleExpanded,
    dispose() {
      alive = false;
      if (timer) { clearTimer(timer); timer = null; }
      socket.off('device-users:changed', loadSoon);
      socket.off('connect', loadSoon);
    },
  };
}

export function NewDeviceUsersView({ view, loading, error, scanning, expanded = true, onRetry, onScan, onToggle, onAdd }) {
  const items = view?.items || [];
  const people = view?.people || groupPeople(items);
  const problems = deviceProblems(view?.devices);
  const skipped = view?.skipped || [];
  const reserved = view?.reserved || [];
  const reportedDevices = (view?.devices || []).filter((d) => d && d.reported != null);
  const bodyId = 'new-device-users-body';
  const label = (d) => d.deviceName || `#${d.deviceId}`;

  return (
    <div className="card p-3" dir="rtl" data-testid="new-device-users">
      <div className="flex items-center justify-between gap-2" style={{ flexWrap: 'wrap' }}>
        <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
          <button type="button" onClick={onToggle} aria-expanded={expanded} aria-controls={bodyId} data-testid="new-device-users-toggle"
            title={expanded ? 'إخفاء القائمة' : 'إظهار القائمة'} aria-label={expanded ? 'إخفاء قائمة الأشخاص الجدد على الأجهزة' : 'إظهار قائمة الأشخاص الجدد على الأجهزة'}
            className="btn-ghost p-1 rounded-lg flex items-center">
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          <Fingerprint className="w-4 h-4" style={{ color: 'var(--accent)' }} />
          <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>أشخاص جدد على أجهزة البصمة</h2>
          {view && (
            <span className={people.length ? 'badge-blue' : 'badge-gray'} data-testid="new-device-users-count"
              style={{ padding: '1px 9px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
              {people.length}
            </span>
          )}
          {/* Status stays visible while collapsed: a scan in progress, devices that could not be read, devices that are not scanned. */}
          {scanning && <span className="text-xs" data-testid="new-device-users-status-scanning" style={{ color: 'var(--text-3)' }}><Loader2 className="w-3 h-3 animate-spin" style={{ display: 'inline', verticalAlign: '-2px' }} /> جارٍ الفحص…</span>}
          {error && <span className="text-xs" data-testid="new-device-users-status-error" style={{ color: '#dc2626' }}>تعذر تحميل القائمة</span>}
          {problems.length > 0 && <span className="text-xs" data-testid="new-device-users-status-problems" style={{ color: '#b45309' }}>⚠ {problems.length} جهاز تعذرت قراءته</span>}
          {skipped.length > 0 && <span className="text-xs" data-testid="new-device-users-status-skipped" style={{ color: '#b45309' }}>{skipped.length} جهاز لا يُفحص</span>}
        </div>
        <button onClick={onScan} disabled={scanning} className="btn-ghost text-xs py-1 px-2 rounded-lg flex items-center gap-1"
          title="قراءة قوائم المستخدمين من الأجهزة الآن (قراءة فقط)">
          {scanning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          فحص الأجهزة الآن
        </button>
      </div>

      {expanded && (
        <div id={bodyId} data-testid="new-device-users-body">
          <p className="text-xs" style={{ color: 'var(--text-3)', margin: '6px 0 0' }} data-testid="new-device-users-hint">
            المطابقة عامة حسب رقم المستخدم (zkUserId) وليست خاصة بجهاز معيّن: إذا كان لأي موظف نفس الرقم يُعدّ مرتبطاً ولا يظهر هنا.
            الاسم المعروض مصدره جهاز البصمة نفسه وقد لا يكون مقروءاً.
          </p>

          {loading && !view && (
            <p className="text-xs" style={{ color: 'var(--text-3)', margin: '8px 0 0' }}>
              <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ display: 'inline', verticalAlign: '-2px' }} /> جاري التحميل…
            </p>
          )}

          {error && (
            <p className="text-xs" role="alert" style={{ color: '#dc2626', margin: '8px 0 0' }}>
              <AlertTriangle className="w-3.5 h-3.5" style={{ display: 'inline', verticalAlign: '-2px' }} /> تعذر تحميل القائمة.{' '}
              <button onClick={onRetry} style={{ textDecoration: 'underline', cursor: 'pointer', background: 'none', border: 'none', color: 'inherit', padding: 0 }}>إعادة المحاولة</button>
            </p>
          )}

          {view && !error && people.length === 0 && (
            <p className="text-xs" style={{ color: 'var(--text-3)', margin: '8px 0 0' }}>
              {view.neverScanned ? 'لم يتم فحص الأجهزة بعد — سيظهر هنا أي شخص جديد يُسجَّل على جهاز بصمة.' : 'لا يوجد أشخاص جدد على أجهزة البصمة.'}
            </p>
          )}

          {people.length > 0 && (
            <div style={{ maxHeight: 320, overflowY: 'auto', marginTop: 8 }}>
              <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: 'var(--text-3)', textAlign: 'right' }}>
                    <th style={{ padding: '4px 8px', fontWeight: 600 }}>رقم المستخدم</th>
                    <th style={{ padding: '4px 8px', fontWeight: 600 }}>الاسم كما أبلغ به الجهاز</th>
                    <th style={{ padding: '4px 8px', fontWeight: 600 }}>الجهاز</th>
                    {onAdd && <th style={{ padding: '4px 8px', fontWeight: 600 }} />}
                  </tr>
                </thead>
                <tbody>
                  {people.map((p) => (
                    <tr key={p.key} data-testid="new-device-user-row" style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '4px 8px', fontFamily: 'Consolas, monospace', direction: 'ltr', textAlign: 'right' }}>{p.zkUserId}</td>
                      <td style={{ padding: '4px 8px', color: p.name ? undefined : 'var(--text-3)' }}>
                        {p.name || NO_NAME_LABEL}
                        {p.nameConflict && <span title={(p.names || []).map((n) => `${n.deviceName || `#${n.deviceId}`}: ${n.name}`).join(' | ')} style={{ color: '#b45309', marginInlineStart: 6 }}>⚠ اسم مختلف على جهاز آخر</span>}
                      </td>
                      <td style={{ padding: '4px 8px' }}>{(p.devices || []).map(label).join('، ')}</td>
                      {onAdd && (
                        <td style={{ padding: '4px 8px', textAlign: 'left', whiteSpace: 'nowrap' }}>
                          {p.addable === false
                            ? <span data-testid="new-device-user-unaddable" style={{ color: '#b45309' }} title={ID_PROBLEM_LABEL[p.problem] || ''}>{ID_PROBLEM_LABEL[p.problem] ? 'لا يمكن إضافته' : 'غير متاح'}</span>
                            : (
                              <button type="button" onClick={() => onAdd(p)} data-testid="new-device-user-add" className="btn-primary text-xs py-1 px-2 rounded-lg flex items-center gap-1"
                                title="فتح نموذج الموظف مع تعبئة الرقم والاسم من الجهاز (لن يُحفظ شيء قبل تأكيدك)">
                                <UserPlus className="w-3.5 h-3.5" /> إضافة موظف
                              </button>
                            )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {reportedDevices.length > 0 && (
            <ul className="text-xs" data-testid="new-device-users-devices" style={{ color: 'var(--text-3)', margin: '8px 0 0', paddingInlineStart: 16 }}>
              {reportedDevices.map((d) => (
                <li key={d.deviceId}>
                  {label(d)}: {d.reported} مستخدم على الجهاز — {d.newCount} جديد · {d.linkedCount} موظف بالفعل{d.reservedCount ? ` · ${d.reservedCount} محجوز لموظف (حسب كود الموظف)` : ''}
                </li>
              ))}
            </ul>
          )}

          {reserved.length > 0 && (
            <p className="text-xs" data-testid="new-device-users-reserved" style={{ color: '#b45309', margin: '6px 0 0' }}>
              أرقام على الأجهزة محجوزة لموظف (حسب كود الموظف) فلا تُعرض كأرقام متاحة: {reserved.map((r) => r.zkUserId).join('، ')}
            </p>
          )}

          {skipped.length > 0 && (
            <p className="text-xs" data-testid="new-device-users-skipped" style={{ color: '#b45309', margin: '6px 0 0' }}>
              <AlertTriangle className="w-3.5 h-3.5" style={{ display: 'inline', verticalAlign: '-2px' }} /> أجهزة لا تُفحص لأن المزامنة التلقائية متوقفة عليها:{' '}
              {skipped.map(label).join('، ')} — لن يظهر هنا أشخاصها.
            </p>
          )}

          {problems.length > 0 && (
            <p className="text-xs" style={{ color: '#b45309', margin: '8px 0 0' }}>
              <AlertTriangle className="w-3.5 h-3.5" style={{ display: 'inline', verticalAlign: '-2px' }} /> تعذرت قراءة المستخدمين من:{' '}
              {problems.map((d) => `${d.deviceName || `#${d.deviceId}`} (${PROBLEM_LABEL[d.status]})`).join('، ')} — القائمة أعلاه قد لا تشملها.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function NewDeviceUsersPanel({ onAdd, reloadToken }) {
  const [state, setState] = useState({ view: null, loading: true, error: false, scanning: false, expanded: true });
  const [ctl, setCtl] = useState(null);
  const ctlRef = useRef(null);
  const firstReload = useRef(true);

  useEffect(() => {
    const c = createNewUsersController({ api, socket: getSocket(), onState: (patch) => setState((s) => ({ ...s, ...patch })) });
    ctlRef.current = c;
    setCtl(c);
    return () => { c.dispose(); ctlRef.current = null; };
  }, []);

  // The Employees page bumps reloadToken after it saved an employee: re-read the list (GET only — never a device scan) so the person
  // just added is no longer presented as new. The very first run is the mount, which the controller already loaded.
  useEffect(() => {
    if (firstReload.current) { firstReload.current = false; return; }
    if (ctlRef.current) ctlRef.current.load();
  }, [reloadToken]);

  return <NewDeviceUsersView {...state} onRetry={() => ctl?.load()} onScan={() => ctl?.scanNow()} onToggle={() => ctl?.toggleExpanded()} onAdd={onAdd} />;
}
