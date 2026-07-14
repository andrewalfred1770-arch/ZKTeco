import { BrowserWindow } from 'electron';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { FRONTEND_ROOT } from './constants.js';
import { state as sharedState } from './state.js';
import { getPaths } from './paths.js';

// ─── Splash IPC bridge — functional checklist, driven by real readiness ──────
const SPLASH_ITEMS = [
  'تحميل الواجهة',
  'تشغيل قاعدة البيانات',
  'تشغيل الخدمات',
  'الاتصال بجهاز البصمة',
  'تهيئة النظام',
];

// index: 0=UI loaded, 1=DB connected, 2=background services started,
// 3=fingerprint device link (or "no device configured"), 4=overall ready.
let splashState = SPLASH_ITEMS.map(() => false);
let splashWindow = null;

export function sendSplashState(pctOverride) {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  const items = SPLASH_ITEMS.map((label, i) => ({ label, done: splashState[i] }));
  const pct = pctOverride ?? Math.round(
    (splashState.filter(Boolean).length / SPLASH_ITEMS.length) * 100
  );
  splashWindow.webContents.send('progress', { items, pct });
}

export function markSplashStep(i, done = true) {
  if (splashState[i] === done) return;
  splashState[i] = done;
  sendSplashState();
}

// Read-only accessor — lifecycle.js's readiness poller checks specific step
// indices (splashState[0]/[1]/[2]/[3]) to decide when all core steps are done.
export function isSplashStepDone(i) {
  return splashState[i];
}

// ─── Progressive App Readiness — broadcast to the renderer ───────────────────
// UI / Backend / Realtime / Device readiness are independent states. The
// renderer can subscribe via window.electron.onMessage and is never blocked
// waiting for any of these — they're informational.
export function notifyRenderer(state) {
  if (!sharedState.mainWindow || sharedState.mainWindow.isDestroyed()) return;
  sharedState.mainWindow.webContents.send('main:message', { type: 'app:ready-state', state, timestamp: Date.now() });
}

