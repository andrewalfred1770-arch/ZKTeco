/**
 * RuleDrawer — Business-friendly rule editor (HR / accounting first).
 *
 * Design goals (PETSHROW "simple but powerful"):
 *  • Clean tabbed layout — البيانات الأساسية · الحسابات · إعدادات التنفيذ · السجل
 *  • Excel-style VISUAL formula builder — users click fields & operators,
 *    they never type variable names. Live calculation preview.
 *  • Plain-Arabic labels, tooltips on every option, smart defaults.
 *  • Internally still stores the canonical formula string the engine expects.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Save, Loader2, Info, Calculator, Sliders,
  FileText, History, Delete, RotateCcw, Clock3,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';

// ── Shared Exports (consumed by RulesPage) ────────────────────────────────────
export const CATEGORY_LABELS = {
  attendance:  'الحضور',      overtime:   'الإضافي',
  deductions:  'الخصومات',    payroll:    'المرتبات',
  leaves:      'الإجازات',    penalties:  'الجزاءات',
  shifts:      'الورديات',    holidays:   'العطلات',
};
export const CAT_COLOR = {
  attendance:'#2563eb', overtime:'#7c3aed', deductions:'#b42318',
  payroll:'#15803d',    leaves:'#0891b2',   penalties:'#c2410c',
  shifts:'#6d28d9',     holidays:'#a16207',
};
export const TYPE_LABELS = {
  number:'رقم',  percentage:'نسبة %',  boolean:'مفعّل/موقوف',
  time:'وقت',    text:'نص',            formula:'معادلة',
};
export const TYPE_ICONS = {
  number:'#',  percentage:'%',  boolean:'⊤',  time:'⏱',
  text:'Aب',   formula:'ƒ',
};

// Friendly one-line explanation of each rule TYPE (shown under the picker)
const TYPE_HELP = {
  number:    'قيمة رقمية ثابتة (مثل: عدد أيام).',
  percentage:'نسبة مئوية تُطبَّق على مبلغ.',
  boolean:   'تشغيل أو إيقاف خيار (نعم / لا).',
  time:      'قيمة زمنية بصيغة ساعة:دقيقة.',
  text:      'نص حر.',
  formula:   'معادلة حسابية تُبنى بصريًا من الحقول.',
};

// ═══ Visual formula builder vocabulary ════════════════════════════════════════
// key = canonical variable stored in the formula string (engine-compatible)
// ar  = business label shown to the user · sample = value used in live preview
const VARS = [
  { key:'salary',                 ar:'الراتب الأساسي',     sample:6000 },
  { key:'working_days_per_month', ar:'أيام العمل بالشهر',  sample:26   },
  { key:'month_days',             ar:'أيام الشهر',         sample:30   },
  { key:'work_hours_per_day',     ar:'ساعات العمل باليوم', sample:8    },
  { key:'day_rate',               ar:'أجر اليوم',          sample:230  },
  { key:'hourly_rate',            ar:'أجر الساعة',         sample:28.8 },
  { key:'overtime_hours',         ar:'ساعات الإضافي',      sample:10   },
  { key:'overtime_rate',          ar:'معامل الإضافي',      sample:1.5  },
  { key:'bonus',                  ar:'المكافأة',           sample:500  },
  { key:'deductions',             ar:'الجزاءات والخصومات', sample:200  },
  { key:'absent_days',            ar:'أيام الغياب',        sample:2    },
];
const VAR_MAP = Object.fromEntries(VARS.map(v => [v.key, v]));
// Display symbol ⇄ stored operator
const OPS = [
  { sym:'+', store:'+' }, { sym:'−', store:'-' },
  { sym:'×', store:'*' }, { sym:'÷', store:'/' },
  { sym:'%', store:'%' },
];
const SYM_OF   = { '+':'+', '-':'−', '*':'×', '/':'÷', '%':'%' };

// Parse a stored formula string → token array for the builder
function parseFormula(str) {
  if (!str) return [];
  const out = [];
  // split into words / operators / parens / numbers
  const re = /([A-Za-z_][A-Za-z0-9_]*)|(\d+(?:\.\d+)?)|([+\-*/%()])/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    if (m[1]) out.push({ t:'var', v:m[1] });
    else if (m[2]) out.push({ t:'num', v:m[2] });
    else if (m[3]) {
      if (m[3] === '(' || m[3] === ')') out.push({ t:'paren', v:m[3] });
      else out.push({ t:'op', v:m[3] });
    }
  }
  return out;
}
// Tokens → canonical stored string
function serializeFormula(tokens) {
  return tokens.map(t => t.v).join(' ').replace(/\(\s/g,'(').replace(/\s\)/g,')').trim();
}
// Tokens → live numeric preview (safe: only numbers + arithmetic)
function previewFormula(tokens) {
  if (!tokens.length) return null;
  try {
    const expr = tokens.map(t => {
      if (t.t === 'var') return String(VAR_MAP[t.v]?.sample ?? 0);
      if (t.t === 'op')  return t.v === '%' ? '/100*' : t.v; // best-effort %
      return t.v;
    }).join(' ');
    if (!/^[-+*/%(). 0-9]+$/.test(expr)) return null;
    // eslint-disable-next-line no-new-func
    const r = Function(`"use strict";return (${expr.replace(/%/g,'/100*')})`)();
    if (!isFinite(r)) return null;
    return Math.round(r * 100) / 100;
  } catch { return null; }
}

