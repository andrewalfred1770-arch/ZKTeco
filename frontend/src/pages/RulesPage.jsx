/**
 * RulesPage — Enterprise Dynamic Rules Engine
 * SAP/Oracle/Odoo/Zoho HR grade — database-driven, auditable, ERP-density.
 *
 * Features: AG Grid (grouping, export, row-height, keyboard nav) •
 * Debounced search • Category chips • Audit drawer timeline •
 * Excel/CSV export • Quick toggle • Inline value/priority edit • ERP styling
 */
import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { AgGridReact } from 'ag-grid-react';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';
import {
  Plus, Loader2, RefreshCw, Search, Pencil, Trash2, History,
  Power, X, Download, CheckCircle2, XCircle, Clock, Edit3,
  Zap, Database, ShieldCheck, Sliders,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { useTheme } from '../contexts/ThemeContext';
import { AG_GRID_LOCALE_AR } from '../lib/agGridLocale';
import { ENTERPRISE_DEFAULT_COL_DEF, ENTERPRISE_GRID_PROPS } from '../lib/gridDefaults';
import { fmtDate, formatDuration, westernDigits } from '../lib/formatters';
import RuleDrawer, { CATEGORY_LABELS, CAT_COLOR, TYPE_LABELS, TYPE_ICONS } from '../components/RuleDrawer';
import { useRulesLiveSync } from '../hooks/useRulesLiveSync';

const ACTOR = 'مدير النظام';
const CHIPS = ['all', ...Object.keys(CATEGORY_LABELS)];

// Rule keys stored/validated in the DB but not read by any engine today —
// see backend/src/engines/ruleDependencyMap.js (entry([], [])) for the
// authoritative "what does this key affect" source. Editing these has zero
// effect on attendance/payroll; hidden by default, clearly badged when a
// power user opts into showAdvanced so they're never mistaken for live rules.
const INERT_KEYS = new Set(['late_limit', 'overtime_rounding']);

const ACT_COLOR = {
  created:'#10b981', updated:'#3b82f6', enabled:'#22c55e',
  disabled:'#94a3b8', deleted:'#ef4444',
};
const ACT_AR = {
  created:'إنشاء', updated:'تعديل', enabled:'تفعيل',
  disabled:'إيقاف', deleted:'حذف',
};
const ACT_ICON = {
  created: CheckCircle2, updated: Edit3, enabled: Zap,
  disabled: XCircle, deleted: Trash2,
};

// Debounce hook
function useDebounce(val, ms = 300) {
  const [deb, setDeb] = useState(val);
  useEffect(() => { const t = setTimeout(() => setDeb(val), ms); return () => clearTimeout(t); }, [val, ms]);
  return deb;
}

// ── Stat badge ────────────────────────────────────────────────────────────────
function StatBadge({ label, value, color, icon: Icon }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:1, padding:'6px 14px',
      borderRadius:8, border:'1px solid var(--border)', background:'var(--surface)' }}>
      <div style={{ display:'flex', alignItems:'center', gap:5 }}>
        {Icon && <Icon style={{ width:13, height:13, color }} />}
        <span style={{ fontSize:18, fontWeight:800, color, fontFamily:'Consolas,monospace', letterSpacing:-1 }}>{value}</span>
      </div>
      <span style={{ fontSize:11, color:'var(--text-3)', whiteSpace:'nowrap' }}>{label}</span>
    </div>
  );
}

// ── Icon action button ─────────────────────────────────────────────────────────
function IconBtn({ children, onClick, title, color, bg }) {
  const [hov, setHov] = useState(false);
  return (
    <button onClick={onClick} title={title}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ display:'inline-flex', alignItems:'center', justifyContent:'center', width:28, height:28, borderRadius:7,
        border:'1px solid var(--border)', cursor:'pointer', transition:'all .15s',
        background: hov ? (bg || 'var(--surface)') : 'transparent',
        color: color || 'var(--text-3)' }}>
      {children}
    </button>
  );
}

