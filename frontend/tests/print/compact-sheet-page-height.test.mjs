/**
 * Regression guard for the blank-pages defect of the bulk payroll sheet (CompactSalarySheet) on Electron 26.6.10 (Chromium 116, the legacy macOS
 * 10.13/10.14 build). Measured there: a `.cps-page` of 209.85mm or more prints 6 blank/collapsed pages instead of 3; 209.8mm and below prints
 * correctly. The page is therefore kept at 209mm (<= 209.5mm, i.e. clear of the threshold).
 *
 * The first four tests are static (file reads + react-dom/server): no Electron, no network, no database, no device. They guard the CSS value and
 * the pagination structure, NOT how a real engine prints.
 * The last test really prints with Electron (`printToPDF`, the same options as the app's pdf:export) and counts the pages of the PDF. It runs only
 * when COMPACT_SHEET_PRINT_ELECTRON points at an Electron binary, and is skipped otherwise, so the normal suite never needs Electron:
 *   COMPACT_SHEET_PRINT_ELECTRON=<path to electron(.exe)>  node --test tests/print/compact-sheet-page-height.test.mjs      (from frontend/)
 * It counts pages only (a doubled page count is exactly the failure signature); it does not read text or pixels, uses the system fallback font
 * instead of the embedded Cairo, and does not exercise the native print dialog (webContents.print).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = fs.readFileSync(path.join(FRONTEND, 'src', 'components', 'CompactSalarySheet.jsx'), 'utf8');
const require = createRequire(path.join(FRONTEND, 'package.json'));

const MAX_PAGE_HEIGHT_MM = 209.5; // measured failure starts at 209.85mm on Chromium 116
const COUNTS = [1, 5, 9, 10, 18, 19, 27, 50];
const pageRule = () => {
  const m = SOURCE.match(/\.cps-page\{([^}]*)\}/);
  assert.ok(m, '.cps-page rule found');
  return m[1];
};

// Bundles the real CompactSalarySheet.jsx and returns render(n) -> static HTML of n employee cards.
function loadRenderer(dir) {
  const outfile = path.join(dir, 'bundle.cjs');
  require('esbuild').buildSync({
    stdin: {
      contents: `import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; import Sheet, { PER_PAGE } from './src/components/CompactSalarySheet.jsx';
        const sheet = (i) => ({ employee: { id: i, name: 'موظف ' + (i + 1) }, earnings: { basicSalary: 4500, overtimeAmount: 100 }, deductions: { total: 270 }, netSalary: 4330 + i });
        export const PAGE = PER_PAGE;
        export const render = (n) => renderToStaticMarkup(<Sheet sheets={Array.from({ length: n }, (_, i) => sheet(i))} monthLabel="أكتوبر" year={2026} />);`,
      resolveDir: FRONTEND, loader: 'jsx', sourcefile: 'entry.jsx',
    },
    outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error', jsx: 'automatic', loader: { '.js': 'jsx' },
  });
  return require(outfile);
}

test('.cps-page height stays at or below 209.5mm (210mm blanks every page on Chromium 116)', () => {
  const h = pageRule().match(/(?:^|[;\s])height:\s*(\d+(?:\.\d+)?)mm/);
  assert.ok(h, '.cps-page declares a height in mm');
  const mm = Number(h[1]);
  assert.ok(mm <= MAX_PAGE_HEIGHT_MM, `.cps-page height is ${mm}mm; must be <= ${MAX_PAGE_HEIGHT_MM}mm`);
  assert.ok(mm >= 205, `.cps-page height ${mm}mm is implausibly small (the 3x3 card grid needs ~205mm+)`);
});

test('.cps-page keeps its other page geometry: A4 landscape width, one sheet per page, flex column, hidden overflow', () => {
  const rule = pageRule();
  assert.match(rule, /width:\s*297mm/);
  assert.match(rule, /break-after:\s*page/);
  assert.match(rule, /display:\s*flex/);
  assert.match(rule, /flex-direction:\s*column/);
  assert.match(rule, /overflow:\s*hidden/);
  assert.match(SOURCE, /export const PER_PAGE = 9;/);
});

test('no other full-sheet 210mm height is left in the sheet CSS', () => {
  assert.ok(!/[^\w-]height:\s*210mm/.test(SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')), 'a height:210mm declaration is back');
});

test('card counts 1, 5, 9, 10, 18, 19, 27, 50 paginate into ceil(n/9) pages with one card per employee and the same 209mm page CSS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-test-'));
  try {
    const { render, PAGE } = loadRenderer(dir);
    assert.equal(PAGE, 9);
    const count = (s, re) => (s.match(re) || []).length;
    for (const n of COUNTS) {
      const html = render(n);
      assert.equal(count(html, /class="cps-page"/g), Math.ceil(n / 9), `${n} cards -> pages`);
      assert.equal(count(html, /class="cps-card"/g), n, `${n} cards -> cards`);
      for (const name of ['موظف 1', `موظف ${n}`]) assert.ok(html.includes(name), `${n} cards: "${name}" rendered`);
      const h = Number(html.match(/\.cps-page\{[^}]*?[;\s]height:\s*(\d+(?:\.\d+)?)mm/)[1]);
      assert.ok(h <= MAX_PAGE_HEIGHT_MM, `${n} cards: shipped .cps-page height ${h}mm`);
    }
    assert.equal(count(render(0), /class="cps-page"/g), 1, 'an empty sheet still renders one page');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Hidden window + loadFile + fonts.ready + printToPDF with the app's pdf:export options (electron/ipc.js). Writes <name>.pdf next to each .html.
const PRINT_RUNNER = `
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const [manifestFile, userData] = process.argv.slice(process.argv.findIndex((a) => a.endsWith('print-runner.cjs')) + 1);
app.setPath('userData', userData);
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const files = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  for (const f of files) {
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, javascript: true, offscreen: false } });
    await win.loadFile(f);
    try { await win.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(()=>true) : true'); } catch {}
    const data = await win.webContents.printToPDF({ printBackground: true, landscape: true, pageSize: 'A4', preferCSSPageSize: true, margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 } });
    fs.writeFileSync(f.replace(/\\.html$/, '.pdf'), data); win.destroy();
  }
  app.exit(0);
}).catch((e) => { console.error(String(e && e.stack || e)); app.exit(1); });
`;
// Skia PDFs keep one plain "/Type /Page" dictionary per page ("/Type /Pages" is the tree node and is not counted).
const pdfPages = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page(?![A-Za-z])/g) || []).length;

const ELECTRON = process.env.COMPACT_SHEET_PRINT_ELECTRON;
test('real print (opt-in): printToPDF of 1, 5, 9, 10, 18, 19, 27, 50 cards gives ceil(n/9) pages',
  { skip: ELECTRON ? false : 'set COMPACT_SHEET_PRINT_ELECTRON=<path to an Electron binary> to print for real', timeout: 240000 },
  () => {
    assert.ok(fs.existsSync(ELECTRON), `COMPACT_SHEET_PRINT_ELECTRON does not exist: ${ELECTRON}`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-print-'));
    try {
      const { render } = loadRenderer(dir);
      // same wrapper CSS as FinalSalaryModal's buildSalaryDoc (A4 landscape, zero page margin), minus the embedded fonts
      const doc = (body) => `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="UTF-8"><title>cps</title><style>*{box-sizing:border-box;margin:0;padding:0;}`
        + `body{font-family:'Cairo','IBM Plex Sans Arabic',Tahoma,Arial,sans-serif;background:#fff;direction:rtl;}@page{size:A4 landscape;margin:0;}</style></head><body>${body}</body></html>`;
      const files = COUNTS.map((n) => { const f = path.join(dir, `n${n}.html`); fs.writeFileSync(f, doc(render(n)), 'utf8'); return f; });
      const manifest = path.join(dir, 'manifest.json'); fs.writeFileSync(manifest, JSON.stringify(files));
      const runner = path.join(dir, 'print-runner.cjs'); fs.writeFileSync(runner, PRINT_RUNNER);
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const r = spawnSync(ELECTRON, [runner, manifest, path.join(dir, 'userdata')], { env, encoding: 'utf8', timeout: 200000 });
      assert.equal(r.status, 0, `Electron exited with ${r.status}: ${String(r.stderr || r.error || '').slice(0, 400)}`);
      for (const n of COUNTS) {
        const pdf = fs.readFileSync(path.join(dir, `n${n}.pdf`));
        assert.equal(pdfPages(pdf), Math.ceil(n / 9), `${n} cards printed to ${pdfPages(pdf)} pages (Electron ${path.basename(ELECTRON)}); expected ${Math.ceil(n / 9)}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
