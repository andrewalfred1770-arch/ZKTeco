/**
 * Is cleanup's `skipDays` protection NECESSARY? Runs the same scenario (skipdays-scenario.js, child process, scratch MySQL only) against
 *   - SCRATCH_BACKEND_DIR          the FIXED backend copy (skipDays active), and
 *   - SCRATCH_NOSKIP_BACKEND_DIR   a TEST-ONLY copy identical to it except that cleanup.js does not pass `skipDays` to recalcScope.
 * The working implementation is never modified. Skipped unless all of these are set:
 *   SCRATCH_BACKEND_DIR, SCRATCH_NOSKIP_BACKEND_DIR, SCRATCH_DATABASE_URL (…/scratch_<name>), I_CONFIRM_THIS_IS_A_DISPOSABLE_SCRATCH_DATABASE=<name>
 * Run:  node --test tests/closed-month/skipdays-necessity.scratch.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path'); const { spawnSync } = require('child_process');
const FIXED = process.env.SCRATCH_BACKEND_DIR; const NOSKIP = process.env.SCRATCH_NOSKIP_BACKEND_DIR;
const URL_ = process.env.SCRATCH_DATABASE_URL; const CONFIRM = process.env.I_CONFIRM_THIS_IS_A_DISPOSABLE_SCRATCH_DATABASE;
const REPO_BACKEND = path.resolve(__dirname, '..', '..');
function problem() {
  if (!FIXED || !NOSKIP || !URL_ || !CONFIRM) return 'scratch environment variables not set';
  const m = /^mysql:\/\/[^/@]*@(127\.0\.0\.1|localhost):\d+\/(scratch_[a-z0-9_]+)$/.exec(URL_);
  if (!m || CONFIRM !== m[2]) return 'scratch database URL / confirmation invalid';
  for (const d of [FIXED, NOSKIP]) {
    if (!path.isAbsolute(d) || !fs.existsSync(path.join(d, 'src', 'routes', 'cleanup.js'))) return `${d} is not a backend copy`;
    if (path.resolve(d).startsWith(REPO_BACKEND + path.sep) || path.resolve(d) === REPO_BACKEND) return 'backend copies must live outside the repository';
    if (fs.readdirSync(d).some((n) => n === '.env' || n.startsWith('.env.'))) return 'backend copy contains an env file';
  }
  const lines = (d) => fs.readFileSync(path.join(d, 'src/routes/cleanup.js'), 'utf8').split(/\r?\n/);
  const fixedLines = lines(FIXED); const noskipLines = lines(NOSKIP);
  const isSkip = (l) => l.trim() === 'skipDays,';
  if (!fixedLines.some(isSkip)) return 'the fixed copy does not pass skipDays';
  if (noskipLines.some(isSkip)) return 'the no-skipDays copy still passes skipDays';
  if (JSON.stringify(fixedLines.filter((l) => !isSkip(l))) !== JSON.stringify(noskipLines)) return 'the no-skipDays copy differs from the fixed copy by more than the skipDays line';
  return null;
}
const REFUSAL = problem();
if (REFUSAL) console.log(`[skipdays-necessity] SKIPPED: ${REFUSAL}`);
const run = (dir, mode) => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'skipdays-scenario.js'), dir, mode], { env: { ...process.env }, encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('@@RESULT@@'));
  assert.ok(line, `no scenario result (${dir}, ${mode}): ${(r.stderr || '').slice(-300)}`);
  return JSON.parse(line.slice('@@RESULT@@'.length));
};
for (const mode of ['daily', 'rawLogs']) {
  test(`cleanup ${mode}: WITH skipDays protected rows keep stored punches / status; WITHOUT it they are rewritten to absent`, { skip: REFUSAL || false }, () => {
    const fixed = run(FIXED, mode); const noskip = run(NOSKIP, mode);
    assert.equal(fixed.status, 200, fixed.error); assert.equal(noskip.status, 200, noskip.error);
    assert.deepEqual(fixed.after, fixed.before, 'fixed implementation: protected rows unchanged');
    assert.ok(fixed.skippedProtectedDays >= 3);
    assert.notDeepEqual(noskip.after, noskip.before, 'without skipDays the post-cleanup recalculation rewrites them (so skipDays is necessary)');
    assert.ok(noskip.after.every((r) => r.status === 'absent' && r.checkIn === null), 'rewritten to absent with the stored punches cleared');
    assert.deepEqual(noskip.after.map((r) => [r.manualLate, r.reason]), noskip.before.map((r) => [r.manualLate, r.reason]), 'manual fields themselves survive either way — only derived fields differ');
  });
}
