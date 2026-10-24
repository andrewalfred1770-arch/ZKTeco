// Bundled by build-fixtures.mjs. Builds the REAL documents the app sends to pdf:export / print:html:
//   - table reports from src/lib/reportTemplate.js (buildReportHTML)
//   - payroll documents from SalaryCard / CompactSalarySheet wrapped by the REAL buildSalaryDoc (sliced out of FinalSalaryModal.jsx, not copied)
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildReportHTML, EMBEDDED_FONT_CSS_ALL } from '../../frontend/src/lib/reportTemplate.js';
import { COLORS } from '../../frontend/src/lib/printDesignSystem.js';
import { BRAND } from '../../frontend/src/lib/branding.js';
import SalaryCard from '../../frontend/src/components/SalaryCard.jsx';
import CompactSalarySheet from '../../frontend/src/components/CompactSalarySheet.jsx';

const FRONTEND = process.env.PDFDIAG_FRONTEND;

// buildSalaryDoc is private to FinalSalaryModal.jsx; slice its exact source so the diagnostic can never drift from the app.
function realBuildSalaryDoc() {
  const src = fs.readFileSync(path.join(FRONTEND, 'src', 'components', 'FinalSalaryModal.jsx'), 'utf8').split('\r\n').join('\n');
  const start = src.indexOf('function buildSalaryDoc(');
  const end = src.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error('buildSalaryDoc not found in FinalSalaryModal.jsx - update pdf-diagnostic/fixtures-entry.jsx');
  return new Function('EMBEDDED_FONT_CSS_ALL', 'COLORS', `${src.slice(start, end + 2)}\nreturn buildSalaryDoc;`)(EMBEDDED_FONT_CSS_ALL, COLORS);
}

// 1x1 PNG (opaque green) as a data: URI - the "image that loads" case
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';

const COLS = [
  { header: 'الموظف', key: 'name' }, { header: 'القسم', key: 'dept' }, { header: 'الحضور', key: 'in' },
  { header: 'الانصراف', key: 'out' }, { header: 'الساعات', key: 'hours', total: true }, { header: 'الصافي', key: 'net', total: true },
];
const rowsOf = (n) => Array.from({ length: n }, (_, i) => ({
  name: 'موظف رقم ' + (i + 1), dept: i % 2 ? 'المبيعات' : 'الحسابات', in: '08:0' + (i % 10), out: '16:3' + (i % 10), hours: 8 + (i % 3), net: 1500 + i * 10,
}));

const sheet = (i) => ({
  employee: { id: i, name: 'موظف رقم ' + (i + 1), code: 'E' + String(i + 1).padStart(3, '0'), department: 'الحسابات', branch: 'الفرع الرئيسي', salary: 4500, dailyRate: 150, hourlyRate: 18.75 },
  attendance: { workDays: 26, absentDays: i % 3, lateMinutes: 10 * (i % 4) },
  earnings: { basicSalary: 4500, overtimeAmount: 200 + i, morningOT: { amount: 100 }, eveningOT: { amount: 100 + i } },
  deductions: { absentAmount: 150 * (i % 3), lateAmount: 20, earlyAmount: 0, advances: 100, manualDeductionAdjustment: 0, total: 270 + 150 * (i % 3) },
  netSalary: 4430 - 150 * (i % 3) + i, monthLabel: 'أكتوبر', year: 2026, month: 10,
});

export function buildAll() {
  const salaryDoc = realBuildSalaryDoc();
  const base = { title: 'تقرير الحضور الشهري', columns: COLS, meta: { period: '2026-10', branch: 'الفرع الرئيسي' }, stats: null, showSignatures: true };
  const logo = (url) => ({ ...BRAND, logoUrl: url, stampUrl: url, printHeaderUrl: url });
  const out = [];
  const add = (name, html, landscape, expect) => out.push({ name, html, landscape, expect });

  add('report-landscape-70rows', buildReportHTML({ ...base, rows: rowsOf(70), orientation: 'landscape', brand: BRAND }), true, ['تقرير الحضور الشهري', 'موظف رقم 1', 'المبيعات']);
  add('report-portrait-70rows', buildReportHTML({ ...base, rows: rowsOf(70), orientation: 'portrait', brand: BRAND }), false, ['تقرير الحضور الشهري', 'موظف رقم 1', 'المبيعات']);
  add('report-empty', buildReportHTML({ ...base, rows: [], orientation: 'landscape', brand: BRAND }), true, ['تقرير الحضور الشهري']);
  add('report-images-data-uri', buildReportHTML({ ...base, rows: rowsOf(20), orientation: 'landscape', brand: logo(PNG), showStamp: true }), true, ['تقرير الحضور الشهري'], );
  add('report-images-unreachable', buildReportHTML({ ...base, rows: rowsOf(20), orientation: 'landscape', brand: logo('http://127.0.0.1:9/logo.png'), showStamp: true }), true, ['تقرير الحضور الشهري']);
  add('report-mixed-rtl-ltr', buildReportHTML({ ...base, title: 'Report تقرير 2026 Q4 (ملخص)', rows: rowsOf(12).map((r, i) => ({ ...r, name: i % 2 ? 'Ahmed أحمد #' + i : 'محمد Ali ' + i })), orientation: 'portrait', brand: BRAND }), false, ['ملخص']);
  add('salary-card-single', salaryDoc(renderToStaticMarkup(<SalaryCard data={sheet(0)} />), 'كشف رواتب أكتوبر 2026', true), true, ['موظف رقم 1']);
  add('salary-sheet-bulk-20', salaryDoc(renderToStaticMarkup(<CompactSalarySheet sheets={Array.from({ length: 20 }, (_, i) => sheet(i))} monthLabel="أكتوبر" year={2026} />), 'كشف رواتب أكتوبر 2026', true), true, ['موظف رقم 1', 'مرتب شهر أكتوبر']);
  return out;
}
