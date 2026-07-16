/**
 * PrintPreviewModal — PETSHROW unified print / export dialog.
 * Live A4 preview (real Chromium-rendered HTML) → Print / PDF / Excel.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Printer, FileText, FileSpreadsheet,
  ZoomIn, ZoomOut, RotateCcw, Loader2, RectangleHorizontal, RectangleVertical,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useTheme } from '../contexts/ThemeContext';
import { printHTML, exportToPDF, exportToExcel, buildReportHTML } from '../lib/printUtils';
import { useCompanyBrand } from '../lib/branding';
import { fmtTime, fmtMoney, fmtOTHours, fmtMinutes, fmtPenaltyUnits, fmtOvertimeUnits, fmtWorkedHours, fmtIntZero, fmtDec, STATUS_LABELS, displayNetSalary } from '../lib/formatters';

const STATUS_TD = r => {
  const m = { present:'status-present', late:'status-late', absent:'status-absent',
              weekend:'status-weekend', holiday:'status-holiday', early_leave:'status-late' };
  return m[r.status] || '';
};

// ── Column presets by report type ─────────────────────────────────────────────
export const REPORT_COLUMNS = {
  attendance_daily: [
    { header: 'الكود',         key: 'employeeCode',      thStyle: 'width:60px' },
    { header: 'اسم الموظف',   key: 'employeeName',      thStyle: 'width:195px' },
    { header: 'القسم',         key: 'department',        thStyle: 'width:140px' },
    { header: 'الحضور',        key: 'checkIn',  format: v => fmtTime(v), align:'num', thStyle: 'width:92px' },
    { header: 'الانصراف',     key: 'checkOut', format: v => fmtTime(v), align:'num', thStyle: 'width:92px' },
    { header: 'خصم التأخير',   key: 'effectiveLatePenalty', format: v => fmtPenaltyUnits(v),
      tdClass: r => (r.effectiveLatePenalty||0) > 0 ? 'num amber' : 'num muted', total:'sum', thStyle: 'width:86px' },
    { header: 'الإضافي',      key: 'effectiveOvertimeUnits', format: v => fmtOvertimeUnits(v),
      tdClass: r => (r.effectiveOvertimeUnits||0) > 0 ? 'num green' : 'num muted', total:'sum', thStyle: 'width:85px' },
    { header: 'وقت الإضافي الفعلي', key: 'overtimeHours', format: v => fmtOTHours(v),
      tdClass: () => 'num muted', thStyle: 'width:100px' },
    { header: 'خصم الانصراف المبكر',  key: 'effectiveEarlyPenalty', format: v => fmtPenaltyUnits(v),
      tdClass: r => (r.effectiveEarlyPenalty||0) > 0 ? 'num amber' : 'num muted', thStyle: 'width:115px' },
    { header: 'الحالة',        key: 'status', format: v => STATUS_LABELS[v]?.ar || v || '—',
      tdClass: STATUS_TD, thStyle: 'width:103px' },
  ],

  attendance_daily_absent: [
    { header: 'الكود',       key: 'employeeCode', thStyle: 'width:65px' },
    { header: 'اسم الموظف', key: 'employeeName',  thStyle: 'width:185px' },
    { header: 'القسم',       key: 'department',   thStyle: 'width:155px' },
    { header: 'الفرع',       key: 'branch',       thStyle: 'width:130px' },
    { header: 'الحالة',      key: 'status', format: v => STATUS_LABELS[v]?.ar || 'غائب',
      tdClass: () => 'status-absent', thStyle: 'width:100px' },
  ],

  attendance_daily_late: [
    { header: 'الكود',         key: 'employeeCode', thStyle: 'width:65px' },
    { header: 'اسم الموظف',   key: 'employeeName',  thStyle: 'width:195px' },
    { header: 'القسم',         key: 'department',   thStyle: 'width:155px' },
    { header: 'وقت الحضور',   key: 'checkIn',      format: v => fmtTime(v), align:'num', thStyle: 'width:92px' },
    { header: 'خصم التأخير', key: 'effectiveLatePenalty',  format: v => fmtPenaltyUnits(v),
      tdClass: () => 'num amber', thStyle: 'width:100px', total:'sum' },
  ],

  attendance_daily_overtime: [
    { header: 'الكود',       key: 'employeeCode', thStyle: 'width:65px' },
    { header: 'اسم الموظف', key: 'employeeName',  thStyle: 'width:185px' },
    { header: 'القسم',       key: 'department',   thStyle: 'width:150px' },
    { header: 'الحضور',      key: 'checkIn',      format: v => fmtTime(v), align:'num', thStyle: 'width:92px' },
    { header: 'الانصراف',   key: 'checkOut',      format: v => fmtTime(v), align:'num', thStyle: 'width:92px' },
    { header: 'الإضافي', key: 'effectiveOvertimeUnits', format: v => fmtOvertimeUnits(v),
      tdClass: () => 'num green', thStyle: 'width:90px', total:'sum' },
    { header: 'وقت الإضافي الفعلي', key: 'overtimeHours', format: v => fmtOTHours(v),
      tdClass: () => 'num muted', thStyle: 'width:110px' },
  ],

  attendance_dashboard: [
    { header: 'الكود',        key: 'employeeCode',           thStyle: 'width:55px' },
    { header: 'اسم الموظف',  key: 'employeeName',           thStyle: 'width:145px' },
    { header: 'القسم',        key: 'department',             thStyle: 'width:105px' },
    { header: 'الحضور',       key: 'checkIn',  format: v => fmtTime(v), align:'num', thStyle: 'width:92px' },
    { header: 'الانصراف',    key: 'checkOut', format: v => fmtTime(v), align:'num', thStyle: 'width:92px' },
    { header: 'خصم التأخير', key: 'effectiveLatePenalty', format: v => fmtPenaltyUnits(v),
      tdClass: r => (r.effectiveLatePenalty||0) > 0 ? 'num amber' : 'num muted', thStyle: 'width:88px', total:'sum' },
    { header: 'الإضافي',     key: 'effectiveOvertimeUnits', format: v => fmtOvertimeUnits(v),
      tdClass: r => (r.effectiveOvertimeUnits||0) > 0 ? 'num green' : 'num muted', thStyle: 'width:80px', total:'sum' },
    { header: 'الحالة',       key: 'status', format: v => STATUS_LABELS[v]?.ar || v || '—',
      tdClass: STATUS_TD, thStyle: 'width:72px' },
  ],

  attendance_monthly: [
    { header: 'الكود',           key: 'employeeCode', thStyle: 'width:58px' },
    { header: 'اسم الموظف',     key: 'employeeName',  thStyle: 'width:140px' },
    { header: 'القسم',           key: 'department',   thStyle: 'width:110px' },
    { header: 'الفرع',           key: 'branch',       thStyle: 'width:100px' },
    { header: 'أيام الحضور',    key: 'workDays',     format: v => fmtIntZero(v),
      tdClass: () => 'num green', thStyle: 'width:72px', total:'sum' },
    { header: 'أيام الغياب',    key: 'absentDays',   format: v => fmtIntZero(v),
      tdClass: r => (r.absentDays||0) > 0 ? 'num red' : 'num muted', thStyle: 'width:72px', total:'sum' },
    { header: 'إجمالي الساعات', key: 'totalHours',   format: v => v ? `${Number(v).toFixed(1)}` : '—',
      tdClass: () => 'num', thStyle: 'width:84px', total:'sum' },
    { header: 'الإضافي',  key: 'totalEffectiveOvertimeUnits', format: v => fmtOvertimeUnits(v),
      tdClass: r => (r.totalEffectiveOvertimeUnits||0) > 0 ? 'num green' : 'num muted', thStyle: 'width:80px', total:'sum' },
    { header: 'وقت الإضافي الفعلي', key: 'totalOvertimeHours', format: v => fmtOTHours(v),
      tdClass: () => 'num muted', thStyle: 'width:90px' },
    { header: 'خصم التأخير',    key: 'totalEffectiveLatePenalty',  format: v => fmtPenaltyUnits(v),
      tdClass: r => (r.totalEffectiveLatePenalty||0) > 0 ? 'num amber' : 'num muted', thStyle: 'width:84px', total:'sum' },
    { header: 'خصم الانصراف المبكر', key: 'totalEffectiveEarlyPenalty', format: v => fmtPenaltyUnits(v),
      tdClass: r => (r.totalEffectiveEarlyPenalty||0) > 0 ? 'num amber' : 'num muted', thStyle: 'width:84px', total:'sum' },
    { header: 'إجمالي الخصومات', key: 'totalEffectiveDeductionUnits', format: v => fmtPenaltyUnits(v),
      tdClass: r => (r.totalEffectiveDeductionUnits||0) > 0 ? 'num red' : 'num muted', thStyle: 'width:90px', total:'sum' },
  ],

  // Field set matches the canonical GET /api/payroll response 1:1 (see
  // backend/src/routes/payroll.js — computePayroll() overlay). employee.department/
  // employee.position and separate latePenalty/penaltyUnits columns were removed:
  // the route never selects/returns those fields (employee is `{code, name}` only,
  // and only the aggregate `deductions` total is computed here, not a late-only
  // split) — referencing them rendered permanently blank columns.
  // EP-022 Phase 7: column order mirrors PayrollPage's grid exactly — كود،
  // اسم الموظف، الراتب الأساسي، أجر الساعة، أيام الحضور، الغياب، ساعات
  // الإضافي، قيمة الإضافي، ساعات الخصم، الخصومات، السلف، الخصم الإداري،
  // صافي المرتب (13 canonical columns). أجر الساعة/hourlyRate and ساعات
  // الخصم/penaltyUnits were previously missing from print entirely — added
  // here, sourced from the same computePayroll()-overlaid GET /payroll
  // fields the grid already renders, no new calculation. المستحقات isn't
  // among the 13 canonical columns — kept, appended after صافي الراتب
  // rather than interleaved.
  payroll: [
    { header: 'الكود',           key: 'employee.code',            thStyle: 'width:48px' },
    { header: 'اسم الموظف',     key: 'employee.name',            thStyle: 'width:130px' },
    { header: 'الراتب الأساسي', key: 'basicSalary',    format: v => fmtMoney(v), tdClass: ()=>'num', thStyle:'width:82px', total:'sum' },
    { header: 'أجر الساعة',      key: 'hourlyRate',     format: v => fmtDec(v, 2),
      tdClass: () => 'num muted', thStyle: 'width:66px' },
    { header: 'أيام الحضور',    key: 'workDays',   format: v => fmtIntZero(v),
      tdClass: () => 'num green', thStyle: 'width:64px', total:'sum' },
    { header: 'الغياب',          key: 'absentDays', format: v => fmtIntZero(v),
      tdClass: r => (r.absentDays||0)>0 ? 'num red':'num muted', thStyle:'width:56px', total:'sum' },
    { header: 'ساعات الإضافي',  key: 'overtimeHours',  format: v => fmtOTHours(v),
      tdClass: r=>(r.overtimeHours||0)>0?'num green':'num muted', thStyle:'width:74px', total:'sum' },
    { header: 'قيمة الإضافي',   key: 'overtimeAmount', format: v => fmtMoney(v),
      tdClass: r=>(r.overtimeAmount||0)>0?'num green':'num muted', thStyle:'width:78px', total:'sum' },
    { header: 'ساعات الخصم',     key: 'penaltyUnits',   format: v => fmtPenaltyUnits(v),
      tdClass: r=>(r.penaltyUnits||0)>0?'num red':'num muted', thStyle:'width:70px', total:'sum' },
    { header: 'إجمالي الخصومات', key: 'deductions',   format: v => fmtMoney(v),
      tdClass: r=>(r.deductions||0)>0?'num red':'num muted', thStyle:'width:78px', total:'sum' },
    { header: 'السلف',           key: 'advances',      format: v => (v||0)>0 ? fmtMoney(v):'—',
      tdClass: r=>(r.advances||0)>0?'num red':'num muted', thStyle:'width:66px', total:'sum' },
    { header: 'خصم يدوي إضافي', key: 'manualDeductionAdjustment', format: v => (v||0)>0 ? fmtMoney(v):'—',
      tdClass: r=>(r.manualDeductionAdjustment||0)>0?'num red':'num muted', thStyle:'width:78px', total:'sum' },
    // EF-019.1: per-row cell uses the shared displayNetSalary() helper (same
    // as every other payroll consumer); the footer's `total:'sum'` still sums
    // the raw exact values and rounds once — the correct pattern for a grand
    // total, left unchanged.
    { header: 'صافي الراتب',    key: 'netSalary',      format: v => fmtMoney(displayNetSalary(v)),
      tdClass: ()=>'num green', thStyle:'width:82px', total:'sum' },
    { header: 'المستحقات',       key: 'grossEntitlements', format: v => fmtMoney(v),
      tdClass: ()=>'num green', thStyle:'width:80px', total:'sum' },
  ],

  movement: [
    { header: 'الكود',       key: 'employeeCode', thStyle: 'width:65px' },
    { header: 'اسم الموظف', key: 'employeeName',  thStyle: 'width:150px' },
    { header: '#',           key: 'dayNum',       align:'num', thStyle: 'width:30px' },
    { header: 'التاريخ',     key: 'date',         align:'num', thStyle: 'width:85px' },
    { header: 'اليوم',       key: 'dayName',      thStyle: 'width:70px' },
    { header: 'الحضور',      key: 'checkIn',      format: v => v || '—', align:'num', thStyle: 'width:72px' },
    { header: 'الانصراف',   key: 'checkOut',      format: v => v || '—', align:'num', thStyle: 'width:72px' },
    { header: 'خصم تأخير',   key: 'effectiveLatePenalty',  format: v => fmtPenaltyUnits(v),
      tdClass: r=>(r.effectiveLatePenalty||0)>0?'num amber':'num muted', thStyle:'width:70px', total:'sum' },
    { header: 'خصم انصراف',  key: 'effectiveEarlyPenalty', format: v => fmtPenaltyUnits(v),
      tdClass: r=>(r.effectiveEarlyPenalty||0)>0?'num amber':'num muted', thStyle:'width:87px', total:'sum' },
    { header: 'إجمالي الخصم', key: 'effectiveTotalDeductions', format: v => fmtPenaltyUnits(v),
      tdClass: r=>(r.effectiveTotalDeductions||0)>0?'num red':'num muted', thStyle:'width:80px', total:'sum' },
    { header: 'إجمالي الإضافي', key: 'totalOT', format: v => fmtOTHours(v),
      tdClass: r=>(r.totalOT||0)>0?'num green':'num muted', thStyle:'width:100px', total:'sum' },
    { header: 'الحالة',      key: 'status', format: v => STATUS_LABELS[v]?.ar || v || '—',
      tdClass: STATUS_TD, thStyle:'width:98px' },
  ],

  adjustments: [
    { header: 'الكود',       key: 'employee.code',            thStyle:'width:58px' },
    { header: 'اسم الموظف', key: 'employee.name',            thStyle:'width:150px' },
    { header: 'القسم',       key: 'employee.department.name', thStyle:'width:110px' },
    { header: 'التاريخ',     key: 'date',                     align:'num', thStyle:'width:85px' },
    { header: 'الحضور',      key: 'checkIn',                  format: v => fmtTime(v), align:'num', thStyle:'width:92px' },
    { header: 'الانصراف',   key: 'checkOut',                 format: v => fmtTime(v), align:'num', thStyle:'width:92px' },
    { header: 'التأخير',     key: 'lateMinutes',              format: v => fmtMinutes(v),
      tdClass: r=>(r.lateMinutes||0)>0?'num amber':'num muted', thStyle:'width:70px' },
    { header: 'الإضافي',    key: 'overtimeHours',            format: v => fmtOTHours(v),
      tdClass: r=>(r.overtimeHours||0)>0?'num green':'num muted', thStyle:'width:70px' },
    { header: 'الحالة',      key: 'status',                   format: v => STATUS_LABELS[v]?.ar || v || '—',
      tdClass: STATUS_TD, thStyle:'width:78px' },
    { header: 'حالة التعديل', key: 'adjustment.status',
      format: (v, r) => ({ pending:'معلّق', approved:'معتمد', rejected:'مرفوض', auto_approved:'تلقائي' }[r.adjustment?.status] || '—'),
      tdClass: (r) => ({ approved:'status-present', rejected:'status-absent', pending:'status-late' }[r.adjustment?.status] || ''),
      thStyle:'width:80px',
    },
  ],

  raw_logs: [
    { header: 'رقم',         key: 'id',            tdClass:()=>'num muted', thStyle:'width:64px' },
    { header: 'الموظف',      key: 'employee.name', thStyle:'width:160px' },
    { header: 'الجهاز',      key: 'device.name',   thStyle:'width:130px' },
    { header: 'التاريخ والوقت', key: 'timestamp', align:'num',
      format: v => {
        if (!v) return '—';
        try {
          const d = new Date(v); const pad = n => String(n).padStart(2,'0');
          const h = d.getHours(), m = d.getMinutes();
          const ampm = h>=12?'PM':'AM'; const h12 = h>12?h-12:h===0?12:h;
          return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}  ${pad(h12)}:${pad(m)} ${ampm}`;
        } catch { return String(v); }
      }, thStyle:'width:140px',
    },
    { header: 'طريقة التحقق', key: 'verifyType',
      format: v => ({0:'كلمة مرور',1:'بصمة',2:'بطاقة',3:'بصمة + كلمة',4:'وجه',15:'غير معروف'}[v]||`النوع ${v}`),
      thStyle:'width:90px',
    },
  ],
};

export const REPORT_LABELS = {
  attendance_daily:          'تقرير الحضور اليومي',
  attendance_dashboard:      'تقرير الحضور اليومي',
  attendance_daily_absent:   'تقرير الغياب اليومي',
  attendance_daily_late:     'تقرير التأخيرات اليومي',
  attendance_daily_overtime: 'تقرير الإضافي اليومي',
  attendance_monthly:        'تقرير الحضور الشهري',
  payroll:                   'كشف المرتبات',
  movement:                  'تقرير حركة الموظفين',
  adjustments:               'تقرير التعديلات اليدوية',
  raw_logs:                  'سجلات البصمة',
};

// A4 content width @96dpi minus page margins (≈ template's printable area)
const A4_W = { portrait: 760, landscape: 1080 };

export default function PrintPreviewModal({
  isOpen, onClose, data = [],
  reportType = 'attendance_daily',
  customColumns = null, title = '', meta = {},
  orientation = 'landscape',
}) {
  const { isLight } = useTheme();
  const iframeRef = useRef();
  const wrapRef = useRef();
  const brand = useCompanyBrand();
  const [zoom, setZoom] = useState(orientation === 'landscape' ? 70 : 90);
  const [ori, setOri] = useState(orientation);
  const [activeReport, setActiveReport] = useState(reportType);
  const [pdfBusy, setPdfBusy] = useState(false);

  useEffect(() => { if (isOpen) { setActiveReport(reportType); setOri(orientation); } }, [isOpen, reportType, orientation]);

  // ── Auto-fit width ────────────────────────────────────────────────────────
  // Instead of a fixed 70%/90% default that leaves large gray gaps around a
  // tiny page on wide screens, measure the actual preview area and pick a zoom
  // that makes the A4 sheet use the real available width (clamped 40–150%).
  const fitToWidth = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const available = el.clientWidth - 48; // minus horizontal scroll-area padding
    if (available <= 0) return;
    const pct = Math.floor((available / A4_W[ori]) * 100);
    setZoom(Math.min(150, Math.max(40, pct)));
  }, [ori]);

  useEffect(() => {
    if (!isOpen) return;
    fitToWidth();
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => fitToWidth());
    ro.observe(el);
    return () => ro.disconnect();
  }, [isOpen, ori, fitToWidth]);

  const columns = customColumns || REPORT_COLUMNS[activeReport] || REPORT_COLUMNS.attendance_daily;
  const reportTitle = title || REPORT_LABELS[activeReport] || 'تقرير';

  const filteredData = useMemo(() => {
    switch (activeReport) {
      case 'attendance_daily_absent':   return data.filter(r => r.isAbsent || r.status === 'absent');
      case 'attendance_daily_late':     return data.filter(r => (r.effectiveLatePenalty || 0) > 0);
      case 'attendance_daily_overtime': return data.filter(r => (r.effectiveOvertimeUnits || 0) > 0);
      case 'attendance_dashboard':      return data;
      default: return data;
    }
  }, [data, activeReport]);

  const stats = useMemo(() => {
    if (activeReport.startsWith('attendance_daily') || activeReport === 'attendance_dashboard') {
      return [
        { label:'حاضر',  value: data.filter(r => ['present','late','early_leave'].includes(r.status)).length, color:'green' },
        { label:'غائب',  value: data.filter(r => r.isAbsent || r.status==='absent').length, color:'red' },
        { label:'متأخر', value: data.filter(r => (r.effectiveLatePenalty||0)>0).length, color:'amber' },
        { label:'إضافي', value: data.filter(r => (r.effectiveOvertimeUnits||0)>0).length, color:'purple' },
        { label:'الإجمالي', value: data.length, color:'blue' },
      ];
    }
    if (activeReport === 'payroll') {
      const sum = k => data.reduce((s,r)=>s+(r[k]||0),0);
      const gross = data.reduce((s,r)=>s+(r.basicSalary||0)+(r.overtimeAmount||0),0);
      return [
        { label:'عدد الموظفين',       value: data.length, color:'blue' },
        { label:'إجمالي المستحقات',   value: fmtMoney(gross), color:'green' },
        { label:'إجمالي الخصومات',    value: fmtMoney(sum('deductions')), color:'red' },
        { label:'إجمالي السلف',       value: fmtMoney(sum('advances')), color:'red' },
        { label:'إجمالي صافي الرواتب', value: fmtMoney(sum('netSalary')), color:'blue' },
      ];
    }
    if (activeReport === 'attendance_monthly') {
      const sum = k => data.reduce((s,r)=>s+(r[k]||0),0);
      return [
        { label:'عدد الموظفين',  value: data.length, color:'blue' },
        { label:'أيام حضور',     value: sum('workDays'), color:'green' },
        { label:'أيام غياب',     value: sum('absentDays'), color:'red' },
        { label:'ساعات إضافي',   value: fmtOTHours(sum('overtimeHours')), color:'purple' },
      ];
    }
    return null;
  }, [data, activeReport]);

  const previewHTML = useMemo(() => {
    if (!isOpen) return '';
    if (filteredData.length === 0)
      return '<p style="padding:40px;font-family:Cairo,sans-serif;direction:rtl;text-align:center;color:#64748b">لا توجد بيانات للعرض</p>';
    return buildReportHTML({
      title: reportTitle, columns, rows: filteredData,
      meta: { ...meta }, stats, orientation: ori, showSignatures: true, brand,
    });
  }, [isOpen, filteredData, columns, reportTitle, meta, stats, ori, brand]);

  // Write into iframe and auto-fit its height to content
  useEffect(() => {
    const ifr = iframeRef.current;
    if (!ifr || !previewHTML) return;
    const doc = ifr.contentDocument;
    if (!doc) return;
    doc.open(); doc.write(previewHTML); doc.close();
    const fit = () => { try { ifr.style.height = doc.body.scrollHeight + 'px'; } catch {} };
    const t = setTimeout(fit, 120);
    if (doc.fonts?.ready) doc.fonts.ready.then(fit).catch(()=>{});
    return () => clearTimeout(t);
  }, [previewHTML]);

  if (!isOpen) return null;

  const handlePrint = () => {
    const ifr = iframeRef.current;
    if (ifr?.contentWindow) {
      // Print directly from the already-rendered preview iframe — no window.open() needed.
      // This works in both Electron (no popup blocker issue) and browser.
      const go = () => { try { ifr.contentWindow.focus(); ifr.contentWindow.print(); } catch {} };
      const doc = ifr.contentDocument;
      if (doc?.fonts?.ready) doc.fonts.ready.then(go).catch(go);
      else setTimeout(go, 180);
    } else {
      printHTML(filteredData, columns, reportTitle, { ...meta, stats, orientation: ori, brand }, true);
    }
  };

  const handlePDF = async () => {
    setPdfBusy(true);
    const tid = toast.loading('جاري إنشاء ملف PDF...');
    try {
      const res = await exportToPDF(filteredData, columns, reportTitle, { ...meta, stats, brand }, ori);
      if (res?.ok && !res.fallback) toast.success('تم حفظ ملف PDF', { id: tid });
      else if (res?.fallback) toast.success('تم فتح نافذة الطباعة (اختر حفظ كـ PDF)', { id: tid });
      else if (res?.canceled) toast.dismiss(tid);
      else toast.error('تعذر إنشاء PDF', { id: tid });
    } catch {
      toast.error('تعذر إنشاء PDF', { id: tid });
    } finally { setPdfBusy(false); }
  };

  const handleExcel = async () => {
    await exportToExcel(filteredData, columns, reportTitle, reportTitle, { title: reportTitle, period: meta.period, branch: meta.branch, dept: meta.dept, brand });
    toast.success('تم تصدير ملف Excel');
  };

  const showSubTabs = reportType === 'attendance_daily' || reportType === 'attendance_dashboard';
  const allTabKey   = reportType === 'attendance_dashboard' ? 'attendance_dashboard' : 'attendance_daily';
  const tbBtn = { background:'rgba(255,255,255,0.08)', border:'none', borderRadius:6, color:'#bfdbfe', cursor:'pointer', padding:'5px 8px', display:'flex', alignItems:'center' };

  return (
    <div style={{ position:'fixed', inset:0, zIndex:9999, background:'rgba(8,12,22,0.78)', display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={e => e.target === e.currentTarget && onClose()} dir="rtl">
      <div style={{
        width:'94vw', height:'94vh', background: isLight ? '#eef2f8' : '#0a0f1a',
        borderRadius:10, border: isLight ? '1px solid #cbd5e1' : '1px solid #233047',
        display:'flex', flexDirection:'column', overflow:'hidden', boxShadow:'0 30px 70px rgba(0,0,0,0.55)',
      }}>
        {/* Toolbar */}
        <div style={{ padding:'9px 14px', background:'#0f2444', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <div style={{ width:26, height:26, borderRadius:6, background:'linear-gradient(135deg,#3b82f6,#1d4ed8)', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:900, color:'#fff', fontSize:15 }}>P</div>
            <span style={{ color:'#fff', fontWeight:700, fontSize:14 }}>{reportTitle}</span>
            <span style={{ background:'rgba(59,130,246,0.2)', color:'#93c5fd', padding:'2px 8px', borderRadius:99, fontSize:11, border:'1px solid rgba(59,130,246,0.3)' }}>
              {filteredData.length} سجل
            </span>
          </div>

          <div style={{ display:'flex', alignItems:'center', gap:7 }}>
            {/* Orientation */}
            <button onClick={() => setOri('portrait')}  title="عمودي"  style={{ ...tbBtn, color: ori==='portrait'  ? '#60a5fa' : '#64748b', background: ori==='portrait'  ? 'rgba(96,165,250,0.15)' : tbBtn.background }}><RectangleVertical style={{ width:15, height:15 }} /></button>
            <button onClick={() => setOri('landscape')} title="أفقي"   style={{ ...tbBtn, color: ori==='landscape' ? '#60a5fa' : '#64748b', background: ori==='landscape' ? 'rgba(96,165,250,0.15)' : tbBtn.background }}><RectangleHorizontal style={{ width:15, height:15 }} /></button>
            <div style={{ width:1, height:18, background:'rgba(255,255,255,0.12)', margin:'0 3px' }} />
            {/* Zoom */}
            <button onClick={() => setZoom(z => Math.max(40, z-10))} style={tbBtn}><ZoomOut style={{ width:14, height:14 }} /></button>
            <span style={{ color:'#93c5fd', fontSize:12, minWidth:34, textAlign:'center' }}>{zoom}%</span>
            <button onClick={() => setZoom(z => Math.min(150, z+10))} style={tbBtn}><ZoomIn style={{ width:14, height:14 }} /></button>
            <button onClick={fitToWidth} title="ملائمة العرض" style={tbBtn}><RotateCcw style={{ width:13, height:13 }} /></button>
            <div style={{ width:1, height:18, background:'rgba(255,255,255,0.12)', margin:'0 3px' }} />
            {/* Exports */}
            <button onClick={handleExcel} style={{ display:'flex', alignItems:'center', gap:6, background:'rgba(16,185,129,0.15)', border:'1px solid rgba(16,185,129,0.35)', color:'#34d399', borderRadius:7, cursor:'pointer', padding:'6px 12px', fontSize:12, fontWeight:700 }}>
              <FileSpreadsheet style={{ width:14, height:14 }} /> Excel
            </button>
            <button onClick={handlePDF} disabled={pdfBusy} style={{ display:'flex', alignItems:'center', gap:6, background:'rgba(239,68,68,0.15)', border:'1px solid rgba(239,68,68,0.35)', color:'#f87171', borderRadius:7, cursor:'pointer', padding:'6px 12px', fontSize:12, fontWeight:700, opacity: pdfBusy?0.6:1 }}>
              {pdfBusy ? <Loader2 style={{ width:14, height:14, animation:'spin 1s linear infinite' }} /> : <FileText style={{ width:14, height:14 }} />} PDF
            </button>
            <button onClick={handlePrint} style={{ display:'flex', alignItems:'center', gap:6, background:'#2563eb', border:'none', color:'#fff', borderRadius:7, cursor:'pointer', padding:'6px 14px', fontSize:12, fontWeight:700 }}>
              <Printer style={{ width:14, height:14 }} /> طباعة
            </button>
            <button onClick={onClose} style={{ background:'rgba(255,255,255,0.06)', border:'none', borderRadius:6, color:'#94a3b8', cursor:'pointer', padding:'6px 8px' }}>
              <X style={{ width:16, height:16 }} />
            </button>
          </div>
        </div>

        {/* Sub-report tabs */}
        {showSubTabs && (
          <div style={{ display:'flex', gap:4, padding:'7px 14px', background: isLight ? '#fff' : '#0b1220', borderBottom: isLight ? '1px solid #e2e8f0' : '1px solid #1a2435', flexShrink:0, overflowX:'auto' }}>
            {[
              { key:allTabKey,                    label:'جميع الموظفين' },
              { key:'attendance_daily_absent',   label:'الغائبون',  n:data.filter(r=>r.isAbsent||r.status==='absent').length },
              { key:'attendance_daily_late',     label:'المتأخرون', n:data.filter(r=>(r.effectiveLatePenalty||0)>0).length },
              { key:'attendance_daily_overtime', label:'الإضافي',   n:data.filter(r=>(r.effectiveOvertimeUnits||0)>0).length },
            ].map(tab => (
              <button key={tab.key} onClick={() => setActiveReport(tab.key)}
                style={{
                  padding:'5px 13px', borderRadius:6, fontSize:12, fontWeight:600, cursor:'pointer', whiteSpace:'nowrap',
                  border: activeReport===tab.key ? '1px solid #2563eb' : isLight ? '1px solid #e2e8f0' : '1px solid #233047',
                  background: activeReport===tab.key ? 'rgba(37,99,235,0.14)' : 'transparent',
                  color: activeReport===tab.key ? '#3b82f6' : isLight ? '#475569' : '#94a3b8',
                }}>
                {tab.label}{tab.n != null && <span style={{ marginRight:5, background:'rgba(59,130,246,0.18)', color:'#60a5fa', padding:'1px 6px', borderRadius:99, fontSize:10 }}>{tab.n}</span>}
              </button>
            ))}
          </div>
        )}

        {/* Preview — auto-fit width: the wrapper measures its real area and
            picks a zoom that fills it (fitToWidth), so the page uses the
            actual available space instead of floating tiny inside a big gray
            canvas. The outer box width tracks the scaled page exactly so
            `margin:auto` centers it with no leftover gutters. */}
        <div ref={wrapRef} style={{ flex:1, overflow:'auto', padding:'18px 24px', background: isLight ? '#cdd5e3' : '#05080f' }}>
          <div style={{ width: Math.round(A4_W[ori] * zoom/100), margin:'0 auto', transition:'width 0.15s' }}>
            <div style={{ width:A4_W[ori], transform:`scale(${zoom/100})`, transformOrigin:'top right', background:'#fff', boxShadow:'0 6px 30px rgba(0,0,0,0.4)', borderRadius:2 }}>
              <iframe ref={iframeRef} title="preview" scrolling="no"
                style={{ width:'100%', minHeight:400, border:'none', display:'block' }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
