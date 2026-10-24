/**
 * Payroll finalization + advances — REAL MySQL regression test (scratch database ONLY).
 *
 * Runs the real routes/advances.js + routes/payroll.js (+ engines) from an ISOLATED COPY of the backend against a disposable MySQL
 * database, with synthetic data. Nothing here touches the application database, reads an .env file, or contacts a device.
 * Same guards and environment as tests/cleanup-protection (every test is SKIPPED unless all of them hold):
 *   SCRATCH_BACKEND_DIR   absolute path to a backend COPY (src, node_modules incl. generated Prisma client, prisma), NO .env* files, src in sync with the repo
 *   SCRATCH_DATABASE_URL  mysql://user[:pw]@127.0.0.1:PORT/scratch_<name>
 *   I_CONFIRM_THIS_IS_A_DISPOSABLE_SCRATCH_DATABASE   must equal that exact database name
 * The database must be EMPTY (core tables) at start; the test wipes only the tables it uses.
 * Scope: advances scoped to employee+month+year (no carry-over), atomic create+audit, concurrent writers, idempotent "set total",
 * negative-total refusal, finalized/paid payroll immutability (rows byte-identical), no unintended writes on rejection.
 * Run:  node --test tests/payroll-advances/payroll-advances.scratch.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const DIR = process.env.SCRATCH_BACKEND_DIR;
const URL_ = process.env.SCRATCH_DATABASE_URL;
const CONFIRM = process.env.I_CONFIRM_THIS_IS_A_DISPOSABLE_SCRATCH_DATABASE;
const REPO_SRC = path.resolve(__dirname, '..', '..', 'src');

function refuse() {
  if (!DIR || !URL_ || !CONFIRM) return 'SCRATCH_BACKEND_DIR / SCRATCH_DATABASE_URL / confirmation not set';
  const m = /^mysql:\/\/[^/@]*@(127\.0\.0\.1|localhost):(\d+)\/(scratch_[a-z0-9_]+)$/.exec(URL_);
  if (!m) return 'SCRATCH_DATABASE_URL must be mysql://…@127.0.0.1:PORT/scratch_<name>';
  // 3306 is the default MySQL port, i.e. where an application database normally lives: never a scratch target.
  if (Number(m[2]) === 3306) return 'port 3306 is the default MySQL port and is refused as a scratch target — use a dedicated scratch port';
  if (CONFIRM !== m[3]) return 'confirmation does not equal the exact database name';
  if (!path.isAbsolute(DIR) || !fs.existsSync(path.join(DIR, 'src', 'routes', 'advances.js'))) return 'SCRATCH_BACKEND_DIR is not a backend copy';
  const repoBackend = path.resolve(REPO_SRC, '..');
  if (path.resolve(DIR) === repoBackend || path.resolve(DIR).startsWith(repoBackend + path.sep)) return 'SCRATCH_BACKEND_DIR must be a copy outside the repository backend';
  for (const d of [DIR, path.join(DIR, 'prisma')]) if (fs.readdirSync(d).some((n) => n === '.env' || n.startsWith('.env.'))) return 'the backend copy contains an env file';
  for (const rel of ['routes/advances.js', 'routes/payroll.js', 'engines/payrollEngine.js']) {
    const h = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    if (h(path.join(DIR, 'src', rel)) !== h(path.join(REPO_SRC, rel))) return `backend copy is stale: src/${rel} differs from the repository`;
  }
  return null;
}
const REFUSAL = refuse();
const T = (name, fn) => test(name, { skip: REFUSAL || false }, fn);
if (REFUSAL) console.log(`[payroll-advances] SKIPPED: ${REFUSAL}`);

let admin; let srv; let base; let cfgDir; let prismaApp; let engine;
// Set to true ONLY after every scratch-database check in before() has passed (connected database == the confirmed scratch name and all
// tables the suite touches are empty). after() wipes data only when this is true, so a failed check can never turn into a delete.
let verified = false;
const M = 3; const Y = 2026;

test.before(async () => {
  if (REFUSAL) return;
  process.env.DATABASE_URL = URL_;
  delete process.env.AUTH_ENABLED;
  cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payroll-adv-'));
  process.env.CONFIG_DIR = cfgDir;
  process.env.NODE_PATH = path.join(DIR, 'node_modules');
  require('module')._initPaths();
  const req = (p) => require(path.join(DIR, p));
  const express = req('node_modules/express');
  const { PrismaClient } = req('node_modules/@prisma/client');
  admin = new PrismaClient({ datasources: { db: { url: URL_ } } });
  const db = (await admin.$queryRaw`SELECT DATABASE() AS d`)[0].d;
  assert.equal(db, CONFIRM, 'connected database is the confirmed scratch database');
  for (const t of ['employees', 'attendance_daily', 'payrolls', 'advances']) {
    assert.equal(Number((await admin.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM ${t}`))[0].c), 0, `scratch table ${t} must be empty at start`);
  }
  verified = true;
  prismaApp = req('src/utils/prisma.js').getPrisma();
  engine = req('src/engines/payrollEngine.js');                                     // same module instance the mounted routes use (in-process lock map)
  const app = express(); app.use(express.json());
  app.use((rq, _rs, next) => { rq.io = { emit() {} }; next(); });
  app.use('/api/advances', req('src/routes/advances.js'));
  app.use('/api/payroll', req('src/routes/payroll.js'));
  srv = http.createServer(app).listen(0, '127.0.0.1'); await new Promise((r) => srv.on('listening', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(async () => {
  if (REFUSAL) return;
  if (verified) { try { await wipe(); } catch { /* best effort */ } }
  if (srv) await new Promise((r) => srv.close(r));
  if (admin) await admin.$disconnect();
  if (prismaApp) await prismaApp.$disconnect();
  if (cfgDir) fs.rmSync(cfgDir, { recursive: true, force: true });
});

