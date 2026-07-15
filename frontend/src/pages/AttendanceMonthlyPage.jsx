import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';
import {
  Download, RefreshCw, Loader2, Play, Printer,
  CheckCircle, XCircle, Clock, TrendingUp,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api, { LONG_OP } from '../lib/api';
import { useTheme } from '../contexts/ThemeContext';
import { AG_GRID_LOCALE_AR } from '../lib/agGridLocale';
import {
  fmtTime, fmtWorkedHours, fmtPenaltyUnits, fmtOvertimeUnits, fmtEditableZero,
  timeToMinutes, STATUS_LABELS, manualOverrideTooltip,
} from '../lib/formatters';
import {
  NUM, CENTER, nameCell, codeCell, deptCell, otCell, penaltyCell, timeCell, rowNumCell,
} from '../lib/cellStyles';
import {
  ENTERPRISE_DEFAULT_COL_DEF, ENTERPRISE_GRID_PROPS, COL_MEDIUM, tabToNextCell,
} from '../lib/gridDefaults';
import PrintPreviewModal from '../components/PrintPreviewModal';
import TimeCellEditor from '../components/grid/TimeCellEditor';
import { useRulesLiveSync } from '../hooks/useRulesLiveSync';
import { useDeviceLiveSync } from '../hooks/useDeviceLiveSync';
import AbsenceTypeModal, { ABSENCE_TYPE_LABELS } from '../components/AbsenceTypeModal';
import AttendanceFilterBar from '../components/AttendanceFilterBar';
import { useAttendanceFilter } from '../hooks/useAttendanceFilter';
import { ACTOR, HHMM_RE, OVERRIDE_FIELD_MAP, normalizeDailyUpdate, replaceAttendanceRow, applyRowFieldUpdate } from '../lib/attendanceUtils';
import { useKeyboardShortcut } from '../hooks/useKeyboardShortcut';
import { MONTHS_AR } from '../lib/constants';

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
  const [printLoading, setPrintLoading] = useState(false);
  const [departments, setDepts]    = useState([]);
  const [deptId,     setDeptId]    = useState(_saved.deptId ?? 0);
  const [absenceModal, setAbsenceModal] = useState(null);
  const [absenceSaving, setAbsenceSaving] = useState(false);
  const [month, setMonth] = useState(_saved.month ?? now.getMonth() + 1);
  const [year,  setYear]  = useState(_saved.year  ?? now.getFullYear());

  const gridRef = useRef();
  const editCountRef   = useRef(0);
  const pendingReloadRef = useRef(false);
  // Tracks in-flight `${rowId}:${field}` saves so a response landing while a
  // sibling field on the same row is still saving can be merged instead of
  // clobbering the whole row (see applyRowFieldUpdate in attendanceUtils.js).
  const savingCellsRef = useRef(new Set());

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
  const cols = useMemo(() => [
    {
      headerName: '#', valueGetter: 'node.rowIndex + 1', width: 60, pinned: 'right',
      sortable: false, filter: false, headerClass: 'ag-header-center',
      checkboxSelection: true, headerCheckboxSelection: true,
      cellStyle: rowNumCell(),
    },
    {
      field: 'employeeCode', headerName: 'كود', width: 88, pinned: 'right',
      cellStyle: codeCell(),
    },
    {
      field: 'employeeName', headerName: 'اسم الموظف', width: 195, minWidth: 160, pinned: 'right',
      cellStyle: (p) => p.data?.isMonitored ? { ...nameCell(), color: p.data.monitorColor || '#f59e0b', fontWeight: '800' } : nameCell(),
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
      field: 'date', headerName: 'التاريخ', width: 130, pinned: 'right',
      valueFormatter: p => {
        if (!p.value) return '';
        const d = new Date(p.value + 'T00:00');
        return `${d.getDate()} - ${DAYS_AR[d.getDay()]}`;
      },
      cellStyle: {
        fontFamily: 'Consolas, monospace', fontSize: '11.5px',
        color: 'var(--text-2)', justifyContent: 'center',
      },
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
      valueFormatter: p => STATUS_LABELS[p.value]?.ar || '—',
      cellClass: p => [
        editCellClass('status', () => true)(p),
        p.data?.manualEdit ? 'cell-manual-override' : '',
      ].filter(Boolean).join(' '),
      tooltipValueGetter: p => p.data?.manualEdit
        ? manualOverrideTooltip(p.data?.manualPenaltyByName, p.data?.manualPenaltyAt) : undefined,
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
  ], []); // eslint-disable-line react-hooks/exhaustive-deps

  const defaultColDef = useMemo(() => ({ ...ENTERPRISE_DEFAULT_COL_DEF }), []);

  const getRowClass = useCallback(({ data }) => {
    if (!data) return '';
    const classes = [];
    if      (data.isMonitored) classes.push('row-monitored');
    if      (data.isHoliday)   classes.push('row-holiday');
    else if (data.isWeekend)   classes.push('row-weekend');
    else if (data.isAbsent)    classes.push('row-absent');
    else if ((data.effectiveLatePenalty   || 0) > 0) classes.push('row-late');
    else if ((data.effectiveOvertimeUnits || 0) > 0) classes.push('row-overtime');
    return classes.join(' ');
  }, []);

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
    if (showLoading) setLoading(true);
    try {
      const params = { month, year };
      if (deptId) params.departmentId = deptId;
      const { data } = await api.get('/attendance/monthly-detail', { params });
      setRows(data);
    } catch { toast.error('تعذر تحميل بيانات الحضور الشهري'); }
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
      const params = { month, year };
      if (deptId) params.departmentId = deptId;
      const fetched = await Promise.all(employeeIds.map(id =>
        api.get('/attendance/monthly-detail', { params: { ...params, employeeId: id } }).then(r => r.data).catch(() => [])
      ));
      setRows(rs => {
        const touchedIds = new Set(employeeIds);
        const kept = rs.filter(r => !touchedIds.has(r.employeeId));
        return [...kept, ...fetched.flat()];
      });
    } catch { /* silent — next full reload (rules/device event) will catch up */ }
  }, [month, year, deptId]);

  useEffect(() => {
    api.get('/departments').then(r => {
      setDepts(r.data);
    }).catch(() => {});
  }, []);

  useEffect(() => { load(true); }, [load]);

  useRulesLiveSync(load, { isBusyRef: editCountRef });
  useDeviceLiveSync(load, { silent: true, isBusyRef: editCountRef, reloadOne: loadOne });

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
    } else {
      if (newValue === oldValue) return;
    }

    // Save primary row — block background reloads for the duration of the PUT
    editCountRef.current++;
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
        const hasOtherFieldsInFlight = Array.from(savingCellsRef.current)
          .some(k => k.startsWith(rowKeyPrefix) && k !== rowKey);
        if (hasOtherFieldsInFlight) pendingReloadRef.current = true;
        setRows(rs => applyRowFieldUpdate(rs, updated, field, hasOtherFieldsInFlight));
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
      toast.error(err?.response?.data?.error || 'فشل التحديث');
      node.setDataValue(field, oldValue);
      savingCellsRef.current.delete(rowKey);
      editCountRef.current--;
      if (editCountRef.current === 0 && pendingReloadRef.current) { pendingReloadRef.current = false; load(false); }
      return;
    }
    savingCellsRef.current.delete(rowKey);
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
    let bulkCount = 1;
    await Promise.all(otherNodes.map(async n => {
      try {
        const updated = await saveRecord(n.data, field, newValue);
        if (updated) {
          setRows(rs => replaceAttendanceRow(rs, updated));
          bulkCount++;
        }
      } catch {}
      finally {
        editCountRef.current--;
        if (editCountRef.current === 0 && pendingReloadRef.current) { pendingReloadRef.current = false; load(false); }
      }
    }));
    toast.success(`تم تطبيق القيمة على ${bulkCount} سجل`);
  }, [saveRecord, load]);

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

  const handleProcess = async () => {
    setProc(true);
    try {
      await api.post('/attendance/process-month', { month, year }, LONG_OP);
      toast.success('تمت معالجة الشهر بنجاح');
      load(true);
    } catch { toast.error('فشل في المعالجة'); }
    finally { setProc(false); }
  };

  const exportCSV = () =>
    gridRef.current?.api?.exportDataAsCsv({ fileName: `حضور_شهري_${year}_${month}.csv` });

  // EF-020.1: the print/PDF/Excel report is per-employee-per-month, not
  // per-day — `rows` (from /attendance/monthly-detail) is the wrong shape for
  // it (that's what caused blank aggregate columns + a daily-granularity
  // report). Reuse the canonical aggregate endpoint (/attendance/monthly),
  // whose response already matches REPORT_COLUMNS.attendance_monthly field-
  // for-field, instead of duplicating the aggregation client-side.
  const openPrint = useCallback(async () => {
    setPrintLoading(true);
    try {
      const params = { month, year };
      if (deptId) params.departmentId = deptId;
      const { data } = await api.get('/attendance/monthly', { params });
      setPrintRows(data);
      setPrintOpen(true);
    } catch {
      toast.error('تعذر تحميل بيانات التقرير الشهري');
    } finally {
      setPrintLoading(false);
    }
  }, [month, year, deptId]);

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
            &nbsp;·&nbsp;انقر مرتين أو اكتب مباشرة لتعديل أي خلية
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={exportCSV} className="btn-secondary text-xs py-1.5 px-3">
            <Download className="w-3.5 h-3.5" /> CSV
          </button>
          <button onClick={openPrint} className="btn-secondary text-xs py-1.5 px-3" disabled={printLoading}>
            {printLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Printer className="w-3.5 h-3.5" />}
            طباعة
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
            {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
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

        <div className="flex items-center gap-5 text-xs font-semibold">
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

      <div className="flex-1 overflow-hidden" style={{ minHeight: 0 }}>
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
            singleClickEdit={true}
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
