/**
 * test-pipe-guard.cjs — simulates the exact EPIPE lifecycle the Electron main
 * process must survive: child with piped stdin dies, parent then attempts the
 * guarded shutdown write. Mirrors the guard logic in electron.js.
 * Exit 0 = guards correct (no crash, write correctly refused after death).
 */
const { spawn } = require('child_process');

const BENIGN = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ECONNRESET', 'ERR_STREAM_WRITE_AFTER_END']);
const isBenign = (e) => !!e && (BENIGN.has(e.code) || /EPIPE|ECONNRESET|write after end/i.test(String(e.message)));

process.on('uncaughtException', (err) => {
  if (isBenign(err)) { console.log('GUARD-OK: benign pipe error swallowed:', err.code); return; }
  console.error('FAIL: unexpected uncaught:', err);
  process.exit(1);
});

function guardedWrite(p) {
  if (!p || p.killed || p.exitCode !== null) return false;
  const sin = p.stdin;
  if (!sin || sin.destroyed || !sin.writable) return false;
  try { sin.write('shutdown\n'); return true; } catch { return false; }
}

// Child that lives until killed
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: ['pipe', 'pipe', 'pipe'] });
for (const s of [child.stdin, child.stdout, child.stderr]) {
  if (s) s.on('error', (e) => { if (!isBenign(e)) { console.error('FAIL stream error:', e); process.exit(1); } });
}

child.on('exit', () => {
  try { child.stdin?.destroy(); } catch {}
  // 1. Write AFTER exit + destroy — guard must refuse, nothing may crash.
  setTimeout(() => {
    const wrote = guardedWrite(child);
    if (wrote) { console.error('FAIL: wrote into a dead pipe'); process.exit(1); }
    console.log('PASS: write refused after child exit (guard caught it)');
    // 2. Raw unguarded write to the destroyed stream — error handler must absorb it.
    try { child.stdin.write('x\n'); } catch (e) {
      if (!isBenign(e)) { console.error('FAIL: sync throw not benign:', e); process.exit(1); }
      console.log('PASS: sync throw on destroyed stream is benign:', e.code);
    }
    setTimeout(() => { console.log('PASS: process survived all pipe teardown paths'); process.exit(0); }, 300);
  }, 200);
});

// Live write first (must succeed), then kill.
setTimeout(() => {
  const ok = guardedWrite(child);
  console.log(ok ? 'PASS: live write accepted' : 'FAIL: live write refused');
  if (!ok) process.exit(1);
  child.kill();
}, 300);
