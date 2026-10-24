// Run with Electron:  electron electron-runner.cjs <fixturesDir> <outDir> [variant,variant,...]
// Replays what electron/ipc.js does for 'pdf:export' (hidden window -> loadFile(tmp .html) -> document.fonts.ready -> printToPDF with the app's
// options) and for 'print:html' (webContents.print). Every variant below differs from `asis` by exactly ONE factor, so a blank page can be tied to
// a cause. Reads only <fixturesDir>; writes only under <outDir>. No network, database or device is used. Native printing is aimed at a printer name
// that cannot exist, so nothing is ever physically printed: only the failure path (and the printers the OS reports) is recorded.
//
//   asis              the app's own sequence: hidden window (default size), temp file, fonts.ready, printToPDF
//   visible           ONLY: the export window is shown
//   nothrottle        ONLY: webPreferences.backgroundThrottling = false
//   dataurl           ONLY: document loaded from a data: URL instead of a temp file
//   wait-images       ONLY: additionally waits until every <img> has loaded or failed
//   wait-frames       ONLY: additionally waits two animation frames
//   wait-300ms        ONLY: additionally waits 300 ms
//   with-main-window  ONLY: a visible window is open during the export (the packaged app always has its main window)
//   app-guards        ONLY: the app's REAL electron/security.js guards are installed (needs PDFDIAG_SECURITY = the bundle made by bundle-security.mjs).
//                     Runs last, because the guards stay installed for every window created afterwards. IS_DEV is true here (not packaged).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const [fixturesDir, outRoot, variantArg] = process.argv.slice(process.argv.findIndex((a) => a.endsWith('electron-runner.cjs')) + 1).filter((a) => !a.startsWith('--'));
const ALL = ['asis', 'visible', 'nothrottle', 'dataurl', 'wait-images', 'wait-frames', 'wait-300ms', 'with-main-window', 'app-guards'];
const requested = (variantArg || ALL.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const unknown = requested.filter((v) => !ALL.includes(v));
if (unknown.length) { console.error('unknown variant(s): ' + unknown.join(', ') + '  (known: ' + ALL.join(', ') + ')'); process.exit(2); }
const VARIANTS = [...requested.filter((v) => v !== 'app-guards'), ...requested.filter((v) => v === 'app-guards')];
const WEB = { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, javascript: true };
const PDF_OPTS = (landscape) => ({ printBackground: true, landscape, pageSize: 'A4', preferCSSPageSize: true, margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms: ${what}`)), ms))]);

// Results and events are appended to .jsonl files AS THEY HAPPEN, so nothing already measured is lost if Electron crashes later in the run.
const verDir = path.join(outRoot, process.versions.electron);
fs.mkdirSync(verDir, { recursive: true });
const append = (file, obj) => fs.appendFileSync(path.join(verDir, file), JSON.stringify(obj) + '\n');
const results = []; const events = [];
const ev = (o) => { events.push(o); append('events.jsonl', o); };
const record = (r) => { results.push(r); append('results.jsonl', r); const n = Number(process.env.PDFDIAG_SELFTEST_CRASH_AFTER || 0); if (n && results.length >= n) process.kill(process.pid, 'SIGKILL'); };
const meta = { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform, arch: process.arch, osRelease: os.release(), variants: VARIANTS };
fs.writeFileSync(path.join(verDir, 'meta.json'), JSON.stringify(meta, null, 2));

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // the app keeps its main window open; the harness has none
app.on('child-process-gone', (_e, d) => ev({ type: 'child-process-gone', ...d }));

function track(win, label) {
  const wc = win.webContents;
  wc.on('did-fail-load', (_e, code, desc, url) => ev({ label, type: 'did-fail-load', code, desc, url: String(url).slice(0, 120) }));
  wc.on('render-process-gone', (_e, d) => ev({ label, type: 'render-process-gone', ...d }));
  wc.on('console-message', (_e, level, message) => { if (level >= 2 && !String(message).includes('Electron Security Warning')) ev({ label, type: 'console', level, message: String(message).slice(0, 200) }); });
  wc.on('preload-error', (_e, p, err) => ev({ label, type: 'preload-error', message: String(err) }));
}

async function loadDoc(win, fx, variant, tmpFile) {
  if (variant === 'dataurl') {
    const b64 = Buffer.from(fs.readFileSync(path.join(fixturesDir, fx.file), 'utf8'), 'utf8').toString('base64');
    await win.loadURL('data:text/html;charset=utf-8;base64,' + b64);
  } else {
    fs.copyFileSync(path.join(fixturesDir, fx.file), tmpFile);
    await win.loadFile(tmpFile);
  }
}

async function exportPdf(fx, variant) {
  const tmpFile = path.join(os.tmpdir(), `pdfdiag_${process.pid}_${Date.now()}.html`);
  // default window size on purpose: the app's pdf:export window is created without width/height
  const win = new BrowserWindow({ show: variant === 'visible', webPreferences: { ...WEB, offscreen: false, ...(variant === 'nothrottle' ? { backgroundThrottling: false } : {}) } });
  track(win, `${variant}/${fx.name}`);
  const t0 = Date.now(); const rec = { fixture: fx.name, variant, ok: false };
  try {
    await withTimeout(loadDoc(win, fx, variant, tmpFile), 60000, 'load');
    rec.loadMs = Date.now() - t0;
    rec.willNavigateListeners = win.webContents.listenerCount('will-navigate'); // >0 only when the app's real guards are installed (proof for app-guards)
    try { await withTimeout(win.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(()=>true) : true'), 30000, 'fonts.ready'); } catch (e) { rec.fontsReadyError = String(e.message || e); }
    if (variant === 'wait-images') {
      await withTimeout(win.webContents.executeJavaScript('Promise.all([...document.images].map(i=>i.complete?1:new Promise(r=>{i.onload=i.onerror=r;})))'), 30000, 'images');
    } else if (variant === 'wait-frames') {
      try { await withTimeout(win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'), 10000, 'animation frames'); }
      catch (e) { rec.framesWaitError = String(e.message || e); } // a hidden window may never produce frames: that is itself a finding
    } else if (variant === 'wait-300ms') {
      await sleep(300);
    }
    const data = await withTimeout(win.webContents.printToPDF(PDF_OPTS(fx.landscape)), 60000, 'printToPDF');
    const dir = path.join(outRoot, process.versions.electron, variant); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, fx.name + '.pdf'); fs.writeFileSync(file, data);
    Object.assign(rec, { ok: true, pdf: path.relative(outRoot, file).split(path.sep).join('/'), bytes: data.length, totalMs: Date.now() - t0 });
  } catch (e) { rec.error = String(e.message || e); }
  finally { if (!win.isDestroyed()) win.destroy(); try { fs.unlinkSync(tmpFile); } catch {} }
  return rec;
}

// print:html -> webContents.print. The deviceName cannot exist, so this never reaches a real printer; it records how the call fails and which
// printers the OS reports (names/status only).
async function nativePrint(fx) {
  const tmpFile = path.join(os.tmpdir(), `pdfdiag_print_${process.pid}_${Date.now()}.html`);
  const win = new BrowserWindow({ show: false, webPreferences: WEB });
  track(win, `print/${fx.name}`);
  const rec = { fixture: fx.name, variant: 'print-native', ok: false };
  try {
    await withTimeout(loadDoc(win, fx, 'asis', tmpFile), 60000, 'load');
    await withTimeout(win.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(()=>true) : true'), 30000, 'fonts.ready').catch(() => {});
    try {
      const list = await withTimeout(win.webContents.getPrintersAsync(), 15000, 'getPrintersAsync');
      rec.printers = list.map((p) => ({ name: p.name, isDefault: !!p.isDefault, status: p.status }));
    } catch (e) { rec.printersError = String(e.message || e); }
    rec.result = await withTimeout(new Promise((resolve) => win.webContents.print({ silent: true, deviceName: 'pdfdiag-nonexistent-printer', printBackground: true, landscape: fx.landscape, pageSize: 'A4', margins: { marginType: 'none' } }, (success, errorType) => resolve({ success, errorType }))), 30000, 'print');
    rec.ok = true;
  } catch (e) { rec.error = String(e.message || e); }
  finally { if (!win.isDestroyed()) win.destroy(); try { fs.unlinkSync(tmpFile); } catch {} }
  return rec;
}

function installRealGuards() {
  const bundle = process.env.PDFDIAG_SECURITY;
  if (!bundle || !fs.existsSync(bundle)) return 'PDFDIAG_SECURITY bundle not provided - run via run-local.mjs (bundle-security.mjs builds it from electron/security.js)';
  try { require(bundle).installSecurityGuards(); return null; } catch (e) { return 'installSecurityGuards failed: ' + String(e && e.message || e); }
}

app.whenReady().then(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'manifest.json'), 'utf8'));
  for (const variant of VARIANTS) {
    let mainWin = null; let skip = null;
    if (variant === 'app-guards') skip = installRealGuards();
    if (skip) { const r = { fixture: '*', variant, ok: false, error: skip }; record(r); console.log(`SKIP ${variant}: ${skip}`); continue; }
    if (variant === 'with-main-window') {
      mainWin = new BrowserWindow({ show: true, width: 800, height: 600, webPreferences: WEB });
      await mainWin.loadURL('data:text/html;charset=utf-8,<title>diag</title><body>main window</body>');
    }
    for (const fx of manifest) { const r = await exportPdf(fx, variant); record(r); console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${variant}/${fx.name} ${r.bytes ?? ''} ${r.error ?? ''}`); }
    if (mainWin && !mainWin.isDestroyed()) mainWin.destroy();
  }
  for (const fx of manifest.slice(0, 2)) { const r = await nativePrint(fx); record(r); console.log(`PRINT ${fx.name}: ${JSON.stringify(r.result || r.error)} printers=${(r.printers || []).length}`); }
  fs.writeFileSync(path.join(verDir, 'run.json'), JSON.stringify({ meta, results, events }, null, 2));
  console.log('DONE', JSON.stringify(meta));
  app.exit(0);
});
