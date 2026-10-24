/**
 * H2 — closed-payroll evidence-loss guard + cleanup skipDays + UI helpers. REAL MySQL regression test (scratch database ONLY).
 *
 * Required environment (otherwise every test is SKIPPED — never run against anything else):
 *   SCRATCH_BACKEND_DIR       backend COPY with the FIXED src (env-free; src hashes must equal the repository's for the files under test)
 *   SCRATCH_DATABASE_URL      mysql://user[:pw]@127.0.0.1:PORT/scratch_<name>
 *   I_CONFIRM_THIS_IS_A_DISPOSABLE_SCRATCH_DATABASE   must equal that exact database name
 * Optional (before/after proof, each a separate env-free backend copy with the ORIGINAL code):
 *   SCRATCH_ORIG_BACKEND_DIR  src = working tree as it was BEFORE the H2 edits
 *   SCRATCH_HEAD_BACKEND_DIR  src = `git archive HEAD` export (read-only)
 * The scenario for those runs in a child process (h2-scenario.js) with the same scratch guards.
 *
 * Run:  node --test tests/closed-month/closed-month.scratch.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const DIR = process.env.SCRATCH_BACKEND_DIR;
const URL_ = process.env.SCRATCH_DATABASE_URL;
const CONFIRM = process.env.I_CONFIRM_THIS_IS_A_DISPOSABLE_SCRATCH_DATABASE;
const ORIG = process.env.SCRATCH_ORIG_BACKEND_DIR;
const HEAD = process.env.SCRATCH_HEAD_BACKEND_DIR;
const REPO_BACKEND = path.resolve(__dirname, '..', '..');
const REPO_SRC = path.join(REPO_BACKEND, 'src');
const FRONTEND = path.resolve(REPO_BACKEND, '..', 'frontend', 'src');
const FILES_UNDER_TEST = ['engines/attendanceEngine.js', 'engines/recalcEngine.js', 'routes/cleanup.js', 'routes/attendance/processing.js', 'routes/adjustments.js', 'utils/cleanupProtection.js', 'services/historicalRebuildService.js'];

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function dirProblem(dir) {
  if (!dir || !path.isAbsolute(dir) || !fs.existsSync(path.join(dir, 'src', 'routes', 'cleanup.js'))) return `${dir} is not a backend copy`;
  const real = path.resolve(dir);
  if (real === REPO_BACKEND || real.startsWith(REPO_BACKEND + path.sep)) return 'backend copy must live outside the repository backend';
  for (const d of [dir, path.join(dir, 'prisma')]) if (fs.readdirSync(d).some((n) => n === '.env' || n.startsWith('.env.'))) return 'the backend copy contains an env file';
  return null;
}
function refuse() {
  if (!DIR || !URL_ || !CONFIRM) return 'SCRATCH_BACKEND_DIR / SCRATCH_DATABASE_URL / confirmation not set';
  const m = /^mysql:\/\/[^/@]*@(127\.0\.0\.1|localhost):\d+\/(scratch_[a-z0-9_]+)$/.exec(URL_);
  if (!m) return 'SCRATCH_DATABASE_URL must be mysql://…@127.0.0.1:PORT/scratch_<name>';
  if (CONFIRM !== m[2]) return 'confirmation does not equal the exact database name';
  const p = dirProblem(DIR); if (p) return p;
  for (const rel of FILES_UNDER_TEST) if (sha(path.join(DIR, 'src', rel)) !== sha(path.join(REPO_SRC, rel))) return `backend copy is stale: src/${rel} differs from the repository`;
  return null;
}
const REFUSAL = refuse();
if (REFUSAL) console.log(`[closed-month] SKIPPED: ${REFUSAL}`);
const T = (name, fn) => test(name, { skip: REFUSAL || false }, fn);

let admin; let srv; let base; let engine; let recalc; let rebuild; let moment; let cfgDir;
const D = (s) => new Date(`${s}T00:00:00.000Z`);
const iso = (d) => (d ? d.toISOString() : null);

test.before(async () => {
  if (REFUSAL) return;
  process.env.DATABASE_URL = URL_; delete process.env.AUTH_ENABLED;
  cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-month-')); process.env.CONFIG_DIR = cfgDir;
  process.env.NODE_PATH = path.join(DIR, 'node_modules'); require('module')._initPaths();
  const req = (p) => require(path.join(DIR, p));
  const express = req('node_modules/express'); moment = req('node_modules/moment');
  const { PrismaClient } = req('node_modules/@prisma/client');
  admin = new PrismaClient({ datasources: { db: { url: URL_ } } });
  assert.equal((await admin.$queryRaw`SELECT DATABASE() AS d`)[0].d, CONFIRM);
  for (const t of ['employees', 'attendance_daily', 'attendance_logs', 'payrolls', 'branches']) assert.equal(Number((await admin.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM ${t}`))[0].c), 0, `scratch table ${t} must be empty at start`);
  engine = req('src/engines/attendanceEngine.js'); recalc = req('src/engines/recalcEngine.js'); rebuild = req('src/services/historicalRebuildService.js');
  const app = express(); app.use(express.json());
  app.use('/api/cleanup', req('src/routes/cleanup.js'));
  app.use('/api/attendance', req('src/routes/attendance/index.js'));
  app.use('/api/adjustments', req('src/routes/adjustments.js'));
  srv = http.createServer(app).listen(0, '127.0.0.1'); await new Promise((r) => srv.on('listening', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(async () => {
  if (REFUSAL) return;
  try { await wipe(); } catch { /* best effort */ }
  await new Promise((r) => srv.close(r)); await admin.$disconnect(); fs.rmSync(cfgDir, { recursive: true, force: true });
});

