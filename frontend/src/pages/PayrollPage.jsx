import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';
import { Download, Play, Loader2, RefreshCw, Users, Printer, AlertTriangle, X } from 'lucide-react';
import toast from 'react-hot-toast';
import api, { LONG_OP } from '../lib/api';
import { useTheme } from '../contexts/ThemeContext';
import { AG_GRID_LOCALE_AR } from '../lib/agGridLocale';
import { fmtMoney, fmtIntZero, fmtOTHours, fmtPenaltyUnits, fmtEditableZero, fmtDec, displayNetSalary } from '../lib/formatters';
import FinalSalaryModal from '../components/FinalSalaryModal';
import PrintPreviewModal from '../components/PrintPreviewModal';
import { useRulesLiveSync } from '../hooks/useRulesLiveSync';
import { useDeviceLiveSync } from '../hooks/useDeviceLiveSync';
import { ENTERPRISE_DEFAULT_COL_DEF, ENTERPRISE_GRID_PROPS, COL_TINY, tabToNextCell, safeRefreshCells } from '../lib/gridDefaults';
import { MONTHS_AR, getYearRange } from '../lib/constants';

const NUM    = { textAlign:'right', direction:'ltr', fontFamily:'Consolas,monospace' };
const CENTER = { justifyContent:'center', textAlign:'center' };
const MONEY  = { ...NUM, ...CENTER, fontWeight:'600', fontSize:'12px', fontVariantNumeric:'tabular-nums' };

const ACTOR = 'مدير النظام';
const getRowId = (p) => String(p.data.id);

// Cell renderer for the detail "بيان" button — defined outside the component
// so AG Grid doesn't re-register it on every render.
function DetailBtnRenderer(p) {
  if (!p.data) return null;
  return (
    <button
      onClick={() => p.context?.openDetail(p.data)}
      style={{
        background: 'transparent',
        border: '1px solid var(--border)',
        borderRadius: 5,
        padding: '2px 10px',
        cursor: 'pointer',
        color: 'var(--c-accent)',
        fontSize: 11,
        fontFamily: 'var(--font-ui)',
        whiteSpace: 'nowrap',
        lineHeight: '1.6',
      }}
    >
      بيان
    </button>
  );
}

