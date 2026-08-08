/**
 * PrintPreviewModal — PETSHROW unified print / export dialog.
 * Live A4 preview (real Chromium-rendered HTML) → Print / PDF / Excel.
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  X, Printer, FileText, FileSpreadsheet,
  ZoomIn, ZoomOut, Maximize2, StretchHorizontal, Loader2,
  ChevronRight, ChevronLeft, PanelLeftClose, PanelLeft, PanelRightClose, PanelRight,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useTheme } from '../contexts/ThemeContext';
import { printHTML, exportToPDF, exportToExcel, buildReportHTML } from '../lib/printUtils';
import { useCompanyBrand } from '../lib/branding';
import { PAPER_MM, MARGIN_PRESETS, MM_TO_PX } from '../lib/printDesignSystem';
import { fmtTime, fmtMoney, fmtOTHours, fmtMinutes, fmtPenaltyUnits, fmtOvertimeUnits, fmtWorkedHours, fmtIntZero, fmtDec, STATUS_LABELS, displayNetSalary } from '../lib/formatters';
import PrintSettingsSidebar from './print/PrintSettingsSidebar';
import PrintThumbnails from './print/PrintThumbnails';
import { useFocusTrap } from '../hooks/useFocusTrap';

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
  // fields the grid already renders, no new calculation.
  // المستحقات/grossEntitlements is intentionally OMITTED from this print-only
  // column set (Portrait A4 layout spec) — it stays fully available on the
  // Payroll screen grid, Excel export, API, and business logic, all of which
  // read PayrollPage's own grid column defs, never this array.
  // `priority` overrides columnLayoutEngine.js's generic name/code pattern
  // classifier — a payroll report has domain-specific tiers a generic
  // key/header regex can't infer (e.g. `employee.code` would otherwise match
  // the generic "code$" LOW pattern, but a payroll report always needs the
  // employee code visible): high = always-visible identity/pay figures,
  // medium = overtime/late/deduction figures, low = informational/optional.
  // `minPx` overrides the tier's blanket legibility floor (95px for 'high',
  // tuned for a full employee name) with this column's OWN actual minimum —
  // a code, a day count, or a money figure never needs a full name's width,
  // and letting every 'high' column claim 95px regardless of content starves
  // the medium-tier columns (Overtime/Deductions) of budget they need far
  // more, forcing needless hiding of columns the spec calls out as
  // Priority 2. Employee Name has no override — it keeps the full 95px
  // floor and, per spec, the largest share of whatever width remains.
  payroll: [
    { header: 'الكود',           key: 'employee.code',            thStyle: 'width:48px', priority: 'high', minPx: 50 },
    { header: 'اسم الموظف',     key: 'employee.name',            thStyle: 'width:130px', priority: 'high' },
    { header: 'الراتب الأساسي', key: 'basicSalary',    format: v => fmtMoney(v), tdClass: ()=>'num', thStyle:'width:82px', total:'sum', priority: 'high', minPx: 72 },
    { header: 'أجر الساعة',      key: 'hourlyRate',     format: v => fmtDec(v, 2),
      tdClass: () => 'num muted', thStyle: 'width:66px', priority: 'low' },
    { header: 'أيام الحضور',    key: 'workDays',   format: v => fmtIntZero(v),
      tdClass: () => 'num green', thStyle: 'width:64px', total:'sum', priority: 'high', minPx: 52 },
    { header: 'الغياب',          key: 'absentDays', format: v => fmtIntZero(v),
      tdClass: r => (r.absentDays||0)>0 ? 'num red':'num muted', thStyle:'width:56px', total:'sum', priority: 'high', minPx: 50 },
    { header: 'ساعات الإضافي',  key: 'overtimeHours',  format: v => fmtOTHours(v),
      tdClass: r=>(r.overtimeHours||0)>0?'num green':'num muted', thStyle:'width:74px', total:'sum', priority: 'medium' },
    { header: 'قيمة الإضافي',   key: 'overtimeAmount', format: v => fmtMoney(v),
      tdClass: r=>(r.overtimeAmount||0)>0?'num green':'num muted', thStyle:'width:78px', total:'sum', priority: 'medium' },
    { header: 'ساعات الخصم',     key: 'penaltyUnits',   format: v => fmtPenaltyUnits(v),
      tdClass: r=>(r.penaltyUnits||0)>0?'num red':'num muted', thStyle:'width:70px', total:'sum', priority: 'medium' },
    { header: 'إجمالي الخصومات', key: 'deductions',   format: v => fmtMoney(v),
      tdClass: r=>(r.deductions||0)>0?'num red':'num muted', thStyle:'width:78px', total:'sum', priority: 'medium' },
    { header: 'السلف',           key: 'advances',      format: v => (v||0)>0 ? fmtMoney(v):'—',
      tdClass: r=>(r.advances||0)>0?'num red':'num muted', thStyle:'width:66px', total:'sum', priority: 'low' },
    { header: 'خصم يدوي إضافي', key: 'manualDeductionAdjustment', format: v => (v||0)>0 ? fmtMoney(v):'—',
      tdClass: r=>(r.manualDeductionAdjustment||0)>0?'num red':'num muted', thStyle:'width:78px', total:'sum', priority: 'low' },
    // EF-019.1: per-row cell uses the shared displayNetSalary() helper (same
    // as every other payroll consumer); the footer's `total:'sum'` still sums
    // the raw exact values and rounds once — the correct pattern for a grand
    // total, left unchanged.
    { header: 'صافي الراتب',    key: 'netSalary',      format: v => fmtMoney(displayNetSalary(v)),
      tdClass: ()=>'num green', thStyle:'width:82px', total:'sum', priority: 'high', minPx: 72 },
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

// ── Enterprise Summary Strip — curated headline metrics per report type ────
// Each entry is a REPORT_COLUMNS `key` (reusing that column's own already-
// computed total, see buildReportHTML's summaryKeys param) or the sentinel
// '__absence' (the status column's already-computed absent-row count). No
// new figures — every one of these already exists as a column total or the
// status breakdown above it. Report types not listed here fall back to
// buildReportHTML's generic default (every totaled column + absence).
const SUMMARY_KEYS = {
  attendance_daily: [
    { key: '__absence',             label: 'إجمالي الغياب' },
    { key: 'effectiveLatePenalty',  label: 'إجمالي خصم التأخير' },
    { key: 'effectiveOvertimeUnits', label: 'إجمالي الإضافي' },
  ],
  attendance_dashboard: [
    { key: '__absence',             label: 'إجمالي الغياب' },
    { key: 'effectiveLatePenalty',  label: 'إجمالي خصم التأخير' },
    { key: 'effectiveOvertimeUnits', label: 'إجمالي الإضافي' },
  ],
  attendance_monthly: [
    { key: 'absentDays',                    label: 'إجمالي أيام الغياب' },
    { key: 'totalEffectiveOvertimeUnits',   label: 'إجمالي ساعات الإضافي' },
    { key: 'totalEffectiveDeductionUnits',  label: 'إجمالي الخصومات' },
  ],
  movement: [
    { key: '__absence',              label: 'إجمالي أيام الغياب' },
    { key: 'totalOT',                label: 'إجمالي ساعات الإضافي' },
    { key: 'effectiveTotalDeductions', label: 'إجمالي ساعات الخصم' },
  ],
  payroll: [
    { key: '__count',       label: 'إجمالي الموظفين' },
    { key: 'netSalary',     label: 'إجمالي الرواتب' },
    { key: 'deductions',    label: 'إجمالي الخصومات' },
    { key: 'overtimeAmount', label: 'إجمالي الإضافي' },
  ],
};

// ── Page geometry ────────────────────────────────────────────────────────────
// Real paper dimensions (mm) so "Paper Size"/"Margins" in the settings
// sidebar are genuine — PAPER_MM/MARGIN_PRESETS/MM_TO_PX are imported from
// printDesignSystem.js, the same source reportTemplate.js's @page rule reads,
// so the preview always matches what prints (previously two hand-copied
// constant tables that had to be kept in sync by convention only).
function computePageBoxPx(paperSize, isLand, marginsKey) {
  const paper = PAPER_MM[paperSize] || PAPER_MM.A4;
  const m     = MARGIN_PRESETS[marginsKey] || MARGIN_PRESETS.normal;
  const fullW = isLand ? paper.h : paper.w;
  const fullH = isLand ? paper.w : paper.h;
  return {
    pageWidthPx:  Math.round((fullW - 2 * m.h) * MM_TO_PX),
    pageHeightPx: Math.round((fullH - 2 * m.v) * MM_TO_PX),
  };
}

const DEFAULT_SETTINGS = {
  paperSize: 'A4', margins: 'normal', scalePercent: 100,
  showHeaderFooter: true, repeatHeader: true, printBackground: true,
  showSignatures: true, watermarkEnabled: false, watermarkText: '', showStamp: false, copies: 1,
};

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
  const [zoom, setZoom] = useState(100);
  const [ori, setOri] = useState(orientation);
  const [activeReport, setActiveReport] = useState(reportType);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [contentHeightPx, setContentHeightPx] = useState(0);
  const [measurementReady, setMeasurementReady] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showThumbs, setShowThumbs] = useState(true);

  useEffect(() => {
    if (isOpen) { setActiveReport(reportType); setOri(orientation); setSettings(DEFAULT_SETTINGS); setCurrentPage(1); }
  }, [isOpen, reportType, orientation]);

  // Phase 13.9: accessible-dialog semantics — full-screen workspace variant,
  // not forced into the centered-card Dialog primitive per the audit's
  // explicit instruction. Only the shared focus-trap/restore/Escape engine
  // is applied; no visual layout change.
  const titleId = useId();
  const containerRef = useFocusTrap(isOpen);
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const { pageWidthPx, pageHeightPx } = useMemo(
    () => computePageBoxPx(settings.paperSize, ori === 'landscape', settings.margins),
    [settings.paperSize, settings.margins, ori]
  );
  // A trailing sliver of table border/margin (a few px) is not real content
  // to paginate — without this tolerance, Math.ceil turns any such sliver
  // into a whole phantom extra page whose thumbnail slice has nothing in
  // it (see PrintThumbnails root-cause note). The epsilon is only applied
  // to the LAST page's remainder, never subtracted from the full height —
  // otherwise genuine overflow of up to PAGE_REMAINDER_EPSILON_PX on the
  // final page would round down and vanish from the preview/thumbnail
  // count while Chromium's native @page pagination still prints it,
  // making the last printed page invisible in Print Preview.
  const PAGE_REMAINDER_EPSILON_PX = 6;
  const pageCount = Math.max(1, (() => {
    if (contentHeightPx <= 0 || pageHeightPx <= 0) return 1;
    const wholePages = Math.floor(contentHeightPx / pageHeightPx);
    const remainderPx = contentHeightPx - wholePages * pageHeightPx;
    if (remainderPx <= 0) return wholePages;
    // Only a genuinely tiny remainder (a rendering sliver) is absorbed
    // into the last whole page; anything larger is real content and
    // gets its own page, matching what will actually print.
    return remainderPx <= PAGE_REMAINDER_EPSILON_PX ? Math.max(1, wholePages) : wholePages + 1;
  })());
  useEffect(() => { if (currentPage > pageCount) setCurrentPage(pageCount); }, [pageCount, currentPage]);

  // Navigating to a page (thumbnail click or the toolbar's prev/next) must
  // actually scroll the paper viewport there — otherwise "current page"
  // would just be a number nobody sees reflected in the document itself.
  const goToPage = useCallback((p) => {
    setCurrentPage(p);
    const el = wrapRef.current;
    if (!el) return;
    const topPx = (p - 1) * pageHeightPx * (zoom / 100);
    el.scrollTo({ top: Math.max(0, topPx), behavior: 'smooth' });
  }, [pageHeightPx, zoom]);

  // ── Auto-fit width ────────────────────────────────────────────────────────
  // Measures the actual preview area and picks a zoom that makes the sheet
  // use the real available width (clamped 40–150%) — never a tiny page
  // floating in a big gray canvas, regardless of paper size/orientation.
  const fitToWidth = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const available = el.clientWidth - 64;
    if (available <= 0) return;
    setZoom(Math.min(150, Math.max(40, Math.floor((available / pageWidthPx) * 100))));
  }, [pageWidthPx]);

  const fitToPage = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const availW = el.clientWidth - 64;
    const availH = el.clientHeight - 64;
    if (availW <= 0 || availH <= 0) return;
    const pct = Math.min((availW / pageWidthPx) * 100, (availH / pageHeightPx) * 100);
    setZoom(Math.min(150, Math.max(40, Math.floor(pct))));
  }, [pageWidthPx, pageHeightPx]);

  useEffect(() => {
    if (!isOpen) return;
    fitToWidth();
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => fitToWidth());
    ro.observe(el);
    return () => ro.disconnect();
  }, [isOpen, ori, fitToWidth]);

  // Manual scrolling (not just thumbnail/toolbar navigation) also updates
  // the current page — the highlighted thumbnail always reflects what's
  // actually visible, the way Acrobat's page indicator does.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onScroll = () => {
      const pageStepPx = pageHeightPx * (zoom / 100);
      if (pageStepPx <= 0) return;
      const p = Math.min(pageCount, Math.max(1, Math.round(el.scrollTop / pageStepPx) + 1));
      setCurrentPage(prev => (prev === p ? prev : p));
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [pageHeightPx, zoom, pageCount]);

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

  const watermarkText = settings.watermarkEnabled ? (settings.watermarkText || brand.name) : '';

  const previewHTML = useMemo(() => {
    if (!isOpen) return '';
    if (filteredData.length === 0)
      return '<p style="padding:40px;font-family:Cairo,sans-serif;direction:rtl;text-align:center;color:#64748b">لا توجد بيانات للعرض</p>';
    return buildReportHTML({
      title: reportTitle, columns, rows: filteredData,
      meta: { ...meta }, stats, orientation: ori, brand,
      showSignatures: settings.showSignatures,
      paperSize: settings.paperSize, margins: settings.margins, scalePercent: settings.scalePercent,
      showHeaderFooter: settings.showHeaderFooter, repeatHeader: settings.repeatHeader,
      printBackground: settings.printBackground, watermarkText, showStamp: settings.showStamp,
      summaryKeys: SUMMARY_KEYS[activeReport],
    });
  }, [isOpen, filteredData, columns, reportTitle, meta, stats, ori, brand, settings, watermarkText, activeReport]);

  // Write into iframe, auto-fit its height, and measure the total content
  // height — the one real input the page-count estimate and thumbnail
  // slicing both need (see computePageBoxPx above).
  //
  // Root cause of the old blank-thumbnail bug: this measurement used to run
  // once at a fixed 120ms timeout (plus once when fonts.ready resolved) and
  // never accounted for the company logo <img> — an in-page image with no
  // width/height attributes renders at 0px until its network request
  // finishes, so an early measurement could land BEFORE that image occupied
  // its real space. Math.ceil() then had no tolerance for the resulting few
  // stray pixels, so a rounding sliver silently became a whole extra
  // "page" with nothing real in it — and PrintThumbnails, which renders
  // each page as a fixed-height iframe slice, just showed blank white for
  // that slice.
  //
  // Fix: keep measuring (via ResizeObserver, which also self-corrects for
  // any late webfont swap) until the body's images have actually finished
  // loading, THEN mark the measurement ready — thumbnails only render once
  // `measurementReady` is true, and the epsilon tolerance above absorbs any
  // remaining sub-row rounding noise.
  useEffect(() => {
    const ifr = iframeRef.current;
    if (!ifr || !previewHTML) { setMeasurementReady(false); return; }
    const doc = ifr.contentDocument;
    if (!doc) return;
    setMeasurementReady(false);
    doc.open(); doc.write(previewHTML); doc.close();

    let cancelled = false;
    const fit = () => {
      if (cancelled) return;
      try {
        const h = doc.body.scrollHeight;
        ifr.style.height = h + 'px';
        setContentHeightPx(h);
      } catch {}
    };

    const ro = new ResizeObserver(fit);
    ro.observe(doc.body);
    fit();

    const imgs = Array.from(doc.images || []);
    const imagesLoaded = Promise.all(imgs.map(img => img.complete
      ? Promise.resolve()
      : new Promise(res => { img.addEventListener('load', res, { once: true }); img.addEventListener('error', res, { once: true }); })
    ));
    const fontsReady = doc.fonts?.ready || Promise.resolve();

    Promise.all([imagesLoaded, fontsReady]).then(() => {
      if (cancelled) return;
      fit();
      setMeasurementReady(true);
    });

    return () => { cancelled = true; ro.disconnect(); };
  }, [previewHTML]);

  if (!isOpen) return null;

  // Every export path carries the same Print Experience settings the live
  // preview renders, so preview/print/PDF never disagree.
  const printMeta = {
    ...meta, stats, orientation: ori, brand,
    paperSize: settings.paperSize, margins: settings.margins, scalePercent: settings.scalePercent,
    showHeaderFooter: settings.showHeaderFooter, repeatHeader: settings.repeatHeader,
    printBackground: settings.printBackground, watermarkText, showStamp: settings.showStamp,
    showSignatures: settings.showSignatures, copies: settings.copies,
    summaryKeys: SUMMARY_KEYS[activeReport],
  };

  // Routed through the one IPC print pipeline (printUtils.js → ipc.js's
  // print:html handler) rather than calling the preview iframe's own
  // .print() directly — that shortcut bypassed `copies` entirely (a fresh
  // print() call on an iframe's contentWindow doesn't carry it), so with
  // the Print Experience settings now real, this is the one path that
  // actually honors all of them consistently.
  const handlePrint = () => {
    printHTML(filteredData, columns, reportTitle, printMeta, settings.showSignatures);
  };

  const handlePDF = async () => {
    setPdfBusy(true);
    const tid = toast.loading('جاري إنشاء ملف PDF...');
    try {
      const res = await exportToPDF(filteredData, columns, reportTitle, printMeta, ori);
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
  // ── Toolbar tokens — theme-aware, so this reads as part of the app's own
  // premium chrome instead of a hardcoded dark-navy dev-tool bar bolted onto
  // whichever theme the user actually has active. Every button in the
  // "view controls" zone shares this one visual language (segmented groups
  // on a sunken track), matching the toolbar hierarchy real print previews
  // (Acrobat/Word/Google Docs) use: identity ← view controls → export actions.
  const segWrap  = { display:'flex', alignItems:'center', gap:2, background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:9, padding:2 };
  const segBtn   = (active) => ({
    display:'flex', alignItems:'center', justifyContent:'center', gap:5,
    border:'none', borderRadius:7, cursor:'pointer', padding:'6px 9px',
    background: active ? 'var(--surface)' : 'transparent',
    color: active ? 'var(--accent)' : 'var(--text-3)',
    boxShadow: active ? '0 1px 3px rgba(0,0,0,0.12)' : 'none',
    fontSize:12, fontWeight:600, transition:'background 0.15s,color 0.15s',
  });
  const ghostBtn = { display:'flex', alignItems:'center', gap:6, background:'transparent', border:'1px solid var(--border)', borderRadius:8, cursor:'pointer', padding:'6px 10px', fontSize:12, fontWeight:600, color:'var(--text-2)' };

  // Page-break guides: subtle dashed rules + "Page N" chips overlaid at every
  // computed page boundary, in the SAME coordinate space as the iframe (so
  // they scale together with zoom) — the one thing missing from a plain
  // scrolling HTML preview that every real print-preview tool shows: where
  // the page will actually break.
  const pageGuides = pageCount > 1
    ? Array.from({ length: pageCount - 1 }, (_, i) => (i + 1) * pageHeightPx)
    : [];

  return (
    // A full-screen WORKSPACE, not a centered dialog card — the toolbar sits
    // flush against the real window edges like Word/Acrobat's own chrome,
    // so nothing reads as "a modal floating over the app".
    <div
      ref={containerRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      style={{ position:'fixed', inset:0, zIndex:9999, background:'var(--surface)', display:'flex', flexDirection:'column', outline:'none' }} dir="rtl">
        {/* ── Toolbar — three zones: identity · view controls · export actions ── */}
        <div style={{
          padding:'10px 16px', background:'var(--surface)', borderBottom:'1px solid var(--border)',
          display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0, flexWrap:'wrap', gap:10,
        }}>
          {/* Zone 1 — identity */}
          <div style={{ display:'flex', alignItems:'center', gap:10, minWidth:0 }}>
            <div style={{ width:28, height:28, borderRadius:8, flexShrink:0, background: isLight ? 'linear-gradient(135deg,#3b82f6,#1d4ed8)' : 'linear-gradient(135deg,#2F81F7,#1F6FEB)', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:900, color:'#fff', fontSize:14 }}>P</div>
            <span id={titleId} style={{ color:'var(--text)', fontWeight:700, fontSize:14, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', maxWidth:240 }}>{reportTitle}</span>
            <span style={{ background:'var(--accent-soft)', color:'var(--accent)', padding:'2px 9px', borderRadius:99, fontSize:11, fontWeight:700, whiteSpace:'nowrap' }}>
              {filteredData.length} سجل
            </span>
          </div>

          {/* Zone 2 — view controls: zoom · fit · page navigation.
              Orientation lives in the settings sidebar (Print Preview →
              Page), not duplicated here — one setting, one place. */}
          <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
            {pageCount > 1 && (
              <div style={segWrap} role="group" aria-label="التنقل بين الصفحات">
                <button onClick={() => goToPage(Math.max(1, currentPage-1))} disabled={currentPage<=1} title="الصفحة السابقة" style={{ ...segBtn(false), padding:'6px 8px', opacity: currentPage<=1?0.4:1 }}><ChevronRight style={{ width:14, height:14 }} /></button>
                <span style={{ color:'var(--text-2)', fontSize:12, fontWeight:700, minWidth:52, textAlign:'center', fontVariantNumeric:'tabular-nums', direction:'ltr', unicodeBidi:'plaintext' }}>{currentPage} / {pageCount}</span>
                <button onClick={() => goToPage(Math.min(pageCount, currentPage+1))} disabled={currentPage>=pageCount} title="الصفحة التالية" style={{ ...segBtn(false), padding:'6px 8px', opacity: currentPage>=pageCount?0.4:1 }}><ChevronLeft style={{ width:14, height:14 }} /></button>
              </div>
            )}

            <div style={segWrap} role="group" aria-label="التكبير">
              <button onClick={() => setZoom(z => Math.max(40, z-10))} title="تصغير" style={{ ...segBtn(false), padding:'6px 8px' }}><ZoomOut style={{ width:14, height:14 }} /></button>
              <span style={{ color:'var(--text-2)', fontSize:12, fontWeight:700, minWidth:38, textAlign:'center', fontVariantNumeric:'tabular-nums' }}>{zoom}%</span>
              <button onClick={() => setZoom(z => Math.min(150, z+10))} title="تكبير" style={{ ...segBtn(false), padding:'6px 8px' }}><ZoomIn style={{ width:14, height:14 }} /></button>
            </div>

            <button onClick={fitToWidth} title="ملائمة العرض للعرض" style={ghostBtn}>
              <StretchHorizontal style={{ width:13, height:13 }} /> ملائمة العرض
            </button>
            <button onClick={fitToPage} title="ملائمة الصفحة كاملة" style={ghostBtn}>
              <Maximize2 style={{ width:13, height:13 }} /> ملائمة الصفحة
            </button>
          </div>

          {/* Zone 3 — export actions (secondary → primary, left-to-right by consequence) */}
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <button onClick={() => setShowSidebar(s => !s)} title={showSidebar ? 'إخفاء إعدادات الطباعة' : 'إظهار إعدادات الطباعة'} style={{ ...ghostBtn, padding:7 }}>
              {showSidebar ? <PanelLeftClose style={{ width:15, height:15 }} /> : <PanelLeft style={{ width:15, height:15 }} />}
            </button>
            <button onClick={() => setShowThumbs(s => !s)} title={showThumbs ? 'إخفاء الصفحات المصغّرة' : 'إظهار الصفحات المصغّرة'} style={{ ...ghostBtn, padding:7 }}>
              {showThumbs ? <PanelRightClose style={{ width:15, height:15 }} /> : <PanelRight style={{ width:15, height:15 }} />}
            </button>
            <div style={{ width:1, height:22, background:'var(--border)', margin:'0 2px' }} />
            <button onClick={handleExcel} style={{ display:'flex', alignItems:'center', gap:6, background:'transparent', border:'1px solid rgba(16,185,129,0.4)', color: isLight ? '#059669' : '#34d399', borderRadius:8, cursor:'pointer', padding:'6px 12px', fontSize:12, fontWeight:700 }}>
              <FileSpreadsheet style={{ width:14, height:14 }} /> Excel
            </button>
            <button onClick={handlePDF} disabled={pdfBusy} style={{ display:'flex', alignItems:'center', gap:6, background:'transparent', border:'1px solid rgba(239,68,68,0.4)', color: isLight ? '#dc2626' : '#f87171', borderRadius:8, cursor:'pointer', padding:'6px 12px', fontSize:12, fontWeight:700, opacity: pdfBusy?0.6:1 }}>
              {pdfBusy ? <Loader2 style={{ width:14, height:14, animation:'spin 1s linear infinite' }} /> : <FileText style={{ width:14, height:14 }} />} PDF
            </button>
            <div style={{ width:1, height:22, background:'var(--border)', margin:'0 2px' }} />
            <button onClick={handlePrint} style={{ display:'flex', alignItems:'center', gap:6, background:'var(--accent)', border:'none', color:'#fff', borderRadius:8, cursor:'pointer', padding:'7px 16px', fontSize:12.5, fontWeight:700, boxShadow:'0 1px 3px rgba(37,99,235,0.35)' }}>
              <Printer style={{ width:14, height:14 }} /> طباعة
            </button>
            <button onClick={onClose} title="إغلاق" style={{ background:'transparent', border:'none', cursor:'pointer', color:'var(--text-3)', padding:7, borderRadius:8, display:'flex' }}>
              <X style={{ width:17, height:17 }} />
            </button>
          </div>
        </div>

        {/* Sub-report tabs — a lighter secondary strip so it never competes
            with the main toolbar above it. */}
        {showSubTabs && (
          <div style={{ display:'flex', gap:6, padding:'8px 16px', background:'var(--surface-2)', borderBottom:'1px solid var(--border)', flexShrink:0, overflowX:'auto' }}>
            {[
              { key:allTabKey,                    label:'جميع الموظفين' },
              { key:'attendance_daily_absent',   label:'الغائبون',  n:data.filter(r=>r.isAbsent||r.status==='absent').length },
              { key:'attendance_daily_late',     label:'المتأخرون', n:data.filter(r=>(r.effectiveLatePenalty||0)>0).length },
              { key:'attendance_daily_overtime', label:'الإضافي',   n:data.filter(r=>(r.effectiveOvertimeUnits||0)>0).length },
            ].map(tab => (
              <button key={tab.key} onClick={() => setActiveReport(tab.key)}
                style={{
                  padding:'5px 13px', borderRadius:7, fontSize:12, fontWeight:600, cursor:'pointer', whiteSpace:'nowrap',
                  border: activeReport===tab.key ? '1px solid var(--accent)' : '1px solid transparent',
                  background: activeReport===tab.key ? 'var(--accent-soft)' : 'transparent',
                  color: activeReport===tab.key ? 'var(--accent)' : 'var(--text-3)',
                }}>
                {tab.label}{tab.n != null && <span style={{ marginRight:5, background: activeReport===tab.key ? 'rgba(37,99,235,0.18)' : 'var(--surface)', color: activeReport===tab.key ? 'var(--accent)' : 'var(--text-3)', padding:'1px 6px', borderRadius:99, fontSize:10, border:'1px solid var(--border)' }}>{tab.n}</span>}
              </button>
            ))}
          </div>
        )}

        {/* ── Workspace body: settings sidebar · paper viewport · thumbnails ── */}
        <div style={{ flex:1, display:'flex', minHeight:0, overflow:'hidden' }}>
          {showSidebar && (
            <PrintSettingsSidebar
              settings={settings} onChange={setSettings}
              orientation={ori} onOrientationChange={setOri}
              hasStamp={!!brand.stampUrl}
            />
          )}

          {/* Paper viewport — a neutral, document-first surface: generous
              whitespace around the sheet (real print previews never let the
              page touch the canvas edge), a crisp hairline border plus a
              soft layered elevation shadow instead of one hard black blur,
              and near-square corners (paper doesn't have rounded corners).
              Auto-fit width on open; Fit Width/Fit Page buttons recompute on
              demand. Page-break guides overlay the exact same scaled
              coordinate space as the iframe, so they track zoom perfectly. */}
          <div ref={wrapRef} style={{ flex:1, overflow:'auto', padding:'32px 24px', background: isLight ? '#e7ebf2' : '#0b0f16' }}>
            <div style={{ width: Math.round(pageWidthPx * zoom/100), margin:'0 auto', transition:'width 0.15s' }}>
              <div style={{
                position:'relative', width:pageWidthPx, transform:`scale(${zoom/100})`, transformOrigin:'top right',
                background:'#fff', borderRadius:1,
                border: isLight ? '1px solid rgba(15,23,42,0.08)' : '1px solid rgba(255,255,255,0.06)',
                boxShadow: isLight
                  ? '0 1px 2px rgba(15,23,42,0.06), 0 12px 32px rgba(15,23,42,0.16)'
                  : '0 1px 2px rgba(0,0,0,0.3), 0 16px 40px rgba(0,0,0,0.55)',
              }}>
                <iframe ref={iframeRef} title="preview" scrolling="no"
                  style={{ width:'100%', minHeight:400, border:'none', display:'block' }} />
                {pageGuides.map((top, i) => (
                  <div key={top} style={{ position:'absolute', insetInlineStart:0, insetInlineEnd:0, top, pointerEvents:'none' }}>
                    <div style={{ borderTop:'1px dashed rgba(15,23,42,0.28)' }} />
                    <span style={{
                      position:'absolute', top:4, insetInlineEnd:8, fontSize:10, fontWeight:700,
                      color:'#64748b', background:'rgba(255,255,255,0.9)', padding:'1px 6px', borderRadius:4,
                    }}>صفحة {i + 2}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {showThumbs && (
            <PrintThumbnails
              previewHTML={previewHTML} pageWidthPx={pageWidthPx} pageHeightPx={pageHeightPx}
              contentHeightPx={contentHeightPx} pageCount={pageCount} currentPage={currentPage}
              ready={measurementReady}
              onNavigate={goToPage}
            />
          )}
        </div>
    </div>
  );
}