const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, body: j };
};
async function wipe() {
  for (const t of ['manualEditAuditLog', 'attendanceDaily', 'attendanceLog', 'payroll', 'advance', 'employee', 'department', 'shift', 'branch']) await admin[t].deleteMany({});
  await admin.company.deleteMany({});
}
async function seed(n = 3) {
  await wipe();
  const co = await admin.company.create({ data: { name: 'SynthCo' } });
  const br = await admin.branch.create({ data: { name: 'B', companyId: co.id } });
  const dp = await admin.department.create({ data: { name: 'D', branchId: br.id } });
  const sh = await admin.shift.create({ data: { name: 'S', startTime: '08:00', endTime: '16:00' } });
  const emps = [];
  for (let i = 1; i <= n; i++) emps.push(await admin.employee.create({ data: { name: `E${i}`, zkUserId: String(800 + i), code: `P${i}`, salary: 3000, branchId: br.id, departmentId: dp.id, shiftId: sh.id, hireDate: new Date('2026-01-01T00:00:00.000Z') } }));
  return emps;
}
const advBody = (employeeId, amount, extra = {}) => ({ employeeId, amount, date: `${Y}-0${M}-10`, month: M, year: Y, reason: 'scratch', ...extra });
const advTotal = async (employeeId, month = M, year = Y) => (await admin.advance.findMany({ where: { employeeId, month, year } })).reduce((s, a) => s + a.amount, 0);
const advAudits = (employeeId) => admin.manualEditAuditLog.count({ where: { employeeId, fieldName: 'advance' } });
const payrollOf = (employeeId, month = M, year = Y) => admin.payroll.findFirst({ where: { employeeId, month, year } });
const ensurePayroll = async (employeeId) => { const r = await call('POST', '/api/payroll/calculate', { month: M, year: Y, employeeId }); assert.equal(r.status, 200, JSON.stringify(r.body)); return payrollOf(employeeId); };
const advSnapshot = async (employeeId) => JSON.stringify(await admin.advance.findMany({ where: { employeeId }, orderBy: { id: 'asc' } }));

T('A1. advance on an open month: 201, stored scoped to employee+month+year, audited, payroll advances == monthly total', async () => {
  const [e] = await seed(1);
  const p0 = await ensurePayroll(e.id);
  const r = await call('POST', '/api/advances', advBody(e.id, 250));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(await advTotal(e.id), 250);
  assert.equal(await advAudits(e.id), 1, 'exactly one audit row, written atomically with the advance');
  const p1 = await payrollOf(e.id);
  assert.equal(p1.id, p0.id); assert.equal(p1.advances, 250); assert.equal(p1.status, 'draft');
});

