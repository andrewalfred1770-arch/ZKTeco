import { spawn, execFileSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync, chmodSync } from 'fs';
import { join } from 'path';
import net from 'net';
import crypto from 'crypto';
import { app } from 'electron';
import { getStandaloneDataPaths, getMysqlBinDir } from './paths.js';
import { isBenignPipeError } from './observability.js';
import { state } from './state.js';

// ─── Mac Standalone — managed local MySQL ────────────────────────────────────
// Deliberately mirrors backend.js's own child-process lifecycle pattern
// (spawn → health-poll → crash-restart → graceful shutdown) rather than
// inventing a new one — that pattern is already proven in production for the
// Node backend, and running two independently-designed supervisors side by
// side would just be two ways to get the same thing wrong differently.
//
// Bound to 127.0.0.1 only, on a non-default port (MYSQL_PORT below) so this
// never collides with — or is reachable from — anything else on the LAN or
// a Homebrew-installed MySQL a user might separately have on 3306. Mac
// Standalone must never expose the database beyond this one machine.
export const MYSQL_PORT = 33061;
const READY_POLL_MS = 300;
const READY_TIMEOUT_MS = 20000;
const CRASH_WINDOW_MS = 60000;
const MAX_CRASHES_IN_WINDOW = 3;

function isPortListening(port) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    sock.setTimeout(300);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error',   () => { sock.destroy(); resolve(false); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, '127.0.0.1');
  });
}

function binPath(name) {
  const dir = getMysqlBinDir();
  if (!dir) throw new Error('MySQL binaries are only available in a packaged Standalone build');
  return join(dir, name);
}