async function wipe() {
  for (const t of ['adjustmentAuditLog', 'attendanceAdjustment', 'manualEditAuditLog', 'attendanceDaily', 'attendanceLog', 'payroll', 'cleanupLog', 'historicalRebuildJob', 'advance', 'employee', 'deviceSyncLog', 'device', 'department', 'shift', 'branch', 'company']) await admin[t].deleteMany({});
}
const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j }; };

/** Fixture: A closed (finalized Mar), B paid (Mar), C open (draft Mar), D no payroll, M closed Feb / open Mar. Rows carry punches; NO raw logs (purged). */
async function fx({ withRawLogs = false } = {}) {
  await wipe();
  const co = await admin.company.create({ data: { name: 'C' } });
  const br = await admin.branch.create({ data: { name: 'B', companyId: co.id } });
  const sh = await admin.shift.create({ data: { name: 'S', startTime: '08:00', endTime: '16:00' } });
  const dv = await admin.device.create({ data: { name: 'Dev', ipAddress: '192.0.2.1', branchId: br.id, enabled: false, autoSync: false } });
  const E = {}; let i = 1;
  for (const c of ['A', 'B', 'C', 'D', 'M']) E[c] = await admin.employee.create({ data: { name: c, code: c, zkUserId: String(800 + i++), salary: 3000, branchId: br.id, shiftId: sh.id, hireDate: D('2026-01-01') } });
  const days = ['2026-02-02', '2026-02-03', '2026-03-02', '2026-03-03', '2026-03-04'];
  const rows = {};
  for (const [c, e] of Object.entries(E)) for (const d of days) {
    rows[`${c}|${d}`] = await admin.attendanceDaily.create({ data: { employeeId: e.id, date: D(d), status: 'present', checkIn: new Date(`${d}T05:00:00Z`), checkOut: new Date(`${d}T13:00:00Z`), workedMinutes: 480 } });
    if (withRawLogs) for (const t of ['05:00:00', '13:00:00']) await admin.attendanceLog.create({ data: { employeeId: e.id, deviceId: dv.id, zkUserId: e.zkUserId, timestamp: new Date(`${d}T${t}Z`) } });
  }
  const pay = (e, month, status) => admin.payroll.create({ data: { employeeId: e.id, month, year: 2026, basicSalary: 3000, hourlyRate: 12.5, workDays: 3, netSalary: 3000, status } });
  const P = { A: await pay(E.A, 3, 'finalized'), B: await pay(E.B, 3, 'paid'), C: await pay(E.C, 3, 'draft'), M: await pay(E.M, 2, 'finalized') };
  return { co, br, sh, dv, E, rows, P, days };
}
const row = (f, c, d) => admin.attendanceDaily.findFirst({ where: { employeeId: f.E[c].id, date: D(d) } });
const view = (r) => r && ({ status: r.status, isAbsent: r.isAbsent, checkIn: iso(r.checkIn), checkOut: iso(r.checkOut), workedMinutes: r.workedMinutes });
const closedPayrollSnap = async () => JSON.stringify((await admin.payroll.findMany({ where: { status: { in: ['finalized', 'paid'] } }, orderBy: { id: 'asc' } })).map(({ updatedAt, ...r }) => r));
const PUNCHED = { status: 'present', isAbsent: false, workedMinutes: 480 };

