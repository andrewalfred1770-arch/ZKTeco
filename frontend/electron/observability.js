import { app } from 'electron';
import { join } from 'path';
import { existsSync, mkdirSync, statSync, unlinkSync, renameSync, createWriteStream } from 'fs';

// ─── Pipe-teardown safety ─────────────────────────────────────────────────────
// Two classes of expected, non-fatal pipe errors can hit the main process:
//  1. OUR OWN stdout/stderr: when the app is launched by a wrapper/installer
//    /test harness with piped stdio and the launcher dies first, every later
//    console.log raises EPIPE on process.stdout.
//  2. The BACKEND CHILD's stdin (graceful-shutdown command channel): writes
//    after the child exits/restarts raise EPIPE/ERR_STREAM_DESTROYED as async
//    stream 'error' events — a try/catch around write() does NOT catch those.
// Neither may ever crash the main process.
const BENIGN_PIPE_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ECONNRESET', 'ERR_STREAM_WRITE_AFTER_END']);
export const isBenignPipeError = (err) =>
  !!err && (BENIGN_PIPE_CODES.has(err.code) || /EPIPE|ECONNRESET|write after end/i.test(String(err.message)));

// Swallow stdio pipe errors from our own process (launcher died first).
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === 'function') {
    stream.on('error', (err) => { if (!isBenignPipeError(err)) throw err; });
  }
}

// ─── Persistent file log (main.log) ──────────────────────────────────────────
// The packaged GUI app has no visible stdout — without a file sink every
// [Electron]/[Backend] line (including all RT-* diagnostics) is lost and an
// on-site incident cannot be diagnosed after the fact. Tee console.* into
// %APPDATA%/petshrow-erp/logs/main.log (the same path the pre-remediation
// electron-log builds wrote to). Must never throw: logging failures are
// swallowed, the console keeps working without the file sink.
let logStream = null;
try {
  const logDir  = join(app.getPath('userData'), 'logs');
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, 'main.log');
  try {
    // Startup size rotation keeps main.log bounded across long uptimes.
    if (statSync(logFile).size > 5 * 1024 * 1024) {
      const old = join(logDir, 'main.old.log');
      try { unlinkSync(old); } catch {}
      renameSync(logFile, old);
    }
  } catch {}
  logStream = createWriteStream(logFile, { flags: 'a' });
  logStream.on('error', () => { logStream = null; });
  const ts = () => {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
           `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  };
  const toLine = (a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  };
  for (const [method, tag] of [['log', 'info'], ['warn', 'warn'], ['error', 'error']]) {
    const orig = console[method].bind(console);
    console[method] = (...args) => {
      try { orig(...args); } catch {}
      try { if (logStream) logStream.write(`[${ts()}] [${tag}]  ${args.map(toLine).join(' ')}\n`); } catch {}
    };
  }
} catch {}

// Last-resort filter: expected pipe-teardown errors are logged (best-effort)
// and ignored; anything else stays fatal and is logged loudly first.
process.on('uncaughtException', (err) => {
  if (isBenignPipeError(err)) {
    try { console.warn('[Electron] benign pipe teardown ignored:', err.code || err.message); } catch {}
    return;
  }
  try { console.error('[Electron] FATAL uncaught exception:', err); } catch {}
  process.exit(1);
});

// A rejected promise with no .catch must never kill the main process. Without
// this handler, Node's default 'throw' mode re-raises the rejection as an
// uncaughtException, and the handler above turns that into process.exit(1) —
// a silent main-process death that orphans the renderer and leaves no backend
// (observed live 2026-06-11 17:32: renderer alive, main gone, port 5000
// closed, zero log output). Startup races (e.g. the splash window's loadURL
// aborting because the splash was closed early) are exactly this class.
process.on('unhandledRejection', (reason) => {
  if (isBenignPipeError(reason)) {
    try { console.warn('[Electron] benign pipe rejection ignored:', reason.code || reason.message); } catch {}
    return;
  }
  try {
    console.error('[Electron] UNHANDLED PROMISE REJECTION (non-fatal):',
      (reason && reason.stack) || String(reason));
  } catch {}
});
