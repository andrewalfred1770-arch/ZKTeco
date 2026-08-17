import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import net from 'net';
import http from 'http';
import { app } from 'electron';
import { BACKEND_PORT, IS_DEV } from './constants.js';
import { isBenignPipeError } from './observability.js';
import { state } from './state.js';

// ─── Port check (non-blocking) ───────────────────────────────────────────────
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

// ─── Read AUTH_ENABLED straight out of the persistent .env ───────────────────
// Deliberately not a full dotenv parse (no dependency for one key): a plain
// `KEY=value` / `KEY="value"` line scan. Returns null when the file is
// missing/unreadable or the key isn't present — callers treat null as
// "can't verify" and fall back to the previous trusting behavior rather than
// disrupting a healthy backend on a false alarm.
function readExpectedAuthEnabled(envFile) {
  if (!envFile || !existsSync(envFile)) return null;
  try {
    const text = readFileSync(envFile, 'utf8');
    const match = text.match(/^\s*AUTH_ENABLED\s*=\s*"?(true|false)"?\s*$/mi);
    return match ? match[1].toLowerCase() === 'true' : null;
  } catch {
    return null;
  }
}

// ─── Backend-owner PID marker (edition-scoped identity) ──────────────────────
// Cross-edition port isolation gap: two DIFFERENT editions/instances can end
// up with a process listening on the SAME port (e.g. a test launch with
// PETSHROW_TEST_BACKEND_PORT misconfigured back to a production port).
// Neither the port number nor AUTH_ENABLED proves the listening process is
// actually THIS edition's own previous instance — both can coincidentally
// match a completely unrelated process. This marker is the positive-identity
// signal: written by THIS edition into ITS OWN persistent config dir
// (already edition-scoped — see paths.js getPersistentConfigDir, a
// different folder per edition) every time it spawns a backend. Only a PID
// recorded in the CALLING edition's own marker file is ever eligible to be
// killed as "stale" — a foreign edition's process, which could never have
// written into this edition's config dir, can never match.
function ownerMarkerFile(configDir) {
  return configDir ? join(configDir, '.backend-owner.json') : null;
}

function writeBackendOwnerMarker(configDir, pid) {
  const file = ownerMarkerFile(configDir);
  if (!file) return; // dev mode has no persistent configDir — see readBackendOwnerPid
  try {
    writeFileSync(file, JSON.stringify({ pid, startedAt: new Date().toISOString() }), 'utf8');
  } catch (err) {
    console.warn('[Electron] Failed to write backend-owner marker:', err.message);
  }
}

