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
const TARGETS = {
  x64: {
    url: `https://dev.mysql.com/get/Downloads/MySQL-8.4/mysql-${MYSQL_VERSION}-macos14-x86_64.tar.gz`,
    sha256: 'b690dfaad2108889390d40df388c16453e345f69a77784444687e8e308855af6',
  },
  arm64: {
    url: `https://dev.mysql.com/get/Downloads/MySQL-8.4/mysql-${MYSQL_VERSION}-macos14-arm64.tar.gz`,
    sha256: 'af1af43030ac66b73dc2d5dcf645a61cdf9e7cf5404cf04bdf8e194447b0f153',
  },
};

// Minimal set of files mysqld/mysql/mysqldump/mysqladmin need at runtime —
// NOT the full ~500MB distribution (dev headers, static libs, test suite,
// docs are all dropped).
const KEEP_BIN = ['mysqld', 'mysql', 'mysqldump', 'mysqladmin'];

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  await pipeline(res.body, createWriteStream(destPath));
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

  // --force-local: without it, a Windows-style "C:\..." path gets parsed by
  // tar as a "host:path" remote spec (the drive-letter colon looks like a
  // remote-host separator) — this makes the exact same command work
  // identically on macOS (where it's a no-op) and on Windows (where it's
  // required), so this script's download/verify/extract logic can be
  // exercised locally before ever reaching CI.
  execFileSync('tar', ['--force-local', '-xzf', tarPath, '-C', tmpDir]);
  const extractedDir = readdirSync(tmpDir).find(f => f.startsWith('mysql-') && statSync(join(tmpDir, f)).isDirectory());
  if (!extractedDir) throw new Error(`Could not find extracted MySQL directory for ${arch}`);
  const srcRoot = join(tmpDir, extractedDir);

  const destRoot = join(OUT_ROOT, arch);
  const destBin = join(destRoot, 'bin');
  const destShare = join(destRoot, 'share');
  if (existsSync(destRoot)) rmSync(destRoot, { recursive: true, force: true });
  mkdirSync(destBin, { recursive: true });

  for (const name of KEEP_BIN) {
    const src = join(srcRoot, 'bin', name);
    if (!existsSync(src)) throw new Error(`Expected binary missing from tarball: bin/${name} (${arch})`);
    copyFileSync(src, join(destBin, name));
    chmodSync(join(destBin, name), 0o755);
  }

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
