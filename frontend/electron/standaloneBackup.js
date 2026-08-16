import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, readFileSync, createWriteStream } from 'fs';
import { join } from 'path';
import zlib from 'zlib';
import { getStandaloneDataPaths, getMysqlBinDir } from './paths.js';
import { MYSQL_PORT } from './mysqlManager.js';

// ─── Mac Standalone — full database backup / restore ─────────────────────────
// This is a REAL full-database backup (mysqldump of the managed instance),
// not the Cleanup Wizard's operational-data safety snapshot (backend/src/
// routes/cleanup.js) — that one is scoped to a destructive-cleanup undo path
// and is explicitly not sufficient as a production backup per the spec.
//
// Retention: keep the most recent KEEP_COUNT backups, pruning older ones by
// mtime. Simple count-based prune, no external scheduler — checked from a
// setInterval in lifecycle.js against a "last backup" timestamp file, the
// same in-process-timer style already used by updater.js.
const KEEP_COUNT = 14; // ~2 weeks of daily backups by default

function binPath(name) {
  const dir = getMysqlBinDir();
  if (!dir) throw new Error('MySQL binaries are only available in a packaged Standalone build');
  return join(dir, name);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// ─── Create ───────────────────────────────────────────────────────────────────
export async function createBackup(creds, { reason = 'manual' } = {}) {
  const paths = getStandaloneDataPaths();
  if (!existsSync(paths.backupsDir)) mkdirSync(paths.backupsDir, { recursive: true });

  const outFile = join(paths.backupsDir, `petshrow-${timestamp()}-${reason}.sql.gz`);
  const dump = spawnSync(binPath('mysqldump'), [
    '--host=127.0.0.1', `--port=${MYSQL_PORT}`,
    `--user=${creds.user}`, `--password=${creds.password}`,
    '--single-transaction', '--routines', '--triggers', '--set-gtid-purged=OFF',
    // mysqld 8.x's mysqldump tries to dump tablespace metadata by default,
    // which requires the global PROCESS privilege — the managed app user
    // intentionally only has GRANT ALL on its own database (mysqlManager.js),
    // not a global grant, so that attempt fails with "Access denied; you
    // need (at least one of) the PROCESS privilege(s)" before any table
    // data is dumped (confirmed on a real CI run, 2026-08-15). This backup
    // is a single-schema, single-tenant local dump — tablespace placement
    // metadata (which physical .ibd file each table lives in) is irrelevant
    // to restoring it, so --no-tablespaces (skip that section entirely) is
    // the correct fix, not widening the app user's privileges.
    '--no-tablespaces',
    creds.database,
  ], { maxBuffer: 1024 * 1024 * 1024 });

  if (dump.status !== 0 || !dump.stdout || dump.stdout.length === 0) {
    const err = dump.stderr?.toString() || `mysqldump exited with code ${dump.status}`;
    console.error('[Backup] mysqldump failed:', err);
    return { ok: false, error: err };
  }

  await new Promise((resolve, reject) => {
    const gzip = zlib.createGzip();
    const out = createWriteStream(outFile);
    gzip.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    gzip.pipe(out);
    gzip.end(dump.stdout);
  });

  console.log('[Backup] created:', outFile);
  pruneOldBackups(paths);
  return { ok: true, path: outFile, createdAt: new Date().toISOString(), sizeBytes: statSync(outFile).size };
}

function pruneOldBackups(paths) {
  try {
    const files = readdirSync(paths.backupsDir)
      .filter(f => f.endsWith('.sql.gz'))
      .map(f => ({ name: f, path: join(paths.backupsDir, f), mtime: statSync(join(paths.backupsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(KEEP_COUNT)) {
      try { unlinkSync(f.path); console.log('[Backup] pruned old backup:', f.name); } catch {}
    }
  } catch (err) {
    console.warn('[Backup] prune failed (non-fatal):', err.message);
  }
}

// ─── List ─────────────────────────────────────────────────────────────────────
export function listBackups() {
  const paths = getStandaloneDataPaths();
  if (!existsSync(paths.backupsDir)) return [];
  return readdirSync(paths.backupsDir)
    .filter(f => f.endsWith('.sql.gz'))
    .map(f => {
      const p = join(paths.backupsDir, f);
      const s = statSync(p);
      return { name: f, path: p, sizeBytes: s.size, createdAt: s.mtime.toISOString() };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ─── Validate before restore ───────────────────────────────────────────────────
function validateBackupFile(filePath) {
  if (!existsSync(filePath)) return { valid: false, error: 'File not found' };
  try {
    const head = zlib.gunzipSync(readFileSync(filePath).slice(0, 65536)).toString('utf8', 0, 256);
    // A real mysqldump output starts with a recognizable header comment —
    // this is a cheap sanity check, not full SQL validation.
    if (!/-- MySQL dump|CREATE TABLE|INSERT INTO/i.test(head)) {
      return { valid: false, error: 'File does not look like a MySQL dump' };
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, error: `Corrupt archive: ${err.message}` };
  }
}

// ─── Restore ────────────────────────────────────────────────────────────────────
// Caller (ipc.js) is responsible for: stopping the backend first (blocks
// writes), calling this, then restarting the backend + re-running
// `prisma migrate deploy` once the restored dump is in place. This function
// only owns the actual data-load step and its own safety-backup-first rule —
// never overwrite a healthy database blindly.
export async function restoreBackup(creds, filePath) {
  const validation = validateBackupFile(filePath);
  if (!validation.valid) return { ok: false, error: validation.error };

  const safety = await createBackup(creds, { reason: 'pre-restore-safety' });
  if (!safety.ok) {
    return { ok: false, error: `Refusing to restore — safety backup of current database failed: ${safety.error}` };
  }

  try {
    const sql = zlib.gunzipSync(readFileSync(filePath));
    const restore = spawnSync(binPath('mysql'), [
      '--host=127.0.0.1', `--port=${MYSQL_PORT}`,
      `--user=${creds.user}`, `--password=${creds.password}`,
      creds.database,
    ], { input: sql, maxBuffer: 1024 * 1024 * 1024 });

    if (restore.status !== 0) {
      const err = restore.stderr?.toString() || `mysql restore exited with code ${restore.status}`;
      console.error('[Restore] failed:', err);
      return { ok: false, error: err, safetyBackupPath: safety.path };
    }
    console.log('[Restore] completed from:', filePath);
    return { ok: true, safetyBackupPath: safety.path };
  } catch (err) {
    return { ok: false, error: err.message, safetyBackupPath: safety.path };
  }
}

// ─── Scheduled backup check (called from an in-process interval) ─────────────
export function shouldRunScheduledBackup(intervalMs = 24 * 60 * 60 * 1000) {
  const backups = listBackups();
  if (backups.length === 0) return true;
  return Date.now() - new Date(backups[0].createdAt).getTime() >= intervalMs;
}