T('A2. no carry-over: an advance in March never appears in the April payroll', async () => {
  const [e] = await seed(1);
  await ensurePayroll(e.id);
  assert.equal((await call('POST', '/api/advances', advBody(e.id, 400))).status, 201);
  const r = await call('POST', '/api/payroll/calculate', { month: 4, year: Y, employeeId: e.id });
  assert.equal(r.status, 200);
  const apr = await payrollOf(e.id, 4);
  assert.equal(apr.advances, 0, 'April advances are April-only');
  assert.equal((await payrollOf(e.id)).advances, 400);
});

T('A3. invalid advances are refused with 400/404 and write nothing (negative, zero, NaN, 3 decimals, wrong period, bad employee)', async () => {
  const [e] = await seed(1);
  await ensurePayroll(e.id);
  const bad = [advBody(e.id, -5), advBody(e.id, 0), advBody(e.id, 'abc'), advBody(e.id, 10.123), advBody(e.id, 10, { date: '2026-04-10' }), advBody(e.id, 10, { month: 13 }), advBody(e.id, 10, { date: 'nope' }), advBody('x', 10)];
  for (const b of bad) { const r = await call('POST', '/api/advances', b); assert.equal(r.status, 400, `${JSON.stringify(b)} -> ${JSON.stringify(r.body)}`); }
  assert.equal((await call('POST', '/api/advances', advBody(999999, 10))).status, 404);
  assert.equal(await admin.advance.count(), 0); assert.equal(await advAudits(e.id), 0);
  assert.equal((await payrollOf(e.id)).advances, 0);
});

T('A4. concurrency: 10 simultaneous advance creates for one employee-month — none lost, total exact, one audit row each, payroll consistent', async () => {
  const [e] = await seed(1);
  await ensurePayroll(e.id);
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => call('POST', '/api/advances', advBody(e.id, 100 + i))));
  assert.deepEqual(rs.map((r) => r.status), Array(10).fill(201), JSON.stringify(rs.map((r) => r.body && r.body.error)));
  const expected = Array.from({ length: 10 }, (_, i) => 100 + i).reduce((a, b) => a + b, 0);
  assert.equal(await advTotal(e.id), expected);
  assert.equal(await admin.advance.count({ where: { employeeId: e.id, month: M, year: Y } }), 10, 'exactly one row per accepted request (nothing lost, nothing duplicated)');
  assert.equal(await advAudits(e.id), 10);
  assert.equal((await payrollOf(e.id)).advances, expected, 'stored payroll figure equals the committed monthly total');
});

T('A5. "set monthly total" is idempotent and serialised: same total twice adds no row; 6 concurrent totals end at exactly one requested value', async () => {
  const [e] = await seed(1);
  const p = await ensurePayroll(e.id);
  assert.equal((await call('PUT', `/api/payroll/${p.id}/advances`, { amount: 300 })).status, 200);
  const rows1 = await admin.advance.count({ where: { employeeId: e.id } });
  assert.equal((await call('PUT', `/api/payroll/${p.id}/advances`, { amount: 300 })).status, 200);
  assert.equal(await admin.advance.count({ where: { employeeId: e.id } }), rows1, 'same total twice → no extra row');
  const targets = [100, 200, 450, 500, 50, 275];
  const rs = await Promise.all(targets.map((amount) => call('PUT', `/api/payroll/${p.id}/advances`, { amount })));
  assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs.map((r) => r.body)));
  const total = await advTotal(e.id);
  assert.ok(targets.includes(total), `final total ${total} is one of the requested totals`);
  assert.equal((await payrollOf(e.id)).advances, total);
});

T('A6. negative-total protection: deleting the +row that would leave the month negative → 409, nothing changes', async () => {
  const [e] = await seed(1);
  const p = await ensurePayroll(e.id);
  assert.equal((await call('PUT', `/api/payroll/${p.id}/advances`, { amount: 1000 })).status, 200);
  assert.equal((await call('PUT', `/api/payroll/${p.id}/advances`, { amount: 400 })).status, 200);   // rows: +1000, -600
  const plus = await admin.advance.findFirst({ where: { employeeId: e.id, amount: 1000 } });
  const before = await advSnapshot(e.id); const auditsBefore = await advAudits(e.id);
  const r = await call('DELETE', `/api/advances/${plus.id}`, {});
  // Observed contract: 409 + the Arabic message ("…إجمالي سلف سالب…"). routes/advances.js sets err.code = 'ADVANCE_NEGATIVE_TOTAL', but
  // utils/apiError.js only forwards `code` for its own classifications, so the body carries { error } only (no consumer reads the code).
  assert.equal(r.status, 409, JSON.stringify(r.body)); assert.match(r.body.error, /سالب/);
  assert.equal(await advSnapshot(e.id), before); assert.equal(await advAudits(e.id), auditsBefore);
  assert.equal(await advTotal(e.id), 400);
});

