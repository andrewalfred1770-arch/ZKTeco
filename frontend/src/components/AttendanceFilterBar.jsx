/**
 * AttendanceFilterBar — reusable filter panel for attendance grids.
 *
 * Always-visible row: quick-filter chips + search box + collapse toggle.
 * Expandable panel: status, absence type, numeric comparisons, overtime,
 * monitored, biometric, department multi-select.
 *
 * Drives useAttendanceFilter — pass the hook's outputs as props.
 */
import React, { useState } from 'react';
import { Search, X, ChevronDown, ChevronUp, Filter } from 'lucide-react';

// ── Quick-filter chip definitions ──────────────────────────────────────────
const QUICK_CHIPS = [
  { key: 'all',                label: 'الكل',          color: 'var(--accent)',   bg: 'var(--accent-soft)' },
  { key: 'absent',             label: 'الغياب',        color: '#dc2626',         bg: 'rgba(220,38,38,0.10)' },
  { key: 'late',               label: 'المتأخرون',     color: '#b45309',         bg: 'rgba(180,83,9,0.10)'  },
  { key: 'deductions',         label: 'الخصومات',      color: '#c2410c',         bg: 'rgba(194,65,12,0.10)' },
  { key: 'overtime',           label: 'الإضافي',        color: '#6d28d9',         bg: 'rgba(109,40,217,0.10)'},
  { key: 'with_permission',    label: 'بإذن',           color: '#15803d',         bg: 'rgba(22,163,74,0.10)' },
  { key: 'without_permission', label: 'بدون إذن',      color: '#991515',         bg: 'rgba(153,21,21,0.10)' },
  { key: 'monitored',          label: 'المميزون',      color: '#b45309',         bg: 'rgba(245,158,11,0.13)'},
  { key: 'incomplete',         label: 'البصمات الناقصة', color: '#0369a1',       bg: 'rgba(3,105,161,0.10)' },
];

const STATUS_OPTIONS = [
  { value: 'present',     label: 'حاضر' },
  { value: 'late',        label: 'متأخر' },
  { value: 'absent',      label: 'غائب' },
  { value: 'early_leave', label: 'انصراف مبكر' },
  { value: 'weekend',     label: 'إجازة أسبوعية' },
  { value: 'holiday',     label: 'عطلة رسمية' },
];

const ABSENCE_OPTIONS = [
  { value: 'with_permission',    label: 'بإذن' },
  { value: 'without_permission', label: 'بدون إذن' },
  { value: 'custom',             label: 'مخصص' },
];

const BIOMETRIC_OPTIONS = [
  { value: 'missing_checkin',  label: 'دخول ناقص' },
  { value: 'missing_checkout', label: 'خروج ناقص' },
  { value: 'no_punches',       label: 'بلا بصمات' },
  { value: 'incomplete',       label: 'بصمات ناقصة' },
];

const OP_OPTIONS = [
  { value: 'none',    label: '—' },
  { value: 'gt',      label: '>' },
  { value: 'lt',      label: '<' },
  { value: 'eq',      label: '=' },
  { value: 'between', label: 'بين' },
];

// ── Small helpers ──────────────────────────────────────────────────────────
function CheckChip({ label, checked, onChange }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '3px 9px', borderRadius: 6, fontSize: 12.5, fontWeight: 600,
        cursor: 'pointer', border: '1px solid',
        background:   checked ? 'var(--accent)'      : 'var(--surface-2)',
        borderColor:  checked ? 'var(--accent)'      : 'var(--border)',
        color:        checked ? '#fff'               : 'var(--text-2)',
        transition:   'all 0.12s',
      }}>
      {label}
    </button>
  );
}

