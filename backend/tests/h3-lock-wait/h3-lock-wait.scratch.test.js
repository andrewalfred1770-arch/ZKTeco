/**
 * H3 — lock wait longer than Prisma's interactive-transaction timeout. REAL MySQL regression test (scratch database ONLY).
 *
 * Required environment (otherwise every test is SKIPPED):
 *   SCRATCH_BACKEND_DIR       env-free backend COPY with the FIXED src (hash-checked against the repository for the files under test)
 *   SCRATCH_DATABASE_URL      mysql://user[:pw]@127.0.0.1:PORT/scratch_<name>      (this test wipes the app tables of that scratch DB and sets the
 *                             scratch server's GLOBAL innodb_lock_wait_timeout; it resets it to 5 at the end)
 *   I_CONFIRM_THIS_IS_A_DISPOSABLE_SCRATCH_DATABASE   exact database name
 * Optional (before/after proof): SCRATCH_NOH3_BACKEND_DIR — a copy identical to the fixed one except that the 4 route files call prisma.$transaction
 * directly (the code as it was before H3). Not hash-checked: it is a deliberately different copy.
 * Run:  node --test tests/h3-lock-wait/h3-lock-wait.scratch.test.js        (≈ 6–7 minutes: real lock waits of 3–40 s)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path'); const crypto = require('crypto'); const { spawnSync } = require('child_process');

const DIR = process.env.SCRATCH_BACKEND_DIR; const NOH3 = process.env.SCRATCH_NOH3_BACKEND_DIR;
const URL_ = process.env.SCRATCH_DATABASE_URL; const CONFIRM = process.env.I_CONFIRM_THIS_IS_A_DISPOSABLE_SCRATCH_DATABASE;
const REPO_BACKEND = path.resolve(__dirname, '..', '..'); const REPO_SRC = path.join(REPO_BACKEND, 'src');
const FILES = ['utils/lockWaitCap.js', 'utils/apiError.js', 'routes/payroll.js', 'routes/advances.js', 'routes/adjustments.js', 'routes/attendance/manual.js'];
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function dirProblem(d) {
  if (!d || !path.isAbsolute(d) || !fs.existsSync(path.join(d, 'src', 'routes', 'payroll.js'))) return `${d} is not a backend copy`;
  if (path.resolve(d) === REPO_BACKEND || path.resolve(d).startsWith(REPO_BACKEND + path.sep)) return 'backend copy must live outside the repository';
  if ([d, path.join(d, 'prisma')].some((x) => fs.readdirSync(x).some((n) => n === '.env' || n.startsWith('.env.')))) return 'the backend copy contains an env file';
  return null;
}
function refuse() {
  if (!DIR || !URL_ || !CONFIRM) return 'scratch environment variables not set';
  const m = /^mysql:\/\/[^/@]*@(127\.0\.0\.1|localhost):\d+\/(scratch_[a-z0-9_]+)$/.exec(URL_);
  if (!m || CONFIRM !== m[2]) return 'scratch database URL / confirmation invalid';
  const p = dirProblem(DIR); if (p) return p;
  for (const f of FILES) if (sha(path.join(DIR, 'src', f)) !== sha(path.join(REPO_SRC, f))) return `backend copy is stale: src/${f} differs from the repository`;
  return null;
}
const REFUSAL = refuse();
if (REFUSAL) console.log(`[h3-lock-wait] SKIPPED: ${REFUSAL}`);
const T = (name, opts, fn) => test(name, { skip: REFUSAL || (opts.needs && !opts.needs() ? 'variant dir not provided' : false), timeout: 600000 }, fn);

function scenario(dir, op, lw) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'h3-scenario.js'), dir, op, String(lw)], { env: { ...process.env }, encoding: 'utf8', timeout: 500000, maxBuffer: 64 * 1024 * 1024 });
  const m = /@@RESULT@@(\{.*\})/.exec(r.stdout || '');
  assert.ok(m, `no scenario result (${op}, lw=${lw}): ${(r.stderr || r.stdout || '').slice(-400)}`);
  return JSON.parse(m[1]);
}
const healthy = (res, lw) => {
  assert.equal(res.probes.failed, 0, `follow-up requests after the lock timeout must all succeed: ${JSON.stringify(res.probes.firstFailures)}`);
  assert.deepEqual(res.sessionValues, [lw], 'every pooled connection serves the server\'s lock-wait value (nothing left capped)');
  assert.deepEqual(res.sessionAfter, [lw]);
  assert.equal(res.noWriteWhileLocked, true, 'the failed request wrote nothing');
  assert.equal(res.lockedRowUntouched, true, 'the held row is intact (no lock bypass)');
  assert.ok([200, 201].includes(res.retry.status), `the same request succeeds once the lock is free (${res.retry.status})`);
  assert.ok([200, 201].includes(res.control.status));
  assert.deepEqual(res.deltas.target, res.deltas.control, 'retry applied exactly once — same audit/advance deltas as an unlocked control run (no duplicates, no partial write)');
};

// ═════ before / after on the real routes ═════
T('H3-before. ORIGINAL code, payroll PUT under a lock held longer than the 5 s transaction timeout: 500 after the full lock wait AND unrelated requests fail', { needs: () => NOH3 }, () => {
  assert.equal(dirProblem(NOH3), null);
  const res = scenario(NOH3, 'payrollPut', 12);
  assert.equal(res.op1.status, 500); assert.ok(res.op1.ms >= 11000, `error only after the whole lock wait (${res.op1.ms} ms)`);
  assert.ok(res.probes.failed >= 1, 'bug reproduced: requests that have nothing to do with the locked row fail afterwards');
  console.log(`[h3-before] valid-admin /me and reads after the timeout: ${JSON.stringify(res.probes.firstFailures.map((f) => [f.name, f.status]))}`);
});
for (const op of ['advanceDelete', 'absenceType', 'bulkMark', 'bulkApprove']) {
  T(`H3-before. ORIGINAL code, ${op} under a lock held longer than the 5 s transaction timeout: fails only after the full 12 s wait and unrelated requests (auth check, payroll list) fail afterwards`, { needs: () => NOH3 }, () => {
    const res = scenario(NOH3, op, 12);
    if (op === 'bulkApprove') { assert.equal(res.op1.status, 200); assert.equal(JSON.parse(res.op1body).results[0].success, false); } else assert.equal(res.op1.status, 500);
    assert.ok(res.op1.ms >= 11000, `error only after the whole lock wait (${res.op1.ms} ms)`);
    assert.ok(res.probes.failed >= 1, `bug reproduced: ${JSON.stringify(res.probes.firstFailures.map((f) => [f.name, f.status]))}`);
  });
}
for (const op of ['payrollPut', 'payrollAdvance', 'advancePost', 'advanceDelete', 'manualPenalty', 'manualEdit', 'absenceType', 'bulkMark', 'bulkApprove']) {
  T(`H3-after. FIXED, ${op} under a held row lock: controlled 409 LOCK_WAIT_TIMEOUT, app stays healthy (auth + reads), nothing written, session value restored, retry applies once`, {}, () => {
    const res = scenario(DIR, op, 12);
    if (op === 'bulkApprove') {
      // existing contract kept: the per-item catch reports the failed item inside an HTTP 200 body (no 409, no code)
      assert.equal(res.op1.status, 200); const body = JSON.parse(res.op1body);
      assert.deepEqual(body.results.map((r) => r.success), [false]); assert.equal(body.count, 0);
      assert.equal(res.adjustments.before, 'pending'); assert.equal(res.adjustments.whileLocked, 'pending', 'the adjustment was not approved while the row was locked');
      assert.equal(res.adjustments.afterRetry, 'approved', 'retry approves it'); assert.equal(res.adjustments.controlAfter, 'approved');
    } else {
      assert.equal(res.op1.status, 409); assert.equal(res.op1.code, 'LOCK_WAIT_TIMEOUT');
      assert.ok(!/prisma|invocation|SELECT|1205/i.test(String(res.op1.error)), 'safe message');
    }
    if (op === 'manualEdit') assert.ok(res.op1.ms <= 13500, `MySQL ended the wait inside the 30 s transaction timeout (${res.op1.ms} ms)`);
    else assert.ok(res.op1.ms >= 2500 && res.op1.ms <= 5000, `capped at 3 s, well inside Prisma's 5 s timeout (${res.op1.ms} ms)`);
    healthy(res, 12);
  });
}
T('H3-long-wait. manual attendance edit (30 s transaction timeout) with a 40 s server lock wait: ORIGINAL fails after ~30–40 s with 500 and breaks other requests; FIXED returns 409 at the 18 s cap and stays healthy', { needs: () => NOH3 }, () => {
  const before = scenario(NOH3, 'manualEdit', 40);
  assert.equal(before.op1.status, 500); assert.ok(before.probes.failed >= 1, 'original: unrelated requests fail after the timeout');
  const after = scenario(DIR, 'manualEdit', 40);
  assert.equal(after.op1.status, 409); assert.equal(after.op1.code, 'LOCK_WAIT_TIMEOUT'); assert.ok(after.op1.ms >= 17000 && after.op1.ms <= 21000, `18 s cap (${after.op1.ms} ms)`);
  healthy(after, 40);
});

// ═════ the helper itself, on a 1-connection pool (every request reuses the same connection) ═════
let PrismaClient; let helper; let admin;
const mk = (x = '') => new PrismaClient({ datasources: { db: { url: URL_ + x } }, errorFormat: 'minimal', log: [] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lw = async (P) => Number((await P.$queryRawUnsafe('SELECT @@session.innodb_lock_wait_timeout AS v'))[0].v);
async function holder(ms) { const H = mk('?connection_limit=1'); const p = H.$transaction(async (tx) => { await tx.$queryRawUnsafe('SELECT id FROM h3_a WHERE id=1 FOR UPDATE'); await sleep(ms); }, { timeout: ms + 20000 }); await sleep(700); return () => p.catch(() => {}).then(() => H.$disconnect()); }
test.before(async () => {
  if (REFUSAL) return;
  process.env.NODE_PATH = path.join(DIR, 'node_modules'); require('module')._initPaths();
  ({ PrismaClient } = require(path.join(DIR, 'node_modules/@prisma/client'))); helper = require(path.join(DIR, 'src/utils/lockWaitCap.js'));
  admin = mk(); await admin.$executeRawUnsafe('SET GLOBAL innodb_lock_wait_timeout = 5');
  await admin.$executeRawUnsafe('DROP TABLE IF EXISTS h3_a'); await admin.$executeRawUnsafe('CREATE TABLE h3_a (id INT PRIMARY KEY, v INT NOT NULL) ENGINE=InnoDB'); await admin.$executeRawUnsafe('INSERT INTO h3_a VALUES (1,111),(2,222)');
});
test.after(async () => { if (REFUSAL) return; try { await admin.$executeRawUnsafe('DROP TABLE IF EXISTS h3_a'); await admin.$executeRawUnsafe('SET GLOBAL innodb_lock_wait_timeout = 5'); } catch { /* best effort */ } await admin.$disconnect(); });

