import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';
import {
  Download, RefreshCw, Loader2, Play, Printer, FileBarChart, Copy, ClipboardPaste,
  CheckCircle, XCircle, Clock, TrendingUp,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useUnsavedWork } from '../hooks/useUnsavedWork';
import { isSessionLostError } from '../lib/unsavedWork';
import api, { LONG_OP } from '../lib/api';
import { closedSkipMessage } from '../lib/closedMonthSkip';
import { useTheme } from '../contexts/ThemeContext';
import { useIsNarrowViewport } from '../hooks/useIsNarrowViewport';
import { AG_GRID_LOCALE_AR } from '../lib/agGridLocale';
import {
  fmtTime, fmtWorkedHours, fmtPenaltyUnits, fmtOvertimeUnits, fmtEditableZero,
  timeToMinutes, STATUS_LABELS, manualOverrideTooltip,
} from '../lib/formatters';
import {
  NUM, CENTER, nameCell, codeCell, deptCell, otCell, penaltyCell, timeCell, rowNumCell,
} from '../lib/cellStyles';
import {
  ENTERPRISE_DEFAULT_COL_DEF, ENTERPRISE_GRID_PROPS, COL_MEDIUM, withHeaderFloor, tabToNextCell,
  isAbsentRow, attendanceRowClass,
} from '../lib/gridDefaults';
import PrintPreviewModal from '../components/PrintPreviewModal';
import TimeCellEditor from '../components/grid/TimeCellEditor';
import { useRulesLiveSync } from '../hooks/useRulesLiveSync';
import { useDeviceLiveSync } from '../hooks/useDeviceLiveSync';
import { useStaleGuard, keepCurrentRows, mergeEmployeeRows } from '../lib/staleGuard';
import AbsenceTypeModal, { ABSENCE_TYPE_LABELS } from '../components/AbsenceTypeModal';
import AttendanceFilterBar from '../components/AttendanceFilterBar';
import { useAttendanceFilter } from '../hooks/useAttendanceFilter';
import { ACTOR, HHMM_RE, OVERRIDE_FIELD_MAP, normalizeDailyUpdate, replaceAttendanceRow, applyRowFieldUpdate } from '../lib/attendanceUtils';
import { useKeyboardShortcut } from '../hooks/useKeyboardShortcut';
import PasteAttendanceModal from '../components/PasteAttendanceModal';
import { useAttendancePaste } from '../hooks/useAttendancePaste';
import { useGridClipboard } from '../hooks/useGridClipboard';
import useAuthStore from '../store/authStore';
import { createBulkSaver } from '../lib/attendanceBulkSave';
import { MONTHS_AR, getYearRange } from '../lib/constants';

const DAYS_AR   = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];

const INLINE_REASON = 'تعديل مباشر من كشف الحضور الشهري';

const MONTHLY_FILTER_KEY = 'attendanceMonthlyFilters';
function loadMonthlyFilters() {
  try { return JSON.parse(localStorage.getItem(MONTHLY_FILTER_KEY)) || {}; } catch { return {}; }
}

