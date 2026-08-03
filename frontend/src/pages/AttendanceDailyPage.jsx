import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';
import {
  RefreshCw, Download, ChevronRight, ChevronLeft,
  CheckCircle, XCircle, Clock, TrendingUp, Loader2, Play, Printer,
  Fingerprint, Pencil, Lock } from 'lucide-react';
import toast from 'react-hot-toast';
import api, { LONG_OP } from '../lib/api';
import { AG_GRID_LOCALE_AR } from '../lib/agGridLocale';
import { fmtTime, fmtOTHours, fmtWorkedHours, fmtPenaltyUnits, fmtOvertimeUnits, fmtEditableZero, timeToMinutes, STATUS_LABELS, manualOverrideTooltip } from '../lib/formatters';
import { useTheme } from '../contexts/ThemeContext';
import {
  NUM, CENTER, nameCell, codeCell, deptCell,
  otCell, penaltyCell, timeCell, rowNumCell, mutedCell } from '../lib/cellStyles';
import { ENTERPRISE_DEFAULT_COL_DEF, ENTERPRISE_GRID_PROPS, COL_MEDIUM, COL_LARGE, tabToNextCell, safeRefreshCells, isAbsentRow, attendanceRowClass } from '../lib/gridDefaults';
import PrintPreviewModal from '../components/PrintPreviewModal';
import TimeCellEditor from '../components/grid/TimeCellEditor';
import { useRulesLiveSync } from '../hooks/useRulesLiveSync';
import { useDeviceLiveSync } from '../hooks/useDeviceLiveSync';
import { useKeyboardShortcut } from '../hooks/useKeyboardShortcut';
import AbsenceTypeModal, { ABSENCE_TYPE_LABELS } from '../components/AbsenceTypeModal';
import AttendanceFilterBar from '../components/AttendanceFilterBar';
import { useAttendanceFilter } from '../hooks/useAttendanceFilter';
import { ACTOR, HHMM_RE, OVERRIDE_FIELD_MAP, normalizeDailyUpdate, replaceAttendanceRow, applyRowFieldUpdate } from '../lib/attendanceUtils';

const INLINE_REASON = 'تعديل مباشر من الجدول (Inline Grid)';

const DAILY_FILTER_KEY = 'attendanceDailyFilters';
function loadDailyFilters() {
  try { return JSON.parse(localStorage.getItem(DAILY_FILTER_KEY)) || {}; } catch { return {}; }
}

