import { app, BrowserWindow } from 'electron';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { APP_NAME, BUILD_MARKER, FRONTEND_ROOT } from './constants.js';
import { state as sharedState } from './state.js';
import { getPaths } from './paths.js';

// ─── Splash IPC bridge — functional checklist, driven by real readiness ──────
// Every label here maps 1:1 to a real, independently-observable readiness
// signal already tracked by the poller in lifecycle.js (see markSplashStep
// call sites) — there is deliberately no separate tick for things like
// "Attendance Engine" / "Payroll Engine" that have no distinct startup-time
// initialization of their own (they're stateless per-request calculation
// modules, not services with a boot phase) — inventing a tick for those would
// be exactly the fake progress this checklist exists to avoid.
const SPLASH_ITEMS = [
  'تحميل الواجهة',            // renderer did-finish-load
  'الاتصال بقاعدة البيانات',   // /api/startup-status → dbConnected
  'تشغيل الخدمات الأساسية',    // sync scheduler + realtime listeners launched
  'الاتصال بجهاز البصمة',      // realtime device link established (or none configured)
  'تجهيز لوحة التحكم',         // aggregate: every step above complete
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
    // EP-010: uploads now live in the persistent config dir (configDir),
    // not resources/backend — falls back to the old backendCwd-relative
    // location in dev mode, where configDir is null and uploads still sit
    // in the source tree.
    const paths = getPaths();
    const uploadsRoot = paths.configDir
      ? join(paths.configDir, 'uploads')
      : join(paths.backendCwd, 'uploads');
    const cacheFile = join(uploadsRoot, 'company', 'cache.json');
    if (!existsSync(cacheFile)) return null;
    const map = JSON.parse(readFileSync(cacheFile, 'utf8'));
    const name = (map.company_name_ar || '').trim();
    const tagline = (map.company_description || '').trim();
    const logoPath = (map.logo_url || '').trim();
    let logoFileUrl = null;
    if (logoPath) {
      const logoFile = join(uploadsRoot, 'company', logoPath.replace(/^\/?uploads\/company\//, ''));
      if (existsSync(logoFile)) logoFileUrl = `file:///${logoFile.replace(/\\/g, '/')}`;
    }
    return { name: name || null, tagline: tagline || null, logoFileUrl };
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
  const splashTag   = escapeHtml(splashBrand?.tagline || 'Enterprise Resource Planning · الحضور والرواتب');
  const splashLogo  = splashBrand?.logoFileUrl
    ? `<img src="${escapeHtml(splashBrand.logoFileUrl)}" style="width:100%;height:100%;object-fit:contain;border-radius:26px" />`
    : `<span style="font-size:50px;font-weight:900;color:#fff;font-family:'Segoe UI',Arial;line-height:1">P</span>`;

  // Real product identity, not decorative filler — app.getVersion() reads
  // package.json's "version" (the same field the packaged installer's
  // filename is stamped with), and the build date is parsed straight out of
  // BUILD_MARKER (bumped on every re-package) rather than duplicated by hand.
  const appVersion = escapeHtml(app.getVersion());
  const buildDateMatch = /BUILD:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/.exec(BUILD_MARKER);
  const buildLabel = escapeHtml(buildDateMatch ? buildDateMatch[1] : BUILD_MARKER);

  splashWindow = new BrowserWindow({
    width: 520, height: 380,
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
html,body{width:100%;height:100%;overflow:hidden;}
body{
  position:relative;
  background:radial-gradient(120% 140% at 50% -10%,#0f2555 0%,#020817 62%);
  color:#f1f5f9;font-family:'Segoe UI',Tahoma,Arial,sans-serif;
  display:flex;flex-direction:column;align-items:center;
  justify-content:center;height:100vh;gap:20px;user-select:none;
  -webkit-app-region:drag;
}
/* Premium ambience — a slow-drifting glow behind the identity block, purely
   decorative (never gates or represents real progress on its own). */
.ambience{position:absolute;inset:0;pointer-events:none;overflow:hidden;}
.ambience::before{
  content:'';position:absolute;width:640px;height:640px;left:50%;top:-420px;
  transform:translateX(-50%);border-radius:50%;
  background:radial-gradient(circle,rgba(59,130,246,0.16) 0%,rgba(59,130,246,0) 70%);
  animation:drift 7s ease-in-out infinite;
}
@keyframes drift{0%,100%{opacity:0.6;transform:translateX(-50%) scale(1);}50%{opacity:1;transform:translateX(-50%) scale(1.08);}}
/* Premium entrance — logo rises/settles first, identity + progress follow
   in a short staggered cascade instead of appearing all at once. */
@keyframes rise{from{opacity:0;transform:translateY(10px) scale(0.94);}to{opacity:1;transform:translateY(0) scale(1);}}
.logo{
  width:96px;height:96px;background:linear-gradient(135deg,#1d4ed8,#3b82f6);
  border-radius:28px;display:flex;align-items:center;justify-content:center;
  box-shadow:0 16px 50px rgba(59,130,246,0.45);position:relative;z-index:1;
  animation:rise 0.5s cubic-bezier(0.16,1,0.3,1) both, pulse 2.4s ease-in-out 0.5s infinite;
}
@keyframes pulse{0%,100%{box-shadow:0 16px 50px rgba(59,130,246,0.45);}50%{box-shadow:0 16px 66px rgba(59,130,246,0.72);}}
.identity{animation:rise 0.5s cubic-bezier(0.16,1,0.3,1) 0.12s both;position:relative;z-index:1;}
.title{font-size:22px;font-weight:800;letter-spacing:1px;}
.sub{font-size:11.5px;color:#7d8bab;margin-top:5px;}
.track{width:280px;height:5px;background:#0f172a;border-radius:3px;overflow:hidden;border:1px solid #1e3a5f;
  animation:rise 0.5s cubic-bezier(0.16,1,0.3,1) 0.22s both;position:relative;z-index:1;}
.fill{height:100%;width:0;background:linear-gradient(90deg,#1d4ed8,#60a5fa);border-radius:3px;
  transition:width 0.4s cubic-bezier(0.4,0,0.2,1);position:relative;overflow:hidden;}
/* Subtle shimmer sweep riding the actual fill width — cosmetic texture on
   real progress, not a substitute for it (width itself only ever moves in
   response to a genuine markSplashStep() call from lifecycle.js). */
.fill::after{
  content:'';position:absolute;inset:0;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,0.35),transparent);
  width:60px;animation:shimmer 1.3s ease-in-out infinite;
}
@keyframes shimmer{0%{transform:translateX(-80px);}100%{transform:translateX(340px);}}
.checklist{display:flex;flex-direction:column;gap:6px;width:280px;
  animation:rise 0.5s cubic-bezier(0.16,1,0.3,1) 0.3s both;position:relative;z-index:1;}
.item{display:flex;align-items:center;gap:8px;font-size:12px;color:#475569;transition:color 0.25s;}
.item.done{color:#cbd5e1;}
.mark{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;
  border:1.5px solid #334155;font-size:9px;line-height:1;color:transparent;transition:all 0.25s;flex-shrink:0;}
.item.done .mark{border-color:#22c55e;background:#22c55e;color:#fff;}
.item.pending .mark{border-color:#2563eb;}
@keyframes spin{to{transform:rotate(360deg);}}
.item.pending .mark{border-top-color:transparent;animation:spin 0.8s linear infinite;}
.identityFooter{
  position:absolute;bottom:16px;left:0;right:0;text-align:center;
  font-size:10px;color:#3f5178;letter-spacing:0.4px;
  animation:rise 0.5s cubic-bezier(0.16,1,0.3,1) 0.38s both;
}
</style>
</head>
<body>
<div class="ambience"></div>
<div class="logo" ${splashBrand?.logoFileUrl ? 'style="background:#0b1a35"' : ''}>
  ${splashLogo}
</div>
<div class="identity" style="text-align:center">
  <div class="title" style="letter-spacing:2px">${splashName}</div>
  <div class="sub">${splashTag}</div>
</div>
<div class="track"><div class="fill" id="fill"></div></div>
<div class="checklist" id="checklist"></div>
<div class="identityFooter">الإصدار ${appVersion} · Build ${buildLabel}</div>
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
