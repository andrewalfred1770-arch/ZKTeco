/**
 * Isolated renderer harness (child process). NO database, NO backend, NO Electron, NO network: the real page source is bundled with
 * esbuild (third-party UI libraries and src/lib/api.js + src/lib/socket.js are replaced by inert stubs) and server-rendered with
 * react-dom/server against fixed fixture data and a FIXED clock. The process time zone comes from the TZ environment variable.
 *
 *   node render-harness.mjs <scenario>        env: TZ, FAKE_NOW (ISO instant), FIXTURES (JSON map: url prefix -> response body)
 * Prints one line:  @@RESULT@@{...json...}
 */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(here, '..', '..');
const SRC = path.join(FRONTEND, 'src');
const require_ = createRequire(path.join(FRONTEND, 'package.json'));
const REAL_REACT = require_.resolve('react');

const scenario = process.argv[2];
const PAGES = {
  holidays: 'pages/HolidaysPage.jsx', daily: 'pages/AttendanceDailyPage.jsx', cleanup: 'pages/DataCleanupPage.jsx',
  launcher: 'pages/LauncherPage.jsx', startup: 'components/launcher/StartupScreen.jsx',
};

const stubPath = (...p) => path.join(here, ...p);

let srcFiles = null;
function listSrc(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'fonts') listSrc(p, out); } else if (/\.(jsx?|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
function importedNames(lib) {
  srcFiles ??= listSrc(SRC).map((f) => fs.readFileSync(f, 'utf8'));
  const esc = lib.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const re = new RegExp(`import\\s+(?:[\\w$]+\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*['"]${esc}['"]`, 'g');
  const names = new Set();
  for (const text of srcFiles) for (const m of text.matchAll(re)) for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/)[0].trim(); if (/^[\w$]+$/.test(n)) names.add(n); }
  return names;
}
const norm = (p) => path.resolve(p).replace(/\.jsx?$/, '');

