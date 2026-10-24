/**
 * Data Cleanup — protected manual attendance data. REAL MySQL regression test (scratch database ONLY).
 *
 * It runs the real routes/cleanup.js (+ engines) from an ISOLATED COPY of the backend against a disposable MySQL database.
 * Nothing here touches the application database, reads an .env file, or contacts a device.
 *
 * Required environment (otherwise every test is SKIPPED — never run against anything else):
 *   SCRATCH_BACKEND_DIR   absolute path to a backend COPY (src, node_modules incl. generated Prisma client, prisma) with NO .env* files,
 *                         whose src/ is in sync with the repository src/ (checked by content hash for the files under test)
 *   SCRATCH_DATABASE_URL  mysql://user[:pw]@127.0.0.1:PORT/scratch_<name>      (database name must match scratch_[a-z0-9_]+)
 *   I_CONFIRM_THIS_IS_A_DISPOSABLE_SCRATCH_DATABASE   must equal that exact database name
 * The database must be EMPTY (core tables) at start; the test deletes only what it created.
 *
 * Run:  node --test tests/cleanup-protection/cleanup-protection.scratch.test.js
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
  const m = /^mysql:\/\/[^/@]*@(127\.0\.0\.1|localhost):\d+\/(scratch_[a-z0-9_]+)$/.exec(URL_);
  if (!m) return 'SCRATCH_DATABASE_URL must be mysql://…@127.0.0.1:PORT/scratch_<name>';
  if (CONFIRM !== m[2]) return 'confirmation does not equal the exact database name';
  if (!path.isAbsolute(DIR) || !fs.existsSync(path.join(DIR, 'src', 'routes', 'cleanup.js'))) return 'SCRATCH_BACKEND_DIR is not a backend copy';
  if (path.resolve(DIR) === path.resolve(REPO_SRC, '..') || path.resolve(DIR).startsWith(path.resolve(REPO_SRC, '..') + path.sep)) return 'SCRATCH_BACKEND_DIR must be a copy outside the repository backend';
  for (const d of [DIR, path.join(DIR, 'prisma')]) if (fs.readdirSync(d).some((n) => n === '.env' || n.startsWith('.env.'))) return 'the backend copy contains an env file';
  for (const rel of ['routes/cleanup.js', 'utils/cleanupProtection.js']) {
    const h = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    if (h(path.join(DIR, 'src', rel)) !== h(path.join(REPO_SRC, rel))) return `backend copy is stale: src/${rel} differs from the repository`;
  }
  return null;
}
const REFUSAL = refuse();
const T = (name, fn) => test(name, { skip: REFUSAL || false }, fn);
if (REFUSAL) console.log(`[cleanup-protection] SKIPPED: ${REFUSAL}`);

let prisma; let admin; let srv; let base; let cfgDir; let moment;
const D = (s) => new Date(`${s}T00:00:00.000Z`);
const FROM = '2026-03-02'; const TO = '2026-03-08';

test.before(async () => {
  if (REFUSAL) return;
  process.env.DATABASE_URL = URL_;
  delete process.env.AUTH_ENABLED;
  cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-prot-'));
  process.env.CONFIG_DIR = cfgDir;
  process.env.NODE_PATH = path.join(DIR, 'node_modules');
  require('module')._initPaths();
  const req = (p) => require(path.join(DIR, p));
  const express = req('node_modules/express');
  moment = req('node_modules/moment');
  const { PrismaClient } = req('node_modules/@prisma/client');
  admin = new PrismaClient({ datasources: { db: { url: URL_ } } });            // independent connection used for setup + race injection
  const db = (await admin.$queryRaw`SELECT DATABASE() AS d`)[0].d;
  assert.equal(db, CONFIRM, 'connected database is the confirmed scratch database');
  for (const t of ['employees', 'attendance_daily', 'attendance_logs', 'payrolls', 'branches', 'attendance_adjustments']) {
    const n = Number((await admin.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM ${t}`))[0].c);
    assert.equal(n, 0, `scratch table ${t} must be empty at start`);
  }
  prisma = req('src/utils/prisma.js').getPrisma();                               // the singleton cleanup.js captured
  const app = express(); app.use(express.json()); app.use('/api/cleanup', req('src/routes/cleanup.js'));
  srv = http.createServer(app).listen(0, '127.0.0.1'); await new Promise((r) => srv.on('listening', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(async () => {
  if (REFUSAL) return;
  try { await wipe(); } catch { /* best effort */ }
  await new Promise((r) => srv.close(r)); await admin.$disconnect(); await prisma.$disconnect();
  fs.rmSync(cfgDir, { recursive: true, force: true });
});

