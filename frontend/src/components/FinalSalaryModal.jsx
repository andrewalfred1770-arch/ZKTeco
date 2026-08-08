/**
 * FinalSalaryModal — Preview, Print, PDF, Excel export for salary sheets
 * Supports single employee or bulk all-employees view.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import {
  X, Printer, FileText, FileSpreadsheet,
  Loader2, ZoomIn, ZoomOut, AlertCircle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import SalaryCard from './SalaryCard';
import CompactSalarySheet, { PER_PAGE } from './CompactSalarySheet';
import { useTheme } from '../contexts/ThemeContext';
import { useRulesLiveSync } from '../hooks/useRulesLiveSync';
import { EMBEDDED_FONT_CSS_ALL } from '../lib/reportTemplate';
import { exportToExcel, printDocument } from '../lib/printUtils';
import { FILE_PREFIX, useCompanyBrand } from '../lib/branding';
import { fmtMoney, fmtIntZero, displayNetSalary } from '../lib/formatters';
import { MONTHS_AR } from '../lib/constants';
import { COLORS } from '../lib/printDesignSystem';

// Wrap salary-card HTML in a self-contained A4 document (embedded Arabic
// fonts). Cairo-first (matching every other printed document's typography —
// IBM Plex Sans Arabic stays available for CompactSalarySheet's own scoped
// styles, which set it explicitly where needed) and the shared ink token
// instead of a bare #000. Page-level footer content (company identity ·
// page number) is rendered directly inside SalaryCard/CompactSalarySheet
// themselves — visible in both the on-screen preview and the printed
// output — rather than an @page margin box, since this document's pages are
// fixed-size divs, not @page-driven like reportTemplate.js's table reports.
function buildSalaryDoc(innerHTML, title, landscape = false) {
  return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="UTF-8"><title>${title}</title>
<style>
${EMBEDDED_FONT_CSS_ALL}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Cairo','IBM Plex Sans Arabic',Tahoma,Arial,sans-serif;background:#fff;color:${COLORS.i1};direction:rtl;}
@page{size:A4${landscape ? ' landscape' : ''};margin:0;}
.salary-card{page-break-after:always;}
.salary-card:last-child{page-break-after:auto;}
@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}
</style></head><body>${innerHTML}</body></html>`;
}

// ── Fit-to-width zoom: scale an A4 page (mm) to fill the modal's preview pane ──
const MM_TO_PX = 96 / 25.4;
function computeFitZoom(pageWidthMM) {
  const available = window.innerWidth - 88; // modal inset (20px×2) + body padding (24px×2)
  return Math.max(40, Math.min(160, Math.floor((available / (pageWidthMM * MM_TO_PX)) * 100)));
}

export default function FinalSalaryModal({ payrollRow, month, year, onClose, bulk = false, allRows = [] }) {
  const { isLight } = useTheme();
  const brand = useCompanyBrand();
  const [loading,  setLoading]  = useState(false);
  const [data,     setData]     = useState(null);
  const [bulkData, setBulkData] = useState([]);
  // Both single (SalaryCard) and bulk (CompactSalarySheet) sheets are A4 landscape.
  const PAGE_W_MM = 297;
  const [zoom,     setZoom]     = useState(() => computeFitZoom(PAGE_W_MM)); // percent — fit-to-width
  const zoomTouchedRef = useRef(false);
  const printRef = useRef();

  // Re-fit zoom on window resize until the user manually adjusts it.
  useEffect(() => {
    const onResize = () => { if (!zoomTouchedRef.current) setZoom(computeFitZoom(PAGE_W_MM)); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [PAGE_W_MM]);

  // Phase 13.9: accessible-dialog semantics — full-screen workspace variant
  // (like PrintPreviewModal), so only the focus-trap/restore/Escape engine
  // is applied here, no visual chrome change.
  const titleId = useId();
  const containerRef = useFocusTrap(true);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // ── Load single salary sheet ──────────────────────────────────────────────
  const loadSingle = useCallback(async (empId) => {
    setLoading(true);
    try {
      const { data: d } = await api.get('/payroll/final-sheet', {
        params: { employeeId: empId, month, year },
      });
      setData(d);
    } catch (err) {
      toast.error('تعذر تحميل كشف الراتب: ' + (err.response?.data?.error || err.message));
    } finally { setLoading(false); }
  }, [month, year]);

  // ── Load bulk ─────────────────────────────────────────────────────────────
  // Bounded-concurrency fetch (Phase 6.1): previously one sequential
  // `await` per employee — O(N) network round-trips end-to-end. Requests are
  // now fired in fixed-size batches (BULK_FETCH_CONCURRENCY in flight at
  // once) instead of unbounded Promise.all, so a 1000-employee company can't
  // open 1000 simultaneous connections. Each employee's own GET /payroll/
  // final-sheet call, and everything it returns, is unchanged — this only
  // changes how many of those identical requests are in flight at once.
  // Results are written into a pre-sized array by original index (not
  // completion order), so the final list is byte-identical in ordering and
  // content to the old sequential version regardless of which request
  // finishes first; a failed/missing-empId row is left as `undefined` and
  // filtered out at the end, matching the old loop's `continue`/`catch {}`
  // skip behavior exactly.
  const BULK_FETCH_CONCURRENCY = 12;
  const loadBulk = useCallback(async () => {
    setLoading(true);
    const slots = new Array(allRows.length);

    const fetchOne = async (row, idx) => {
      const empId = row['employee.id'] || row.employeeId || row.employee?.id;
      if (!empId) return;
      try {
        const { data: d } = await api.get('/payroll/final-sheet', {
          params: { employeeId: empId, month, year },
        });
        slots[idx] = d;
      } catch {}
    };

    for (let start = 0; start < allRows.length; start += BULK_FETCH_CONCURRENCY) {
      const batch = allRows.slice(start, start + BULK_FETCH_CONCURRENCY);
      await Promise.all(batch.map((row, i) => fetchOne(row, start + i)));
    }

    const results = slots.filter(Boolean);
    setBulkData(results);
    if (results.length === 0) toast.error('لا توجد بيانات رواتب محسوبة');
    setLoading(false);
  }, [allRows, month, year]);

  const reloadSheet = useCallback(() => {
    if (bulk) {
      loadBulk();
    } else if (payrollRow) {
      const empId = payrollRow.employeeId || payrollRow['employee.id'] || payrollRow.employee?.id;
      if (empId) loadSingle(empId);
    }
  }, [bulk, payrollRow, loadBulk, loadSingle]);

  useEffect(() => { reloadSheet(); }, []);

  // Rule edited while the sheet is open → backend recalculates → refetch the
  // final sheet so printed/exported numbers always reflect the latest rules
  // (modal already shows its own loading state, so keep this silent).
  useRulesLiveSync(reloadSheet, { silent: true });

  // ── Print (real Chromium HTML — embedded Arabic fonts) ──────────────────────
  // Routed through printUtils.js's shared printDocument() — the same
  // dispatcher every table report's print button uses — instead of a second,
  // independently hand-rolled window.open()/fonts.ready/print() sequence.
  // That duplicate never checked window.electron?.printHTML, so in the
  // packaged Electron app window.open() (blocked by setWindowOpenHandler)
  // silently failed and this print button did nothing; printDocument()
  // already handles the Electron IPC path correctly, with this exact
  // window.open fallback preserved for the browser/dev case.
  const handlePrint = () => {
    const printContent = printRef.current?.innerHTML;
    if (!printContent) { toast.error('لا توجد بيانات للطباعة'); return; }
    const html = buildSalaryDoc(printContent, `كشف رواتب ${monthLabel} ${year}`, true);
    printDocument(html, undefined, 'landscape');
  };

  // ── Export PDF (Chromium print engine + browser fallback) ───────────────────
  const handlePDF = async () => {
    const printContent = printRef.current?.innerHTML;
    if (!printContent) { toast.error('لا توجد بيانات'); return; }
    const html = buildSalaryDoc(printContent, `كشف رواتب ${monthLabel} ${year}`, true);
    const filename = `${FILE_PREFIX}_كشف_رواتب_${monthLabel}_${year}`;
    const tid = toast.loading('جاري إنشاء ملف PDF...');
    try {
      if (window.electron?.exportPDF) {
        const res = await window.electron.exportPDF({ html, filename, landscape: true });
        if (res?.ok) toast.success('تم حفظ ملف PDF', { id: tid });
        else if (res?.canceled) toast.dismiss(tid);
        else toast.error('تعذر إنشاء PDF', { id: tid });
      } else {
        handlePrint(); toast.success('اختر "حفظ كـ PDF" من نافذة الطباعة', { id: tid });
      }
    } catch { toast.error('تعذر إنشاء PDF', { id: tid }); }
  };

  // ── Export Excel (real .xlsx, PETSHROW branded, with totals) ────────────────
  // EF-011 Accounting Policy: "إجمالي الخصومات" is the sum of this SAME row's
  // other displayed (already-rounded) deduction columns — not the backend's
  // separately-rounded `deductions.total` field — so the sheet is calculator-
  // verifiable from the numbers printed in it. Unchanged by EF-019.1.
  // Phase 8.1: r0() was a byte-for-byte duplicate of formatters.js's
  // displayNetSalary() (same Math.round(Number(n)||0)) — removed in favor of
  // the shared function; the row-sum policy itself (EF-011, above) is unchanged.
  const rowDedTotal = (row) => (
    displayNetSalary(row?.deductions?.absentAmount) + displayNetSalary(row?.deductions?.lateAmount) + displayNetSalary(row?.deductions?.earlyAmount)
    + displayNetSalary(row?.deductions?.manualDeductionAdjustment)
  );
  // EF-019.1: "صافي الراتب" is the ONE shared displayNetSalary() helper
  // applied to this row's own canonical `netSalary` field — not re-derived
  // from components (that was the proven root cause of cross-system ±1
  // divergence between this export and the Payroll Grid/Salary Card).
  const rowNet = (row) => displayNetSalary(row?.netSalary);
  const exportExcel = async () => {
    const sheets = bulk ? bulkData : (data ? [data] : []);
    if (!sheets.length) { toast.error('لا توجد بيانات للتصدير'); return; }
    const cols = [
      { header:'اسم الموظف',     key:'employee.name' },
      { header:'الكود',           key:'employee.code' },
      { header:'القسم',           key:'employee.department' },
      { header:'أيام الحضور',    key:'attendance.workDays',   format:v=>fmtIntZero(v), total:'sum' },
      { header:'أيام الغياب',    key:'attendance.absentDays', format:v=>fmtIntZero(v), total:'sum' },
      { header:'الراتب الأساسي', key:'earnings.basicSalary',  format:v=>fmtMoney(v), total:'sum' },
      { header:'إضافي صباحي',    key:'earnings.morningOT.amount', format:v=>fmtMoney(v), total:'sum' },
      { header:'إضافي مسائي',    key:'earnings.eveningOT.amount', format:v=>fmtMoney(v), total:'sum' },
      { header:'إجمالي الإضافي', key:'earnings.overtimeAmount', format:v=>fmtMoney(v), total:'sum' },
      // Phase 9 Part 1: earnings.bonus already exists on this exact
      // /final-sheet response (shown on SalaryCard/CompactSalarySheet) — it
      // was simply never added as a column here, the same gap Phase 8.3
      // fixed in reports.js's /reports/payroll/export. Read directly, no
      // recalculation; netSalary below already included it.
      { header:'مكافأة / بدل',   key:'earnings.bonus',           format:v=>fmtMoney(v), total:'sum' },
      { header:'خصم الغياب',     key:'deductions.absentAmount', format:v=>fmtMoney(v), total:'sum' },
      { header:'خصم التأخير',    key:'deductions.lateAmount',  format:v=>fmtMoney(v), total:'sum' },
      { header:'خصم الانصراف المبكر', key:'deductions.earlyAmount', format:v=>fmtMoney(v), total:'sum' },
      { header:'السلف',           key:'deductions.advances',                format:v=>fmtMoney(v), total:'sum' },
      { header:'خصم إداري',      key:'deductions.manualDeductionAdjustment', format:v=>fmtMoney(v), total:'sum' },
      { header:'إجمالي الخصومات', key:'deductions.total', format:(v,row)=>fmtMoney(row?.__total ? v : rowDedTotal(row)), total:(rows)=>rows.reduce((s,r)=>s+rowDedTotal(r),0) },
      { header:'صافي الراتب',    key:'netSalary', format:(v,row)=>fmtMoney(row?.__total ? v : rowNet(row)), total:(rows)=>rows.reduce((s,r)=>s+rowNet(r),0) },
    ];
    await exportToExcel(sheets, cols, `كشف_رواتب_${monthLabel}_${year}`, 'كشف الرواتب', {
      title: `كشف رواتب ${monthLabel} ${year}`, period: `${monthLabel} ${year}`, brand,
    });
    toast.success('تم تصدير ملف Excel');
  };

  const monthLabel = MONTHS_AR[month - 1];
  const hasData    = bulk ? bulkData.length > 0 : !!data;
  const totalCards = bulk ? bulkData.length : (data ? 1 : 0);

  return (
    <>
      {/* Overlay */}
      <div onClick={onClose} style={{
        position:'fixed', inset:0, zIndex:60,
        background: isLight ? 'rgba(37,99,235,0.10)' : 'rgba(0,0,0,0.65)',
        backdropFilter:'blur(6px)',
      }} />

      {/* Modal */}
      <div
        ref={containerRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
        position:'fixed', inset:'20px', zIndex:70,
        background:'var(--surface-2)',
        border:'1.5px solid var(--border)',
        borderRadius:16,
        boxShadow:'0 24px 80px rgba(0,0,0,0.28)',
        display:'flex', flexDirection:'column',
        overflow:'hidden', outline:'none',
      }} dir="rtl">

        {/* ── Header ───────────────────────────────────────────────────────── */}
        <div style={{
          display:'flex', alignItems:'center', justifyContent:'space-between',
          padding:'14px 20px', borderBottom:'1px solid var(--border)',
          background: isLight
            ? 'linear-gradient(135deg,#1d4ed8,#1e40af)'
            : 'linear-gradient(135deg,var(--surface-3),var(--surface-2))',
          flexShrink:0,
        }}>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <div style={{
              width:36, height:36, borderRadius:10,
              background:'rgba(255,255,255,0.15)',
              display:'flex', alignItems:'center', justifyContent:'center',
            }}>
              <FileSpreadsheet style={{ width:18, height:18, color:'#fff' }} />
            </div>
            <div>
              <h2 id={titleId} style={{ color:'#fff', fontSize:15, fontWeight:800, margin:0 }}>
                {bulk ? 'كشف رواتب جميع الموظفين' : 'كشف راتب - النهائي'}
              </h2>
              <p style={{ color:'rgba(255,255,255,0.65)', fontSize:12, margin:'2px 0 0' }}>
                {monthLabel} {year}
                {bulk && totalCards > 0 && ` · ${totalCards} موظف`}
              </p>
            </div>
          </div>

          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            {/* Zoom */}
            <div style={{ display:'flex', alignItems:'center', gap:4 }}>
              <button onClick={() => { zoomTouchedRef.current = true; setZoom(z => Math.max(40, z - 10)); }} style={btnStyle('#fff', 'transparent')}>
                <ZoomOut style={{ width:15, height:15 }} />
              </button>
              <span style={{ color:'rgba(255,255,255,0.8)', fontSize:11.5, fontFamily:'Consolas', minWidth:36, textAlign:'center' }}>
                {zoom}%
              </span>
              <button onClick={() => { zoomTouchedRef.current = true; setZoom(z => Math.min(160, z + 10)); }} style={btnStyle('#fff', 'transparent')}>
                <ZoomIn style={{ width:15, height:15 }} />
              </button>
            </div>

            <div style={{ width:1, height:24, background:'rgba(255,255,255,0.2)' }} />

            {/* Actions */}
            <button onClick={exportExcel} style={btnStyle('#34d399', 'rgba(16,185,129,0.15)')} title="تصدير Excel">
              <FileSpreadsheet style={{ width:15, height:15 }} />
              <span style={{ fontSize:11.5, marginRight:4 }}>Excel</span>
            </button>
            <button onClick={handlePDF} style={btnStyle('#f87171', 'rgba(239,68,68,0.15)')} title="تصدير PDF">
              <FileText style={{ width:15, height:15 }} />
              <span style={{ fontSize:11.5, marginRight:4 }}>PDF</span>
            </button>
            <button onClick={handlePrint} style={btnStyle('#60a5fa', 'rgba(96,165,250,0.15)')} title="طباعة">
              <Printer style={{ width:15, height:15 }} />
              <span style={{ fontSize:11.5, marginRight:4 }}>طباعة</span>
            </button>
            <button onClick={onClose} style={btnStyle('rgba(255,255,255,0.6)', 'transparent')}>
              <X style={{ width:17, height:17 }} />
            </button>
          </div>
        </div>

        {/* ── Body ─────────────────────────────────────────────────────────── */}
        <div style={{
          flex:1, overflowY:'auto', overflowX:'auto',
          padding:'24px', background:'#9ca3af22',
          display:'flex', justifyContent:'center',
        }}>
          {loading ? (
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
              gap:14, height:'100%', color:'var(--text-3)' }}>
              <Loader2 style={{ width:32, height:32, animation:'spin 1s linear infinite' }} />
              <p style={{ fontSize:14, fontWeight:600 }}>جاري تحميل كشف الراتب...</p>
            </div>
          ) : !hasData ? (
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
              gap:12, height:'100%', color:'var(--text-3)' }}>
              <AlertCircle style={{ width:40, height:40, opacity:0.4 }} />
              <p style={{ fontSize:14, fontWeight:600 }}>لا توجد بيانات رواتب لهذا الشهر</p>
              <p style={{ fontSize:12 }}>يرجى احتساب المرتبات أولاً ثم المحاولة</p>
            </div>
          ) : (
            <div ref={printRef} style={{ zoom: zoom/100 }}>
              {bulk
                ? <CompactSalarySheet sheets={bulkData} monthLabel={monthLabel} year={year} />
                : <SalaryCard data={data} />}
            </div>
          )}
        </div>

        {/* ── Footer — bulk summary ────────────────────────────────────────── */}
        {bulk && totalCards > 0 && (
          <div style={{
            padding:'8px 20px', borderTop:'1px solid var(--border)',
            background:'var(--surface)', flexShrink:0,
            display:'flex', alignItems:'center', justifyContent:'space-between',
            fontSize:12, color:'var(--text-3)',
          }}>
            <span style={{ fontWeight:600 }}>{totalCards} موظف · {Math.ceil(totalCards / PER_PAGE)} صفحة A4</span>
            <span>٩ موظفين في كل صفحة — صُمّم للطباعة الجماعية</span>
          </div>
        )}
      </div>

      <style>{`@keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }`}</style>
    </>
  );
}

function btnStyle(color, bg) {
  return {
    display:'flex', alignItems:'center', padding:'6px 10px', borderRadius:8,
    border:'none', cursor:'pointer', background:bg, color, transition:'all 0.15s',
  };
}
