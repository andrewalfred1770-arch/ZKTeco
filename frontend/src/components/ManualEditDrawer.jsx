/**
 * ManualEditDrawer — HR manual-override editor for a single attendance_daily row.
 *
 * Lets HR override checkIn/checkOut/status/notes (re-runs the same policy math
 * as automatic processing) plus workedMinutes/lateMinutes/earlyLeaveMinutes/
 * overtimeMinutes directly (locks the row with manualEdit=true). Shows a
 * payroll-impact preview before saving, the per-field audit trail after, and
 * a "استرجاع الحساب التلقائي" action to clear manualEdit and let the engine
 * recompute the row again.
 */
import React, { useEffect, useState } from 'react';
import { X, Save, Loader2, History, Calculator, RotateCcw, Fingerprint } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { useTheme } from '../contexts/ThemeContext';
import { minutesToTime, timeToMinutes, fmtTime, fmtMoney, STATUS_LABELS, displayNetSalary } from '../lib/formatters';

const ACTOR = 'مدير النظام';

const STATUS_OPTIONS = ['present', 'late', 'absent', 'early_leave', 'weekend', 'holiday'];

// ── Small layout helpers (consistent with RuleDrawer's Field/Card) ──────────
function Field({ label, children, hint }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:6, minWidth:0 }}>
      {label && <label style={{ fontSize:12.5, fontWeight:700, color:'var(--text-2)' }}>{label}</label>}
      {children}
      {hint && <span style={{ fontSize:11, color:'var(--text-3)', lineHeight:1.5 }}>{hint}</span>}
    </div>
  );
}

function Card({ title, icon:Icon, children, accent='var(--accent)' }) {
  return (
    <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:10, overflow:'hidden' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 14px',
        borderBottom:'1px solid var(--border)', background:'var(--surface-2)' }}>
        {Icon && <Icon style={{ width:15, height:15, color:accent }} />}
        <span style={{ fontSize:12.5, fontWeight:800, color:'var(--text)' }}>{title}</span>
      </div>
      <div style={{ padding:'14px', display:'flex', flexDirection:'column', gap:14 }}>{children}</div>
    </div>
  );
}