const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); let j; try { j = await r.json(); } catch { j = null; } return { status: r.status, body: j }; };
const preview = (types = { daily: true }, range = [FROM, TO]) => post('/api/cleanup/preview', { from: range[0], to: range[1], types });
const execute = (types = { daily: true }, extra = {}, range = [FROM, TO]) => post('/api/cleanup/execute', { from: range[0], to: range[1], types, confirmText: 'حذف', executedByName: 'scratch-test', backupFirst: false, ...extra });

async function wipe() {
  await admin.$executeRawUnsafe('DROP TABLE IF EXISTS t_cleanup_block');
  for (const t of ['adjustmentAuditLog', 'attendanceAdjustment', 'manualEditAuditLog', 'attendanceDaily', 'attendanceLog', 'payroll', 'cleanupLog', 'advance', 'employee', 'deviceSyncLog', 'device', 'department', 'shift', 'branch', 'company']) await admin[t].deleteMany({});
}

/** Fixture. Day = 2026-03-0N. Each protected kind sits on its own employee-day so it can be asserted in isolation. */
async function seed() {
  await wipe();
  const co = await admin.company.create({ data: { name: 'SynthCo' } });
  const br = await admin.branch.create({ data: { name: 'B', companyId: co.id } });
  const dp = await admin.department.create({ data: { name: 'D', branchId: br.id } });
  const sh = await admin.shift.create({ data: { name: 'S', startTime: '08:00', endTime: '16:00' } });
  const dv = await admin.device.create({ data: { name: 'Dev', ipAddress: '192.0.2.1', branchId: br.id, enabled: false, autoSync: false } });
  const emps = [];
  for (let i = 1; i <= 12; i++) emps.push(await admin.employee.create({ data: { name: `E${i}`, zkUserId: String(900 + i), code: `S${i}`, salary: 3000, branchId: br.id, departmentId: dp.id, shiftId: sh.id, hireDate: D('2026-01-01') } }));
  const row = async (e, day, extra = {}) => admin.attendanceDaily.create({ data: { employeeId: emps[e].id, date: D(`2026-03-0${day}`), status: 'present', checkIn: new Date(`2026-03-0${day}T05:00:00Z`), checkOut: new Date(`2026-03-0${day}T13:00:00Z`), workedMinutes: 480, ...extra } });
  const f = { emps, br, dv };
  // ordinary (deletable): 5 plain rows, plus one with only the engine-default absenceType (NOT protective)
  f.ordinary = [await row(0, 2), await row(0, 3), await row(1, 2), await row(1, 3), await row(2, 2)];
  f.absTypeOnly = await row(2, 3, { status: 'absent', isAbsent: true, absenceType: 'with_permission', checkIn: null, checkOut: null });
  // protected, one kind each
  f.manualEdit = await row(3, 2, { manualEdit: true });
  f.zeroUnits = await row(3, 3, { manualLatePenaltyUnits: 0 });                         // explicit manual 0 still counts
  f.earlyUnits = await row(3, 4, { manualEarlyPenaltyUnits: 1 });
  f.condUnits = await row(3, 5, { manualConditionUnits: 2 });
  f.otUnits = await row(3, 6, { manualOvertimeUnits: 1.5 });
  f.penReason = await row(4, 2, { manualPenaltyReason: 'hr', manualPenaltyAt: new Date() });
  f.penByName = await row(4, 3, { manualPenaltyByName: 'hr-user' });
  f.absReason = await row(5, 2, { status: 'absent', isAbsent: true, absenceType: 'with_permission', absenceReason: 'sick', checkIn: null, checkOut: null });
  f.absSetBy = await row(5, 3, { status: 'absent', isAbsent: true, absenceType: 'without_permission', absenceSetBy: 'hr-user', checkIn: null, checkOut: null });
  f.absSetAt = await row(5, 4, { status: 'absent', isAbsent: true, absenceType: 'without_permission', absenceSetAt: new Date(), checkIn: null, checkOut: null });
  const adj = (daily, status) => admin.attendanceAdjustment.create({ data: { attendanceDailyId: daily.id, employeeId: daily.employeeId, date: daily.date, approvalStatus: status, adjCheckIn: '08:00' } });
  f.adjPending = await row(6, 2); f.adjP = await adj(f.adjPending, 'pending');
  f.adjApproved = await row(6, 3); f.adjA = await adj(f.adjApproved, 'approved');
  f.adjRejected = await row(6, 4); f.adjR = await adj(f.adjRejected, 'rejected');
  // overlap: manualEdit + absence reason + adjustment on ONE row
  f.overlap = await row(7, 2, { manualEdit: true, absenceReason: 'x', status: 'absent', isAbsent: true, absenceType: 'with_permission', checkIn: null, checkOut: null });
  f.adjO = await adj(f.overlap, 'pending');
  for (const a of [f.adjP, f.adjA, f.adjO]) { await admin.adjustmentAuditLog.create({ data: { adjustmentId: a.id, action: 'create' } }); await admin.adjustmentAuditLog.create({ data: { adjustmentId: a.id, action: 'update' } }); }
  for (const r of [f.manualEdit, f.overlap, f.penReason]) await admin.manualEditAuditLog.create({ data: { employeeId: r.employeeId, attendanceDailyId: r.id, fieldName: 'checkIn', oldValue: 'a', newValue: 'b' } });
  // a few raw logs so the post-delete recalculation has something to rebuild from
  for (const e of [0, 1, 2]) for (const day of [2, 3]) {
    await admin.attendanceLog.create({ data: { employeeId: emps[e].id, deviceId: dv.id, zkUserId: emps[e].zkUserId, timestamp: new Date(`2026-03-0${day}T05:00:00Z`) } });
    await admin.attendanceLog.create({ data: { employeeId: emps[e].id, deviceId: dv.id, zkUserId: emps[e].zkUserId, timestamp: new Date(`2026-03-0${day}T13:00:00Z`) } });
  }
  f.protectedRows = [f.manualEdit, f.zeroUnits, f.earlyUnits, f.condUnits, f.otUnits, f.penReason, f.penByName, f.absReason, f.absSetBy, f.absSetAt, f.adjPending, f.adjApproved, f.adjRejected, f.overlap];
  f.protectedIds = f.protectedRows.map((r) => r.id).sort((a, b) => a - b);
  f.deletableIds = [...f.ordinary.map((r) => r.id), f.absTypeOnly.id].sort((a, b) => a - b);
  return f;
}
const counts = async () => ({
  daily: await admin.attendanceDaily.count(), adj: await admin.attendanceAdjustment.count(), adjAudit: await admin.adjustmentAuditLog.count(),
  manAudit: await admin.manualEditAuditLog.count(), raw: await admin.attendanceLog.count(), payroll: await admin.payroll.count(),
});
const protectedFieldsSnapshot = async (ids) => (await admin.attendanceDaily.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } }))
  .map((r) => ({ id: r.id, manualEdit: r.manualEdit, mL: r.manualLatePenaltyUnits, mE: r.manualEarlyPenaltyUnits, mC: r.manualConditionUnits, mO: r.manualOvertimeUnits,
    pr: r.manualPenaltyReason, pa: r.manualPenaltyAt && r.manualPenaltyAt.getTime(), pbn: r.manualPenaltyByName, ar: r.absenceReason, asb: r.absenceSetBy, asa: r.absenceSetAt && r.absenceSetAt.getTime() }));
