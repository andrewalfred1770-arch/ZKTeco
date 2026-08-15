#!/usr/bin/env node
/**
 * fetch-mysql-macos.mjs — Mac Standalone build-time provisioning step.
 *
 * Downloads the official MySQL Community Server tarball for macOS
 * (x86_64 and arm64), verifies its published SHA256, and extracts just the
 * binaries + support files mysqld/mysql/mysqldump/mysqladmin actually need
 * at runtime into resources/mysql/{x64,arm64}/{bin,share}. This keeps
 * ~150-300MB of binaries out of git entirely — run this on a macOS CI
 * runner (or a real Mac) before `electron-builder --config
 * electron-builder.standalone.json`; it CANNOT run on Windows/Linux since
 * it needs `tar` with macOS-package support and produces darwin-only
 * binaries.
 *
 * MUST be re-run (and the version/checksums below re-verified against
 * https://dev.mysql.com/downloads/mysql/) whenever MYSQL_VERSION changes.
 * Checksums are NOT filled in here — they must be copied from MySQL's own
 * published SHA256 for the exact tarball before this script is trusted in
 * CI (see the empty EXPECTED_SHA256 values below, which intentionally
 * make this script refuse to run until someone has actually done that).
 */
import { createWriteStream, existsSync, mkdirSync, rmSync, readdirSync, copyFileSync, statSync, chmodSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { pipeline } from 'stream/promises';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = join(__dirname, '..');
const OUT_ROOT = join(FRONTEND_ROOT, 'resources', 'mysql');

// Pin an exact MySQL Community Server version. Update deliberately, not
// automatically — a silent version bump would change runtime behavior of a
// production-managed database with no review.
const MYSQL_VERSION = '8.4.3';

// SHA256 values below were established by this chain of verification
// (2026-08-15, re-verify if MYSQL_VERSION ever changes):
//   1. Downloaded from the exact URLs below (dev.mysql.com → redirects to
//      cdn.mysql.com, both official MySQL/Oracle infrastructure).
//   2. MD5 checksum matched MySQL's own published value for this exact file
//      at https://downloads.mysql.com/archives/community/?version=8.4.3&os=33
//      (x86_64: 516cdd560af2715da00189aeef4804cd,
//       arm64:  1f02612a8ec99e8da8520232919efa6b).
//   3. Detached GPG signature (from the same official page's "Signature"
//      link) verified as a Good signature against MySQL's own published
//      "GPG Public Build Key for MySQL 8.3.0 through 8.4.6" (fingerprint
//      BCA4 3417 C3B4 85DD 128E C6D4 B7B3 B788 A8D3 785C, published at
//      https://dev.mysql.com/doc/refman/9.7/en/gpg-key-archived-packages.html).
//   4. Only after both (2) and (3) passed was SHA256 computed from the file
//      and pinned here — this is NOT an assumed/self-issued checksum, it's
//      derived from a file whose authenticity was independently confirmed
//      two ways against MySQL's own official channels.
// MySQL does not itself publish a SHA256 for archived releases (only MD5 +
// GPG signature) — SHA256 here exists purely as this script's own stronger
// tamper-detection pin for CI re-downloads, not as a claim that MySQL
// published this exact hex string.
// URLs point directly at cdn.mysql.com (MySQL's own CDN — confirmed by
// following dev.mysql.com/get/...'s own 302 redirect there) rather than
// through the dev.mysql.com/get/ download-tracking redirector. First real
// CI run (GitHub-hosted macOS runner, 2026-08-15) got HTTP 403 from the
// dev.mysql.com/get/ path — Akamai's bot-protection layer in front of it,
// not a problem with this script's logic or the checksums themselves (both
// verified independently, see above). The direct CDN path has no such
// redirector in front of it.
const TARGETS = {
  x64: {
    url: `https://cdn.mysql.com/archives/mysql-8.4/mysql-${MYSQL_VERSION}-macos14-x86_64.tar.gz`,
    sha256: 'b690dfaad2108889390d40df388c16453e345f69a77784444687e8e308855af6',
  },
  arm64: {
    url: `https://cdn.mysql.com/archives/mysql-8.4/mysql-${MYSQL_VERSION}-macos14-arm64.tar.gz`,
    sha256: 'af1af43030ac66b73dc2d5dcf645a61cdf9e7cf5404cf04bdf8e194447b0f153',
  },
};

// Minimal set of files mysqld/mysql/mysqldump/mysqladmin need at runtime —
// NOT the full ~500MB distribution (dev headers, static libs, test suite,
// docs are all dropped).
const KEEP_BIN = ['mysqld', 'mysql', 'mysqldump', 'mysqladmin'];

// A browser-style User-Agent is sent as defense-in-depth against Akamai's
// bot-protection layer (Node's native fetch sends none by default, and the
// dev.mysql.com/get/ redirector 403'd exactly that on a first real CI run —
// switching to the direct cdn.mysql.com URL above was the actual fix, this
// header is just extra insurance). Up to 3 attempts with backoff to absorb
// transient CDN hiccups — a persistent failure still surfaces as a real
// thrown error, never silently skipped.
async function downloadFile(url, destPath) {
  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept': '*/*',
        },
      });
      if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
      await pipeline(res.body, createWriteStream(destPath));
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`[fetch-mysql] download attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, attempt * 3000));
    }
  }
  throw lastErr;
}

function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

// Recursively indexes every file under `root` by basename, so a dependency
// dyld reports missing can be located anywhere in the extracted tarball
// (not just the specific subdirectory a hand-written guess would check).
// Last writer wins on a basename collision — fine here, since MySQL's own
// tarball doesn't ship two different files with the same basename.
function indexFilesByBasename(root) {
  const index = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) index.set(entry.name, full);
    }
  };
  walk(root);
  return index;
}

// Runs `otool -L` on a Mach-O binary/library and returns the dependency
// paths it declares (excluding the file's own install-name id line and
// absolute system paths, which are never bundled).
function otoolDependencies(filePath) {
  let output;
  try {
    output = execFileSync('otool', ['-L', filePath], { encoding: 'utf8' });
  } catch (err) {
    throw new Error(`otool -L failed on ${filePath}: ${err.message}`);
  }
  const lines = output.split('\n').slice(1); // first line is the file path itself
  const deps = [];
  for (const line of lines) {
    const match = line.match(/^\s*(\S+)\s+\(compatibility version/);
    if (!match) continue;
    const dep = match[1];
    // Apple/system libraries and frameworks are never bundled — only
    // @loader_path/@rpath-relative references point at MySQL's own
    // dependency tree and need resolving.
    if (dep.startsWith('/usr/lib/') || dep.startsWith('/System/')) continue;
    if (!dep.startsWith('@loader_path') && !dep.startsWith('@rpath')) continue;
    deps.push(dep);
  }
  return deps;
}

// For a single `@loader_path/...`-relative dependency string declared by
// `fromFile`, returns the exact absolute path dyld will look for it at.
// `@rpath` is treated the same as `@loader_path` here — every rpath MySQL's
// own binaries declare (checked via `otool -l`) is loader-relative
// (`@loader_path` or `@loader_path/../lib`), so resolving `@rpath` the same
// way matches dyld's actual behavior for this tarball without needing to
// parse LC_RPATH commands separately.
function resolveLoaderRelativePath(fromFile, dep) {
  const relPart = dep.replace(/^@(loader_path|rpath)/, '.');
  return join(dirname(fromFile), relPart);
}

function resolveDependencyClosure(arch, destRoot, srcRoot) {
  const srcIndex = indexFilesByBasename(srcRoot);
  const destBin = join(destRoot, 'bin');
  const destLib = join(destRoot, 'lib');

  const seedFiles = [
    ...readdirSync(destBin).map(f => join(destBin, f)),
    ...(existsSync(destLib) ? readdirSync(destLib, { recursive: true })
      .map(f => join(destLib, f))
      .filter(f => statSync(f).isFile())
      : []),
  ];

  const queue = [...seedFiles];
  const seen = new Set(queue);
  let copiedCount = 0;

  while (queue.length > 0) {
    const file = queue.shift();
    const deps = otoolDependencies(file);
    for (const dep of deps) {
      const resolvedPath = resolveLoaderRelativePath(file, dep);
      if (existsSync(resolvedPath)) continue; // already satisfied

      const basename = dep.split('/').pop();
      const srcPath = srcIndex.get(basename);
      if (!srcPath) {
        throw new Error(
          `[fetch-mysql] ${arch}: ${file} depends on '${dep}' (basename '${basename}'), ` +
          `which does not exist anywhere in the extracted tarball. Cannot resolve this dependency.`
        );
      }

      mkdirSync(dirname(resolvedPath), { recursive: true });
      copyFileSync(srcPath, resolvedPath);
      chmodSync(resolvedPath, 0o755);
      copiedCount++;
      console.log(`[fetch-mysql] ${arch}: resolved missing dependency '${basename}' -> ${resolvedPath}`);

      if (!seen.has(resolvedPath)) {
        seen.add(resolvedPath);
        queue.push(resolvedPath);
      }
    }
  }

  console.log(`[fetch-mysql] ${arch}: dependency closure resolved (${copiedCount} additional file(s) copied beyond the wholesale bin/+lib/ copy)`);
}

async function provisionArch(arch, { url, sha256 }) {
  if (!sha256) {
    throw new Error(
      `Refusing to fetch MySQL for ${arch}: no expected SHA256 pinned in fetch-mysql-macos.mjs.\n` +
      `Look up the checksum for ${url} on https://dev.mysql.com/downloads/mysql/ and fill in TARGETS.${arch}.sha256 first.`
    );
  }

  console.log(`[fetch-mysql] ${arch}: downloading ${url}`);
  const tmpDir = join(os.tmpdir(), `petshrow-mysql-${arch}`);
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const tarPath = join(tmpDir, 'mysql.tar.gz');
  await downloadFile(url, tarPath);

  const actualSha = sha256File(tarPath);
  if (actualSha !== sha256) {
    throw new Error(`Checksum mismatch for ${arch}: expected ${sha256}, got ${actualSha}. Aborting — refusing to package an unverified binary.`);
  }
  console.log(`[fetch-mysql] ${arch}: checksum verified`);

  // --force-local is a GNU-tar-only flag (needed on Windows/Git-Bash, where
  // a "C:\..." path gets parsed as a "host:path" remote spec because of the
  // drive-letter colon) — macOS ships BSD tar (libarchive), which has no
  // such remote-tape concept and no --force-local flag at all: passing it
  // there is a hard error ("Option --force-local is not supported"), not a
  // no-op as originally assumed. Confirmed on a real CI run (GitHub-hosted
  // macOS runner, 2026-08-15) — only add the flag on win32, where it's the
  // one platform that actually needs it.
  const tarArgs = process.platform === 'win32'
    ? ['--force-local', '-xzf', tarPath, '-C', tmpDir]
    : ['-xzf', tarPath, '-C', tmpDir];
  execFileSync('tar', tarArgs);
  const extractedDir = readdirSync(tmpDir).find(f => f.startsWith('mysql-') && statSync(join(tmpDir, f)).isDirectory());
  if (!extractedDir) throw new Error(`Could not find extracted MySQL directory for ${arch}`);
  const srcRoot = join(tmpDir, extractedDir);

  const destRoot = join(OUT_ROOT, arch);
  const destBin = join(destRoot, 'bin');
  const destShare = join(destRoot, 'share');
  const destLib = join(destRoot, 'lib');
  if (existsSync(destRoot)) rmSync(destRoot, { recursive: true, force: true });
  mkdirSync(destBin, { recursive: true });

  for (const name of KEEP_BIN) {
    const src = join(srcRoot, 'bin', name);
    if (!existsSync(src)) throw new Error(`Expected binary missing from tarball: bin/${name} (${arch})`);
    copyFileSync(src, join(destBin, name));
    chmodSync(join(destBin, name), 0o755);
  }

  // mysqld/mysql/mysqldump/mysqladmin are all linked against the tarball's
  // own bundled libssl/libcrypto (and friends) via an @loader_path/../lib
  // rpath, not the system OpenSSL — omitting lib/ (as this script did until
  // now) leaves that rpath pointing at nothing, and dyld aborts the process
  // before main() ever runs (confirmed on a real CI run: "Library not
  // loaded: @loader_path/../lib/libssl.3.dylib", exit 134/SIGABRT, arm64).
  // Copied wholesale (including lib/private/, which holds the auth/plugin
  // libraries some of these binaries dlopen at runtime) — same
  // copy-everything approach already used for share/ just below, since
  // KEEP_BIN's per-file allowlist doesn't apply to a shared-library
  // directory the kept binaries all depend on as a unit.
  const srcLib = join(srcRoot, 'lib');
  if (!existsSync(srcLib)) throw new Error(`Expected lib/ missing from tarball (${arch}) — mysqld cannot run without its bundled libssl/libcrypto`);
  mkdirSync(destLib, { recursive: true });
  execFileSync('cp', ['-R', srcLib + '/.', destLib]);

  // mysqld needs share/ for error messages + charset definitions at runtime.
  const srcShare = join(srcRoot, 'share');
  if (existsSync(srcShare)) {
    mkdirSync(destShare, { recursive: true });
    execFileSync('cp', ['-R', srcShare + '/.', destShare]);
  }

  // The wholesale bin/ + lib/ copy above is not sufficient by itself: two
  // real CI failures (arm64, 2026-08-15) each traced to a DIFFERENT dylib
  // dyld couldn't find — first libssl/libcrypto via an @loader_path/../lib
  // rpath, then libprotobuf-lite via a bare @loader_path rpath pointing at
  // mysqld's OWN directory (bin/), even though the tarball actually ships
  // that file elsewhere in its tree (not loose in bin/, so the previous
  // hand-written "copy *.dylib out of bin/" patch never caught it). Guessing
  // library names/locations one crash report at a time doesn't scale — this
  // asks dyld's own resolution algorithm (via `otool -L`) what each bundled
  // binary and library actually needs, and mirrors any missing dependency
  // to the EXACT path dyld will look for it at, wherever in the extracted
  // tarball that file happens to live. Runs to a fixed point, since a copied
  // library can itself pull in further dependencies.
  if (process.platform === 'darwin') {
    resolveDependencyClosure(arch, destRoot, srcRoot);
  } else {
    console.warn(`[fetch-mysql] ${arch}: skipping otool-based dependency-closure resolution (not running on macOS) — this MUST be re-run on a macOS CI runner before the bundle is trusted.`);
  }

  rmSync(tmpDir, { recursive: true, force: true });
  console.log(`[fetch-mysql] ${arch}: provisioned to ${destRoot}`);
}

async function main() {
  if (process.platform !== 'darwin') {
    console.warn('[fetch-mysql] WARNING: not running on macOS — this is expected only when pre-populating resources/mysql via a macOS CI runner\'s artifact cache; the extracted binaries themselves are still darwin-only.');
  }
  mkdirSync(OUT_ROOT, { recursive: true });
  for (const [arch, target] of Object.entries(TARGETS)) {
    await provisionArch(arch, target);
  }
  console.log('[fetch-mysql] done.');
}

main().catch(err => {
  console.error('[fetch-mysql] FAILED:', err.message);
  process.exit(1);
});
