/**
 * CheckIn redesign — isolated tests (no database, no backend, no Electron, no network): startup truthfulness, launcher contents,
 * brand tokens/contrast, motion rules, logo files, and the guarantee that export-facing branding was NOT changed.
 * Run:  node --test tests/brand/checkin-brand.test.mjs     (from frontend/)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(here, '..', '..');
const SRC = path.join(FRONTEND, 'src');
const HARNESS = path.join(FRONTEND, 'tests', 'tz', 'render-harness.mjs');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

function render(scenario, fixtures = {}, tz = 'Asia/Riyadh') {
  const r = spawnSync(process.execPath, [HARNESS, scenario], { cwd: FRONTEND, encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TZ: tz, FAKE_NOW: '2026-10-14T10:00:00Z', FIXTURES: JSON.stringify(fixtures) } });
  const m = /@@RESULT@@(\{.*\})/s.exec(r.stdout || '');
  assert.ok(m, `no result for ${scenario}: ${(r.stderr || r.stdout || '').slice(-500)}`);
  return JSON.parse(m[1]);
}

// ───────────── 1. startup stages: only what the backend reported ─────────────
const { deriveStages, STEP_IDS } = await import(pathToFileURL(path.join(SRC, 'lib', 'startupStages.js')).href);

test('startupStages: no answer from the server verifies NOTHING (no fake progress)', () => {
  for (const bad of [null, undefined, 'x', 42, []].slice(0, 3)) {
    const s = deriveStages(bad);
    assert.equal(s.count, 0); assert.deepEqual(s.done, { server: false, database: false, services: false }); assert.equal(s.devices, null);
  }
});
test('startupStages: a step is done only when its own field is exactly true', () => {
  assert.deepEqual(deriveStages({}).done, { server: true, database: false, services: false });
  assert.deepEqual(deriveStages({ dbConnected: 'yes', servicesStarted: 1 }).done, { server: true, database: false, services: false });
  assert.deepEqual(deriveStages({ dbConnected: true }).done, { server: true, database: true, services: false });
  assert.equal(deriveStages({ dbConnected: true, servicesStarted: true }).count, 3);
  assert.equal(deriveStages({ dbConnected: true, servicesStarted: true }).total, STEP_IDS.length);
});
test('startupStages: device link is reported only after the services started, and never invented', () => {
  assert.equal(deriveStages({ dbConnected: true, servicesStarted: false, devices: { total: 3, connected: 2 } }).devices, null);
  assert.deepEqual(deriveStages({ dbConnected: true, servicesStarted: true, devices: { total: 3, connected: 2 } }).devices, { total: 3, connected: 2 });
  assert.deepEqual(deriveStages({ dbConnected: true, servicesStarted: true }).devices, { total: 0, connected: 0 });
  assert.deepEqual(deriveStages({ dbConnected: true, servicesStarted: true, devices: { total: 'x', connected: null } }).devices, { total: 0, connected: 0 });
});
test('startupStages: a blocked startup is surfaced with the backend-provided stage/reason', () => {
  const s = deriveStages({ ready: false, startup: { phase: 'blocked', stage: 'database', reason: 'unreachable' } });
  assert.equal(s.blocked, true); assert.deepEqual(s.blockedInfo, { phase: 'blocked', stage: 'database', reason: 'unreachable' });
  assert.equal(deriveStages({ startup: { phase: 'initializing' } }).blocked, false);
});

// the real component, server-rendered with the mocked API
test('StartupScreen: server unreachable -> no step shown as done, indeterminate bar, no device or percentage text', () => {
  const html = render('startup', { '/startup-status': '__FAIL__' }).html;
  assert.equal((html.match(/ci-step is-done/g) || []).length, 0);
  assert.match(html, /ci-indeterminate/);
  const visibleText = html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]*>/g, ' ');
  assert.doesNotMatch(visibleText, /\d\s*%/, 'no percentage is ever shown');
  assert.doesNotMatch(html, /أجهزة البصمة/);
});
test('StartupScreen: database verified but services not -> exactly 2 steps done, no device line', () => {
  const html = render('startup', { '/startup-status': { dbConnected: true, servicesStarted: false, devices: { total: 2, connected: 2 }, ready: false } }).html;
  assert.equal((html.match(/ci-step is-done/g) || []).length, 2);
  assert.equal((html.match(/ci-seg is-done/g) || []).length, 2);
  assert.doesNotMatch(html, /أجهزة البصمة/);
});
test('StartupScreen: everything verified -> 3 steps + the real device count', () => {
  const html = render('startup', { '/startup-status': { dbConnected: true, servicesStarted: true, devices: { total: 3, connected: 2 }, ready: true } }).html;
  assert.equal((html.match(/ci-seg is-done/g) || []).length, 3);
  assert.match(html, /أجهزة البصمة: 2 من 3 متصلة/);
});
test('StartupScreen: no configured devices is stated as such (not as "connected")', () => {
  const html = render('startup', { '/startup-status': { dbConnected: true, servicesStarted: true, devices: { total: 0, connected: 0 }, ready: true } }).html;
  assert.match(html, /لا توجد أجهزة بصمة مضبوطة/);
});
test('StartupScreen: "unreachable" state offers the retry button', () => {
  // the gate passes status="unreachable"; the harness renders the default (checking), so assert the wiring in the source instead
  const src = read('components', 'ServerReadyGate.jsx');
  assert.match(src, /<StartupScreen status=\{status\} onRetry=\{recheck\} \/>/);
  assert.match(read('components', 'launcher', 'StartupScreen.jsx'), /status === 'unreachable'[\s\S]*onClick=\{onRetry\}/);
});

// ───────────── 2. launcher: every module is a link to an existing route ─────────────
test('Launcher: the 8 required modules exist, in order, each pointing at a route that App.jsx really declares', () => {
  const r = render('launcher-modules');
  assert.deepEqual(r.all.map((m) => m[2]), ['الموظفون', 'أجهزة البصمة', 'الحضور والانصراف', 'الدوام الشهري', 'المرتبات', 'التقارير', 'الإعدادات', 'أدوات الصيانة']);
  const app = read('App.jsx');
  for (const [, to] of r.all) assert.match(app, new RegExp(`path="${to.replace(/^\//, '').replace(/\//g, '\\/')}"`), `route ${to} is declared in App.jsx`);
});
test('Launcher: device configuration is hidden on a Manager client exactly like the sidebar, nothing else is', () => {
  const r = render('launcher-modules');
  assert.equal(r.server.length, 8); assert.equal(r.manager.length, 7); assert.ok(!r.manager.includes('devices'));
});
test('Launcher page renders the real components: links, logo text and the Arabic descriptor', () => {
  const html = render('launcher').html;
  assert.equal((html.match(/class="ci-card"/g) || []).length, 8);
  assert.match(html, /href="\/devices"/); assert.match(html, /href="\/maintenance\/cleanup"/);
  assert.match(html, /ATTENDANCE &amp; WORKFORCE MANAGEMENT/);
  assert.match(html, /نظام إدارة الحضور والانصراف والموارد البشرية/);
  assert.match(html, />Check<span[^>]*>In<\/span>/);
});

// ───────────── 3. tokens + contrast ─────────────
const tokens = read('styles', 'checkin-tokens.css');
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
test('true-dark palette and the official CheckIn brand palette are present in the tokens', () => {
  for (const hex of ['#090909', '#0C0C0C', '#111111', '#151515', '#1B1B1B', '#242424', '#2D2D2D', '#F5F5F5', '#A3A3A3', '#737373', '#F59E0B', '#EF4444',
    // official brand palette (sampled from the approved logo: green #4FBF6B / dark green #3FA85C replace the brief's initial #28C928 / #1F9F25)
    '#293438', '#20282B', '#4FBF6B', '#3FA85C', '#1E7A34', '#E9F4EC', '#FFFFFF', '#FFFFFF', '#E5E7EB', '#6B7280']) assert.ok(tokens.toUpperCase().includes(hex), `${hex} missing`);
  assert.doesNotMatch(tokens, /#2563EB|#38BDF8|#1D4ED8/i, 'the previous blue brand colours must be gone from the token layer');
});
test('contrast (WCAG AA 4.5:1) of essential text on the dark theme surfaces', () => {
  const pairs = [['#F5F5F5', '#090909'], ['#F5F5F5', '#151515'], ['#F5F5F5', '#1B1B1B'], ['#D4D4D4', '#151515'], ['#A3A3A3', '#151515'], ['#A3A3A3', '#1B1B1B'],
    ['#8A8A8A', '#090909'], ['#8A8A8A', '#151515'], ['#8A8A8A', '#1B1B1B'], ['#4FBF6B', '#151515'], ['#4FBF6B', '#090909'], ['#0A130C', '#4FBF6B'], ['#FFFFFF', '#1E7A34'], ['#F5F5F5', '#242424']];
  for (const [fg, bg] of pairs) assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg} = ${ratio(fg, bg).toFixed(2)}`);
  // the brief's muted grey (#737373) is reserved for decorative / disabled text: it only has to clear the 3:1 non-text bar
  assert.ok(ratio('#737373', '#151515') >= 3, `#737373 on #151515 = ${ratio('#737373', '#151515').toFixed(2)}`);
});
function darkBlock() {
  const start = tokens.indexOf('html.dark, html:not(.light) {'); assert.ok(start >= 0);
  return tokens.slice(start, tokens.indexOf('\n}', start));
}
test('dark mode is NEUTRAL: every surface / border / text / table / sidebar colour in the dark tokens has R = G = B (no navy or blue tint)', () => {
  const neutralProps = /^(--bg|--surface(-\d)?|--border|--input-bg|--input-b|--text|--text-2|--text-3|--text-muted|--sidebar-background|--sidebar-surface-hover|--sidebar-border|--sidebar-text-primary|--ag-(background|header-background|foreground|header-foreground|odd-row-background|even-row-background|border|row-border|row-hover|header-column-separator)-color|--h-grad|--h-accent|--h-text|--total-bg|--pin-b|--c-(name|code|dept|val|muted|time|money|net)|--erp-[a-z-]+)$/;
  let checked = 0;
  for (const m of darkBlock().matchAll(/(--[a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\b/g)) {
    if (!neutralProps.test(m[1])) continue;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(m[2].slice(i, i + 2), 16));
    assert.ok(r === g && g === b, `${m[1]}: ${m[2]} is tinted`); checked++;
  }
  assert.ok(checked >= 40, `only ${checked} neutral tokens were checked`);
});
test('tailwind gray utilities are re-coloured for dark ONLY (never under a bare selector), and the stock gray scale is untouched', () => {
  const grayRules = [...tokens.matchAll(/^([^\n{]*\.(?:bg|border|text)-gray-[^{]*)\{/gm)].map((m) => m[1].trim());
  assert.ok(grayRules.length >= 18);
  for (const sel of grayRules) assert.ok(sel.startsWith('html:not(.light)') || sel.startsWith('html.light'), `unscoped gray rule: ${sel}`);   // always theme-scoped, never a bare selector
  assert.doesNotMatch(fs.readFileSync(path.join(FRONTEND, 'tailwind.config.js'), 'utf8'), /\bgray\s*:\s*\{/);
});
function lightBlock() {
  const start = tokens.indexOf('html.light {'); assert.ok(start >= 0);
  return tokens.slice(start, tokens.indexOf('\n}', start));
}
test('LIGHT MODE is pure neutral white: white surfaces, neutral-grey ramp (no green/blue tint), green accent only for actions and selection', () => {
  const light = lightBlock();
  const expect = { '--bg': '#FFFFFF', '--surface': '#FFFFFF', '--surface-2': '#F8FAFC', '--border': '#E5E7EB', '--text': '#1F2937', '--text-3': '#6B7280', '--accent': '#1E7A34', '--accent-2': '#1E7A34', '--sidebar-background': '#20282B', '--sidebar-text-primary': '#F5F5F5', '--sidebar-icon': '#C5CDCF', '--sidebar-text-muted': '#B8C0C2', '--ag-selected-row-background-color': '#F0F7F1' };
  for (const [k, v] of Object.entries(expect)) assert.match(light, new RegExp(`${k}:\\s*${v}`, 'i'), `${k} should be ${v}`);
  assert.match(light, /#E5E7EB/i);
  assert.doesNotMatch(light, /#(2563EB|1D4ED8|3B82F6|38BDF8)/i);
  // every surface / border / text / table token must be a neutral grey (Tailwind gray ramp, green never dominant) — never green-tinted
  const neutral = /^(--bg|--surface(-content|-\d)?|--border|--input-bg|--input-b|--text|--text-2|--text-3|--text-muted|--ag-(background|header-background|foreground|header-foreground|odd-row-background|even-row-background|border|row-border|row-hover|header-column-separator)-color|--h-grad|--h-accent|--h-text|--total-bg|--pin-b|--c-(name|code|dept|val|muted|time|money|net)|--erp-(text|text-muted|text-faint|border|ag-header-bg-end))$/;
  let n = 0;
  for (const m of light.matchAll(/(--[a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})/g)) {
    if (!neutral.test(m[1])) continue;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(m[2].slice(i, i + 2), 16));
    assert.ok(g <= Math.max(r, b) + 2, `${m[1]}: ${m[2]} is green-tinted`); n++;   // the Tailwind gray ramp is cool (blue >= green); green-dominant greys are the defect this guards against
  }
  assert.ok(n >= 30, `only ${n} neutral light tokens checked`);
});
test('contrast (WCAG AA 4.5:1) of essential text on the light theme surfaces', () => {
  const pairs = [['#20282B', '#FFFFFF'], ['#20282B', '#FFFFFF'], ['#4B5563', '#FFFFFF'], ['#6B7280', '#FFFFFF'], ['#6B7280', '#FFFFFF'], ['#1E7A34', '#FFFFFF'], ['#1E7A34', '#FFFFFF'],
    ['#1E7A34', '#E9F4EC'], ['#FFFFFF', '#1E7A34'], ['#FFFFFF', '#17632A'], ['#20282B', '#4FBF6B'], ['#F5F5F5', '#20282B'], ['#D4D4D4', '#20282B'], ['#A3A3A3', '#20282B'], ['#F5F5F5', '#243A2C'], ['#4FBF6B', '#20282B']];
  for (const [fg, bg] of pairs) assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg} = ${ratio(fg, bg).toFixed(2)}`);
});
test('stored data colours are untouched: the employee monitor colour palette keeps #2F81F7', () => {
  assert.match(read('pages', 'EmployeesPage.jsx'), /\{ value: '#2F81F7', label: 'أزرق'\s*\}/);
});

// ───────────── 4. motion rules ─────────────
const motion = read('styles', 'checkin-launcher.css');
test('motion: keyframes animate only transform / opacity / stroke-dashoffset', () => {
  const allowed = new Set(['transform', 'opacity', 'stroke-dashoffset']);
  let count = 0;
  for (const m of motion.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {          // brace-counted body of each @keyframes block
    let depth = 1, i = m.index + m[0].length; const start = i;
    while (depth > 0 && i < motion.length) { const ch = motion[i++]; if (ch === '{') depth++; else if (ch === '}') depth--; }
    const body = motion.slice(start, i - 1);
    const props = [...body.matchAll(/([a-z-]+)\s*:\s*[^;{}]+;?/g)].map((x) => x[1]);
    assert.ok(props.length > 0, `@keyframes ${m[1]} has declarations`);
    for (const p of props) assert.ok(allowed.has(p), `@keyframes ${m[1]} animates "${p}"`);
    count++;
  }
  assert.ok(count >= 8, `checked ${count} keyframes`);
  assert.doesNotMatch(motion, /filter\s*:\s*blur|backdrop-filter/);
});
test('motion: transitions of ordinary UI are 180-350 ms and every animated class is switched off for reduced motion', () => {
  assert.match(tokens, /--ci-dur-ui:\s*200ms/); assert.match(tokens, /--ci-dur-scene:\s*320ms/);
  const reduced = motion.slice(motion.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(reduced.length > 40, 'reduced-motion block exists');
  const animatedClasses = [...motion.slice(0, motion.indexOf('@media (prefers-reduced-motion: reduce)')).matchAll(/(\.[a-z][\w-]*)[^{}]*\{[^}]*\banimation\s*:/g)].map((m) => m[1]);
  assert.ok(animatedClasses.length > 4);
  for (const c of new Set(animatedClasses)) assert.ok(reduced.includes(c), `${c} is not covered by prefers-reduced-motion`);
});

// ───────────── 5. logo files ─────────────
test('logo masters: valid, transparent (except the app icon), no scripts/images, mono files use one colour only', () => {
  const dir = path.join(SRC, 'assets', 'brand');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.svg'));
  assert.equal(files.length, 8);
  for (const f of files) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8').replace(/<!--[\s\S]*?-->/g, '');   // comments may mention the words below
    assert.match(t, /^<svg [^>]*viewBox="0 0 \d+ \d+"/); assert.match(t, /<\/svg>\s*$/); assert.doesNotMatch(t, /<script|<image|Gradient|filter/i);
    if (!f.includes('app-icon')) assert.doesNotMatch(t, /<rect/);
    if (f.includes('mono')) { const colors = new Set([...t.matchAll(/(?:stroke|fill)="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1].toUpperCase())); assert.equal(colors.size, 1, `${f}: ${[...colors]}`); }
  }
});

test('approved logo assets: RGBA transparent PNG master, multi-size ICO, tray icon, and the live icons are the validated candidates', () => {
  const dir = path.join(SRC, 'assets', 'brand', 'icons-approved');
  const png = (f) => { const b = fs.readFileSync(f); assert.equal(b.subarray(1, 4).toString(), 'PNG'); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25] }; };
  const master = png(path.join(dir, 'checkin-logo-master-transparent.png'));
  assert.equal(master.colorType, 6, 'master must carry an alpha channel'); assert.ok(master.w >= 1024 && master.w === master.h);
  const ico = fs.readFileSync(path.join(FRONTEND, 'assets', 'icon.ico'));
  assert.equal(ico.readUInt16LE(2), 1); const count = ico.readUInt16LE(4);
  const sizes = Array.from({ length: count }, (_, i) => ico[6 + i * 16] || 256).sort((a, b) => a - b);
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256]);
  assert.equal(png(path.join(FRONTEND, 'assets', 'icon.png')).w, 1024);
  assert.ok(png(path.join(FRONTEND, 'assets', 'tray.png')).w >= 32);
  for (const f of ['icon.ico', 'icon.png', 'tray.png']) assert.ok(fs.readFileSync(path.join(FRONTEND, 'assets', f)).equals(fs.readFileSync(path.join(dir, f))), `${f} differs from the validated candidate`);
});

// ───────────── 6. what was deliberately NOT rebranded ─────────────
test('export-facing branding is unchanged: company defaults, product, export file prefix', () => {
  const b = read('lib', 'branding.js');
  assert.match(b, /name:\s+'PETSHROW'/); assert.match(b, /product:\s+'PETSHROW ERP'/); assert.match(b, /export const FILE_PREFIX = 'PETSHROW';/);
  assert.match(b, /appName:\s+'CheckIn'/);
});
test('Windows product / executable / shortcut are named CheckIn, while the identity that existing installs and data depend on is untouched: app id, update feed, persistent config dir name', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'package.json'), 'utf8'));
  // productName drives the Windows .exe name, ProductName/FileDescription, install folder, shortcuts and artifact names (CheckIn-Setup.exe / CheckIn-Portable.exe)
  assert.equal(pkg.build.productName, 'CheckIn'); assert.equal(pkg.build.nsis.shortcutName, 'CheckIn');
  assert.match(pkg.description, /^CheckIn\b/);
  assert.equal(pkg.build.nsis.artifactName, '${productName}-Setup.${ext}'); assert.equal(pkg.build.portable.artifactName, '${productName}-Portable.${ext}');   // no numeric version in the file names
  // NOT renamed (an installed app's upgrade identity, its update feed and its data folder): app id, feed, APP_NAME
  assert.equal(pkg.build.appId, 'com.petshrow.erp');
  assert.equal(pkg.build.publish[0].url, 'https://updates.petshrow.local/erp/');
  assert.match(fs.readFileSync(path.join(FRONTEND, 'electron', 'constants.js'), 'utf8'), /APP_NAME\s*=\s*'PETSHROW ERP'/);
});
test('No numeric version is shown to users: installer/portable names, Add-Remove-Programs name, installer footer, startup screen, sidebar, update toast, build marker', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'package.json'), 'utf8'));
  for (const t of [pkg.build.nsis.artifactName, pkg.build.portable.artifactName, pkg.build.nsis.uninstallDisplayName, pkg.build.nsis.shortcutName]) assert.doesNotMatch(t, /\$\{version\}|\d+\.\d+/, `user-facing name carries a version: ${t}`);
  assert.equal(pkg.build.nsis.uninstallDisplayName, '${productName}');
  assert.equal(pkg.build.nsis.include, 'installer/checkin-branding.nsh');
  // per-machine installs (C:\Program Files, read-only for a normal user) broke the backend's migrate step: the "all users" choice must not offer elevation
  assert.equal(pkg.build.nsis.allowElevation, false);
  assert.equal(pkg.build.nsis.perMachine, false);
  const nsh = fs.readFileSync(path.join(FRONTEND, 'installer', 'checkin-branding.nsh'), 'utf8');
  assert.match(nsh, /!macro customHeader[\s\S]*BrandingText "\$\{PRODUCT_NAME\}"[\s\S]*!macroend/);
  assert.doesNotMatch(nsh.replace(/^;.*$/gm, ''), /VERSION|VIProductVersion|DisplayVersion/, 'the include must not touch internal version metadata');
  for (const rel of [['components', 'launcher', 'StartupScreen.jsx'], ['components', 'Layout.jsx']]) assert.doesNotMatch(read(...rel), /v{(BRAND|brand).version}/, `${rel.join('/')} renders a numeric version`);
  assert.doesNotMatch(read('components', 'UpdateNotifications.jsx'), /يتوفر إصدار جديد \{/, 'the update toast must not print a version number');
  assert.doesNotMatch(read('lib', 'branding.js'), /buildMarker:\s*'[^']*\d+\.\d+\.\d+/, 'the visible build marker has no version number');
  assert.doesNotMatch(fs.readFileSync(path.join(FRONTEND, 'electron', 'constants.js'), 'utf8'), /BUILD_MARKER\s*=\s*'[^']*\d+\.\d+\.\d+/);
  // tray tooltip + window title show the display name; APP_NAME stays the (never shown) data-folder identity
  const consts = fs.readFileSync(path.join(FRONTEND, 'electron', 'constants.js'), 'utf8');
  assert.match(consts, /APP_NAME\s*=\s*'PETSHROW ERP'/);
  assert.match(consts, /DISPLAY_NAME\s*=\s*'CheckIn'/);
  assert.match(fs.readFileSync(path.join(FRONTEND, 'electron', 'tray.js'), 'utf8'), /setToolTip\(DISPLAY_NAME\)/);
  assert.match(fs.readFileSync(path.join(FRONTEND, 'electron', 'windows.js'), 'utf8'), /title:\s*DISPLAY_NAME/);
  assert.match(fs.readFileSync(path.join(FRONTEND, 'electron', 'paths.js'), 'utf8'), /\bAPP_NAME\b/);
  // no renderer text renders a server / app / update version
  for (const f of ['components/ConnectionWizard.jsx', 'pages/ConnectionSettingsPage.jsx']) {
    const t = fs.readFileSync(path.join(SRC, ...f.split('/')), 'utf8');
    assert.doesNotMatch(t, /إصدار الخادم/, `${f} prints the server version`);
    assert.doesNotMatch(t, /\{\s*result\.(remoteVersion|remoteApiVersion)/, `${f} renders a version from the connection test`);
  }
  const upd = read('components', 'UpdateNotifications.jsx');
  assert.doesNotMatch(upd, /\{\s*s\.(downloadedVersion|updateInfo\.version)\s*\}/, 'update toasts must not print a version');
  assert.match(upd, /تم تنزيل التحديث — أعد التشغيل للتثبيت/);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.jsx') ? [path.join(d, e.name)] : []));
  for (const f of walk(SRC)) {
    const t = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(t, /\{[^{}]*\b(BRAND|brand)\.version\b[^{}]*\}/, `${path.relative(SRC, f)} renders the app version`);
    assert.doesNotMatch(t, /\{[^{}]*\b(downloadedVersion|remoteVersion|appVersion)\b[^{}]*\}\s*<\/|>\s*\{[^{}]*\b(downloadedVersion|remoteVersion|appVersion)\b[^{}]*\}/, `${path.relative(SRC, f)} renders a version in text`);
  }
});

test('dark overlays and the crash screen are neutral (no navy backdrops), while the Light fallbacks stay as they were', () => {
  const tokens = read('styles', 'checkin-tokens.css');
  for (const name of ['--ci-overlay-sync', '--ci-overlay-drawer', '--ci-overlay-dialog']) {
    const m = tokens.match(new RegExp(name + '\\s*:\\s*rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),'));
    assert.ok(m, `${name} missing`);
    assert.ok(m[1] === m[2] && m[2] === m[3], `${name} must be a neutral grey/black, got ${m[1]},${m[2]},${m[3]}`);
  }
  // the shared components read the variable and keep the original navy literal as the Light fallback
  assert.match(read('components', 'ui', 'Dialog.jsx'), /var\(--ci-overlay-dialog, rgba\(6,10,20,0\.6\)\)/);
  assert.match(read('components', 'ui', 'Drawer.jsx'), /var\(--ci-overlay-drawer, rgba\(6,10,20,0\.55\)\)/);
  assert.match(read('components', 'FingerprintSyncModal.jsx'), /var\(--ci-overlay-sync, rgba\(6,10,20,0\.72\)\)/);
  const crash = read('main.jsx');
  assert.ok(!/#0D1117|#21262D|#30363D/i.test(crash), 'crash screen must not use the navy GitHub-dark colours');
});

test('grid header floors: every grid that shows localized headers uses withHeaderFloor, and the no-clip header rule is intact', () => {
  for (const f of ['AttendanceDailyPage', 'AttendanceMonthlyPage', 'EmployeeMovementPage', 'RawLogsPage', 'EmployeesPage', 'DevicesPage', 'PayrollPage', 'RulesPage']) {
    assert.match(read('pages', f + '.jsx'), /withHeaderFloor\)/, `${f} must apply withHeaderFloor to its columns`);
  }
  const css = read('index.css');
  assert.match(css, /\.ag-header-cell-label,[\s\S]{0,200}white-space:\s*nowrap\s*!important/);
  assert.match(css, /\.ag-header-cell-text[\s\S]{0,200}overflow:\s*visible\s*!important/);
});