function ensureDirs(paths) {
  for (const dir of [paths.root, paths.databaseDir, paths.mysqlDataDir, join(paths.root, 'config'), paths.backupsDir, paths.exportsDir, paths.logsDir, paths.tempDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

// ─── Credentials (generated once, never exposed to the renderer) ─────────────
function loadOrCreateCredentials(paths) {
  if (existsSync(paths.mysqlCredentialsFile)) {
    try {
      return JSON.parse(readFileSync(paths.mysqlCredentialsFile, 'utf8'));
    } catch (err) {
      console.error('[MySQL] credentials file unreadable, cannot proceed safely:', err.message);
      throw err;
    }
  }
  const creds = {
    user: 'petshrow',
    password: crypto.randomBytes(24).toString('base64url'),
    database: 'petshrow_erp',
  };
  writeFileSync(paths.mysqlCredentialsFile, JSON.stringify(creds, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(paths.mysqlCredentialsFile, 0o600); } catch {}
  return creds;
}

// ─── First-run data-dir initialization ────────────────────────────────────────
// mysqld --initialize-insecure creates a fresh datadir with a passwordless
// root@localhost; we immediately lock that down to the generated credentials
// above via a bootstrap SQL file passed on the FIRST start only (see start()).
function isDataDirEmpty(dataDir) {
  if (!existsSync(dataDir)) return true;
  try { return readdirSync(dataDir).length === 0; } catch { return true; }
}

export function ensureDataDir() {
  const paths = getStandaloneDataPaths();
  ensureDirs(paths);
  if (!isDataDirEmpty(paths.mysqlDataDir)) {
    return { initialized: false, paths, creds: loadOrCreateCredentials(paths) };
  }
  console.log('[MySQL] First run — initializing data directory:', paths.mysqlDataDir);
  execFileSync(binPath('mysqld'), [
    '--initialize-insecure',
    `--datadir=${paths.mysqlDataDir}`,
    '--basedir=' + join(getMysqlBinDir(), '..'),
  ], { stdio: 'pipe', timeout: 60000 });
  const creds = loadOrCreateCredentials(paths);
  return { initialized: true, paths, creds };
}

// ─── Startup ──────────────────────────────────────────────────────────────────
export function startMysql(bootstrap) {
  if (state.mysqlReady && state.mysqlProcess) {
    console.log('[MySQL] Already running — skipping launch');
    return;
  }
  const { paths, creds, initialized } = bootstrap;
  const socketPath = join(paths.mysqlDataDir, 'mysql.sock');
  const logFile = join(paths.logsDir, 'mysqld.log');

  const args = [
    `--datadir=${paths.mysqlDataDir}`,
    `--socket=${socketPath}`,
    `--port=${MYSQL_PORT}`,
    '--bind-address=127.0.0.1',
    '--mysqlx=OFF',
    `--log-error=${logFile}`,
    '--skip-name-resolve',
  ];

  // On the very first start after --initialize-insecure, root@localhost has
  // no password yet — feed a one-shot bootstrap SQL file via --init-file to
  // create the real app user + database and lock root down, all before the
  // server accepts any external connection.
  let initFile = null;
  if (initialized) {
    initFile = join(paths.tempDir, 'bootstrap.sql');
    const sql = [
      `CREATE DATABASE IF NOT EXISTS \`${creds.database}\` CHARACTER SET utf8mb4;`,
      `CREATE USER IF NOT EXISTS '${creds.user}'@'localhost' IDENTIFIED BY '${creds.password.replace(/'/g, "''")}';`,
      `CREATE USER IF NOT EXISTS '${creds.user}'@'127.0.0.1' IDENTIFIED BY '${creds.password.replace(/'/g, "''")}';`,
      `GRANT ALL PRIVILEGES ON \`${creds.database}\`.* TO '${creds.user}'@'localhost';`,
      `GRANT ALL PRIVILEGES ON \`${creds.database}\`.* TO '${creds.user}'@'127.0.0.1';`,
      `ALTER USER 'root'@'localhost' IDENTIFIED BY '${crypto.randomBytes(24).toString('base64url').replace(/'/g, "''")}';`,
      'FLUSH PRIVILEGES;',
    ].join('\n');
    writeFileSync(initFile, sql, 'utf8');
    args.push(`--init-file=${initFile}`);
  }

  console.log('[MySQL] Spawning mysqld on port', MYSQL_PORT);
  const proc = spawn(binPath('mysqld'), args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: false,
  });
  state.mysqlProcess = proc;

  for (const stream of [proc.stdout, proc.stderr]) {
    stream?.on('error', (err) => { if (!isBenignPipeError(err)) console.error('[MySQL] stream error:', err.code || err.message); });
    stream?.on('data', d => { const line = d.toString().trim(); if (line) console.log(`[MySQL] ${line}`); });
  }

  proc.on('error', e => console.error('[MySQL] spawn error:', e.message));
  proc.on('exit', (c, s) => {
    console.log(`[MySQL] exited — code:${c} signal:${s}`);
    if (state.mysqlProcess === proc) {
      state.mysqlProcess = null;
      state.mysqlReady = false;
    }
    if (app.isQuitting) return;

    const now = Date.now();
    if (now - state.mysqlCrashWindowStart > CRASH_WINDOW_MS) {
      state.mysqlCrashWindowStart = now;
      state.mysqlCrashCount = 0;
    }
    state.mysqlCrashCount += 1;
    if (state.mysqlCrashCount > MAX_CRASHES_IN_WINDOW) {
      console.error(`[MySQL] Crashed ${state.mysqlCrashCount} times in ${CRASH_WINDOW_MS}ms — giving up, not restarting automatically`);
      return;
    }
    console.log('[MySQL] Crashed — restarting in 4s');
    setTimeout(() => {
      if (!app.isQuitting && !state.mysqlProcess) startMysql({ paths, creds, initialized: false });
    }, 4000);
  });

  return { socketPath, port: MYSQL_PORT };
}

// ─── Readiness ────────────────────────────────────────────────────────────────
export async function waitForReady(timeoutMs = READY_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortListening(MYSQL_PORT)) {
      try {
        execFileSync(binPath('mysqladmin'), ['--host=127.0.0.1', `--port=${MYSQL_PORT}`, 'ping'], { stdio: 'ignore', timeout: 2000 });
        state.mysqlReady = true;
        return true;
      } catch {}
    }
    await new Promise(r => setTimeout(r, READY_POLL_MS));
  }
  return false;
}

// ─── Connection env for the backend spawn (see backend.js's extraEnv) ────────
export function getConnectionEnv(creds) {
  return {
    DB_HOST: '127.0.0.1',
    DB_PORT: String(MYSQL_PORT),
    DB_USER: creds.user,
    DB_PASSWORD: creds.password,
    DB_NAME: creds.database,
  };
}

// ─── Graceful shutdown ─────────────────────────────────────────────────────────
export function requestMysqlShutdown(creds) {
  const p = state.mysqlProcess;
  if (!p || p.killed || p.exitCode !== null) return Promise.resolve(false);
  try {
    execFileSync(binPath('mysqladmin'), [
      '--host=127.0.0.1', `--port=${MYSQL_PORT}`,
      `--user=${creds.user}`, `--password=${creds.password}`,
      'shutdown',
    ], { stdio: 'ignore', timeout: 8000 });
    return Promise.resolve(true);
  } catch (err) {
    console.warn('[MySQL] mysqladmin shutdown failed, falling back to SIGTERM:', err.message);
    try { p.kill('SIGTERM'); return Promise.resolve(true); } catch { return Promise.resolve(false); }
  }
}
