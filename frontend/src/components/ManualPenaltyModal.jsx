/**
 * ManualPenaltyModal — unified "تعديل" HR override of an attendance_daily row:
 * late/early/overtime deduction-bonus units, attendance status, and a single
 * HR reason/notes field.
 *
 * This is the FINAL/highest-precedence overlay on top of the Policy Engine's
 * canonical latePenaltyUnits/earlyCheckoutUnits/overtimeRulesUnits (and any
 * approved AttendanceAdjustment). Setting a unit field to empty restores the
 * canonical value (manual* = null). Every change requires a mandatory reason
 * and is written to the same audit trail as ManualEditDrawer.
 */
import React, { useEffect, useState } from 'react';
import { Save, Loader2, History, ShieldOff, RotateCcw } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { fmtPenaltyUnits, fmtOvertimeUnits, STATUS_LABELS } from '../lib/formatters';
import Drawer from './ui/Drawer';

const ACTOR = 'مدير النظام';

// Status options HR can set directly via the unified override modal.
const STATUS_OPTIONS = ['present', 'late', 'absent', 'early_leave', 'holiday'];

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

const inputStyle = { fontFamily:'Consolas,monospace', textAlign:'center', direction:'ltr' };

export default function ManualPenaltyModal({ record, onClose, onSaved }) {
  const originalLate     = record.manualLatePenaltyUnits  ?? null;
  const originalEarly    = record.manualEarlyPenaltyUnits ?? null;
  const originalOvertime = record.manualOvertimeUnits     ?? null;
  const originalStatus   = record.status ?? '';

  const [lateStr, setLateStr]       = useState(originalLate     == null ? '' : String(originalLate));
  const [earlyStr, setEarlyStr]     = useState(originalEarly    == null ? '' : String(originalEarly));
  const [overtimeStr, setOvertimeStr] = useState(originalOvertime == null ? '' : String(originalOvertime));
  const [statusVal, setStatusVal]   = useState(originalStatus);
  const [reason, setReason]         = useState('');
  const [saving, setSaving]         = useState(false);
  const [audit, setAudit]           = useState(null);
  const [showAudit, setShowAudit]   = useState(false);

  const loadAudit = async () => {
    setAudit(null);
    try {
      const { data } = await api.get(`/attendance/daily/${record.id}/audit`);
      setAudit(data);
    } catch { setAudit([]); }
  };
  useEffect(() => { if (showAudit && audit == null) loadAudit(); }, [showAudit]); // eslint-disable-line

  // null = "restore canonical" (inherit Policy Engine value)
  const parsedLate      = lateStr      === '' ? null : Number(lateStr);
  const parsedEarly     = earlyStr     === '' ? null : Number(earlyStr);
  const parsedOvertime  = overtimeStr  === '' ? null : Number(overtimeStr);

  const lateChanged      = parsedLate      !== originalLate;
  const earlyChanged     = parsedEarly     !== originalEarly;
  const overtimeChanged  = parsedOvertime  !== originalOvertime;
  const statusChanged    = statusVal !== originalStatus && statusVal !== '';
  const needsReason  = lateChanged || earlyChanged || overtimeChanged || statusChanged;

  const invalid =
    (parsedLate      != null && (!Number.isFinite(parsedLate)      || parsedLate      < 0)) ||
    (parsedEarly     != null && (!Number.isFinite(parsedEarly)     || parsedEarly     < 0)) ||
    (parsedOvertime  != null && (!Number.isFinite(parsedOvertime)  || parsedOvertime  < 0 || parsedOvertime > 24));

  // EF-015.1: worked-hours-vs-manual-overtime mismatch is a WARNING only —
  // it never blocks save (HR may intentionally override overtime after
  // approval). The existing 0–24 bound above is the only rejection rule.
  const workedHoursNum = parseFloat(record.workedHours);
  const overtimeMismatch = parsedOvertime != null && Number.isFinite(workedHoursNum) && parsedOvertime !== workedHoursNum;

  const exemptAll = () => { setLateStr('0'); setEarlyStr('0'); };
  const restoreOriginal = () => { setLateStr(''); setEarlyStr(''); setOvertimeStr(''); setStatusVal(originalStatus); };

  const handleSave = async () => {
    if (parsedOvertime != null && parsedOvertime > 24) {
      toast.error('قيمة الإضافي اليدوي لا يمكن أن تتجاوز 24 ساعة لليوم الواحد'); return;
    }
    if (invalid) { toast.error('قيمة الخصم/الإضافي يجب أن تكون رقمًا أكبر من أو يساوي صفر'); return; }
    if (!needsReason) { toast.error('لم يتم تغيير أي قيمة'); return; }
    if (!reason.trim()) { toast.error('سبب التعديل مطلوب'); return; }

    setSaving(true);
    try {
      const payload = { overrideReason: reason, modifiedByName: ACTOR };
      if (lateChanged)      payload.manualLatePenaltyUnits  = parsedLate;
      if (earlyChanged)     payload.manualEarlyPenaltyUnits = parsedEarly;
      if (overtimeChanged)  payload.manualOvertimeUnits     = parsedOvertime;
      if (statusChanged)    payload.status = statusVal;
      await api.put(`/attendance/${record.id}/manual-penalty`, payload);
      toast.success('تم حفظ التعديل اليدوي');
      onSaved?.();
      onClose();
    } catch (err) {
      toast.error('فشل الحفظ: ' + (err.response?.data?.error || err.message));
    } finally { setSaving(false); }
  };

  const originalOvertimeBase = record.originalOvertimeUnits ?? record.overtimeRulesUnits ?? record.overtimeHours ?? 0;

  return (
    <Drawer
      open
      onClose={onClose}
      width={480}
      panelStyle={{
        background: 'var(--bg)',
        borderTop: '3px solid #f59e0b',
      }}
      title={
        <>
          تعديل يدوي — {record.employeeName}
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', fontWeight: 400, marginTop: 2 }}>
            {record.employeeCode} · {record.date}
          </div>
        </>
      }
      footer={
        <>
          <button onClick={handleSave} disabled={saving || !needsReason}
            style={{ display:'flex', alignItems:'center', gap:7, padding:'10px 22px', borderRadius:9,
              background:'var(--accent)', color:'#fff', border:'none', fontWeight:700, fontSize:13.5,
              cursor: (saving || !needsReason) ? 'not-allowed' : 'pointer', opacity: (saving || !needsReason) ? .6 : 1 }}>
            {saving ? <Loader2 style={{ width:15, height:15, animation:'spin 1s linear infinite' }} />
                    : <Save style={{ width:15, height:15 }} />}
            حفظ التعديل
          </button>
          <button onClick={onClose}
            style={{ padding:'10px 18px', borderRadius:9, border:'1px solid var(--border)',
              background:'transparent', color:'var(--text-2)', fontWeight:600, fontSize:13.5, cursor:'pointer' }}>
            إلغاء
          </button>
        </>
      }
    >
      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>

        {/* Body */}
        <div style={{ display:'flex', flexDirection:'column', gap:14 }}>

          {/* القيمة المحسوبة */}
          <Card title="القيمة المحسوبة (Policy Engine)">
            <div style={{ display:'flex', gap:12 }}>
              <Field label="خصم التأخير">
                <div className="input w-full" style={{ ...inputStyle, color:'var(--text-2)', background:'var(--surface-2)' }}>
                  {fmtPenaltyUnits(record.latePenaltyUnits)}
                </div>
              </Field>
              <Field label="خصم الانصراف المبكر">
                <div className="input w-full" style={{ ...inputStyle, color:'var(--text-2)', background:'var(--surface-2)' }}>
                  {fmtPenaltyUnits(record.earlyCheckoutUnits)}
                </div>
              </Field>
              <Field label="الإضافي">
                <div className="input w-full" style={{ ...inputStyle, color:'var(--text-2)', background:'var(--surface-2)' }}>
                  {fmtOvertimeUnits(originalOvertimeBase)}
                </div>
              </Field>
            </div>
          </Card>

          {/* التعديل اليدوي */}
          <Card title="التعديل اليدوي" icon={ShieldOff} accent="#f59e0b">
            <div style={{ display:'flex', gap:12, flexWrap:'wrap' }}>
              <Field label="خصم التأخير الفعلي" hint="ساعات كاملة فقط (0، 1، 2، 3، 4) — اتركه فارغًا للقيمة المحسوبة">
                <input className="input w-full" style={inputStyle} type="number" min="0" step="1"
                  placeholder={fmtPenaltyUnits(record.latePenaltyUnits) === '—' ? '0' : String(record.latePenaltyUnits)}
                  value={lateStr} onChange={e => setLateStr(e.target.value)} />
              </Field>
              <Field label="خصم الانصراف المبكر الفعلي" hint="ساعات كاملة فقط (0، 1، 2، 3، 4) — اتركه فارغًا للقيمة المحسوبة">
                <input className="input w-full" style={inputStyle} type="number" min="0" step="1"
                  placeholder={fmtPenaltyUnits(record.earlyCheckoutUnits) === '—' ? '0' : String(record.earlyCheckoutUnits)}
                  value={earlyStr} onChange={e => setEarlyStr(e.target.value)} />
              </Field>
              <Field label="الإضافي الفعلي" hint="اتركه فارغًا للاعتماد على القيمة المحسوبة">
                <input className="input w-full" style={inputStyle} type="number" min="0" max="24" step="0.5"
                  placeholder={fmtOvertimeUnits(originalOvertimeBase) === '—' ? '0' : String(originalOvertimeBase)}
                  value={overtimeStr} onChange={e => setOvertimeStr(e.target.value)} />
              </Field>
            </div>

            {/* EF-015.1: non-blocking mismatch notice — worked hours vs the
                manually-entered overtime value. Never prevents saving. */}
            {overtimeMismatch && (
              <div style={{
                display: 'flex', alignItems: 'flex-start', gap: 8,
                padding: '10px 12px', borderRadius: 8,
                background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.35)',
              }}>
                <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>⚠️</span>
                <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6 }}>
                  <b style={{ color: '#f59e0b' }}>تنبيه</b> — عدد ساعات الإضافي اليدوي ({parsedOvertime}) لا يطابق
                  عدد ساعات العمل الفعلية لهذا اليوم ({workedHoursNum}). يرجى التأكد من صحة البيانات.
                </div>
              </div>
            )}
            <Field label="الحالة">
              <select className="input w-full" value={statusVal} onChange={e => setStatusVal(e.target.value)}>
                {STATUS_OPTIONS.map(s => (
                  <option key={s} value={s}>{STATUS_LABELS[s]?.ar || s}</option>
                ))}
              </select>
            </Field>

            <div style={{ display:'flex', gap:8 }}>
              <button onClick={exemptAll} className="btn-secondary text-xs py-1.5 px-3">
                <ShieldOff className="w-3.5 h-3.5" /> إعفاء كامل (خصم 0)
              </button>
              <button onClick={restoreOriginal} className="btn-secondary text-xs py-1.5 px-3">
                <RotateCcw className="w-3.5 h-3.5" /> استرجاع الأصل
              </button>
            </div>

            {needsReason && (
              <Field label="ملاحظات HR *" hint="إجراء مثل (إذن صباحي) — يُسجَّل في سجل التعديلات ويظهر في التقارير.">
                <textarea className="input w-full" rows={2} value={reason}
                  onChange={e => setReason(e.target.value)}
                  placeholder="مثال: إذن صباحي معتمد من المدير المباشر" />
              </Field>
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
    </Drawer>
  );
}
