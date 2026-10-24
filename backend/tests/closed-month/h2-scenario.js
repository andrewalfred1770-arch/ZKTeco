/**
 * h2-scenario.js — the H2 reproduction, run in a CHILD process against ONE backend variant (original or fixed) and ONE scratch database.
 * Driven by closed-month.scratch.test.js, which owns all safety guards (scratch URL regex, exact confirmation, env-free backend copy).
 * This script refuses to run unless the same guard variables are present. It prints one line:  @@RESULT@@<json>
 *
 *   node h2-scenario.js <absolute backend dir>        env: SCRATCH_DATABASE_URL, I_CONFIRM_THIS_IS_A_DISPOSABLE_SCRATCH_DATABASE
 *
 * Sequence (all synthetic): daily rows with punches + raw logs for Feb/Mar 2026 → payrolls (finalized / paid / draft / none) →
 * REAL cleanup route "rawLogs" for Feb..Mar → processMonth(Mar) and processMonth(Feb) → late-punch control → result snapshot.
 */
const path = require('path');
const http = require('http');
const os = require('os');
const fs = require('fs');

const DIR = process.argv[2];
const URL_ = process.env.SCRATCH_DATABASE_URL;
const CONFIRM = process.env.I_CONFIRM_THIS_IS_A_DISPOSABLE_SCRATCH_DATABASE;
const m = /^mysql:\/\/[^/@]*@(127\.0\.0\.1|localhost):\d+\/(scratch_[a-z0-9_]+)$/.exec(URL_ || '');
if (!DIR || !m || CONFIRM !== m[2]) { console.error('refused: scratch guards not satisfied'); process.exit(3); }
process.env.DATABASE_URL = URL_;
process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-scn-'));
delete process.env.AUTH_ENABLED;
process.env.NODE_PATH = path.join(DIR, 'node_modules');
require('module')._initPaths();
const req = (p) => require(path.join(DIR, p));
const express = req('node_modules/express');
const { PrismaClient } = req('node_modules/@prisma/client');
const admin = new PrismaClient({ datasources: { db: { url: URL_ } } });
const engine = req('src/engines/attendanceEngine.js');
const D = (s) => new Date(`${s}T00:00:00.000Z`);
const ISO = (d) => (d ? d.toISOString() : null);

async function wipe() {
  for (const t of ['adjustmentAuditLog', 'attendanceAdjustment', 'manualEditAuditLog', 'attendanceDaily', 'attendanceLog', 'payroll', 'cleanupLog', 'advance', 'employee', 'deviceSyncLog', 'device', 'department', 'shift', 'branch', 'company']) await admin[t].deleteMany({});
}

