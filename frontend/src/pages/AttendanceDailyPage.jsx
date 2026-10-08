import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';
import {
  RefreshCw, Download, ChevronRight, ChevronLeft,
  CheckCircle, XCircle, Clock, TrendingUp, Loader2, Play, Printer,
  Fingerprint, Pencil, Lock, UserX, Copy, ClipboardPaste } from 'lucide-react';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';
import api, { LONG_OP } from '../lib/api';
import { AG_GRID_LOCALE_AR } from '../lib/agGridLocale';
import { todayStr, addDays } from '../lib/businessDate';
import { fmtTime, fmtOTHours, fmtWorkedHours, fmtPenaltyUnits, fmtOvertimeUnits, fmtEditableZero, timeToMinutes, STATUS_LABELS, manualOverrideTooltip } from '../lib/formatters';
import { useTheme } from '../contexts/ThemeContext';
import { useIsNarrowViewport } from '../hooks/useIsNarrowViewport';
import { useGridPagination } from '../hooks/useGridPagination';
import {
  NUM, CENTER, nameCell, codeCell, deptCell,
  otCell, penaltyCell, timeCell, rowNumCell, mutedCell } from '../lib/cellStyles';
import { ENTERPRISE_DEFAULT_COL_DEF, ENTERPRISE_GRID_PROPS, COL_MEDIUM, COL_LARGE, tabToNextCell, safeRefreshCells, isAbsentRow, attendanceRowClass } from '../lib/gridDefaults';
import PrintPreviewModal from '../components/PrintPreviewModal';
import FingerprintSyncModal from '../components/FingerprintSyncModal';
import TimeCellEditor from '../components/grid/TimeCellEditor';
import { useRulesLiveSync } from '../hooks/useRulesLiveSync';
import { useDeviceLiveSync } from '../hooks/useDeviceLiveSync';
import { useFingerprintSyncWorkflow } from '../hooks/useFingerprintSyncWorkflow';
import { useKeyboardShortcut } from '../hooks/useKeyboardShortcut';
import AbsenceTypeModal, { ABSENCE_TYPE_LABELS } from '../components/AbsenceTypeModal';
import PasteAttendanceModal from '../components/PasteAttendanceModal';
import AttendanceFilterBar from '../components/AttendanceFilterBar';
import { MobileActionsMenu } from '../components/ui';
import { useAttendanceFilter } from '../hooks/useAttendanceFilter';
import { ACTOR, HHMM_RE, OVERRIDE_FIELD_MAP, toHHMM, normalizeDailyUpdate, replaceAttendanceRow, replaceAttendanceRows, applyRowFieldUpdate } from '../lib/attendanceUtils';

const INLINE_REASON = 'تعديل مباشر من الجدول (Inline Grid)';

const DAILY_FILTER_KEY = 'attendanceDailyFilters';
function loadDailyFilters() {
  try { return JSON.parse(localStorage.getItem(DAILY_FILTER_KEY)) || {}; } catch { return {}; }
}

// Today's LOCAL calendar day as YYYY-MM-DD. (toISOString() is the UTC date, which
// is still yesterday between 00:00 and 02:00/03:00 in Egypt.)
const localToday = todayStr;

// The page opens on today. A manually chosen date is only remembered for
// navigating away and back on the SAME local day; a date saved on an earlier
// day (or by a version that stored no day) is never restored, so the screen
// can't open on a stale day.
function initialDailyDate(saved) {
  return saved.date && saved.savedOn === localToday() ? saved.date : localToday();
}

