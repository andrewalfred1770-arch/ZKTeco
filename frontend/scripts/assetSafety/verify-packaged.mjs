/**
 * verify-packaged.mjs — post-build production asset safety gate.
 *
 * Inspects an ALREADY-BUILT electron-builder output (never trusts source-
 * tree inspection alone — a manifest entry can be perfectly correct in
 * source and still fail to survive `files`/`extraResources`/asarUnpack
 * filtering into the real artifact). Run once per edition, right after
 * that edition's electron-builder step:
 *
 *   node scripts/assetSafety/verify-packaged.mjs <edition-id>
 *
 * <edition-id> is one of the ids in manifest.mjs EDITIONS (e.g.
 * mac-standalone-modern). Exits non-zero — BUILD/CERTIFY BLOCKED — if any
 * manifest asset scoped to this edition didn't make it into the package,
 * came out with a mismatched size, has a case-mismatched filename, or if
 * an edition that shouldn't bundle the backend/managed-MySQL resources
 * does anyway (or vice versa).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, basename, resolve } from 'path';
import { EDITIONS, FRONTEND_DIR, assetsForEdition } from './manifest.mjs';

const HOST_PLATFORM = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : process.platform;

let failures = 0;
function fail(msg) { console.error(`[assets:verify:packaged] FAIL: ${msg}`); failures++; }
function ok(msg) { console.log(`[assets:verify:packaged] OK: ${msg}`); }
function note(msg) { console.log(`[assets:verify:packaged] NOTE: ${msg}`); }

function loadBuilderConfig(edition) {
  if (edition.config === 'embedded') {
    return JSON.parse(readFileSync(join(FRONTEND_DIR, 'package.json'), 'utf8')).build;
  }
  return JSON.parse(readFileSync(join(FRONTEND_DIR, edition.config), 'utf8'));
}

// Derived from the edition's OWN config rather than hardcoded, so this
// stays accurate if extraResources ever change without anyone remembering
// to update a second, separate "what should edition X contain" table.
function expectedResourceShape(build, platform) {
  const target = platform === 'win' ? build.win : build.mac;
  const extraResources = target?.extraResources || [];
  return {
    expectsBackend: extraResources.some(r => r.to === 'backend'),
    expectsMysql: extraResources.some(r => typeof r.to === 'string' && r.to.startsWith('mysql')),
  };
}

function findAppBundles(outputDirAbs) {
  const results = [];
  function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = join(dir, e.name);
      if (e.name.endsWith('.app')) { results.push(full); continue; }
      if (e.name === 'Contents') continue;
      walk(full, depth + 1);
    }
  }
  walk(outputDirAbs, 0);
  return results;
}

// One bundle per built target: a mac multi-arch build produces TWO .app
// bundles (one per arch, each independently checked below); a win --dir/
// nsis build stages through a single win-unpacked/ directory. Editions
// with platform:'both' (e.g. Manager) may have either or both present in
// the same output dir, so check for both rather than picking one branch.
function findBundles(edition, outputDirAbs) {
  const bundles = [];
  if (edition.platform === 'win' || edition.platform === 'both') {
    const winUnpacked = join(outputDirAbs, 'win-unpacked');
    if (existsSync(winUnpacked)) bundles.push({ label: 'win-unpacked', resources: join(winUnpacked, 'resources'), root: winUnpacked, platform: 'win' });
  }
  if (edition.platform === 'mac' || edition.platform === 'both') {
    for (const app of findAppBundles(outputDirAbs)) {
      bundles.push({ label: basename(app), resources: join(app, 'Contents', 'Resources'), root: app, platform: 'mac' });
    }
  }
  return bundles;
}

function verifyBundle(edition, bundle, build) {
  const { label, resources } = bundle;
  const prefix = `${edition.id}/${label}`;

  // ── Manifest assets scoped to this edition, inside asarUnpack ──────────
  const scoped = assetsForEdition(edition.id).filter(a => a.packagedAsarUnpackedPath);
  const unpackedAssetsDir = join(resources, 'app.asar.unpacked', 'assets');
  let dirListing = [];
  if (existsSync(unpackedAssetsDir)) {
    dirListing = readdirSync(unpackedAssetsDir);
  } else if (scoped.length) {
    fail(`${prefix}: app.asar.unpacked/assets/ missing entirely (expected ${scoped.length} asset(s))`);
  }

  for (const asset of scoped) {
    const wantName = basename(asset.packagedAsarUnpackedPath);
    // Case-sensitive membership check — do NOT use existsSync here, it is
    // case-INSENSITIVE on default macOS (HFS+/APFS) and Windows
    // filesystems and would silently pass a Logo.PNG vs logo.png mismatch
    // that only breaks on a case-sensitive filesystem/CDN/Linux host.
    const exactMatch = dirListing.includes(wantName);
    if (!exactMatch) {
      const caseInsensitiveHit = dirListing.find(f => f.toLowerCase() === wantName.toLowerCase());
      if (caseInsensitiveHit) {
        fail(`${prefix}: '${asset.id}' present as '${caseInsensitiveHit}' but manifest requires exact case '${wantName}' — CASE MISMATCH`);
      } else {
        fail(`${prefix}: '${asset.id}' missing from packaged assets/ (expected ${wantName})`);
      }
      continue;
    }
    const abs = join(unpackedAssetsDir, wantName);
    const size = statSync(abs).size;
    if (size <= 0) { fail(`${prefix}: '${asset.id}' packaged as a zero-byte file`); continue; }
    if (asset.minSize && size < asset.minSize) { fail(`${prefix}: '${asset.id}' packaged size ${size}B is under the ${asset.minSize}B floor`); continue; }
    const sourceAbs = join(FRONTEND_DIR, asset.sourcePath);
    if (existsSync(sourceAbs) && statSync(sourceAbs).size !== size) {
      fail(`${prefix}: '${asset.id}' packaged size (${size}B) does not match source (${statSync(sourceAbs).size}B) — packaging corrupted/truncated it`);
      continue;
    }
    ok(`${prefix}: '${asset.id}' present at assets/${wantName} (${size}B, exact case match)`);
  }

  // ── Mac icon → .icns conversion actually happened ───────────────────────
  if (bundle.platform === 'mac') {
    const infoPlist = join(bundle.root, 'Contents', 'Info.plist');
    if (!existsSync(infoPlist)) {
      fail(`${prefix}: Info.plist missing — cannot verify app icon`);
    } else {
      const plist = readFileSync(infoPlist, 'utf8');
      const m = /<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
      if (!m) {
        fail(`${prefix}: Info.plist has no CFBundleIconFile entry`);
      } else {
        const icnsName = m[1].endsWith('.icns') ? m[1] : `${m[1]}.icns`;
        const icnsPath = join(resources, icnsName);
        if (!existsSync(icnsPath)) fail(`${prefix}: app icon '${icnsName}' referenced by Info.plist but missing from Resources/`);
        else if (statSync(icnsPath).size <= 0) fail(`${prefix}: app icon '${icnsName}' is zero bytes`);
        else ok(`${prefix}: app icon ${icnsName} present (${statSync(icnsPath).size}B)`);
      }
    }
  }

  // ── Edition isolation — derived from this edition's OWN extraResources ──
  const { expectsBackend, expectsMysql } = expectedResourceShape(build, bundle.platform);
  const backendDir = join(resources, 'backend');
  const backendPresent = existsSync(backendDir);
  if (expectsBackend && !backendPresent) fail(`${prefix}: edition config bundles a backend but resources/backend is missing from the package`);
  if (!expectsBackend && backendPresent) fail(`${prefix}: edition config does NOT bundle a backend, but resources/backend leaked into the package — edition isolation violated`);

  const mysqlDir = join(resources, 'mysql');
  const mysqlPresent = existsSync(mysqlDir);
  if (expectsMysql && !mysqlPresent) fail(`${prefix}: edition config bundles managed MySQL but resources/mysql is missing`);
  if (!expectsMysql && mysqlPresent) fail(`${prefix}: edition config does NOT bundle managed MySQL, but resources/mysql leaked into the package — edition isolation violated`);

  // Customer runtime uploads must never ship inside any edition's package —
  // formalizes section 8 (branding-upload safety) at the packaging boundary.
  if (backendPresent) {
    const uploadsDir = join(backendDir, 'uploads');
    if (existsSync(uploadsDir)) fail(`${prefix}: backend/uploads/ (customer runtime branding data) leaked into the package`);
    else ok(`${prefix}: backend/uploads/ correctly excluded from the package`);
  }
}

async function main() {
  const editionId = process.argv[2];
  const edition = EDITIONS.find(e => e.id === editionId);
  if (!edition) {
    console.error(`Usage: node scripts/assetSafety/verify-packaged.mjs <edition-id>`);
    console.error(`Known editions: ${EDITIONS.map(e => e.id).join(', ')}`);
    process.exit(1);
  }

  if (edition.platform !== HOST_PLATFORM && edition.platform !== 'both') {
    note(`edition '${edition.id}' targets platform '${edition.platform}' — this inspection logic is written but has not been exercised on this host platform (${process.platform}). Treat any PASS below as advisory only until it has actually run on a matching CI runner.`);
  }

  const outputDirAbs = resolve(FRONTEND_DIR, edition.outputDir);
  if (!existsSync(outputDirAbs)) {
    fail(`edition '${edition.id}': output directory not found: ${edition.outputDir} — did the build step run first?`);
    process.exit(1);
  }

  const build = loadBuilderConfig(edition);
  const bundles = findBundles(edition, outputDirAbs);
  if (!bundles.length) {
    fail(`edition '${edition.id}': no built .app/win-unpacked bundle found under ${edition.outputDir}`);
    process.exit(1);
  }
  note(`edition '${edition.id}': found ${bundles.length} bundle(s): ${bundles.map(b => b.label).join(', ')}`);

  for (const bundle of bundles) verifyBundle(edition, bundle, build);

  console.log('');
  if (failures > 0) {
    console.error(`[assets:verify:packaged] ${failures} failure(s) for edition '${edition.id}' — CERTIFICATION BLOCKED. Do not ship this artifact.`);
    process.exit(1);
  }
  console.log(`[assets:verify:packaged] PASS — edition '${edition.id}': all required assets present, correctly cased, and edition-isolated.`);
}

main();
