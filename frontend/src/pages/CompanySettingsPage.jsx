import React, { useEffect, useRef, useState } from 'react';
import { Building2, Image as ImageIcon, Printer, Save, Loader2, Upload, Trash2, CheckCircle2, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import useCompanySettingsStore, { resolveCompanyAssetUrl } from '../store/companySettingsStore';

// No login/auth in this desktop app — every change is recorded under this
// actor name (same no-auth convention `rules.js` already uses for its audit trail).
const ACTOR = 'مستخدم النظام';

// Each image plays a different visual role across the app (a square sidebar
// tile vs. a wide print banner), so its preview box, recommended dimensions,
// and quality bar are tuned per-field instead of one generic 72×72 square.
const IMAGE_FIELDS = [
  { field: 'logo',            key: 'logo_url',             label: 'شعار الشركة (Logo)',     hint: 'يظهر في الشريط الجانبي والتقارير وكشوف المرتبات', box: { w: 96, h: 96 },   recommended: { w: 512, h: 512 } },
  { field: 'loginBackground', key: 'login_background_url', label: 'خلفية شاشة البدء',        hint: 'تظهر في شاشة بدء التشغيل (Splash)',              box: { w: 168, h: 96 },  recommended: { w: 1920, h: 1080 } },
  { field: 'stamp',           key: 'stamp_url',            label: 'ختم الشركة',              hint: 'يُستخدم في مستندات الطباعة الرسمية',              box: { w: 96, h: 96 },   recommended: { w: 400, h: 400 } },
  { field: 'printHeader',     key: 'print_header_url',     label: 'رأس صفحة الطباعة',        hint: 'صورة رأس مخصصة للتقارير المطبوعة',                box: { w: 220, h: 62 },  recommended: { w: 1200, h: 300 } },
];

function ImageUploader({ field, settingKey, label, hint, value, box, recommended, onUpload, onDelete }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [natural, setNatural] = useState(null); // {w,h} of the currently-displayed image, once loaded
  const url = resolveCompanyAssetUrl(value);

  // Reset the measured size whenever the underlying image changes (new
  // upload/delete) so a stale quality readout never lingers on screen.
  useEffect(() => { setNatural(null); }, [url]);

  const pick = () => inputRef.current?.click();

  const handleChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      await onUpload(field, file, ACTOR);
      toast.success('تم رفع الصورة');
    } catch (err) {
      toast.error(err?.response?.data?.error || 'فشل رفع الصورة');
    } finally { setBusy(false); }
  };

  const handleDelete = async () => {
    setBusy(true);
    try {
      await onDelete(field, ACTOR);
      toast.success('تم حذف الصورة');
    } catch {
      toast.error('فشل حذف الصورة');
    } finally { setBusy(false); }
  };

  // Quality bands — measured against the recommended dimensions for THIS
  // field (a logo and a wide print banner have very different "good enough"
  // thresholds, so this is relative, never a fixed pixel count).
  const ratio = natural ? Math.min(natural.w / recommended.w, natural.h / recommended.h) : null;
  const quality = ratio == null ? null : ratio >= 0.9 ? 'good' : ratio >= 0.5 ? 'ok' : 'low';
  const QUALITY = {
    good: { label: 'جودة ممتازة', color: '#22c55e', Icon: CheckCircle2 },
    ok:   { label: 'جودة مقبولة — يُفضّل رفع صورة أعلى دقة', color: '#f59e0b', Icon: AlertTriangle },
    low:  { label: 'دقة منخفضة — قد تظهر غير واضحة عند الطباعة', color: '#ef4444', Icon: AlertTriangle },
  };

  return (
    <div className="card p-4" style={{ display:'flex', gap:14, alignItems:'center' }}>
      <div style={{
        width:box.w, height:box.h, borderRadius:10, flexShrink:0, overflow:'hidden',
        background: url ? '#0f172a' : 'rgba(148,163,184,0.12)',
        border:'1px solid var(--border)',
        display:'flex', alignItems:'center', justifyContent:'center',
      }}>
        {url
          ? <img src={url} alt={label} style={{ width:'100%', height:'100%', objectFit:'contain' }}
              onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
          : <ImageIcon className="w-6 h-6 text-gray-500" />}
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <p className="text-sm font-medium text-gray-200">{label}</p>
        <p className="text-xs text-gray-500 mt-0.5">{hint}</p>
        <p className="text-xs text-gray-600 mt-1">
          المقاس الموصى به: {recommended.w}×{recommended.h}px
          {natural && <span className="text-gray-500"> · الحالي: {natural.w}×{natural.h}px</span>}
        </p>
        {quality && (
          <p style={{ display:'flex', alignItems:'center', gap:5, fontSize:11, fontWeight:600, color:QUALITY[quality].color, marginTop:3 }}>
            {React.createElement(QUALITY[quality].Icon, { style:{ width:12, height:12 } })}
            {QUALITY[quality].label}
          </p>
        )}
        <div style={{ display:'flex', gap:8, marginTop:8 }}>
          <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" style={{ display:'none' }} onChange={handleChange} />
          <button type="button" className="btn-secondary text-xs" onClick={pick} disabled={busy}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            {url ? 'استبدال' : 'رفع صورة'}
          </button>
          {url && (
            <button type="button" className="btn-secondary text-xs" style={{ color:'#f87171' }} onClick={handleDelete} disabled={busy}>
              <Trash2 className="w-3.5 h-3.5" /> حذف
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function CompanySettingsPage() {
  const { settings, loading, fetch: fetchSettings, update, uploadImage, deleteImage } = useCompanySettingsStore();
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState('');

  useEffect(() => { fetchSettings(); }, []);

  // Sync local form state whenever the live store updates (e.g. another window edits)
  useEffect(() => { setForm(settings || {}); }, [settings]);

  const setField = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const saveSection = async (keys, label) => {
    setSaving(label);
    try {
      const partial = {};
      for (const k of keys) partial[k] = form[k] ?? '';
      await update(partial, ACTOR);
      toast.success('تم حفظ التغييرات — تنعكس فورًا في كل الشاشات');
    } catch {
      toast.error('فشل الحفظ');
    } finally { setSaving(''); }
  };

  return (
    <div className="flex flex-col gap-6" style={{ flex:1, overflow:'auto', minHeight:0 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">بيانات الشركة</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            هوية النظام بالكامل — الاسم، الشعار، بيانات التواصل، وإعدادات الطباعة. أي تعديل ينعكس فورًا
            في الشريط الجانبي والتقارير والطباعة وكشوف المرتبات دون إعادة تشغيل البرنامج.
          </p>
        </div>
        {loading && <Loader2 className="w-5 h-5 animate-spin text-gray-400" />}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* ── الهوية ─────────────────────────────────────────────────────── */}
        <div className="card p-5">
          <h3 className="section-title mb-4 flex items-center gap-2">
            <Building2 className="w-5 h-5 text-blue-400" /> الهوية والتواصل
          </h3>
          <div className="space-y-2">
            <label className="text-xs text-gray-500">اسم الشركة (عربي)</label>
            <input className="input text-sm" value={form.company_name_ar || ''} onChange={e => setField('company_name_ar', e.target.value)} />
            <label className="text-xs text-gray-500">اسم الشركة (إنجليزي)</label>
            <input className="input text-sm" dir="ltr" value={form.company_name_en || ''} onChange={e => setField('company_name_en', e.target.value)} />
            <label className="text-xs text-gray-500">وصف الشركة</label>
            <textarea className="input text-sm" rows={2} value={form.company_description || ''} onChange={e => setField('company_description', e.target.value)} />
            <label className="text-xs text-gray-500">العنوان</label>
            <input className="input text-sm" value={form.company_address || ''} onChange={e => setField('company_address', e.target.value)} />
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-gray-500">رقم الهاتف</label>
                <input className="input text-sm" dir="ltr" value={form.company_phone || ''} onChange={e => setField('company_phone', e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-gray-500">البريد الإلكتروني</label>
                <input className="input text-sm" dir="ltr" value={form.company_email || ''} onChange={e => setField('company_email', e.target.value)} />
              </div>
            </div>
            <button
              type="button" className="btn-primary w-full justify-center mt-2"
              disabled={saving === 'identity'}
              onClick={() => saveSection(['company_name_ar', 'company_name_en', 'company_description', 'company_address', 'company_phone', 'company_email'], 'identity')}
            >
              {saving === 'identity' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              حفظ بيانات الشركة
            </button>
          </div>
        </div>

        {/* ── الشعار والصور ──────────────────────────────────────────────── */}
        <div className="card p-5">
          <h3 className="section-title mb-4 flex items-center gap-2">
            <ImageIcon className="w-5 h-5 text-purple-400" /> الشعار والصور
          </h3>
          <div className="space-y-3">
            {IMAGE_FIELDS.map(f => (
              <ImageUploader
                key={f.field}
                field={f.field}
                settingKey={f.key}
                label={f.label}
                hint={f.hint}
                box={f.box}
                recommended={f.recommended}
                value={settings?.[f.key]}
                onUpload={uploadImage}
                onDelete={deleteImage}
              />
            ))}
          </div>
        </div>

        {/* ── إعدادات الطباعة ────────────────────────────────────────────── */}
        <div className="card p-5 lg:col-span-2">
          <h3 className="section-title mb-4 flex items-center gap-2">
            <Printer className="w-5 h-5 text-green-400" /> إعدادات الطباعة
          </h3>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <div className="space-y-2">
              <label className="text-xs text-gray-500">نص رأس الطباعة</label>
              <textarea className="input text-sm" rows={3} value={form.print_header_text || ''} onChange={e => setField('print_header_text', e.target.value)} placeholder="نص يظهر أعلى المستندات المطبوعة (اختياري — بجانب صورة الرأس)" />
            </div>
            <div className="space-y-2">
              <label className="text-xs text-gray-500">نص تذييل الطباعة</label>
              <textarea className="input text-sm" rows={3} value={form.print_footer_text || ''} onChange={e => setField('print_footer_text', e.target.value)} placeholder="مثال: © الشركة — جميع الحقوق محفوظة" />
            </div>
            <div className="space-y-2">
              <label className="text-xs text-gray-500">بيانات التواصل أسفل التقارير</label>
              <textarea className="input text-sm" rows={3} value={form.print_contact_text || ''} onChange={e => setField('print_contact_text', e.target.value)} placeholder="العنوان · الهاتف · البريد الإلكتروني" />
            </div>
          </div>
          <button
            type="button" className="btn-primary w-full justify-center mt-3"
            disabled={saving === 'print'}
            onClick={() => saveSection(['print_header_text', 'print_footer_text', 'print_contact_text'], 'print')}
          >
            {saving === 'print' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            حفظ إعدادات الطباعة
          </button>
        </div>
      </div>
    </div>
  );
}