// ── Toggle Switch ──────────────────────────────────────────────────────────────
function Toggle({ checked, onChange }) {
  return (
    <button type="button" onClick={() => onChange(!checked)}
      style={{ width:46, height:26, borderRadius:13, border:'none', cursor:'pointer', padding:3,
        background: checked ? '#16a34a' : 'var(--input-b)', transition:'background .2s', flexShrink:0 }}>
      <div style={{ width:20, height:20, borderRadius:10, background:'#fff', transition:'transform .2s',
        transform: checked ? 'translateX(-20px)' : 'translateX(0px)' }} />
    </button>
  );
}

// ── Field wrapper (label + optional help tooltip) ──────────────────────────────
function Field({ label, children, grow, hint }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:6, flex:grow ? 1 : 'unset', minWidth:0 }}>
      {label && (
        <div style={{ display:'flex', alignItems:'center', gap:5 }}>
          <label style={{ fontSize:12.5, fontWeight:700, color:'var(--text-2)' }}>{label}</label>
          {hint && (
            <span title={hint} style={{ display:'inline-flex', cursor:'help' }}>
              <Info style={{ width:13, height:13, color:'var(--accent)', opacity:.75 }} />
            </span>
          )}
        </div>
      )}
      {children}
      {hint && <span style={{ fontSize:11, color:'var(--text-3)', lineHeight:1.5 }}>{hint}</span>}
    </div>
  );
}

// Shown instead of raw formula expressions for normal HR users — that logic
// stays intact, it's just edited from "إعدادات متقدمة" only.
function AdvancedOnlyNotice() {
  return (
    <div style={{ display:'flex', alignItems:'flex-start', gap:10, padding:'12px 14px',
      borderRadius:9, background:'rgba(124,58,237,.08)', border:'1px solid rgba(124,58,237,.25)' }}>
      <Sliders style={{ width:16, height:16, color:'#7c3aed', flexShrink:0, marginTop:2 }} />
      <span style={{ fontSize:12.5, color:'var(--text-2)', lineHeight:1.6 }}>
        هذه القاعدة تعتمد على منطق حسابي متقدّم. لعرضه أو تعديله،
        فعّل <b style={{ color:'#7c3aed' }}>«إعدادات متقدمة»</b> من أعلى شاشة القواعد.
      </span>
    </div>
  );
}

// ── Card wrapper for a logical group inside a tab ──────────────────────────────
function Card({ title, icon:Icon, children, accent='var(--accent)' }) {
  return (
    <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:10, overflow:'hidden' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 14px',
        borderBottom:'1px solid var(--border)', background:'var(--surface-2)' }}>
        {Icon && <Icon style={{ width:15, height:15, color:accent }} />}
        <span style={{ fontSize:12.5, fontWeight:800, color:'var(--text)' }}>{title}</span>
      </div>
      <div style={{ padding:'14px', display:'flex', flexDirection:'column', gap:14 }}>{children}</div>
    </div>
  );
}

