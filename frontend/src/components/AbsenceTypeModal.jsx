/**
 * AbsenceTypeModal — appears when HR marks a day as غائب.
 * Asks for:  نوع الغياب  (بإذن | بدون إذن | مخصص)
 * Auto-fills penaltyDays based on selection; مخصص lets HR enter any number.
 * Saving calls PUT /attendance/:id/absence-type and propagates to payroll engine.
 */
import React, { useEffect, useId, useState } from 'react';
import { X, ShieldCheck, ShieldX, Settings, CheckCircle } from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';

const TYPES = [
  {
    key: 'with_permission',
    label: 'غياب بإذن',
    sub: 'خصم يوم واحد',
    days: 1,
    Icon: ShieldCheck,
    color: 'var(--c-green, #22c55e)',
  },
  {
    key: 'without_permission',
    label: 'غياب بدون إذن',
    sub: 'خصم يومين',
    days: 2,
    Icon: ShieldX,
    color: 'var(--c-red, #ef4444)',
  },
  {
    key: 'custom',
    label: 'مخصص',
    sub: 'أدخل عدد أيام الخصم',
    days: null,
    Icon: Settings,
    color: 'var(--accent, #2563eb)',
  },
];

export const ABSENCE_TYPE_LABELS = {
  with_permission:    'غياب بإذن',
  without_permission: 'غياب بدون إذن',
  custom:             'مخصص',
};

export default function AbsenceTypeModal({
  isOpen,
  onClose,
  onSave,
  saving = false,
  initialType = null,
  initialPenaltyDays = null,
  initialReason = '',
  employeeName = '',
  dateLabel = '',
}) {
  const [type, setType]         = useState(initialType || 'with_permission');
  const [customDays, setCustomDays] = useState(
    initialType === 'custom' ? (initialPenaltyDays ?? 1) : 1
  );
  const [reason, setReason]     = useState(initialReason || '');

  // Re-initialise when the modal is opened for a different record
  useEffect(() => {
    if (!isOpen) return;
    setType(initialType || 'with_permission');
    setReason(initialReason || '');
    setCustomDays(initialType === 'custom' ? (initialPenaltyDays ?? 1) : 1);
  }, [isOpen, initialType, initialPenaltyDays, initialReason]);

  // Phase 13.9: accessible-dialog semantics (focus trap/restore + Escape).
  const titleId = useId();
  const containerRef = useFocusTrap(isOpen);
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const selected = TYPES.find(t => t.key === type);
  const effectiveDays = type === 'custom'
    ? (parseFloat(customDays) || 0)
    : (selected?.days ?? 1);

  const handleSave = () => {
    if (type === 'custom') {
      const d = parseFloat(customDays);
      if (!Number.isFinite(d) || d < 0) return;
    }
    onSave({ absenceType: type, penaltyDays: effectiveDays, absenceReason: reason });
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(8,12,22,0.82)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        dir="rtl"
        style={{
          background: 'var(--surface, #161B22)',
          border: '1px solid var(--border, rgba(139,148,158,0.18))',
          borderRadius: 12,
          width: '100%', maxWidth: 440,
          padding: '24px',
          boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
          outline: 'none',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <div id={titleId} style={{ fontWeight: 700, fontSize: 16, color: 'var(--text)', fontFamily: 'Cairo, sans-serif' }}>
              نوع الغياب
            </div>
            {(employeeName || dateLabel) && (
              <div style={{ fontSize: 12, color: 'var(--text-muted, #6b7fa3)', marginTop: 2 }}>
                {employeeName}{employeeName && dateLabel ? ' · ' : ''}{dateLabel}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--text-muted, #6b7fa3)', padding: 4, borderRadius: 6,
              display: 'flex', alignItems: 'center',
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Type selection */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
          {TYPES.map(({ key, label, sub, Icon, color, days }) => {
            const active = type === key;
            return (
              <button
                key={key}
                onClick={() => setType(key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '12px 14px',
                  background: active ? `${color}18` : 'var(--bg, #0D1117)',
                  border: `2px solid ${active ? color : 'var(--border, rgba(139,148,158,0.18))'}`,
                  borderRadius: 8, cursor: 'pointer', textAlign: 'right',
                  transition: 'all 0.15s',
                }}
              >
                <Icon size={20} style={{ color, flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: active ? color : 'var(--text)', fontFamily: 'Cairo, sans-serif' }}>
                    {label}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted, #6b7fa3)' }}>
                    {key === 'custom' ? sub : `خصم ${days} ${days === 1 ? 'يوم' : 'أيام'}`}
                  </div>
                </div>
                {active && (
                  <CheckCircle size={16} style={{ color, flexShrink: 0 }} />
                )}
              </button>
            );
          })}
        </div>

        {/* Custom days input */}
        {type === 'custom' && (
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 6, fontFamily: 'Cairo, sans-serif' }}>
              عدد أيام الخصم
            </label>
            <input
              type="number"
              min={0}
              step={0.5}
              value={customDays}
              onChange={e => setCustomDays(e.target.value)}
              style={{
                width: '100%', padding: '8px 12px',
                background: 'var(--bg)', border: '1px solid var(--border)',
                borderRadius: 6, color: 'var(--text)', fontSize: 14,
                fontFamily: 'Cairo, monospace', textAlign: 'center',
              }}
              autoFocus
            />
          </div>
        )}

        {/* Reason */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 6, fontFamily: 'Cairo, sans-serif' }}>
            سبب التعديل (اختياري)
          </label>
          <input
            type="text"
            placeholder="مثال: إجازة مرضية موثقة"
            value={reason}
            onChange={e => setReason(e.target.value)}
            style={{
              width: '100%', padding: '8px 12px',
              background: 'var(--bg)', border: '1px solid var(--border)',
              borderRadius: 6, color: 'var(--text)', fontSize: 13,
              fontFamily: 'Cairo, sans-serif',
            }}
          />
        </div>

        {/* Preview badge */}
        <div style={{
          background: 'rgba(37,99,235,0.10)',
          border: '1px solid rgba(37,99,235,0.25)',
          borderRadius: 8, padding: '10px 14px',
          display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20,
          fontFamily: 'Cairo, sans-serif',
        }}>
          <div style={{ flex: 1, fontSize: 13, color: 'var(--text)' }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>أيام الخصم: </span>
            <strong style={{ color: '#60a5fa', fontSize: 15 }}>{effectiveDays}</strong>
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}> × المعدل اليومي</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'left' }}>
            {ABSENCE_TYPE_LABELS[type]}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={handleSave}
            disabled={saving || (type === 'custom' && !(parseFloat(customDays) >= 0))}
            className="btn-primary"
            style={{ flex: 1, padding: '10px 0', fontSize: 14, fontFamily: 'Cairo, sans-serif', fontWeight: 700 }}
          >
            {saving ? 'جاري الحفظ...' : 'تأكيد'}
          </button>
          <button
            onClick={onClose}
            style={{
              flex: 1, padding: '10px 0', fontSize: 13, fontFamily: 'Cairo, sans-serif',
              background: 'transparent', border: '1px solid var(--border)',
              borderRadius: 6, cursor: 'pointer', color: 'var(--text-muted)',
            }}
          >
            تخطي لاحقاً
          </button>
        </div>
      </div>
    </div>
  );
}