const orphanManualAudits = async () => Number((await admin.$queryRaw`SELECT COUNT(*) c FROM manual_edit_audit_logs m LEFT JOIN attendance_daily d ON d.id = m.attendanceDailyId WHERE m.attendanceDailyId IS NOT NULL AND d.id IS NULL`)[0].c);
const existingIds = async (ids) => (await admin.attendanceDaily.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id).sort((a, b) => a - b);

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
T('S1. preview: deletable vs protected counts, no double counting, audit/adjustment counts', async () => {
  const f = await seed();
  const p = await preview();
  assert.equal(p.status, 200);
  assert.equal(p.body.counts.daily, f.deletableIds.length, 'counts.daily = exactly the deletable rows');
  assert.equal(p.body.counts.dailyProtected, f.protectedIds.length);
  const dp = p.body.dailyProtection;
  assert.equal(dp.protectedRows, f.protectedIds.length, 'unique protected rows');
  const primarySum = Object.values(dp.byPrimaryCategory).reduce((a, b) => a + b, 0);
  assert.equal(primarySum, dp.protectedRows, 'primary categories add up to the unique total (no double counting)');
  const overlapSum = Object.values(dp.overlappingCategories).reduce((a, b) => a + b, 0);
  assert.ok(overlapSum > dp.protectedRows, 'overlapping view is reported separately and exceeds the unique total (the overlap row)');
  assert.equal(dp.adjustments, 4, 'pending + approved + rejected + overlap adjustments');
  assert.equal(dp.adjustmentAuditLogs, 6);
  assert.equal(dp.manualEditAuditLogs, 3);
  assert.ok(p.body.warnings.some((w) => w.includes('محمي')), 'protection warning present');
  assert.equal(p.body.canExecute, true);
});