// ═══ Visual Formula Builder ════════════════════════════════════════════════════
function FormulaBuilder({ value, onChange }) {
  const [tokens, setTokens] = useState(() => parseFormula(value));
  const [num, setNum] = useState('');

  // keep parent's canonical string in sync
  useEffect(() => { onChange(serializeFormula(tokens)); }, [tokens]); // eslint-disable-line

  const push   = (tok) => setTokens(t => [...t, tok]);
  const pop    = () => setTokens(t => t.slice(0, -1));
  const clear  = () => setTokens([]);
  const addNum = () => { const n = num.trim(); if (n !== '' && !isNaN(Number(n))) { push({ t:'num', v:n }); setNum(''); } };

  const preview = previewFormula(tokens);

  const chipStyle = (t) => {
    if (t.t === 'var')   return { bg:'var(--accent-soft)', color:'var(--accent)', bd:'var(--accent)' };
    if (t.t === 'op')    return { bg:'rgba(245,158,11,0.12)', color:'#d97706', bd:'#f59e0b' };
    if (t.t === 'paren') return { bg:'var(--surface-2)', color:'var(--text-2)', bd:'var(--border)' };
    return { bg:'rgba(22,163,74,0.10)', color:'#16a34a', bd:'#16a34a' };
  };
  const chipLabel = (t) => t.t === 'var' ? (VAR_MAP[t.v]?.ar || t.v) : (t.t === 'op' ? SYM_OF[t.v] : t.v);

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
      {/* Live formula canvas */}
      <div style={{ minHeight:54, borderRadius:9, border:'1.5px dashed var(--accent)',
        background:'var(--accent-soft)', padding:'10px 12px', display:'flex', flexWrap:'wrap',
        gap:6, alignItems:'center' }}>
        {tokens.length === 0 && (
          <span style={{ fontSize:12.5, color:'var(--text-3)' }}>
            اضغط على حقل أو عملية بالأسفل لبناء المعادلة… (بدون كتابة)
          </span>
        )}
        {tokens.map((t, i) => {
          const c = chipStyle(t);
          return (
            <span key={i} style={{ display:'inline-flex', alignItems:'center',
              padding: t.t === 'paren' ? '4px 8px' : '4px 10px',
              borderRadius:7, fontSize: t.t === 'op' ? 15 : 12.5, fontWeight:700,
              background:c.bg, color:c.color, border:`1px solid ${c.bd}55`,
              fontFamily: t.t === 'var' ? 'Cairo,sans-serif' : 'inherit' }}>
              {chipLabel(t)}
            </span>
          );
        })}
      </div>

      {/* Live preview */}
      <div style={{ display:'flex', alignItems:'center', gap:8, fontSize:12.5,
        padding:'8px 12px', borderRadius:8, background:'var(--surface-2)', border:'1px solid var(--border)' }}>
        <Calculator style={{ width:14, height:14, color:'var(--accent)' }} />
        <span style={{ color:'var(--text-2)', fontWeight:600 }}>معاينة مباشرة (بقيم تجريبية):</span>
        <span style={{ marginInlineStart:'auto', fontFamily:'Consolas,monospace', fontWeight:800,
          fontSize:14, color: preview == null ? 'var(--text-3)' : '#16a34a' }}>
          {preview == null ? '—' : preview.toLocaleString('en-US')}
        </span>
      </div>

      {/* Variable picker */}
      <Field label="الحقول — اضغط لإضافتها">
        <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
          {VARS.map(v => (
            <button key={v.key} type="button" onClick={() => push({ t:'var', v:v.key })}
              title={`قيمة تجريبية: ${v.sample}`}
              style={{ padding:'6px 11px', borderRadius:7, border:'1px solid var(--accent)44',
                background:'var(--accent-soft)', color:'var(--accent)', fontSize:12, fontWeight:700,
                fontFamily:'Cairo,sans-serif', cursor:'pointer' }}>
              {v.ar}
            </button>
          ))}
        </div>
      </Field>

      {/* Operators + number + edit controls */}
      <div style={{ display:'flex', flexWrap:'wrap', gap:6, alignItems:'center' }}>
        {OPS.map(o => (
          <button key={o.store} type="button" onClick={() => push({ t:'op', v:o.store })}
            style={{ width:38, height:34, borderRadius:7, border:'1px solid #f59e0b55',
              background:'rgba(245,158,11,0.10)', color:'#d97706', fontSize:17, fontWeight:800, cursor:'pointer' }}>
            {o.sym}
          </button>
        ))}
        {['(',')'].map(p => (
          <button key={p} type="button" onClick={() => push({ t:'paren', v:p })}
            style={{ width:34, height:34, borderRadius:7, border:'1px solid var(--border)',
              background:'var(--surface-2)', color:'var(--text-2)', fontSize:16, fontWeight:800, cursor:'pointer' }}>
            {p}
          </button>
        ))}
        <input value={num} onChange={e => setNum(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addNum(); } }}
          placeholder="رقم" inputMode="decimal"
          style={{ width:72, height:34, borderRadius:7, border:'1px solid var(--border)',
            background:'var(--input-bg)', color:'var(--text)', padding:'0 10px',
            fontFamily:'Consolas,monospace', fontSize:13, textAlign:'center' }} />
        <button type="button" onClick={addNum}
          style={{ height:34, padding:'0 12px', borderRadius:7, border:'1px solid #16a34a55',
            background:'rgba(22,163,74,0.10)', color:'#16a34a', fontSize:12, fontWeight:700, cursor:'pointer' }}>
          إضافة رقم
        </button>
        <div style={{ marginInlineStart:'auto', display:'flex', gap:6 }}>
          <button type="button" onClick={pop} disabled={!tokens.length} title="تراجع"
            style={{ height:34, padding:'0 10px', borderRadius:7, border:'1px solid var(--border)',
              background:'var(--surface)', color:'var(--text-2)', cursor:'pointer',
              display:'flex', alignItems:'center', gap:5, fontSize:12, opacity: tokens.length ? 1 : .5 }}>
            <Delete style={{ width:14, height:14 }} /> تراجع
          </button>
          <button type="button" onClick={clear} disabled={!tokens.length} title="مسح"
            style={{ height:34, padding:'0 10px', borderRadius:7, border:'1px solid #ef444455',
              background:'rgba(239,68,68,0.08)', color:'#ef4444', cursor:'pointer',
              display:'flex', alignItems:'center', gap:5, fontSize:12, opacity: tokens.length ? 1 : .5 }}>
            <RotateCcw style={{ width:14, height:14 }} /> مسح
          </button>
        </div>
      </div>
    </div>
  );
}

