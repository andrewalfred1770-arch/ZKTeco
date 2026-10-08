/**
 * PasteAttendanceModal — preview step of "نسخ / لصق الحركة" on the Daily
 * Attendance page.
 *
 * Presentation only. It shows, for the ONE target row, the current value of
 * every copyable field next to the value that would be applied, lets the user
 * tick exactly which fields to paste, and hands the chosen field keys back to
 * the page. The page then saves through the SAME endpoints and validation the
 * inline grid already uses (PUT /attendance/daily/:id and
 * PUT /attendance/:id/manual-penalty) — nothing is computed or saved here.
 *
 * Only the fields listed in FIELDS can ever be pasted: never an employee id,
 * personal data, or audit metadata.
 */
import React, { useEffect, useState } from 'react';
import Dialog from './ui/Dialog';
import { STATUS_LABELS, fmtWorkedHours, fmtPenaltyUnits, fmtOvertimeUnits } from '../lib/formatters';

const time  = (v) => v || '—';
const label = (v) => STATUS_LABELS[v]?.ar || '—';

// `locked` mirrors the grid: on an official-holiday row the time / worked /
// penalty / overtime cells are not editable (only the status cell is).
export const PASTE_FIELDS = [
  { key: 'checkIn',                label: 'الحضور',               fmt: time,               defaultOn: true,  lockedOnHoliday: true  },
  { key: 'checkOut',               label: 'الانصراف',             fmt: time,               defaultOn: true,  lockedOnHoliday: true  },
  { key: 'status',                 label: 'الحالة',               fmt: label,              defaultOn: true,  lockedOnHoliday: false },
  { key: 'workedMinutes',          label: 'ساعات العمل',          fmt: fmtWorkedHours,     defaultOn: false, lockedOnHoliday: true  },
  { key: 'effectiveLatePenalty',   label: 'خصم التأخير (يدوي)',   fmt: fmtPenaltyUnits,    defaultOn: false, lockedOnHoliday: true  },
  { key: 'effectiveEarlyPenalty',  label: 'خصم الانصراف المبكر (يدوي)', fmt: fmtPenaltyUnits, defaultOn: false, lockedOnHoliday: true },
  { key: 'effectiveOvertimeUnits', label: 'الإضافي (يدوي)',       fmt: fmtOvertimeUnits,   defaultOn: false, lockedOnHoliday: true  },
];

export default function PasteAttendanceModal({ open, onClose, onApply, saving = false, clip, target }) {
  const isLocked = (f) => !!(target?.isHoliday && f.lockedOnHoliday);

  const [picked, setPicked] = useState(() => new Set());

  // Re-seed the default selection every time the dialog opens for a target.
  useEffect(() => {
    if (!open || !target) return;
    setPicked(new Set(PASTE_FIELDS.filter(f => f.defaultOn && !(target.isHoliday && f.lockedOnHoliday)).map(f => f.key)));
  }, [open, target]);

  if (!open || !clip || !target) return null;

  const toggle = (key) => setPicked(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const count = picked.size;
  const cellStyle = { padding: '7px 8px', fontSize: 12.5, borderBottom: '1px solid var(--border-2)' };

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      closeOnOverlay={!saving}
      showClose={!saving}
      title="لصق الحركة — معاينة قبل التطبيق"
      maxWidth={640}
      footer={(
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-ghost text-xs py-1.5 px-3" onClick={onClose} disabled={saving}>إلغاء</button>
          <button
            type="button"
            className="btn-primary text-xs py-1.5 px-3"
            disabled={saving || count === 0}
            onClick={() => onApply([...picked])}
          >
            {saving ? 'جاري الحفظ…' : `تطبيق (${count})`}
          </button>
        </div>
      )}
    >
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }} dir="rtl">
        <div style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.7 }}>
          <div>من: <strong style={{ color: 'var(--text)' }}>{clip.sourceName}</strong>{clip.sourceCode ? ` (${clip.sourceCode})` : ''} — {clip.sourceDate}</div>
          <div>إلى: <strong style={{ color: 'var(--text)' }}>{target.employeeName}</strong>{target.employeeCode ? ` (${target.employeeCode})` : ''} — {target.date}</div>
          <div style={{ marginTop: 4 }}>
            سيُسجَّل كتعديل يدوي عادي بنفس التحقق والتدقيق المستخدمين في التعديل من الجدول، ولن يُنسخ أي معرّف موظف أو بيانات شخصية.
          </div>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'right', color: 'var(--text-3)', fontSize: 11.5 }}>
              <th style={{ ...cellStyle, width: 36 }} />
              <th style={cellStyle}>الحقل</th>
              <th style={cellStyle}>القيمة الحالية</th>
              <th style={cellStyle}>ستصبح</th>
            </tr>
          </thead>
          <tbody>
            {PASTE_FIELDS.map((f) => {
              const locked  = isLocked(f);
              const current = f.fmt(target[f.key]);
              const next    = f.fmt(clip[f.key]);
              const same    = current === next;
              return (
                <tr key={f.key} style={{ opacity: locked ? 0.5 : 1 }}>
                  <td style={cellStyle}>
                    <input
                      type="checkbox"
                      checked={picked.has(f.key) && !locked}
                      disabled={locked || saving}
                      onChange={() => toggle(f.key)}
                      aria-label={f.label}
                    />
                  </td>
                  <td style={{ ...cellStyle, fontWeight: 600 }}>
                    {f.label}
                    {locked && <span style={{ color: 'var(--text-3)', fontWeight: 400 }}> — مقفل (عطلة رسمية)</span>}
                  </td>
                  <td style={cellStyle}>{current}</td>
                  <td style={{ ...cellStyle, fontWeight: 700, color: same ? 'var(--text-3)' : 'var(--accent, #2563eb)' }}>
                    {next}{same && !locked ? ' (بدون تغيير)' : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}