T('A7. delete on an open month removes the row, audits it atomically and recalculates the payroll', async () => {
  const [e] = await seed(1);
  await ensurePayroll(e.id);
  const c = await call('POST', '/api/advances', advBody(e.id, 120)); assert.equal(c.status, 201);
  const d = await call('DELETE', `/api/advances/${c.body.id}`, { reason: 'scratch' }); assert.ok([200, 204].includes(d.status), JSON.stringify(d.body));
  assert.equal(await advTotal(e.id), 0); assert.equal(await advAudits(e.id), 2, 'create + delete audited');
  assert.equal((await payrollOf(e.id)).advances, 0);
});

for (const closed of ['finalized', 'paid']) {
  T(`F-${closed}. ${closed} payroll is immutable: advance create / set-total / delete / salary & manual edits / recalculate all refused, rows byte-identical, no audit rows`, async () => {
    const [e] = await seed(1);
    const p = await ensurePayroll(e.id);
    const a = await call('POST', '/api/advances', advBody(e.id, 200)); assert.equal(a.status, 201);
    assert.equal((await call('PUT', `/api/payroll/${p.id}`, { status: 'finalized' })).status, 200);
    if (closed === 'paid') assert.equal((await call('PUT', `/api/payroll/${p.id}`, { status: 'paid' })).status, 200);
    assert.equal((await payrollOf(e.id)).status, closed);
    const payrollBefore = JSON.stringify(await payrollOf(e.id)); const advBefore = await advSnapshot(e.id); const auditsBefore = await advAudits(e.id);
    const manualAuditsBefore = await admin.manualEditAuditLog.count();

    const attempts = {
      'POST advance': await call('POST', '/api/advances', advBody(e.id, 50)),
      'PUT set-total': await call('PUT', `/api/payroll/${p.id}/advances`, { amount: 999 }),
      'DELETE advance': await call('DELETE', `/api/advances/${a.body.id}`, {}),
      'PUT basicSalary': await call('PUT', `/api/payroll/${p.id}`, { basicSalary: 9999 }),
      'PUT manual deduction': await call('PUT', `/api/payroll/${p.id}`, { manualDeductionAdjustment: 77 }),
      'PUT notes': await call('PUT', `/api/payroll/${p.id}`, { notes: 'x' }),
    };
    for (const [k, r] of Object.entries(attempts)) assert.equal(r.status, 409, `${k}: ${r.status} ${JSON.stringify(r.body)}`);
    const recalc = await call('POST', '/api/payroll/calculate', { month: M, year: Y, employeeId: e.id });
    assert.equal(recalc.status, 200); assert.equal(recalc.body.protected, true, 'explicit recalculation is refused (reported as protected)');
    assert.equal(JSON.stringify(await payrollOf(e.id)), payrollBefore, 'payroll row byte-identical');
    assert.equal(await advSnapshot(e.id), advBefore, 'advances byte-identical');
    assert.equal(await advAudits(e.id), auditsBefore);
    assert.equal(await admin.manualEditAuditLog.count(), manualAuditsBefore, 'no audit rows written by rejected attempts');
    const emp = await admin.employee.findUnique({ where: { id: e.id } }); assert.equal(emp.salary, 3000, 'employee salary untouched by the rejected basicSalary edit');
  });
}

const openTransactions = async () => Number((await admin.$queryRaw`SELECT COUNT(*) AS c FROM information_schema.innodb_trx WHERE trx_mysql_thread_id <> CONNECTION_ID()`)[0].c);
const payrollRows = (employeeId) => admin.payroll.count({ where: { employeeId, month: M, year: Y } });
const snapshotOf = async (employeeId) => { const { updatedAt, ...rest } = (await payrollOf(employeeId)) || {}; return JSON.stringify(rest); };

