import React, { useEffect, useMemo, useState } from 'react';
import {
  Trash2, Calendar, Database, AlertTriangle, FileSpreadsheet,
  ShieldAlert, CheckCircle2, XCircle, Loader2, History, ChevronLeft,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api, { LONG_OP } from '../lib/api';
import { getSocket } from '../lib/socket';

// Same disabled-auth attribution pattern as RulesPage (ACTOR) — there is no
// real session, so the operator's name is what makes the audit log meaningful.
const DEFAULT_ACTOR = 'مدير النظام';

const STEPS = [
  { id: 1, label: 'الفترة' },
  { id: 2, label: 'البيانات' },
  { id: 3, label: 'المعاينة' },
  { id: 4, label: 'التأكيد' },
  { id: 5, label: 'النتيجة' },
];

const TYPE_DEFS = [
  { key: 'rawLogs', icon: Database, label: 'السجلات الخام (Raw Logs)', desc: 'بصمات الحضور والانصراف الأصلية القادمة من الأجهزة' },
  { key: 'daily',   icon: Calendar, label: 'نتائج الحضور اليومية', desc: 'الأيام المُحتسبة (حضور/غياب/تأخير/إضافي) وأي تعديلات يدوية مرتبطة بها' },
  { key: 'payroll', icon: FileSpreadsheet, label: 'المرتبات والتجميعات الشهرية', desc: 'سجلات الرواتب المحتسبة لكل موظف عن الأشهر المشمولة بالفترة' },
];

function fmtNum(n) { return (n ?? 0).toLocaleString('en-US'); }

export default function DataCleanupPage() {
  const [step, setStep] = useState(1);

  const [form, setForm] = useState({ from: '', to: '', types: { rawLogs: false, daily: false, payroll: false } });
  const [backupFirst, setBackupFirst] = useState(true);
  const [executedByName, setExecutedByName] = useState(DEFAULT_ACTOR);

  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);

  const [confirmText, setConfirmText] = useState('');
  const [confirmCurrentPeriod, setConfirmCurrentPeriod] = useState(false);
  const [confirmFinalizedPayroll, setConfirmFinalizedPayroll] = useState(false);

  const [progress, setProgress] = useState(null);
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState(null);
  const [execError, setExecError] = useState(null);

  const [history, setHistory] = useState([]);

  const anyTypeSelected = form.types.rawLogs || form.types.daily || form.types.payroll;
  const rangeValid = form.from && form.to && form.from <= form.to;

  const loadHistory = async () => {
    try { const { data } = await api.get('/cleanup/logs', { params: { limit: 10 } }); setHistory(data); }
    catch { /* history is a convenience panel — silent on failure */ }
  };
  useEffect(() => { loadHistory(); }, []);

  // Live progress feed during execution (mirrors recalc:start/progress/done usage elsewhere)
  useEffect(() => {
    const socket = getSocket();
    const onStart = (p) => setProgress({ done: 0, total: p.totalSteps, label: 'جارِ البدء…' });
    const onProgress = (p) => setProgress({ done: p.done, total: p.total, label: p.label });
    // Certification HIGH#7: cleanup:done was emitted but never listened to —
    // the executing tab already gets its result from the POST /cleanup/execute
    // HTTP response (see execute() below), but any OTHER tab/window watching
    // this page had no way to learn a cleanup just ran, or see the result (the
    // step-5 result panel is gated on step===5, so setResult alone is not
    // enough — must also advance the step, exactly like execute() does below).
    const onDone = (data) => {
      if (data?.error) { setExecError(data.error); setExecuting(false); return; }
      setResult(data);
      setExecuting(false);
      setStep(5);
    };
    socket.on('cleanup:start', onStart);
    socket.on('cleanup:progress', onProgress);
    socket.on('cleanup:done', onDone);
    return () => {
      socket.off('cleanup:start', onStart);
      socket.off('cleanup:progress', onProgress);
      socket.off('cleanup:done', onDone);
    };
  }, []);

  const toggleType = (key) => setForm(f => ({ ...f, types: { ...f.types, [key]: !f.types[key] } }));

  const runPreview = async () => {
    setPreviewLoading(true); setPreviewError(null); setPreview(null);
    try {
      const { data } = await api.post('/cleanup/preview', { from: form.from, to: form.to, types: form.types }, LONG_OP);
      setPreview(data);
      setConfirmCurrentPeriod(false);
      setConfirmFinalizedPayroll(false);
      setStep(3);
    } catch (err) {
      setPreviewError(err.response?.data?.error || 'فشل تحميل المعاينة');
    } finally { setPreviewLoading(false); }
  };

  const goConfirm = () => {
    setConfirmText('');
    setStep(4);
  };

  const canExecute = useMemo(() => {
    if (confirmText.trim() !== 'حذف') return false;
    if (!executedByName.trim()) return false;
    if (preview?.currentPeriodOverlap && !confirmCurrentPeriod) return false;
    if (preview?.finalizedPayroll?.length && !confirmFinalizedPayroll) return false;
    return true;
  }, [confirmText, executedByName, preview, confirmCurrentPeriod, confirmFinalizedPayroll]);

  const execute = async () => {
    setExecuting(true); setExecError(null); setResult(null); setProgress({ done: 0, total: 1, label: 'جارِ البدء…' });
    try {
      const { data } = await api.post('/cleanup/execute', {
        from: form.from, to: form.to, types: form.types,
        backupFirst, executedByName: executedByName.trim(),
        confirmCurrentPeriod, confirmFinalizedPayroll,
        // EP-019: the backend now requires this — previously only checked
        // client-side to enable/disable the button, never actually sent.
        confirmText: confirmText.trim(),
      }, { timeout: 6 * 60 * 1000 });
      setResult(data);
      setStep(5);
      toast.success('تم تنفيذ عملية التنظيف بنجاح');
      loadHistory();
    } catch (err) {
      const msg = err.response?.data?.error || 'فشل تنفيذ عملية التنظيف';
      setExecError(msg);
      toast.error(msg);
    } finally { setExecuting(false); setProgress(null); }
  };

  const startOver = () => {
    setStep(1); setForm({ from: '', to: '', types: { rawLogs: false, daily: false, payroll: false } });
    setPreview(null); setPreviewError(null); setConfirmText('');
    setConfirmCurrentPeriod(false); setConfirmFinalizedPayroll(false);
    setResult(null); setExecError(null);
  };

  return (
    <div className="flex flex-col gap-4" style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><Trash2 className="w-5 h-5 text-red-400" /> تنظيف الحركات</h1>
          <p className="text-sm text-gray-500 mt-0.5">حذف آمن ومُراجَع للسجلات التشغيلية القديمة (لا يمس بيانات الموظفين أو الإعدادات أو القواعد)</p>
        </div>
      </div>

      {/* Step indicator */}
      <div className="card p-4 flex items-center gap-2">
        {STEPS.map((s, i) => (
          <React.Fragment key={s.id}>
            <div className={`flex-1 flex items-center justify-center gap-2.5 px-4 py-3 rounded-lg text-sm transition-colors ${step === s.id ? 'bg-blue-600/20 text-blue-300 font-bold' : step > s.id ? 'text-emerald-400' : 'text-gray-500'}`}>
              {step > s.id ? <CheckCircle2 className="w-5 h-5" /> : <span className="w-6 h-6 rounded-full border border-current text-sm flex items-center justify-center shrink-0">{s.id}</span>}
              <span className="whitespace-nowrap">{s.label}</span>
            </div>
            {i < STEPS.length - 1 && <ChevronLeft className="w-5 h-5 text-gray-700 shrink-0" />}
          </React.Fragment>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-4 items-start">
        <div className="flex flex-col gap-4 min-w-0">

          {/* Step 1 — Period */}
          {step === 1 && (
            <div className="card p-6 space-y-5">
              <h2 className="font-bold text-gray-200 text-base">اختر الفترة المطلوب تنظيفها</h2>
              <div className="max-w-2xl space-y-5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="label">من تاريخ *</label>
                    <input className="input" type="date" value={form.from} onChange={e => setForm(f => ({ ...f, from: e.target.value }))} />
                  </div>
                  <div>
                    <label className="label">إلى تاريخ *</label>
                    <input className="input" type="date" value={form.to} onChange={e => setForm(f => ({ ...f, to: e.target.value }))} />
                  </div>
                </div>
                {form.from && form.to && form.from > form.to && (
                  <p className="text-xs text-red-400 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> تاريخ البداية يجب أن يسبق تاريخ النهاية</p>
                )}
                <div className="flex justify-start">
                  <button className="btn-primary" disabled={!rangeValid} onClick={() => setStep(2)}>التالي</button>
                </div>
              </div>
            </div>
          )}

          {/* Step 2 — Data type selection */}
          {step === 2 && (
            <div className="card p-6 space-y-5">
              <h2 className="font-bold text-gray-200 text-base">حدد البيانات المراد حذفها</h2>
              <p className="text-xs text-gray-500">يبقى كل شيء آخر (الموظفون، الأقسام، القواعد، الأجهزة، الرواتب الأساسية، الإعدادات) محميًا تمامًا ولا يتأثر بهذه العملية.</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {TYPE_DEFS.map(t => (
                  <label key={t.key} className={`flex items-start gap-3 p-4 rounded-lg border cursor-pointer transition-colors ${form.types[t.key] ? 'border-blue-500/50 bg-blue-600/10' : 'border-gray-800 hover:border-gray-700'}`}>
                    <input type="checkbox" className="mt-1" checked={form.types[t.key]} onChange={() => toggleType(t.key)} />
                    <t.icon className="w-4 h-4 text-gray-400 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-gray-200">{t.label}</p>
                      <p className="text-xs text-gray-500">{t.desc}</p>
                    </div>
                  </label>
                ))}
              </div>
              <div className="flex justify-between">
                <button className="btn-secondary" onClick={() => setStep(1)}>السابق</button>
                <button className="btn-primary" disabled={!anyTypeSelected} onClick={runPreview}>
                  {previewLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null} معاينة الأثر
                </button>
              </div>
              {previewError && <p className="text-xs text-red-400">{previewError}</p>}
            </div>
          )}

          {/* Step 3 — Impact preview */}
          {step === 3 && preview && (
            <div className="card p-6 space-y-5">
              <h2 className="font-bold text-gray-200 text-base">معاينة الأثر — {preview.from} إلى {preview.to}</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-5 gap-3">
                {form.types.rawLogs && (
                  <div className="p-3 rounded-lg bg-gray-800/60"><p className="text-xs text-gray-500">السجلات الخام</p><p className="text-lg font-bold text-gray-100">{fmtNum(preview.counts.rawLogs)}</p></div>
                )}
                {form.types.daily && (
                  <>
                    <div className="p-3 rounded-lg bg-gray-800/60"><p className="text-xs text-gray-500">نتائج يومية</p><p className="text-lg font-bold text-gray-100">{fmtNum(preview.counts.daily)}</p></div>
                    <div className="p-3 rounded-lg bg-gray-800/60"><p className="text-xs text-gray-500">عدد الأيام</p><p className="text-lg font-bold text-gray-100">{fmtNum(preview.daysAffected)}</p></div>
                  </>
                )}
                {form.types.payroll && (
                  <div className="p-3 rounded-lg bg-gray-800/60"><p className="text-xs text-gray-500">سجلات رواتب</p><p className="text-lg font-bold text-gray-100">{fmtNum(preview.counts.payroll)}</p></div>
                )}
                <div className="p-3 rounded-lg bg-gray-800/60"><p className="text-xs text-gray-500">الموظفون المتأثرون</p><p className="text-lg font-bold text-gray-100">{fmtNum(preview.employeesAffected)}</p></div>
              </div>

              {preview.warnings?.length > 0 && (
                <div className="space-y-1.5">
                  {preview.warnings.map((w, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs text-amber-300 bg-amber-900/20 border border-amber-800/40 rounded-lg p-2.5">
                      <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" /> {w}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-start gap-2 text-xs text-red-300 bg-red-900/20 border border-red-800/40 rounded-lg p-2.5">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                هذا الإجراء نهائي ولا يمكن التراجع عنه بعد التنفيذ. سيتم إعادة احتساب الحضور والرواتب تلقائيًا للفترة المتأثرة بعد الحذف.
              </div>

              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={backupFirst} onChange={e => setBackupFirst(e.target.checked)} />
                تنزيل نسخة احتياطية (Excel) من البيانات قبل حذفها
              </label>

              <div className="flex justify-between">
                <button className="btn-secondary" onClick={() => setStep(2)}>السابق</button>
                <button className="btn-primary" onClick={goConfirm}>المتابعة للتأكيد</button>
              </div>
            </div>
          )}

          {/* Step 4 — Confirmation */}
          {step === 4 && preview && (
            <div className="card p-6 space-y-5 border border-red-900/40">
              <h2 className="font-bold text-red-300 flex items-center gap-2"><ShieldAlert className="w-4 h-4" /> تأكيد نهائي قبل الحذف</h2>
              <div className="max-w-2xl space-y-5">
                <p className="text-sm text-gray-400">
                  سيتم حذف <b className="text-gray-200">{fmtNum((preview.counts.rawLogs||0) + (preview.counts.daily||0) + (preview.counts.payroll||0))}</b> سجل
                  من <b className="text-gray-200">{preview.from}</b> إلى <b className="text-gray-200">{preview.to}</b>،
                  يؤثر على <b className="text-gray-200">{fmtNum(preview.employeesAffected)}</b> موظف. هذا الإجراء يتطلب صلاحية مدير النظام.
                </p>

                {preview.currentPeriodOverlap && (
                  <label className="flex items-start gap-2 text-sm text-amber-300 bg-amber-900/20 border border-amber-800/40 rounded-lg p-3">
                    <input type="checkbox" className="mt-1" checked={confirmCurrentPeriod} onChange={e => setConfirmCurrentPeriod(e.target.checked)} />
                    أؤكد أنني أريد حذف بيانات تشمل الشهر الحالي رغم التحذير.
                  </label>
                )}
                {preview.finalizedPayroll?.length > 0 && (
                  <label className="flex items-start gap-2 text-sm text-amber-300 bg-amber-900/20 border border-amber-800/40 rounded-lg p-3">
                    <input type="checkbox" className="mt-1" checked={confirmFinalizedPayroll} onChange={e => setConfirmFinalizedPayroll(e.target.checked)} />
                    أؤكد أنني أريد حذف سجلات رواتب معتمدة/مدفوعة ({preview.finalizedPayroll.length}) رغم التحذير.
                  </label>
                )}

                <div>
                  <label className="label">تنفيذ بواسطة (يُسجَّل في سجل التدقيق) *</label>
                  <input className="input" value={executedByName} onChange={e => setExecutedByName(e.target.value)} placeholder="اسمك" />
                </div>

                <div>
                  <label className="label">للتأكيد، اكتب كلمة <span className="text-red-400 font-bold">حذف</span> في الحقل أدناه *</label>
                  <input className="input" value={confirmText} onChange={e => setConfirmText(e.target.value)} placeholder="حذف" />
                </div>

                {execError && <p className="text-xs text-red-400">{execError}</p>}

                <div className="flex justify-between">
                  <button className="btn-secondary" onClick={() => setStep(3)} disabled={executing}>السابق</button>
                  <button className="btn-danger" disabled={!canExecute || executing} onClick={execute}>
                    {executing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    {executing ? 'جارِ التنفيذ…' : 'تنفيذ الحذف الآن'}
                  </button>
                </div>

                {executing && progress && (
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs text-gray-400">
                      <span>{progress.label || 'جارِ المعالجة…'}</span>
                      <span>{progress.total ? `${progress.done} / ${progress.total}` : ''}</span>
                    </div>
                    <div className="h-2 rounded-full bg-gray-800 overflow-hidden">
                      <div className="h-full bg-blue-500 transition-all" style={{ width: progress.total ? `${Math.min(100, (progress.done / progress.total) * 100)}%` : '10%' }} />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 5 — Result report */}
          {step === 5 && result && (
            <div className="card p-6 space-y-5 border border-emerald-900/40">
              <h2 className="font-bold text-emerald-300 flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> تم تنفيذ عملية التنظيف</h2>
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 text-sm">
                <div className="p-3 rounded-lg bg-gray-800/60"><p className="text-xs text-gray-500">سجلات خام محذوفة</p><p className="font-bold text-gray-100">{fmtNum(result.deleted.rawLogsDeleted)}</p></div>
                <div className="p-3 rounded-lg bg-gray-800/60"><p className="text-xs text-gray-500">نتائج يومية محذوفة</p><p className="font-bold text-gray-100">{fmtNum(result.deleted.dailyDeleted)}</p></div>
                <div className="p-3 rounded-lg bg-gray-800/60"><p className="text-xs text-gray-500">سجلات رواتب محذوفة</p><p className="font-bold text-gray-100">{fmtNum(result.deleted.payrollDeleted)}</p></div>
                <div className="p-3 rounded-lg bg-gray-800/60"><p className="text-xs text-gray-500">الموظفون المتأثرون</p><p className="font-bold text-gray-100">{fmtNum(result.employeesAffected)}</p></div>
                <div className="p-3 rounded-lg bg-gray-800/60"><p className="text-xs text-gray-500">المدة</p><p className="font-bold text-gray-100">{(result.durationMs / 1000).toFixed(1)} ث</p></div>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <span className={`badge-${result.backupFile ? 'green' : 'gray'}`}>{result.backupFile ? '✓' : '✗'} نسخة احتياطية</span>
                <span className={`badge-${result.recalcTriggered ? 'green' : 'gray'}`}>{result.recalcTriggered ? '✓' : '—'} إعادة احتساب</span>
                <span className={`badge-${result.optimizeRun ? 'green' : 'gray'}`}>{result.optimizeRun ? '✓' : '—'} تحسين قاعدة البيانات</span>
              </div>
              {result.backupFile && (
                <a className="btn-secondary inline-flex w-fit" href={`${api.defaults.baseURL}/cleanup/backups/${result.backupFile}`} target="_blank" rel="noreferrer">
                  <FileSpreadsheet className="w-4 h-4" /> تنزيل النسخة الاحتياطية
                </a>
              )}
              {result.consistencyNotes?.length > 0 && (
                <div className="space-y-1">
                  {result.consistencyNotes.map((n, i) => <p key={i} className="text-xs text-amber-300">⚠ {n}</p>)}
                </div>
              )}
              <div className="flex justify-start">
                <button className="btn-primary" onClick={startOver}>عملية تنظيف جديدة</button>
              </div>
            </div>
          )}
          {step === 5 && !result && execError && (
            <div className="card p-6 space-y-3 border border-red-900/40">
              <h2 className="font-bold text-red-300 flex items-center gap-2"><XCircle className="w-4 h-4" /> فشلت العملية</h2>
              <p className="text-sm text-gray-400">{execError}</p>
              <button className="btn-secondary w-fit" onClick={() => setStep(4)}>رجوع</button>
            </div>
          )}

        </div>

        {/* Sidebar — guide + history */}
        <div className="flex flex-col gap-4">
          <div className="card p-5 space-y-3">
            <h2 className="font-bold text-gray-200 flex items-center gap-2 text-sm"><ShieldAlert className="w-4 h-4 text-gray-400" /> خطوات العملية</h2>
            <ol className="text-xs text-gray-500 space-y-2.5 list-decimal list-inside marker:text-gray-600">
              <li>حدد الفترة الزمنية المطلوب تنظيفها.</li>
              <li>اختر نوع البيانات المراد حذفها.</li>
              <li>عاين الأثر المتوقع قبل أي حذف فعلي.</li>
              <li>أكّد الحذف بكتابة «حذف» واسم المنفذ.</li>
              <li>راجع تقرير النتيجة وحمّل النسخة الاحتياطية.</li>
            </ol>
          </div>

          <div className="card p-5">
            <h2 className="font-bold text-gray-200 flex items-center gap-2 mb-3 text-sm"><History className="w-4 h-4 text-gray-400" /> آخر عمليات التنظيف</h2>
            {history.length === 0 ? (
              <p className="text-xs text-gray-600 italic">لا توجد عمليات سابقة</p>
            ) : (
              <div className="space-y-2">
                {history.map(h => (
                  <div key={h.id} className="flex items-center justify-between text-xs py-1.5 border-b border-gray-800/60 last:border-0 gap-2">
                    <div className="min-w-0">
                      <p className="text-gray-300">
                        {new Date(h.fromDate).toLocaleDateString('ar-EG')} → {new Date(h.toDate).toLocaleDateString('ar-EG')}
                        <span className="text-gray-600"> · بواسطة {h.executedByName}</span>
                      </p>
                      <p className="text-gray-600">
                        خام: {fmtNum(h.rawLogsDeleted)} · يومي: {fmtNum(h.dailyDeleted)} · رواتب: {fmtNum(h.payrollDeleted)} · موظفون: {fmtNum(h.employeesAffected)}
                      </p>
                    </div>
                    <span className="text-gray-600 shrink-0">{new Date(h.createdAt).toLocaleString('ar-EG')}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
