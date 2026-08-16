/**
 * manifest.mjs — single source of truth for PETSHROW ERP's production
 * asset safety gate (icons, tray, embedded print fonts, and the electron-
 * builder configs/editions that consume them).
 *
 * `verify-source.mjs` (pre-build) and `verify-packaged.mjs` (post-build)
 * both import ASSETS/EDITIONS/BUILDER_CONFIGS from here instead of
 * hardcoding paths, so there is exactly one place that knows what a
 * "required runtime asset" is.
 *
 * Run directly to (re)generate the lockfile after an intentional asset
 * change:
 *   node scripts/assetSafety/manifest.mjs generate
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FRONTEND_DIR = resolve(__dirname, '..', '..');
export const LOCKFILE_PATH = join(__dirname, 'asset-manifest.lock.json');

// ─── Editions ──────────────────────────────────────────────────────────────
// The repo produces these buildable artifacts. "Windows Server" uses the
// `build` field embedded in package.json (appId com.petshrow.erp) — that
// config bundles the full backend and is Windows-only in practice.
//
// "Mac Client (Modern)" and "Mac Client (Legacy/Mojave)" are BOTH the
// Manager edition (electron-builder.manager.json / .legacy-mac.json,
// appId com.petshrow.erp.manager) — a client-only build that never bundles
// a backend or MySQL and defaults to remote server-mode
// (frontend/electron/connectionSettings.js). They previously shared the
// embedded/full-backend config with "windows-server" and were mislabeled as
// "standalone"; both were corrected so this gate actually enforces the
// client-only requirement instead of certifying a backend-bundled package
// as the "Mac Client".
export const EDITIONS = [
  {
    id: 'windows-server',
    label: 'Windows Server',
    platform: 'win',
    config: 'embedded', // frontend/package.json "build" field
    outputDir: '../dist-electron',
    ciJob: null, // no Windows CI runner exists yet in .github/workflows/build.yml
  },
  {
    id: 'mac-client-modern',
    label: 'Mac Client (Modern, Manager edition)',
    platform: 'mac',
    config: 'electron-builder.manager.json',
    outputDir: '../dist-electron-manager',
    ciJob: 'build-macos-modern',
  },
  {
    id: 'mac-standalone-modern',
    label: 'Mac Standalone Modern',
    platform: 'mac',
    config: 'electron-builder.standalone.json',
    outputDir: '../dist-electron-standalone',
    ciJob: 'build-macos-standalone',
  },
  {
    id: 'mac-client-legacy',
    label: 'Mac Client Legacy (Mojave, Manager edition)',
    platform: 'mac',
    config: 'electron-builder.legacy-mac.json',
    outputDir: '../dist-electron-legacy',
    ciJob: 'build-macos-mojave',
  },
  {
    id: 'manager',
    label: 'Manager (Windows build — ad hoc, not wired into CI)',
    platform: 'both',
    config: 'electron-builder.manager.json',
    outputDir: '../dist-electron-manager',
    ciJob: null,
  },
];

export const ALL_EDITION_IDS = EDITIONS.map(e => e.id);

// electron-builder configs whose local `icon` / `extraResources[].from` /
// `files` entries must resolve to real files on disk — checked generically
// in verify-source.mjs rather than duplicated per-config here.
export const BUILDER_CONFIGS = [
  { path: 'package.json', embedded: true },
  { path: 'electron-builder.manager.json' },
  { path: 'electron-builder.standalone.json' },
  { path: 'electron-builder.legacy-mac.json' },
];

function fontKeys(weights, subsets = ['arabic', 'latin']) {
  const keys = [];
  for (const w of weights) for (const s of subsets) keys.push(`${s}_${w}`);
  return keys;
}

// ─── Required runtime assets ────────────────────────────────────────────────
// category 'source'    — a real file on disk, hashed into the lockfile.
// category 'generated' — a committed JS module produced by a build script
//                         (frontend/scripts/embed-plex.cjs and its Cairo
//                         counterpart); verified by key-completeness, not
//                         file-hash, since regenerating it legitimately
//                         changes its bytes every time.
export const ASSETS = [
  {
    id: 'icon-ico',
    category: 'source',
    sourcePath: 'assets/icon.ico',
    kind: 'ico',
    minSize: 1024,
    consumers: [
      "electron-builder.manager.json / embedded config: win.icon",
      'nsis: installerIcon / uninstallerIcon / installerHeaderIcon',
    ],
    editions: ['windows-server', 'manager'],
  },
  {
    id: 'icon-png',
    category: 'source',
    sourcePath: 'assets/icon.png',
    kind: 'png',
    minSize: 1024,
    consumers: [
      'electron-builder: mac.icon (auto-converted to .icns at package time)',
      'frontend/electron/windows.js: BrowserWindow icon',
    ],
    editions: ['mac-client-modern', 'mac-standalone-modern', 'mac-client-legacy', 'manager'],
    packagedAsarUnpackedPath: 'assets/icon.png',
  },
  {
    id: 'tray-png',
    category: 'source',
    sourcePath: 'assets/tray.png',
    kind: 'png',
    minSize: 128,
    consumers: ['frontend/electron/tray.js: createTray()'],
    editions: ['windows-server', 'mac-client-modern', 'mac-standalone-modern', 'mac-client-legacy', 'manager'],
    packagedAsarUnpackedPath: 'assets/tray.png',
    // tray.js already existsSync-guards this and falls back to
    // nativeImage.createEmpty() — noted so the gate doesn't duplicate that
    // runtime fallback logic, only confirms the preferred asset is present.
    hasRuntimeFallback: true,
  },
  {
    id: 'cairo-font-data',
    category: 'generated',
    sourcePath: 'src/lib/fonts/cairoFontData.js',
    exportName: 'CAIRO_FONTS',
    expectedKeys: fontKeys([400, 600, 700, 800]),
    minBase64Length: 1000,
    consumers: ['frontend/src/lib/reportTemplate.js: embedded @font-face (Cairo)'],
    editions: 'all-frontend',
  },
  {
    id: 'plex-font-data',
    category: 'generated',
    sourcePath: 'src/lib/fonts/ibmPlexArabicFontData.js',
    exportName: 'PLEX_FONTS',
    expectedKeys: fontKeys([400, 600, 700]),
    minBase64Length: 1000,
    consumers: ['frontend/src/lib/reportTemplate.js: embedded @font-face (IBM Plex Sans Arabic)'],
    editions: 'all-frontend',
  },
];

export function assetsForEdition(editionId) {
  return ASSETS.filter(a => a.editions === 'all-frontend' || a.editions.includes(editionId));
}

export function sha256File(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

function generateLockfile() {
  const lock = {};
  for (const asset of ASSETS) {
    if (asset.category !== 'source') continue;
    const abs = join(FRONTEND_DIR, asset.sourcePath);
    if (!existsSync(abs)) {
      console.error(`[manifest] FAIL: cannot lock '${asset.id}' — missing file: ${asset.sourcePath}`);
      process.exitCode = 1;
      continue;
    }
    const size = statSync(abs).size;
    lock[asset.id] = { path: asset.sourcePath, sha256: sha256File(abs), size };
  }
  writeFileSync(LOCKFILE_PATH, JSON.stringify(lock, null, 2) + '\n');
  console.log(`[manifest] wrote ${LOCKFILE_PATH} (${Object.keys(lock).length} assets)`);
}

export function readLockfile() {
  if (!existsSync(LOCKFILE_PATH)) return null;
  return JSON.parse(readFileSync(LOCKFILE_PATH, 'utf8'));
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === 'generate') {
    generateLockfile();
  } else {
    console.log('Usage: node scripts/assetSafety/manifest.mjs generate');
    process.exitCode = 1;
  }
}