T('S2. SQL delete predicate and Prisma preview predicate select the same rows', async () => {
  const f = await seed();
  const prot = require(path.join(DIR, 'src/utils/cleanupProtection.js'));
  const viaPrisma = (await admin.attendanceDaily.findMany({ where: { date: { gte: D(FROM), lte: D(TO) }, ...prot.unprotectedDailyWhere() }, select: { id: true } })).map((r) => r.id).sort((a, b) => a - b);
  const viaSql = (await admin.$queryRawUnsafe(`SELECT d.id AS id FROM attendance_daily d LEFT JOIN attendance_adjustments a ON a.attendanceDailyId = d.id WHERE d.date >= ? AND d.date <= ? AND ${prot.unprotectedDailySqlCondition()}`, FROM, TO)).map((r) => Number(r.id)).sort((a, b) => a - b);
  assert.deepEqual(viaPrisma, f.deletableIds);
  assert.deepEqual(viaSql, f.deletableIds);
});

T('S3. execute: deletes only ordinary rows; every protected type survives untouched; counts equal the preview', async () => {
  const f = await seed();
  const before = await counts(); const snapBefore = await protectedFieldsSnapshot(f.protectedIds);
  const p = await preview();
  const ex = await execute({ daily: true });
  assert.equal(ex.status, 200, JSON.stringify(ex.body));
  assert.equal(ex.body.deleted.dailyDeleted, p.body.counts.daily, 'deleted == preview counts.daily');
  assert.deepEqual(ex.body.dailyProtection, p.body.dailyProtection, 'result protection summary == preview summary');
  assert.deepEqual(await existingIds(f.protectedIds), f.protectedIds, 'no protected row deleted (same ids still present)');
  assert.deepEqual(await protectedFieldsSnapshot(f.protectedIds), snapBefore, 'manual fields of protected rows unchanged (incl. explicit 0)');
  const after = await counts();
  assert.equal(after.adj, before.adj, 'adjustments preserved'); assert.equal(after.adjAudit, before.adjAudit, 'adjustment audit rows preserved');
  assert.equal(after.manAudit, before.manAudit, 'manual-edit audit rows preserved');
  assert.equal(await orphanManualAudits(), 0, 'no orphaned manual-edit audit references');
});