export default function PayrollPage() {
  const { agGridTheme } = useTheme();
  const [rows,        setRows]        = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [calcing,     setCalcing]     = useState(false);
  const [modal,       setModal]       = useState(null); // { row, bulk }
  const [calcConfirm, setCalcConfirm] = useState(false); // payroll calc confirmation
  const [printOpen,   setPrintOpen]   = useState(false);
  const now = new Date();
  const [month,  setMonth]  = useState(now.getMonth() + 1);
  const [year,   setYear]   = useState(now.getFullYear());
  const [deptId, setDeptId] = useState(0); // 0 = جميع الأقسام
  const gridRef = useRef();
  const savingCellsRef = useRef(new Set());
  // Counts in-flight PUT requests — live-sync reloads (useRulesLiveSync/
  // useDeviceLiveSync below) are deferred while this is nonzero, so a
  // rules-recalc or device-sync event mid-edit can no longer swap the grid's
  // rowData out from under an open/saving cell. This page previously had no
  // such guard at all (see gridDefaults.js safeRefreshCells doc comment).
  const editCountRef = useRef(0);
  // Set when a reload was skipped because editCountRef was nonzero; flushed
  // once the in-flight edit's finally block sees the counter back at 0.
  const pendingReloadRef = useRef(false);

  // Load departments list once on mount for the filter dropdown.
  useEffect(() => {
    api.get('/departments').then(r => setDepartments(r.data)).catch(() => {});
  }, []);

  const markSaving = (rowId, field, node, saving) => {
    const key = `${rowId}:${field}`;
    if (saving) savingCellsRef.current.add(key);
    else        savingCellsRef.current.delete(key);
    safeRefreshCells(gridRef, rowId, node, [field]);
  };

  const editCellClass = (field) => p => {
    if (!p.data) return 'cell-editable';
    return savingCellsRef.current.has(`${p.data.id}:${field}`) ? 'cell-editable cell-saving' : 'cell-editable';
  };

  // Stable callback for the detail button — passed via AG Grid context so the
  // cell renderer can open the FinalSalaryModal without being re-registered.
  const openDetail = useCallback((row) => setModal({ row, bulk: false }), []);

  const cols = useMemo(() => [
    // ── Identity (pinned right, always visible while scrolling) ───────────────
    {
      field: 'employee.code', headerName: 'الكود', ...COL_TINY, pinned: 'right',
      headerClass: 'ag-header-center',
      cellStyle: { ...CENTER, fontFamily: 'Consolas,monospace', color: 'var(--c-muted)', fontSize: '11px', letterSpacing: '0.04em' },
    },
    {
      field: 'employee.name', headerName: 'اسم الموظف', width: 200, minWidth: 160, pinned: 'right',
      cellStyle: { display: 'flex', alignItems: 'center', fontWeight: '700', color: 'var(--c-name)', fontFamily: 'Cairo,sans-serif' },
    },
    // ── Earnings — basicSalary is editable inline ─────────────────────────────
    {
      field: 'basicSalary', headerName: 'الراتب الأساسي', width: 130, minWidth: 114,
      editable: true,
      cellClass: editCellClass('basicSalary'),
      headerClass: 'ag-header-center',
      valueFormatter: p => fmtEditableZero(p.value, fmtMoney),
      cellStyle: { ...MONEY, alignItems:'center', color: 'var(--c-val)' },
    },
    {
      // EF-012.1: previously Math.ceil'd to a whole unit (33.333333333333336
      // → "34") — not the nearest representation of what payrollEngine.js's
      // computeRates() actually computed and used for every OT/penalty
      // calculation, with no documented accounting reason. Shown to 2
      // decimals instead, matching the engine's rate exactly.
      field: 'hourlyRate', headerName: 'أجر الساعة', width: 100, minWidth: 90, headerClass: 'ag-header-center',
      valueFormatter: p => fmtDec(p.value, 2),
      cellStyle: { ...NUM, ...CENTER, color: 'var(--c-code)', fontSize: '11px' },
    },
    // ── Attendance ────────────────────────────────────────────────────────────
    {
      field: 'workDays', headerName: 'أيام الحضور', width: 104, minWidth: 92, headerClass: 'ag-header-center',
      valueFormatter: p => fmtIntZero(p.value),
      cellStyle: { ...CENTER, ...NUM, color: 'var(--c-green)' },
    },
    {
      field: 'absentDays', headerName: 'الغياب', width: 90, minWidth: 82, headerClass: 'ag-header-center',
      valueFormatter: p => fmtIntZero(p.value),
      cellStyle: p => ({ ...CENTER, ...NUM, color: (p.value || 0) > 0 ? 'var(--c-red)' : 'var(--c-muted)' }),
    },
    {
      field: 'overtimeHours', headerName: 'ساعات الإضافي', width: 114, minWidth: 102, headerClass: 'ag-header-center',
      valueFormatter: p => (p.value || 0) > 0 ? fmtOTHours(p.value) : '—',
      cellStyle: p => ({ ...NUM, ...CENTER, color: (p.value || 0) > 0 ? 'var(--c-ot)' : 'var(--c-muted)' }),
    },
    {
      field: 'overtimeAmount', headerName: 'قيمة الإضافي', width: 118, minWidth: 104, headerClass: 'ag-header-center',
      valueFormatter: p => (p.value || 0) > 0 ? fmtMoney(p.value) : '—',
      cellStyle: p => ({ ...MONEY, color: (p.value || 0) > 0 ? 'var(--c-ot)' : 'var(--c-muted)' }),
    },
    // ── ساعات الخصم (EP-022): canonical penaltyUnits — late + early-leave
    // deduction hours only (payrollEngine.computePayroll's totalEffectiveDeductionUnits).
    // Excludes السلف/خصم إداري/absence-day penalties, which are money, not hours.
    {
      field: 'penaltyUnits', headerName: 'ساعات الخصم', width: 114, minWidth: 102, headerClass: 'ag-header-center',
      valueFormatter: p => fmtPenaltyUnits(p.value),
      cellStyle: p => ({ ...NUM, ...CENTER, color: (p.value || 0) > 0 ? 'var(--c-red)' : 'var(--c-muted)' }),
    },
    // ── Deductions (total computed by engine) ─────────────────────────────────
    {
      field: 'deductions', headerName: 'الخصومات', width: 118, minWidth: 104, headerClass: 'ag-header-center',
      valueFormatter: p => (p.value || 0) > 0 ? fmtMoney(p.value) : '—',
      cellStyle: p => ({ ...MONEY, color: (p.value || 0) > 0 ? 'var(--c-red)' : 'var(--c-muted)' }),
    },
    // ── السلف (editable — calls PUT /payroll/:id/advances to create delta Advance row) ──
    {
      field: 'advances', headerName: 'السلف', width: 110, minWidth: 96, headerClass: 'ag-header-center',
      editable: true,
      cellClass: editCellClass('advances'),
      valueFormatter: p => fmtEditableZero(p.value, v => ((v || 0) > 0 ? fmtMoney(v) : '—')),
      cellStyle: p => ({ ...MONEY, alignItems:'center', color: (p.value || 0) > 0 ? '#d97706' : 'var(--c-muted)' }),
    },
    // ── خصم إداري (editable — maps to manualDeductionAdjustment) ────────────
    {
      field: 'manualDeductionAdjustment', headerName: 'خصم إداري', width: 118, minWidth: 104,
      editable: true,
      cellClass: editCellClass('manualDeductionAdjustment'),
      headerClass: 'ag-header-center',
      valueFormatter: p => fmtEditableZero(p.value, v => ((v || 0) > 0 ? fmtMoney(v) : '—')),
      cellStyle: p => ({ ...MONEY, alignItems:'center', color: (p.value || 0) > 0 ? 'var(--c-red)' : 'var(--c-muted)' }),
    },
    // ── Net salary (pinned left) ───────────────────────────────────────────────
    // EF-019.1: displayed net = displayNetSalary(the row's own canonical
    // `netSalary` field) — the ONE shared presentation-layer implementation,
    // used identically by every payroll consumer (Salary Card, Final Salary
    // Modal, Compact Salary Sheet, Print Preview, PDF, Excel). Previously this
    // column independently re-derived net from separately-rounded components
    // (basic/OT/deductions/advances), which could disagree with the other
    // consumers' own independent re-derivations by ±1 on some rows (EF-019).
    {
      field: 'netSalary', headerName: 'صافي الراتب', width: 128, minWidth: 112, pinned: 'left',
      headerClass: 'ag-header-center',
      valueFormatter: p => fmtMoney(displayNetSalary(p.value)),
      cellStyle: { ...MONEY, fontSize: '13px', fontWeight: '800', color: 'var(--c-net)', borderLeft: '2px solid #2563eb' },
    },
    // ── Action: opens the full salary statement (pinned left) ─────────────────
    {
      field: '_action', headerName: '', width: 64, minWidth: 60, pinned: 'left',
      sortable: false, filter: false, suppressMenu: true,
      headerClass: 'ag-header-center',
      cellRenderer: DetailBtnRenderer,
      cellStyle: { ...CENTER },
    },
  ], []);

  const defaultColDef = useMemo(() => ({ ...ENTERPRISE_DEFAULT_COL_DEF }), []);

  // Guarded regardless of trigger (background live-sync OR the manual
  // refresh button) — either would otherwise replace rowData mid-edit.
  const load = async () => {
    if (editCountRef.current > 0) { pendingReloadRef.current = true; return; }
    setLoading(true);
    try {
      const params = { month, year };
      if (deptId) params.departmentId = deptId;
      const { data } = await api.get('/payroll', { params });
      setRows(data);
    } catch { toast.error('تعذر تحميل المرتبات'); }
    finally { setLoading(false); }
  };

  // EP-014: targeted refresh — refetches just the named employee's payroll
  // row (computePayroll() narrowed server-side to one employeeId, same
  // canonical calculation, just a smaller input set) instead of reloading
  // every employee for the month.
  const loadOne = async (employeeIds) => {
    try {
      const fetched = await Promise.all(employeeIds.map(id =>
        api.get('/payroll', { params: { month, year, employeeId: id } }).then(r => r.data[0]).catch(() => null)
      ));
      setRows(rs => {
        let next = rs;
        for (const row of fetched) {
          if (!row) continue;
          const exists = next.some(r => r.employeeId === row.employeeId);
          // A department filter is active and this employee wasn't already a
          // visible row — don't inject it client-side without knowing
          // whether it actually belongs to the filtered department; the next
          // full reload (guaranteed by the other live-sync events) reconciles
          // it correctly server-side. Updating an ALREADY-visible row is
          // always safe (it already passed the filter).
          if (!exists && deptId) continue;
          next = exists ? next.map(r => (r.employeeId === row.employeeId ? row : r)) : [...next, row];
        }
        return next;
      });
    } catch { /* silent — next full reload (rules/device event) will catch up */ }
  };

  useEffect(() => { load(); }, [month, year, deptId]);
  useRulesLiveSync(load, { isBusyRef: editCountRef });
  useDeviceLiveSync(load, { silent: true, isBusyRef: editCountRef, reloadOne: loadOne });

  const calculate = async () => {
    setCalcing(true);
    try {
      await api.post('/payroll/calculate', { month, year }, LONG_OP);
      toast.success('تم احتساب المرتبات بنجاح');
      load();
    } catch { toast.error('فشل الاحتساب'); }
    finally { setCalcing(false); }
  };

  const FIELD_LABELS = {
    basicSalary:                'الراتب الأساسي',
    manualDeductionAdjustment:  'خصم إداري',
    advances:                   'السلف',
  };
  const MAX_FINANCIAL   = 100_000_000;
  const DIRECT_REASON   = 'تعديل مباشر من جدول المرتبات';

  const handleCellEdit = async ({ data, colDef, newValue, oldValue, node }) => {
    const field = colDef.field;
    if (!FIELD_LABELS[field] || !data) return;

    const label  = FIELD_LABELS[field];
    const oldNum = parseFloat(oldValue) || 0;
    const raw    = (newValue === '' || newValue == null) ? '0' : String(newValue).trim();
    const num    = Number(raw);

    if (!Number.isFinite(num)) {
      toast.error(`"${label}" يجب أن تكون رقمًا صحيحًا`);
      node.setDataValue(field, oldValue); return;
    }
    if (num < 0) {
      toast.error(`"${label}" لا تقبل قيمة سالبة`);
      node.setDataValue(field, oldValue); return;
    }
    if (num > MAX_FINANCIAL) {
      toast.error(`"${label}" تتجاوز الحد الأقصى المسموح`);
      node.setDataValue(field, oldValue); return;
    }
    if (num === oldNum) return;

    editCountRef.current++;
    markSaving(data.id, field, node, true);
    try {
      // السلف uses a dedicated endpoint that creates a delta Advance record
      // so the payroll engine can recompute advances + netSalary correctly.
      const res = field === 'advances'
        ? await api.put(`/payroll/${data.id}/advances`, { amount: num, reason: DIRECT_REASON, modifiedByName: ACTOR })
        : await api.put(`/payroll/${data.id}`, { [field]: num, reason: DIRECT_REASON, modifiedByName: ACTOR });
      const updated = res.data;
      // Another editable column on this same row may still be saving (e.g.
      // the user tabbed to the next editable cell — basicSalary/advances/
      // manualDeductionAdjustment — before this one resolved). This response
      // is a snapshot from before that sibling edit, so only apply the field
      // it's authoritative for; clobbering the whole row here would revert
      // the sibling's in-flight value and swap the row's object identity out
      // from under AG Grid mid-edit.
      const rowKeyPrefix = `${data.id}:`;
      const hasOtherFieldsInFlight = Array.from(savingCellsRef.current)
        .some(k => k.startsWith(rowKeyPrefix) && k !== `${rowKeyPrefix}${field}`);
      if (hasOtherFieldsInFlight) pendingReloadRef.current = true;
      setRows(rs => rs.map(r => {
        if (r.id !== updated.id) return r;
        return hasOtherFieldsInFlight
          ? { ...r, [field]: updated[field] }
          : { ...r, ...updated, employee: { ...r.employee, ...updated.employee } };
      }));
      // No success toast for single-cell saves — cell updates visually
    } catch (err) {
      toast.error(err?.response?.data?.error || 'فشل الحفظ');
      node.setDataValue(field, oldValue);
    } finally {
      editCountRef.current--;
      markSaving(data.id, field, node, false);
      if (editCountRef.current === 0 && pendingReloadRef.current) { pendingReloadRef.current = false; load(); }
    }
  };

  // Double-clicking any non-editable, non-action cell also opens the full sheet.
  const onCellDoubleClicked = (e) => {
    if (e.colDef?.editable || e.colDef?.field === '_action' || !e.data) return;
    setModal({ row: e.data, bulk: false });
  };

  // EP-026: window.open() to a relative URL is silently denied by Electron's
  // setWindowOpenHandler (new URL() throws on a non-absolute URL → caught →
  // action:'deny') and, even served plain, bypasses api.js's Bearer-token
  // interceptor required whenever AUTH_ENABLED=true (EP-009 LAN/Server mode).
  // Route the request through the authenticated `api` client instead and
  // save the returned blob via a temporary anchor — no new window involved.
  const exportExcel = async () => {
    try {
      const res = await api.get('/reports/payroll/export', {
        params: { month, year },
        responseType: 'blob',
      });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `payroll_${month}_${year}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error('فشل تصدير ملف Excel');
    }
  };

  const totals = useMemo(() => ({
    basic:       rows.reduce((s, r) => s + (r.basicSalary                || 0), 0),
    ot:          rows.reduce((s, r) => s + (r.overtimeAmount             || 0), 0),
    deduct:      rows.reduce((s, r) => s + (r.deductions                 || 0), 0),
    deductHours: rows.reduce((s, r) => s + (r.penaltyUnits               || 0), 0),
    advances:    rows.reduce((s, r) => s + (r.advances                   || 0), 0),
    adminDeduct: rows.reduce((s, r) => s + (r.manualDeductionAdjustment  || 0), 0),
    net:         rows.reduce((s, r) => s + (r.netSalary                  || 0), 0),
  }), [rows]);

  return (
    <div className="flex flex-col gap-3" style={{ flex: 1, minHeight: 0 }} dir="rtl">

      {/* ── Page header ──────────────────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">المرتبات</h1>
          <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
            {MONTHS_AR[month - 1]} {year} · {rows.length} موظف
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              if (rows.length === 0) {
                toast.error('لا توجد مرتبات محسوبة لهذا الشهر');
                return;
              }
              setModal({ row: null, bulk: true });
            }}
            className="btn-secondary text-xs py-1.5 px-3">
            <Users className="w-3.5 h-3.5" /> كشوف الكل
          </button>
          <button onClick={exportExcel} className="btn-secondary text-xs py-1.5 px-3">
            <Download className="w-3.5 h-3.5" /> Excel
          </button>
          <button onClick={() => setPrintOpen(true)} className="btn-secondary text-xs py-1.5 px-3">
            <Printer className="w-3.5 h-3.5" /> طباعة
          </button>
          <button onClick={() => setCalcConfirm(true)} className="btn-primary text-xs py-1.5 px-3" disabled={calcing}>
            {calcing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {calcing ? 'جاري الاحتساب...' : 'احتساب المرتبات'}
          </button>
        </div>
      </div>

      {/* ── Filters + Totals bar ─────────────────────────────────────────────── */}
      <div className="card p-3 flex flex-wrap items-center justify-between gap-3">

        {/* Filters: [القسم] [الشهر] [السنة] [تحديث] */}
        <div className="flex items-center gap-2 flex-wrap">
          <select
            className="input w-auto text-xs py-1.5"
            value={deptId}
            onChange={e => setDeptId(parseInt(e.target.value))}
          >
            <option value={0}>جميع الأقسام</option>
            {departments.map(d => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>

          <select className="input w-auto text-xs py-1.5" value={month}
            onChange={e => setMonth(parseInt(e.target.value))}>
            {MONTHS_AR.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select>

          <select className="input w-auto text-xs py-1.5" value={year}
            onChange={e => setYear(parseInt(e.target.value))}>
            {getYearRange().map(y => <option key={y} value={y}>{y}</option>)}
          </select>

          <button onClick={load} className="btn-ghost p-1.5 rounded" title="تحديث">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Running totals */}
        <div className="flex items-center gap-5 text-xs font-mono">
          {[
            { label: 'إجمالي الرواتب',  value: totals.basic,       cls: 'text-slate-200'  },
            { label: 'إجمالي الإضافي',  value: totals.ot,          cls: 'text-purple-400' },
            { label: 'إجمالي الخصومات', value: totals.deduct,      cls: 'text-red-400'    },
            { label: 'إجمالي ساعات الخصم', value: totals.deductHours, cls: 'text-red-400', penaltyHours: true },
            { label: 'إجمالي السلف',    value: totals.advances,    cls: 'text-amber-400'  },
            { label: 'إجمالي خصم إداري',value: totals.adminDeduct, cls: 'text-red-400'    },
            { label: 'إجمالي صافي',      value: totals.net,         cls: 'text-blue-400'   },
          ].map(item => (
            <div key={item.label} className="flex flex-col items-end">
              <span className="text-gray-500 font-sans text-xs leading-tight">{item.label}</span>
              <span className={`font-bold text-sm ${item.cls}`} style={{ direction: 'ltr' }}>
                {item.penaltyHours ? fmtPenaltyUnits(item.value) : fmtMoney(item.value)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Data grid ────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden" style={{ minHeight: 0 }}>
        <div className={`${agGridTheme} h-full`}>
          <AgGridReact
            ref={gridRef}
            rowData={rows}
            getRowId={getRowId}
            columnDefs={cols}
            defaultColDef={defaultColDef}
            context={{ openDetail }}
            {...ENTERPRISE_GRID_PROPS}
            onCellEditingStopped={handleCellEdit}
            onCellDoubleClicked={onCellDoubleClicked}
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
            rowHeight={36}
            headerHeight={40}
            pagination
            paginationPageSize={50}
            paginationPageSizeSelector={[25, 50, 100]}
            loading={loading}
          />
        </div>
      </div>

      {/* ── Final Salary Modal ────────────────────────────────────────────────── */}
      {modal && (
        <FinalSalaryModal
          payrollRow={modal.row}
          month={month}
          year={year}
          bulk={modal.bulk}
          allRows={modal.bulk ? rows : []}
          onClose={() => setModal(null)}
        />
      )}

      <PrintPreviewModal
        isOpen={printOpen}
        onClose={() => setPrintOpen(false)}
        data={rows}
        reportType="payroll"
        meta={{
          period: `${MONTHS_AR[month - 1]} ${year}`,
          subtitle: `إجمالي الموظفين: ${rows.length}`,
        }}
        orientation="landscape"
      />

      {/* ── Payroll Calculation Confirmation Dialog ─────────────────── */}
      {calcConfirm && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(8,12,22,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} dir="rtl"
          onClick={e => e.target === e.currentTarget && setCalcConfirm(false)}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, width: '100%', maxWidth: 420, boxShadow: 'var(--shadow-pop)', overflow: 'hidden' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
              <AlertTriangle style={{ width: 18, height: 18, color: '#d97706', flexShrink: 0 }} />
              <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)', flex: 1 }}>تأكيد احتساب المرتبات</span>
              <button onClick={() => setCalcConfirm(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: 4 }}>
                <X style={{ width: 16, height: 16 }} />
              </button>
            </div>
            {/* Body */}
            <div style={{ padding: '18px 18px 10px', fontSize: 14, color: 'var(--text-2)', lineHeight: 1.7 }}>
              <p>سيتم <strong style={{ color: 'var(--text)' }}>احتساب مرتبات جميع الموظفين</strong> للفترة المحددة:</p>
              <div style={{ margin: '10px 0', padding: '8px 14px', borderRadius: 7, background: 'var(--accent-soft)', border: '1px solid var(--border)', fontSize: 13, fontWeight: 700, color: 'var(--accent)' }}>
                {['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'][month-1]} {year}
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-3)' }}>سيتم حساب الراتب الصافي بناءً على بيانات الحضور والخصومات والإضافي. هل تريد المتابعة؟</p>
            </div>
            {/* Actions */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '10px 18px 16px' }}>
              <button onClick={() => setCalcConfirm(false)} className="btn-secondary text-sm py-2 px-4">إلغاء</button>
              <button onClick={() => { setCalcConfirm(false); calculate(); }} className="btn-primary text-sm py-2 px-5"
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Play style={{ width: 13, height: 13 }} /> متابعة الاحتساب
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