// Returns a positive integer PID this edition itself previously spawned, or
// null if there is nothing to trust (missing/unreadable/corrupt marker, or
// no persistent configDir at all — dev mode). null is the "cannot verify"
// state; callers must treat null as "do not kill", never as "safe to kill".
function readBackendOwnerPid(configDir) {
  const file = ownerMarkerFile(configDir);
  if (!file || !existsSync(file)) return null;
  try {
    const pid = Number(JSON.parse(readFileSync(file, 'utf8'))?.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Returns the PID(s) actually LISTENING on `port` right now, cross-platform.
// Never throws — an empty array means "couldn't determine" and callers must
// not kill on that basis.
function listListeningPids(port) {
  try {
    if (process.platform === 'win32') {
      // findstr /C:":5000 " (trailing space) is a literal match — a bare
      // `:5000` is a substring match that also hits :50000–:50009.
      const out = execSync(
        `netstat -aon | findstr LISTENING | findstr /C:":${port} "`,
        { shell: 'cmd.exe', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }
      ).toString();
      return [...out.matchAll(/\s(\d+)\s*$/gm)].map(m => Number(m[1])).filter(Number.isInteger);
    }
    // macOS/Linux (EP-004): lsof gives the PID(s) directly, no parsing needed.
    return execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).toString().trim().split('\n').filter(Boolean).map(Number).filter(Number.isInteger);
  } catch {
    return [];
  }
}

function killPid(pid) {
  if (process.platform === 'win32') {
    try { execSync(`taskkill /PID ${pid} /F`, { shell: 'cmd.exe', stdio: 'ignore', timeout: 2000 }); } catch {}
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

// ─── Kill stale backend on this port ─────────────────────────────────────────
// `paths` is optional (callers that can't supply it yet keep the old
// trusting behavior) — when given, an already-answering backend is only
// adopted if its own /api/health confirms the SAME AUTH_ENABLED value the
// current persistent .env holds. A process that was spawned before a later
// .env edit still answers health checks fine but is running with a frozen,
// now-stale env — adopting it silently would mean the edit never takes
// effect until someone manually kills that process. Mismatch → fall through
// and replace it with a freshly-spawned backend instead — but ONLY once
// positive PID-ownership (below) confirms it's safe to do so.
export async function killStaleBackend(paths) {
  const inUse = await isPortListening(BACKEND_PORT);
  if (!inUse) return;

  console.log(`[Electron] Port ${BACKEND_PORT} in use — checking if it's a stale process`);
  try {
    // Check if it's OUR backend (responds to /api/health)
    const health = await fetchHealth(`http://localhost:${BACKEND_PORT}`, 1000);
    if (health.ok) {
      const expectedAuth = readExpectedAuthEnabled(paths?.envFile);
      const actualAuth   = health.body?.authEnabled;
      if (expectedAuth === null || actualAuth === undefined || actualAuth === expectedAuth) {
        // Backend already up and (as far as we can tell) matches current config — don't start another
        console.log('[Electron] Backend already running — will use it');
        state.backendReady = true;
        return;
      }
      console.log(`[Electron] Backend on port ${BACKEND_PORT} is running with a stale AUTH_ENABLED (${actualAuth}, expected ${expectedAuth}) — verifying ownership before replacing it`);
    }
  } catch {}

  // Port in use but not adopted above — before touching it, require positive
  // proof this is OUR OWN previous instance, never just "something is on the
  // port". A healthy, differently-owned process (a different edition/test
  // launch that happens to share this port) is left completely alone.
  const ownerPid = readBackendOwnerPid(paths?.configDir);
  if (ownerPid === null) {
    console.warn(`[Electron] Port ${BACKEND_PORT} is occupied by an unverified process — no owned-PID record for this edition, refusing to kill it`);
    return;
  }
  const listeningPids = listListeningPids(BACKEND_PORT);
  if (!listeningPids.includes(ownerPid)) {
    console.warn(`[Electron] Port ${BACKEND_PORT} is occupied by PID(s) [${listeningPids.join(', ')}], none matching this edition's own recorded PID ${ownerPid} — refusing to kill (likely a different edition/instance)`);
    return;
  }

  console.log(`[Electron] Verified PID ${ownerPid} on port ${BACKEND_PORT} as this edition's own stale process — freeing it`);
  killPid(ownerPid);
  await new Promise(r => setTimeout(r, 1000));
  console.log('[Electron] Freed stale port');
}

// ─── Startup status poll — backend's /api/startup-status ─────────────────────
// Reports REAL progress (DB connected, services started, device link state)
// instead of a fake animated bar. Never throws — returns null on any failure
// so the splash poller's hard timeout remains the only thing that can close it.
// baseUrl defaults to the locally-spawned backend (Local Mode); Server Mode
// passes the configured remote server's URL so the same splash/poll logic
// works unchanged against either target (EP-003 Connection Layer).
export function fetchStartupStatus(timeoutMs = 400, baseUrl = `http://localhost:${BACKEND_PORT}`) {
  return new Promise(resolve => {
    const req = http.get(`${baseUrl}/api/startup-status`, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

// ─── Health check against any base URL (local or remote) ────────────────────
// Used by the Connection Settings "Test Connection" flow and by Server Mode's
// startup readiness check. Never throws.
export function fetchHealth(baseUrl, timeoutMs = 3000) {
  return new Promise(resolve => {
    const req = http.get(`${baseUrl}/api/health`, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ ok: res.statusCode === 200, status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ ok: false, status: res.statusCode, body: null }); }
      });
    }).on('error', (err) => resolve({ ok: false, status: null, body: null, error: err.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, status: null, body: null, error: 'timeout' }); });
  });
}

// ─── Legacy .env migration (EP-010) ───────────────────────────────────────────
// Pre-EP-010 installs (or a previous Portable temp extraction) may have a
// resources/backend/.env. Copy it ONCE into the persistent AppData config —
// never overwrite an existing AppData .env (that's the install's real,
// already-migrated config and must win), never delete the legacy file
// (a Setup install's resources/ dir may not be writable/deletable without
// elevation, and Portable's copy is discarded by Windows on its own anyway).
function migrateLegacyEnv({ envFile, legacyEnvFile, configDir }) {
  if (!configDir || !legacyEnvFile) return; // dev mode — nothing to migrate
  if (existsSync(envFile)) return;          // persistent config already present — leave it untouched
  if (!existsSync(legacyEnvFile)) return;   // nothing to migrate from
  try {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    copyFileSync(legacyEnvFile, envFile);
    console.log('[Electron] Migrated legacy backend/.env to persistent config:', envFile);
  } catch (err) {
    console.error('[Electron] Legacy .env migration failed:', err.message);
  }
}

// ─── Backend startup ──────────────────────────────────────────────────────────
// extraEnv (Mac Standalone only): DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME
// for the managed local MySQL instance (see mysqlManager.js's
// getConnectionEnv()). Merged in BEFORE the backend's own ensureEnvFile()
// runs, so the very first .env it generates already points at the managed
// instance — no separate write-then-restart cycle needed. Ignored entirely
// once an .env already exists (ensureEnvFile is a no-op then, same as today).
export function startBackend(paths, extraEnv = null) {
  if (state.backendReady) {
    console.log('[Electron] Backend already running — skipping launch');
    return;
  }

  const { backendEntry, backendCwd, envFile, configDir, frontendDist } = paths;

  if (!existsSync(backendEntry)) {
    console.error('[Electron] Backend entry not found:', backendEntry);
    return;
  }

  migrateLegacyEnv(paths);

  const env = {
    ...process.env,
    ...(extraEnv || {}),
    NODE_ENV:     IS_DEV ? 'development' : 'production',
    PORT:         String(BACKEND_PORT),
    ELECTRON_APP: '1',
  };
  if (frontendDist) env.FRONTEND_DIST = frontendDist;
  // EP-010: ALWAYS point the backend at the persistent config path, whether
  // or not it exists yet (ensureEnvFile() on the backend side creates it
  // there if missing). Previously this was `if (existsSync(envFile))`,
  // which meant a fresh install/extraction with no .env yet left
  // DOTENV_CONFIG_PATH unset — the backend then fell back to its own
  // cwd-relative default, landing squarely inside resources/backend. That
  // was the actual root cause of configuration being lost on every
  // Portable re-extraction.
  env.DOTENV_CONFIG_PATH = envFile;
  if (configDir) env.CONFIG_DIR = configDir;
  if (!IS_DEV) env.ELECTRON_RUN_AS_NODE = '1';

  const [bin, args] = IS_DEV
    ? ['node',          [backendEntry]]
    : [process.execPath, [backendEntry]];

  console.log(`[Electron] Spawning backend: ${bin} ${backendEntry}`);

  const proc = spawn(bin, args, {
    env,
    cwd:         backendCwd,
    // stdin is piped: graceful shutdown is requested by writing "shutdown\n"
    // (Windows has no real signals — child.kill('SIGTERM') is a hard
    // TerminateProcess that would cut DB writes mid-flight).
    stdio:       ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached:    false,
  });
  state.backendProcess = proc;
  writeBackendOwnerMarker(configDir, proc.pid);

  // Pipe-error guards on EVERY child stream: after the child exits (crash,
  // restart, kill), buffered writes/reads surface as async 'error' events.
  // Without these handlers a single EPIPE crashes the whole main process.
  for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
    if (stream) stream.on('error', (err) => {
      if (!isBenignPipeError(err)) console.error('[Backend] stream error:', err.code || err.message);
    });
  }

  proc.stdout?.on('data', d => {
    const line = d.toString().trim();
    if (line) console.log(`[Backend] ${line}`);
    // Detect when server is ready
    if (line.includes('Server running') || line.includes('Server on port')) {
      state.backendReady = true;
    }
    // EP-010.1: the Database Setup Wizard just persisted a new .env and is
    // about to gracefully shut down — this distinguishes that intentional
    // restart from a real app-quit, both of which otherwise look identical
    // to the exit handler below (clean exit, code 0).
    if (line.includes('[Setup] RESTART_REQUIRED')) {
      state.pendingConfigRestart = true;
    }
  });

  proc.stderr?.on('data', d => {
    const line = d.toString().trim();
    if (line && !line.includes('ExperimentalWarning')) {
      console.error(`[Backend ERR] ${line}`);
    }
  });

  proc.on('error', e  => console.error('[Backend] spawn error:', e.message));
  proc.on('exit',  (c, s) => {
    console.log(`[Backend] exited — code:${c} signal:${s}`);

    // Tear the dead child's pipes down NOW so nothing can write into them
    // between exit and the next restart (the EPIPE window).
    try { proc.stdin?.destroy(); } catch {}
    try { proc.stdout?.destroy(); } catch {}
    try { proc.stderr?.destroy(); } catch {}

    if (state.backendProcess === proc) {
      state.backendProcess = null;
      state.backendReady   = false;
    }

    // EP-010.1: the Database Setup Wizard requested this exit (config was
    // just saved) — restart regardless of exit code/signal. Checked BEFORE
    // the crash-restart branch below and BEFORE app.isQuitting would matter,
    // since this exit is intentional but not a real app-quit.
    const configRestart = state.pendingConfigRestart;
    state.pendingConfigRestart = false;
    if (configRestart && !app.isQuitting) {
      console.log('[Backend] Restarting after database configuration change');
      setTimeout(() => {
        if (!app.isQuitting && !state.backendProcess) startBackend(paths, extraEnv);
      }, 1000);
      return;
    }

    // Restart on crash, but NOT if quitting
    if (!app.isQuitting && c !== 0 && s !== 'SIGTERM') {
      console.log('[Backend] Crashed — restarting in 4s');
      setTimeout(() => {
        if (!app.isQuitting && !state.backendProcess) startBackend(paths, extraEnv);
      }, 4000);
    }
  });
}

// Write the shutdown command ONLY if the pipe is provably alive. Returns true
// if the request was written. Synchronous throw AND async 'error' events are
// both covered (stream error handlers attached at spawn).
export function requestBackendShutdown() {
  const p = state.backendProcess;
  if (!p || p.killed || p.exitCode !== null) return false;
  const sin = p.stdin;
  if (!sin || sin.destroyed || !sin.writable) return false;
  try {
    sin.write('shutdown\n');
    return true;
  } catch (err) {
    console.warn('[Electron] shutdown write failed:', err.code || err.message);
    return false;
  }
}