T('S4. engine-default absenceType alone is NOT protective (row is deleted)', async () => {
  const f = await seed();
  const p = await preview();
  assert.ok(f.deletableIds.includes(f.absTypeOnly.id));
  const ex = await execute({ daily: true });
  assert.equal(ex.status, 200);
  assert.equal(ex.body.deleted.dailyDeleted, p.body.counts.daily);
  assert.equal((await admin.attendanceDaily.findUnique({ where: { id: f.absTypeOnly.id } })), null, 'original row removed (a later recalculation may create a new one with a new id)');
});

T('S5. race: a row becomes PROTECTED between preview and delete → 409, full rollback, nothing deleted', async () => {
  const f = await seed();
  const before = await counts();
  const target = f.ordinary[0];
  const orig = prisma.payroll.findMany.bind(prisma.payroll); let fired = false;
  prisma.payroll.findMany = async (...a) => { const r = await orig(...a); if (!fired) { fired = true; await admin.attendanceDaily.update({ where: { id: target.id }, data: { manualPenaltyReason: 'raced', manualPenaltyAt: new Date() } }); } return r; };
  let ex; try { ex = await execute({ daily: true }); } finally { prisma.payroll.findMany = orig; }
  assert.equal(fired, true, 'race injected');
  assert.equal(ex.status, 409); assert.equal(ex.body.code, 'CLEANUP_DATA_CHANGED');
  assert.deepEqual(await counts(), before, 'nothing deleted anywhere (rolled back)');
  assert.ok((await admin.attendanceDaily.findUnique({ where: { id: target.id } })).manualPenaltyReason === 'raced', 'the raced manual data is intact');
  const log = await admin.cleanupLog.findFirst({ orderBy: { id: 'desc' } });
  assert.equal(log.status, 'failed'); assert.ok(log.notes.includes('409'));
});

T('S6. race: an adjustment is created / a new row appears between preview and delete → 409, rollback', async () => {
  for (const mode of ['adjustment', 'newRow']) {
    const f = await seed(); const before = await counts();
    const orig = prisma.payroll.findMany.bind(prisma.payroll); let fired = false;
    prisma.payroll.findMany = async (...a) => { const r = await orig(...a); if (!fired) { fired = true;
      if (mode === 'adjustment') { const d = f.ordinary[1]; await admin.attendanceAdjustment.create({ data: { attendanceDailyId: d.id, employeeId: d.employeeId, date: d.date } }); }
      else await admin.attendanceDaily.create({ data: { employeeId: f.emps[8].id, date: D('2026-03-05'), status: 'present' } }); } return r; };
    let ex; try { ex = await execute({ daily: true }); } finally { prisma.payroll.findMany = orig; }
    assert.equal(ex.status, 409, mode); assert.equal(ex.body.code, 'CLEANUP_DATA_CHANGED', mode);
    const after = await counts();
    assert.equal(after.daily, before.daily + (mode === 'newRow' ? 1 : 0), `${mode}: no row deleted`);
    assert.equal(after.adj, before.adj + (mode === 'adjustment' ? 1 : 0));
    assert.equal(after.adjAudit, before.adjAudit);
  }
});

T('S7. injected DB failure mid-delete rolls back everything; protected rows and audits intact; failed log written', async () => {
  const f = await seed(); const before = await counts(); const snap = await protectedFieldsSnapshot(f.protectedIds);
  // Scratch-only RESTRICT foreign key pointing at a deletable row of a LATER slice: the first slice deletes fine, the later delete fails.
  const late = f.ordinary.find((r) => r.date.getTime() === D('2026-03-03').getTime());
  await admin.$executeRawUnsafe('CREATE TABLE t_cleanup_block (id INT PRIMARY KEY, d INT NOT NULL, FOREIGN KEY (d) REFERENCES attendance_daily(id)) ENGINE=InnoDB');
  await admin.$executeRawUnsafe(`INSERT INTO t_cleanup_block VALUES (1, ${Number(late.id)})`);
  let ex; try { ex = await execute({ daily: true }); } finally { await admin.$executeRawUnsafe('DROP TABLE IF EXISTS t_cleanup_block'); }
  assert.equal(ex.status, 500); assert.ok(!JSON.stringify(ex.body).match(/SELECT|DELETE|constraint|attendance_daily/i), 'no SQL in the response');
  assert.deepEqual(await counts(), before, 'every table identical after rollback');
  assert.deepEqual(await protectedFieldsSnapshot(f.protectedIds), snap);
  assert.equal((await admin.cleanupLog.findFirst({ orderBy: { id: 'desc' } })).status, 'failed');
});