// ═════ before / after: the reproduced H2 sequence, original code vs fixed code ═════
function runScenario(dir) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'h2-scenario.js'), dir], { env: { ...process.env, SCRATCH_DATABASE_URL: URL_, I_CONFIRM_THIS_IS_A_DISPOSABLE_SCRATCH_DATABASE: CONFIRM }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 240000 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('@@RESULT@@'));
  assert.ok(line, `scenario produced no result for ${dir}: ${(r.stderr || '').slice(-400)}`);
  return JSON.parse(line.slice('@@RESULT@@'.length));
}
const CLOSED_KEYS = ['A|2026-03-02', 'A|2026-03-03', 'A|2026-03-04', 'B|2026-03-02', 'B|2026-03-03', 'B|2026-03-04', 'M|2026-02-02', 'M|2026-02-03', 'M|2026-02-04'];
const changedClosed = (res) => CLOSED_KEYS.filter((k) => JSON.stringify(res.rowsAfterProcess[k]) !== JSON.stringify(res.rowsBefore[k]));

for (const [label, dir] of [['ORIGINAL (pre-H2 working tree)', ORIG], ['git HEAD export', HEAD]]) {
  test(`H2-before. ${label}: raw-log cleanup then process-month REWRITES attendance under finalized/paid payroll (bug reproduced)`, { skip: REFUSAL || (!dir ? 'variant dir not provided' : false) }, () => {
    assert.equal(dirProblem(dir), null);
    const res = runScenario(dir);
    assert.equal(res.cleanupStatus, 200);
    assert.deepEqual(changedClosed(res), CLOSED_KEYS, 'every punched day of every closed employee-month was rewritten');
    for (const k of CLOSED_KEYS) { assert.equal(res.rowsAfterProcess[k].status, 'absent'); assert.equal(res.rowsAfterProcess[k].checkIn, null); }
    assert.equal(res.payrollUnchanged, true, 'the finalized/paid payroll itself was not touched (so attendance and payroll now disagree)');
  });
}

T('H2-after. FIXED: the same sequence leaves closed employee-months untouched and reports them; payroll identical', () => {
  const res = runScenario(DIR);
  assert.equal(res.cleanupStatus, 200);
  assert.deepEqual(changedClosed(res), [], 'no closed employee-month row changed');
  assert.equal(res.payrollUnchanged, true, 'finalized/paid payroll rows byte-identical');
  const rep = (r) => r.skippedClosedPayroll.map((x) => `${x.employeeId}|${x.month}|${x.payrollStatus}|${x.days.length}`).sort();
  assert.equal(res.processMonth.mar.skippedClosedPayroll.length, 2, 'A (finalized) and B (paid) reported for March');
  assert.deepEqual(res.processMonth.mar.skippedClosedPayroll.map((x) => x.payrollStatus).sort(), ['finalized', 'paid']);
  assert.ok(res.processMonth.mar.skippedClosedPayroll.every((x) => x.days.length === 3 && x.month === 3));
  assert.equal(res.processMonth.feb.skippedClosedPayroll.length, 1, 'M reported for February only');
  assert.equal(res.processMonth.feb.skippedClosedPayroll[0].month, 2); assert.equal(rep(res.processMonth.feb).length, 1);
  // controls
  for (const k of ['C|2026-03-02', 'C|2026-03-03', 'C|2026-03-04', 'D|2026-03-02', 'M|2026-03-02', 'M|2026-03-03', 'M|2026-03-04', 'C|2026-02-02', 'D|2026-02-02']) {
    assert.equal(res.rowsAfterProcess[k].status, 'absent', `open month / no payroll ${k}: normal processing still turns purged days into absence`);
  }
  assert.equal(res.rowsAfterProcess['A|2026-03-05'].status, 'absent', 'a stored absence stays an absence');
  assert.notEqual(res.rowsAfterLate['A|2026-03-05'].status, 'absent', 'a legitimate LATE punch in a closed month still updates attendance');
  assert.equal(res.rowsAfterLate['A|2026-03-05'].isAbsent, false);
  assert.ok(res.rowsAfterLate['A|2026-03-05'].checkIn);
});