T('U1. helper: lock wait ends at the 3 s cap with LockWaitTimeoutError (409); follow-ups on the same connection healthy; session value restored', {}, async () => {
  const P = mk('?connection_limit=1'); const release = await holder(9000); const t = Date.now(); let err;
  try { await helper.lockCappedTransaction(P, async (tx) => { await tx.$queryRawUnsafe('SELECT id FROM h3_a WHERE id=1 FOR UPDATE'); }); } catch (e) { err = e; }
  const ms = Date.now() - t;
  assert.ok(err instanceof helper.LockWaitTimeoutError); assert.equal(err.statusCode, 409); assert.equal(err.code, 'LOCK_WAIT_TIMEOUT'); assert.ok(ms >= 2500 && ms < 4800, `${ms} ms`);
  for (let i = 0; i < 6; i++) assert.deepEqual(await P.$queryRawUnsafe('SELECT v FROM h3_a WHERE id=2'), [{ v: 222 }]);
  assert.equal(await lw(P), 5, 'restored'); await release(); await P.$disconnect();
});
T('U2. helper: success path caps during the transaction (3) and restores afterwards (5)', {}, async () => {
  const P = mk('?connection_limit=1'); let during;
  await helper.lockCappedTransaction(P, async (tx) => { during = Number((await tx.$queryRawUnsafe('SELECT @@session.innodb_lock_wait_timeout AS v'))[0].v); await tx.$queryRawUnsafe('SELECT id FROM h3_a WHERE id=2 FOR UPDATE'); });
  assert.equal(during, 3); assert.equal(await lw(P), 5); await P.$disconnect();
});
T('U3. helper: an application error rolls back, restores the value and is rethrown unchanged (not mapped to a lock error)', {}, async () => {
  const P = mk('?connection_limit=1'); let err;
  try { await helper.lockCappedTransaction(P, async (tx) => { await tx.$executeRawUnsafe('UPDATE h3_a SET v = 999 WHERE id = 2'); throw Object.assign(new Error('boom'), { statusCode: 400 }); }); } catch (e) { err = e; }
  assert.equal(err.message, 'boom'); assert.ok(!(err instanceof helper.LockWaitTimeoutError)); assert.equal(await lw(P), 5);
  assert.deepEqual(await P.$queryRawUnsafe('SELECT v FROM h3_a WHERE id=2'), [{ v: 222 }], 'rolled back'); await P.$disconnect();
});
T('U4. helper: no cap when the server wait is already within the cap (explicit 30 s timeout → cap 18 s ≥ server 5 s): session untouched', {}, async () => {
  const P = mk('?connection_limit=1'); let during;
  await helper.lockCappedTransaction(P, async (tx) => { during = Number((await tx.$queryRawUnsafe('SELECT @@session.innodb_lock_wait_timeout AS v'))[0].v); }, { timeout: 30000, maxWait: 10000 });
  assert.equal(during, 5); assert.equal(await lw(P), 5); await P.$disconnect();
});
T('U5. KNOWN LIMIT: if Prisma expires the transaction for a non-lock reason (slow callback) the finally cannot run and the capped value stays on that connection; its next capped transaction restores it', {}, async () => {
  const P = mk('?connection_limit=1'); let err;
  try { await helper.lockCappedTransaction(P, async (tx) => { await tx.$queryRawUnsafe('SELECT 1'); await sleep(6500); await tx.$queryRawUnsafe('SELECT 2'); }); } catch (e) { err = e; }
  assert.match(String(err && err.message), /expired transaction|Transaction already closed/);
  assert.equal(await lw(P), 3, 'documented: the cap leaked on this connection (only SHORTENS later lock waits; no wrong results)');
  assert.deepEqual(await P.$queryRawUnsafe('SELECT v FROM h3_a WHERE id=2'), [{ v: 222 }], 'the connection still answers correctly');
  await helper.lockCappedTransaction(P, async (tx) => { await tx.$queryRawUnsafe('SELECT 1'); }, { timeout: 30000, maxWait: 10000 });
  assert.equal(await lw(P), 5, 'healed by the next capped transaction'); await P.$disconnect();
});
T('U6. helper: isLockWaitError recognises MySQL 1205 shapes and nothing else', {}, () => {
  const f = helper.isLockWaitError;
  assert.equal(f(new Error('Raw query failed. Code: `1205`. Message: `Lock wait timeout exceeded; try restarting transaction`')), true);
  assert.equal(f({ message: 'x', meta: { code: '1205' } }), true);
  assert.equal(f(new Error('Unique constraint failed')), false); assert.equal(f(new Error('Transaction already closed: expired')), false); assert.equal(f(null), false);
  assert.equal(helper.lockWaitCapSeconds(5000), 3); assert.equal(helper.lockWaitCapSeconds(30000), 18); assert.equal(helper.lockWaitCapSeconds(1000), 1);
});