function NumFilter({ op, val, val2, onOp, onVal, onVal2, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <span style={{ fontSize: 12.5, color: 'var(--text-2)', whiteSpace: 'nowrap', fontWeight: 600 }}>{label}</span>
      <select value={op} onChange={e => onOp(e.target.value)} className="input py-0.5 px-1 text-xs" style={{ width: 52 }}>
        {OP_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {op !== 'none' && (
        <input type="number" min="0" step="0.5" value={val} onChange={e => onVal(e.target.value)}
          className="input py-0.5 px-1 text-xs" style={{ width: 54 }} />
      )}
      {op === 'between' && (
        <>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>و</span>
          <input type="number" min="0" step="0.5" value={val2} onChange={e => onVal2(e.target.value)}
            className="input py-0.5 px-1 text-xs" style={{ width: 54 }} />
        </>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────
export default function AttendanceFilterBar({
  filters,
  updateFilter,
  toggleArrayItem,
  applyQuick,
  clearFilters,
  isActive,
  departments = [],   // string[] of available department names
  activeQuick = null, // optional: key of currently active quick preset
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="card" style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 7 }}>

      {/* ── Row 1: Quick filter chips ────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
        {QUICK_CHIPS.map(chip => {
          const isCurrent = activeQuick === chip.key ||
            (chip.key === 'all' && !isActive);
          return (
            <button
              key={chip.key}
              onClick={() => applyQuick(chip.key)}
              style={{
                padding: '3px 11px', borderRadius: 20, fontSize: 12.5, fontWeight: 700,
                cursor: 'pointer', border: '1px solid',
                background:  isCurrent ? chip.color : chip.bg,
                borderColor: isCurrent ? chip.color : 'transparent',
                color:       isCurrent ? '#fff'     : chip.color,
                transition:  'all 0.12s',
              }}>
              {chip.label}
            </button>
          );
        })}

        {/* Spacer */}
        <span style={{ flex: 1 }} />

        {/* Search */}
        <div style={{ position: 'relative', width: 200 }}>
          <Search style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', width: 14, height: 14, color: 'var(--text-3)' }} />
          <input
            type="text"
            placeholder="بحث: اسم، كود، قسم..."
            value={filters.search}
            onChange={e => updateFilter('search', e.target.value)}
            className="input text-xs py-1"
            style={{ paddingRight: 28, paddingLeft: 8, width: '100%' }}
          />
          {filters.search && (
            <button onClick={() => updateFilter('search', '')}
              style={{ position: 'absolute', left: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--text-3)' }}>
              <X style={{ width: 12, height: 12 }} />
            </button>
          )}
        </div>

        {/* Expand toggle */}
        <button
          onClick={() => setOpen(o => !o)}
          style={{
            display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px',
            borderRadius: 6, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
            border: '1px solid',
            background:  open ? 'var(--accent-soft)' : 'var(--surface-2)',
            borderColor: open ? 'var(--accent)'      : 'var(--border)',
            color:       open ? 'var(--accent)'      : 'var(--text-2)',
          }}>
          <Filter style={{ width: 13, height: 13 }} />
          فلاتر متقدمة
          {open ? <ChevronUp style={{ width: 13, height: 13 }} /> : <ChevronDown style={{ width: 13, height: 13 }} />}
        </button>

        {/* Clear */}
        {isActive && (
          <button onClick={clearFilters}
            style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 9px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid rgba(220,38,38,0.35)', background: 'rgba(220,38,38,0.07)', color: '#dc2626' }}>
            <X style={{ width: 13, height: 13 }} />
            مسح الفلاتر
          </button>
        )}
      </div>

      {/* ── Row 2: Advanced panel (collapsible) ─────────────────────────── */}
      {open && (
        <div style={{
          paddingTop: 8, borderTop: '1px solid var(--border)',
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: '10px 20px',
        }}>

          {/* Status */}
          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-3)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>الحالة</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {STATUS_OPTIONS.map(o => (
                <CheckChip
                  key={o.value}
                  label={o.label}
                  checked={filters.statuses.includes(o.value)}
                  onChange={() => toggleArrayItem('statuses', o.value)}
                />
              ))}
            </div>
          </div>

          {/* Absence type */}
          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-3)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>نوع الغياب</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {ABSENCE_OPTIONS.map(o => (
                <CheckChip
                  key={o.value}
                  label={o.label}
                  checked={filters.absenceTypes.includes(o.value)}
                  onChange={() => toggleArrayItem('absenceTypes', o.value)}
                />
              ))}
            </div>
          </div>

          {/* Penalty */}
          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-3)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>أيام الخصم</p>
            <NumFilter
              label="أيام الخصم"
              op={filters.penaltyOp}   val={filters.penaltyVal}  val2={filters.penaltyVal2}
              onOp={v  => updateFilter('penaltyOp', v)}
              onVal={v => updateFilter('penaltyVal', v)}
              onVal2={v=> updateFilter('penaltyVal2', v)}
            />
          </div>

          {/* Late */}
          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-3)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>التأخير (دقيقة)</p>
            <NumFilter
              label="دقائق التأخير"
              op={filters.lateOp}    val={filters.lateVal}
              onOp={v  => updateFilter('lateOp',  v)}
              onVal={v => updateFilter('lateVal', v)}
              onVal2={() => {}}
            />
          </div>

          {/* Early leave */}
          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-3)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>الانصراف المبكر (دقيقة)</p>
            <NumFilter
              label="دقائق الانصراف"
              op={filters.earlyLeaveOp}  val={filters.earlyLeaveVal}
              onOp={v  => updateFilter('earlyLeaveOp',  v)}
              onVal={v => updateFilter('earlyLeaveVal', v)}
              onVal2={() => {}}
            />
          </div>

          {/* Overtime */}
          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-3)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>الإضافي</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ display: 'flex', gap: 5 }}>
                {[['all','الكل'],['has','موجود'],['none','لا يوجد']].map(([v,l]) => (
                  <button key={v} onClick={() => updateFilter('overtimeMode', v)}
                    style={{ padding: '3px 9px', borderRadius: 6, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid',
                      background:  filters.overtimeMode === v ? 'var(--accent)'      : 'var(--surface-2)',
                      borderColor: filters.overtimeMode === v ? 'var(--accent)'      : 'var(--border)',
                      color:       filters.overtimeMode === v ? '#fff'               : 'var(--text-2)',
                    }}>{l}</button>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>أكثر من</span>
                <input type="number" min="0" step="0.5" value={filters.overtimeGt}
                  onChange={e => updateFilter('overtimeGt', e.target.value)}
                  className="input py-0.5 px-1 text-xs" style={{ width: 60 }} placeholder="0" />
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>ساعة</span>
              </div>
            </div>
          </div>

          {/* Monitored */}
          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-3)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>الموظفون المميزون</p>
            <div style={{ display: 'flex', gap: 5 }}>
              {[['all','الكل'],['only','فقط'],['hide','إخفاء']].map(([v,l]) => (
                <button key={v} onClick={() => updateFilter('monitored', v)}
                  style={{ padding: '3px 9px', borderRadius: 6, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid',
                    background:  filters.monitored === v ? '#d97706'                     : 'var(--surface-2)',
                    borderColor: filters.monitored === v ? '#d97706'                     : 'var(--border)',
                    color:       filters.monitored === v ? '#fff'                        : 'var(--text-2)',
                  }}>{l}</button>
              ))}
            </div>
          </div>

          {/* Biometric */}
          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-3)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>حالة البصمات</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {BIOMETRIC_OPTIONS.map(o => (
                <CheckChip
                  key={o.value}
                  label={o.label}
                  checked={filters.biometric.includes(o.value)}
                  onChange={() => toggleArrayItem('biometric', o.value)}
                />
              ))}
            </div>
          </div>

          {/* Departments */}
          {departments.length > 0 && (
            <div>
              <p style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-3)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>القسم</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {departments.map(d => (
                  <CheckChip
                    key={d}
                    label={d}
                    checked={filters.departments.includes(d)}
                    onChange={() => toggleArrayItem('departments', d)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