export default function AttendanceMonthlyPage() {
  const { agGridTheme } = useTheme();
  const _saved = loadMonthlyFilters();
  const now = new Date();
  const [rows,       setRows]      = useState([]);
  const [loading,    setLoading]   = useState(false);
  const [processing, setProc]      = useState(false);
  const [printOpen,  setPrintOpen] = useState(false);
  const [printRows,  setPrintRows] = useState([]);
  const [summaryPrintOpen,    setSummaryPrintOpen]    = useState(false);
  const [summaryPrintRows,    setSummaryPrintRows]    = useState([]);
  const [summaryPrintStats,   setSummaryPrintStats]   = useState([]);
  const [summaryPrintMeta,    setSummaryPrintMeta]    = useState({});
  const [summaryPrintLoading, setSummaryPrintLoading] = useState(false);
  const [departments, setDepts]    = useState([]);
  const [deptId,     setDeptId]    = useState(_saved.deptId ?? 0);
  const [absenceModal, setAbsenceModal] = useState(null);
  const [absenceSaving, setAbsenceSaving] = useState(false);
  const [month, setMonth] = useState(_saved.month ?? now.getMonth() + 1);
  const [year,  setYear]  = useState(_saved.year  ?? now.getFullYear());

  const gridRef = useRef();
  const [selectedRows, setSelectedRows] = useState([]);
  const editCountRef   = useRef(0);
  const pendingReloadRef = useRef(false);
  // Tracks in-flight `${rowId}:${field}` saves so a response landing while a
  // sibling field on the same row is still saving can be merged instead of
  // clobbering the whole row (see applyRowFieldUpdate in attendanceUtils.js).
  const savingCellsRef = useRef(new Set());
  // Stale-response protection (see lib/staleGuard.js): an older GET must never
  // overwrite the month/department the user switched to, or a row saved since.
  const screenKey = `${month}|${year}|${deptId}`;
  const guard = useStaleGuard(screenKey);

  // Excel-style cell range selection, Ctrl+C / Ctrl+V and bulk paste (AG Grid Community has none of these).
  // The paste handler is defined further down (it needs load()); the hook reaches it through this ref.
  const pasteHandlerRef = useRef(null);
  const clip = useGridClipboard({
    gridRef, rtl: true,
    lockReason: (row, field) => (field !== 'status' && row.isHoliday ? 'يوم عطلة رسمية — مقفل' : null),
    onPaste: (plan, ctx) => (pasteHandlerRef.current ? pasteHandlerRef.current(plan, ctx) : undefined),
  });
  const bulkSaver = useMemo(() => createBulkSaver({ api, actor: ACTOR }), []);
  // Background reloads wait while a save is in flight OR a cell holds an unsaved (failed) value, so a reload cannot wipe it.
  const monthlyBusyRef = useMemo(() => ({ get current() { return editCountRef.current > 0 || clip.stateSummary().failed > 0; } }), []);   // eslint-disable-line react-hooks/exhaustive-deps
  // Typed-but-not-saved work on this grid: a cell open in the editor, a save still in flight, or a cell whose save failed and awaits an
  // explicit retry. If the session ends while any of these exist the screen stays mounted under the login overlay (lib/unsavedWork.js).
  useUnsavedWork('attendance-monthly-editor', 'الحضور الشهري (تعديل غير محفوظ)', () =>
    !!gridRef.current?.api?.getEditingCells?.().length || savingCellsRef.current.size > 0 || clip.stateSummary().failed > 0);

  // ── Filter system ─────────────────────────────────────────────────────────
  const {
    filters, updateFilter, toggleArrayItem, applyQuick, clearFilters,
    doesPassFilter, isActive, gridApiRef,
  } = useAttendanceFilter();

  // Weekly holidays (isWeekend) remain editable — see attendanceEngine.js
  // processDate(): the engine converts worked time on a weekly holiday into
  // a "holiday work day" (all worked time = overtime, no penalties) whether
  // the punch is manual or automatic. Public holidays (isHoliday) stay locked.
  const editableNotOff = p => !p.data?.isHoliday;

  const editCellClass = (_field, editableFn) => p => {
    if (!p.data) return '';
    return editableFn(p) ? 'cell-editable' : '';
  };

  // ── Column definitions ────────────────────────────────────────────────────
  // Pinned-right columns (# + code + name + date) sum to ~470px, exceeding
  // a narrow phone's entire viewport. Below ~480px, only the name column
  // stays pinned — the rest flow into the normal scrollable region.
  const isNarrow = useIsNarrowViewport(480);

  const cols = useMemo(() => [
    {
      headerName: '#', valueGetter: 'node.rowIndex + 1', width: 60, pinned: isNarrow ? undefined : 'right',
      sortable: false, filter: false, headerClass: 'ag-header-center',
      checkboxSelection: true, headerCheckboxSelection: true,
      cellStyle: rowNumCell(),
    },
    {
      field: 'employeeCode', headerName: 'كود', width: 88, pinned: isNarrow ? undefined : 'right',
      cellStyle: codeCell(),
    },
    {
      field: 'employeeName', headerName: 'اسم الموظف', width: 195, minWidth: 160, pinned: 'right',
      cellStyle: (p) => p.data?.isMonitored ? { ...nameCell(), color: p.data.monitorColor || '#f59e0b', fontWeight: '800' } : nameCell(),
      cellClass: (p) => (!p.data?.isMonitored && isAbsentRow(p.data)) ? 'cell-name-absent' : '',
      cellRenderer: ({ data, value }) => data?.isMonitored
        ? <span style={{ display:'flex', alignItems:'center', gap:5 }}>
            <span style={{
              display:'inline-flex', alignItems:'center', justifyContent:'center',
              width:14, height:14, borderRadius:'50%', flexShrink:0,
              background: data.monitorColor || '#f59e0b', fontSize:8, color:'#fff', fontWeight:900,
            }}>●</span>
            {value}
          </span>
        : value,
    },
    {
      field: 'date', headerName: 'التاريخ', width: 148, minWidth: 136, pinned: isNarrow ? undefined : 'right',
      headerClass: 'ag-header-center',
      valueFormatter: p => {
        if (!p.value) return '';
        const d = new Date(p.value + 'T00:00');
        return `${d.getDate()} - ${DAYS_AR[d.getDay()]}`;
      },
      // Typography lives in index.css (.cell-date-day): the app's Arabic UI font, 14px/700, theme-aware colour. It cannot be set
      // here — the global `.ag-cell{font-size/font-weight !important}` and `html.light .ag-cell{color !important}` rules override an
      // inline cellStyle, which is why the old 11.5px Consolas style never took effect (and Consolas has no Arabic glyphs).
      cellClass: 'cell-date-day',
    },
    {
      field: 'department', headerName: 'القسم', width: 130,
      cellStyle: deptCell(),
    },
    {
      field: 'checkIn', headerName: 'الحضور', ...COL_MEDIUM,
      headerClass: 'ag-header-center',
      editable: editableNotOff,
      cellEditor: TimeCellEditor, cellEditorParams: { mode: 'datetime' },
      valueFormatter: p => fmtTime(p.value),
      cellClass: editCellClass('checkIn', editableNotOff),
      cellStyle: p => ({ ...timeCell(p.value), ...CENTER, fontSize: '12px' }),
    },
    {
      field: 'checkOut', headerName: 'الانصراف', ...COL_MEDIUM,
      headerClass: 'ag-header-center',
      editable: editableNotOff,
      cellEditor: TimeCellEditor, cellEditorParams: { mode: 'datetime' },
      valueFormatter: p => fmtTime(p.value),
      cellClass: editCellClass('checkOut', editableNotOff),
      cellStyle: p => ({
        ...NUM, ...CENTER, fontSize: '12px', fontWeight: '600',
        color: p.value ? 'var(--c-time)' : 'var(--c-muted)',
      }),
    },
    {
      field: 'workedMinutes', headerName: 'ساعات العمل', width: 115,
      headerClass: 'ag-header-center',
      editable: editableNotOff,
      cellEditor: TimeCellEditor, cellEditorParams: { mode: 'minutes' },
      valueFormatter: p => fmtWorkedHours(p.value),
      cellClass: editCellClass('workedMinutes', editableNotOff),
      cellStyle: p => ({
        ...NUM, ...CENTER,
        color:      (p.value || 0) > 0 ? 'var(--c-net)' : 'var(--c-muted)',
        fontWeight: (p.value || 0) > 0 ? '700' : '400',
      }),
    },
    {
      field: 'effectiveLatePenalty', headerName: 'خصم التأخير', ...COL_MEDIUM,
      headerClass: 'ag-header-center',
      editable: editableNotOff,
      cellEditor: 'agNumberCellEditor',
      cellEditorParams: { min: 0, step: 1, precision: 0 },
      valueFormatter: p => fmtEditableZero(p.value, fmtPenaltyUnits),
      cellClass: p => [
        editCellClass('effectiveLatePenalty', editableNotOff)(p),
        p.data?.manualLatePenaltyUnits != null ? 'cell-manual-override' : '',
      ].filter(Boolean).join(' '),
      tooltipValueGetter: p => p.data?.manualLatePenaltyUnits != null
        ? manualOverrideTooltip(p.data?.manualPenaltyByName, p.data?.manualPenaltyAt) : undefined,
      cellStyle: p => ({ ...penaltyCell(p.value), ...CENTER, alignItems:'center' }),
    },
    {
      field: 'effectiveOvertimeUnits', headerName: 'الإضافي', ...COL_MEDIUM,
      headerClass: 'ag-header-center',
      editable: editableNotOff,
      cellEditor: 'agNumberCellEditor',
      cellEditorParams: { min: 0, step: 0.5, precision: 1 },
      valueFormatter: p => fmtEditableZero(p.value, fmtOvertimeUnits),
      cellClass: p => [
        editCellClass('effectiveOvertimeUnits', editableNotOff)(p),
        p.data?.manualOvertimeUnits != null ? 'cell-manual-override' : '',
      ].filter(Boolean).join(' '),
      tooltipValueGetter: p => p.data?.manualOvertimeUnits != null
        ? manualOverrideTooltip(p.data?.manualPenaltyByName, p.data?.manualPenaltyAt) : undefined,
      cellStyle: p => ({ ...otCell(p.value), ...CENTER, alignItems:'center' }),
    },
    {
      field: 'effectiveEarlyPenalty', headerName: 'انصراف مبكر', width: 115,
      headerClass: 'ag-header-center',
      editable: editableNotOff,
      cellEditor: 'agNumberCellEditor',
      cellEditorParams: { min: 0, step: 1, precision: 0 },
      valueFormatter: p => fmtEditableZero(p.value, fmtPenaltyUnits),
      cellClass: p => [
        editCellClass('effectiveEarlyPenalty', editableNotOff)(p),
        p.data?.manualEarlyPenaltyUnits != null ? 'cell-manual-override' : '',
      ].filter(Boolean).join(' '),
      tooltipValueGetter: p => p.data?.manualEarlyPenaltyUnits != null
        ? manualOverrideTooltip(p.data?.manualPenaltyByName, p.data?.manualPenaltyAt) : undefined,
      cellStyle: p => ({ ...penaltyCell(p.value), ...CENTER, alignItems:'center' }),
    },
    {
      field: 'status', headerName: 'الحالة', width: 145, headerClass: 'ag-header-center',
      editable: true,
      cellEditor: 'agSelectCellEditor',
      cellEditorParams: {
        values: ['present','late','absent','early_leave','weekend','holiday'],
      },
      valueFormatter: p => (STATUS_LABELS[p.value]?.ar || '—') + (p.data?.lockedPunchConflict ? ' ⚠' : ''),
      cellClass: p => [
        editCellClass('status', () => true)(p),
        p.data?.manualEdit ? 'cell-manual-override' : '',
        p.data?.lockedPunchConflict ? 'cell-lock-conflict' : '',
        p.value === 'absent' ? 'status-absent' : '',
      ].filter(Boolean).join(' '),
      tooltipValueGetter: p => p.data?.lockedPunchConflict
        ? `⚠ توجد ${p.data.ignoredPunches || ''} بصمة خام لم تُطبَّق لأن السجل معدّل يدوياً — استخدم "استرجاع الحساب التلقائي"`
        : (p.data?.manualEdit ? manualOverrideTooltip(p.data?.manualPenaltyByName, p.data?.manualPenaltyAt) : undefined),
      cellStyle: p => ({
        justifyContent: 'center', fontWeight: '700', fontSize: '12px',
        fontFamily: 'Cairo, sans-serif',
        color:      STATUS_LABELS[p.value]?.color || 'var(--c-muted)',
        background: STATUS_LABELS[p.value]?.bg    || 'transparent',
      }),
    },
    {
      field: 'absenceType', headerName: 'نوع الغياب', width: 140,
      headerClass: 'ag-header-center',
      valueFormatter: p => p.data?.isAbsent ? (ABSENCE_TYPE_LABELS[p.value] || '—') : '',
      cellStyle: p => ({
        fontFamily: 'Cairo, sans-serif', fontSize: '12px',
        justifyContent: 'center', textAlign: 'center', fontWeight: '700',
        color: p.data?.isAbsent
          ? (p.data?.absenceType === 'without_permission' ? 'var(--c-red, #ef4444)'
            : p.data?.absenceType === 'with_permission' ? 'var(--c-green, #22c55e)'
            : p.data?.absenceType === 'custom' ? 'var(--accent, #1E7A34)'
            : 'var(--text-3)')
          : 'transparent',
        cursor: p.data?.isAbsent ? 'pointer' : 'default',
      }),
      onCellClicked: ({ data }) => {
        if (!data?.id || !data.isAbsent) return;
        setAbsenceModal({
          id: data.id,
          employeeName: data.employeeName,
          dateLabel: data.date,
          initialType: data.absenceType || null,
          initialPenaltyDays: data.penaltyDays || null,
          initialReason: data.absenceReason || '',
        });
      },
    },
    {
      field: 'penaltyDays', headerName: 'أيام الخصم', width: 105,
      headerClass: 'ag-header-center',
      valueFormatter: p => (p.data?.isAbsent && p.value != null) ? String(p.value) : '',
      cellStyle: p => ({
        fontFamily: 'Consolas, monospace', fontSize: '13px',
        justifyContent: 'center', textAlign: 'center', fontWeight: '700',
        color: p.data?.isAbsent
          ? (p.data?.penaltyDays != null ? 'var(--c-red, #ef4444)' : 'var(--text-3)')
          : 'transparent',
      }),
    },
  ].map(withHeaderFloor), [isNarrow]); // eslint-disable-line react-hooks/exhaustive-deps

  const defaultColDef = useMemo(() => ({ ...ENTERPRISE_DEFAULT_COL_DEF, cellClassRules: clip.cellClassRules }), [clip.cellClassRules]);

  // Shared priority chain — see gridDefaults.js#attendanceRowClass.
  const getRowClass = useCallback(attendanceRowClass, []);

  const getRowStyle = useCallback(({ data }) => {
    if (!data?.isMonitored) return undefined;
    const c = data.monitorColor || '#f59e0b';
    return { borderRight: `6px solid ${c}` };
  }, []);

  const getRowId = useCallback(p => String(p.data.id), []);

  // Assigns a ref only — safe with an empty dependency array.
  const handleGridReady = useCallback((p) => { gridApiRef.current = p.api; }, [gridApiRef]);

  // isActive/doesPassFilter come from useAttendanceFilter() and change
  // whenever the user changes the advanced filter bar — must stay in the
  // dependency array or these would close over stale filter state.
  const gridIsExternalFilterPresent = useCallback(() => isActive, [isActive]);
  const gridDoesExternalFilterPass = useCallback((p) => doesPassFilter(p.data), [doesPassFilter]);

  // ── Data loading ──────────────────────────────────────────────────────────
  // Guarded regardless of trigger (background live-sync OR manual refresh
  // button / Ctrl+Shift+R) — either can replace rowData mid-edit otherwise.
  const load = useCallback(async (showLoading = false) => {
    if (editCountRef.current > 0) { pendingReloadRef.current = true; return; }
    const t = guard.start(screenKey);
    if (showLoading) setLoading(true);
    try {
      const params = { month, year };
      if (deptId) params.departmentId = deptId;
      const { data } = await api.get('/attendance/monthly-detail', { params });
      // Dropped when the month/department changed meanwhile, or a later load already applied.
      if (!guard.accept(t)) return;
      // Rows saved (or being edited) after this request started keep their newer version.
      const keep = guard.claim(data, t);
      setRows(prev => keepCurrentRows(prev, data, keep));
    } catch {
      if (guard.keyMatches(t)) toast.error('تعذر تحميل بيانات الحضور الشهري');
    }
    finally { if (showLoading) setLoading(false); }
  }, [month, year, deptId]);

  // EP-014: targeted refresh — refetches just the named employee's rows for
  // the current month (still every day of that one employee, since the grid
  // is per-day, but a small fraction of the full company × month dataset)
  // instead of reloading every employee. Merges by replacing that employee's
  // existing rows wholesale — safe because the narrowed response is already
  // that employee's complete current-month row set, not a partial patch.
  const loadOne = useCallback(async (employeeIds) => {
    try {
      const t = guard.startOne(screenKey);
      const params = { month, year };
      if (deptId) params.departmentId = deptId;
      const fetched = await Promise.all(employeeIds.map(id =>
        api.get('/attendance/monthly-detail', { params: { ...params, employeeId: id } })
          .then(r => ({ employeeId: id, rows: Array.isArray(r.data) ? r.data : null }))
          // A failed refresh must NOT remove that employee's rows from the screen
          // (it used to resolve to [] and wipe them): leave them untouched instead.
          .catch(() => ({ employeeId: id, rows: null }))
      ));
      if (!guard.keyMatches(t)) return;                       // month/department changed meanwhile
      const ok = fetched.filter(f => f.rows);
      if (!ok.length) return;
      const keep = guard.claim(ok.flatMap(f => f.rows), t);
      setRows(rs => mergeEmployeeRows(rs, ok, keep));
    } catch { /* silent — next full reload (rules/device event) will catch up */ }
  }, [month, year, deptId]);

  useEffect(() => {
    api.get('/departments').then(r => {
      setDepts(r.data);
    }).catch(() => {});
  }, []);

  useEffect(() => { load(true); }, [load]);

  useRulesLiveSync(load, { isBusyRef: monthlyBusyRef });
  useDeviceLiveSync(load, { silent: true, isBusyRef: monthlyBusyRef, reloadOne: loadOne });

  // Persist filters across navigation
  useEffect(() => {
    localStorage.setItem(MONTHLY_FILTER_KEY, JSON.stringify({ month, year, deptId }));
  }, [month, year, deptId]);

  // Ctrl+Shift+R → refresh grid data
  useKeyboardShortcut('r', () => load(true), { ctrl: true, shift: true });

  // ── Core save for one record ──────────────────────────────────────────────
  const saveRecord = useCallback(async (data, field, newValue) => {
    if (!data?.id) return null;
    if (field === 'workedMinutes') {
      const mins = newValue ? (timeToMinutes(newValue) ?? 0) : 0;
      const res = await api.put(`/attendance/daily/${data.id}`, {
        workedMinutes: mins, reason: INLINE_REASON,
        modifiedByName: ACTOR, source: 'inline-grid',
      });
      return normalizeDailyUpdate(res.data);
    }
    if (['checkIn','checkOut','status'].includes(field)) {
      const res = await api.put(`/attendance/daily/${data.id}`, {
        modifiedByName: ACTOR, source: 'inline-grid', [field]: newValue,
      });
      return normalizeDailyUpdate(res.data);
    }
    const overrideKey = OVERRIDE_FIELD_MAP[field];
    if (!overrideKey) return null;
    const val = (newValue == null || newValue === '') ? null : Number(newValue);
    const res = await api.put(`/attendance/${data.id}/manual-penalty`, {
      [overrideKey]: val, overrideReason: INLINE_REASON,
      modifiedByName: ACTOR, source: 'inline-grid',
    });
    return normalizeDailyUpdate(res.data);
  }, []);

  // ── Cell edit handler (optimistic UI) ────────────────────────────────────
  // AG Grid has already committed newValue to the cell when this fires.
  // We fire the API in the background and revert on error — no cell locking.
  const handleCellEdit = useCallback(async ({ data, colDef, newValue, oldValue, node }) => {
    // A cancelled edit (Escape) also fires cellEditingStopped, with
    // newValue === undefined (a cleared field commits '' instead) — without
    // this guard the workedMinutes branch coerces undefined → 0 and saves it.
    if (newValue === undefined) return;
    if (!data?.id) return;
    const field = colDef.field;

    // Validation
    if (['checkIn','checkOut','workedMinutes'].includes(field)) {
      if (newValue && !HHMM_RE.test(newValue)) {
        toast.error('صيغة الوقت غير صحيحة (HH:mm)');
        node.setDataValue(field, oldValue);
        return;
      }
    }
    if (OVERRIDE_FIELD_MAP[field] && newValue != null && newValue !== '') {
      const n = Number(newValue);
      if (!Number.isFinite(n) || n < 0) {
        toast.error('القيمة يجب أن تكون رقمًا موجبًا');
        node.setDataValue(field, oldValue);
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
    } else if (field === 'checkIn' || field === 'checkOut') {
      if ((newValue || null) === (oldValue || null)) return;   // clearing an already-empty time cell is not an edit
    } else {
      if (newValue === oldValue) return;
    }

    // Save primary row — block background reloads for the duration of the PUT
    editCountRef.current++;
    guard.beginEdit([data.id]);
    const rowKey = `${data.id}:${field}`;
    savingCellsRef.current.add(rowKey);
    let primaryOk = false;
    try {
      const updated = await saveRecord(data, field, newValue);
      if (updated) {
        // Another field on this same row may still be saving (e.g. the user
        // tabbed to the next editable cell before this response landed) —
        // this response predates that sibling edit, so only apply the field
        // it's authoritative for instead of clobbering the sibling's
        // in-flight value with a stale full-row replace.
        const rowKeyPrefix = `${data.id}:`;
        const inFlightFields = Array.from(savingCellsRef.current)
          .filter(k => k.startsWith(rowKeyPrefix) && k !== rowKey).map(k => k.slice(rowKeyPrefix.length));
        const hasOtherFieldsInFlight = inFlightFields.length > 0;
        if (hasOtherFieldsInFlight) pendingReloadRef.current = true;
        guard.markFresh([data.id]);   // the PUT result is now the newest data for this row
        // The WHOLE server row is applied (so status / isAbsent / worked time derived from this edit are current — a
        // row can no longer show a time next to a stale "absent"); only the siblings still saving keep their own value.
        setRows(rs => applyRowFieldUpdate(rs, updated, field, inFlightFields));
        primaryOk = true;
        if (field === 'status' && newValue === 'absent') {
          setAbsenceModal({
            id: data.id,
            employeeName: data.employeeName,
            dateLabel: data.date,
            initialType: data.absenceType || null,
            initialPenaltyDays: data.penaltyDays || null,
            initialReason: data.absenceReason || '',
          });
        }
      }
    } catch (err) {
      if (isSessionLostError(err) && ['checkIn', 'checkOut', 'status'].includes(field)) {
        // The session ended while this edit was in flight (or was refused before sending). Do NOT silently revert the typed value:
        // keep it in the cell, flag the cell as NOT saved, and remember it in memory as a retryable op. It is re-sent only when the
        // user signs in again and presses «إعادة المحاولة» — never automatically. Nothing is reported as saved.
        clip.setCellState(data.id, field, 'failed', {
          op: { rowId: data.id, employeeId: data.employeeId, employeeName: data.employeeName, date: data.date, field, value: newValue },
          error: 'انتهت الجلسة — لم يُحفظ',
        });
        toast.error('انتهت الجلسة — التعديل لم يُحفظ بعد. سجّل الدخول ثم اضغط «إعادة المحاولة» أسفل الشاشة', { id: 'edit-not-saved', duration: 9000 });
        savingCellsRef.current.delete(rowKey);
        guard.endEdit([data.id]);
        editCountRef.current--;
        return;
      }
      toast.error(err?.response?.data?.error || 'فشل التحديث');
      node.setDataValue(field, oldValue);
      savingCellsRef.current.delete(rowKey);
      guard.endEdit([data.id]);
      editCountRef.current--;
      if (editCountRef.current === 0 && pendingReloadRef.current) { pendingReloadRef.current = false; load(false); }
      return;
    }
    savingCellsRef.current.delete(rowKey);
    guard.endEdit([data.id]);
    editCountRef.current--;
    if (!primaryOk) return;

    // Bulk: apply to all other selected rows in the same field
    const otherNodes = (gridRef.current?.api?.getSelectedNodes() || [])
      .filter(n => n.data?.id !== data.id && !n.data?.isHoliday);

    if (otherNodes.length === 0) {
      if (editCountRef.current === 0 && pendingReloadRef.current) { pendingReloadRef.current = false; load(false); }
      return;
    }

    editCountRef.current += otherNodes.length;
    guard.beginEdit(otherNodes.map(n => n.data.id));
    let bulkCount = 1;
    await Promise.all(otherNodes.map(async n => {
      try {
        const updated = await saveRecord(n.data, field, newValue);
        if (updated) {
          guard.markFresh([n.data.id]);
          setRows(rs => replaceAttendanceRow(rs, updated));
          bulkCount++;
        }
      } catch {}
      finally {
        guard.endEdit([n.data.id]);
        editCountRef.current--;
        if (editCountRef.current === 0 && pendingReloadRef.current) { pendingReloadRef.current = false; load(false); }
      }
    }));
    toast.success(`تم تطبيق القيمة على ${bulkCount} سجل`);
  }, [saveRecord, load]);

  const handleAbsenceSave = useCallback(async ({ absenceType, penaltyDays, absenceReason }) => {
    if (!absenceModal?.id) return;
    editCountRef.current++;
    guard.beginEdit([absenceModal.id]);
    setAbsenceSaving(true);
    try {
      const { data: updated } = await api.put(`/attendance/${absenceModal.id}/absence-type`, {
        absenceType, penaltyDays, absenceReason, modifiedByName: ACTOR,
      });
      guard.markFresh([absenceModal.id]);
      setRows(rs => replaceAttendanceRow(rs, updated));
      toast.success('تم تحديث نوع الغياب');
      setAbsenceModal(null);
    } catch (err) {
      toast.error(err?.response?.data?.error || 'فشل تحديث نوع الغياب');
    } finally {
      guard.endEdit([absenceModal.id]);
      editCountRef.current--;
      setAbsenceSaving(false);
      if (editCountRef.current === 0 && pendingReloadRef.current) { pendingReloadRef.current = false; load(false); }
    }
  }, [absenceModal, load]);

  const handleProcess = async () => {
    setProc(true);
    try {
      const { data: pm } = await api.post('/attendance/process-month', { month, year }, LONG_OP);
      toast.success('تمت معالجة الشهر بنجاح');
      const closedNote = closedSkipMessage(pm?.skippedClosedPayroll);
      if (closedNote) toast(closedNote, { icon: '⚠️', duration: 12000 });
      load(true);
    } catch { toast.error('فشل في المعالجة'); }
    finally { setProc(false); }
  };

  const exportCSV = () =>
    gridRef.current?.api?.exportDataAsCsv({ fileName: `حضور_شهري_${year}_${month}.csv` });

  // Shared by both print buttons: the Grid's own post-filter daily-detail
  // node set (forEachNodeAfterFilter — reflects both the custom filter bar's
  // external filter AND AG Grid's built-in per-column header filters).
  const collectFilteredRows = useCallback(() => {
    const filtered = [];
    if (gridRef.current?.api) {
      gridRef.current.api.forEachNodeAfterFilter(node => {
        if (node.data) filtered.push(node.data);
      });
    } else {
      filtered.push(...rows);
    }
    return filtered;
  }, [rows]);

  // "طباعة" — daily-detail report: one row per employee per day, exactly
  // what the Grid shows. node.data IS a /attendance/monthly-detail row,
  // field-for-field what REPORT_COLUMNS.attendance_monthly expects — no
  // fetch, no aggregation. Stable-sorted by date ascending on top of the
  // Grid's filtered node order so the printed report always reads
  // start-of-month → end-of-month, Grid order preserved as the tiebreaker
  // for same-date rows. UNCHANGED — do not modify.
  const openPrint = useCallback(() => {
    const printData = collectFilteredRows();
    printData.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    setPrintRows(printData);
    setPrintOpen(true);
  }, [collectFilteredRows]);

  // "طباعة الملخص" — a SEPARATE action from "طباعة": the OLD per-employee-
  // per-month aggregate report (summary/KPI cards + one row per employee for
  // the month), reusing the same canonical /attendance/monthly aggregate
  // endpoint and field set "طباعة" used before the daily-detail redesign.
  // Employee selection reuses the identical Grid-filter pipeline (Grid's
  // filtered daily nodes -> employeeId Set -> filter the aggregate rows by
  // those IDs) — same source of truth as "طباعة", just applied to the
  // aggregate dataset instead of the daily one. KPI totals are plain sums of
  // the aggregate's own already-computed fields (workDays/absentDays/
  // totalHours/totalEffectiveLatePenalty/totalEffectiveOvertimeUnits/
  // totalEffectiveDeductionUnits) — no new calculation, just the existing
  // aggregate numbers scoped to the filtered employee set.
  const openSummaryPrint = useCallback(async () => {
    setSummaryPrintLoading(true);
    try {
      const params = { month, year };
      if (deptId) params.departmentId = deptId;
      const { data } = await api.get('/attendance/monthly', { params });

      const passingEmployeeIds = new Set(collectFilteredRows().map(r => r.employeeId).filter(id => id != null));
      const filteredAggregate = data.filter(r => passingEmployeeIds.has(r.employeeId));

      const sum = k => filteredAggregate.reduce((s, r) => s + (r[k] || 0), 0);
      setSummaryPrintStats([
        { label: 'عدد الموظفين',     value: filteredAggregate.length, color: 'blue' },
        { label: 'أيام حضور',        value: sum('workDays'), color: 'green' },
        { label: 'أيام غياب',        value: sum('absentDays'), color: 'red' },
        { label: 'إجمالي الساعات',   value: fmtWorkedHours(sum('totalHours') * 60), color: 'blue' },
        { label: 'إجمالي التأخير',   value: fmtPenaltyUnits(sum('totalEffectiveLatePenalty')), color: 'amber' },
        { label: 'إجمالي الإضافي',   value: fmtOvertimeUnits(sum('totalEffectiveOvertimeUnits')), color: 'purple' },
        { label: 'إجمالي الخصومات',  value: fmtPenaltyUnits(sum('totalEffectiveDeductionUnits')), color: 'red' },
      ]);
      const deptName = deptId ? (departments.find(d => d.id === deptId)?.name || '') : 'جميع الأقسام';
      setSummaryPrintMeta({ period: `${MONTHS_AR[month - 1]} ${year}`, generatedBy: ACTOR, subtitle: `القسم: ${deptName}` });
      setSummaryPrintRows(filteredAggregate);
      setSummaryPrintOpen(true);
    } catch {
      toast.error('تعذر تحميل بيانات ملخص الحضور الشهري');
    } finally {
      setSummaryPrintLoading(false);
    }
  }, [month, year, deptId, departments, collectFilteredRows]);

  // ── Excel-style paste: validated plan → the existing PUT /attendance/daily/:id → per-cell states ────────
  const runPasteOps = useCallback(async (ops) => {
    const c = clip;
    const ids = [...new Set(ops.map(o => o.rowId))];
    editCountRef.current += ids.length;                 // background reloads wait until every save has finished
    ids.forEach(id => guard.beginEdit([id]));
    ops.forEach(o => c.setCellState(o.rowId, o.field, 'saving', { op: o }));
    let res = null;
    try {
      res = await bulkSaver.save(ops, {
        onCell: (op, state, info = {}) => c.setCellState(op.rowId, op.field, state, { op, ...info }),
        onRowSaved: (updated, rowId) => { guard.markFresh([rowId]); setRows(rs => replaceAttendanceRow(rs, updated)); },
      });
    } finally {
      ids.forEach(id => guard.endEdit([id]));
      editCountRef.current -= ids.length;
    }
    const nSaved = res.saved.length, nAdj = res.adjusted.length, nFail = res.failed.length;
    if (nFail === 0 && nAdj === 0) toast.success(`تم حفظ ${nSaved} خلية في ${res.rows} سجل`);
    else if (nSaved + nAdj > 0) toast(`تم حفظ ${nSaved + nAdj} من ${ops.length} — فشل ${nFail}${nAdj ? ` — ${nAdj} بقيمة مختلفة` : ''}`, { icon: '⚠️', duration: 6000 });
    else toast.error(`لم يتم حفظ أي خلية (${nFail} فشل)`);
    if (res.protectedRows > 0) toast(`${res.protectedRows} سجل ضمن مرتب معتمد/مدفوع: تم تعديل الحضور ولم يُعاد احتساب الراتب`, { icon: 'ℹ️', duration: 7000 });
    setTimeout(() => c.clearCellStates((k, v) => v.state !== 'saved'), 2500);   // the green "saved" mark fades; failures stay
    if (editCountRef.current === 0) { pendingReloadRef.current = false; load(false); }   // re-read AttendanceDaily: what is shown is what is stored
    return res;
  }, [clip, guard, bulkSaver, load]);

  const handlePastePlan = useCallback(async (plan) => {
    const c = clip;
    c.clearCellStates((k, v) => v.state === 'failed');             // earlier failures stay retryable; everything else resets
    if (plan.errors.length) {
      plan.errors.forEach(er => c.setCellState(er.rowId, er.field, 'invalid', { error: er.reason, text: er.text }));
      const first = plan.errors.slice(0, 3).map(er => `${er.employeeName || ''} ${er.date || ''}: "${er.text}" — ${er.reason}`).join(' | ');
      toast.error(`لم يتم اللصق: ${plan.errors.length} قيمة غير صالحة. ${first}`, { duration: 9000 });
      return;
    }
    if (!plan.ops.length) {
      toast(plan.skipped.length
        ? `لا توجد خلايا قابلة للكتابة (${plan.skipped.length} تم تخطيها: ${plan.skipped[0].reason})`
        : (plan.unchanged ? 'القيم الملصوقة مطابقة للموجودة — لا تغييرات' : 'لا توجد بيانات للصق'), { icon: 'ℹ️' });
      return;
    }
    const rowsN = new Set(plan.ops.map(o => o.rowId)).size;
    if (plan.ops.length > 20 && !window.confirm(`سيتم تعديل ${plan.ops.length} خلية في ${rowsN} سجل حضور وتسجيلها في سجل التدقيق. متابعة؟`)) return;
    const notes = [];
    if (plan.skipped.length) notes.push(`${plan.skipped.length} تم تخطيها`);
    if (plan.unchanged) notes.push(`${plan.unchanged} بدون تغيير`);
    if (plan.clipped) notes.push(`${plan.clipped} خارج الجدول`);
    if (notes.length) toast(notes.join(' · '), { icon: 'ℹ️', duration: 4000 });
    await runPasteOps(plan.ops);
  }, [clip, runPasteOps]);
  pasteHandlerRef.current = handlePastePlan;

  const retryFailedPaste = useCallback(() => {
    const ops = clip.stateSummary().failedItems.map(v => v.op).filter(Boolean);
    if (ops.length) runPasteOps(ops);
  }, [clip, runPasteOps]);

  // ── Restore automatic calculation (admin / hr) ────────────────────────────────
  // A row an HR user edited is locked (manualEdit) and every automatic path skips it, so punches that arrive later never
  // reach it. This calls the EXISTING POST /attendance/daily/:id/restore-auto per row: it clears the lock, recomputes the
  // row from the raw punches (through the same engine, Friday / holiday rules included), writes the audit entry
  // (manualEdit true -> false, who, why) and leaves finalized / paid payroll untouched. Server-side authorisation is
  // unchanged; this only hides the button from roles the server would reject anyway.
  const authEnabled = useAuthStore((s) => s.authEnabled);
  const authUser = useAuthStore((s) => s.user);
  const canRestoreAuto = authEnabled !== true || ['admin', 'hr'].includes(authUser?.role);
  const [restoring, setRestoring] = useState(false);
  const restoreAuto = useCallback(async (targets) => {
    if (!targets.length || restoring) return;
    const sample = targets.slice(0, 5).map(r => `• ${r.employeeName || ''}  ${r.date || ''}`).join('\n');
    const ok = window.confirm(
      `استرجاع الحساب التلقائي لـ ${targets.length} سجل؟\n\n${sample}${targets.length > 5 ? '\n…' : ''}\n\n` +
      'سيُلغى قفل التعديل اليدوي وتُعاد حسابات هذه الأيام من البصمات الخام. الأوقات والحالة المعدّلة يدوياً ستُستبدل بنتيجة البصمات ' +
      '(الجمعة والعطلات تبقى حسب القواعد الثابتة)، ويُسجَّل الاسترجاع في سجل التدقيق. الرواتب المعتمدة/المدفوعة لا تتأثر.\n\nمتابعة؟'
    );
    if (!ok) return;
    setRestoring(true);
    editCountRef.current += 1;               // hold background reloads until every restore has finished
    let done = 0, protectedN = 0; const failed = [];
    try {
      for (const r of targets) {
        try {
          const res = await api.post(`/attendance/daily/${r.id}/restore-auto`, {
            reason: 'استرجاع الحساب التلقائي من شاشة الحضور الشهري', modifiedByName: ACTOR,
          });
          done++;
          if (res?.data?.payrollProtected) protectedN++;
        } catch (err) {
          failed.push(`${r.employeeName || ''} ${r.date || ''}: ${err.response?.data?.error || err.message}`);
        }
      }
    } finally {
      editCountRef.current -= 1;
      setRestoring(false);
    }
    if (done) toast.success(`تم استرجاع الحساب التلقائي لـ ${done} سجل`);
    if (protectedN) toast(`${protectedN} سجل ضمن راتب معتمد/مدفوع: حُدّث الحضور ولم يُعاد احتساب الراتب`, { icon: 'ℹ️', duration: 7000 });
    if (failed.length) toast.error(`تعذّر استرجاع ${failed.length} سجل — ${failed.slice(0, 2).join(' | ')}`, { duration: 9000 });
    pendingReloadRef.current = false;
    load(false);
  }, [restoring, load]);

  // A different month / department / sort / filter changes which cell is at which index → drop the selection.
  useEffect(() => { clip.resetSelection(); }, [month, year, deptId]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ── Copy / paste a manual attendance entry (shared workflow) ──────────────
  const paste = useAttendancePaste({
    selected: selectedRows,
    onBegin: (t) => { editCountRef.current++; guard.beginEdit([t.id]); },
    onSaved: (updated, t) => { guard.markFresh([t.id]); setRows(rs => replaceAttendanceRow(rs, updated)); },
    onEnd: (t) => {
      guard.endEdit([t.id]);
      editCountRef.current--;
      if (editCountRef.current === 0 && pendingReloadRef.current) { pendingReloadRef.current = false; load(false); }
    },
  });

  const summary = useMemo(() => ({
    present: rows.filter(r => ['present','late','early_leave'].includes(r.status)).length,
    absent:  rows.filter(r => r.isAbsent).length,
    late:    rows.filter(r => (r.effectiveLatePenalty   || 0) > 0).length,
    ot:      rows.filter(r => (r.effectiveOvertimeUnits || 0) > 0).length,
  }), [rows]);

  return (
    <div className="flex flex-col gap-3" style={{ flex: 1, minHeight: 0 }} dir="rtl">

      <div className="page-header">
        <div>
          <h1 className="page-title">كشف الحضور الشهري</h1>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>
            {MONTHS_AR[month - 1]} {year}
            &nbsp;·&nbsp;{rows.length} سجل
            &nbsp;·&nbsp;انقر مرتين أو اكتب مباشرة لتعديل أي خلية &nbsp;·&nbsp;حدّد نطاقاً (سحب / Shift) ثم Ctrl+C / Ctrl+V للنسخ واللصق
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={paste.copy} disabled={!paste.canCopy} className="btn-secondary text-xs py-1.5 px-3"
            title={paste.canCopy ? 'نسخ قيم الحركة المحددة' : 'حدّد حركة واحدة لنسخها'}>
            <Copy className="w-3.5 h-3.5" /> نسخ الحركة
          </button>
          <button onClick={paste.openPaste} disabled={!paste.canPaste} className="btn-secondary text-xs py-1.5 px-3"
            title={paste.blockReason || `لصق حركة ${paste.clip.sourceName} (${paste.clip.sourceDate})`}>
            <ClipboardPaste className="w-3.5 h-3.5" /> لصق الحركة
          </button>
          <button onClick={exportCSV} className="btn-secondary text-xs py-1.5 px-3">
            <Download className="w-3.5 h-3.5" /> CSV
          </button>
          <button onClick={openPrint} className="btn-secondary text-xs py-1.5 px-3">
            <Printer className="w-3.5 h-3.5" />
            طباعة
          </button>
          <button onClick={openSummaryPrint} className="btn-secondary text-xs py-1.5 px-3" disabled={summaryPrintLoading}>
            {summaryPrintLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileBarChart className="w-3.5 h-3.5" />}
            طباعة الملخص
          </button>
          <button onClick={handleProcess} className="btn-primary text-xs py-1.5 px-3" disabled={processing}
            title="إعادة تطبيق قواعد الحضور والانصراف على الشهر المحدد لجميع الموظفين">
            {processing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {processing ? 'جاري...' : 'معالجة الشهر'}
          </button>
        </div>
      </div>

      <div className="card p-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <select
            className="input w-auto text-xs py-1.5"
            value={month}
            onChange={e => setMonth(parseInt(e.target.value))}
          >
            {MONTHS_AR.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select>
          <select
            className="input w-auto text-xs py-1.5"
            value={year}
            onChange={e => setYear(parseInt(e.target.value))}
          >
            {getYearRange().map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <select
            className="input w-auto text-xs py-1.5"
            value={deptId}
            onChange={e => setDeptId(parseInt(e.target.value))}
          >
            <option value={0}>جميع الأقسام</option>
            {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <button onClick={() => load(true)} className="btn-ghost p-1.5 rounded" title="تحديث البيانات (Ctrl+Shift+R)">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div className="hidden md:flex items-center gap-5 text-xs font-semibold">
          <span className="flex items-center gap-1.5" style={{ color: 'var(--c-green)' }}>
            <CheckCircle className="w-3.5 h-3.5" /> {summary.present} حاضر
          </span>
          <span className="flex items-center gap-1.5" style={{ color: 'var(--c-red)' }}>
            <XCircle className="w-3.5 h-3.5" /> {summary.absent} غائب
          </span>
          <span className="flex items-center gap-1.5" style={{ color: 'var(--c-penalty)' }}>
            <Clock className="w-3.5 h-3.5" /> {summary.late} متأخر
          </span>
          <span className="flex items-center gap-1.5" style={{ color: 'var(--c-ot)' }}>
            <TrendingUp className="w-3.5 h-3.5" /> {summary.ot} إضافي
          </span>
        </div>
      </div>

      {/* Filter bar */}
      <AttendanceFilterBar
        filters={filters}
        updateFilter={updateFilter}
        toggleArrayItem={toggleArrayItem}
        applyQuick={applyQuick}
        clearFilters={clearFilters}
        isActive={isActive}
        departments={departments.map(d => d.name)}
      />

      {(() => {
        const conflictRows = rows.filter(r => r.lockedPunchConflict);
        const selectedLocked = selectedRows.filter(r => r.manualEdit || r.lockedPunchConflict);
        if (!conflictRows.length && !selectedLocked.length) return null;
        return (
          <div className="card px-3 py-2 flex flex-wrap items-center gap-3 text-xs" role="alert" data-testid="locked-punch-banner"
            style={{ borderInlineStart: '3px solid var(--c-penalty, #d97706)' }}>
            {conflictRows.length > 0 && (
              <span>
                ⚠ <b>{conflictRows.length}</b> سجل معدّل يدوياً توجد له بصمات خام لم تُحتسب في الحضور
                {conflictRows.length <= 3 && ' (' + conflictRows.map(r => `${r.employeeName} ${r.date}`).join('، ') + ')'}
              </span>
            )}
            {canRestoreAuto && conflictRows.length > 0 && (
              <button disabled={restoring} onClick={() => restoreAuto(conflictRows)} className="btn-secondary text-xs py-0.5 px-2" data-testid="restore-conflicts">
                استرجاع الحساب التلقائي للسجلات المتأثرة ({conflictRows.length})
              </button>
            )}
            {canRestoreAuto && selectedLocked.length > 0 && (
              <button disabled={restoring} onClick={() => restoreAuto(selectedLocked)} className="btn-secondary text-xs py-0.5 px-2" data-testid="restore-selected">
                استرجاع الحساب التلقائي للمحدد ({selectedLocked.length})
              </button>
            )}
            {!canRestoreAuto && conflictRows.length > 0 && <span style={{ color: 'var(--text-3)' }}>الاسترجاع متاح لمدير النظام أو الموارد البشرية فقط</span>}
          </div>
        );
      })()}

      {(() => {
        const st = clip.stateSummary();
        const show = clip.selectionCount > 1 || clip.copiedCount > 0 || st.saving || st.saved || st.adjusted || st.failed || st.invalid;
        if (!show) return null;
        return (
          <div className="card px-3 py-1.5 flex flex-wrap items-center gap-3 text-xs" role="status" aria-live="polite" data-testid="grid-clip-status"
            style={{ borderInlineStart: '3px solid var(--accent)' }}>
            {clip.selectionCount > 1 && <span>المحدد: <b>{clip.selectionCount}</b> خلية</span>}
            {clip.copiedCount > 0 && <span>منسوخ: <b>{clip.copiedCount}</b> (Esc للإلغاء)</span>}
            {st.saving > 0 && <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> جاري الحفظ… ({st.saving})</span>}
            {st.saved > 0 && <span style={{ color: 'var(--c-green)' }}>✔ تم الحفظ: {st.saved}</span>}
            {st.adjusted > 0 && <span style={{ color: 'var(--c-penalty)' }}>⚠ حُفظ بقيمة مختلفة: {st.adjusted}</span>}
            {st.invalid > 0 && <span style={{ color: 'var(--c-red)' }}>✖ قيم غير صالحة: {st.invalid}</span>}
            {st.failed > 0 && (
              <span className="flex items-center gap-2" style={{ color: 'var(--c-red)' }}>
                ✖ فشل الحفظ: {st.failed}
                <button onClick={retryFailedPaste} className="btn-secondary text-xs py-0.5 px-2">إعادة المحاولة</button>
                <button onClick={() => clip.clearCellStates(() => false)} className="btn-ghost text-xs py-0.5 px-2">إخفاء</button>
              </span>
            )}
            {st.failed > 0 && <span style={{ color: 'var(--text-3)' }}>{st.failedItems.slice(0, 2).map(v => `${v.op?.employeeName || ''} ${v.op?.date || ''}: ${v.error}`).join(' | ')}</span>}
          </div>
        );
      })()}

      <div className="flex-1 overflow-hidden" style={{ minHeight: 0 }}>
        <div className={`${agGridTheme} h-full`} {...clip.wrapperProps}>
          <AgGridReact
            ref={gridRef}
            rowData={rows}
            columnDefs={cols}
            defaultColDef={defaultColDef}
            {...ENTERPRISE_GRID_PROPS}
            getRowId={getRowId}
            getRowClass={getRowClass}
            getRowStyle={getRowStyle}
            onCellEditingStopped={handleCellEdit}
            onSelectionChanged={() => setSelectedRows(gridRef.current?.api?.getSelectedRows() ?? [])}
            onGridReady={(p) => { handleGridReady(p); clip.refreshColMap(); }}
            onCellMouseDown={clip.gridProps.onCellMouseDown}
            onCellMouseOver={clip.gridProps.onCellMouseOver}
            onCellFocused={clip.gridProps.onCellFocused}
            onDisplayedColumnsChanged={clip.gridProps.onDisplayedColumnsChanged}
            onSortChanged={clip.resetSelection}
            onFilterChanged={clip.resetSelection}
            isExternalFilterPresent={gridIsExternalFilterPresent}
            doesExternalFilterPass={gridDoesExternalFilterPass}
            singleClickEdit={false}
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
            enableCellTextSelection={false}
            loading={loading}
          />
        </div>
      </div>

      <PrintPreviewModal
        isOpen={printOpen}
        onClose={() => setPrintOpen(false)}
        data={printRows}
        reportType="attendance_monthly"
        meta={{ period: `${MONTHS_AR[month - 1]} ${year}`, generatedBy: ACTOR }}
        orientation="landscape"
      />

      <PrintPreviewModal
        isOpen={summaryPrintOpen}
        onClose={() => setSummaryPrintOpen(false)}
        data={summaryPrintRows}
        customStats={summaryPrintStats}
        title="تقرير الحضور الشهري"
        reportType="attendance_monthly_summary"
        meta={summaryPrintMeta}
        orientation="landscape"
      />

      <PasteAttendanceModal {...paste.modalProps} />

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