const plugin = {
  name: 'isolation',
  setup(b) {
    b.onResolve({ filter: /^REAL_REACT$/ }, () => ({ path: REAL_REACT }));
    b.onResolve({ filter: /^react$/ }, () => ({ path: stubPath('shims', 'react.js') }));
    b.onResolve({ filter: /^xlsx$/ }, () => ({ path: stubPath('stubs', 'xlsx.js') }));
    // Third-party UI libraries become an ESM module that exports every name the source imports from them (an ESM namespace cannot
    // be a Proxy, so the names are collected up front by scanning src/).
    b.onResolve({ filter: /^(lucide-react|react-hot-toast|ag-grid-react|ag-grid-community(\/.*)?|recharts|socket\.io-client|react-router-dom|zustand(\/.*)?)$/ },
      (args) => ({ path: args.path, namespace: 'lib-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'lib-stub' }, (args) => {
      const names = importedNames(args.path);
      const hooks = { useNavigate: '() => () => {}', useLocation: "() => ({ pathname: '/', search: '', hash: '', state: null })", useParams: '() => ({})', useSearchParams: '() => [new URLSearchParams(), () => {}]' };
      const router = args.path === 'react-router-dom'
        ? ["import React from 'react';",
           'export const NavLink = (p) => React.createElement("a", { href: p.to, className: typeof p.className === "string" ? p.className : undefined, style: p.style }, p.children);',
           'export const Link = NavLink;']
        : [];
      const zus = args.path.startsWith('zustand')
        ? ['const makeStore = () => { const st = {}; const f = (sel) => (typeof sel === "function" ? sel(st) : st); f.getState = () => st; f.setState = () => {}; f.subscribe = () => () => {}; return f; };',
           'export const create = () => makeStore(); export const createStore = create; export const useStore = (s, sel) => (sel ? sel({}) : {}); export const persist = (x) => x; export const devtools = (x) => x;']
        : [];
      const lines = [
        ...zus,
        ...router,
        'const reactKeys = new Set(["$$typeof","defaultProps","contextTypes","childContextTypes","propTypes","displayName","getDerivedStateFromProps","isReactComponent"]);',
        'const stub = new Proxy(function Stub() { return null; }, { get: (t, k) => (typeof k === "symbol" ? (k === Symbol.toPrimitive ? () => "" : undefined) : (k in t || reactKeys.has(k)) ? t[k] : stub), apply: () => null, construct: () => ({}) });',
        'export default stub;',
        ...[...names].filter((n) => n !== 'default' && !(args.path.startsWith('zustand') && ['create', 'createStore', 'useStore', 'persist', 'devtools'].includes(n)) && !(args.path === 'react-router-dom' && ['NavLink', 'Link'].includes(n))).map((n) => (hooks[n] ? `export const ${n} = ${hooks[n]};` : `export const ${n} = stub;`)),
      ];
      return { contents: lines.join('\n'), loader: 'js' };
    });
    b.onResolve({ filter: /^\.\.?\// }, (args) => {
      if (!args.importer) return null;
      const target = norm(path.resolve(path.dirname(args.importer), args.path));
      if (target === norm(path.join(SRC, 'lib', 'api'))) return { path: stubPath('stubs', 'api.js') };
      if (target === norm(path.join(SRC, 'lib', 'socket'))) return { path: stubPath('stubs', 'socket.js') };
      return null;
    });
  },
};

function entrySource() {
  if (scenario === 'filename') {
    return `import { exportToExcel } from ${JSON.stringify(path.join(SRC, 'lib', 'printUtils.js'))};
      export async function run() { await exportToExcel([{ a: 1 }], [{ header: 'a', key: 'a' }], 'rep', 'S', {}); return { files: globalThis.__WRITTEN_FILES || [] }; }`;
  }
  if (scenario === 'launcher-modules') {
    return `import { visibleLauncherModules, LAUNCHER_MODULES } from ${JSON.stringify(path.join(SRC, 'pages', 'LauncherPage.jsx'))};
      export async function run() { return { all: LAUNCHER_MODULES.map((m) => [m.id, m.to, m.label]), server: visibleLauncherModules(false).map((m) => m.id), manager: visibleLauncherModules(true).map((m) => m.id) }; }`;
  }
  if (scenario === 'helpers') {
    return `import { addDays, instantDateStr, monthBounds } from ${JSON.stringify(path.join(SRC, 'lib', 'businessDate.js'))};
      import { fmtDate } from ${JSON.stringify(path.join(SRC, 'lib', 'formatters.js'))};
      const wk = (v) => { const d = new Date(v + 'T00:00'); return d.getDate() + '-' + d.getDay(); };   // pattern used by the print/monthly headers
      export async function run() { return {
        addDays_month_end: addDays('2026-10-31', 1), addDays_back: addDays('2026-03-01', -1), addDays_year: addDays('2026-12-31', 1),
        monthBounds_feb: monthBounds(2026, 2), monthBounds_oct: monthBounds(2026, 10),
        fmtDate_isoUtcMidnight: fmtDate('2026-10-14T00:00:00.000Z'), fmtDate_plain: fmtDate('2026-10-14'),
        instant_local_day: instantDateStr(new Date(2026, 9, 14, 0, 30)),
        weekday_header_2026_10_14: wk('2026-10-14'), weekday_header_2026_11_01: wk('2026-11-01') }; }`;
  }
  const page = PAGES[scenario];
  if (!page) throw new Error('unknown scenario ' + scenario);
  return `import * as Server from 'react-dom/server';
    import React, { __resetPass, __clearStore } from 'react';
    import Page from ${JSON.stringify(path.join(SRC, page))};
    const settle = () => new Promise((r) => setTimeout(r, 25));
    export async function run() {
      __clearStore();
      __resetPass(1); Server.renderToString(React.createElement(Page));
      for (let i = 0; i < 4; i++) await settle();
      __resetPass(2); const html = Server.renderToStaticMarkup(React.createElement(Page));
      return { html };
    }`;
}

// ── minimal browser-ish globals for code that peeks at window / storage (server rendering has none) ──
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), key: () => null, get length() { return m.size; } }; };
globalThis.window = globalThis;
globalThis.localStorage = mem(); globalThis.sessionStorage = mem();
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {};
globalThis.document = { addEventListener() {}, removeEventListener() {}, documentElement: { dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {} }, body: { style: {}, classList: { add() {}, remove() {} } }, querySelector: () => null, getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }) };
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0); globalThis.cancelAnimationFrame = clearTimeout;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.__API_FIXTURES = JSON.parse(process.env.FIXTURES || '{}');

// ── fixed clock ──
const RealDate = Date;
const FIXED = new RealDate(process.env.FAKE_NOW || '2026-10-14T10:00:00Z').getTime();
globalThis.Date = class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); }
  static now() { return FIXED; }
};

const result = await build({
  stdin: { contents: entrySource(), resolveDir: FRONTEND, sourcefile: 'entry.jsx', loader: 'jsx' },
  bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node20', jsx: 'automatic', logLevel: 'silent',
  loader: { '.css': 'empty', '.js': 'jsx', '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  plugins: [plugin], absWorkingDir: FRONTEND, nodePaths: [path.join(FRONTEND, 'node_modules')],
});
const mod = { exports: {} };
new Function('module', 'exports', 'require', result.outputFiles[0].text)(mod, mod.exports, createRequire(import.meta.url));
const out = await mod.exports.run();
console.log('@@RESULT@@' + JSON.stringify({ tz: process.env.TZ, ...out }));
process.exit(0);