// ═════ every mutation entry point (fixed code, in-process) ═════
const unchanged = async (f, keys) => { for (const k of keys) { const [c, d] = k.split('|'); assert.deepEqual(view(await row(f, c, d)), { ...PUNCHED, checkIn: `${d}T05:00:00.000Z`, checkOut: `${d}T13:00:00.000Z` }, k); } };

T('E1. processDate direct: closed+evidence → skipped & unchanged; open → recomputed to absent', async () => {
  const f = await fx(); const snap = await closedPayrollSnap();
  const r = await engine.processDate(new Date('2026-03-02T12:00:00'), f.E.A.id);
  assert.equal(r.skipped, 'closed-evidence-loss'); assert.equal(r.payrollStatus, 'finalized'); assert.equal(r.month, 3);
  await unchanged(f, ['A|2026-03-02']);
  assert.equal(await engine.processDate(new Date('2026-03-02T12:00:00'), f.E.C.id), undefined);
  assert.equal((await row(f, 'C', '2026-03-02')).status, 'absent');
  assert.equal(await closedPayrollSnap(), snap);
});

T('E2. POST /attendance/process {employeeId}: unchanged + additive skippedClosedPayroll', async () => {
  const f = await fx();
  const r = await call('POST', '/api/attendance/process', { date: '2026-03-03', employeeId: f.E.A.id });
  assert.equal(r.status, 200); assert.equal(r.body.skippedClosedPayroll.length, 1); assert.deepEqual(r.body.skippedClosedPayroll[0].days, ['2026-03-03']);
  await unchanged(f, ['A|2026-03-03']);
  const open = await call('POST', '/api/attendance/process', { date: '2026-03-03', employeeId: f.E.C.id });
  assert.equal(open.status, 200); assert.equal(open.body.skippedClosedPayroll, undefined, 'no field when nothing skipped');
});