// ─── Splash window ────────────────────────────────────────────────────────────
// Reads the live "بيانات الشركة" snapshot (written by companySettingsStore on
// every change) so the splash — the closest thing this no-auth desktop app has
// to a "login screen" — shows the current company name/logo on the very next
// launch, with no rebuild. Falls back to the static PETSHROW branding when the
// snapshot doesn't exist yet (fresh install before the seed/first save runs).
function readCompanySplashBrand() {
  try {
    const cacheFile = join(getPaths().backendCwd, 'uploads', 'company', 'cache.json');
    if (!existsSync(cacheFile)) return null;
    const map = JSON.parse(readFileSync(cacheFile, 'utf8'));
    const name = (map.company_name_ar || '').trim();
    const logoPath = (map.logo_url || '').trim();
    let logoFileUrl = null;
    if (logoPath) {
      const logoFile = join(getPaths().backendCwd, 'uploads', 'company', logoPath.replace(/^\/?uploads\/company\//, ''));
      if (existsSync(logoFile)) logoFileUrl = `file:///${logoFile.replace(/\\/g, '/')}`;
    }
    return { name: name || null, logoFileUrl };
  } catch { return null; }
}

// EF-007.1: company_name_ar/logo_url are user-editable settings persisted to
// uploads/company/cache.json and read back here — must be HTML-escaped before
// interpolation into the splash's HTML, since this window (see webPreferences
// below) previously ran with nodeIntegration:true, making unescaped injection
// here a direct RCE path.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function createSplash() {
  const splashBrand = readCompanySplashBrand();
  const splashName  = escapeHtml((splashBrand?.name) || 'PETSHROW');
  const splashLogo  = splashBrand?.logoFileUrl
    ? `<img src="${escapeHtml(splashBrand.logoFileUrl)}" style="width:100%;height:100%;object-fit:contain;border-radius:22px" />`
    : `<span style="font-size:42px;font-weight:900;color:#fff;font-family:'Segoe UI',Arial;line-height:1">P</span>`;

  splashWindow = new BrowserWindow({
    width: 460, height: 300,
    frame: false, alwaysOnTop: true,
    resizable: false, center: true,
    backgroundColor: '#020817',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(FRONTEND_ROOT, 'splashPreload.cjs'),
      devTools: false,
    },
  });

  const html = `<!DOCTYPE html>
<html dir="rtl">
<head>
<meta charset="UTF-8">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{
  background:linear-gradient(135deg,#020817 0%,#0c1a3a 100%);
  color:#f1f5f9;font-family:'Segoe UI',Tahoma,Arial,sans-serif;
  display:flex;flex-direction:column;align-items:center;
  justify-content:center;height:100vh;gap:18px;user-select:none;
  -webkit-app-region:drag;
}
.logo{
  width:76px;height:76px;background:linear-gradient(135deg,#1d4ed8,#3b82f6);
  border-radius:22px;display:flex;align-items:center;justify-content:center;
  box-shadow:0 12px 40px rgba(59,130,246,0.45);
  animation:pulse 2s ease-in-out infinite;
}
@keyframes pulse{0%,100%{box-shadow:0 12px 40px rgba(59,130,246,0.45);}50%{box-shadow:0 12px 60px rgba(59,130,246,0.7);}}
.title{font-size:20px;font-weight:700;letter-spacing:-0.3px;}
.sub{font-size:12px;color:#64748b;margin-top:4px;}
.track{width:260px;height:5px;background:#0f172a;border-radius:3px;overflow:hidden;border:1px solid #1e3a5f;}
.fill{height:100%;width:0;background:linear-gradient(90deg,#1d4ed8,#60a5fa);border-radius:3px;transition:width 0.4s cubic-bezier(0.4,0,0.2,1);}
.checklist{display:flex;flex-direction:column;gap:6px;width:260px;}
.item{display:flex;align-items:center;gap:8px;font-size:12px;color:#475569;transition:color 0.25s;}
.item.done{color:#cbd5e1;}
.mark{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;
  border:1.5px solid #334155;font-size:9px;line-height:1;color:transparent;transition:all 0.25s;flex-shrink:0;}
.item.done .mark{border-color:#22c55e;background:#22c55e;color:#fff;}
.item.pending .mark{border-color:#2563eb;}
@keyframes spin{to{transform:rotate(360deg);}}
.item.pending .mark{border-top-color:transparent;animation:spin 0.8s linear infinite;}
</style>
</head>
<body>
<div class="logo" ${splashBrand?.logoFileUrl ? 'style="background:#0b1a35"' : ''}>
  ${splashLogo}
</div>
<div style="text-align:center">
  <div class="title" style="letter-spacing:2px">${splashName}</div>
  <div class="sub">Enterprise Resource Planning · الحضور والرواتب</div>
</div>
<div class="track"><div class="fill" id="fill"></div></div>
<div class="checklist" id="checklist"></div>
<script>
const fill = document.getElementById('fill');
const list = document.getElementById('checklist');

function render(items) {
  list.innerHTML = items.map((it, i) => \`
    <div class="item \${it.done ? 'done' : 'pending'}">
      <span class="mark">\${it.done ? '✓' : ''}</span>
      <span>\${it.label}</span>
    </div>\`).join('');
}

window.splash.onProgress(({ items, pct }) => {
  if (items) render(items);
  if (typeof pct === 'number') fill.style.width = pct + '%';
});
</script>
</body>
</html>`;

  splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  splashWindow.webContents.once('did-finish-load', () => sendSplashState());
  return splashWindow;
}

export function closeSplash() {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  sendSplashState(100);
  setTimeout(() => {
    if (!splashWindow?.isDestroyed()) splashWindow.close();
    splashWindow = null;
  }, 350);
}
