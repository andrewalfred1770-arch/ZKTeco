/**
 * skipdays-scenario.js — child-process scenario proving whether cleanup's `skipDays` protection is NECESSARY.
 * Run against ONE backend variant (fixed, or a test-only copy with skipDays disabled) and ONE scratch database:
 *   node skipdays-scenario.js <absolute backend dir> <daily|rawLogs>
 * Same scratch guards as h2-scenario.js. Prints one line:  @@RESULT@@{before, after}
 *
 * Fixture (synthetic): employee C with three PROTECTED rows that carry stored punches but are NOT manualEdit-locked
 * (manual-penalty-only, absence-metadata-only, pending-adjustment-only) plus one ordinary row (puts C into the recalculation scope).
 * The raw logs behind the protected days are gone. Then the REAL cleanup route runs for `daily` or `rawLogs`.
 */
const path = require('path'); const http = require('http'); const os = require('os'); const fs = require('fs');
const DIR = process.argv[2]; const MODE = process.argv[3];
const URL_ = process.env.SCRATCH_DATABASE_URL; const CONFIRM = process.env.I_CONFIRM_THIS_IS_A_DISPOSABLE_SCRATCH_DATABASE;
const m = /^mysql:\/\/[^/@]*@(127\.0\.0\.1|localhost):\d+\/(scratch_[a-z0-9_]+)$/.exec(URL_ || '');
if (!DIR || !['daily', 'rawLogs'].includes(MODE) || !m || CONFIRM !== m[2]) { console.error('refused: scratch guards not satisfied'); process.exit(3); }
process.env.DATABASE_URL = URL_; process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'skipd-')); delete process.env.AUTH_ENABLED;
process.env.NODE_PATH = path.join(DIR, 'node_modules'); require('module')._initPaths();
const req = (p) => require(path.join(DIR, p));
const express = req('node_modules/express'); const { PrismaClient } = req('node_modules/@prisma/client');
const admin = new PrismaClient({ datasources: { db: { url: URL_ } } });
const D = (s) => new Date(`${s}T00:00:00.000Z`);
async function wipe() { for (const t of ['adjustmentAuditLog', 'attendanceAdjustment', 'manualEditAuditLog', 'attendanceDaily', 'attendanceLog', 'payroll', 'cleanupLog', 'employee', 'device', 'shift', 'branch', 'company']) await admin[t].deleteMany({}); }
(async () => {
  if ((await admin.$queryRaw`SELECT DATABASE() AS d`)[0].d !== CONFIRM) throw new Error('not the confirmed scratch database');
  await wipe();
  const co = await admin.company.create({ data: { name: 'C' } }); const br = await admin.branch.create({ data: { name: 'B', companyId: co.id } });
  const sh = await admin.shift.create({ data: { name: 'S', startTime: '08:00', endTime: '16:00' } });
  const dv = await admin.device.create({ data: { name: 'V', ipAddress: '192.0.2.1', branchId: br.id, enabled: false, autoSync: false } });
  const e = await admin.employee.create({ data: { name: 'C', code: 'C', zkUserId: '901', salary: 3000, branchId: br.id, shiftId: sh.id, hireDate: D('2026-01-01') } });
  const mk = (d, x = {}) => admin.attendanceDaily.create({ data: { employeeId: e.id, date: D(d), status: 'present', checkIn: new Date(`${d}T05:00:00Z`), checkOut: new Date(`${d}T13:00:00Z`), workedMinutes: 480, ...x } });
  const pen = await mk('2026-04-06', { manualLatePenaltyUnits: 1, manualPenaltyReason: 'hr' });
  const abs = await mk('2026-04-07', { absenceReason: 'sick', absenceSetBy: 'hr' });
  const adj = await mk('2026-04-08');
  await admin.attendanceAdjustment.create({ data: { attendanceDailyId: adj.id, employeeId: e.id, date: adj.date, approvalStatus: 'pending' } });
  await mk('2026-04-09');                       // ordinary row → C is in the recalculation scope
  // raw logs exist ONLY for the ordinary day; the protected days' raw logs are gone
  for (const t of ['05:00:00', '13:00:00']) await admin.attendanceLog.create({ data: { employeeId: e.id, deviceId: dv.id, zkUserId: e.zkUserId, timestamp: new Date(`2026-04-09T${t}Z`) } });
  const ids = [pen.id, abs.id, adj.id];
  const snap = async () => (await admin.attendanceDaily.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } })).map((r) => ({ id: r.id, status: r.status, isAbsent: r.isAbsent, checkIn: r.checkIn && r.checkIn.toISOString(), checkOut: r.checkOut && r.checkOut.toISOString(), workedMinutes: r.workedMinutes, manualLate: r.manualLatePenaltyUnits, reason: r.absenceReason }));
  const before = await snap();
  const app = express(); app.use(express.json()); app.use('/api/cleanup', req('src/routes/cleanup.js'));
  const srv = http.createServer(app).listen(0, '127.0.0.1'); await new Promise((r) => srv.on('listening', r));
  const types = MODE === 'daily' ? { daily: true } : { rawLogs: true };
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/cleanup/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: '2026-04-06', to: '2026-04-12', types, confirmText: 'حذف', executedByName: 'scn', backupFirst: false }) });
  const body = await r.json(); srv.close();
  const after = await snap();
  console.log('@@RESULT@@' + JSON.stringify({ status: r.status, error: r.status === 200 ? null : body.error, before, after, skippedProtectedDays: body.recalcSkippedProtectedDays ?? null }));
  await wipe(); await admin.$disconnect(); process.exit(0);
})().catch((e) => { console.error('SCENARIO ERROR', e); process.exit(1); });