T('C1. concurrent payroll calculations: 8 simultaneous single-employee runs + a monthly batch → all succeed, exactly ONE payroll row per employee-month, identical figures, no open transactions', async () => {
  const emps = await seed(3);
  const rs = await Promise.all([
    ...Array.from({ length: 8 }, () => call('POST', '/api/payroll/calculate', { month: M, year: Y, employeeId: emps[0].id })),
    call('POST', '/api/payroll/calculate', { month: M, year: Y }),
    call('POST', '/api/payroll/calculate', { month: M, year: Y, employeeId: emps[1].id }),
  ]);
  assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs.map((r) => r.status + ':' + (r.body && r.body.error))));
  for (const e of emps) assert.equal(await payrollRows(e.id), 1, `one payroll row for employee ${e.id} (unique employee+month+year)`);
  const nets = []; for (const e of emps) nets.push((await payrollOf(e.id)).netSalary);
  assert.equal(new Set(nets).size, 1, 'identical employees → identical net');
  assert.equal(await openTransactions(), 0, 'no transaction left open');
});

T('C2. calculations interleaved with advance writes converge: final stored advances == committed monthly total, one payroll row', async () => {
  const [e] = await seed(1);
  await ensurePayroll(e.id);
  const work = [];
  for (let i = 0; i < 6; i++) { work.push(call('POST', '/api/advances', advBody(e.id, 10 + i))); work.push(call('POST', '/api/payroll/calculate', { month: M, year: Y, employeeId: e.id })); }
  const rs = await Promise.all(work);
  assert.ok(rs.every((r) => [200, 201].includes(r.status)), JSON.stringify(rs.map((r) => r.status)));
  const total = await advTotal(e.id);
  assert.equal(total, [10, 11, 12, 13, 14, 15].reduce((a, b) => a + b, 0));
  assert.equal((await payrollOf(e.id)).advances, total);
  assert.equal(await payrollRows(e.id), 1);
  assert.equal(await openTransactions(), 0);
});

test('L1. lock acquisition timeout fails closed: while another operation holds the employee-month lock, a waiting write is REJECTED (409 after the acquire timeout), nothing is written, nothing runs later, and the lock is usable again afterwards', { skip: REFUSAL || false, timeout: 90000 }, async () => {
  const [e] = await seed(1);
  const p = await ensurePayroll(e.id);
  let release; const held = new Promise((r) => { release = r; });
  let acquired; const gotLock = new Promise((r) => { acquired = r; });
  const holder = engine.withPayrollKeyLock(e.id, M, Y, async () => { acquired(); await held; });        // the "other operation"
  await gotLock;
  const t0 = Date.now();
  let r;
  try { r = await call('PUT', `/api/payroll/${p.id}/advances`, { amount: 777 }); } finally { release(); await holder; }
  const waited = Date.now() - t0;
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.ok(waited >= 14000 && waited < 30000, `rejected after the bounded acquire timeout (${waited} ms), not immediately and not hanging`);
  await new Promise((s) => setTimeout(s, 500));                                                         // the rejected work must not run late
  assert.equal(await admin.advance.count({ where: { employeeId: e.id } }), 0, 'no advance written by the rejected request');
  assert.equal(await advAudits(e.id), 0, 'no audit row written by the rejected request');
  assert.equal((await payrollOf(e.id)).advances, 0);
  assert.equal(await openTransactions(), 0, 'no transaction left open by the rejected request');
  const ok = await call('PUT', `/api/payroll/${p.id}/advances`, { amount: 777 });                        // lock is free again: same request now succeeds
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await advTotal(e.id), 777);
});

T('D1. draft payroll follows salary changes made through the payroll edit: employee salary and the draft figures update, audited', async () => {
  const [e] = await seed(1);
  const p = await ensurePayroll(e.id);
  assert.equal((await payrollOf(e.id)).basicSalary, 3000);
  const r = await call('PUT', `/api/payroll/${p.id}`, { basicSalary: 4500 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await admin.employee.findUnique({ where: { id: e.id } })).salary, 4500);
  const after = await payrollOf(e.id);
  assert.equal(after.basicSalary, 4500); assert.equal(after.status, 'draft');
  assert.ok(await admin.manualEditAuditLog.count({ where: { employeeId: e.id } }) >= 1, 'salary edit audited');
});

T('D2. draft payroll follows a salary change made on the employee record on the next calculation', async () => {
  const [e] = await seed(1);
  await ensurePayroll(e.id);
  await admin.employee.update({ where: { id: e.id }, data: { salary: 3600 } });
  assert.equal((await call('POST', '/api/payroll/calculate', { month: M, year: Y, employeeId: e.id })).status, 200);
  assert.equal((await payrollOf(e.id)).basicSalary, 3600);
});

