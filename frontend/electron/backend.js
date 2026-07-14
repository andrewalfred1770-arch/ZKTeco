import { spawn, execSync } from 'child_process';
import { existsSync } from 'fs';
import net from 'net';
import http from 'http';
import { app } from 'electron';
import { BACKEND_PORT, IS_DEV, HEALTH_URL } from './constants.js';
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

// ─── Quick HTTP ping ──────────────────────────────────────────────────────────
function quickPing(timeoutMs = 500) {
  return new Promise(resolve => {
    const req = http.get(HEALTH_URL, res => { res.resume(); resolve(true); })
      .on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}

// ─── Kill stale backend on this port ─────────────────────────────────────────
export async function killStaleBackend() {
  const inUse = await isPortListening(BACKEND_PORT);
  if (!inUse) return;

  console.log(`[Electron] Port ${BACKEND_PORT} in use — checking if it's a stale process`);
  try {
    // Check if it's OUR backend (responds to /api/health)
    const alive = await quickPing(1000);
    if (alive) {
      // Backend already up — don't start another
      console.log('[Electron] Backend already running — will use it');
      state.backendReady = true;
      return;
    }
  } catch {}

  // Port in use but not our backend — try to free it.
  // findstr /C:":5000 " (with the trailing space) is a literal match — the
  // old bare `:5000` was a substring match that also hit :50000–:50009 and
  // could taskkill completely unrelated processes. LISTENING filter keeps
  // ephemeral client connections out of the kill list.
  if (process.platform === 'win32') {
    try {
      execSync(
        `for /f "tokens=5" %a in ('netstat -aon ^| findstr LISTENING ^| findstr /C:":${BACKEND_PORT} "') do taskkill /PID %a /F`,
        { shell: 'cmd.exe', stdio: 'ignore', timeout: 2000 }
      );
      await new Promise(r => setTimeout(r, 1000));
      console.log('[Electron] Freed stale port');
    } catch {}
  } else {
    // macOS/Linux (EP-004): no netstat/taskkill equivalent — use lsof to find
    // the PID(s) actually LISTENING on the port, then SIGKILL each directly
    // via Node (no extra shell interpolation needed, unlike the Windows path).
    try {
      const pids = execSync(`lsof -ti tcp:${BACKEND_PORT} -sTCP:LISTEN`, {
        stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
      }).toString().trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        try { process.kill(Number(pid), 'SIGKILL'); } catch {}
      }
      if (pids.length) {
        await new Promise(r => setTimeout(r, 1000));
        console.log('[Electron] Freed stale port');
      }
    } catch {}
  }
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

// ─── Backend startup ──────────────────────────────────────────────────────────
export function startBackend(paths) {
  if (state.backendReady) {
    console.log('[Electron] Backend already running — skipping launch');
    return;
  }

  const { backendEntry, backendCwd, envFile, frontendDist } = paths;

  if (!existsSync(backendEntry)) {
    console.error('[Electron] Backend entry not found:', backendEntry);
    return;
  }

  const env = {
    ...process.env,
    NODE_ENV:     IS_DEV ? 'development' : 'production',
    PORT:         String(BACKEND_PORT),
    ELECTRON_APP: '1',
  };
  if (frontendDist)          env.FRONTEND_DIST      = frontendDist;
  if (existsSync(envFile))   env.DOTENV_CONFIG_PATH = envFile;
  if (!IS_DEV)               env.ELECTRON_RUN_AS_NODE = '1';

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

    // Restart on crash, but NOT if quitting
    if (!app.isQuitting && c !== 0 && s !== 'SIGTERM') {
      console.log('[Backend] Crashed — restarting in 4s');
      setTimeout(() => {
        if (!app.isQuitting && !state.backendProcess) startBackend(paths);
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