T('S8. finalized / paid payroll: daily & payroll cleanup refused (409), payroll rows byte-identical; protected data untouched', async () => {
  for (const status of ['finalized', 'paid']) {
    const f = await seed();
    const pr = await admin.payroll.create({ data: { employeeId: f.emps[9].id, month: 3, year: 2026, basicSalary: 3000, hourlyRate: 12.5, netSalary: 2900, status } });
    const snap = JSON.stringify(await admin.payroll.findUnique({ where: { id: pr.id } })); const before = await counts();
    for (const types of [{ daily: true }, { payroll: true }, { daily: true, rawLogs: true }]) {
      const ex = await execute(types, { confirmFinalizedPayroll: true });
      assert.equal(ex.status, 409, `${status} ${JSON.stringify(types)}`); assert.equal(ex.body.code, 'CLEANUP_PAYROLL_PROTECTED');
    }
    assert.equal(JSON.stringify(await admin.payroll.findUnique({ where: { id: pr.id } })), snap);
    assert.deepEqual(await counts(), before, 'no row anywhere changed');
    const pv = await preview({ daily: true });
    assert.equal(pv.body.blocked, true); assert.equal(pv.body.canExecute, false);
  }
});

T('S9. raw-log cleanup does not delete protected rows; manualEdit rows keep their times; manual fields persist (H2 overlap observation)', async () => {
  const f = await seed(); const snap = await protectedFieldsSnapshot(f.protectedIds);
  const me = await admin.attendanceDaily.findUnique({ where: { id: f.manualEdit.id } });
  const ex = await execute({ rawLogs: true });
  assert.equal(ex.status, 200, JSON.stringify(ex.body));
  assert.deepEqual(await existingIds(f.protectedIds), f.protectedIds, 'protected rows still exist with the same ids');
  assert.deepEqual(await protectedFieldsSnapshot(f.protectedIds), snap, 'manual fields unchanged by the post-delete recalculation');
  const me2 = await admin.attendanceDaily.findUnique({ where: { id: f.manualEdit.id } });
  assert.equal(String(me2.checkIn), String(me.checkIn)); assert.equal(String(me2.checkOut), String(me.checkOut));
  assert.equal((await counts()).adj, 4);
});

T('S10. no protected data at all: behaves like before (everything in range deleted, summary says 0 protected)', async () => {
  await seed();
  await admin.attendanceAdjustment.deleteMany({}); await admin.attendanceDaily.deleteMany({ where: { OR: [{ manualEdit: true }, { manualLatePenaltyUnits: { not: null } }, { manualEarlyPenaltyUnits: { not: null } }, { manualConditionUnits: { not: null } }, { manualOvertimeUnits: { not: null } }, { manualPenaltyReason: { not: null } }, { manualPenaltyAt: { not: null } }, { manualPenaltyByName: { not: null } }, { absenceReason: { not: null } }, { absenceSetBy: { not: null } }, { absenceSetAt: { not: null } }] } });
  const p = await preview(); assert.equal(p.body.dailyProtection.protectedRows, 0);
  const total = await admin.attendanceDaily.count();
  assert.equal(p.body.counts.daily, total);
  const ex = await execute({ daily: true });
  assert.equal(ex.status, 200); assert.equal(ex.body.deleted.dailyDeleted, total);
});
