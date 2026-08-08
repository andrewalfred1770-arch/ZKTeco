import React, { useEffect, useId, useState } from 'react';
import {
  Save, Plus, Trash2, Pencil, X, Loader2,
  Building2, GitBranch, Users, Archive,
  AlertTriangle, CheckCircle, RotateCcw,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { useFocusTrap } from '../hooks/useFocusTrap';

// ─── Dependency badge ─────────────────────────────────────────────────────────
function DepBadge({ count, label, warn = false }) {
  if (count === undefined || count === null) return null;
  const color = warn && count > 0 ? '#f59e0b' : count > 0 ? '#6b7280' : '#374151';
  const textColor = count > 0 ? '#e5e7eb' : '#6b7280';
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px',
      borderRadius: 6, border: `1px solid ${color}`, fontSize: 11, color: textColor,
    }}>
      <span style={{ fontWeight: 700, fontFamily: 'Consolas,monospace', color: warn && count > 0 ? '#fbbf24' : textColor }}>
        {count}
      </span>
      <span>{label}</span>
    </div>
  );
}

// ─── Delete / Archive confirmation modal ──────────────────────────────────────
function ArchiveModal({ modal, onConfirm, onCancel }) {
  // Phase 13.9: accessible-dialog semantics — hooks run unconditionally,
  // above the early return below.
  const isOpen = !!modal;
  const titleId = useId();
  const containerRef = useFocusTrap(isOpen);
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onCancel?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onCancel]);

  if (!modal) return null;
  const { type, item, deps, depsLoading, confirming } = modal;

  const typeLabels = { company: 'الشركة', branch: 'الفرع', dept: 'القسم' };
  const hasLinks =
    type === 'company' ? (deps?.activeBranches > 0 || deps?.employees > 0 || deps?.devices > 0)
    : type === 'branch'  ? (deps?.activeDepts > 0 || deps?.employees > 0 || deps?.devices > 0)
    : (deps?.employees > 0 || deps?.rules > 0);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: 16,
      }}
      dir="rtl"
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 14, padding: '24px', width: '100%', maxWidth: 440,
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)', outline: 'none',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10, flexShrink: 0,
            background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Archive style={{ width: 18, height: 18, color: '#f59e0b' }} />
          </div>
          <div>
            <h3 id={titleId} style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-1)', marginBottom: 3 }}>
              أرشفة {typeLabels[type]}
            </h3>
            <p style={{ fontSize: 13, color: '#79C0FF', fontWeight: 600 }}>{item.name}</p>
          </div>
          <button
            onClick={onCancel}
            style={{ marginRight: 'auto', padding: 4, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-3)' }}
          >
            <X style={{ width: 16, height: 16 }} />
          </button>
        </div>

        {/* Dependency section */}
        <div style={{
          background: 'var(--surface-2)', borderRadius: 8, padding: '12px 14px', marginBottom: 16,
          border: '1px solid var(--border)',
        }}>
          <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            البيانات المرتبطة
          </p>

          {depsLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
              <Loader2 style={{ width: 14, height: 14, color: '#79C0FF', animation: 'spin 1s linear infinite' }} />
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>جاري الفحص...</span>
            </div>
          ) : deps ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {type === 'company' && (<>
                <DepBadge count={deps.activeBranches} label="فرع نشط" warn />
                <DepBadge count={deps.departments}    label="قسم" />
                <DepBadge count={deps.employees}      label="موظف" warn />
                <DepBadge count={deps.devices}        label="جهاز بصمة" />
              </>)}
              {type === 'branch' && (<>
                <DepBadge count={deps.activeDepts} label="قسم نشط" warn />
                <DepBadge count={deps.employees}   label="موظف" warn />
                <DepBadge count={deps.devices}     label="جهاز بصمة" />
                <DepBadge count={deps.policies}    label="سياسة" />
                <DepBadge count={deps.rules}       label="قاعدة" />
              </>)}
              {type === 'dept' && (<>
                <DepBadge count={deps.employees} label="موظف" warn />
                <DepBadge count={deps.rules}     label="قاعدة" />
              </>)}
            </div>
          ) : (
            <span style={{ fontSize: 12, color: '#ef4444' }}>تعذّر جلب التفاصيل</span>
          )}
        </div>

        {/* Info message */}
        <div style={{
          display: 'flex', gap: 8, padding: '10px 12px', borderRadius: 8, marginBottom: 18,
          background: hasLinks ? 'rgba(245,158,11,0.06)' : 'rgba(16,185,129,0.06)',
          border: `1px solid ${hasLinks ? 'rgba(245,158,11,0.2)' : 'rgba(16,185,129,0.2)'}`,
        }}>
          {hasLinks
            ? <AlertTriangle style={{ width: 15, height: 15, color: '#f59e0b', flexShrink: 0, marginTop: 1 }} />
            : <CheckCircle   style={{ width: 15, height: 15, color: '#10b981', flexShrink: 0, marginTop: 1 }} />
          }
          <p style={{ fontSize: 12, color: hasLinks ? '#fbbf24' : '#34d399', lineHeight: 1.5 }}>
            {hasLinks
              ? 'هذا السجل مرتبط ببيانات موجودة. بعد الأرشفة ستختفي من القوائم النشطة، لكن جميع البيانات المرتبطة (الموظفون، السجلات، المرتبات) ستبقى محفوظة ولن تُحذف.'
              : 'لا توجد بيانات نشطة مرتبطة بهذا السجل. يمكن أرشفته بأمان.'
            }
          </p>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            disabled={confirming}
            style={{
              padding: '8px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
              background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-2)',
            }}
          >
            إلغاء
          </button>
          <button
            onClick={onConfirm}
            disabled={depsLoading || confirming}
            style={{
              padding: '8px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
              background: '#b45309', border: '1px solid #92400e', color: '#fff',
              display: 'flex', alignItems: 'center', gap: 6,
              opacity: (depsLoading || confirming) ? 0.6 : 1,
            }}
          >
            {confirming
              ? <Loader2 style={{ width: 14, height: 14, animation: 'spin 1s linear infinite' }} />
              : <Archive style={{ width: 14, height: 14 }} />
            }
            {confirming ? 'جاري الأرشفة...' : 'أرشفة'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Inline edit form ─────────────────────────────────────────────────────────
function EditForm({ fields, onSave, onCancel, saving }) {
  return (
    <form onSubmit={onSave} style={{
      padding: '10px 12px', borderRadius: 10,
      background: 'var(--surface-2)', border: '1px solid #2F81F7',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      {fields}
      <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
        <button type="submit" className="btn-primary text-xs py-1.5 flex-1 justify-center" disabled={saving}>
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          حفظ
        </button>
        <button type="button" className="btn-secondary text-xs py-1.5 px-3" onClick={onCancel}>
          <X className="w-3.5 h-3.5" /> إلغاء
        </button>
      </div>
    </form>
  );
}

// ─── Item card ────────────────────────────────────────────────────────────────
function ItemCard({ name, sub, onEdit, onDelete }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 12px', borderRadius: 8,
      background: 'var(--surface-2)', border: '1px solid var(--border)',
    }}>
      <div>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>{name}</p>
        {sub && <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 1 }}>{sub}</p>}
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <button
          onClick={onEdit}
          title="تعديل"
          style={{ padding: 5, background: 'transparent', border: 'none', cursor: 'pointer', borderRadius: 6, color: '#79C0FF' }}
        >
          <Pencil style={{ width: 14, height: 14 }} />
        </button>
        <button
          onClick={onDelete}
          title="أرشفة"
          style={{ padding: 5, background: 'transparent', border: 'none', cursor: 'pointer', borderRadius: 6, color: '#f87171' }}
        >
          <Trash2 style={{ width: 14, height: 14 }} />
        </button>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function SettingsPage() {
  const [companies,   setCompanies]   = useState([]);
  const [branches,    setBranches]    = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading,     setLoading]     = useState(false);

  // Add-new forms
  const [newComp,   setNewComp]   = useState({ name: '', address: '', phone: '' });
  const [newBranch, setNewBranch] = useState({ name: '', companyId: '', address: '' });
  const [newDept,   setNewDept]   = useState({ name: '', branchId: '' });
  const [saving,    setSaving]    = useState('');

  // Inline edit state
  const [editComp,   setEditComp]   = useState(null);
  const [editBranch, setEditBranch] = useState(null);
  const [editDept,   setEditDept]   = useState(null);

  // Archive confirmation modal state
  // shape: { type, item, deps, depsLoading, confirming }
  const [archiveModal, setArchiveModal] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [c, b, d] = await Promise.all([
        api.get('/companies'),
        api.get('/branches'),
        api.get('/departments'),
      ]);
      setCompanies(c.data);
      setBranches(b.data);
      setDepartments(d.data);
    } catch { toast.error('فشل التحميل'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  // ── Opens the archive modal and immediately fetches dep counts ──────────────
  const openArchive = (type, item) => {
    const endpoint =
      type === 'company' ? `/companies/${item.id}/deps`
      : type === 'branch' ? `/branches/${item.id}/deps`
      : `/departments/${item.id}/deps`;

    setArchiveModal({ type, item, deps: null, depsLoading: true, confirming: false });
    api.get(endpoint)
      .then(r => setArchiveModal(m => m?.item.id === item.id ? { ...m, deps: r.data, depsLoading: false } : m))
      .catch(()  => setArchiveModal(m => m ? { ...m, deps: null, depsLoading: false } : m));
  };

  // ── Confirms and executes the archive ──────────────────────────────────────
  const confirmArchive = async () => {
    if (!archiveModal) return;
    const { type, item } = archiveModal;
    setArchiveModal(m => m ? { ...m, confirming: true } : m);
    const url =
      type === 'company' ? `/companies/${item.id}`
      : type === 'branch' ? `/branches/${item.id}`
      : `/departments/${item.id}`;
    try {
      const { data } = await api.delete(url);
      toast.success(data.message || 'تم الأرشفة بنجاح');
      setArchiveModal(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'فشل الأرشفة');
      setArchiveModal(m => m ? { ...m, confirming: false } : m);
    }
  };

  // ── Add handlers ────────────────────────────────────────────────────────────
  const addCompany = async (e) => {
    e.preventDefault(); setSaving('company');
    try {
      await api.post('/companies', newComp);
      toast.success('تمت إضافة الشركة');
      setNewComp({ name: '', address: '', phone: '' });
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'فشل الإضافة'); }
    finally { setSaving(''); }
  };

  const addBranch = async (e) => {
    e.preventDefault(); setSaving('branch');
    try {
      await api.post('/branches', newBranch);
      toast.success('تمت إضافة الفرع');
      setNewBranch({ name: '', companyId: '', address: '' });
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'فشل الإضافة'); }
    finally { setSaving(''); }
  };

  const addDept = async (e) => {
    e.preventDefault(); setSaving('dept');
    try {
      await api.post('/departments', newDept);
      toast.success('تمت إضافة القسم');
      setNewDept({ name: '', branchId: '' });
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'فشل الإضافة'); }
    finally { setSaving(''); }
  };

  // ── Edit save handlers ──────────────────────────────────────────────────────
  const saveCompany = async (e) => {
    e.preventDefault(); setSaving('company-edit');
    try {
      await api.put(`/companies/${editComp.id}`, {
        name: editComp.name, address: editComp.address, phone: editComp.phone,
      });
      toast.success('تم تحديث الشركة'); setEditComp(null); load();
    } catch (err) { toast.error(err.response?.data?.error || 'فشل التحديث'); }
    finally { setSaving(''); }
  };

  const saveBranch = async (e) => {
    e.preventDefault(); setSaving('branch-edit');
    try {
      await api.put(`/branches/${editBranch.id}`, {
        name: editBranch.name, address: editBranch.address, phone: editBranch.phone,
      });
      toast.success('تم تحديث الفرع'); setEditBranch(null); load();
    } catch (err) { toast.error(err.response?.data?.error || 'فشل التحديث'); }
    finally { setSaving(''); }
  };

  const saveDept = async (e) => {
    e.preventDefault(); setSaving('dept-edit');
    try {
      await api.put(`/departments/${editDept.id}`, {
        name: editDept.name, branchId: editDept.branchId,
      });
      toast.success('تم تحديث القسم'); setEditDept(null); load();
    } catch (err) { toast.error(err.response?.data?.error || 'فشل التحديث'); }
    finally { setSaving(''); }
  };

  // Only active companies/branches are needed for dropdowns
  const activeCompanies = companies.filter(c => c.status !== false);

  return (
    <div className="flex flex-col gap-6" style={{ flex: 1, overflow: 'auto', minHeight: 0 }} dir="rtl">

      {/* Page header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">إعدادات النظام</h1>
          <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
            إدارة الشركات والفروع والأقسام
          </p>
        </div>
        {loading && <Loader2 className="w-5 h-5 animate-spin text-blue-400" />}
      </div>

      {/* Three-column grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* ── Companies ─────────────────────────────────────────────────────── */}
        <div className="card p-5 flex flex-col gap-4">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: 'var(--text-1)' }}>
            <Building2 style={{ width: 16, height: 16, color: '#79C0FF' }} />
            الشركات
            <span style={{ marginRight: 'auto', fontSize: 11, color: 'var(--text-3)', fontWeight: 400 }}>
              {activeCompanies.length} نشطة
            </span>
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {activeCompanies.map(c =>
              editComp?.id === c.id ? (
                <EditForm key={c.id} saving={saving === 'company-edit'} onSave={saveCompany} onCancel={() => setEditComp(null)}
                  fields={<>
                    <input className="input text-sm" required placeholder="اسم الشركة" value={editComp.name}
                      onChange={e => setEditComp({ ...editComp, name: e.target.value })} />
                    <input className="input text-sm" placeholder="رقم الهاتف" value={editComp.phone || ''}
                      onChange={e => setEditComp({ ...editComp, phone: e.target.value })} />
                    <input className="input text-sm" placeholder="العنوان" value={editComp.address || ''}
                      onChange={e => setEditComp({ ...editComp, address: e.target.value })} />
                  </>}
                />
              ) : (
                <ItemCard key={c.id} name={c.name} sub={c.phone}
                  onEdit={() => setEditComp({ id: c.id, name: c.name, address: c.address || '', phone: c.phone || '' })}
                  onDelete={() => openArchive('company', c)}
                />
              )
            )}
          </div>

          {/* Add company form */}
          <form onSubmit={addCompany} style={{ borderTop: '1px solid var(--border)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)' }}>إضافة شركة جديدة</p>
            <input className="input text-sm" required placeholder="اسم الشركة" value={newComp.name}
              onChange={e => setNewComp({ ...newComp, name: e.target.value })} />
            <input className="input text-sm" placeholder="رقم الهاتف" value={newComp.phone}
              onChange={e => setNewComp({ ...newComp, phone: e.target.value })} />
            <input className="input text-sm" placeholder="العنوان" value={newComp.address}
              onChange={e => setNewComp({ ...newComp, address: e.target.value })} />
            <button type="submit" className="btn-primary w-full justify-center" disabled={saving === 'company'}>
              {saving === 'company' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              إضافة شركة
            </button>
          </form>
        </div>

        {/* ── Branches ──────────────────────────────────────────────────────── */}
        <div className="card p-5 flex flex-col gap-4">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: 'var(--text-1)' }}>
            <GitBranch style={{ width: 16, height: 16, color: '#34d399' }} />
            الفروع
            <span style={{ marginRight: 'auto', fontSize: 11, color: 'var(--text-3)', fontWeight: 400 }}>
              {branches.length} نشط
            </span>
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {branches.map(b =>
              editBranch?.id === b.id ? (
                <EditForm key={b.id} saving={saving === 'branch-edit'} onSave={saveBranch} onCancel={() => setEditBranch(null)}
                  fields={<>
                    <input className="input text-sm" required placeholder="اسم الفرع" value={editBranch.name}
                      onChange={e => setEditBranch({ ...editBranch, name: e.target.value })} />
                    <input className="input text-sm" placeholder="رقم الهاتف" value={editBranch.phone || ''}
                      onChange={e => setEditBranch({ ...editBranch, phone: e.target.value })} />
                    <input className="input text-sm" placeholder="العنوان" value={editBranch.address || ''}
                      onChange={e => setEditBranch({ ...editBranch, address: e.target.value })} />
                  </>}
                />
              ) : (
                <ItemCard key={b.id} name={b.name} sub={b.company?.name}
                  onEdit={() => setEditBranch({ id: b.id, name: b.name, address: b.address || '', phone: b.phone || '' })}
                  onDelete={() => openArchive('branch', b)}
                />
              )
            )}
          </div>

          <form onSubmit={addBranch} style={{ borderTop: '1px solid var(--border)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)' }}>إضافة فرع جديد</p>
            <select className="input text-sm" required value={newBranch.companyId}
              onChange={e => setNewBranch({ ...newBranch, companyId: e.target.value })}>
              <option value="">-- اختر الشركة --</option>
              {activeCompanies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input className="input text-sm" required placeholder="اسم الفرع" value={newBranch.name}
              onChange={e => setNewBranch({ ...newBranch, name: e.target.value })} />
            <input className="input text-sm" placeholder="العنوان" value={newBranch.address}
              onChange={e => setNewBranch({ ...newBranch, address: e.target.value })} />
            <button type="submit" className="btn-primary w-full justify-center" disabled={saving === 'branch'}>
              {saving === 'branch' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              إضافة فرع
            </button>
          </form>
        </div>

        {/* ── Departments ───────────────────────────────────────────────────── */}
        <div className="card p-5 flex flex-col gap-4">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: 'var(--text-1)' }}>
            <Users style={{ width: 16, height: 16, color: '#a78bfa' }} />
            الأقسام
            <span style={{ marginRight: 'auto', fontSize: 11, color: 'var(--text-3)', fontWeight: 400 }}>
              {departments.length} نشط
            </span>
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {departments.map(d =>
              editDept?.id === d.id ? (
                <EditForm key={d.id} saving={saving === 'dept-edit'} onSave={saveDept} onCancel={() => setEditDept(null)}
                  fields={<>
                    <select className="input text-sm" required value={editDept.branchId}
                      onChange={e => setEditDept({ ...editDept, branchId: e.target.value })}>
                      {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                    <input className="input text-sm" required placeholder="اسم القسم" value={editDept.name}
                      onChange={e => setEditDept({ ...editDept, name: e.target.value })} />
                  </>}
                />
              ) : (
                <ItemCard key={d.id} name={d.name} sub={d.branch?.name}
                  onEdit={() => setEditDept({ id: d.id, name: d.name, branchId: String(d.branchId) })}
                  onDelete={() => openArchive('dept', d)}
                />
              )
            )}
          </div>

          <form onSubmit={addDept} style={{ borderTop: '1px solid var(--border)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)' }}>إضافة قسم جديد</p>
            <select className="input text-sm" required value={newDept.branchId}
              onChange={e => setNewDept({ ...newDept, branchId: e.target.value })}>
              <option value="">-- اختر الفرع --</option>
              {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <input className="input text-sm" required placeholder="اسم القسم" value={newDept.name}
              onChange={e => setNewDept({ ...newDept, name: e.target.value })} />
            <button type="submit" className="btn-primary w-full justify-center" disabled={saving === 'dept'}>
              {saving === 'dept' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              إضافة قسم
            </button>
          </form>
        </div>
      </div>

      {/* Archive confirmation modal */}
      <ArchiveModal
        modal={archiveModal}
        onConfirm={confirmArchive}
        onCancel={() => setArchiveModal(null)}
      />
    </div>
  );
}