export default function AttendanceDailyPage() {
  const { agGridTheme } = useTheme();
  const navigate = useNavigate();
  const _saved = loadDailyFilters();
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(false);
  const [processing, setProc] = useState(false);
  const [date, setDate]       = useState(initialDailyDate(_saved));
  const [printOpen, setPrintOpen] = useState(false);
  const fpSync = useFingerprintSyncWorkflow();
  const syncing = fpSync.state.phase === 'running';
  const [editMode, setEditMode]   = useState(true); // default ON — no mode switch needed
  const [departments, setDepts]   = useState([]);
  const [absenceModal, setAbsenceModal] = useState(null);
  const [absenceSaving, setAbsenceSaving] = useState(false);
  const [selectedRows, setSelectedRows] = useState([]);
  const [bulkSaving, setBulkSaving] = useState(false);
  // Copy/paste of a manual attendance entry. The clipboard is plain page state
  // holding ONLY the pasteable values (never an employee id or audit data).
  const [attClipboard, setAttClipboard] = useState(null);
  const [pasteTarget, setPasteTarget]   = useState(null);
  const [pasteSaving, setPasteSaving]   = useState(false);
  const gridRef = useRef();
  // per-cell "saving" affordance
  const savingCellsRef = useRef(new Set());
  // counts in-flight PUT requests — background load(false) skipped while > 0
  const editCountRef   = useRef(0);
  // set to true when a background reload was skipped; cleared + fired on counter-zero
  const pendingReloadRef = useRef(false);

  // ── Stale-GET protection ───────────────────────────────────────────────────
  // load()/loadOne() responses can arrive AFTER a newer manual save was already
  // applied (a background refresh that started before the PUT committed). Without
  // a guard, setRows() would put that older snapshot over the saved edit.
  // A logical clock orders everything: each request records the clock value at
  // which it STARTED, and each row remembers the clock value of the data it
  // currently shows (originRef). A response row replaces the shown row only if
  // its request started no earlier than that row's origin, and never while that
  // employee has an edit in flight. A save stamps its row when it is applied, so
  // every request that began before the save is ignored for that row — while the
  // rest of the same response still refreshes normally (no refresh is blocked).
  const dateRef         = useRef(date);
  dateRef.current       = date;
  const clockRef        = useRef(0);
  const originRef       = useRef(new Map());   // employeeId -> clock of the data on screen
  const editingEmpRef   = useRef(new Map());   // employeeId -> edits currently in flight
  const loadSeqRef      = useRef(0);           // full-grid load start counter
  const appliedLoadRef  = useRef(0);           // newest full load already applied
  const beginRowEdit = useCallback((ids) => {
    for (const id of ids) editingEmpRef.current.set(id, (editingEmpRef.current.get(id) || 0) + 1);
  }, []);
  const endRowEdit = useCallback((ids) => {
    for (const id of ids) {
      const n = (editingEmpRef.current.get(id) || 0) - 1;
      if (n > 0) editingEmpRef.current.set(id, n); else editingEmpRef.current.delete(id);
    }
  }, []);
  const markRowsFresh = useCallback((ids) => {
    const c = ++clockRef.current;
    for (const id of ids) if (id != null) originRef.current.set(id, c);
  }, []);
  const isRowStale = useCallback(
    (employeeId, startClock) =>
      (editingEmpRef.current.get(employeeId) || 0) > 0 ||
      startClock < (originRef.current.get(employeeId) ?? 0),
    [],
  );

  // ── Filter system ─────────────────────────────────────────────────────────
  const {
    filters, updateFilter, toggleArrayItem, applyQuick, clearFilters,
    doesPassFilter, isActive, gridApiRef,
  } = useAttendanceFilter();

  const markSaving = useCallback((rowId, field, node, saving) => {
    const key = `${rowId}:${field}`;
    if (saving) savingCellsRef.current.add(key);
    else savingCellsRef.current.delete(key);
    safeRefreshCells(gridRef, rowId, node, [field]);
  }, []);

  // Weekly holidays (isWeekend) remain editable — see attendanceEngine.js
  // processDate(): the engine converts worked time on a weekly holiday into
  // a "holiday work day" (all worked time = overtime, no penalties) whether
  // the punch is manual or automatic. Public holidays (isHoliday) stay locked.
  const editableNotOff = p => !p.data?.isHoliday;

  const editCellClass = (field, editableFn) => p => {
    if (!p.data) return '';
    const classes = [];
    if (editableFn(p)) classes.push('cell-editable');
    if (p.data.id != null && savingCellsRef.current.has(`${p.data.id}:${field}`)) classes.push('cell-saving');
    return classes.join(' ');
  };

  // Pinned-right columns (checkbox + # + code + name) sum to ~400px, which
  // alone exceeds a narrow phone's entire viewport width, leaving no room
  // for the scrollable data columns. Below ~480px, only the name column
  // (the one identity anchor worth keeping visible while scrolling) stays
  // pinned — the rest flow into the normal scrollable region instead.
  const isNarrow = useIsNarrowViewport(480);
  const pagination = useGridPagination(50, [25, 50, 100]);

  const cols = useMemo(() => [
    {
      headerName:'', width:44, pinned: isNarrow ? undefined : 'right',
      sortable:false, filter:false, resizable:false,
      checkboxSelection: true, headerCheckboxSelection: true,
      headerCheckboxSelectionFilteredOnly: true },
    {
      headerName:'#', valueGetter:'node.rowIndex + 1', width:50, pinned: isNarrow ? undefined : 'right',
      sortable:false, filter:false, headerClass:'ag-header-center',
      cellStyle: rowNumCell() },
    {
      field:'employeeCode', headerName:'كود', width:88, pinned: isNarrow ? undefined : 'right',
      cellStyle: codeCell() },
    {
      field:'employeeName', headerName:'اسم الموظف', width:220, minWidth:180, pinned:'right',
      cellStyle: (p) => p.data?.isMonitored ? { ...nameCell(), color: p.data.monitorColor || '#f59e0b', fontWeight: '800' } : nameCell(),
      // Slightly-darker name treatment for absent rows (skipped when
      // monitored — that badge color already takes visual priority, same
      // as the row-class chain in gridDefaults.js#attendanceRowClass).
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
      field:'department', headerName:'القسم', ...COL_LARGE,
      cellStyle: deptCell() },
    {
      field:'checkIn', headerName:'الحضور', ...COL_MEDIUM,
      editable: editableNotOff,
      cellEditor: TimeCellEditor,
      cellEditorParams: { mode:'datetime' },
      valueFormatter: p => fmtTime(p.value),
      cellClass: editCellClass('checkIn', editableNotOff),
      cellStyle: p => ({ ...timeCell(p.value), ...CENTER, fontSize:'12px' }) },
    {
      field:'checkOut', headerName:'الانصراف', ...COL_MEDIUM,
      editable: editableNotOff,
      cellEditor: TimeCellEditor,
      cellEditorParams: { mode:'datetime' },
      valueFormatter: p => fmtTime(p.value),
      cellClass: editCellClass('checkOut', editableNotOff),
      cellStyle: p => ({
        ...NUM, ...CENTER,
        color: p.value ? 'var(--c-time)' : 'var(--c-muted)',
        fontWeight:'600', fontSize:'12px' }) },
    {
      field:'workedMinutes', headerName:'ساعات العمل', width:115,
      editable: editableNotOff,
      cellEditor: TimeCellEditor,
      cellEditorParams: { mode:'minutes' },
      valueFormatter: p => fmtWorkedHours(p.value),
      cellClass: editCellClass('workedMinutes', editableNotOff),
      cellStyle: p => ({
        ...NUM, ...CENTER,
        color:(p.value||0)>0 ? 'var(--c-net)' : 'var(--c-muted)',
        fontWeight:(p.value||0)>0 ? '700' : '400' }) },
    {
      field:'effectiveLatePenalty', headerName:'التأخير', ...COL_MEDIUM,
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
      cellStyle: p => ({ ...penaltyCell(p.value), ...CENTER, alignItems:'center' }) },
    {
      field:'effectiveOvertimeUnits', headerName:'الإضافي', ...COL_MEDIUM,
      editable: editableNotOff,
      cellEditor:'agNumberCellEditor',
      cellEditorParams:{ min:0, step:0.5, precision:1 },
      valueFormatter: p => fmtEditableZero(p.value, fmtOvertimeUnits),
      cellClass: p => [
        editCellClass('effectiveOvertimeUnits', editableNotOff)(p),
        p.data?.manualOvertimeUnits != null ? 'cell-manual-override' : '',
      ].filter(Boolean).join(' '),
      tooltipValueGetter: p => p.data?.manualOvertimeUnits != null
        ? manualOverrideTooltip(p.data?.manualPenaltyByName, p.data?.manualPenaltyAt) : undefined,
      cellStyle: p => ({ ...otCell(p.value), ...CENTER, alignItems:'center' }) },
    {
      // Raw-time info only — NOT the canonical overtime source. The canonical
      // bonus units are `effectiveOvertimeUnits` (see column above).
      field:'overtimeHours', headerName:'وقت الإضافي الفعلي', width:110,
      valueFormatter: p => fmtOTHours(p.value),
      cellStyle: p => ({ ...NUM, ...mutedCell() }) },
    {
      field:'effectiveEarlyPenalty', headerName:'انصراف مبكر', width:112,
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
      cellStyle: p => ({ ...penaltyCell(p.value), ...CENTER, alignItems:'center' }) },
    {
      field:'status', headerName:'الحالة', width:175, headerClass:'ag-header-center',
      editable:true,
      cellEditor:'agSelectCellEditor',
      cellEditorParams:{ values:['present','late','absent','early_leave','weekend','holiday'] },
      valueFormatter: p => STATUS_LABELS[p.value]?.ar || '—',
      cellClass: p => [
        editCellClass('status', () => true)(p),
        p.data?.manualEdit ? 'cell-manual-override' : '',
        p.value === 'absent' ? 'status-absent' : '',
      ].filter(Boolean).join(' '),
      tooltipValueGetter: p => p.data?.manualEdit
        ? manualOverrideTooltip(p.data?.manualPenaltyByName, p.data?.manualPenaltyAt) : undefined,
      cellStyle: p => ({
        justifyContent:'center', fontWeight:'700', fontSize:'12.5px',
        fontFamily:'Cairo, sans-serif',
        color: STATUS_LABELS[p.value]?.color || 'var(--c-muted)',
        background: STATUS_LABELS[p.value]?.bg || 'transparent',
      }) },
    {
      field:'absenceType', headerName:'نوع الغياب', width:140,
      headerClass:'ag-header-center',
      valueFormatter: p => p.data?.isAbsent ? (ABSENCE_TYPE_LABELS[p.value] || '—') : '',
      cellStyle: p => ({
        fontFamily:'Cairo, sans-serif', fontSize:'12px',
        justifyContent:'center', textAlign:'center', fontWeight:'700',
        color: p.data?.isAbsent
          ? (p.data?.absenceType === 'without_permission' ? 'var(--c-red, #ef4444)'
            : p.data?.absenceType === 'with_permission' ? 'var(--c-green, #22c55e)'
            : p.data?.absenceType === 'custom' ? 'var(--accent, #2563eb)'
            : 'var(--text-3)')
          : 'transparent',
        cursor: p.data?.isAbsent ? 'pointer' : 'default',
      }),
      onCellClicked: ({ data }) => {
        if (!data?.id || !data.isAbsent) return;
        setAbsenceModal({
          id: data.id,
          employeeId: data.employeeId,
          employeeName: data.employeeName,
          dateLabel: data.date,
          initialType: data.absenceType || null,
          initialPenaltyDays: data.penaltyDays || null,
          initialReason: data.absenceReason || '',
        });
      },
    },
    {
      field:'penaltyDays', headerName:'أيام الخصم', width:105,
      headerClass:'ag-header-center',
      valueFormatter: p => (p.data?.isAbsent && p.value != null) ? String(p.value) : '',
      cellStyle: p => ({
        fontFamily:'Consolas, monospace', fontSize:'13px',
        justifyContent:'center', textAlign:'center', fontWeight:'700',
        color: p.data?.isAbsent
          ? (p.data?.penaltyDays != null ? 'var(--c-red, #ef4444)' : 'var(--text-3)')
          : 'transparent',
      }),
    },
  ], [isNarrow]);

  const defaultColDef = useMemo(() => ({ ...ENTERPRISE_DEFAULT_COL_DEF }), []);

  // Priority: Monitored > Holiday > Weekend > Absent > Late > Overtime —
  // shared with AttendanceMonthlyPage/EmployeeMovementPage so the "entire
  // row" absence highlight (and every other row state) is defined once
  // (see gridDefaults.js#attendanceRowClass). EF-018: manual-override rows
  // no longer get a row-level highlight — only the edited cell's own text
  // changes color (see .cell-manual-override).
  const getRowClass = useCallback(attendanceRowClass, []);

  const getRowStyle = useCallback(({ data }) => {
    if (!data?.isMonitored) return undefined;
    const c = data.monitorColor || '#f59e0b';
    return { borderRight: `6px solid ${c}` };
  }, []);

  // The API returns a placeholder row (id: null) for every employee that has no
  // AttendanceDaily record on the selected date, so `String(id)` was the same
  // "null" for ALL of them: AG Grid keyed them to one id and the grid ended up
  // with ~2n-1 nodes for n employees (every employee listed twice, inflated
  // pagination/selection/print counts). A placeholder is identified by its
  // employee instead; the `e` prefix cannot collide with a numeric record id.
  const getRowId = useCallback(p => (p.data.id != null ? String(p.data.id) : `e${p.data.employeeId}`), []);

  // Assigns a ref only — safe with an empty dependency array.
  const handleGridReady = useCallback((p) => { gridApiRef.current = p.api; }, [gridApiRef]);

  // isActive/doesPassFilter come from useAttendanceFilter() and change
  // whenever the user changes the advanced filter bar — must stay in the
  // dependency array or these would close over stale filter state.
  const gridIsExternalFilterPresent = useCallback(() => isActive, [isActive]);
  const gridDoesExternalFilterPass = useCallback((p) => doesPassFilter(p.data), [doesPassFilter]);

  // showLoading=true → user-triggered (date change, button, keyboard).
  // showLoading=false → background sync (live hooks). Either way, skip the
  // reload while any PUT is in-flight — a manual refresh click / Ctrl+Shift+R
  // fired while a cell is still open or saving replaces rowData exactly like
  // a background live-sync reload would, so it gets the same deferral rather
  // than a carve-out for "the user asked for it".
  const load = useCallback(async (showLoading = false) => {
    if (editCountRef.current > 0) { pendingReloadRef.current = true; return; }
    const seq = ++loadSeqRef.current;
    const startClock = ++clockRef.current;
    const reqDate = date;
    if (showLoading) setLoading(true);
    try {
      const { data: r } = await api.get('/attendance/daily', { params: { date } });
      // Superseded: the date changed, or a later-started load already applied.
      if (dateRef.current !== reqDate || seq < appliedLoadRef.current) return;
      appliedLoadRef.current = seq;
      // Rows saved/refreshed after this request started keep their newer state.
      const keep = new Set();
      for (const row of r) {
        if (isRowStale(row.employeeId, startClock)) keep.add(row.employeeId);
        else originRef.current.set(row.employeeId, startClock);
      }
      setRows(prev => {
        if (!keep.size) return r;
        const prevByEmp = new Map(prev.map(x => [x.employeeId, x]));
        return r.map(row => (keep.has(row.employeeId) && prevByEmp.has(row.employeeId)
          ? prevByEmp.get(row.employeeId) : row));
      });
      const deptNames = [...new Set(r.map(x => x.department).filter(Boolean))].sort();
      setDepts(deptNames);
    } catch { toast.error('تعذر تحميل بيانات الحضور'); }
    finally { if (showLoading) setLoading(false); }
  }, [date, isRowStale]); // eslint-disable-line react-hooks/exhaustive-deps

  // EP-014: targeted refresh for realtime events that name a single employee
  // (attendance:realtime/processed) — fetches just that employee's row for
  // the currently-selected date instead of the whole day's grid, then merges
  // it in by employeeId (not `id`: a punch can create the AttendanceDaily row
  // for the first time, so the previous placeholder row has no `id` yet).
  // Same deferral behavior as load() while an edit is in flight, handled by
  // useDeviceLiveSync's own guard — this callback only runs once idle.
  const loadOne = useCallback(async (employeeIds) => {
    const startClock = ++clockRef.current;
    const reqDate = date;
    try {
      const fetched = await Promise.all(employeeIds.map(id =>
        api.get('/attendance/daily', { params: { date, employeeId: id } }).then(r => r.data[0]).catch(() => null)
      ));
      if (dateRef.current !== reqDate) return;
      // Drop any row a newer save / refresh has already superseded; stamp the rest.
      const usable = fetched.filter(row => row && !isRowStale(row.employeeId, startClock));
      for (const row of usable) originRef.current.set(row.employeeId, startClock);
      setRows(rs => {
        let next = rs;
        for (const row of usable) {
          if (!row) continue;
          next = next.some(r => r.employeeId === row.employeeId)
            ? next.map(r => (r.employeeId === row.employeeId ? row : r))
            : [...next, row];
        }
        return next;
      });
    } catch { /* silent — next full reload (rules/device event) will catch up */ }
  }, [date, isRowStale]);

  useEffect(() => { load(true); }, [load]);
  useRulesLiveSync(load, { isBusyRef: editCountRef });
  useDeviceLiveSync(load, { silent: true, isBusyRef: editCountRef, reloadOne: loadOne });

  // Remember the selected date for navigating away/back on the same local day
  useEffect(() => {
    localStorage.setItem(DAILY_FILTER_KEY, JSON.stringify({ date, savedOn: localToday() }));
  }, [date]);

  // Ctrl+Shift+R → refresh grid data
  useKeyboardShortcut('r', () => load(true), { ctrl: true, shift: true });

  const handleCellEdit = async ({ data, colDef, newValue, oldValue, node }) => {
    // A cancelled edit (Escape) also fires cellEditingStopped, with
    // newValue === undefined (a cleared field commits '' instead) — without
    // this guard the workedMinutes branch coerces undefined → 0 and saves it.
    if (newValue === undefined) return;
    if (!data?.id) return;
    const field = colDef.field;

    // ── Client-side validation (Arabic toast + revert, no API call) ──────────
    if (['checkIn','checkOut','workedMinutes'].includes(field)) {
      if (newValue !== '' && newValue != null && !HHMM_RE.test(newValue)) {
        toast.error('صيغة الوقت غير صحيحة (HH:mm)');
        node.setDataValue(field, oldValue);
        return;
      }
    }
    if (OVERRIDE_FIELD_MAP[field]) {
      if (newValue !== '' && newValue != null) {
        const n = Number(newValue);
        if (!Number.isFinite(n) || n < 0) {
          toast.error('القيمة يجب أن تكون رقمًا أكبر من أو يساوي صفر');
          node.setDataValue(field, oldValue);
          return;
        }
      }
    }

    // ── No-op detection (per-field, since types differ from raw string compare) ──
    if (field === 'workedMinutes') {
      const newMin = (newValue === '' || newValue == null) ? 0 : (timeToMinutes(newValue) ?? 0);
      if (newMin === (oldValue || 0)) return;
    } else if (OVERRIDE_FIELD_MAP[field]) {
      const a = (newValue === '' || newValue == null) ? null : Number(newValue);
      const b = (oldValue === '' || oldValue == null) ? null : Number(oldValue);
      if (a === b) return;
    } else {
      if (newValue === oldValue) return;
    }

    editCountRef.current++;
    markSaving(data.id, field, node, true);
    beginRowEdit([data.employeeId]);
    try {
      let updated;
      if (field === 'workedMinutes') {
        const mins = (newValue === '' || newValue == null) ? 0 : (timeToMinutes(newValue) ?? 0);
        const res = await api.put(`/attendance/daily/${data.id}`, {
          workedMinutes: mins, reason: INLINE_REASON, modifiedByName: ACTOR, source: 'inline-grid',
        });
        updated = normalizeDailyUpdate(res.data);
      } else if (['checkIn','checkOut','status'].includes(field)) {
        const payload = { modifiedByName: ACTOR, source: 'inline-grid', [field]: newValue };
        const res = await api.put(`/attendance/daily/${data.id}`, payload);
        updated = normalizeDailyUpdate(res.data);
      } else {
        const overrideKey = OVERRIDE_FIELD_MAP[field];
        const val = (newValue === '' || newValue == null) ? null : Number(newValue);
        const res = await api.put(`/attendance/${data.id}/manual-penalty`, {
          [overrideKey]: val, overrideReason: INLINE_REASON, modifiedByName: ACTOR, source: 'inline-grid',
        });
        updated = normalizeDailyUpdate(res.data);
      }
      // Another field on this same row may still be saving (e.g. the user
      // tabbed to the next editable cell before this one resolved) — this
      // response's snapshot predates that sibling edit, so only apply the
      // field it's authoritative for and let the eventual reload reconcile
      // the rest, instead of clobbering the sibling's in-flight value with a
      // stale full-row replace.
      const rowKeyPrefix = `${data.id}:`;
      const hasOtherFieldsInFlight = Array.from(savingCellsRef.current)
        .some(k => k.startsWith(rowKeyPrefix) && k !== `${rowKeyPrefix}${field}`);
      if (hasOtherFieldsInFlight) pendingReloadRef.current = true;
      markRowsFresh([data.employeeId]);   // the PUT result is now the newest data for this row
      setRows(rs => applyRowFieldUpdate(rs, updated, field, hasOtherFieldsInFlight));
    } catch (err) {
      toast.error(err?.response?.data?.error || 'فشل التحديث');
      node.setDataValue(field, oldValue);
    } finally {
      endRowEdit([data.employeeId]);
      editCountRef.current--;
      markSaving(data.id, field, node, false);
      if (editCountRef.current === 0 && pendingReloadRef.current) {
        pendingReloadRef.current = false;
        load(false);
      }
    }
  };

  const handleAbsenceSave = useCallback(async ({ absenceType, penaltyDays, absenceReason }) => {
    if (!absenceModal?.id) return;
    editCountRef.current++;
    const absenceEmpIds = [absenceModal.employeeId];
    beginRowEdit(absenceEmpIds);
    setAbsenceSaving(true);
    try {
      const { data: updated } = await api.put(`/attendance/${absenceModal.id}/absence-type`, {
        absenceType, penaltyDays, absenceReason, modifiedByName: ACTOR,
      });
      markRowsFresh(absenceEmpIds);
      setRows(rs => replaceAttendanceRow(rs, updated));
      toast.success('تم تحديث نوع الغياب');
      setAbsenceModal(null);
    } catch (err) {
      toast.error(err?.response?.data?.error || 'فشل تحديث نوع الغياب');
    } finally {
      endRowEdit(absenceEmpIds);
      editCountRef.current--;
      setAbsenceSaving(false);
      if (editCountRef.current === 0 && pendingReloadRef.current) { pendingReloadRef.current = false; load(false); }
    }
  }, [absenceModal, load, beginRowEdit, endRowEdit, markRowsFresh]);

  const handleSelectionChanged = useCallback(() => {
    setSelectedRows(gridRef.current?.api?.getSelectedRows() ?? []);
  }, []);

  const clearSelection = useCallback(() => {
    gridRef.current?.api?.deselectAll();
    setSelectedRows([]);
  }, []);

  const selectedAbsent = useMemo(() => selectedRows.filter(r => r.isAbsent), [selectedRows]);

  // Same PUT→server-confirm→replace-row pipeline as handleAbsenceSave, applied
  // to many rows from one request. Uses the existing editCountRef guard so
  // useRulesLiveSync/useDeviceLiveSync defer any background reload until the
  // bulk save (and its server response) has fully landed — no full-grid
  // reload, no optimistic UI, only the server-confirmed rows are applied.
  const handleBulkUnauthorizedAbsence = useCallback(async () => {
    if (!selectedAbsent.length) return;
    const confirmed = window.confirm(
      `سيتم تحويل غياب ${selectedAbsent.length} موظف إلى "غياب بدون إذن" وتطبيق عقوبة الغياب حسب قواعد النظام.\n\nهل تريد المتابعة؟`
    );
    if (!confirmed) return;

    editCountRef.current++;
    const bulkEmpIds = selectedAbsent.map(r => r.employeeId);
    beginRowEdit(bulkEmpIds);
    setBulkSaving(true);
    try {
      const { data } = await api.post('/attendance/bulk-mark-unauthorized', {
        ids: selectedAbsent.map(r => r.id),
        modifiedByName: ACTOR,
        source: 'bulk-unauthorized-absence',
      });
      const normalized = (data.updated || []).map(normalizeDailyUpdate);
      markRowsFresh(normalized.map(r => r.employeeId));
      setRows(rs => replaceAttendanceRows(rs, normalized));
      if (data.updatedCount) {
        toast.success(`تم تحديث ${data.updatedCount} موظف بنجاح`);
      }
      if (data.skippedCount) {
        toast.error(`تم تجاهل ${data.skippedCount} موظف (ليسوا في حالة غياب)`);
      }
      clearSelection();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'فشل تحديث الغياب بدون إذن');
    } finally {
      endRowEdit(bulkEmpIds);
      editCountRef.current--;
      setBulkSaving(false);
      if (editCountRef.current === 0 && pendingReloadRef.current) { pendingReloadRef.current = false; load(false); }
    }
  }, [selectedAbsent, clearSelection, load, beginRowEdit, endRowEdit, markRowsFresh]);

  // ── Copy / paste a manual attendance entry ────────────────────────────────
  // A shortcut for typing the same values by hand: pasting saves through the
  // exact endpoints (and server-side validation + audit) the inline grid uses —
  // PUT /attendance/daily/:id for time/status/worked minutes and
  // PUT /attendance/:id/manual-penalty for the late/early/overtime overrides.
  const singleSelected = selectedRows.length === 1 ? selectedRows[0] : null;
  const canCopy  = !!singleSelected;
  const canPaste = !!attClipboard && editMode && !!singleSelected?.id;

  const handleCopyRow = () => {
    const r = singleSelected;
    if (!r) return;
    setAttClipboard({
      sourceName: r.employeeName,
      sourceCode: r.employeeCode,
      sourceDate: date,
      checkIn: toHHMM(r.checkIn),
      checkOut: toHHMM(r.checkOut),
      status: r.status,
      workedMinutes: r.workedMinutes ?? 0,
      effectiveLatePenalty: r.effectiveLatePenalty ?? 0,
      effectiveEarlyPenalty: r.effectiveEarlyPenalty ?? 0,
      effectiveOvertimeUnits: r.effectiveOvertimeUnits ?? 0,
    });
    toast.success(`تم نسخ حركة ${r.employeeName}`);
  };

  const handlePasteOpen = () => { if (canPaste) setPasteTarget(singleSelected); };

  const handlePasteApply = async (keys) => {
    const t = pasteTarget;
    const clip = attClipboard;
    if (!t?.id || !clip || !keys.length) return;
    const picked = new Set(keys);
    const reason = `نسخ/لصق حركة يدوية من ${clip.sourceName} (${clip.sourceDate})`;

    const dailyBody = {};
    if (picked.has('checkIn'))       dailyBody.checkIn  = clip.checkIn  || '';
    if (picked.has('checkOut'))      dailyBody.checkOut = clip.checkOut || '';
    if (picked.has('status'))        dailyBody.status   = clip.status;
    if (picked.has('workedMinutes')) dailyBody.workedMinutes = clip.workedMinutes;
    const penaltyBody = {};
    for (const [field, overrideKey] of Object.entries(OVERRIDE_FIELD_MAP)) {
      if (picked.has(field)) penaltyBody[overrideKey] = Number(clip[field]) || 0;
    }

    // Same client-side check the grid applies before it calls the API.
    for (const k of ['checkIn', 'checkOut']) {
      if (dailyBody[k] && !HHMM_RE.test(dailyBody[k])) { toast.error('صيغة الوقت غير صحيحة (HH:mm)'); return; }
    }

    // Same in-flight guards a normal cell save uses (see handleCellEdit).
    editCountRef.current++;
    beginRowEdit([t.employeeId]);
    setPasteSaving(true);
    let updated = null;
    try {
      if (Object.keys(dailyBody).length) {
        const res = await api.put(`/attendance/daily/${t.id}`, {
          ...dailyBody, reason, modifiedByName: ACTOR, source: 'inline-grid',
        });
        updated = normalizeDailyUpdate(res.data);
      }
      if (Object.keys(penaltyBody).length) {
        const res = await api.put(`/attendance/${t.id}/manual-penalty`, {
          ...penaltyBody, overrideReason: reason, modifiedByName: ACTOR, source: 'inline-grid',
        });
        updated = normalizeDailyUpdate(res.data);
      }
      toast.success('تم لصق الحركة');
      setPasteTarget(null);
    } catch (err) {
      // The server's own validation message, exactly like a rejected cell edit.
      toast.error(err?.response?.data?.error || 'فشل لصق الحركة');
    } finally {
      // If the first request succeeded and the second failed, the row still
      // shows what the server actually saved.
      if (updated) {
        markRowsFresh([t.employeeId]);
        setRows(rs => replaceAttendanceRow(rs, updated));
      }
      endRowEdit([t.employeeId]);
      editCountRef.current--;
      setPasteSaving(false);
      if (editCountRef.current === 0 && pendingReloadRef.current) { pendingReloadRef.current = false; load(false); }
    }
  };

  const process = async () => {
    setProc(true);
    try {
      await api.post('/attendance/process', { date }, LONG_OP);
      toast.success('تم معالجة الحضور');
      load(true);
    } catch { toast.error('فشل المعالجة'); }
    finally { setProc(false); }
  };

  // Real end-to-end workflow (connect → read → save → recompute attendance →
  // refresh this page's own grid) — see useFingerprintSyncWorkflow.js. The
  // modal only ever shows "success" after `load(true)` below has itself
  // resolved, so the grid is never still stale when the success dialog
  // appears.
  const syncDevices = () => fpSync.run({ endpoint: '/devices/sync-all', reload: () => load(true) });

  const exportCSV = () => gridRef.current?.api?.exportDataAsCsv({ fileName:`حضور_${date}.csv` });
  const getVisibleRows = () => {
    const api = gridRef.current?.api;
    if (!api) return rows;
    const visible = [];
    api.forEachNodeAfterFilterAndSort(n => { if (n.data) visible.push(n.data); });
    return visible.length > 0 ? visible : rows;
  };
  const shift = (d) => setDate(addDays(date, d));

  const summary = useMemo(() => ({
    present: rows.filter(r => ['present','late','early_leave'].includes(r.status)).length,
    absent:  rows.filter(r => r.isAbsent).length,
    late:    rows.filter(r => (r.effectiveLatePenalty||0)>0).length,
    ot:      rows.filter(r => (r.effectiveOvertimeUnits||0)>0).length }), [rows]);

  const dateAr = new Date(date).toLocaleDateString('ar-EG',{ weekday:'long',year:'numeric',month:'long',day:'numeric' });

  return (
    <div className="flex flex-col gap-3" style={{ flex: 1, minHeight: 0 }} dir="rtl">
      <div className="page-header">
        <div>
          <h1 className="page-title">الحضور اليومي</h1>
          <p className="text-xs mt-0.5" style={{ color:'var(--text-3)', display: 'flex', alignItems: 'center', gap: 6 }}>
            {dateAr} · {rows.length} موظف · انقر على أي خلية للتعديل
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Secondary actions: full row on desktop, "⋮ المزيد" overflow on
              mobile — same three actions, nothing removed. */}
          <div className="hidden md:flex items-center gap-2">
            <button
              onClick={handleCopyRow}
              disabled={!canCopy}
              className="btn-secondary text-xs py-1.5 px-3"
              title={canCopy ? 'نسخ قيم الحركة المحددة' : 'حدّد حركة واحدة لنسخها'}
            >
              <Copy className="w-3.5 h-3.5" /> نسخ الحركة
            </button>
            <button
              onClick={handlePasteOpen}
              disabled={!canPaste}
              className="btn-secondary text-xs py-1.5 px-3"
              title={!attClipboard ? 'لا توجد حركة منسوخة'
                : !editMode ? 'وضع القراءة فقط'
                : !singleSelected?.id ? 'حدّد حركة واحدة لها سجل للصق عليها'
                : `لصق حركة ${attClipboard.sourceName} (${attClipboard.sourceDate})`}
            >
              <ClipboardPaste className="w-3.5 h-3.5" /> لصق الحركة
            </button>
            <button onClick={exportCSV} className="btn-secondary text-xs py-1.5 px-3">
              <Download className="w-3.5 h-3.5" /> CSV
            </button>
            <button onClick={() => setPrintOpen(true)} className="btn-secondary text-xs py-1.5 px-3">
              <Printer className="w-3.5 h-3.5" /> طباعة
            </button>
            <button onClick={syncDevices} className="btn-secondary text-xs py-1.5 px-3" disabled={syncing}>
              {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Fingerprint className="w-3.5 h-3.5" />}
              {syncing ? 'جاري سحب البصمات...' : 'سحب البصمات'}
            </button>
          </div>
          <div className="md:hidden">
            <MobileActionsMenu actions={[
              { key: 'copy-row', label: 'نسخ الحركة', disabled: !canCopy,
                icon: <Copy style={{ width: 15, height: 15 }} />, onClick: handleCopyRow },
              { key: 'paste-row', label: 'لصق الحركة', disabled: !canPaste,
                icon: <ClipboardPaste style={{ width: 15, height: 15 }} />, onClick: handlePasteOpen },
              { key: 'csv', label: 'CSV', icon: <Download style={{ width: 15, height: 15 }} />, onClick: exportCSV },
              { key: 'print', label: 'طباعة', icon: <Printer style={{ width: 15, height: 15 }} />, onClick: () => setPrintOpen(true) },
              { key: 'sync', label: syncing ? 'جاري سحب البصمات...' : 'سحب البصمات', disabled: syncing,
                icon: syncing ? <Loader2 style={{ width: 15, height: 15 }} className="animate-spin" /> : <Fingerprint style={{ width: 15, height: 15 }} />,
                onClick: syncDevices },
            ]} />
          </div>
          {/* Primary action — always visible on every breakpoint */}
          <button onClick={process} className="btn-primary text-xs py-1.5 px-3" disabled={processing}
            title="إعادة تطبيق قواعد الحضور والانصراف على التاريخ المحدد">
            {processing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {processing ? 'جاري...' : 'معالجة الحضور'}
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="card p-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button onClick={() => shift(-1)} className="btn-ghost p-1.5 rounded-lg"><ChevronRight className="w-4 h-4" /></button>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            className="input w-auto text-sm font-mono py-1.5 text-center" dir="ltr" />
          <button onClick={() => shift(1)} className="btn-ghost p-1.5 rounded-lg"><ChevronLeft className="w-4 h-4" /></button>
          <button onClick={() => setDate(localToday())} className="btn-secondary text-xs py-1.5 px-3">اليوم</button>
          <button onClick={() => load(true)} className="btn-ghost p-1.5 rounded-lg" title="تحديث البيانات (Ctrl+Shift+R)">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => setEditMode(m => !m)}
            title={editMode ? 'يسمح بتعديل الخلايا مباشرة بالنقر عليها' : 'يمنع تعديل البيانات داخل الجدول — انقر للتبديل'}
            className={`text-xs py-1.5 px-3 flex items-center gap-1.5 rounded-lg border transition-colors ${
              editMode
                ? 'bg-amber-500/15 border-amber-500/40 text-amber-400'
                : 'btn-secondary'
            }`}
          >
            {editMode ? <Pencil className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
            {editMode ? 'وضع التعديل' : 'قراءة فقط'}
          </button>
        </div>
        {/* Secondary summary counts — already visible on the Dashboard KPIs;
            hidden below md so the table (the actual reason to be on this
            page) starts higher on a phone screen instead of competing with
            redundant info. Nothing is removed, just deprioritized. */}
        <div className="hidden md:flex items-center gap-5 text-sm font-semibold">
          <span className="flex items-center gap-1.5" style={{ color:'var(--c-green)' }}>
            <CheckCircle className="w-4 h-4" /> {summary.present} حاضر
          </span>
          <span className="flex items-center gap-1.5" style={{ color:'var(--c-red)' }}>
            <XCircle className="w-4 h-4" /> {summary.absent} غائب
          </span>
          <span className="flex items-center gap-1.5" style={{ color:'var(--c-penalty)' }}>
            <Clock className="w-4 h-4" /> {summary.late} متأخر
          </span>
          <span className="flex items-center gap-1.5" style={{ color:'var(--c-ot)' }}>
            <TrendingUp className="w-4 h-4" /> {summary.ot} إضافي
          </span>
        </div>
      </div>

      {/* Bulk selection toolbar — only visible once at least one row is selected */}
      {selectedRows.length > 0 && (
        <div className="card p-3 flex flex-wrap items-center justify-between gap-3"
          style={{ borderColor: 'var(--c-red, #ef4444)', borderWidth: 1 }}>
          <div className="flex items-center gap-3 text-sm font-semibold">
            <span>تم تحديد {selectedRows.length} موظف</span>
            {selectedAbsent.length > 0 && selectedAbsent.length !== selectedRows.length && (
              <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>
                ({selectedAbsent.length} منهم غياب ويمكن تحديثهم)
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={clearSelection} className="btn-ghost text-xs py-1.5 px-3">إلغاء التحديد</button>
            <button
              onClick={handleBulkUnauthorizedAbsence}
              disabled={!selectedAbsent.length || bulkSaving}
              className="text-xs py-1.5 px-3 flex items-center gap-1.5 rounded-lg font-semibold"
              style={{
                background: 'var(--c-red, #ef4444)', color: '#fff',
                opacity: (!selectedAbsent.length || bulkSaving) ? 0.5 : 1,
                cursor: (!selectedAbsent.length || bulkSaving) ? 'not-allowed' : 'pointer',
              }}
              title={!selectedAbsent.length ? 'لا يوجد موظفين غائبين ضمن التحديد' : ''}
            >
              {bulkSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserX className="w-3.5 h-3.5" />}
              غياب بدون إذن {selectedAbsent.length ? `(${selectedAbsent.length})` : ''}
            </button>
          </div>
        </div>
      )}

      {/* Filter bar */}
      <AttendanceFilterBar
        filters={filters}
        updateFilter={updateFilter}
        toggleArrayItem={toggleArrayItem}
        applyQuick={applyQuick}
        clearFilters={clearFilters}
        isActive={isActive}
        departments={departments}
      />

      {/* Grid */}
      <div className="flex-1 overflow-hidden" style={{ minHeight:0 }}>
        <div className={`${agGridTheme} h-full`}>
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
            onGridReady={handleGridReady}
            onSelectionChanged={handleSelectionChanged}
            isExternalFilterPresent={gridIsExternalFilterPresent}
            doesExternalFilterPass={gridDoesExternalFilterPass}
            singleClickEdit={editMode}
            suppressClickEdit={!editMode}
            stopEditingWhenCellsLoseFocus={true}
            tabToNextCell={tabToNextCell}
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
            pagination {...pagination}
            loading={loading}
          />
        </div>
      </div>

      <PrintPreviewModal
        isOpen={printOpen}
        onClose={() => setPrintOpen(false)}
        data={getVisibleRows()}
        reportType="attendance_daily"
        meta={{ period: dateAr, generatedBy: ACTOR }}
        orientation="portrait"
      />

      <FingerprintSyncModal
        state={fpSync.state}
        onClose={fpSync.close}
        onRetry={fpSync.retry}
        onViewLogs={() => { fpSync.close(); navigate('/attendance/logs'); }}
      />

      <PasteAttendanceModal
        open={!!pasteTarget}
        onClose={() => { if (!pasteSaving) setPasteTarget(null); }}
        onApply={handlePasteApply}
        saving={pasteSaving}
        clip={attClipboard}
        target={pasteTarget}
      />

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