export default function ManualEditDrawer({ record, onClose, onSaved }) {
  const { isLight } = useTheme();

  const original = {
    checkIn:  record.checkIn  || '',
    checkOut: record.checkOut || '',
    status:   record.status   || 'present',
    workedMinutes:     record.workedMinutes     || 0,
    lateMinutes:       record.lateMinutes       || 0,
    earlyLeaveMinutes: record.earlyLeaveMinutes || 0,
    overtimeMinutes:   record.overtimeMinutes   ?? Math.round((record.overtimeHours || 0) * 60),
  };

  const [form, setForm]   = useState({ ...original, reason:'' });
  const [saving, setSaving]     = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [preview, setPreview]   = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [audit, setAudit]       = useState(null);
  const [showAudit, setShowAudit] = useState(false);
  const [punches, setPunches]   = useState(null);

  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setPreview(null); };

  // ── Audit history ────────────────────────────────────────────────────────
  const loadAudit = async () => {
    setAudit(null);
    try {
      const { data } = await api.get(`/attendance/daily/${record.id}/audit`);
      setAudit(data);
    } catch { setAudit([]); }
  };
  useEffect(() => { if (showAudit && audit == null) loadAudit(); }, [showAudit]); // eslint-disable-line

  // ── Raw biometric punches for this day ───────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/attendance/logs', {
          params: { employeeId: record.employeeId, from: `${record.date}T00:00:00`, to: `${record.date}T23:59:59`, limit: 50 },
        });
        setPunches(data?.logs || []);
      } catch { setPunches([]); }
    })();
  }, [record.id]); // eslint-disable-line

  // ── Which numeric overrides actually changed (these require `reason`) ────
  const numericChanged = ['workedMinutes', 'lateMinutes', 'earlyLeaveMinutes', 'overtimeMinutes']
    .filter(k => form[k] !== original[k]);
  const needsReason = numericChanged.length > 0;

  function buildPayload() {
    const payload = {
      checkIn:  form.checkIn  || null,
      checkOut: form.checkOut || null,
      status:   form.status,
      modifiedByName: ACTOR,
    };
    for (const k of numericChanged) payload[k] = form[k];
    if (needsReason) payload.reason = form.reason;
    return payload;
  }

  // ── Preview payroll impact — no writes ───────────────────────────────────
  const handlePreview = async () => {
    setPreviewLoading(true);
    try {
      const { data } = await api.post(`/attendance/daily/${record.id}/preview`, buildPayload());
      setPreview(data);
    } catch (err) {
      toast.error('فشل حساب المعاينة: ' + (err.response?.data?.error || err.message));
    } finally { setPreviewLoading(false); }
  };

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (needsReason && !form.reason.trim()) {
      toast.error('سبب التعديل مطلوب عند تعديل القيم المحسوبة يدويًا');
      return;
    }
    setSaving(true);
    try {
      await api.put(`/attendance/daily/${record.id}`, buildPayload());
      toast.success('تم حفظ التعديل');
      onSaved?.();
      onClose();
    } catch (err) {
      toast.error('فشل الحفظ: ' + (err.response?.data?.error || err.message));
    } finally { setSaving(false); }
  };

  // ── Restore automatic calculation ────────────────────────────────────────
  const handleRestoreAuto = async () => {
    setRestoring(true);
    try {
      await api.post(`/attendance/daily/${record.id}/restore-auto`, {
        modifiedByName: ACTOR,
        reason: 'استرجاع الحساب التلقائي من شاشة التعديل اليدوي',
      });
      toast.success('تم استرجاع الحساب التلقائي');
      onSaved?.();
      onClose();
    } catch (err) {
      toast.error('فشل الاسترجاع: ' + (err.response?.data?.error || err.message));
    } finally { setRestoring(false); }
  };

  const inputStyle = { fontFamily:'Consolas,monospace', textAlign:'center', direction:'ltr' };

  return (
    <>
      <div onClick={onClose} style={{ position:'fixed', inset:0, zIndex:60,
        background: isLight ? 'rgba(37,99,235,0.10)' : 'rgba(0,0,0,0.55)', backdropFilter:'blur(3px)' }} />

      <div dir="rtl" style={{
        position:'fixed', top:0, bottom:0, left:0, zIndex:70, width:'min(520px,100vw)',
        background:'var(--bg)', borderRight:'1px solid var(--border)',
        boxShadow:'-8px 0 48px rgba(0,0,0,.4)', display:'flex', flexDirection:'column',
        animation:'slideIn .22s ease' }}>
        <style>{`@keyframes slideIn{from{transform:translateX(-20px);opacity:.6}to{transform:translateX(0);opacity:1}}@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>

        {/* Header */}
        <div style={{ padding:'14px 18px', borderBottom:'1px solid var(--border)',
          background:'linear-gradient(135deg,var(--accent-soft),transparent)',
          borderTop:'3px solid var(--accent)', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <div>
              <h2 style={{ margin:0, fontSize:15, fontWeight:800, color:'var(--text)' }}>
                تعديل يدوي — {record.employeeName}
              </h2>
              <p style={{ margin:'2px 0 0', fontSize:11.5, color:'var(--text-3)' }}>
                {record.employeeCode} · {record.date}
                {record.manualEdit && (
                  <span style={{ marginInlineStart:8, padding:'1px 7px', borderRadius:4, fontSize:10.5,
                    fontWeight:700, background:'rgba(245,158,11,0.15)', color:'#f59e0b', border:'1px solid #f59e0b55' }}>
                    معدّل يدويًا
                  </span>
                )}
              </p>
            </div>
            <button onClick={onClose} style={{ border:'none', background:'var(--surface)', borderRadius:8,
              padding:8, color:'var(--text-3)', cursor:'pointer' }}>
              <X style={{ width:16, height:16 }} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{ flex:1, overflowY:'auto', padding:'16px', display:'flex', flexDirection:'column', gap:14 }}>

          {/* أوقات الحضور */}
          <Card title="أوقات الحضور والحالة">
            <div style={{ display:'flex', gap:12 }}>
              <Field label="وقت الحضور">
                <input type="time" className="input w-full" style={inputStyle}
                  value={form.checkIn} onChange={e => set('checkIn', e.target.value)} />
              </Field>
              <Field label="وقت الانصراف">
                <input type="time" className="input w-full" style={inputStyle}
                  value={form.checkOut} onChange={e => set('checkOut', e.target.value)} />
              </Field>
            </div>
            <Field label="الحالة">
              <select className="input w-full" value={form.status} onChange={e => set('status', e.target.value)}>
                {STATUS_OPTIONS.map(s => <option key={s} value={s}>{STATUS_LABELS[s]?.ar || s}</option>)}
              </select>
            </Field>
          </Card>

          {/* القيم المحسوبة — overrides */}
          <Card title="تعديل القيم المحسوبة (اختياري)" icon={Calculator}>
            <div style={{ display:'flex', gap:12 }}>
              <Field label="ساعات العمل (HH:mm)">
                <input className="input w-full" style={inputStyle}
                  value={minutesToTime(form.workedMinutes)}
                  onChange={e => set('workedMinutes', timeToMinutes(e.target.value) ?? form.workedMinutes)} />
              </Field>
              <Field label="التأخير (HH:mm)">
                <input className="input w-full" style={inputStyle}
                  value={minutesToTime(form.lateMinutes)}
                  onChange={e => set('lateMinutes', timeToMinutes(e.target.value) ?? form.lateMinutes)} />
              </Field>
            </div>
            <div style={{ display:'flex', gap:12 }}>
              <Field label="انصراف مبكر (HH:mm)">
                <input className="input w-full" style={inputStyle}
                  value={minutesToTime(form.earlyLeaveMinutes)}
                  onChange={e => set('earlyLeaveMinutes', timeToMinutes(e.target.value) ?? form.earlyLeaveMinutes)} />
              </Field>
              <Field label="الإضافي (HH:mm)">
                <input className="input w-full" style={inputStyle}
                  value={minutesToTime(form.overtimeMinutes)}
                  onChange={e => set('overtimeMinutes', timeToMinutes(e.target.value) ?? form.overtimeMinutes)} />
              </Field>
            </div>
            {needsReason && (
              <Field label="سبب التعديل *" hint="مطلوب لأن أحد القيم المحسوبة تم تعديله يدويًا — يُسجَّل في سجل التعديلات.">
                <textarea className="input w-full" rows={2} value={form.reason}
                  onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                  placeholder="مثال: تصحيح بناءً على طلب رسمي من الموظف" />
              </Field>
            )}
          </Card>

          {/* معاينة الأثر على الراتب */}
          <Card title="معاينة الأثر على الراتب" icon={Calculator}>
            <button onClick={handlePreview} disabled={previewLoading}
              className="btn-secondary text-xs py-1.5 px-3" style={{ alignSelf:'flex-start' }}>
              {previewLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Calculator className="w-3.5 h-3.5" />}
              معاينة الأثر على الراتب
            </button>
            {preview && (
              <div style={{ display:'flex', flexDirection:'column', gap:8, fontSize:12.5 }}>
                <Row label="الإضافي" cur={fmtMoney(preview.current.overtimeAmount)} prop={fmtMoney(preview.proposed.overtimeAmount)} delta={preview.delta.overtimeAmount} />
                <Row label="الاستقطاعات" cur={fmtMoney(preview.current.deductions)} prop={fmtMoney(preview.proposed.deductions)} delta={-preview.delta.deductions} reverse />
                <Row label="صافي الراتب" cur={fmtMoney(displayNetSalary(preview.current.netSalary))} prop={fmtMoney(displayNetSalary(preview.proposed.netSalary))} delta={preview.delta.netSalary} bold />
              </div>
            )}
          </Card>

          {/* البصمات الخام */}
          <Card title="البصمات الخام لهذا اليوم" icon={Fingerprint}>
            {punches == null ? (
              <div style={{ textAlign:'center', padding:8, color:'var(--text-3)' }}>
                <Loader2 style={{ width:16, height:16, animation:'spin 1s linear infinite' }} />
              </div>
            ) : punches.length === 0 ? (
              <div style={{ fontSize:12.5, color:'var(--text-3)', textAlign:'center' }}>لا توجد بصمات مسجّلة لهذا اليوم.</div>
            ) : (
              <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                {punches.map(p => (
                  <span key={p.id} style={{ padding:'3px 9px', borderRadius:6, fontSize:12,
                    fontFamily:'Consolas,monospace', background:'var(--surface-2)', border:'1px solid var(--border)' }}>
                    {fmtTime(p.timestamp)}
                  </span>
                ))}
              </div>
            )}
          </Card>

          {/* سجل التعديلات */}
          <Card title="سجل التعديلات" icon={History}>
            <button onClick={() => setShowAudit(s => !s)} className="btn-secondary text-xs py-1.5 px-3" style={{ alignSelf:'flex-start' }}>
              <History className="w-3.5 h-3.5" /> {showAudit ? 'إخفاء السجل' : 'عرض السجل'}
            </button>
            {showAudit && (
              audit == null ? (
                <div style={{ textAlign:'center', padding:14, color:'var(--text-3)' }}>
                  <Loader2 style={{ width:18, height:18, animation:'spin 1s linear infinite' }} />
                </div>
              ) : audit.length === 0 ? (
                <div style={{ textAlign:'center', padding:'12px', color:'var(--text-3)', fontSize:12.5 }}>
                  لا توجد تعديلات مسجّلة بعد.
                </div>
              ) : (
                <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                  {audit.map((a, i) => (
                    <div key={a.id || i} style={{ fontSize:12, paddingBottom:8, borderBottom: i < audit.length-1 ? '1px solid var(--border)' : 'none' }}>
                      <div style={{ fontWeight:700, color:'var(--text)' }}>{a.fieldName}</div>
                      <div style={{ color:'var(--text-3)', fontFamily:'Consolas', direction:'ltr', textAlign:'right' }}>
                        {a.oldValue ?? '∅'} → {a.newValue ?? '∅'}
                      </div>
                      {a.reason && <div style={{ color:'var(--text-2)', marginTop:2 }}>السبب: {a.reason}</div>}
                      <div style={{ color:'var(--text-3)', fontSize:11, marginTop:2 }}>
                        {a.modifiedByName || 'HR'} · {a.createdAt ? new Date(a.createdAt).toLocaleString('en-GB') : ''}
                      </div>
                    </div>
                  ))}
                </div>
              )
            )}
          </Card>
        </div>

        {/* Footer */}
        <div style={{ padding:'12px 16px', borderTop:'1px solid var(--border)', flexShrink:0,
          display:'flex', gap:10, alignItems:'center', background:'var(--surface)' }}>
          <button onClick={handleSave} disabled={saving}
            style={{ display:'flex', alignItems:'center', gap:7, padding:'10px 22px', borderRadius:9,
              background:'var(--accent)', color:'#fff', border:'none', fontWeight:700, fontSize:13.5,
              cursor: saving ? 'wait' : 'pointer', opacity: saving ? .7 : 1 }}>
            {saving ? <Loader2 style={{ width:15, height:15, animation:'spin 1s linear infinite' }} />
                    : <Save style={{ width:15, height:15 }} />}
            حفظ التعديل
          </button>
          {record.manualEdit && (
            <button onClick={handleRestoreAuto} disabled={restoring}
              style={{ display:'flex', alignItems:'center', gap:7, padding:'10px 16px', borderRadius:9,
                border:'1px solid #f59e0b55', background:'rgba(245,158,11,0.10)', color:'#f59e0b',
                fontWeight:700, fontSize:13, cursor: restoring ? 'wait' : 'pointer', opacity: restoring ? .7 : 1 }}>
              {restoring ? <Loader2 style={{ width:14, height:14, animation:'spin 1s linear infinite' }} />
                         : <RotateCcw style={{ width:14, height:14 }} />}
              استرجاع الحساب التلقائي
            </button>
          )}
          <button onClick={onClose}
            style={{ padding:'10px 18px', borderRadius:9, border:'1px solid var(--border)',
              background:'transparent', color:'var(--text-2)', fontWeight:600, fontSize:13.5, cursor:'pointer' }}>
            إلغاء
          </button>
        </div>
      </div>
    </>
  );
}

// ── Preview comparison row ───────────────────────────────────────────────────
function Row({ label, cur, prop, delta, reverse, bold }) {
  const positive = reverse ? delta < 0 : delta > 0;
  const color = delta === 0 ? 'var(--text-3)' : positive ? '#16a34a' : '#ef4444';
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
      padding:'8px 10px', borderRadius:8, background:'var(--surface-2)', border:'1px solid var(--border)' }}>
      <span style={{ fontWeight: bold ? 800 : 600, color:'var(--text)' }}>{label}</span>
      <span style={{ fontFamily:'Consolas,monospace', direction:'ltr' }}>
        {cur} → <b>{prop}</b>{' '}
        <span style={{ color, fontWeight:700 }}>
          ({delta > 0 ? '+' : ''}{delta})
        </span>
      </span>
    </div>
  );
}