// ═════ expired-transaction warning (observability of the known residual risk) ═════
function captureWarnings(fn) {
  const logger = require(path.join(DIR, 'src/utils/logger.js')); const orig = logger.warn; const lines = [];
  logger.warn = (m) => { lines.push(String(m)); };
  return Promise.resolve().then(fn).then(() => lines).finally(() => { logger.warn = orig; });
}
const EXPIRY = /transaction expired before innodb_lock_wait_timeout could be restored/;
T('W1. warning: a slow callback that Prisma expires logs ONE expiry warning (cap, server value, timeout, caller site) and the original Prisma error is rethrown unchanged', {}, async () => {
  const P = mk('?connection_limit=1'); let err;
  const lines = await captureWarnings(async () => {
    try { await helper.lockCappedTransaction(P, async (tx) => { await tx.$queryRawUnsafe('SELECT 1'); await sleep(6500); await tx.$queryRawUnsafe('SELECT 2'); }); } catch (e) { err = e; }
  });
  assert.equal(err.name, 'PrismaClientKnownRequestError'); assert.equal(err.code, 'P2028'); assert.ok(!(err instanceof helper.LockWaitTimeoutError), 'original error, not mapped');
  const hits = lines.filter((l) => EXPIRY.test(l)); assert.equal(hits.length, 1, lines.join(' | '));
  assert.match(hits[0], /3s instead of 5s/); assert.match(hits[0], /tx timeout 5000ms/); assert.match(hits[0], /caller=[\w/.-]+\.js:\d+/);
  assert.ok(!/postgres|mysql:|password|token|SELECT|SET SESSION/i.test(hits[0]), 'no SQL, credentials or connection strings in the warning');
  assert.ok(/may keep the capped value/.test(hits[0]), 'states the risk; does not claim a restore');
  await P.$disconnect();
});
T('W2. no expiry warning for: success, application error, lock-wait error, killed connection (restore fails but NOT because of expiry)', {}, async () => {
  const P = mk('?connection_limit=2&pool_timeout=20'); const A = mk(); const all = [];
  all.push(...await captureWarnings(() => helper.lockCappedTransaction(P, async (tx) => { await tx.$queryRawUnsafe('SELECT 1'); })));
  all.push(...await captureWarnings(async () => { try { await helper.lockCappedTransaction(P, async () => { throw Object.assign(new Error('boom'), { statusCode: 400 }); }); } catch { /* expected */ } }));
  const release = await holder(9000);
  const lockWait = await captureWarnings(async () => { try { await helper.lockCappedTransaction(P, async (tx) => { await tx.$queryRawUnsafe('SELECT id FROM h3_a WHERE id=1 FOR UPDATE'); }); } catch { /* lock wait */ } });
  all.push(...lockWait); await release();
  const killed = await captureWarnings(async () => { try { await helper.lockCappedTransaction(P, async (tx) => { const cid = Number((await tx.$queryRawUnsafe('SELECT CONNECTION_ID() AS c'))[0].c); await A.$executeRawUnsafe('KILL ' + cid); await sleep(300); await tx.$queryRawUnsafe('SELECT 1'); }); } catch { /* connection lost */ } });
  all.push(...killed);
  assert.equal(all.filter((l) => EXPIRY.test(l)).length, 0, 'no expiry warning for any of these: ' + all.join(' | '));
  assert.ok(lockWait.some((l) => /\[LOCK-WAIT\]/.test(l)), 'the lock-wait warning still appears');
  assert.ok(killed.some((l) => /could not restore innodb_lock_wait_timeout/.test(l)), 'a restore failure that is not an expiry keeps the generic warning');
  await A.$disconnect(); await P.$disconnect();
});
T('W3. classification: only P2028 with meta.error "…on an expired transaction" counts; maxWait, committed-transaction, lock-wait, string-only and null do not', {}, () => {
  const f = helper.isTransactionExpiredError;
  assert.equal(f({ code: 'P2028', meta: { error: 'Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 6508 ms passed…' } }), true);
  assert.equal(f({ code: 'P2028', meta: { error: 'Transaction already closed: A commit cannot be executed on an expired transaction. …' } }), true);
  assert.equal(f({ code: 'P2028', meta: { error: 'Unable to start a transaction in the given time.' } }), false, 'maxWait: the callback never ran');
  assert.equal(f({ code: 'P2028', meta: { error: 'Transaction already closed: A query cannot be executed on a committed transaction.' } }), false);
  assert.equal(f({ code: 'P2010', meta: { code: '1205' } }), false); assert.equal(f(new Error('Transaction already closed: … on an expired transaction')), false, 'message text alone is not enough');
  assert.equal(f({ code: 'P2028' }), false); assert.equal(f(null), false); assert.equal(f(undefined), false);
});
