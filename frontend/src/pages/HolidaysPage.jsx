import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Calendar, X, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { MONTHS_AR } from '../lib/constants';

export default function HolidaysPage() {
  const [holidays, setHolidays] = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [year,     setYear]     = useState(new Date().getFullYear());
  const [modal,    setModal]    = useState(false);
  const [form,     setForm]     = useState({ name:'', date:'', type:'public' });
  const [saving,   setSaving]   = useState(false);

  const load = async () => {
    setLoading(true);
    try { const { data } = await api.get('/holidays', { params: { year } }); setHolidays(data); }
    catch { toast.error('فشل التحميل'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [year]);

  const save = async (e) => {
    e.preventDefault(); setSaving(true);
    try {
      await api.post('/holidays', form);
      toast.success('تم إضافة الإجازة');
      setModal(false); setForm({ name:'', date:'', type:'public' }); load();
    } catch { toast.error('فشل الحفظ'); }
    finally { setSaving(false); }
  };

  const del = async (id) => {
    if (!confirm('هل تريد حذف هذه الإجازة؟')) return;
    try { await api.delete(`/holidays/${id}`); toast.success('تم الحذف'); load(); }
    catch { toast.error('فشل الحذف'); }
  };

  const byMonth = {};
  holidays.forEach(h => {
    const m = new Date(h.date).getMonth();
    if (!byMonth[m]) byMonth[m] = [];
    byMonth[m].push(h);
  });

  return (
    <div className="flex flex-col gap-4" style={{ flex:1, overflow:'auto', minHeight:0 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">الإجازات الرسمية</h1>
          <p className="text-sm text-gray-500 mt-0.5">{holidays.length} إجازة في {year}</p>
        </div>
        <div className="flex items-center gap-2">
          <select className="input w-auto text-sm" value={year} onChange={e => setYear(parseInt(e.target.value))}>
            {[2024,2025,2026,2027].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <button className="btn-primary" onClick={() => setModal(true)}>
            <Plus className="w-4 h-4" /> إضافة إجازة
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {MONTHS_AR.map((month, idx) => {
          const mh = byMonth[idx] || [];
          return (
            <div key={idx} className="card p-4">
              <h3 className="font-bold text-gray-200 text-sm mb-3 flex items-center gap-2">
                <Calendar className="w-4 h-4 text-blue-400" />
                {month}
                {mh.length > 0 && <span className="badge-blue text-xs">{mh.length}</span>}
              </h3>
              {mh.length === 0
                ? <p className="text-xs text-gray-700 italic">لا توجد إجازات</p>
                : mh.map(h => (
                  <div key={h.id} className="flex items-center justify-between group py-1.5">
                    <div>
                      <p className="text-sm font-medium text-gray-200">{h.name}</p>
                      <p className="text-xs text-gray-500">
                        {new Date(h.date).toLocaleDateString('ar-EG', { weekday: 'short', day: 'numeric' })}
                      </p>
                    </div>
                    <button
                      onClick={() => del(h.id)}
                      className="opacity-0 group-hover:opacity-100 btn-ghost p-1.5 rounded text-red-400 hover:text-red-300 hover:bg-red-900/20"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              }
            </div>
          );
        })}
      </div>

      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" dir="rtl">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setModal(false)} />
          <div className="relative bg-gray-900 rounded-xl shadow-2xl border border-gray-800 w-full max-w-sm">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
              <h2 className="font-bold text-white">إضافة إجازة رسمية</h2>
              <button onClick={() => setModal(false)} className="btn-ghost p-2 rounded-lg"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={save} className="p-5 space-y-4">
              <div>
                <label className="label">اسم الإجازة *</label>
                <input className="input" required value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="مثال: اليوم الوطني" />
              </div>
              <div>
                <label className="label">التاريخ *</label>
                <input className="input" type="date" required value={form.date} onChange={e => setForm({...form, date: e.target.value})} />
              </div>
              <div>
                <label className="label">النوع</label>
                <select className="input" value={form.type} onChange={e => setForm({...form, type: e.target.value})}>
                  <option value="public">إجازة رسمية عامة</option>
                  <option value="company">إجازة شركة</option>
                </select>
              </div>
              <div className="flex justify-start gap-2 pt-2">
                <button type="submit" className="btn-primary" disabled={saving}>
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null} إضافة
                </button>
                <button type="button" onClick={() => setModal(false)} className="btn-secondary">إلغاء</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
