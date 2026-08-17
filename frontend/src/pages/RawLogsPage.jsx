import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';
import { RefreshCw, Download, Printer } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { useTheme } from '../contexts/ThemeContext';
import { AG_GRID_LOCALE_AR } from '../lib/agGridLocale';
import { fmtDateTime } from '../lib/formatters';
import { ENTERPRISE_DEFAULT_COL_DEF, ENTERPRISE_GRID_PROPS } from '../lib/gridDefaults';
import PrintPreviewModal from '../components/PrintPreviewModal';
import { useRulesLiveSync } from '../hooks/useRulesLiveSync';
import { useDeviceLiveSync } from '../hooks/useDeviceLiveSync';

const VERIFY = { 0: 'Password', 1: 'Fingerprint', 2: 'Card', 3: 'Finger + Pass', 4: 'Face', 15: 'Unknown' };
const NUM = { textAlign: 'right', direction: 'ltr', fontFamily: 'Consolas, monospace' };

export default function RawLogsPage() {
  const { agGridTheme } = useTheme();
  const [logs,      setLogs]      = useState([]);
  const [total,     setTotal]     = useState(0);
  const [loading,   setLoading]   = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [from, setFrom] = useState(new Date().toISOString().split('T')[0]);
  const [to,   setTo]   = useState(new Date().toISOString().split('T')[0]);
  const gridRef = useRef();

  const cols = useMemo(() => [
    {
      field: 'id', headerName: 'ID', width: 80, sort: 'desc', pinned: 'right',
      cellStyle: { ...NUM, color: 'var(--c-muted)', fontSize: '11px', justifyContent: 'center' } },
    {
      field: 'zkUserId', headerName: 'ZK ID', width: 75, pinned: 'right',
      cellStyle: { fontFamily: 'Consolas, monospace', color: 'var(--c-code)', fontSize: '11px', textAlign: 'center', justifyContent: 'center' } },
    {
      field: 'employee.name', headerName: 'الموظف', width: 190, pinned: 'right',
      cellStyle: { fontWeight: '600', color: 'var(--c-name)', fontFamily: 'Cairo, sans-serif' } },
    {
      field: 'device.name', headerName: 'الجهاز', width: 175,
      cellStyle: { color: 'var(--c-dept)', fontFamily: 'Cairo, sans-serif', fontSize: '11px' } },
    {
      field: 'timestamp', headerName: 'التاريخ والوقت', width: 185, sort: 'desc',
      valueFormatter: p => fmtDateTime(p.value),
      cellStyle: { ...NUM, fontSize: '11px', color: 'var(--c-time)' } },
    {
      field: 'verifyType', headerName: 'طريقة التحقق', width: 140,
      valueFormatter: p => VERIFY[p.value] || `Type ${p.value}`,
      cellStyle: { color: 'var(--c-dept)', fontSize: '11px' } },
    {
      field: 'isDuplicate', headerName: 'مكرر', width: 80,
      cellRenderer: ({ value }) => value
        ? <span className="badge-yellow text-xs">مكرر</span>
        : <span style={{ color: 'var(--c-muted)' }}>—</span>,
      cellStyle: { justifyContent: 'center' } },
    {
      field: 'source', headerName: 'المصدر', width: 90,
      cellStyle: { ...NUM, fontSize: '11px', color: 'var(--c-muted)', textAlign: 'center', justifyContent: 'center' } },
  ], []);

  const defaultColDef = useMemo(() => ({ ...ENTERPRISE_DEFAULT_COL_DEF }), []);
  // Perf Fix #4: same stable-identity pattern as PayrollPage/AttendanceDailyPage/
  // AttendanceMonthlyPage/RulesPage — `id` is the AttendanceLog row's own
  // primary key (already displayed as the pinned "ID" column above), unique
  // per raw punch record.
  const getRowId = useCallback(p => String(p.data.id), []);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/attendance/logs', {
        params: { from: from + 'T00:00:00', to: to + 'T23:59:59', limit: 500 } });
      setLogs(data.logs); setTotal(data.total);
    } catch { toast.error('فشل تحميل السجلات'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [from, to]);
  useRulesLiveSync(load, { silent: true }); // raw logs aren't recalculated, but attendance status overlays may shift
  useDeviceLiveSync(load, { silent: true }); // new punches synced from device → reload automatically

  const exportCSV = () =>
    gridRef.current?.api?.exportDataAsCsv({ fileName: `logs-${from}-${to}.csv` });

  return (
    <div className="flex flex-col gap-3" style={{ flex: 1, minHeight: 0 }} dir="rtl">
      <div className="page-header">
        <div>
          <h1 className="page-title">سجلات البصمة الخام</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            {total.toLocaleString('en-US')} حركة إجمالية
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={exportCSV} className="btn-secondary text-xs py-1.5 px-3">
            <Download className="w-3.5 h-3.5" /> CSV
          </button>
          <button onClick={() => setPrintOpen(true)} className="btn-secondary text-xs py-1.5 px-3">
            <Printer className="w-3.5 h-3.5" /> طباعة
          </button>
        </div>
      </div>

      <div className="card p-3 flex items-center gap-4">
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span>من</span>
          <input type="date" className="input w-auto text-xs py-1.5 font-mono" dir="ltr"
            value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span>إلى</span>
          <input type="date" className="input w-auto text-xs py-1.5 font-mono" dir="ltr"
            value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <button onClick={load} className="btn-ghost p-1.5 rounded">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
        <span className="text-xs text-gray-500 font-mono">{logs.length.toLocaleString('en-US')} نتيجة</span>
      </div>

      <div className="flex-1 overflow-hidden" style={{ minHeight: 0 }}>
        <div className={`${agGridTheme} h-full`}>
          <AgGridReact
            ref={gridRef}
            rowData={logs}
            columnDefs={cols}
            defaultColDef={defaultColDef}
            {...ENTERPRISE_GRID_PROPS}
            enableRtl={true}
            localeText={AG_GRID_LOCALE_AR}
            animateRows={false}
            pagination
            paginationPageSize={100}
            paginationPageSizeSelector={[50, 100, 200, 500]}
            loading={loading}
            getRowId={getRowId}
          />
        </div>
      </div>

      <PrintPreviewModal
        isOpen={printOpen}
        onClose={() => setPrintOpen(false)}
        data={logs}
        reportType="raw_logs"
        meta={{ period: `${from} — ${to}`, generatedBy: 'مدير النظام' }}
        orientation="landscape"
      />
    </div>
  );
}