const CATS  = Object.keys(CATEGORY_LABELS);
const TYPES = Object.keys(TYPE_LABELS);
const TABS  = [
  { id:'basic', label:'البيانات الأساسية', icon:FileText  },
  { id:'calc',  label:'الحسابات',          icon:Calculator},
  { id:'exec',  label:'إعدادات التنفيذ',   icon:Sliders   },
  { id:'log',   label:'السجل',             icon:History   },
];

// ── Main Component ───────────────────────────────────────────────────────────
export default function RuleDrawer({ rule, actor, advanced = false, onClose, onSaved }) {
  const isEdit = !!rule?.id;

  const [tab, setTab] = useState('basic');
  const [form, setForm] = useState({
    name:       rule?.name        || '',
    key:        rule?.key         || '',
    category:   rule?.category    || 'attendance',
    type:       rule?.type        || 'number',
    value:      rule?.value       ?? '',
    unit:       rule?.unit        || '',
    priority:   rule?.priority    ?? 0,
    appliesTo:  rule?.appliesTo   || 'all',
    isActive:   rule?.isActive    ?? true,
    description:rule?.description || '',
  });
  const [saving, setSaving] = useState(false);
  const [audit, setAudit]   = useState(null);

  // HR users only choose from plain value types — "معادلة" needs the visual
  // builder and stays reserved for "إعدادات متقدمة" (existing rules of this
  // type still display correctly so nothing breaks when editing them).
  const visibleTypes = advanced
    ? TYPES
    : TYPES.filter(t => t !== 'formula' || t === form.type);

  const set = useCallback((k, v) => setForm(p => ({ ...p, [k]: v })), []);

  // Auto-generate key from name (create only)
  const handleNameChange = (v) => {
    set('name', v);
    if (!isEdit && !form.key.trim()) {
      set('key', v.trim().toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'').slice(0,50));
    }
  };

  // Lazy-load audit timeline when opening the السجل tab
  useEffect(() => {
    if (tab === 'log' && isEdit && audit == null) {
      api.get(`/rules/${rule.id}/audit`).then(r => setAudit(r.data || [])).catch(() => setAudit([]));
    }
  }, [tab, isEdit, rule, audit]);

  const save = async () => {
    if (!form.name.trim()) { toast.error('اسم القاعدة مطلوب'); setTab('basic'); return; }
    if (!form.key.trim())  { toast.error('المفتاح مطلوب');     setTab('basic'); return; }
    setSaving(true);
    const payload = {
      ...form,
      priority: parseInt(form.priority) || 0,
      changedByName: actor,
    };
    try {
      if (isEdit) await api.put(`/rules/${rule.id}`, payload);
      else        await api.post('/rules', payload);
      toast.success(isEdit ? 'تم حفظ التعديلات' : 'تم إنشاء القاعدة بنجاح');
      onSaved();
    } catch (err) {
      toast.error(err.response?.data?.error || 'فشل الحفظ');
    } finally { setSaving(false); }
  };

  const catColor = CAT_COLOR[form.category] || '#2563eb';

  // ── value editor for the الحسابات tab ───────────────────────────────────────
  const valueEditor = () => {
    switch (form.type) {
      case 'time':
        return (
          <Field label="القيمة الزمنية" hint="تُدخَل بصيغة ساعة:دقيقة — مثال 02:30 تعني ساعتان ونصف.">
            <input type="time" className="input w-full"
              style={{ fontFamily:'Consolas,monospace', fontSize:16, letterSpacing:2 }}
              value={form.value} onChange={e => set('value', e.target.value)} />
          </Field>
        );
      case 'boolean':
        return (
          <Field label="الحالة" hint="تشغيل أو إيقاف هذا الخيار.">
            <div style={{ display:'flex', alignItems:'center', gap:12 }}>
              <Toggle checked={String(form.value) === 'true'} onChange={v => set('value', String(v))} />
              <span style={{ fontSize:13.5, fontWeight:700, color:'var(--text)' }}>
                {String(form.value) === 'true' ? 'نعم — مفعّل' : 'لا — موقوف'}
              </span>
            </div>
          </Field>
        );
      case 'percentage':
        return (
          <Field label="النسبة المئوية" hint="مثال: 150 تعني صرف الإضافي بمعدّل مرة ونصف.">
            <div style={{ display:'flex', alignItems:'center', border:'1px solid var(--input-b)',
              borderRadius:7, overflow:'hidden', background:'var(--input-bg)' }}>
              <input type="number" step="0.1" min="0"
                style={{ flex:1, background:'transparent', border:'none', outline:'none', padding:'10px 12px',
                  fontFamily:'Consolas,monospace', fontSize:15, color:'var(--text)' }}
                value={form.value} onChange={e => set('value', e.target.value)} />
              <span style={{ padding:'0 14px', alignSelf:'stretch', display:'flex', alignItems:'center',
                background:'var(--surface-2)', borderInlineStart:'1px solid var(--border)',
                color:'var(--text-2)', fontSize:14, fontWeight:800 }}>%</span>
            </div>
          </Field>
        );
      case 'formula':
        return advanced ? (
          <Field label="المعادلة" hint="ابنِها بالضغط على الحقول والعمليات — لا حاجة لكتابة أي كود.">
            <FormulaBuilder value={form.value} onChange={v => set('value', v)} />
          </Field>
        ) : <AdvancedOnlyNotice />;
      default:
        return (
          <Field label="القيمة" hint={form.type === 'number' ? 'قيمة رقمية.' : 'نص حر.'}>
            <input type={form.type === 'number' ? 'number' : 'text'} step="any"
              className="input w-full" style={{ fontFamily: form.type==='number' ? 'Consolas,monospace' : 'inherit', fontSize:14 }}
              value={form.value} onChange={e => set('value', e.target.value)} />
          </Field>
        );
    }
  };

  return (
    <>
      <div onClick={onClose} style={{ position:'fixed', inset:0, zIndex:60,
        background:'rgba(0,0,0,0.55)', backdropFilter:'blur(3px)' }} />

      <div dir="rtl" style={{
        position:'fixed', top:0, bottom:0, left:0, zIndex:70, width:'min(560px,100vw)',
        background:'var(--bg)', borderRight:'1px solid var(--border)',
        boxShadow:'-8px 0 48px rgba(0,0,0,.4)', display:'flex', flexDirection:'column',
        animation:'slideIn .22s ease' }}>
        <style>{`@keyframes slideIn{from{transform:translateX(-20px);opacity:.6}to{transform:translateX(0);opacity:1}}@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>

        {/* Header */}
        <div style={{ padding:'14px 18px', borderBottom:'1px solid var(--border)',
          background:`linear-gradient(135deg,${catColor}1f,${catColor}06)`,
          borderTop:`3px solid ${catColor}`, flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <div style={{ display:'flex', alignItems:'center', gap:11 }}>
              <div style={{ width:38, height:38, borderRadius:10, background:catColor,
                display:'flex', alignItems:'center', justifyContent:'center',
                fontSize:17, color:'#fff', fontWeight:700 }}>{TYPE_ICONS[form.type] || '#'}</div>
              <div>
                <h2 style={{ margin:0, fontSize:15, fontWeight:800, color:'var(--text)' }}>
                  {isEdit ? 'تعديل قاعدة' : 'إضافة قاعدة جديدة'}
                </h2>
                <p style={{ margin:'2px 0 0', fontSize:11.5, color:'var(--text-3)' }}>
                  {CATEGORY_LABELS[form.category]} · {TYPE_LABELS[form.type]}
                </p>
              </div>
            </div>
            <button onClick={onClose} style={{ border:'none', background:'var(--surface)', borderRadius:8,
              padding:8, color:'var(--text-3)', cursor:'pointer' }}>
              <X style={{ width:16, height:16 }} />
            </button>
          </div>

          {/* Tabs */}
          <div style={{ display:'flex', gap:4, marginTop:12 }}>
            {TABS.map(t => {
              const active = tab === t.id;
              return (
                <button key={t.id} type="button" onClick={() => setTab(t.id)}
                  style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', gap:6,
                    padding:'8px 6px', borderRadius:8, border:'none', cursor:'pointer',
                    fontSize:12, fontWeight:700, fontFamily:'Cairo,sans-serif',
                    background: active ? catColor : 'var(--surface)',
                    color: active ? '#fff' : 'var(--text-2)',
                    boxShadow: active ? `0 2px 8px ${catColor}55` : 'none' }}>
                  <t.icon style={{ width:14, height:14 }} />
                  <span className="hidden sm:inline">{t.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Body */}
        <div style={{ flex:1, overflowY:'auto', padding:'16px', display:'flex', flexDirection:'column', gap:14 }}>

          {/* ── Tab 1: البيانات الأساسية ───────────────────────────────────── */}
          {tab === 'basic' && (
            <Card title="البيانات الأساسية" icon={FileText} accent={catColor}>
              <Field label="اسم القاعدة">
                <input className="input w-full" value={form.name}
                  onChange={e => handleNameChange(e.target.value)}
                  placeholder="مثال: فترة سماح التأخير" style={{ fontSize:14 }} />
              </Field>
              <div style={{ display:'flex', gap:12 }}>
                <Field label="الفئة" grow hint="المجموعة التي تنتمي إليها القاعدة.">
                  <select className="input w-full" value={form.category} onChange={e => set('category', e.target.value)}>
                    {CATS.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
                  </select>
                </Field>
                <Field label="النوع" grow hint={TYPE_HELP[form.type]}>
                  <select className="input w-full" value={form.type} onChange={e => set('type', e.target.value)}>
                    {visibleTypes.map(t => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
                  </select>
                </Field>
              </div>
              {advanced && (
                <Field label="المفتاح البرمجي" hint="معرّف داخلي للمحرك — يُنشأ تلقائيًا ولا يتغيّر بعد الحفظ.">
                  <input className="input w-full"
                    style={{ fontFamily:'Consolas,monospace', letterSpacing:.5,
                      background:'var(--surface)', opacity: isEdit ? .55 : .9 }}
                    value={form.key} disabled={isEdit}
                    onChange={e => set('key', e.target.value.replace(/[^a-z0-9_]/gi,'_').toLowerCase())}
                    placeholder="late_grace" />
                </Field>
              )}
              <Field label="الوصف" hint="شرح مختصر يظهر للمستخدمين (اختياري).">
                <textarea className="input w-full" rows={2} value={form.description}
                  onChange={e => set('description', e.target.value)} placeholder="وصف اختياري لهذه القاعدة" />
              </Field>
              {isEdit && (
                <Field label="🔗 يؤثر على" hint="الشاشات والحسابات التي تُعاد تلقائيًا عند تعديل هذه القاعدة.">
                  {(rule?.affects || []).length ? (
                    <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                      {rule.affects.map(a => (
                        <span key={a} style={{ fontSize:11, fontWeight:700, padding:'3px 9px', borderRadius:99,
                          background:`${catColor}1a`, color:catColor, border:`1px solid ${catColor}33` }}>{a}</span>
                      ))}
                    </div>
                  ) : (
                    <p style={{ margin:0, fontSize:12, color:'var(--text-3)' }}>
                      ⚠️ غير مفعّلة بعد — هذه القاعدة محفوظة كإعداد فقط ولا تؤثر حاليًا على أي حساب أو شاشة.
                    </p>
                  )}
                </Field>
              )}
            </Card>
          )}

          {/* ── Tab 2: الحسابات ─────────────────────────────────────────────── */}
          {tab === 'calc' && (
            <>
              <Card title="قيمة القاعدة" icon={Calculator} accent="#0891b2">
                {valueEditor()}
                {form.type !== 'boolean' && form.type !== 'formula' && (
                  <Field label="الوحدة" hint="وحدة القياس التي تظهر بجوار القيمة (اختياري).">
                    <input className="input w-full" value={form.unit} placeholder="دقيقة / ساعة / يوم / ج.م"
                      onChange={e => set('unit', e.target.value)} />
                  </Field>
                )}
              </Card>
            </>
          )}

          {/* ── Tab 3: إعدادات التنفيذ ──────────────────────────────────────── */}
          {tab === 'exec' && (
            <Card title="إعدادات التنفيذ" icon={Sliders} accent={catColor}>
              {advanced && (
                <Field label="الأولوية" hint="كلما قلّ الرقم، نُفِّذت القاعدة أولًا عند تعارض قاعدتين.">
                  <input type="number" min="0" max="100" className="input w-full"
                    style={{ fontFamily:'Consolas' }} value={form.priority}
                    onChange={e => set('priority', e.target.value)} />
                </Field>
              )}
              <Field label="تطبَّق على" hint="تحدد الفئة التي تُطبَّق عليها القاعدة (الكل أو فرع/إدارة محددة).">
                <select className="input w-full" value={form.appliesTo} onChange={e => set('appliesTo', e.target.value)}>
                  <option value="all">جميع الموظفين</option>
                  <option value="branch">فرع محدّد</option>
                  <option value="department">إدارة محدّدة</option>
                  <option value="employee">موظف محدّد</option>
                </select>
              </Field>
              <div style={{ display:'flex', alignItems:'center', gap:12, padding:'12px',
                borderRadius:9, background:'var(--surface)', border:'1px solid var(--border)' }}>
                <Toggle checked={form.isActive} onChange={v => set('isActive', v)} />
                <div>
                  <div style={{ fontSize:13.5, fontWeight:700, color:'var(--text)' }}>
                    {form.isActive ? 'القاعدة مفعّلة' : 'القاعدة موقوفة'}
                  </div>
                  <div style={{ fontSize:11.5, color:'var(--text-3)' }}>
                    تشغيل أو إيقاف القاعدة دون حذفها — الموقوفة لا تؤثر على أي حساب.
                  </div>
                </div>
              </div>
            </Card>
          )}

          {/* ── Tab 4: السجل ────────────────────────────────────────────────── */}
          {tab === 'log' && (
            <Card title="السجل والتاريخ" icon={History} accent={catColor}>
              {!isEdit ? (
                <div style={{ textAlign:'center', padding:'24px 12px', color:'var(--text-3)', fontSize:13 }}>
                  <Clock3 style={{ width:26, height:26, opacity:.5, margin:'0 auto 8px' }} />
                  سيظهر سجل التعديلات بعد حفظ القاعدة.
                </div>
              ) : (
                <>
                  <div style={{ display:'flex', gap:10 }}>
                    <div style={{ flex:1, padding:'10px 12px', borderRadius:8, background:'var(--surface)', border:'1px solid var(--border)' }}>
                      <div style={{ fontSize:11, color:'var(--text-3)' }}>آخر تعديل</div>
                      <div style={{ fontSize:12.5, fontWeight:700, color:'var(--text)', fontFamily:'Consolas' }}>
                        {rule.updatedAt ? new Date(rule.updatedAt).toLocaleString('en-GB') : '—'}
                      </div>
                    </div>
                    <div style={{ flex:1, padding:'10px 12px', borderRadius:8, background:'var(--surface)', border:'1px solid var(--border)' }}>
                      <div style={{ fontSize:11, color:'var(--text-3)' }}>أُنشئت بواسطة</div>
                      <div style={{ fontSize:12.5, fontWeight:700, color:'var(--text)' }}>{rule.createdByName || 'النظام'}</div>
                    </div>
                  </div>
                  {audit == null ? (
                    <div style={{ textAlign:'center', padding:14, color:'var(--text-3)' }}>
                      <Loader2 style={{ width:18, height:18, animation:'spin 1s linear infinite' }} />
                    </div>
                  ) : audit.length === 0 ? (
                    <div style={{ textAlign:'center', padding:'16px', color:'var(--text-3)', fontSize:12.5 }}>
                      لا توجد تعديلات مسجّلة بعد.
                    </div>
                  ) : (
                    <div style={{ display:'flex', flexDirection:'column', gap:0, position:'relative' }}>
                      {audit.map((a, i) => (
                        <div key={a.id || i} style={{ display:'flex', gap:10, paddingBottom:14, position:'relative' }}>
                          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', flexShrink:0 }}>
                            <span style={{ width:9, height:9, borderRadius:5, background:catColor, marginTop:4 }} />
                            {i < audit.length-1 && <span style={{ flex:1, width:1.5, background:'var(--border)' }} />}
                          </div>
                          <div style={{ minWidth:0 }}>
                            <div style={{ fontSize:12.5, fontWeight:700, color:'var(--text)' }}>
                              {a.action === 'created' ? 'إنشاء' : a.action === 'updated' ? 'تعديل'
                                : a.action === 'enabled' ? 'تفعيل' : a.action === 'disabled' ? 'إيقاف'
                                : a.action === 'deleted' ? 'حذف' : a.action}
                              {a.fieldName ? ` · ${a.fieldName}` : ''}
                            </div>
                            {(a.oldValue != null || a.newValue != null) && (
                              <div style={{ fontSize:11.5, color:'var(--text-3)', fontFamily:'Consolas', direction:'ltr', textAlign:'right' }}>
                                {a.oldValue ?? '∅'} → {a.newValue ?? '∅'}
                              </div>
                            )}
                            <div style={{ fontSize:11, color:'var(--text-3)' }}>
                              {a.changedByName || 'النظام'} · {a.changedAt ? new Date(a.changedAt).toLocaleString('en-GB') : ''}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </Card>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding:'12px 16px', borderTop:'1px solid var(--border)', flexShrink:0,
          display:'flex', gap:10, alignItems:'center', background:'var(--surface)' }}>
          <button onClick={save} disabled={saving}
            style={{ display:'flex', alignItems:'center', gap:7, padding:'10px 22px', borderRadius:9,
              background: catColor, color:'#fff', border:'none', fontWeight:700, fontSize:13.5,
              cursor: saving ? 'wait' : 'pointer', opacity: saving ? .7 : 1 }}>
            {saving ? <Loader2 style={{ width:15, height:15, animation:'spin 1s linear infinite' }} />
                    : <Save style={{ width:15, height:15 }} />}
            {isEdit ? 'حفظ التعديلات' : 'إنشاء القاعدة'}
          </button>
          <button onClick={onClose}
            style={{ padding:'10px 18px', borderRadius:9, border:'1px solid var(--border)',
              background:'transparent', color:'var(--text-2)', fontWeight:600, fontSize:13.5, cursor:'pointer' }}>
            إلغاء
          </button>
        </div>
      </div>
    </>
  );
}
