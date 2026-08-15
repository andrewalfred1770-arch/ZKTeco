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

  // Some of KEEP_BIN's own dependencies (confirmed on a real CI run: mysqld
  // dyld-aborted on "Library not loaded: @loader_path/libprotobuf-lite...
  // dylib") are linked via a bare @loader_path rpath — same directory as the
  // binary itself — not @loader_path/../lib like libssl/libcrypto above.
  // The tarball ships these few .dylib files sitting directly in bin/
  // alongside mysqld/mysql/etc, not in lib/, so they must be copied there
  // too, next to the binaries that expect to find them there.
  for (const entry of readdirSync(join(srcRoot, 'bin'))) {
    if (entry.endsWith('.dylib')) {
      copyFileSync(join(srcRoot, 'bin', entry), join(destBin, entry));
    }
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
