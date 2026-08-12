/**
 * PayrollAuditDrawer — "سجل التغييرات" for one Payroll row.
 *
 * Phase 20.6: reuses the EXISTING audit mechanism (ManualEditAuditLog via
 * GET /payroll/:id/audit, already written by PUT /payroll/:id and
 * PUT /payroll/:id/advances — see routes/payroll.js) — no new audit table,
 * no new endpoint, no new schema. Read-only: this component never mutates
 * payroll data, it only displays what already happened.
 *
 * Uses the shared Drawer primitive (components/ui/Drawer.jsx) — accessible
 * dialog semantics (role, aria-modal, focus trap, focus restoration,
 * Escape-to-close) come from there for free, matching every other
 * Phase 13.9-migrated drawer in the app.
 */
import React, { useEffect, useState } from 'react';
import { History, Loader2 } from 'lucide-react';
import api from '../lib/api';
import Drawer from './ui/Drawer';
import { fmtMoney } from '../lib/formatters';

const FIELD_LABELS = {
  basicSalary: 'الراتب الأساسي',
  bonus: 'مكافأة / بدل',
  manualDeductionAdjustment: 'خصم إداري',
  advances: 'السلف',
  notes: 'ملاحظات',
  status: 'الحالة',
};
const STATUS_VALUE_LABELS = { draft: 'مسودة', finalized: 'معتمد', paid: 'مدفوع' };

function fmtFieldValue(field, value) {
  if (value == null || value === '') return '—';
  if (field === 'status') return STATUS_VALUE_LABELS[value] || value;
  if (['basicSalary', 'bonus', 'manualDeductionAdjustment', 'advances'].includes(field)) {
    const n = Number(value);
    return Number.isFinite(n) ? fmtMoney(n) : value;
  }
  return value;
}

export default function PayrollAuditDrawer({ payrollId, employeeName, open, onClose }) {
  const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState([]);

  useEffect(() => {
    if (!open || !payrollId) return;
    setLoading(true);
    api.get(`/payroll/${payrollId}/audit`)
      .then((r) => setEntries(r.data || []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [open, payrollId]);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      side="left"
      width={420}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <History style={{ width: 16, height: 16, color: 'var(--accent)' }} />
          <span>سجل التغييرات{employeeName ? ` — ${employeeName}` : ''}</span>
        </div>
      }
    >
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '40px 0', color: 'var(--text-3)' }}>
          <Loader2 style={{ width: 18, height: 18, animation: 'spin 1s linear infinite' }} />
          <span style={{ fontSize: 13 }}>جاري التحميل...</span>
        </div>
      ) : entries.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--text-3)', textAlign: 'center', padding: '40px 0' }}>
          لا يوجد سجل تعديلات لهذا الراتب
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {entries.map((e) => (
            <div key={e.id} style={{
              padding: '10px 12px', borderRadius: 8,
              background: 'var(--surface-3)', border: '1px solid var(--border)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>
                  {FIELD_LABELS[e.fieldName] || e.fieldName}
                </span>
                <span style={{ fontSize: 10.5, color: 'var(--text-3)', fontFamily: 'Consolas,monospace', whiteSpace: 'nowrap' }}>
                  {e.createdAt ? new Date(e.createdAt).toLocaleString('ar-EG') : '—'}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 12 }}>
                <span style={{ color: 'var(--c-red)', textDecoration: 'line-through', opacity: 0.75 }}>
                  {fmtFieldValue(e.fieldName, e.oldValue)}
                </span>
                <span style={{ color: 'var(--text-3)' }}>←</span>
                <span style={{ color: 'var(--c-green)', fontWeight: 700 }}>
                  {fmtFieldValue(e.fieldName, e.newValue)}
                </span>
              </div>
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-3)', display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
                <span>بواسطة: {e.modifiedByName || 'غير معروف'}</span>
                {e.reason && <span>السبب: {e.reason}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}
