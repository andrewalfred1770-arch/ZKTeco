/**
 * verify-source.mjs — pre-build production asset safety gate.
 *
 * Run before every electron-builder invocation (wired into
 * `assets:verify:source` / `assets:gate` in package.json, and as a CI step
 * in .github/workflows/build.yml). Fails loudly — non-zero exit — on:
 *   - a required source asset missing, empty, or drifted from the lockfile
 *   - a source asset whose magic bytes don't match its declared kind
 *     (catches a zero-byte/truncated/renamed-wrong-format file the size
 *     check alone can miss)
 *   - a generated font-data module missing an expected weight/subset key,
 *     or holding a suspiciously short base64 blob (the silent-skip failure
 *     mode of scripts/embed-plex.cjs, which only console.warns on a
 *     missing source .woff2 and keeps going)
 *   - an electron-builder config's icon / buildResources / extraResources
 *     path pointing at something that doesn't exist on disk
 *
 * This is the same "fail loudly instead of shipping a broken image" gate
 * required by the project's production-asset-safety policy — see the repo
 * root for context. Never silently degrade a FAIL into a warning here.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { ASSETS, BUILDER_CONFIGS, FRONTEND_DIR, readLockfile, sha256File } from './manifest.mjs';

let failures = 0;
function fail(msg) {
  console.error(`[assets:verify:source] FAIL: ${msg}`);
  failures++;
}
function ok(msg) {
  console.log(`[assets:verify:source] OK: ${msg}`);
}

function sniffKind(buf) {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  // ICO: reserved(2 bytes, must be 0) + type(2 bytes, must be 1 for icon)
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'ico';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

async function verifySourceAssets() {
  const lock = readLockfile();
  if (!lock) {
    fail(`no lockfile at scripts/assetSafety/asset-manifest.lock.json — run 'node scripts/assetSafety/manifest.mjs generate' first`);
    return;
  }

  for (const asset of ASSETS) {
    const abs = join(FRONTEND_DIR, asset.sourcePath);

    if (asset.category === 'source') {
      if (!existsSync(abs)) { fail(`'${asset.id}' — required asset missing: ${asset.sourcePath}`); continue; }
      const size = statSync(abs).size;
      if (size <= 0) { fail(`'${asset.id}' — file is zero bytes: ${asset.sourcePath}`); continue; }
      if (asset.minSize && size < asset.minSize) {
        fail(`'${asset.id}' — file suspiciously small (${size}B < ${asset.minSize}B floor): ${asset.sourcePath}`);
        continue;
      }
      const buf = readFileSync(abs);
      const kind = sniffKind(buf);
      if (kind !== asset.kind) {
        fail(`'${asset.id}' — expected a valid ${asset.kind.toUpperCase()} file, magic bytes say '${kind ?? 'unrecognized'}': ${asset.sourcePath}`);
        continue;
      }
      const entry = lock[asset.id];
      if (!entry) {
        fail(`'${asset.id}' — not present in lockfile; run 'node scripts/assetSafety/manifest.mjs generate' to add it`);
        continue;
      }
      const hash = sha256File(abs);
      if (hash !== entry.sha256 || size !== entry.size) {
        fail(`'${asset.id}' — drifted from asset-manifest.lock.json (was this an intentional change? if so, run 'node scripts/assetSafety/manifest.mjs generate' and commit the updated lockfile): ${asset.sourcePath}`);
        continue;
      }
      ok(`${asset.id} (${asset.sourcePath}, ${size}B, sha256 matches lockfile, magic bytes = ${kind})`);
    }

    if (asset.category === 'generated') {
      if (!existsSync(abs)) { fail(`'${asset.id}' — generated asset missing (run its embed script?): ${asset.sourcePath}`); continue; }
      let mod;
      try {
        mod = await import(pathToFileURL(abs).href);
      } catch (e) {
        fail(`'${asset.id}' — failed to import ${asset.sourcePath}: ${e.message}`);
        continue;
      }
      const data = mod[asset.exportName];
      if (!data || typeof data !== 'object') {
        fail(`'${asset.id}' — ${asset.sourcePath} does not export '${asset.exportName}'`);
        continue;
      }
      const missing = asset.expectedKeys.filter(k => !data[k]);
      if (missing.length) {
        fail(`'${asset.id}' — missing font face(s) [${missing.join(', ')}] in ${asset.sourcePath} (embed script silently skipped a missing source file — re-run it)`);
        continue;
      }
      const tooShort = asset.expectedKeys.filter(k => String(data[k]).length < asset.minBase64Length);
      if (tooShort.length) {
        fail(`'${asset.id}' — suspiciously short base64 for [${tooShort.join(', ')}] in ${asset.sourcePath}`);
        continue;
      }
      ok(`${asset.id} (${asset.sourcePath}, ${asset.expectedKeys.length} font faces present)`);
    }
  }
}

// electron-builder config icon/buildResources/extraResources local-path
// cross-check. extraResources 'from' entries that are populated by an
// earlier build step (Vite's dist/, the fetched MySQL binaries) are
// intentionally skipped here — they don't exist yet at gate time, and are
// covered by verify-packaged.mjs after the actual build.
const BUILD_TIME_PREFIXES = ['dist', 'resources/mysql', 'resources\\mysql'];

function checkBuilderConfigs() {
  for (const bc of BUILDER_CONFIGS) {
    const abs = join(FRONTEND_DIR, bc.path);
    if (!existsSync(abs)) { fail(`builder config missing: ${bc.path}`); continue; }
    let json;
    try {
      json = JSON.parse(readFileSync(abs, 'utf8'));
    } catch (e) {
      fail(`builder config is not valid JSON: ${bc.path} (${e.message})`);
      continue;
    }
    const build = bc.embedded ? json.build : json;
    if (!build) { fail(`${bc.path}: no "build" field found`); continue; }

    const iconFields = [
      ['mac.icon', build.mac?.icon],
      ['win.icon', build.win?.icon],
      ['nsis.installerIcon', build.nsis?.installerIcon],
      ['nsis.uninstallerIcon', build.nsis?.uninstallerIcon],
      ['nsis.installerHeaderIcon', build.nsis?.installerHeaderIcon],
    ].filter(([, v]) => !!v);

    for (const [field, relPath] of iconFields) {
      const iconAbs = join(FRONTEND_DIR, relPath);
      if (!existsSync(iconAbs)) fail(`${bc.path}: ${field} -> '${relPath}' does not exist`);
      else ok(`${bc.path}: ${field} -> ${relPath}`);
    }

    const br = build.directories?.buildResources;
    if (br) {
      if (!existsSync(join(FRONTEND_DIR, br))) fail(`${bc.path}: directories.buildResources -> '${br}' does not exist`);
      else ok(`${bc.path}: directories.buildResources -> ${br}`);
    }

    for (const target of ['mac', 'win']) {
      const er = build[target]?.extraResources || [];
      for (const r of er) {
        if (!r.from) continue;
        const normalized = r.from.replace(/\$\{arch\}/g, '');
        if (BUILD_TIME_PREFIXES.some(p => normalized.startsWith(p))) continue;
        const fromAbs = resolve(FRONTEND_DIR, r.from);
        if (!existsSync(fromAbs)) fail(`${bc.path}: ${target}.extraResources from '${r.from}' does not exist`);
        else ok(`${bc.path}: ${target}.extraResources from '${r.from}' exists`);
      }
    }
  }
}

// Directory listing of frontend/assets/ must contain exactly the files the
// manifest expects — catches a stray/forgotten extra asset just as much as
// a missing one, and doubles as a cheap case-sensitivity sanity check on
// this always-present-at-gate-time directory (packaged-app case-sensitivity
// is the deeper check in verify-packaged.mjs, post-build).
function checkAssetsDirExactly() {
  const dir = join(FRONTEND_DIR, 'assets');
  if (!existsSync(dir)) { fail(`assets/ directory missing entirely`); return; }
  const actual = new Set(readdirSync(dir).filter(f => !f.endsWith('.psd')));
  const expected = new Set(ASSETS.filter(a => a.sourcePath.startsWith('assets/')).map(a => a.sourcePath.replace(/^assets\//, '')));
  for (const f of expected) if (!actual.has(f)) fail(`assets/${f} expected by manifest but not found via directory listing (case mismatch?)`);
  for (const f of actual) if (!expected.has(f)) console.warn(`[assets:verify:source] NOTE: assets/${f} exists on disk but is not tracked in the manifest — add it to manifest.mjs if it's a real runtime dependency`);
}

async function main() {
  await verifySourceAssets();
  checkBuilderConfigs();
  checkAssetsDirExactly();

  console.log('');
  if (failures > 0) {
    console.error(`[assets:verify:source] ${failures} failure(s) — BUILD BLOCKED. Fix the asset(s) above before packaging.`);
    process.exit(1);
  }
  console.log('[assets:verify:source] PASS — all required source assets present, valid, and unchanged.');
}

main();
