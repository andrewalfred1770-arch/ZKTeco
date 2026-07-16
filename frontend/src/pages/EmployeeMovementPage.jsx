import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';
import {
  UserSquare2, Download, Play,
  CheckCircle, XCircle, Clock, TrendingUp, AlertTriangle,
  Loader2, ChevronLeft, ChevronRight, Printer, Pencil,
  Zap, ZapOff,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { AG_GRID_LOCALE_AR } from '../lib/agGridLocale';
import {
  westernDigits, fmtPenaltyUnits, fmtOvertimeUnits, formatHours, fmtEditableZero,
  fmtTime, fmtWorkedHours, timeToMinutes, STATUS_LABELS, manualOverrideTooltip,
} from '../lib/formatters';
import { useTheme } from '../contexts/ThemeContext';
import PrintPreviewModal from '../components/PrintPreviewModal';
import ManualPenaltyModal from '../components/ManualPenaltyModal';
import { useRulesLiveSync } from '../hooks/useRulesLiveSync';
import { ENTERPRISE_DEFAULT_COL_DEF, ENTERPRISE_GRID_PROPS, COL_MEDIUM, tabToNextCell, safeRefreshCells as sharedSafeRefreshCells } from '../lib/gridDefaults';
import { nameCell, codeCell } from '../lib/cellStyles';
import { useDeviceLiveSync } from '../hooks/useDeviceLiveSync';
import TimeCellEditor from '../components/grid/TimeCellEditor';
import AbsenceTypeModal, { ABSENCE_TYPE_LABELS } from '../components/AbsenceTypeModal';
import AttendanceFilterBar from '../components/AttendanceFilterBar';
import { useAttendanceFilter } from '../hooks/useAttendanceFilter';
import { ACTOR, HHMM_RE, OVERRIDE_FIELD_MAP, toHHMM, replaceAttendanceRow, applyRowFieldUpdate } from '../lib/attendanceUtils';
import { MONTHS_AR } from '../lib/constants';

// ─── Constants ────────────────────────────────────────────────────────────────
const NUM  = { textAlign:'right', direction:'ltr', fontFamily:'Consolas,monospace', fontWeight:'600', fontVariantNumeric:'tabular-nums' };
const W    = (v) => westernDigits(String(v ?? 0));

const INLINE_REASON = 'تعديل مباشر من حركة الموظف';

const STATUS_MAP = {
  present:     { ar:'حاضر',          cls:'badge-green',  row:'row-present'  },
  late:        { ar:'متأخر',          cls:'badge-yellow', row:'row-late'     },
  absent:      { ar:'غائب',           cls:'badge-red',    row:'row-absent'   },
  early_leave: { ar:'انصراف مبكر',   cls:'badge-yellow', row:'row-late'     },
  weekend:     { ar:'إجازة أسبوعية', cls:'badge-gray',   row:'row-weekend'  },
  holiday:     { ar:'عطلة رسمية',    cls:'badge-blue',   row:'row-holiday'  },
};

const STATUS_FILTER_OPTIONS = [
  { value:'',            label:'كل الحالات' },
  { value:'present',     label:'حاضر' },
  { value:'late',        label:'متأخر' },
  { value:'absent',      label:'غائب' },
  { value:'early_leave', label:'انصراف مبكر' },
  { value:'weekend',     label:'إجازة أسبوعية' },
  { value:'holiday',     label:'عطلة رسمية' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Convert backend's "08:30 AM" / "02:00 PM" → "08:30" / "14:00" 24-hour.
// TimeCellEditor and PUT API both use 24-hour; fmtTime() converts back for display.
function convert12to24(t) {
  if (!t) return null;
  const match = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return t; // already 24-hour or unrecognised — pass through
  let h = parseInt(match[1]);
  const min = match[2];
  const ampm = match[3].toUpperCase();
  if (ampm === 'AM' && h === 12) h = 0;
  if (ampm === 'PM' && h !== 12) h += 12;
  return `${String(h).padStart(2,'0')}:${min}`;
}

function normalizeDailyUpdate(updated) {
  // Raw morning/evening OT (hours) — display-only breakdown, straight renames
  // of the backend's own fields, not recomputed.
  const rawMorningOT = updated.morningOvertimeHours || 0;
  const rawEveningOT = updated.eveningOvertimeHours || 0;

  // Spread ALL raw API fields first — this is the critical fix that propagates
  // lateMinutes, isAbsent, earlyLeaveMinutes, manualEdit, isWeekend, isHoliday,
  // penaltyDays, absenceType and every other field to computeSummaryFromDays,
  // the grid, and filteredDays (print/PDF/Excel source).
  // Then apply movement-specific field-name aliases only — every canonical
  // attendance value (effectiveLatePenalty, effectiveEarlyPenalty,
  // effectiveOvertimeUnits, effectiveTotalDeductionUnits, status, ...) is the
  // backend's own value, never recomputed here. The Attendance Engine is the
  // only source of truth.
  // `date` is intentionally excluded — the row keeps its "YYYY-MM-DD" display string.
  const { date: _ignoreDate, ...rawRest } = updated;
  return {
    ...rawRest,
    // Formatted display times (override raw Date objects from API)
    checkIn:  toHHMM(updated.checkIn),
    checkOut: toHHMM(updated.checkOut),
    // Movement-page field aliases — same value, renamed/reformatted for this page's columns
    workedMinutes: updated.workedMinutes || 0,
    workedHours:   parseFloat(((updated.workedMinutes || 0) / 60).toFixed(2)),
    morningOT:     rawMorningOT,
    eveningOT:     rawEveningOT,
    // Friday-OT certification fix: totalOT must equal effectiveOvertimeUnits,
    // not rawMorningOT+rawEveningOT — both are structurally 0 on any weekend/
    // holiday day (including Friday configured as weekend), so summing them
    // silently excluded that OT from the "ساعات الإضافي" KPI after an inline
    // edit. Matches the same fix in routes/attendance.js's buildMovementDays().
    totalOT:       updated.effectiveOvertimeUnits || 0,
    latePenalty:   updated.latePenaltyUnits   || 0,
    earlyPenalty:  updated.earlyCheckoutUnits || 0,
    totalDeductions: updated.totalDeductionUnits || 0,
    // Effective (canonical) values — taken as-is from the backend response
    effectiveLatePenalty:    updated.effectiveLatePenalty    || 0,
    effectiveEarlyPenalty:   updated.effectiveEarlyPenalty   || 0,
    effectiveOvertimeUnits:  updated.effectiveOvertimeUnits  || 0,
    effectiveTotalDeductions: updated.effectiveTotalDeductionUnits || 0,
    status: updated.status,
  };
}

// Recompute summary totals from the current days array after an inline edit,
// so KPI cards + pinned totals bar stay live without a full server roundtrip.
// effectiveDeductAmount (units × hourlyRate, no multiplier) requires
// hourlyRate, preserved from the last backend response via prevSummary.
// EF-004.1: otAmount/effectiveNetEffect are NOT recomputed here — the
// backend applies a per-day overtime multiplier (Friday/holiday/weekend
// rules) this function has no access to; approximating with a flat
// multiplier would silently disagree with the real payroll figure. Both are
// carried forward unchanged from prevSummary (via the spread below) until
// applyUpdate's background refresh replaces them with the authoritative
// backend value — briefly stale rather than wrong.
function computeSummaryFromDays(days, prevSummary) {
  const hourlyRate = prevSummary?.hourlyRate || 0;
  const presentDays = days.filter(d =>
    !d.isWeekend && !d.isHoliday && !d.isAbsent
  ).length;
  const absentDays = days.filter(d =>
    !d.isWeekend && !d.isHoliday && d.isAbsent
  ).length;
  // EP-024.2: mirrors backend summarizeMovementDays' totalPenaltyDays — sums
  // only explicit penaltyDays values (matches what the "أيام الخصم" column
  // itself displays; a null penaltyDays row shows blank, so it contributes 0
  // here too, keeping the footer an exact SUM of the visible grid column).
  const totalPenaltyDays = days
    .filter(d => !d.isWeekend && !d.isHoliday && d.isAbsent)
    .reduce((s, d) => s + (d.penaltyDays || 0), 0);
  const totalWorkedHours = parseFloat(
    days.reduce((s, d) => s + (d.workedMinutes || 0) / 60, 0).toFixed(2)
  );
  const totalLateMinutes = days.reduce((s, d) => s + (d.lateMinutes || 0), 0);
  const totalOTHours = parseFloat(
    days.reduce((s, d) => s + (d.totalOT || 0), 0).toFixed(2)
  );
  const totalEffectiveOvertimeUnits = parseFloat(
    days.reduce((s, d) => s + (d.effectiveOvertimeUnits || 0), 0).toFixed(2)
  );
  const totalEffectiveLatePenalty = parseFloat(
    days.reduce((s, d) => s + (d.effectiveLatePenalty || 0), 0).toFixed(2)
  );
  const totalEffectiveEarlyPenalty = parseFloat(
    days.reduce((s, d) => s + (d.effectiveEarlyPenalty || 0), 0).toFixed(2)
  );
  const totalEffectiveDeductionUnits = parseFloat(
    days.reduce((s, d) => s + (d.effectiveTotalDeductions || 0), 0).toFixed(2)
  );
  const effectiveDeductAmount = Math.round(totalEffectiveDeductionUnits * hourlyRate);
  return {
    ...prevSummary,
    presentDays, absentDays, totalPenaltyDays,
    totalWorkedHours, totalLateMinutes,
    totalOTHours, totalEffectiveOvertimeUnits,
    totalEffectiveLatePenalty, totalEffectiveEarlyPenalty,
    totalEffectiveDeductionUnits,
    effectiveDeductAmount,
  };
}

// Normalise the raw API response: convert times + add workedMinutes.
function processData(raw) {
  if (!raw) return null;
  return {
    ...raw,
    days: (raw.days || []).map(d => ({
      ...d,
      checkIn:  convert12to24(d.checkIn),
      checkOut: convert12to24(d.checkOut),
      workedMinutes: Math.round((d.workedHours || 0) * 60),
    })),
  };
}

// Effective per-day status (for status filter)
function getEffectiveStatus(d) {
  if (!d) return null;
  if (d.isWeekend) return 'weekend';
  if (d.isHoliday) return 'holiday';
  if (d.isAbsent) return 'absent';
  return d.status || 'present';
}

// ─── Filter persistence ───────────────────────────────────────────────────────
const FILTERS_KEY = 'movementLedgerFilters';
function loadSavedFilters() {
  try { return JSON.parse(localStorage.getItem(FILTERS_KEY)) || {}; } catch { return {}; }
}

// ─── KPI card ─────────────────────────────────────────────────────────────────
function KpiCard({ label, value, unit, icon: Icon, color, sub }) {
  const { isLight } = useTheme();
  return (
    <div className="card p-3 flex items-start gap-2.5" style={{ minWidth:0 }}>
      <div className="flex-shrink-0 p-2 rounded-lg" style={{ background: color + (isLight ? '22' : '18') }}>
        <Icon className="w-4 h-4" style={{ color }} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs" style={{ color:'var(--erp-text-muted)' }}>{label}</p>
        <p className="font-bold text-xl tabular-nums" style={{ color:'var(--erp-text)', fontFamily:'Consolas,monospace', fontVariantNumeric:'tabular-nums' }}>
          {W(value)}<span className="text-xs font-normal ml-1" style={{ color:'var(--erp-text-muted)' }}>{unit}</span>
        </p>
        {sub && <p className="text-xs mt-0.5" style={{ color:'var(--erp-text-faint)' }}>{sub}</p>}
      </div>
    </div>
  );
}

// ─── Status badge cell ─────────────────────────────────────────────────────────
const StatusCell = ({ data }) => {
  if (!data) return null;
  if (data.isWeekend) return <span className="badge badge-gray">إجازة أسبوعية</span>;
  if (data.isHoliday) return <span className="badge badge-blue">عطلة رسمية</span>;
  if (data.isAbsent) return <span className="badge badge-red">غائب</span>;
  const s = STATUS_MAP[data.status];
  if (s) return <span className={`badge ${s.cls}`}>{s.ar}</span>;
  return <span className="badge badge-gray">{data.status}</span>;
};

// ─── Main page ─────────────────────────────────────────────────────────────────
export default function EmployeeMovementPage() {
  const { agGridTheme, isLight } = useTheme();
  const gridRef = useRef();
  const editCountRef   = useRef(0);
  const pendingReloadRef = useRef(false);
  const moneyRefreshTokenRef = useRef(0); // EF-004.1: discard out-of-order money-summary responses

  const [employees,   setEmployees]   = useState([]);
  const [branches,    setBranches]    = useState([]);
  const [departments, setDepartments] = useState([]);
  const [data,        setData]        = useState(null);
  const [gridRows,    setGridRows]    = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [printOpen,   setPrintOpen]   = useState(false);
  const [penaltyRow,  setPenaltyRow]  = useState(null);
  const [quickEdit, setQuickEdit] = useState(() => {
    // Persist across reloads — default ON (true) for Excel-like UX
    const saved = localStorage.getItem('movement_quick_edit');
    return saved === null ? true : saved === 'true';
  });
  const [absenceModal, setAbsenceModal] = useState(null);
  const [absenceSaving, setAbsenceSaving] = useState(false);

  // ── Filter system ─────────────────────────────────────────────────────────
  const {
    filters, updateFilter, toggleArrayItem, applyQuick, clearFilters,
    doesPassFilter, isActive: filterActive, gridApiRef: filterGridApiRef,
  } = useAttendanceFilter();

  const now = new Date();
  const saved = useMemo(loadSavedFilters, []);
  const [empId,        setEmpId]        = useState(saved.empId || '');
  const [branchId,     setBranchId]     = useState(saved.branchId || '');
  const [departmentId, setDepartmentId] = useState(saved.departmentId || '');
  const [statusFilter, setStatusFilter] = useState(saved.statusFilter || '');
  const [month,        setMonth]        = useState(saved.month || `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`);

  // Per-cell visual state refs (read at AG Grid render time — no state re-render needed)
  const savingCellsRef = useRef(new Set());
  const savedCellsRef  = useRef(new Set());
  const errorCellsRef  = useRef(new Set());

  // markSaved()/markError() defer a cell-highlight cleanup via setTimeout. If
  // the component unmounts (navigate away) before that timeout fires, the
  // callback used to still run against a destroyed/replaced grid — tracked
  // here so every pending timer is cancelled on unmount, and never merely
  // caught-and-ignored.
  const pendingTimersRef = useRef(new Set());
  useEffect(() => () => {
    pendingTimersRef.current.forEach(clearTimeout);
    pendingTimersRef.current.clear();
  }, []);

  // Single guarded entry point for every deferred/delayed grid touch in this
  // component — refreshCells() must never run against a destroyed grid, a
  // torn-down api, or a rowNode that no longer exists in the current model.
  // Checked explicitly (not merely try/caught) so a stale call is a silent,
  // expected no-op rather than swallowed noise.
  const safeRefreshCells = useCallback((rowId, node, columns) => {
    sharedSafeRefreshCells(gridRef, rowId, node, columns);
  }, []);

  useEffect(() => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ empId, branchId, departmentId, statusFilter, month }));
  }, [empId, branchId, departmentId, statusFilter, month]);

  useEffect(() => {
    Promise.all([api.get('/employees'), api.get('/branches'), api.get('/departments')])
      .then(([e, b, d]) => { setEmployees(e.data); setBranches(b.data); setDepartments(d.data); })
      .catch(() => {});
  }, []);

  // Guarded regardless of trigger (background live-sync OR manual refresh
  // button) — either can replace rowData mid-edit otherwise.
  const load = useCallback(async (showLoading = false) => {
    if (editCountRef.current > 0) { pendingReloadRef.current = true; return; }
    if (showLoading) setLoading(true);
    try {
      const { data: raw } = await api.get('/attendance/movement', {
        params: {
          employeeId:   empId        || undefined,
          month,
          branchId:     branchId     || undefined,
          departmentId: departmentId || undefined,
        },
      });
      const processed = processData(raw);
      setData(processed);
      setGridRows(processed?.days || []);
    } catch { toast.error('تعذر تحميل كشف الحضور'); }
    finally { if (showLoading) setLoading(false); }
  }, [empId, month, branchId, departmentId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(true); }, [load]);
  useRulesLiveSync(load, { isBusyRef: editCountRef });
  useDeviceLiveSync(load, { silent: true, isBusyRef: editCountRef });

  const shiftMonth = (d) => {
    const [y, m] = month.split('-').map(Number);
    const nd = new Date(y, m - 1 + d, 1);
    setMonth(`${nd.getFullYear()}-${String(nd.getMonth()+1).padStart(2,'0')}`);
  };

  const isAll = data?.mode !== 'single';

  // filteredDays is only for print preview — NOT used as AG Grid rowData.
  const filteredDays = useMemo(() => {
    const rows = data?.days || [];
    if (!statusFilter) return rows;
    return rows.filter(r => getEffectiveStatus(r) === statusFilter);
  }, [data, statusFilter]);

  // AG Grid external filter — keeps the statusFilter active without changing
  // the rowData prop (which would scroll the grid and cancel active edits).
  const statusFilterRef = useRef(statusFilter);
  useEffect(() => { statusFilterRef.current = statusFilter; }, [statusFilter]);
  const isExternalFilterPresent = useCallback(() => !!statusFilterRef.current, []);
  const doesExternalFilterPass = useCallback((node) => {
    if (!statusFilterRef.current || !node.data) return true;
    return getEffectiveStatus(node.data) === statusFilterRef.current;
  }, []);
  useEffect(() => {
    gridRef.current?.api?.onFilterChanged();
  }, [statusFilter]);

  const exportCSV = () =>
    gridRef.current?.api?.exportDataAsCsv({
      fileName: isAll
        ? `كشف_حضور_الشركة_${month}.csv`
        : `حركة_${data?.employee?.name}_${month}.csv`,
      processCellCallback: p => p.column.getColDef().valueFormatter
        ? p.column.getColDef().valueFormatter(p)
        : p.value,
    });

  // ── Cell state helpers ────────────────────────────────────────────────────
  const markSaving = useCallback((rowId, field, node, isSaving) => {
    const key = `${rowId}:${field}`;
    if (isSaving) savingCellsRef.current.add(key);
    else          savingCellsRef.current.delete(key);
    safeRefreshCells(rowId, node, [field]);
  }, [safeRefreshCells]);

  const markSaved = useCallback((rowId, field, node) => {
    const key = `${rowId}:${field}`;
    savedCellsRef.current.add(key);
    safeRefreshCells(rowId, node, [field]);
    const timerId = setTimeout(() => {
      pendingTimersRef.current.delete(timerId);
      savedCellsRef.current.delete(key);
      safeRefreshCells(rowId, node, [field]);
    }, 1200);
    pendingTimersRef.current.add(timerId);
  }, [safeRefreshCells]);

  const markError = useCallback((rowId, field, node) => {
    const key = `${rowId}:${field}`;
    errorCellsRef.current.add(key);
    safeRefreshCells(rowId, node, [field]);
    const timerId = setTimeout(() => {
      pendingTimersRef.current.delete(timerId);
      errorCellsRef.current.delete(key);
      safeRefreshCells(rowId, node, [field]);
    }, 2000);
    pendingTimersRef.current.add(timerId);
  }, [safeRefreshCells]);

  // Weekly holidays (isWeekend) remain editable — HR can record attendance and
  // overtime for employees who worked a weekly holiday; the engine converts the
  // day to a "holiday work day" (all worked time = overtime, no late/early/
  // absence penalties) regardless of whether the punch was manual or automatic.
  // Public holidays (isHoliday) stay locked — a distinct, unrelated concept.
  const editableNotOff = p =>
    !p.node?.rowPinned && !p.data?.isHoliday;

  const editCellClass = (field, editableFn) => p => {
    if (!p.data) return '';
    const id = p.data.id;
    const cls = [];
    if (editableFn(p)) cls.push('cell-editable');
    if (id != null && savingCellsRef.current.has(`${id}:${field}`)) cls.push('cell-saving');
    if (id != null && savedCellsRef.current.has(`${id}:${field}`))  cls.push('cell-saved');
    if (id != null && errorCellsRef.current.has(`${id}:${field}`))  cls.push('cell-error');
    return cls.join(' ');
  };

  // ── Column definitions ─────────────────────────────────────────────────────
  const cols = useMemo(() => [
    {
      headerName:'', field:'_actions', width:50, pinned:'right',
      sortable:false, filter:false, resizable:false, headerClass:'ag-header-center',
      cellStyle:{ display:'flex', alignItems:'center', justifyContent:'center' },
      cellRenderer: ({ data, node }) => node.rowPinned ? null : (
        <button
          disabled={!data?.id}
          onClick={() => setPenaltyRow(data)}
          title="تعديل يدوي متقدم"
          style={{
            border:'none',
            background:(data?.hasManualPenalty || data?.hasManualOvertime)
              ? 'rgba(245,158,11,0.15)' : 'var(--surface-2)',
            color:(data?.hasManualPenalty || data?.hasManualOvertime)
              ? '#f59e0b' : 'var(--text-2)',
            borderRadius:6, width:26, height:26,
            display:'flex', alignItems:'center', justifyContent:'center',
            cursor:data?.id ? 'pointer' : 'not-allowed',
            opacity:data?.id ? 1 : 0.4 }}>
          <Pencil style={{ width:13, height:13 }} />
        </button>
      ),
    },
    {
      field:'employeeCode', headerName:'الكود', width:80, pinned:'right',
      cellStyle: codeCell(),
    },
    {
      field:'employeeName', headerName:'اسم الموظف', width:160, minWidth:140, pinned:'right',
      cellStyle: (p) => p.data?.isMonitored ? { ...nameCell(), color: p.data.monitorColor || '#f59e0b', fontWeight: '800' } : nameCell(),
      cellRenderer: ({ data, value, node }) => {
        if (node.rowPinned) return value;
        return data?.isMonitored
          ? <span style={{ display:'flex', alignItems:'center', gap:5 }}>
              <span style={{
                display:'inline-flex', alignItems:'center', justifyContent:'center',
                width:14, height:14, borderRadius:'50%', flexShrink:0,
                background: data.monitorColor || '#f59e0b', fontSize:8, color:'#fff', fontWeight:900,
              }}>●</span>
              {value}
            </span>
          : value;
      },
    },
    {
      field:'date', headerName:'التاريخ', width:105, pinned:'right',
      cellRenderer: ({ data, node, value }) => node.rowPinned
        ? <span style={{ fontWeight:'800' }}>{data?.date}</span>
        : value,
      cellStyle:{ ...NUM, justifyContent:'center', textAlign:'center', fontSize:'11px', color:'var(--erp-text-muted)', fontWeight:'500' },
    },
    {
      field:'dayName', headerName:'اليوم', width:90,
      cellStyle: p => ({
        color:(p.data?.isWeekend || p.data?.isHoliday) ? 'var(--erp-text-faint)' : 'var(--erp-text)',
        fontFamily:'Cairo,sans-serif', fontSize:'12px',
      }),
    },
    {
      field:'checkIn', headerName:'الحضور', ...COL_MEDIUM,
      editable: editableNotOff,
      cellEditor: TimeCellEditor, cellEditorParams:{ mode:'datetime' },
      valueFormatter: p => fmtTime(p.value),
      cellClass: editCellClass('checkIn', editableNotOff),
      cellStyle: p => ({
        ...NUM, justifyContent:'center',
        color: p.value ? 'var(--c-green)' : 'var(--erp-text-faint)',
      }),
    },
    {
      field:'checkOut', headerName:'الانصراف', ...COL_MEDIUM,
      editable: editableNotOff,
      cellEditor: TimeCellEditor, cellEditorParams:{ mode:'datetime' },
      valueFormatter: p => fmtTime(p.value),
      cellClass: editCellClass('checkOut', editableNotOff),
      cellStyle: p => ({
        ...NUM, justifyContent:'center',
        color: p.value ? 'var(--c-time)' : 'var(--erp-text-faint)',
      }),
    },
    {
      field:'morningOT', headerName:'إضافي ص', width:90,
      headerTooltip:'الإضافي الصباحي',
      valueFormatter: p => p.value > 0 ? formatHours(p.value) : '—',
      cellStyle: p => ({
        ...NUM, justifyContent:'center',
        color: p.value > 0 ? 'var(--c-ot)' : 'var(--erp-text-faint)',
        fontWeight: p.value > 0 ? '700' : '400',
      }),
    },
    {
      field:'eveningOT', headerName:'إضافي م', width:90,
      headerTooltip:'الإضافي المسائي',
      valueFormatter: p => p.value > 0 ? formatHours(p.value) : '—',
      cellStyle: p => ({
        ...NUM, justifyContent:'center',
        color: p.value > 0 ? 'var(--c-ot)' : 'var(--erp-text-faint)',
        fontWeight: p.value > 0 ? '700' : '400',
      }),
    },
    {
      field:'effectiveOvertimeUnits', headerName:'إجمالي الإضافي', width:115,
      editable: editableNotOff,
      cellEditor:'agNumberCellEditor',
      cellEditorParams:{ min:0, step:0.5, precision:1 },
      // effectiveOvertimeUnits is the single canonical overtime value (backend
      // mergeEffectivePenalty) — on weekend/holiday days all worked time is
      // credited here directly (morningOT/eveningOT are explicitly zeroed by
      // the engine for those days, see attendanceEngine.js), and manual
      // overrides also only ever land in this field. Reading morningOT +
      // eveningOT instead used to show an empty/zero cell for exactly those
      // two cases even though real overtime existed.
      valueFormatter: p => fmtEditableZero(p.value, v => ((v || 0) > 0 ? formatHours(v) : '—')),
      cellClass: p => [
        editCellClass('effectiveOvertimeUnits', editableNotOff)(p),
        p.data?.manualOvertimeUnits != null ? 'cell-manual-override' : '',
      ].filter(Boolean).join(' '),
      tooltipValueGetter: p => p.data?.manualOvertimeUnits != null
        ? manualOverrideTooltip(p.data?.manualPenaltyByName, p.data?.manualPenaltyAt) : undefined,
      cellStyle: p => {
        const total = p.value || 0;
        return {
          ...NUM, justifyContent:'center', alignItems:'center',
          color: total > 0 ? 'var(--c-ot)' : 'var(--erp-text-faint)',
          fontWeight: total > 0 ? '800' : '400',
        };
      },
    },
    {
      field:'effectiveLatePenalty', headerName:'خصم تأخير', width:110,
      editable: editableNotOff,
      cellEditor:'agNumberCellEditor',
      cellEditorParams:{ min:0, step:1, precision:0 },
      valueFormatter: p => fmtEditableZero(p.value, fmtPenaltyUnits),
      cellClass: p => [
        editCellClass('effectiveLatePenalty', editableNotOff)(p),
        p.data?.manualLatePenaltyUnits != null ? 'cell-manual-override' : '',
      ].filter(Boolean).join(' '),
      tooltipValueGetter: p => p.data?.manualLatePenaltyUnits != null
        ? manualOverrideTooltip(p.data?.manualPenaltyByName, p.data?.manualPenaltyAt) : undefined,
      cellStyle: p => ({
        ...NUM, justifyContent:'center', alignItems:'center',
        color: p.value > 0 ? 'var(--c-penalty)' : 'var(--erp-text-faint)',
      }),
    },
    {
      field:'effectiveEarlyPenalty', headerName:'خصم انصراف', width:105,
      editable: editableNotOff,
      cellEditor:'agNumberCellEditor',
      cellEditorParams:{ min:0, step:1, precision:0 },
      valueFormatter: p => fmtEditableZero(p.value, fmtPenaltyUnits),
      cellClass: p => [
        editCellClass('effectiveEarlyPenalty', editableNotOff)(p),
        p.data?.manualEarlyPenaltyUnits != null ? 'cell-manual-override' : '',
      ].filter(Boolean).join(' '),
      tooltipValueGetter: p => p.data?.manualEarlyPenaltyUnits != null
        ? manualOverrideTooltip(p.data?.manualPenaltyByName, p.data?.manualPenaltyAt) : undefined,
      cellStyle: p => ({
        ...NUM, justifyContent:'center', alignItems:'center',
        color: p.value > 0 ? 'var(--c-red)' : 'var(--erp-text-faint)',
      }),
    },
    {
      field:'effectiveTotalDeductions', headerName:'إجمالي الخصم', width:115,
      valueFormatter: p => fmtPenaltyUnits(p.value),
      cellStyle: p => ({
        ...NUM, justifyContent:'center', fontWeight: p.value > 0 ? '800' : '400',
        color: p.value > 0 ? 'var(--c-red)' : 'var(--erp-text-faint)',
      }),
    },
    {
      field: 'absenceType', headerName: 'نوع الغياب', width: 140,
      valueFormatter: p => {
        if (!p.data || p.data.isWeekend || p.data.isHoliday) return '';
        return p.data.isAbsent ? (ABSENCE_TYPE_LABELS[p.value] || '—') : '';
      },
      cellStyle: p => ({
        ...NUM, fontFamily: 'Cairo, sans-serif', fontSize: '12px',
        justifyContent: 'center', fontWeight: '700',
        color: p.data?.absenceType === 'without_permission' ? 'var(--c-red)'
          : p.data?.absenceType === 'with_permission' ? 'var(--c-green)'
          : p.data?.absenceType === 'custom' ? 'var(--c-time)'
          : 'var(--erp-text-faint)',
      }),
      onCellClicked: ({ data }) => {
        if (!data?.id || data.isWeekend || data.isHoliday) return;
        if (!data.isAbsent) return;
        setAbsenceModal({
          id: data.id,
          employeeName: data.employeeName,
          dateLabel: data.date,
          initialType: data.absenceType || null,
          initialPenaltyDays: data.penaltyDays || null,
          initialReason: data.absenceReason || '',
          _originalRow: data,
        });
      },
    },
    {
      field: 'penaltyDays', headerName: 'أيام الخصم', width: 100,
      valueFormatter: p => {
        if (p.node?.rowPinned) return p.value != null ? String(p.value) : '';
        if (!p.data || p.data.isWeekend || p.data.isHoliday) return '';
        return p.data.isAbsent && p.value != null ? String(p.value) : '';
      },
      cellStyle: p => ({
        ...NUM, justifyContent: 'center', fontWeight: '700',
        color: p.data?.isAbsent ? 'var(--c-red)' : 'var(--erp-text-faint)',
      }),
    },
    {
      headerName:'الحالة', width:125, pinned:'left',
      editable: p => !p.node?.rowPinned,
      cellEditor:'agSelectCellEditor',
      cellEditorParams:{ values:['present','late','absent','early_leave','weekend','holiday'] },
      valueFormatter: p => STATUS_LABELS[p.value]?.ar || STATUS_MAP[p.value]?.ar || p.value || '—',
      field:'status',
      cellClass: p => editCellClass('status', () => !p.node?.rowPinned)(p),
      cellRenderer: ({ data, node }) => node.rowPinned ? null : <StatusCell data={data} />,
      cellStyle:{ justifyContent:'center' },
    },
  ], [isLight]); // eslint-disable-line react-hooks/exhaustive-deps

  const defaultColDef = useMemo(() => ({ ...ENTERPRISE_DEFAULT_COL_DEF }), []);

  const getRowClass = useCallback(({ data }) => {
    if (!data) return '';
    const classes = [];
    if      (data.isMonitored) classes.push('row-monitored');
    if      (data.isHoliday)   classes.push('row-holiday');
    else if (data.isWeekend)   classes.push('row-weekend');
    else if (data.isAbsent) classes.push('row-absent');
    else if ((data.effectiveLatePenalty  || 0) > 0) classes.push('row-late');
    else if ((data.effectiveOvertimeUnits|| 0) > 0) classes.push('row-overtime');
    return classes.join(' ');
  }, []);

  // AttendanceDaily.id is the ONLY row identity for any row that has one —
  // never derive it from employeeId/date, since those can transiently be
  // missing from a PUT response (see normalizeDailyUpdate/applyUpdate) and a
  // composite key built from them changes AG Grid's row identity mid-edit,
  // destroying and recreating the RowNode (rows/cells appear to "disappear").
  // The employeeId-date fallback only applies to placeholder calendar days
  // with no AttendanceDaily record yet (id === null) — those rows are never
  // editable (handleCellEdit bails out on `!rowData?.id`), so they can never
  // hit this bug.
  const getRowId = useCallback(p => (
    p.data.id != null ? String(p.data.id) : `${p.data.employeeId}-${p.data.date}`
  ), []);

  const pinnedBottom = useMemo(() => {
    if (!data?.summary) return [];
    const s = data.summary;
    return [{
      employeeCode:'', employeeName:'', department:'',
      date:'الإجمالي', dayName:'',
      checkIn:null, checkOut:null,
      workedMinutes: Math.round((s.totalWorkedHours || 0) * 60),
      workedHours:   s.totalWorkedHours,
      morningOT: null, eveningOT: null,
      totalOT:              s.totalOTHours,
      effectiveOvertimeUnits:   s.totalEffectiveOvertimeUnits,
      effectiveLatePenalty:     s.totalEffectiveLatePenalty,
      effectiveEarlyPenalty:    s.totalEffectiveEarlyPenalty,
      penaltyDays:              s.totalPenaltyDays,
      effectiveTotalDeductions: s.totalEffectiveDeductionUnits,
    }];
  }, [data?.summary]);

  // ── Save one record (shared by single + bulk save) ────────────────────────
  const saveRecord = useCallback(async (rowData, field, newValue) => {
    if (!rowData?.id) return null;
    if (field === 'workedMinutes') {
      const mins = newValue ? (timeToMinutes(newValue) ?? 0) : 0;
      const res = await api.put(`/attendance/daily/${rowData.id}`, {
        workedMinutes: mins, reason: INLINE_REASON,
        modifiedByName: ACTOR, source:'inline-grid',
      });
      return normalizeDailyUpdate(res.data);
    }
    if (['checkIn','checkOut','status'].includes(field)) {
      const res = await api.put(`/attendance/daily/${rowData.id}`, {
        modifiedByName: ACTOR, source:'inline-grid', [field]: newValue,
      });
      return normalizeDailyUpdate(res.data);
    }
    const overrideKey = OVERRIDE_FIELD_MAP[field];
    if (!overrideKey) return null;
    const val = (newValue == null || newValue === '') ? null : Number(newValue);
    const res = await api.put(`/attendance/${rowData.id}/manual-penalty`, {
      [overrideKey]: val, overrideReason: INLINE_REASON,
      modifiedByName: ACTOR, source:'inline-grid',
    });
    return normalizeDailyUpdate(res.data);
  }, []);

  // Apply a backend response (updatedFields) to this row's two state copies:
  //   1. gridRows — the actual AG Grid rowData, updated through React state
  //      via replaceAttendanceRow() (same unified pipeline as AttendanceDaily/
  //      AttendanceMonthlyPage — full row replacement, never a partial merge,
  //      never an imperative applyTransaction/refreshCells call).
  //   2. data.days (for print preview) + data.summary recomputed from days
  //      → KPI cards, payroll effect bar and pinned totals update immediately.
  //
  // updatedFields (already run through normalizeDailyUpdate — formatting
  // only) is the COMPLETE, final row. date/dayName/dayNum are the only fields
  // carried over from originalRow — pure calendar/UI metadata the backend
  // response never includes (normalizeDailyUpdate strips `date` deliberately;
  // buildDailyResponseRow never returns dayName/dayNum at all), never
  // canonical attendance values. Row IDENTITY (getRowId) is keyed off
  // data.id — never off date — so this carry-over is purely cosmetic
  // (the "التاريخ"/day-name/day-number columns), not an identity concern.
  const applyUpdate = useCallback((updatedFields, originalRow, field) => {
    if (!updatedFields || !originalRow?.id) return;
    const newRow = {
      ...updatedFields,
      date: originalRow.date,
      dayName: originalRow.dayName,
      dayNum: originalRow.dayNum,
    };

    // A sibling field on this same row may still be saving (e.g. the user
    // tabbed to the next editable cell before this response landed) — this
    // response predates that sibling edit, so only apply the field it's
    // authoritative for instead of clobbering the sibling's in-flight value
    // with a stale full-row replace (and swapping the row's object identity
    // out from under AG Grid mid-edit).
    const rowKeyPrefix = `${originalRow.id}:`;
    const hasOtherFieldsInFlight = field != null && Array.from(savingCellsRef.current)
      .some(k => k.startsWith(rowKeyPrefix) && k !== `${rowKeyPrefix}${field}`);
    if (hasOtherFieldsInFlight) pendingReloadRef.current = true;

    // 1. Grid rowData — unified React-state row apply
    setGridRows(rows => applyRowFieldUpdate(rows, newRow, field, hasOtherFieldsInFlight));

    // 2. State — update days + recompute summary for KPIs / pinned totals
    setData(prev => {
      if (!prev) return prev;
      const newDays = replaceAttendanceRow(prev.days, newRow);
      const newSummary = computeSummaryFromDays(newDays, prev.summary);
      return { ...prev, days: newDays, summary: newSummary };
    });

    // 3. EF-004.1: otAmount/effectiveNetEffect need the backend's per-day
    // overtime-multiplier logic — fetch the authoritative summary in the
    // background (never blocks the grid) and merge in just those two fields.
    // moneyRefreshTokenRef discards a response if a newer edit has already
    // superseded it, so rapid successive edits can't flash back to a stale value.
    const myToken = ++moneyRefreshTokenRef.current;
    api.get('/attendance/movement', {
      params: {
        employeeId: empId || undefined, month,
        branchId: branchId || undefined, departmentId: departmentId || undefined,
      },
    }).then(({ data: raw }) => {
      if (!raw?.summary || myToken !== moneyRefreshTokenRef.current) return;
      setData(prev => prev ? {
        ...prev,
        summary: { ...prev.summary, otAmount: raw.summary.otAmount, effectiveNetEffect: raw.summary.effectiveNetEffect },
      } : prev);
    }).catch(() => {}); // best-effort — the carried-forward value stays displayed on failure
  }, [empId, month, branchId, departmentId]);

  // Revert a single field's displayed value after a validation or save
  // failure — through the SAME React-state path (setGridRows + setData) that
  // every successful edit already uses, never through an imperative AG Grid
  // RowNode mutation (node.setDataValue). React state stays the single
  // writable owner of row content in every branch of handleCellEdit; AG Grid
  // only ever consumes whatever `gridRows` currently holds.
  const revertField = useCallback((rowId, field, oldValue) => {
    setGridRows(rows => rows.map(r => (r.id === rowId ? { ...r, [field]: oldValue } : r)));
    setData(prev => {
      if (!prev) return prev;
      return { ...prev, days: prev.days.map(d => (d.id === rowId ? { ...d, [field]: oldValue } : d)) };
    });
  }, []);

  // ── Cell edit handler ─────────────────────────────────────────────────────
  const handleCellEdit = useCallback(async ({ data: rowData, colDef, newValue, oldValue, node }) => {
    // A cancelled edit (Escape) also fires cellEditingStopped, with
    // newValue === undefined (a cleared field commits '' instead) — without
    // this guard the workedMinutes branch coerces undefined → 0 and saves it.
    if (newValue === undefined) return;
    if (!rowData?.id) return;
    const field = colDef.field;

    // Validation
    if (['checkIn','checkOut','workedMinutes'].includes(field)) {
      if (newValue && !HHMM_RE.test(newValue)) {
        toast.error('صيغة الوقت غير صحيحة (HH:mm)');
        revertField(rowData.id, field, oldValue);
        markError(rowData.id, field, node);
        return;
      }
    }
    if (OVERRIDE_FIELD_MAP[field] && newValue != null && newValue !== '') {
      const n = Number(newValue);
      if (!Number.isFinite(n) || n < 0) {
        toast.error('القيمة يجب أن تكون رقمًا موجبًا');
        revertField(rowData.id, field, oldValue);
        markError(rowData.id, field, node);
        return;
      }
    }

    // No-op detection
    if (field === 'workedMinutes') {
      const newMin = newValue ? (timeToMinutes(newValue) ?? 0) : 0;
      if (newMin === (oldValue || 0)) return;
    } else if (OVERRIDE_FIELD_MAP[field]) {
      const a = (newValue == null || newValue === '') ? null : Number(newValue);
      const b = (oldValue == null || oldValue === '') ? null : Number(oldValue);
      if (a === b) return;
    } else {
      if (newValue === oldValue) return;
    }

    // Save primary row — block background reloads for the duration of the PUT
    editCountRef.current++;
    performance.mark('refreshCells-start'); // Chromium tracing: observational only, see trace-capture investigation
    markSaving(rowData.id, field, node, true);
    let primaryOk = false;
    try {
      const updated = await saveRecord(rowData, field, newValue);
      if (updated) {
        applyUpdate(updated, rowData, field);
        performance.mark('applyUpdate'); // Chromium tracing: observational only
        markSaved(rowData.id, field, node);
        performance.mark('markSaved'); // Chromium tracing: observational only
        primaryOk = true;
        if (field === 'status' && newValue === 'absent') {
          setAbsenceModal({
            id: rowData.id,
            employeeName: rowData.employeeName,
            dateLabel: rowData.date,
            initialType: rowData.absenceType || null,
            initialPenaltyDays: rowData.penaltyDays || null,
            initialReason: rowData.absenceReason || '',
            _originalRow: { ...rowData, ...updated },
          });
        }
      }
    } catch (err) {
      toast.error(err?.response?.data?.error || 'فشل التحديث');
      revertField(rowData.id, field, oldValue);
      markError(rowData.id, field, node);
    } finally {
      editCountRef.current--;
      performance.mark('refreshCells-end'); // Chromium tracing: observational only
      markSaving(rowData.id, field, node, false);
      // Do NOT check pending here — bulk nodes may re-increment the counter next
    }
    if (!primaryOk) return;

    // Bulk: apply same change to all other selected rows
    const otherNodes = (gridRef.current?.api?.getSelectedNodes() || [])
      .filter(n => n.data?.id !== rowData.id && !n.data?.isHoliday && n.data?.id != null);

    if (otherNodes.length === 0) {
      // No bulk — counter is permanently at 0, safe to fire deferred reload
      if (editCountRef.current === 0 && pendingReloadRef.current) { pendingReloadRef.current = false; load(false); }
      return;
    }

    editCountRef.current += otherNodes.length;
    let bulkCount = 1;
    await Promise.all(otherNodes.map(async n => {
      markSaving(n.data.id, field, n, true);
      try {
        const updated = await saveRecord(n.data, field, newValue);
        if (updated) {
          applyUpdate(updated, n.data, field);
          markSaved(n.data.id, field, n);
          bulkCount++;
        }
      } catch {
        markSaving(n.data.id, field, n, false);
      } finally {
        editCountRef.current--;
        markSaving(n.data.id, field, n, false);
        if (editCountRef.current === 0 && pendingReloadRef.current) { pendingReloadRef.current = false; load(false); }
      }
    }));
    toast.success(`تم تطبيق القيمة على ${bulkCount} سجل`);
  }, [saveRecord, markSaving, markSaved, markError, applyUpdate, revertField, load]);

  const handleAbsenceSave = useCallback(async ({ absenceType, penaltyDays, absenceReason }) => {
    if (!absenceModal?.id) return;
    editCountRef.current++;
    setAbsenceSaving(true);
    try {
      const { data: updated } = await api.put(`/attendance/${absenceModal.id}/absence-type`, {
        absenceType, penaltyDays, absenceReason, modifiedByName: ACTOR,
      });
      const origRow = absenceModal._originalRow;
      if (origRow) applyUpdate(updated, origRow);
      toast.success('تم تحديث نوع الغياب');
      setAbsenceModal(null);
    } catch (err) {
      toast.error(err?.response?.data?.error || 'فشل تحديث نوع الغياب');
    } finally {
      editCountRef.current--;
      setAbsenceSaving(false);
      if (editCountRef.current === 0 && pendingReloadRef.current) { pendingReloadRef.current = false; load(false); }
    }
  }, [absenceModal, applyUpdate, load]);

  const [y, m] = month.split('-');
  const monthLabel = `${MONTHS_AR[parseInt(m) - 1]} ${y}`;
  const s = data?.summary;

  const kpis = useMemo(() => {
    if (!s) return [];
    if (isAll) {
      return [
        { label:'إجمالي حضور الشركة', value:s.presentDays,                   unit:'يوم',  icon:CheckCircle,   color:'var(--c-green)' },
        { label:'إجمالي غياب الشركة', value:s.absentDays,                    unit:'يوم',  icon:XCircle,       color:'var(--c-red)' },
        { label:'إجمالي التأخيرات',   value:s.totalEffectiveLatePenalty,      unit:'ساعة', icon:AlertTriangle, color:'var(--c-penalty)' },
        { label:'إجمالي ساعات الخصم', value:s.totalEffectiveDeductionUnits,   unit:'ساعة', icon:AlertTriangle, color:'var(--c-penalty)' },
      ];
    }
    return [
      { label:'أيام الحضور',        value:s.presentDays,                       unit:'يوم',  icon:CheckCircle,  color:'var(--c-green)' },
      { label:'أيام الغياب',        value:s.absentDays,                        unit:'يوم',  icon:XCircle,      color:'var(--c-red)' },
      { label:'ساعات الإضافي',      value:formatHours(s.totalOTHours, { zero:'00:00' }), unit:'', icon:TrendingUp,  color:'var(--c-ot)' },
      { label:'إجمالي ساعات الخصم', value:s.totalEffectiveDeductionUnits,      unit:'ساعة', icon:AlertTriangle, color:'var(--c-penalty)' },
    ];
  }, [s, isAll]);

  // Every callback-type AG Grid prop must be reference-stable, or AG Grid's
  // GridOptionsService treats the prop as "changed" on every parent render
  // (e.g. after every inline edit) and — for row-level options such as
  // getRowStyle — forces RowRenderer.redrawRows() to destroy and recreate
  // every currently-displayed RowCtrl/CellCtrl, which briefly unmounts every
  // custom cellRenderer (StatusCell, badges, etc.), visible as rows/cells
  // flashing blank. Root-caused and verified live (destroyFirstPass/
  // destroySecondPass/StatusCell mount-unmount instrumented directly against
  // AG Grid's internals): only getRowStyle was unstable and only its identity
  // needed to change to reproduce/eliminate the full-grid redraw.
  const getRowStyle = useCallback(({ node, data }) => {
    if (node.rowPinned === 'bottom') return {
      background:'var(--erp-ag-header-bg-end, #0f1e35)',
      color:'#93c5fd', fontWeight:'700',
      borderTop:'2px solid var(--erp-ag-header-accent, #2563eb)',
    };
    if (data?.isMonitored) {
      const c = data.monitorColor || '#f59e0b';
      return { borderRight: `6px solid ${c}` };
    }
    return undefined;
  }, []);

  // filterActive/doesPassFilter come from useAttendanceFilter() and can
  // change whenever the user changes the advanced filter bar — must stay in
  // the dependency array or these would close over stale filter state.
  const gridIsExternalFilterPresent = useCallback(
    () => filterActive || isExternalFilterPresent(),
    [filterActive, isExternalFilterPresent],
  );
  const gridDoesExternalFilterPass = useCallback(
    (p) => doesExternalFilterPass(p) && doesPassFilter(p.data),
    [doesExternalFilterPass, doesPassFilter],
  );

  // Assigns a ref only — no external state read, safe with an empty
  // dependency array (AG Grid only calls this once, when the grid mounts).
  const handleGridReady = useCallback((p) => { filterGridApiRef.current = p.api; }, [filterGridApiRef]);

  return (
    <div className="flex flex-col gap-3" style={{ flex:1, minHeight:0 }} dir="rtl">

      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2">
            <UserSquare2 className="w-5 h-5 text-blue-400" />
            كشف الحضور الشهري
          </h1>
          <p className="text-xs mt-0.5" style={{ color:'var(--erp-text-muted)' }}>
            {data?.mode === 'single' && data?.employee
              ? `${data.employee.name} — ${data.employee.code}`
              : data
                ? `كشف الشركة الكامل — ${data.employeeCount} موظف`
                : 'سجل حضور تفصيلي يومي لكل الموظفين'}
            &nbsp;·&nbsp;
            <span style={{ color: quickEdit ? 'var(--c-penalty)' : 'var(--text-3)' }}>
              {quickEdit ? 'وضع التعديل السريع' : 'انقر مرتين للتعديل'}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setQuickEdit(q => { const next = !q; localStorage.setItem('movement_quick_edit', String(next)); return next; })}
            className={quickEdit ? 'btn-warning text-xs py-1.5 px-3' : 'btn-secondary text-xs py-1.5 px-3'}
          >
            {quickEdit ? <ZapOff className="w-3.5 h-3.5" /> : <Zap className="w-3.5 h-3.5" />}
            {quickEdit ? 'وضع القراءة' : 'التعديل السريع'}
          </button>
          {data && (
            <>
              <button onClick={exportCSV} className="btn-secondary text-xs py-1.5 px-3">
                <Download className="w-3.5 h-3.5" /> CSV
              </button>
              <button onClick={() => setPrintOpen(true)} className="btn-secondary text-xs py-1.5 px-3">
                <Printer className="w-3.5 h-3.5" /> طباعة
              </button>
            </>
          )}
          <button onClick={() => load(true)} className="btn-primary text-xs py-1.5 px-3" disabled={loading}>
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {loading ? 'جاري التحميل...' : 'عرض التقرير'}
          </button>
        </div>
      </div>

      {/* Advanced filter bar */}
      <AttendanceFilterBar
        filters={filters}
        updateFilter={updateFilter}
        toggleArrayItem={toggleArrayItem}
        applyQuick={applyQuick}
        clearFilters={clearFilters}
        isActive={filterActive}
        departments={departments.map(d => d.name)}
      />

      {/* Base filters (employee / branch / dept / month) */}
      <div className="card p-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="label mb-0 whitespace-nowrap">الموظف</label>
          <select className="input w-52 text-xs py-1.5" value={empId} onChange={e => setEmpId(e.target.value)}>
            <option value="">كل الموظفين</option>
            {employees
              .filter(e => !branchId     || e.branchId     === parseInt(branchId))
              .filter(e => !departmentId || e.departmentId === parseInt(departmentId))
              .map(e => <option key={e.id} value={e.id}>{e.name} ({e.code})</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="label mb-0 whitespace-nowrap">الفرع</label>
          <select className="input w-36 text-xs py-1.5" value={branchId} onChange={e => setBranchId(e.target.value)}>
            <option value="">الكل</option>
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="label mb-0 whitespace-nowrap">القسم</label>
          <select className="input w-36 text-xs py-1.5" value={departmentId} onChange={e => setDepartmentId(e.target.value)}>
            <option value="">الكل</option>
            {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="label mb-0 whitespace-nowrap">الحالة</label>
          <select className="input w-32 text-xs py-1.5" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            {STATUS_FILTER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-1 mr-auto">
          <button onClick={() => shiftMonth(-1)} className="btn-ghost p-1.5 rounded-lg">
            <ChevronRight className="w-4 h-4" />
          </button>
          <input type="month" value={month} onChange={e => setMonth(e.target.value)}
            className="input w-36 text-xs py-1.5 text-center font-mono" dir="ltr" />
          <button onClick={() => shiftMonth(1)} className="btn-ghost p-1.5 rounded-lg">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-xs px-2 font-semibold" style={{ color:'var(--erp-text-muted)' }}>
            {monthLabel}
          </span>
        </div>
      </div>

      {/* KPI Cards */}
      {s && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {kpis.map(kpi => <KpiCard key={kpi.label} {...kpi} />)}
        </div>
      )}

      {/* AG Grid */}
      <div className="flex-1 overflow-hidden" style={{ minHeight:0 }}>
        <div className={`${agGridTheme} h-full`}>
          <AgGridReact
            ref={gridRef}
            rowData={gridRows}
            columnDefs={cols}
            defaultColDef={defaultColDef}
            {...ENTERPRISE_GRID_PROPS}
            pinnedBottomRowData={pinnedBottom}
            getRowClass={getRowClass}
            getRowId={getRowId}
            onCellEditingStopped={handleCellEdit}
            onGridReady={handleGridReady}
            isExternalFilterPresent={gridIsExternalFilterPresent}
            doesExternalFilterPass={gridDoesExternalFilterPass}
            singleClickEdit={quickEdit}
            tabToNextCell={tabToNextCell}
            stopEditingWhenCellsLoseFocus={true}
            enterNavigatesVertically={true}
            enterNavigatesVerticallyAfterEdit={true}
            undoRedoCellEditing={true}
            undoRedoCellEditingLimit={20}
            enableRtl={true}
            localeText={AG_GRID_LOCALE_AR}
            animateRows={false}
            rowSelection="multiple"
            suppressRowClickSelection
            enableCellTextSelection
            tooltipShowDelay={300}
            loading={loading}
            rowBuffer={10}
            getRowStyle={getRowStyle}
          />
        </div>
      </div>

      {data && (
        <PrintPreviewModal
          isOpen={printOpen}
          onClose={() => setPrintOpen(false)}
          data={filteredDays}
          reportType="movement"
          title={data.mode === 'single' && data.employee
            ? `حركة الموظف — ${data.employee.name}`
            : 'كشف الحضور الشهري الشامل'}
          meta={{
            period: monthLabel,
            generatedBy: ACTOR,
            ...(data.mode === 'single' && data.employee
              ? { employee:`${data.employee.name} (${data.employee.code})`, dept:data.employee.department }
              : { employees:`${data.employeeCount} موظف` }),
          }}
          orientation="landscape"
        />
      )}

      {penaltyRow && (
        <ManualPenaltyModal
          record={penaltyRow}
          onClose={() => setPenaltyRow(null)}
          onSaved={load}
        />
      )}

      {absenceModal && (
        <AbsenceTypeModal
          isOpen={!!absenceModal}
          onClose={() => setAbsenceModal(null)}
          onSave={handleAbsenceSave}
          saving={absenceSaving}
          employeeName={absenceModal.employeeName}
          dateLabel={absenceModal.dateLabel}
          initialType={absenceModal.initialType}
          initialPenaltyDays={absenceModal.initialPenaltyDays}
          initialReason={absenceModal.initialReason}
        />
      )}
    </div>
  );
}
