import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';
import { Plus, RefreshCw, X, Loader2, UserCheck, UserX, Trash2, Monitor, AlertTriangle, Search } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { fmtMoney } from '../lib/formatters';
import { useTheme } from '../contexts/ThemeContext';
import { AG_GRID_LOCALE_AR } from '../lib/agGridLocale';
import { ENTERPRISE_DEFAULT_COL_DEF, ENTERPRISE_GRID_PROPS } from '../lib/gridDefaults';

const NUM = { textAlign: 'right', direction: 'ltr', justifyContent: 'flex-end', fontFamily: 'Consolas, monospace' };

// ── Employee Delete Confirmation Modal ────────────────────────────────────────
function DeleteInfoModal({ open, info, onClose, onConfirm }) {
  const [deleting, setDeleting] = useState(false);

  if (!open || !info) return null;
  const { employee: emp, payrollCount, attendanceCount, advanceCount,
          canHardDelete, blockReason, devices } = info;

  const handleAction = async (includeDevice) => {
    setDeleting(true);
    try {
      await onConfirm(includeDevice);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-gray-900 shadow-2xl border border-red-900/40 w-full max-w-lg rounded-xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 bg-red-950/30">
          <div className="flex items-center gap-2.5">
            <Trash2 className="w-4 h-4 text-red-400" />
            <h2 className="text-sm font-bold text-white">حذف موظف</h2>
          </div>
          <button onClick={onClose} className="btn-ghost p-1.5 rounded"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* Employee info */}
          <div className="bg-gray-800/60 rounded-lg p-3.5 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div>
              <span className="text-gray-500 text-xs">الاسم</span>
              <p className="font-bold text-white mt-0.5">{emp.name}</p>
            </div>
            <div>
              <span className="text-gray-500 text-xs">الكود</span>
              <p className="font-mono text-gray-300 mt-0.5">{emp.code || '—'}</p>
            </div>
            <div>
              <span className="text-gray-500 text-xs">ZK ID</span>
              <p className="font-mono text-gray-300 mt-0.5">{emp.zkUserId}</p>
            </div>
            <div>
              <span className="text-gray-500 text-xs">الفرع</span>
              <p className="text-gray-300 mt-0.5">{emp.branch?.name || '—'}</p>
            </div>
          </div>

          {/* History warning */}
          {!canHardDelete && (
            <div className="flex items-start gap-2.5 bg-amber-950/40 border border-amber-700/40 rounded-lg p-3 text-xs">
              <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-amber-300 font-semibold">لا يمكن الحذف النهائي</p>
                <p className="text-amber-400/80 mt-0.5">{blockReason} — سيتم أرشفة الموظف (تعطيل الحساب) مع الحفاظ على جميع السجلات.</p>
              </div>
            </div>
          )}

          {/* Stats */}
          <div className="grid grid-cols-3 gap-2 text-center text-xs">
            {[
              { label: 'سجلات الراتب', value: payrollCount, warn: payrollCount > 0 },
              { label: 'سجلات الحضور', value: attendanceCount, warn: attendanceCount > 0 },
              { label: 'السلفيات',      value: advanceCount,   warn: advanceCount > 0 },
            ].map(({ label, value, warn }) => (
              <div key={label} className={`rounded-lg p-2.5 ${warn ? 'bg-amber-950/30 border border-amber-800/30' : 'bg-gray-800/50'}`}>
                <p className={`text-lg font-bold ${warn ? 'text-amber-400' : 'text-gray-400'}`}>{value}</p>
                <p className="text-gray-500 mt-0.5">{label}</p>
              </div>
            ))}
          </div>

          {/* Connected devices */}
          <div>
            <p className="text-xs text-gray-500 mb-1.5 flex items-center gap-1.5">
              <Monitor className="w-3.5 h-3.5" /> الأجهزة المتصلة ({devices.length})
            </p>
            {devices.length === 0 ? (
              <p className="text-xs text-gray-600 italic">لا توجد أجهزة مفعّلة</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {devices.map(d => (
                  <span key={d.id} className="text-xs bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-gray-300">
                    {d.name}
                    <span className="text-gray-600 mr-1">({d.branch?.name})</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 px-5 pb-5">
          <button
            onClick={() => handleAction(true)}
            disabled={deleting || devices.length === 0}
            className="flex-1 flex items-center justify-center gap-2 py-2 px-3 text-xs font-semibold rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors"
          >
            {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            حذف من النظام والبصمة
          </button>
          <button
            onClick={() => handleAction(false)}
            disabled={deleting}
            className="flex-1 flex items-center justify-center gap-2 py-2 px-3 text-xs font-semibold rounded-lg bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white transition-colors"
          >
            {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            حذف من النظام فقط
          </button>
          <button onClick={onClose} disabled={deleting} className="py-2 px-3 text-xs rounded-lg btn-secondary">
            إلغاء
          </button>
        </div>
      </div>
    </div>
  );
}

const MONITOR_COLORS = [
  { value: '#f59e0b', label: 'أصفر'   },
  { value: '#ef4444', label: 'أحمر'   },
  { value: '#3b82f6', label: 'أزرق'   },
  { value: '#10b981', label: 'أخضر'   },
  { value: '#a855f7', label: 'بنفسجي' },
  { value: '#f97316', label: 'برتقالي'},
  { value: '#ec4899', label: 'وردي'   },
];

function EmployeeModal({ open, onClose, onSaved, emp, branches, departments }) {
  const empty = { name:'', zkUserId:'', code:'', phone:'', email:'',
                  position:'', salary:'', departmentId:'', branchId:'', status: true,
                  isMonitored: false, monitorColor: '#f59e0b' };
  const [form, setForm]   = useState(empty);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm(emp
      ? { ...empty, ...emp, departmentId: emp.departmentId || '',
          isMonitored: emp.isMonitored || false,
          monitorColor: emp.monitorColor || '#f59e0b' }
      : empty);
  }, [emp, open]);

  const save = async (e) => {
    e.preventDefault(); setSaving(true);
    try {
      const payload = { ...form };
      if (emp) await api.put(`/employees/${emp.id}`, payload);
      else     await api.post('/employees', payload);
      toast.success(emp ? 'تم تحديث بيانات الموظف' : 'تم إضافة الموظف بنجاح');
      onSaved(); onClose();
    } catch (err) { toast.error(err.response?.data?.error || 'فشل الحفظ'); }
    finally { setSaving(false); }
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-gray-900 shadow-2xl border border-gray-800 w-full max-w-2xl max-h-[90vh] overflow-auto rounded-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 bg-gray-950/50">
          <div>
            <h2 className="text-base font-bold text-white">
              {emp ? 'تعديل بيانات موظف' : 'إضافة موظف جديد'}
            </h2>
            {emp && <p className="text-xs text-gray-500">{emp.code}</p>}
          </div>
          <button onClick={onClose} className="btn-ghost p-2 rounded-lg"><X className="w-4 h-4" /></button>
        </div>

        <form onSubmit={save} className="p-6 grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="label">الاسم الكامل *</label>
            <input className="input" required value={form.name}
              onChange={e => setForm({...form, name: e.target.value})} placeholder="اسم الموظف الكامل" />
          </div>
          <div>
            <label className="label">رقم الجهاز (ZK ID) *</label>
            <input className="input font-mono" required value={form.zkUserId}
              onChange={e => setForm({...form, zkUserId: e.target.value})} placeholder="الرقم في جهاز البصمة" />
          </div>
          <div>
            <label className="label">كود الموظف</label>
            <input className="input font-mono" value={form.code}
              onChange={e => setForm({...form, code: e.target.value})} placeholder="EMP-001" />
          </div>
          <div>
            <label className="label">رقم الهاتف</label>
            <input className="input" value={form.phone}
              onChange={e => setForm({...form, phone: e.target.value})} dir="ltr" />
          </div>
          <div>
            <label className="label">المسمى الوظيفي</label>
            <input className="input" value={form.position}
              onChange={e => setForm({...form, position: e.target.value})} placeholder="مدير - محاسب - مهندس..." />
          </div>
          <div>
            <label className="label">الراتب الأساسي</label>
            <input className="input font-mono" type="number" value={form.salary}
              onChange={e => setForm({...form, salary: e.target.value})} placeholder="0" dir="ltr" />
          </div>
          <div>
            <label className="label">الفرع *</label>
            <select className="input" required value={form.branchId}
              onChange={e => setForm({...form, branchId: e.target.value})}>
              <option value="">-- اختر الفرع --</option>
              {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">القسم</label>
            <select className="input" value={form.departmentId}
              onChange={e => setForm({...form, departmentId: e.target.value})}>
              <option value="">-- اختر القسم --</option>
              {departments
                .filter(d => !form.branchId || d.branchId === parseInt(form.branchId))
                .map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>

          {/* ── Monitor highlight ─────────────────────────────────────────── */}
          <div className="col-span-2 border border-gray-700 rounded-lg p-3 space-y-2.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
                <span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-400" />
                مراقبة الموظف (تمييز بصري)
              </label>
              <button
                type="button"
                onClick={() => setForm(f => ({ ...f, isMonitored: !f.isMonitored }))}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${form.isMonitored ? 'bg-amber-500' : 'bg-gray-600'}`}
              >
                <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${form.isMonitored ? 'translate-x-4' : 'translate-x-1'}`} style={{ transform: form.isMonitored ? 'translateX(18px)' : 'translateX(2px)' }} />
              </button>
            </div>
            {form.isMonitored && (
              <div className="flex flex-wrap gap-2">
                {MONITOR_COLORS.map(c => (
                  <button
                    key={c.value}
                    type="button"
                    title={c.label}
                    onClick={() => setForm(f => ({ ...f, monitorColor: c.value }))}
                    className="w-7 h-7 rounded-full border-2 transition-all"
                    style={{
                      background: c.value,
                      borderColor: form.monitorColor === c.value ? '#fff' : 'transparent',
                      boxShadow: form.monitorColor === c.value ? `0 0 0 2px ${c.value}` : 'none',
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="col-span-2 flex justify-start gap-2 pt-3 border-t border-gray-800">
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {saving ? 'جاري الحفظ...' : 'حفظ البيانات'}
            </button>
            <button type="button" onClick={onClose} className="btn-secondary">إلغاء</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function EmployeesPage() {
  const { agGridTheme } = useTheme();
  const [employees,   setEmployees]   = useState([]);
  const [branches,    setBranches]    = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading,     setLoading]     = useState(false);
  // ── Client-side search & filters ──────────────────────────────────────────
  const [searchQ,    setSearchQ]    = useState('');
  const [filterDept, setFilterDept] = useState('');
  const [filterBranch, setFilterBranch] = useState('');
  const [filterStatus, setFilterStatus] = useState('active'); // 'all'|'active'|'inactive'
  const [modal,       setModal]       = useState(false);
  const [editing,     setEditing]     = useState(null);
  const [deleteInfo,  setDeleteInfo]  = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const gridRef = useRef();

  const cols = useMemo(() => [
    {
      field: 'code', headerName: 'الكود', width: 90, pinned: 'right',
      cellStyle: { fontFamily: 'Consolas, monospace', color: 'var(--c-muted)', fontSize: '11px', letterSpacing: '0.04em' } },
    {
      field: 'name', headerName: 'اسم الموظف', width: 200, pinned: 'right',
      cellStyle: { fontWeight: '700', color: 'var(--c-name)', fontFamily: 'Cairo, sans-serif' } },
    {
      field: 'zkUserId', headerName: 'ZK ID', width: 75, headerClass: 'ag-header-center',
      cellStyle: { fontFamily: 'Consolas, monospace', color: 'var(--c-code)', fontSize: '11px', textAlign: 'center', justifyContent: 'center' } },
    {
      field: 'position', headerName: 'المسمى الوظيفي', width: 160,
      cellStyle: { color: 'var(--c-dept)', fontFamily: 'Cairo, sans-serif', fontSize: '11px' } },
    {
      field: 'department.name', headerName: 'القسم', width: 145,
      cellStyle: { color: 'var(--c-dept)', fontFamily: 'Cairo, sans-serif', fontSize: '11px' } },
    {
      field: 'branch.name', headerName: 'الفرع', width: 125,
      cellStyle: { color: 'var(--c-dept)', fontFamily: 'Cairo, sans-serif', fontSize: '11px' } },
    {
      field: 'phone', headerName: 'الهاتف', width: 120,
      cellStyle: { fontFamily: 'Consolas, monospace', fontSize: '11px', direction: 'ltr', justifyContent: 'flex-end', textAlign: 'right' } },
    {
      field: 'salary', headerName: 'الراتب', width: 115,
      valueFormatter: p => fmtMoney(p.value),
      cellStyle: { ...NUM, fontWeight: '600', color: 'var(--c-val)' } },
    {
      field: 'isMonitored', headerName: '●', width: 52, headerClass: 'ag-header-center',
      sortable: false, filter: false,
      cellRenderer: ({ data }) => data?.isMonitored
        ? <span title="موظف تحت المراقبة" style={{ color: data.monitorColor || '#f59e0b', fontSize: '16px', lineHeight: 1 }}>●</span>
        : null,
      cellStyle: { justifyContent: 'center' } },
    {
      field: 'status', headerName: 'الحالة', width: 90, headerClass: 'ag-header-center',
      cellRenderer: ({ value }) => value
        ? <span className="badge-green">نشط</span>
        : <span className="badge-red">موقوف</span>,
      cellStyle: { justifyContent: 'center' } },
    {
      headerName: 'إجراء', width: 180, sortable: false, filter: false, headerClass: 'ag-header-center',
      cellRenderer: ({ data }) => (
        <div className="flex items-center gap-2 justify-center h-full">
          <button
            className="text-blue-400 hover:text-blue-300 text-xs font-medium hover:underline"
            onClick={() => { setEditing(data); setModal(true); }}
          >تعديل</button>
          {data?.status ? (
            <button
              className="text-amber-400 hover:text-amber-300 text-xs font-medium hover:underline"
              onClick={() => handleStatusToggle(data, false)}
            >إيقاف</button>
          ) : (
            <button
              className="text-emerald-400 hover:text-emerald-300 text-xs font-medium hover:underline"
              onClick={() => handleStatusToggle(data, true)}
            >تفعيل</button>
          )}
          <button
            className="text-red-500 hover:text-red-400 text-xs font-medium hover:underline"
            onClick={() => handleDeleteOpen(data)}
          >حذف</button>
        </div>
      ),
      cellStyle: { justifyContent: 'center' } },
  ], []);

  const defaultColDef = useMemo(() => ({ ...ENTERPRISE_DEFAULT_COL_DEF }), []);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [e, b, d] = await Promise.all([
        api.get('/employees'), api.get('/branches'), api.get('/departments'),
      ]);
      setEmployees(e.data); setBranches(b.data); setDepartments(d.data);
    } catch { toast.error('فشل تحميل البيانات'); }
    finally { setLoading(false); }
  };

  const handleStatusToggle = async (emp, newStatus) => {
    const msg = newStatus
      ? `هل تريد إعادة تفعيل الموظف "${emp.name}"؟`
      : `هل تريد إيقاف الموظف "${emp.name}"؟\nيمكن إعادة تفعيله لاحقاً.`;
    if (!window.confirm(msg)) return;
    try {
      await api.put(`/employees/${emp.id}`, {
        name: emp.name,
        zkUserId: emp.zkUserId,
        code: emp.code || '',
        phone: emp.phone || '',
        email: emp.email || '',
        position: emp.position || '',
        salary: emp.salary || 0,
        departmentId: emp.departmentId || '',
        branchId: emp.branchId,
        status: newStatus,
      });
      toast.success(newStatus ? `تم تفعيل "${emp.name}"` : `تم إيقاف "${emp.name}"`);
      loadAll();
    } catch (err) {
      toast.error(err.response?.data?.error || 'فشل التحديث');
    }
  };

  const handleDeleteOpen = async (emp) => {
    setDeleteLoading(true);
    try {
      const { data } = await api.get(`/employees/${emp.id}/delete-info`);
      setDeleteInfo(data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'فشل تحميل معلومات الحذف');
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleDeleteConfirm = async (includeDevice) => {
    if (!deleteInfo) return;
    const { data } = await api.post(`/employees/${deleteInfo.employee.id}/delete-confirm`, { includeDevice });
    const modeLabel = data.mode === 'hard_delete' ? 'حذف نهائي' : 'أرشفة';
    toast.success(`تم ${modeLabel} "${data.employeeName}"`);
    if (data.deviceResults?.length) {
      const ok  = data.deviceResults.filter(r => r.success).length;
      const fail = data.deviceResults.filter(r => !r.success && !r.notFound).length;
      if (ok > 0)   toast.success(`تم حذف البصمة من ${ok} جهاز`);
      if (fail > 0) toast.error(`فشل حذف البصمة من ${fail} جهاز`);
    }
    setDeleteInfo(null);
    loadAll();
  };

  useEffect(() => { loadAll(); }, []);

  const active   = employees.filter(e => e.status).length;
  const inactive = employees.filter(e => !e.status).length;

  // Client-side filtered list
  const filteredEmployees = useMemo(() => {
    const q = searchQ.trim().toLowerCase();
    return employees.filter(e => {
      if (filterStatus === 'active'   && !e.status) return false;
      if (filterStatus === 'inactive' &&  e.status) return false;
      if (filterDept   && String(e.departmentId) !== filterDept)  return false;
      if (filterBranch && String(e.branchId)     !== filterBranch) return false;
      if (q && !e.name?.toLowerCase().includes(q) &&
               !String(e.code || '').toLowerCase().includes(q) &&
               !String(e.zkUserId || '').includes(q)) return false;
      return true;
    });
  }, [employees, searchQ, filterDept, filterBranch, filterStatus]);

  // Stable references — an inline function here is recreated on every
  // keystroke in the search box (filteredEmployees recomputing re-renders
  // this component), which AG Grid's GridOptionsService treats as a changed
  // grid option and forces a full-grid RowCtrl/CellCtrl redraw for every
  // visible row (see EmployeeMovementPage.jsx for the traced root cause).
  const getRowClass = useCallback(({ data }) => data?.isMonitored ? 'row-monitored' : '', []);
  const getRowStyle = useCallback(({ data }) => data?.isMonitored
    ? { borderRight: `6px solid ${data.monitorColor || '#f59e0b'}` }
    : undefined, []);

  return (
    <div className="flex flex-col gap-3" style={{ flex: 1, minHeight: 0 }} dir="rtl">
      <div className="page-header">
        <div>
          <h1 className="page-title">الموظفين</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            {filteredEmployees.length} / {employees.length} &nbsp;·&nbsp;
            <span className="text-emerald-500">{active} نشط</span>
            {inactive > 0 && <>&nbsp;·&nbsp;<span className="text-red-500">{inactive} موقوف</span></>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadAll} className="btn-ghost p-2 rounded-lg">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button className="btn-primary text-xs py-1.5 px-3"
            onClick={() => { setEditing(null); setModal(true); }}>
            <Plus className="w-3.5 h-3.5" /> إضافة موظف
          </button>
        </div>
      </div>

      {/* ── Search + Filters ─────────────────────────────────────────── */}
      <div className="card p-2.5 flex flex-wrap items-center gap-2">
        {/* Search */}
        <div style={{ position: 'relative', flex: '1 1 180px', minWidth: 160, maxWidth: 280 }}>
          <Search style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', width: 14, height: 14, color: 'var(--text-3)' }} />
          <input type="text" placeholder="بحث: اسم، كود، ZK ID..." value={searchQ}
            onChange={e => setSearchQ(e.target.value)}
            className="input text-xs py-1.5"
            style={{ paddingRight: 28, width: '100%' }} />
          {searchQ && <button onClick={() => setSearchQ('')} style={{ position:'absolute', left:6, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', cursor:'pointer', padding:2, color:'var(--text-3)' }}><X style={{ width:12, height:12 }} /></button>}
        </div>
        {/* Department */}
        <select value={filterDept} onChange={e => setFilterDept(e.target.value)} className="input text-xs py-1.5 w-36">
          <option value="">كل الأقسام</option>
          {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        {/* Branch */}
        <select value={filterBranch} onChange={e => setFilterBranch(e.target.value)} className="input text-xs py-1.5 w-32">
          <option value="">كل الفروع</option>
          {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        {/* Status */}
        <div style={{ display: 'flex', gap: 4 }}>
          {[['active','نشط'],['inactive','موقوف'],['all','الكل']].map(([v,l]) => (
            <button key={v} onClick={() => setFilterStatus(v)}
              style={{ padding:'4px 10px', borderRadius:6, fontSize:12, fontWeight:600, cursor:'pointer', border:'1px solid',
                background: filterStatus===v ? 'var(--accent)'    : 'var(--surface-2)',
                borderColor:filterStatus===v ? 'var(--accent)'    : 'var(--border)',
                color:      filterStatus===v ? '#fff'             : 'var(--text-2)' }}>
              {l}
            </button>
          ))}
        </div>
        {/* Clear */}
        {(searchQ || filterDept || filterBranch || filterStatus !== 'active') && (
          <button onClick={() => { setSearchQ(''); setFilterDept(''); setFilterBranch(''); setFilterStatus('active'); }}
            style={{ fontSize:12, fontWeight:600, padding:'4px 8px', borderRadius:6, border:'1px solid rgba(220,38,38,0.3)', background:'rgba(220,38,38,0.07)', color:'#dc2626', cursor:'pointer' }}>
            × مسح
          </button>
        )}
      </div>

      <div className="flex-1 overflow-hidden" style={{ minHeight: 0 }}>
        <div className={`${agGridTheme} h-full`}>
          <AgGridReact
            ref={gridRef}
            rowData={filteredEmployees}
            columnDefs={cols}
            defaultColDef={defaultColDef}
            {...ENTERPRISE_GRID_PROPS}
            enableRtl={true}
            localeText={AG_GRID_LOCALE_AR}
            animateRows={false}
            pagination
            paginationPageSize={50}
            loading={loading}
            getRowClass={getRowClass}
            getRowStyle={getRowStyle}
          />
        </div>
      </div>

      <EmployeeModal
        open={modal}
        onClose={() => { setModal(false); setEditing(null); }}
        onSaved={loadAll}
        emp={editing}
        branches={branches}
        departments={departments}
      />

      <DeleteInfoModal
        open={!!deleteInfo}
        info={deleteInfo}
        onClose={() => setDeleteInfo(null)}
        onConfirm={handleDeleteConfirm}
      />
    </div>
  );
}