(async () => {
  const db = (await admin.$queryRaw`SELECT DATABASE() AS d`)[0].d;
  if (db !== CONFIRM) throw new Error('connected database is not the confirmed scratch database');
  await wipe();
  const co = await admin.company.create({ data: { name: 'C' } });
  const br = await admin.branch.create({ data: { name: 'B', companyId: co.id } });
  const sh = await admin.shift.create({ data: { name: 'S', startTime: '08:00', endTime: '16:00' } });
  const dv = await admin.device.create({ data: { name: 'Dev', ipAddress: '192.0.2.1', branchId: br.id, enabled: false, autoSync: false } });
  const mk = async (code, i) => admin.employee.create({ data: { name: code, code, zkUserId: String(700 + i), salary: 3000, branchId: br.id, shiftId: sh.id, hireDate: D('2026-01-01') } });
  const E = { A: await mk('A', 1), B: await mk('B', 2), C: await mk('C', 3), D: await mk('D', 4), M: await mk('M', 5) };
  const days = ['2026-02-02', '2026-02-03', '2026-02-04', '2026-03-02', '2026-03-03', '2026-03-04'];   // Mon-Wed
  for (const e of Object.values(E)) for (const d of days) {
    await admin.attendanceDaily.create({ data: { employeeId: e.id, date: D(d), status: 'present', checkIn: new Date(`${d}T05:00:00Z`), checkOut: new Date(`${d}T13:00:00Z`), workedMinutes: 480 } });
    for (const t of ['05:00:00', '13:00:00']) await admin.attendanceLog.create({ data: { employeeId: e.id, deviceId: dv.id, zkUserId: e.zkUserId, timestamp: new Date(`${d}T${t}Z`) } });
  }
  // A: a stored ABSENT day (no punches) that a late punch will legitimately turn into presence
  await admin.attendanceDaily.create({ data: { employeeId: E.A.id, date: D('2026-03-05'), status: 'absent', isAbsent: true, absenceType: 'with_permission' } });
  const pay = (e, month, status) => admin.payroll.create({ data: { employeeId: e.id, month, year: 2026, basicSalary: 3000, hourlyRate: 12.5, workDays: 3, absentDays: 0, netSalary: 3000, status } });
  await pay(E.A, 3, 'finalized'); await pay(E.B, 3, 'paid'); await pay(E.C, 3, 'draft'); await pay(E.M, 2, 'finalized');
  const payrollSnap = async () => JSON.stringify((await admin.payroll.findMany({ where: { status: { in: ['finalized', 'paid'] } }, orderBy: { id: 'asc' } })).map(({ updatedAt, ...r }) => r));
  const rowsSnap = async () => {
    const rows = await admin.attendanceDaily.findMany({ include: { employee: { select: { code: true } } }, orderBy: [{ employeeId: 'asc' }, { date: 'asc' }] });
    return Object.fromEntries(rows.map((r) => [`${r.employee.code}|${r.date.toISOString().slice(0, 10)}`, { status: r.status, isAbsent: r.isAbsent, checkIn: ISO(r.checkIn), checkOut: ISO(r.checkOut), workedMinutes: r.workedMinutes }]));
  };
  const payBefore = await payrollSnap(); const rowsBefore = await rowsSnap();

  // REAL cleanup route: purge ALL raw logs of Feb..Mar (allowed for closed months by design)
  const app = express(); app.use(express.json()); app.use('/api/cleanup', req('src/routes/cleanup.js'));
  const srv = http.createServer(app).listen(0, '127.0.0.1'); await new Promise((r) => srv.on('listening', r));
  const cl = await fetch(`http://127.0.0.1:${srv.address().port}/api/cleanup/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: '2026-02-01', to: '2026-03-31', types: { rawLogs: true }, confirmText: 'حذف', executedByName: 'scenario', backupFirst: false }) });
  const cleanupStatus = cl.status; srv.close();
  const rowsAfterCleanup = await rowsSnap();

  const t0 = Date.now();
  const resMar = await engine.processMonth(2026, 3, null);
  const resFeb = await engine.processMonth(2026, 2, null);
  const monthMs = Date.now() - t0;
  const rowsAfterProcess = await rowsSnap();

  // control: a legitimate LATE punch for A on the stored-absent day of the closed month
  await admin.attendanceLog.create({ data: { employeeId: E.A.id, deviceId: dv.id, zkUserId: E.A.zkUserId, timestamp: new Date('2026-03-05T05:00:00Z') } });
  await admin.attendanceLog.create({ data: { employeeId: E.A.id, deviceId: dv.id, zkUserId: E.A.zkUserId, timestamp: new Date('2026-03-05T13:00:00Z') } });
  await engine.processDate(new Date('2026-03-05T12:00:00'), E.A.id);
  const rowsAfterLate = await rowsSnap();

  console.log('@@RESULT@@' + JSON.stringify({
    cleanupStatus, payrollUnchanged: payBefore === await payrollSnap(),
    rowsBefore, rowsAfterCleanup, rowsAfterProcess, rowsAfterLate,
    processMonth: { mar: resMar, feb: resFeb }, processMonthMs: monthMs,
  }));
  await wipe(); await admin.$disconnect(); process.exit(0);
})().catch((e) => { console.error('SCENARIO ERROR', e); process.exit(1); });
