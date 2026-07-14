# PETSHROW ERP — Manual QA Checklist (Print / PDF Engine)

Generated: 2026-07-04
Scope: Visual/output verification only. No business logic, calculation, or data changes are covered by this checklist — those were certified separately (see memory: Condition Rule Engine Refactor, OT Multiplier Shadowing Fix).

All six report types below are rendered through the single shared pipeline:
`reportTemplate.js` (`buildReportHTML`) → `printUtils.js` → `PrintPreviewModal.jsx`.
Because the fix is centralized there, most checks are identical across reports — run the full matrix once per report type regardless.

## How to test
1. Open the app, navigate to each screen, open the print preview (or PDF export) for a dataset large enough to span 2+ pages (recommend 40+ rows; for the "row number" check specifically, use a dataset/log source with 100+ and 1000+ sequential records — Raw Logs is the best candidate for 4-digit IDs).
2. Check both Portrait and Landscape where the toggle is available.
3. Repeat for Print (browser/OS print dialog or Electron print) and PDF export.

---

## 1. Attendance Daily Print
- [ ] Header: logo, company name, tagline, title, print date, record count all present and correctly aligned (RTL)
- [ ] Footer: page number visible at bottom-right (`صفحة X من Y`), correct on every page
- [ ] All Arabic labels render correctly — no mojibake, no missing glyphs, no boxes/tofu
- [ ] Column alignment: text columns right-aligned, numeric columns (time, penalty, OT) center-aligned LTR
- [ ] Totals row present at bottom of table, bold, sums match on-screen grid totals
- [ ] Row-number / ID / sequence columns: **never wrap** — "104" renders as a single line, not stacked digits (test with 100+ rows)
- [ ] No row is duplicated across a page break
- [ ] No row is missing/dropped across a page break
- [ ] Landscape orientation: table fits width, no horizontal clipping
- [ ] Portrait orientation: table fits width, no horizontal clipping
- [ ] Long report (2+ pages): header/footer repeat correctly, no content lost at page boundary
- [ ] Sub-tabs (all/absent/late/overtime) each print correct filtered subset

## 2. Attendance Monthly Print
- [ ] Same header/footer/RTL/Arabic checks as above
- [ ] 10-column dense layout: no text overlaps, no column bleeds into neighbor
- [ ] Totals row sums (work days, absent days, hours, OT, deductions) match on-screen
- [ ] Row numbers/day counts never wrap mid-digit
- [ ] Long report (full month, many employees): page breaks clean, no duplicate/missing rows
- [ ] Landscape + Portrait both checked

## 3. Employee Movement Print
- [ ] Day-of-month "#" column (values 1–31): single line, centered, never wraps
- [ ] Date/day-name columns render correctly in Arabic
- [ ] Deduction/OT totals row matches on-screen summary
- [ ] Long single-employee report (full month, 31 rows): no page-break artifacts
- [ ] Landscape + Portrait both checked

## 4. Payroll Print
- [ ] 15-column dense payroll table: all currency values format correctly (no truncation)
- [ ] Totals row (basic salary, OT amount, deductions, advances, net salary) matches on-screen payroll grid
- [ ] Row numbers never wrap even with 100+ employees
- [ ] KPI cards (employee count, gross, deductions, advances, net) render correctly above table
- [ ] Long report (full company payroll): no duplicated/missing employee rows across pages
- [ ] Landscape + Portrait both checked
- [ ] Compact Salary Sheet (per-employee card layout) — separate template, verify independently: card content, net bar, no clipping

## 5. Dashboard Print
- [ ] KPI stat cards (present/absent/late/overtime/total) match live dashboard numbers
- [ ] Same attendance-daily-style table below stats prints correctly
- [ ] Row numbers never wrap
- [ ] Landscape + Portrait both checked

## 6. PDF Export (all report types above)
- [ ] PDF generates via Electron `printToPDF` (not the jsPDF/browser fallback) when running the packaged app
- [ ] Arabic text renders correctly in the PDF (Cairo font embedded, no fallback tofu)
- [ ] Page numbers appear in PDF footer, correct count
- [ ] No clipped columns at page edges
- [ ] Row numbers/IDs never wrap in PDF (re-verify separately from print — PDF rasterization can differ from print CSS in edge cases)
- [ ] File saves with expected filename pattern and opens correctly in a PDF viewer
- [ ] Multi-page PDF: no duplicated or missing pages/rows

---

## Cross-cutting sign-off (once per report type)
- [ ] RTL layout confirmed correct throughout (header, table, footer)
- [ ] No unexpected page breaks splitting a single table row across two pages
- [ ] No clipping of any cell content at print margins
- [ ] No duplicated rows anywhere in a multi-page output
- [ ] No missing rows anywhere in a multi-page output
- [ ] No wrapped/stacked row numbers anywhere (99, 999, 1000, 9999 all single-line)

## Sign-off
| Report | Print | PDF | Tester | Date | Notes |
|---|---|---|---|---|---|
| Attendance Daily | | | | | |
| Attendance Monthly | | | | | |
| Employee Movement | | | | | |
| Payroll | | | | | |
| Dashboard | | | | | |