export default function AttendanceDailyPage() {
  const { agGridTheme } = useTheme();
  const _saved = loadDailyFilters();
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(false);
  const [processing, setProc] = useState(false);
  const [date, setDate]       = useState(_saved.date || new Date().toISOString().split('T')[0]);
  const [printOpen, setPrintOpen] = useState(false);
  const [syncing, setSyncing]     = useState(false);
  const [editMode, setEditMode]   = useState(true); // default ON — no mode switch needed
  const [departments, setDepts]   = useState([]);
  const [absenceModal, setAbsenceModal] = useState(null);
  const [absenceSaving, setAbsenceSaving] = useState(false);
  const gridRef = useRef();
  // per-cell "saving" affordance
  const savingCellsRef = useRef(new Set());
  // counts in-flight PUT requests — background load(false) skipped while > 0
  const editCountRef   = useRef(0);
  // set to true when a background reload was skipped; cleared + fired on counter-zero
  const pendingReloadRef = useRef(false);

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

  const cols = useMemo(() => [
    {
      headerName:'#', valueGetter:'node.rowIndex + 1', width:50, pinned:'right',
      sortable:false, filter:false, headerClass:'ag-header-center',
      cellStyle: rowNumCell() },
    {
      field:'employeeCode', headerName:'كود', width:88, pinned:'right',
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
  ], []);

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

  const getRowId = useCallback(p => String(p.data.id), []);

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
    if (showLoading) setLoading(true);
    try {
      const { data: r } = await api.get('/attendance/daily', { params: { date } });
      setRows(r);
      const deptNames = [...new Set(r.map(x => x.department).filter(Boolean))].sort();
      setDepts(deptNames);
    } catch { toast.error('تعذر تحميل بيانات الحضور'); }
    finally { if (showLoading) setLoading(false); }
  }, [date]); // eslint-disable-line react-hooks/exhaustive-deps

  // EP-014: targeted refresh for realtime events that name a single employee
  // (attendance:realtime/processed) — fetches just that employee's row for
  // the currently-selected date instead of the whole day's grid, then merges
  // it in by employeeId (not `id`: a punch can create the AttendanceDaily row
  // for the first time, so the previous placeholder row has no `id` yet).
  // Same deferral behavior as load() while an edit is in flight, handled by
  // useDeviceLiveSync's own guard — this callback only runs once idle.
  const loadOne = useCallback(async (employeeIds) => {
    try {
      const fetched = await Promise.all(employeeIds.map(id =>
        api.get('/attendance/daily', { params: { date, employeeId: id } }).then(r => r.data[0]).catch(() => null)
      ));
      setRows(rs => {
        let next = rs;
        for (const row of fetched) {
          if (!row) continue;
          next = next.some(r => r.employeeId === row.employeeId)
            ? next.map(r => (r.employeeId === row.employeeId ? row : r))
            : [...next, row];
        }
        return next;
      });
    } catch { /* silent — next full reload (rules/device event) will catch up */ }
  }, [date]);

  useEffect(() => { load(true); }, [load]);
  useRulesLiveSync(load, { isBusyRef: editCountRef });
  useDeviceLiveSync(load, { silent: true, isBusyRef: editCountRef, reloadOne: loadOne });

  // Persist selected date across navigation
  useEffect(() => {
    localStorage.setItem(DAILY_FILTER_KEY, JSON.stringify({ date }));
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
      setRows(rs => applyRowFieldUpdate(rs, updated, field, hasOtherFieldsInFlight));
    } catch (err) {
      toast.error(err?.response?.data?.error || 'فشل التحديث');
      node.setDataValue(field, oldValue);
    } finally {
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
    setAbsenceSaving(true);
    try {
      const { data: updated } = await api.put(`/attendance/${absenceModal.id}/absence-type`, {
        absenceType, penaltyDays, absenceReason, modifiedByName: ACTOR,
      });
      setRows(rs => replaceAttendanceRow(rs, updated));
      toast.success('تم تحديث نوع الغياب');
      setAbsenceModal(null);
    } catch (err) {
      toast.error(err?.response?.data?.error || 'فشل تحديث نوع الغياب');
    } finally {
      editCountRef.current--;
      setAbsenceSaving(false);
      if (editCountRef.current === 0 && pendingReloadRef.current) { pendingReloadRef.current = false; load(false); }
    }
  }, [absenceModal, load]);

  const process = async () => {
    setProc(true);
    try {
      await api.post('/attendance/process', { date }, LONG_OP);
      toast.success('تم معالجة الحضور');
      load(true);
    } catch { toast.error('فشل المعالجة'); }
    finally { setProc(false); }
  };

  const syncDevices = async () => {
    setSyncing(true);
    try {
      const { data } = await api.post('/devices/sync-all', null, LONG_OP);
      toast.success(`تم سحب البصمات (${data?.synced ?? data?.count ?? '—'} جهاز)`);
    } catch (err) {
      toast.error(err?.response?.data?.error || 'فشل سحب البصمات');
    } finally {
      setSyncing(false);
    }
  };

  const exportCSV = () => gridRef.current?.api?.exportDataAsCsv({ fileName:`حضور_${date}.csv` });
  const getVisibleRows = () => {
    const api = gridRef.current?.api;
    if (!api) return rows;
    const visible = [];
    api.forEachNodeAfterFilterAndSort(n => { if (n.data) visible.push(n.data); });
    return visible.length > 0 ? visible : rows;
  };
  const shift = (d) => {
    const nd = new Date(date); nd.setDate(nd.getDate()+d);
    setDate(nd.toISOString().split('T')[0]);
  };

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
          <button onClick={exportCSV} className="btn-secondary text-xs py-1.5 px-3">
            <Download className="w-3.5 h-3.5" /> CSV
          </button>
          <button onClick={() => setPrintOpen(true)} className="btn-secondary text-xs py-1.5 px-3">
            <Printer className="w-3.5 h-3.5" /> طباعة
          </button>
          <button onClick={syncDevices} className="btn-secondary text-xs py-1.5 px-3" disabled={syncing}>
            {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Fingerprint className="w-3.5 h-3.5" />}
            {syncing ? 'جاري...' : 'سحب البصمات'}
          </button>
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
          <button onClick={() => setDate(new Date().toISOString().split('T')[0])} className="btn-secondary text-xs py-1.5 px-3">اليوم</button>
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
        <div className="flex items-center gap-5 text-sm font-semibold">
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
            pagination paginationPageSize={50}
            paginationPageSizeSelector={[25,50,100]}
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