T('F-salary. finalized / paid rows ignore later salary changes: single and monthly recalculation leave them byte-identical (and report them), draft rows still follow', async () => {
  const emps = await seed(3);
  const ps = []; for (const e of emps) ps.push(await ensurePayroll(e.id));
  assert.equal((await call('PUT', `/api/payroll/${ps[0].id}`, { status: 'finalized' })).status, 200);
  assert.equal((await call('PUT', `/api/payroll/${ps[1].id}`, { status: 'finalized' })).status, 200);
  assert.equal((await call('PUT', `/api/payroll/${ps[1].id}`, { status: 'paid' })).status, 200);
  const snaps = [await snapshotOf(emps[0].id), await snapshotOf(emps[1].id)];
  for (const e of emps) await admin.employee.update({ where: { id: e.id }, data: { salary: 5000 } });
  const single0 = await call('POST', '/api/payroll/calculate', { month: M, year: Y, employeeId: emps[0].id });
  const single1 = await call('POST', '/api/payroll/calculate', { month: M, year: Y, employeeId: emps[1].id });
  assert.equal(single0.body.protected, true); assert.equal(single1.body.protected, true);
  const batch = await call('POST', '/api/payroll/calculate', { month: M, year: Y });
  assert.equal(batch.status, 200);
  assert.deepEqual(batch.body.protectedPayroll.map((x) => x.employeeId).sort(), [emps[0].id, emps[1].id].sort());
  assert.equal(await snapshotOf(emps[0].id), snaps[0], 'finalized row unchanged'); assert.equal(await snapshotOf(emps[1].id), snaps[1], 'paid row unchanged');
  assert.equal((await payrollOf(emps[0].id)).basicSalary, 3000); assert.equal((await payrollOf(emps[1].id)).basicSalary, 3000);
  assert.equal((await payrollOf(emps[2].id)).basicSalary, 5000, 'the draft employee follows the new salary');
});

T('F-steps. status machine: draft→paid skip refused; finalized→draft refused; repeat finalize changes nothing; finalized→paid is status-only', async () => {
  const [e] = await seed(1);
  const p = await ensurePayroll(e.id);
  assert.equal((await call('PUT', `/api/payroll/${p.id}`, { status: 'paid' })).status, 409, 'draft → paid skips a step');
  assert.equal((await call('PUT', `/api/payroll/${p.id}`, { status: 'bogus' })).status, 400);
  assert.equal((await call('PUT', `/api/payroll/${p.id}`, { status: 'finalized' })).status, 200);
  const fin = JSON.stringify(await payrollOf(e.id));
  assert.equal((await call('PUT', `/api/payroll/${p.id}`, { status: 'draft' })).status, 409, 'finalized → draft refused');
  assert.equal(JSON.stringify(await payrollOf(e.id)), fin);
  const again = await call('PUT', `/api/payroll/${p.id}`, { status: 'finalized' });
  assert.ok([200, 409].includes(again.status)); assert.equal(JSON.stringify(await payrollOf(e.id)), fin, 'repeat finalize changes nothing');
  assert.equal((await call('PUT', `/api/payroll/${p.id}`, { status: 'paid' })).status, 200);
  const paid = await payrollOf(e.id); const finObj = JSON.parse(fin);
  for (const k of ['basicSalary', 'deductions', 'advances', 'netSalary', 'overtimeAmount', 'manualDeductionAdjustment']) assert.equal(paid[k], finObj[k], `${k} unchanged by finalized→paid`);
});

T('F-batch. monthly recalculation skips closed employees and still computes open ones (reported, not silent)', async () => {
  const emps = await seed(3);
  const ps = []; for (const e of emps) ps.push(await ensurePayroll(e.id));
  assert.equal((await call('PUT', `/api/payroll/${ps[0].id}`, { status: 'finalized' })).status, 200);
  const closedBefore = JSON.stringify(await payrollOf(emps[0].id));
  assert.equal((await call('POST', '/api/advances', advBody(emps[1].id, 90))).status, 201);
  const r = await call('POST', '/api/payroll/calculate', { month: M, year: Y });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.protectedPayroll.some((x) => x.employeeId === emps[0].id), 'finalized employee reported as protected');
  assert.equal(JSON.stringify(await payrollOf(emps[0].id)), closedBefore, 'finalized row untouched by the batch');
  assert.equal((await payrollOf(emps[1].id)).advances, 90, 'open employee recalculated');
});
