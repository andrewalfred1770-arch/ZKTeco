/**
 * printUtils.js — PETSHROW Print & Export Engine
 *
 * PDF   → Chromium print engine (Electron webContents.printToPDF) with a
 *         window.print() fallback in the browser. NO jsPDF — that was the
 *         source of broken Arabic glyphs. Chromium shapes Arabic natively.
 * Print → opens the unified A4 report HTML and prints it.
 * Excel → SheetJS with PETSHROW branding, RTL sheet, title rows & totals.
 */
import { buildReportHTML } from './reportTemplate.js';
import { BRAND, FILE_PREFIX } from './branding.js';
import { westernDigits, getNestedValue } from './formatters.js';

// Re-export so existing imports (`import { getNestedValue } from '../lib/printUtils'`) keep working
export { getNestedValue };

// ── Helpers ───────────────────────────────────────────────────────────────────
function nowStr() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return westernDigits(`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}  ${pad(d.getHours())}:${pad(d.getMinutes())}`);
}
function nowFilename() { return new Date().toISOString().slice(0, 10); }
function safeName(t) {
  return String(t).replace(/[^\w؀-ۿ\s-]/g, '').trim().replace(/\s+/g, '_') || 'report';
}
function sumKey(rows, key) {
  return rows.reduce((s, r) => {
    const v = Number(getNestedValue(r, key));
    return s + (isNaN(v) ? 0 : v);
  }, 0);
}

// ── Excel Export ──────────────────────────────────────────────────────────────
/**
 * @param {Object[]} data
 * @param {Array}    columns   [{ header, key, format?, total? }]
 * @param {string}   filename
 * @param {string}   sheetName
 * @param {Object}   meta      { title, subtitle, period, branch, dept }
 */
export async function exportToExcel(data, columns, filename = 'تقرير', sheetName = 'البيانات', meta = {}) {
  // xlsx is a large library only needed at the moment of an Excel export —
  // dynamic import keeps it out of the main bundle/startup path (EP-015).
  const XLSX = await import('xlsx');
  // Pass `meta.brand` (useCompanyBrand() output) from the calling screen for
  // live company name/product in the exported file's metadata + title block.
  const brand = meta.brand || BRAND;
  const wb = XLSX.utils.book_new();
  wb.Props = { Title: meta.title || filename, Company: brand.name, Author: brand.product };

  const headers = columns.map(c => c.header);
  const body = data.map(row =>
    columns.map(c => {
      const val = getNestedValue(row, c.key);
      return c.format ? c.format(val, row) : (val ?? '');
    })
  );

  // Totals row (accounting)
  const hasTotals = columns.some(c => c.total);
  let totalsRow = null;
  if (hasTotals && data.length) {
    totalsRow = columns.map((c, i) => {
      if (!c.total) return i === 0 ? 'الإجمالي' : '';
      let v;
      if (c.total === 'sum') v = sumKey(data, c.key);
      else if (typeof c.total === 'function') v = c.total(data);
      else v = c.total;
      return c.format ? c.format(v, { __total: true }) : v;
    });
  }

  // Title block
  const titleRows = [
    [brand.name],
    [meta.title || sheetName],
  ];
  const sub = [meta.period, meta.branch && `الفرع: ${meta.branch}`, meta.dept && `القسم: ${meta.dept}`]
    .filter(Boolean).join('  |  ');
  if (sub) titleRows.push([sub]);
  titleRows.push([`تاريخ الطباعة: ${nowStr()}`, '', `عدد السجلات: ${westernDigits(data.length)}`]);
  titleRows.push([]);
  titleRows.push(headers);

  const aoa = [...titleRows, ...body];
  if (totalsRow) aoa.push(totalsRow);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = columns.map(c => ({ wch: Math.max(String(c.header).length * 1.6 + 4, 12) }));
  ws['!sheetView'] = [{ rightToLeft: true }];
  // Merge the brand/title lines across the table width
  const lastCol = Math.max(columns.length - 1, 1);
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
  ];

  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  XLSX.writeFile(wb, `${FILE_PREFIX}_${safeName(filename)}_${nowFilename()}.xlsx`);
}

// ── PDF Export (Chromium engine + browser fallback) ────────────────────────────
/**
 * @param {Object[]} data
 * @param {Array}    columns   [{ header, key, format?, align?, tdClass?, thStyle?, total? }]
 * @param {string}   title
 * @param {Object}   meta      { period, branch, dept, employee, shift, stats, showSignatures }
 * @param {string}   orientation 'portrait' | 'landscape'
 * @returns {Promise<{ok:boolean, path?:string, fallback?:boolean, canceled?:boolean}>}
 */
export async function exportToPDF(data, columns, title, meta = {}, orientation = 'landscape') {
  const html = buildReportHTML({
    title,
    columns,
    rows: data,
    meta,
    stats: meta.stats || null,
    orientation,
    showSignatures: meta.showSignatures !== false,
    brand: meta.brand || BRAND,
  });

  const filename = `${FILE_PREFIX}_${safeName(title)}_${nowFilename()}`;

  // Preferred path: Electron Chromium print engine → true Arabic PDF
  if (typeof window !== 'undefined' && window.electron?.exportPDF) {
    try {
      return await window.electron.exportPDF({ html, filename, landscape: orientation === 'landscape' });
    } catch (e) {
      console.error('[PDF] electron export failed, falling back to print:', e);
    }
  }

  // Fallback (dev/browser): open a print window — Chromium still shapes Arabic.
  printDocument(html);
  return { ok: true, fallback: true };
}

// ── Browser print ───────────────────────────────────────────────────────────
export function printHTML(data, columns, title, meta = {}, showSignatures = true) {
  const html = buildReportHTML({
    title,
    columns,
    rows: data,
    meta,
    stats: meta.stats || null,
    orientation: meta.orientation || 'landscape',
    showSignatures,
    brand: meta.brand || BRAND,
  });
  printDocument(html);
}

function printDocument(html) {
  // In Electron, window.open() is blocked by setWindowOpenHandler — use IPC instead.
  if (window.electron?.printHTML) {
    window.electron.printHTML({ html }).catch(err => console.error('[Print] IPC failed:', err));
    return;
  }
  const w = window.open('', '_blank', 'width=1000,height=720');
  if (!w) { alert('فضلاً اسمح بالنوافذ المنبثقة للطباعة'); return; }
  const withPrint = html.replace(
    '</body>',
    `<script>function go(){setTimeout(function(){try{window.focus();window.print();}catch(e){}},180);}`
    + `if(document.fonts&&document.fonts.ready){document.fonts.ready.then(go);}else{go();}<\/script></body>`
  );
  w.document.open();
  w.document.write(withPrint);
  w.document.close();
}

// ── Convert AG Grid colDefs → print columns ────────────────────────────────────
export function agColsToPrintCols(agCols, exclude = []) {
  return agCols
    .filter(c => c.field && !exclude.includes(c.field) && c.headerName)
    .map(c => ({
      header: c.headerName,
      key: c.field,
      format: c.valueFormatter
        ? (val, row) => { try { return c.valueFormatter({ value: val, data: row }); } catch { return val; } }
        : null,
    }));
}

// ── Build the full report HTML (exposed for the live preview) ──────────────────
export { buildReportHTML };