T('E3. POST /attendance/process {date} (processToday path): reports closed skips, processes open employees', async () => {
  const f = await fx();
  const r = await call('POST', '/api/attendance/process', { date: '2026-03-04' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ids = r.body.skippedClosedPayroll.map((x) => x.employeeId).sort((a, b) => a - b);
  assert.deepEqual(ids, [f.E.A.id, f.E.B.id].sort((a, b) => a - b));
  await unchanged(f, ['A|2026-03-04', 'B|2026-03-04']);
  assert.equal((await row(f, 'C', '2026-03-04')).status, 'absent'); assert.equal((await row(f, 'D', '2026-03-04')).status, 'absent');
});

T('E4. POST /attendance/process-month: mixed batch — closed employee-months skipped whole, others processed', async () => {
  const f = await fx(); const snap = await closedPayrollSnap();
  const r = await call('POST', '/api/attendance/process-month', { year: 2026, month: 3 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.skippedClosedPayroll.map((x) => x.employeeId).sort((a, b) => a - b), [f.E.A.id, f.E.B.id].sort((a, b) => a - b));
  await unchanged(f, ['A|2026-03-02', 'A|2026-03-03', 'A|2026-03-04', 'B|2026-03-02']);
  for (const c of ['C', 'D', 'M']) assert.equal((await row(f, c, '2026-03-03')).status, 'absent', `${c} March open`);
  const feb = await call('POST', '/api/attendance/process-month', { year: 2026, month: 2 });
  assert.deepEqual(feb.body.skippedClosedPayroll.map((x) => x.employeeId), [f.E.M.id], 'M is closed for February only');
  await unchanged(f, ['M|2026-02-02', 'M|2026-02-03']);
  assert.equal((await row(f, 'A', '2026-02-02')).status, 'absent', 'A has no February payroll → processed normally');
  assert.equal(await closedPayrollSnap(), snap);
});

T('E5. recalcScope (rules / holidays / recalculate-full path): closed skipped & reported, payroll untouched', async () => {
  const f = await fx(); const snap = await closedPayrollSnap();
  const res = await recalc.recalcScope({ from: D('2026-03-01'), to: D('2026-03-31'), reason: 'test' });
  assert.deepEqual(res.skippedClosedPayroll.map((x) => x.employeeId).sort((a, b) => a - b), [f.E.A.id, f.E.B.id].sort((a, b) => a - b));
  await unchanged(f, ['A|2026-03-02', 'B|2026-03-04']);
  assert.equal((await row(f, 'C', '2026-03-02')).status, 'absent');
  assert.equal(await closedPayrollSnap(), snap);
});

T('E6. historical rebuild job: closed skipped, open rebuilt, job completes', async () => {
  const f = await fx(); const snap = await closedPayrollSnap();
  const r = await rebuild.startRebuild({ from: D('2026-03-01'), to: D('2026-03-31'), reason: 'test', triggeredBy: 'manual' });
  assert.equal(r.started, true);
  for (let i = 0; i < 120; i++) { const j = await admin.historicalRebuildJob.findUnique({ where: { id: r.jobId } }); if (j.status !== 'running') { assert.equal(j.status, 'completed', j.lastError || ''); break; } await new Promise((x) => setTimeout(x, 500)); }
  await unchanged(f, ['A|2026-03-02', 'A|2026-03-03', 'B|2026-03-04']);
  assert.equal((await row(f, 'C', '2026-03-03')).status, 'absent');
  assert.equal(await closedPayrollSnap(), snap);
});

T('E7. adjustment revert in a closed month: revert still happens (adjustment deleted, lock released, audit), stored evidence kept, skip reported', async () => {
  const f = await fx(); const snap = await closedPayrollSnap();
  const d = f.rows['A|2026-03-03'];
  const approvedAt = new Date();
  const adj = await admin.attendanceAdjustment.create({ data: { attendanceDailyId: d.id, employeeId: d.employeeId, date: d.date, approvalStatus: 'approved', approvedAt, adjCheckIn: '08:30' } });
  await admin.attendanceDaily.update({ where: { id: d.id }, data: { manualEdit: true, updatedAt: approvedAt } });
  const r = await call('POST', `/api/adjustments/${adj.id}/revert`, { revertedByName: 'tester' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await admin.attendanceAdjustment.count({ where: { id: adj.id } }), 0, 'adjustment deleted');
  const after = await row(f, 'A', '2026-03-03');
  assert.equal(after.manualEdit, false, 'lock released (revert behaviour unchanged)');
  assert.deepEqual(view(after), { ...PUNCHED, checkIn: '2026-03-03T05:00:00.000Z', checkOut: '2026-03-03T13:00:00.000Z' }, 'stored attendance NOT turned into absence');
  assert.equal(r.body.skippedClosedPayroll.length, 1);
  assert.equal(await admin.manualEditAuditLog.count({ where: { attendanceDailyId: d.id, source: 'adjustment-revert' } }), 1, 'revert audit written');
  assert.equal(await closedPayrollSnap(), snap);
});

T('E8. weekend/holiday branch: a punched Friday of a closed month is not turned into "weekend"; open employee is', async () => {
  const f = await fx();
  for (const c of ['A', 'C']) await admin.attendanceDaily.create({ data: { employeeId: f.E[c].id, date: D('2026-03-06'), status: 'present', checkIn: new Date('2026-03-06T06:00:00Z'), checkOut: new Date('2026-03-06T12:00:00Z'), workedMinutes: 360 } });
  const r = await engine.processDate(new Date('2026-03-06T12:00:00'), f.E.A.id);
  assert.equal(r.skipped, 'closed-evidence-loss');
  assert.equal((await row(f, 'A', '2026-03-06')).status, 'present');
  await engine.processDate(new Date('2026-03-06T12:00:00'), f.E.C.id);
  assert.equal((await row(f, 'C', '2026-03-06')).status, 'weekend');
});

T('E9. controls: stored row WITHOUT punches in a closed month is still recomputed; manual edit and Restore Auto behave as before (D2)', async () => {
  const f = await fx();
  await admin.attendanceDaily.update({ where: { id: f.rows['A|2026-03-04'].id }, data: { checkIn: null, checkOut: null, workedMinutes: 0 } });
  assert.equal(await engine.processDate(new Date('2026-03-04T12:00:00'), f.E.A.id), undefined);
  assert.equal((await row(f, 'A', '2026-03-04')).status, 'absent', 'no stored punches → not an evidence-loss case');
  // manual edit on a closed month: allowed, locks the row
  const id = f.rows['A|2026-03-02'].id;
  const m = await call('PUT', `/api/attendance/daily/${id}`, { checkIn: '09:00', checkOut: '15:00', reason: 'hr' });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal((await admin.attendanceDaily.findUnique({ where: { id } })).manualEdit, true);
  // Restore Auto: explicit HR action, not guarded (documented residual risk)
  const ra = await call('POST', `/api/attendance/daily/${id}/restore-auto`, { reason: 'x' });
  assert.equal(ra.status, 200, JSON.stringify(ra.body));
  const after = await admin.attendanceDaily.findUnique({ where: { id } });
  assert.equal(after.manualEdit, false); assert.equal(after.status, 'absent', 'Restore Auto recomputes from the (missing) raw logs — unchanged D2 behaviour');
});

// ═════ H1 follow-up: cleanup must not recompute protected rows ═════
for (const types of [{ daily: true }, { rawLogs: true }]) {
  T(`C1. cleanup ${JSON.stringify(types)}: protected rows without manualEdit keep their derived fields after the recalculation`, async () => {
    const f = await fx({ withRawLogs: true });
    await admin.payroll.deleteMany({ where: { status: { in: ['finalized', 'paid'] } } });   // cleanup of daily rows is (rightly) refused for closed payroll months; this test needs an open range
    // C: penalty-only protected row + absence-metadata row + approved-adjustment-only row, all with stored punches
    const pen = await row(f, 'C', '2026-03-02'); const abs = await row(f, 'C', '2026-03-03'); const adjRow = await row(f, 'C', '2026-03-04');
    await admin.attendanceDaily.update({ where: { id: pen.id }, data: { manualLatePenaltyUnits: 1, manualPenaltyReason: 'hr' } });
    await admin.attendanceDaily.update({ where: { id: abs.id }, data: { absenceReason: 'sick', absenceSetBy: 'hr' } });
    await admin.attendanceAdjustment.create({ data: { attendanceDailyId: adjRow.id, employeeId: adjRow.employeeId, date: adjRow.date, approvalStatus: 'pending' } });
    const keys = [['C', '2026-03-02'], ['C', '2026-03-03'], ['C', '2026-03-04']];
    const before = []; for (const [c, d] of keys) before.push(view(await row(f, c, d)));
    // an ordinary row of the same employee brings C into the recalculation scope
    await admin.attendanceDaily.create({ data: { employeeId: f.E.C.id, date: D('2026-03-05'), status: 'present', checkIn: new Date('2026-03-05T05:00:00Z'), checkOut: new Date('2026-03-05T13:00:00Z'), workedMinutes: 480 } });
    // raw logs of these protected days are gone (the state that used to flip them to absent)
    await admin.attendanceLog.deleteMany({ where: { employeeId: f.E.C.id, timestamp: { gte: new Date('2026-03-02T00:00:00Z'), lt: new Date('2026-03-05T00:00:00Z') } } });
    const r = await call('POST', '/api/cleanup/execute', { from: '2026-03-02', to: '2026-03-08', types, confirmText: 'حذف', executedByName: 'tester', backupFirst: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.recalcSkippedProtectedDays >= 3, `skip set used (${r.body.recalcSkippedProtectedDays})`);
    const after = []; for (const [c, d] of keys) after.push(view(await row(f, c, d)));
    assert.deepEqual(after, before, 'derived fields of protected rows unchanged by the cleanup recalculation');
  });
}

// ═════ UI helpers (frontend, pure ESM) ═════
test('U1. frontend helpers: 409 CLEANUP_DATA_CHANGED detection + Arabic messages', async () => {
  const E = await import(pathToFileURL(path.join(FRONTEND, 'lib', 'cleanupExecuteError.js')).href);
  const C = await import(pathToFileURL(path.join(FRONTEND, 'lib', 'closedMonthSkip.js')).href);
  assert.equal(E.isStalePreviewError({ response: { status: 409, data: { code: 'CLEANUP_DATA_CHANGED' } } }), true);
  assert.equal(E.isStalePreviewError({ response: { status: 409, data: { code: 'CLEANUP_PAYROLL_PROTECTED' } } }), false);
  assert.equal(E.isStalePreviewError({ response: { status: 500, data: { code: 'CLEANUP_DATA_CHANGED' } } }), false);
  assert.equal(E.isStalePreviewError(new Error('network')), false);
  assert.match(E.STALE_PREVIEW_MESSAGE, /معاينة جديدة/);
  assert.equal(C.closedSkipMessage([]), null); assert.equal(C.closedSkipMessage(undefined), null);
  const msg = C.closedSkipMessage([{ days: ['a', 'b', 'c'] }, { days: ['d'] }]);
  assert.match(msg, /4 يوم/); assert.match(msg, /2 موظف-شهر/); assert.match(msg, /لم يتغيّر أي مرتب/);
});