// ── AuditDrawer — Timeline ─────────────────────────────────────────────────────
function AuditDrawer({ rule, onClose }) {
  const [audits, setAudits] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const { data } = await api.get(`/rules/${rule.id}/audit`);
        setAudits(data);
      } catch { toast.error('تعذّر تحميل السجل'); }
      finally { setLoading(false); }
    })();
  }, [rule.id]);

  const catColor = CAT_COLOR[rule.category] || '#2563eb';

  return (
    <>
      <div onClick={onClose} style={{ position:'fixed', inset:0, zIndex:60,
        background:'rgba(0,0,0,.55)', backdropFilter:'blur(3px)' }} />
      <div dir="rtl" style={{ position:'fixed', top:0, bottom:0, left:0, zIndex:70,
        width:'min(460px,100vw)', background:'var(--surface-2)',
        borderRight:'1px solid var(--border)', display:'flex', flexDirection:'column',
        animation:'slideIn .22s ease', boxShadow:'-8px 0 48px rgba(0,0,0,.4)' }}>

        {/* header */}
        <div style={{ padding:'14px 18px', borderBottom:'1px solid var(--border)', flexShrink:0,
          background:`linear-gradient(135deg,${catColor}25,${catColor}05)`,
          borderTop:`3px solid ${catColor}` }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <div style={{ width:36, height:36, borderRadius:9, background:catColor,
                display:'flex', alignItems:'center', justifyContent:'center' }}>
                <History style={{ width:18, height:18, color:'#fff' }} />
              </div>
              <div>
                <h2 style={{ margin:0, fontSize:14.5, fontWeight:800, color:'var(--text)' }}>سجل التعديلات</h2>
                <div style={{ fontSize:11, color:'var(--text-3)', fontFamily:'Consolas', marginTop:2 }}>
                  {rule.name} · {rule.key}
                </div>
              </div>
            </div>
            <button onClick={onClose} style={{ border:'none', background:'var(--surface)', borderRadius:8,
              padding:7, color:'var(--text-3)', cursor:'pointer' }}>
              <X style={{ width:16, height:16 }} />
            </button>
          </div>
        </div>

        {/* timeline body */}
        <div style={{ flex:1, overflowY:'auto', padding:'20px 18px' }}>
          {loading ? (
            <div style={{ display:'flex', justifyContent:'center', marginTop:40 }}>
              <Loader2 style={{ width:28, height:28, animation:'spin 1s linear infinite', color:'var(--text-3)' }} />
            </div>
          ) : audits.length === 0 ? (
            <div style={{ textAlign:'center', marginTop:50, color:'var(--text-3)' }}>
              <History style={{ width:36, height:36, opacity:.3, margin:'0 auto 10px' }} />
              <p style={{ fontSize:13 }}>لا توجد تعديلات بعد</p>
            </div>
          ) : (
            <div style={{ position:'relative' }}>
              {/* vertical line */}
              <div style={{ position:'absolute', right:17, top:8, bottom:0, width:2,
                background:'var(--border)', borderRadius:1 }} />
              {audits.map((a, i) => {
                const color = ACT_COLOR[a.action] || '#64748b';
                const Icon = ACT_ICON[a.action] || Edit3;
                return (
                  <div key={a.id} style={{ display:'flex', gap:14, marginBottom:20, position:'relative' }}>
                    {/* dot */}
                    <div style={{ flexShrink:0, width:36, height:36, borderRadius:18,
                      background:`${color}20`, border:`2px solid ${color}`,
                      display:'flex', alignItems:'center', justifyContent:'center', zIndex:1 }}>
                      <Icon style={{ width:15, height:15, color }} />
                    </div>
                    {/* card */}
                    <div style={{ flex:1, border:'1px solid var(--border)', borderRadius:9,
                      padding:'10px 14px', background:'var(--surface)', marginTop:3 }}>
                      <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:6 }}>
                        <span style={{ fontSize:12.5, fontWeight:700, color }}>
                          {ACT_AR[a.action] || a.action}
                          {a.fieldName ? <span style={{ color:'var(--text-3)', fontWeight:500 }}> · {a.fieldName}</span> : null}
                        </span>
                        <span style={{ fontSize:11, color:'var(--text-3)', fontFamily:'Consolas', direction:'ltr' }}>
                          {fmtDate(a.changedAt)}
                        </span>
                      </div>
                      {/* old → new */}
                      {(a.oldValue != null || a.newValue != null) && (
                        <div style={{ display:'flex', alignItems:'center', gap:8, direction:'ltr',
                          fontFamily:'Consolas', fontSize:12.5, margin:'6px 0' }}>
                          {a.oldValue != null && (
                            <span style={{ padding:'2px 8px', borderRadius:4, background:'rgba(239,68,68,.12)',
                              color:'#ef4444', textDecoration:'line-through' }}>{a.oldValue}</span>
                          )}
                          <span style={{ color:'var(--text-3)' }}>→</span>
                          {a.newValue != null && (
                            <span style={{ padding:'2px 8px', borderRadius:4, background:'rgba(16,185,129,.12)',
                              color:'#10b981', fontWeight:700 }}>{a.newValue}</span>
                          )}
                        </div>
                      )}
                      {/* actor */}
                      <div style={{ fontSize:11, color:'var(--text-3)', display:'flex', alignItems:'center', gap:5 }}>
                        <ShieldCheck style={{ width:11, height:11 }} />
                        {a.changedByName || 'النظام'}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <style>{`@keyframes slideIn{from{transform:translateX(-16px);opacity:.5}to{transform:translateX(0);opacity:1}} @keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
    </>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function RulesPage() {
  const { agGridTheme } = useTheme();
  const gridRef = useRef();

  const [rules,    setRules]    = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [rawSearch, setRawSearch] = useState('');
  const search = useDebounce(rawSearch, 250);
  const [cat,      setCat]      = useState('all');
  const [active,   setActive]   = useState('all');
  const [editing,  setEditing]  = useState(null);
  const [auditRule,setAuditRule]= useState(null);
  // Hidden by default — HR users see only the essentials; power users opt in.
  const [showAdvanced, setShowAdvanced] = useState(() => localStorage.getItem('rules_advanced') === '1');
  useEffect(() => { localStorage.setItem('rules_advanced', showAdvanced ? '1' : '0'); }, [showAdvanced]);

  // Counts in-flight PUT requests — both the live-sync reload below and this
  // page's own post-edit reload (onCellEdit calls load() right after saving)
  // are deferred while this is nonzero, so a second cell edit (e.g. tabbing
  // to the next row before the previous save's reload lands) can no longer
  // have its rowData swapped out from under an open editor mid-edit.
  const editCountRef = useRef(0);
  const pendingReloadRef = useRef(false);

  const load = useCallback(async (showLoading = true) => {
    if (editCountRef.current > 0) { pendingReloadRef.current = true; return; }
    if (showLoading) setLoading(true);
    try { const { data } = await api.get('/rules'); setRules(data); }
    catch { toast.error('فشل تحميل القواعد'); }
    finally { if (showLoading) setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useRulesLiveSync(load, { isBusyRef: editCountRef }); // another admin/session edited a rule → reload the table + show recalc progress

  // counts
  const counts = useMemo(() => {
    const c = { all: rules.length };
    rules.forEach(r => { c[r.category] = (c[r.category] || 0) + 1; });
    return c;
  }, [rules]);
  const activeCount   = useMemo(() => rules.filter(r => r.isActive).length, [rules]);
  const inactiveCount = rules.length - activeCount;

  // filtered
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rules.filter(r =>
      // INERT_KEYS (late_limit, overtime_rounding) are stored/validated rule rows
      // that no engine reads — see the "غير مُستخدم" badge below and
      // ruleDependencyMap.js for the authoritative per-key wiring. Kept out of
      // the default view for backward-compat/audit-history reasons only; power
      // users can still see (and clearly identify) them via showAdvanced.
      (showAdvanced || !INERT_KEYS.has(r.key)) &&
      (cat === 'all' || r.category === cat) &&
      (active === 'all' || (active === 'active' ? r.isActive : !r.isActive)) &&
      (!q || r.name.toLowerCase().includes(q) || r.key.toLowerCase().includes(q) ||
       (r.description || '').toLowerCase().includes(q))
    );
  }, [rules, search, cat, active, showAdvanced]);

  // actions
  const toggle = async (rule) => {
    // Optimistic update: flip isActive immediately for instant feedback
    const next = !rule.isActive;
    setRules(prev => prev.map(r => r.id === rule.id ? { ...r, isActive: next } : r));
    try {
      // Use the full API response to update the row — captures updatedAt and
      // any other server-side changes rather than leaving them stale.
      const { data: updated } = await api.patch(`/rules/${rule.id}/toggle`, { changedByName: ACTOR });
      setRules(prev => prev.map(r => r.id === rule.id ? updated : r));
    } catch {
      // Revert on failure
      setRules(prev => prev.map(r => r.id === rule.id ? { ...r, isActive: rule.isActive } : r));
      toast.error('تعذّر التبديل');
    }
  };

  const remove = async (rule) => {
    if (!window.confirm(`حذف القاعدة "${rule.name}"؟ هذا الإجراء لا يمكن التراجع عنه.`)) return;
    try { await api.delete(`/rules/${rule.id}`); toast.success('تم الحذف'); load(); }
    catch { toast.error('فشل الحذف'); }
  };

  const onCellEdit = async ({ data, colDef, newValue, oldValue }) => {
    if (String(newValue) === String(oldValue)) return;
    editCountRef.current++;
    try {
      await api.put(`/rules/${data.id}`, { [colDef.field]: newValue, changedByName: ACTOR });
      toast.success('تم التحديث');
    } catch { toast.error('فشل التحديث'); }
    finally {
      editCountRef.current--;
      if (editCountRef.current === 0) { pendingReloadRef.current = false; load(false); }
    }
  };

  // export
  const exportCSV = () => gridRef.current?.api?.exportDataAsCsv({ fileName: `rules_${Date.now()}.csv` });
  const exportExcel = () => gridRef.current?.api?.exportDataAsExcel({ fileName: `rules_${Date.now()}.xlsx` });

  const getRowId = useCallback(p => String(p.data.id), []);

  // ── Column definitions ─────────────────────────────────────────────────────
  // Default view: only what an HR user needs to understand a rule at a glance.
  // Technical columns (key/priority/...) are opt-in via "إعدادات متقدمة".
  const cols = useMemo(() => {
    const nameCol = {
      field:'name', headerName:'اسم القاعدة', minWidth:200, flex:2, pinned:'right',
      cellStyle:{ fontWeight:700, color:'var(--text)', fontFamily:'IBM Plex Sans Arabic, Cairo, sans-serif', fontSize:13 },
      cellRenderer: ({ data, value }) => (
        <span style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
          {value}
          {INERT_KEYS.has(data?.key) && (
            <span title="هذا الإعداد محفوظ لأغراض التوافق فقط — لا يؤثر على أي حساب حالياً"
              style={{ display:'inline-flex', alignItems:'center', padding:'1px 7px', borderRadius:20,
                fontSize:10, fontWeight:700, color:'#94a3b8', background:'rgba(148,163,184,.15)',
                border:'1px solid rgba(148,163,184,.3)' }}>
              🚫 غير مُفعّل — للتوافق فقط
            </span>
          )}
        </span>
      ),
    };
    const valueCol = {
      // Formulas are NOT inline-editable (use the visual builder); other types are.
      field:'value', headerName:'القيمة', width:130,
      editable: p => p.data?.type !== 'formula',
      cellRenderer: ({ data, value }) => {
        const type = data?.type;
        if (type === 'formula') {
          return <span style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'2px 9px',
            borderRadius:20, fontSize:11, fontWeight:700, color:'#7c3aed', background:'rgba(124,58,237,.12)',
            fontFamily:'Cairo,sans-serif' }}>معادلة محسوبة تلقائيًا</span>;
        }
        if (type === 'boolean') {
          const on = String(value) === 'true';
          return <span style={{ fontWeight:800, color: on ? '#10b981' : '#ef4444' }}>{on ? 'نعم ✓' : 'لا ✗'}</span>;
        }
        // Minutes-based values → human duration (never raw minute counts)
        const unit = String(data?.unit || '');
        if ((type === 'number' || !type) && /دقيق|min/i.test(unit) && value !== '' && !isNaN(Number(value))) {
          return <span style={{ fontWeight:800, color:'#3b82f6' }}>{formatDuration(Number(value))}</span>;
        }
        return <span style={{ fontWeight:800, color:'#3b82f6' }}>{westernDigits(String(value ?? ''))}</span>;
      },
      cellStyle:{ fontFamily:'Consolas,monospace', textAlign:'center', direction:'ltr', justifyContent:'center' },
    };
    const unitCol = {
      field:'unit', headerName:'الوحدة', width:90,
      cellStyle:{ color:'var(--text-2)', fontSize:11.5, textAlign:'center' },
    };
    const descCol = {
      field:'description', headerName:'وصف مختصر', minWidth:240, flex:2,
      valueFormatter: p => p.value || '—',
      cellStyle:{ color:'var(--text-2)', fontSize:12, textAlign:'right', direction:'rtl',
        whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' },
      tooltipField:'description',
    };
    const statusCol = {
      field:'isActive', headerName:'الحالة', width:120, sortable:true,
      valueGetter: p => p.data?.isActive,
      cellRenderer: ({ data }) => (
        <button onClick={() => toggle(data)}
          style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'3px 10px', borderRadius:20,
            border:`1.5px solid ${data.isActive ? 'rgba(16,185,129,.4)' : 'rgba(148,163,184,.3)'}`,
            cursor:'pointer', fontSize:11, fontWeight:700, transition:'all .15s',
            color: data.isActive ? '#10b981' : '#94a3b8',
            background: data.isActive ? 'rgba(16,185,129,.1)' : 'transparent' }}>
          <Power style={{ width:11, height:11 }} />
          {data.isActive ? 'مفعّلة' : 'موقوفة'}
        </button>
      ),
    };
    const actionsCol = {
      headerName:'تعديل', width: showAdvanced ? 132 : 70, pinned:'left', sortable:false, filter:false,
      suppressMovable:true, resizable:false,
      cellRenderer: ({ data }) => (
        <div style={{ display:'flex', gap:5, alignItems:'center', justifyContent:'center', height:'100%' }}>
          <IconBtn title="تعديل القاعدة" color='#a3e635' bg='rgba(163,230,53,.1)'
            onClick={() => setEditing(data)}><Pencil style={{ width:13, height:13 }} /></IconBtn>
          {showAdvanced && (
            <>
              <IconBtn title="سجل التعديلات" color='#3b82f6' bg='rgba(59,130,246,.1)'
                onClick={() => setAuditRule(data)}><History style={{ width:13, height:13 }} /></IconBtn>
              <IconBtn title="حذف القاعدة" color='#ef4444' bg='rgba(239,68,68,.1)'
                onClick={() => remove(data)}><Trash2 style={{ width:13, height:13 }} /></IconBtn>
            </>
          )}
        </div>
      ),
    };

    if (!showAdvanced) {
      return [nameCol, valueCol, unitCol, descCol, statusCol, actionsCol];
    }

    // ── Advanced (opt-in) columns — for power users / implementers only ──────
    const keyCol = {
      field:'key', headerName:'المفتاح البرمجي', minWidth:150, flex:1.2,
      cellStyle:{ fontFamily:'Consolas,monospace', color:'var(--text-3)', fontSize:11.5,
        textAlign:'right', direction:'ltr' },
    };
    const categoryCol = {
      field:'category', headerName:'الفئة', width:110,
      cellRenderer: ({ value }) => {
        const color = CAT_COLOR[value] || '#64748b';
        return (
          <span style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'2px 9px', borderRadius:20,
            fontSize:11, fontWeight:700, color, background:`${color}1e`, letterSpacing:.2 }}>
            {CATEGORY_LABELS[value] || value}
          </span>
        );
      },
    };
    const typeCol = {
      field:'type', headerName:'النوع', width:96,
      cellRenderer: ({ value }) => (
        <span style={{ display:'inline-flex', alignItems:'center', gap:4, fontSize:11.5,
          color:'var(--text-3)', fontFamily:'Consolas' }}>
          <span style={{ fontSize:13 }}>{TYPE_ICONS[value] || '#'}</span>
          {TYPE_LABELS[value] || value}
        </span>
      ),
    };
    const priorityCol = {
      field:'priority', headerName:'الأولوية', width:88, editable:true,
      cellStyle:{ fontFamily:'Consolas', color:'var(--text-3)', textAlign:'center', direction:'ltr' },
    };
    const updatedCol = {
      field:'updatedAt', headerName:'آخر تعديل', width:108,
      valueFormatter: p => fmtDate(p.value),
      cellStyle:{ fontFamily:'Consolas', color:'var(--text-3)', fontSize:11, textAlign:'center', direction:'ltr' },
    };

    return [
      nameCol, keyCol, categoryCol, typeCol, valueCol, unitCol,
      priorityCol, descCol, statusCol, updatedCol, actionsCol,
    ];
  }, [showAdvanced]);

  const defaultColDef = useMemo(() => ({
    ...ENTERPRISE_DEFAULT_COL_DEF,
    filterParams:{ buttons:['reset'] },
  }), []);

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', gap:10, direction:'rtl' }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="page-header" style={{ alignItems:'flex-start' }}>
        <div>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
            <div style={{ width:32, height:32, borderRadius:8, background:'#2563eb',
              display:'flex', alignItems:'center', justifyContent:'center' }}>
              <Database style={{ width:16, height:16, color:'#fff' }} />
            </div>
            <h1 className="page-title" style={{ margin:0 }}>محرك القواعد الديناميكي</h1>
            <span style={{ padding:'2px 8px', borderRadius:6, background:'rgba(37,99,235,.15)',
              color:'#3b82f6', fontSize:10.5, fontWeight:800, letterSpacing:.5 }}>ERP</span>
          </div>
          <p style={{ fontSize:11.5, color:'var(--text-3)', margin:0 }}>
            قواعد قابلة للإنشاء والتعديل والتدقيق بالكامل · مرتبطة بمحركات الحضور والمرتبات
          </p>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          {/* Stats */}
          <StatBadge label="إجمالي القواعد" value={rules.length} color='var(--text-2)' icon={Database} />
          <StatBadge label="مفعّلة" value={activeCount} color='#10b981' icon={CheckCircle2} />
          <StatBadge label="موقوفة" value={inactiveCount} color='#94a3b8' icon={XCircle} />
          {/* Advanced settings toggle — power-user fields stay hidden until requested */}
          <button onClick={() => setShowAdvanced(s => !s)} title="عرض الحقول التقنية (المفتاح، الأولوية، الشرط...)"
            style={{ display:'flex', alignItems:'center', gap:7, padding:'9px 14px', borderRadius:9,
              border:`1px solid ${showAdvanced ? '#7c3aed' : 'var(--border)'}`,
              background: showAdvanced ? 'rgba(124,58,237,.12)' : 'transparent',
              color: showAdvanced ? '#7c3aed' : 'var(--text-2)', fontWeight:700, fontSize:12.5, cursor:'pointer' }}>
            <Sliders style={{ width:14, height:14 }} />
            إعدادات متقدمة
          </button>
          {/* Add */}
          <button onClick={() => setEditing({})}
            style={{ display:'flex', alignItems:'center', gap:7, padding:'9px 16px', borderRadius:9,
              background:'#2563eb', color:'#fff', border:'none', fontWeight:700, fontSize:13, cursor:'pointer' }}>
            <Plus style={{ width:15, height:15 }} /> إضافة قاعدة
          </button>
        </div>
      </div>

      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap',
        padding:'9px 14px', borderRadius:10, border:'1px solid var(--border)', background:'var(--surface)' }}>
        {/* Search */}
        <div style={{ position:'relative', flex:1, maxWidth:340 }}>
          <Search style={{ width:14, height:14, position:'absolute', top:'50%', right:10,
            transform:'translateY(-50%)', color:'var(--text-3)' }} />
          <input value={rawSearch} onChange={e => setRawSearch(e.target.value)}
            style={{ width:'100%', padding:'7px 32px 7px 10px', borderRadius:7, border:'1px solid var(--border)',
              background:'var(--surface-2)', color:'var(--text)', fontSize:12.5, outline:'none', boxSizing:'border-box' }}
            placeholder="بحث بالاسم أو المفتاح أو الوصف..." />
        </div>
        {/* Status filter */}
        <select value={active} onChange={e => setActive(e.target.value)}
          style={{ padding:'7px 10px', borderRadius:7, border:'1px solid var(--border)',
            background:'var(--surface-2)', color:'var(--text)', fontSize:12, cursor:'pointer' }}>
          <option value="all">كل الحالات</option>
          <option value="active">المفعّلة فقط</option>
          <option value="inactive">الموقوفة فقط</option>
        </select>
        {/* Refresh */}
        <button onClick={load} title="تحديث"
          style={{ display:'flex', alignItems:'center', padding:7, borderRadius:7,
            border:'1px solid var(--border)', background:'transparent', cursor:'pointer', color:'var(--text-3)' }}>
          <RefreshCw style={{ width:14, height:14 }} className={loading ? 'animate-spin' : ''} />
        </button>
        <div style={{ flex:1 }} />
        {/* result count */}
        <span style={{ fontSize:12, color:'var(--text-3)', whiteSpace:'nowrap' }}>
          {loading ? <Loader2 style={{ width:12, height:12, display:'inline', animation:'spin 1s linear infinite' }} /> : `${filtered.length} نتيجة`}
        </span>
        {/* Exports */}
        <button onClick={exportCSV} title="تصدير CSV"
          style={{ display:'flex', alignItems:'center', gap:5, padding:'6px 11px', borderRadius:7,
            border:'1px solid var(--border)', background:'transparent', color:'var(--text-3)',
            fontSize:11.5, fontWeight:600, cursor:'pointer' }}>
          <Download style={{ width:13, height:13 }} /> CSV
        </button>
      </div>

      {/* ── Category Chips ───────────────────────────────────────────────────── */}
      <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
        {CHIPS.map(c => {
          const on = cat === c;
          const color = c === 'all' ? '#2563eb' : (CAT_COLOR[c] || '#64748b');
          const cnt = counts[c] || 0;
          return (
            <button key={c} onClick={() => setCat(c)}
              style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'5px 13px',
                borderRadius:20, fontSize:12, fontWeight:700, cursor:'pointer', transition:'all .15s',
                border:`1.5px solid ${on ? color : 'var(--border)'}`,
                background: on ? `${color}1e` : 'transparent',
                color: on ? color : 'var(--text-3)' }}>
              {c === 'all' ? 'الكل' : CATEGORY_LABELS[c]}
              <span style={{ padding:'1px 6px', borderRadius:10, fontSize:10.5, fontWeight:800,
                background: on ? `${color}30` : 'var(--surface)', color: on ? color : 'var(--text-3)' }}>
                {cnt}
              </span>
            </button>
          );
        })}
      </div>

      {/* ── AG Grid ─────────────────────────────────────────────────────────── */}
      <div style={{ flex:1, minHeight:0, borderRadius:10, overflow:'hidden',
        border:'1px solid var(--border)' }}>
        <div className={agGridTheme} style={{ height:'100%' }}>
          <AgGridReact
            ref={gridRef}
            rowData={filtered}
            columnDefs={cols}
            defaultColDef={defaultColDef}
            {...ENTERPRISE_GRID_PROPS}
            onCellEditingStopped={onCellEdit}
            enableRtl
            localeText={AG_GRID_LOCALE_AR}
            animateRows={false}
            rowHeight={38}
            headerHeight={38}
            loading={loading}
            getRowId={getRowId}
            suppressCellFocus={false}
            enableCellTextSelection
            pagination
            paginationPageSize={50}
            paginationPageSizeSelector={[25,50,100]}
            overlayLoadingTemplate='<span style="font-family:Cairo,sans-serif;font-size:13px;color:#94a3b8">جاري تحميل القواعد...</span>'
            overlayNoRowsTemplate={rules.length === 0 && !loading
              ? '<div style="font-family:Cairo,sans-serif;text-align:center;padding:40px 20px"><p style="font-size:14px;color:#64748b;font-weight:700;margin:0 0 6px">لا توجد قواعد محملة</p><p style="font-size:12px;color:#94a3b8;margin:0">تأكد من تشغيل الخادم الخلفي وإعادة التحميل</p></div>'
              : '<span style="font-family:Cairo,sans-serif;font-size:13px;color:#94a3b8">لا توجد نتائج مطابقة للبحث</span>'}
          />
        </div>
      </div>

      {/* ── Drawers ──────────────────────────────────────────────────────────── */}
      {editing && (
        <RuleDrawer rule={editing.id ? editing : null} actor={ACTOR} advanced={showAdvanced}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }} />
      )}
      {auditRule && (
        <AuditDrawer rule={auditRule} onClose={() => setAuditRule(null)} />
      )}
      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
