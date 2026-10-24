/**
 * h3-scenario.js — H3 reproduction against the REAL routes, in a CHILD process, for ONE backend variant and ONE scratch database.
 *   node h3-scenario.js <absolute backend dir> <op> <lockWaitSeconds> [pool]
 * Safety: refuses to run unless SCRATCH_DATABASE_URL is mysql://…@127.0.0.1:PORT/scratch_<name> and the exact confirmation matches (same guards as
 * the other scratch tests). It sets the scratch server's GLOBAL innodb_lock_wait_timeout (scratch instance only), holds a row lock from a separate
 * connection longer than that wait, fires ONE request that has to take the same lock, then probes the application (auth check + reads) and retries.
 * Prints one line:  @@RESULT@@<json>
 *   op ∈ payrollPut | payrollAdvance | advancePost | advanceDelete | manualEdit | manualPenalty | absenceType | bulkMark | bulkApprove
 */
const path = require('path'); const http = require('http'); const os = require('os'); const fs = require('fs');
const DIR = process.argv[2]; const OP = process.argv[3]; const LW = Number(process.argv[4]);
const URL_ = process.env.SCRATCH_DATABASE_URL; const CONFIRM = process.env.I_CONFIRM_THIS_IS_A_DISPOSABLE_SCRATCH_DATABASE;
const m = /^mysql:\/\/[^/@]*@(127\.0\.0\.1|localhost):\d+\/(scratch_[a-z0-9_]+)$/.exec(URL_ || '');
if (!DIR || !OP || !Number.isFinite(LW) || !m || CONFIRM !== m[2]) { console.error('refused: scratch guards not satisfied'); process.exit(3); }
process.env.DATABASE_URL = URL_ + '?connection_limit=3&pool_timeout=20';
process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-scn-'));
process.env.AUTH_ENABLED = 'true'; process.env.JWT_SECRET = 'scratch-h3-secret-not-a-real-secret';
process.env.NODE_PATH = path.join(DIR, 'node_modules'); require('module')._initPaths();
const req = (p) => require(path.join(DIR, p));
const express = req('node_modules/express'); const jwt = req('node_modules/jsonwebtoken');
const { PrismaClient } = req('node_modules/@prisma/client');
const admin = new PrismaClient({ datasources: { db: { url: URL_ } } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const D = (s) => new Date(`${s}T00:00:00.000Z`);

async function wipe() { for (const t of ['adjustmentAuditLog', 'attendanceAdjustment', 'manualEditAuditLog', 'attendanceDaily', 'attendanceLog', 'payroll', 'advance', 'cleanupLog', 'employee', 'device', 'shift', 'branch', 'company', 'user']) await admin[t].deleteMany({}); }

(async () => {
  if ((await admin.$queryRaw`SELECT DATABASE() AS d`)[0].d !== CONFIRM) throw new Error('not the confirmed scratch database');
  await admin.$executeRawUnsafe(`SET GLOBAL innodb_lock_wait_timeout = ${Math.trunc(LW)}`);     // scratch server only; new sessions pick it up
  await wipe();
  const co = await admin.company.create({ data: { name: 'C' } }); const br = await admin.branch.create({ data: { name: 'B', companyId: co.id } });
  const sh = await admin.shift.create({ data: { name: 'S', startTime: '08:00', endTime: '16:00' } });
  const user = await admin.user.create({ data: { username: 'h3admin', name: 'h3admin', password: 'x', role: 'admin', active: true } });
  const mkEmp = (c, i) => admin.employee.create({ data: { name: c, code: c, zkUserId: String(600 + i), salary: 3000, branchId: br.id, shiftId: sh.id, hireDate: D('2026-01-01') } });
  const T = await mkEmp('TARGET', 1); const C = await mkEmp('CONTROL', 2);
  const day = {}, pay = {};
  for (const [k, e] of [['T', T], ['C', C]]) {
    day[k] = await admin.attendanceDaily.create({ data: { employeeId: e.id, date: D('2026-03-03'), status: 'present', checkIn: new Date('2026-03-03T05:00:00Z'), checkOut: new Date('2026-03-03T13:00:00Z'), workedMinutes: 480 } });
    pay[k] = await admin.payroll.create({ data: { employeeId: e.id, month: 3, year: 2026, basicSalary: 3000, hourlyRate: 12.5, workDays: 1, netSalary: 3000, status: 'draft' } });
  }
  // extra synthetic rows for the delete / absence / bulk operations (same for the target and the never-locked control employee)
  const adv = {}, adj = {};
  for (const [k, e] of [['T', T], ['C', C]]) {
    adv[k] = await admin.advance.create({ data: { employeeId: e.id, amount: 50, date: D('2026-03-10'), month: 3, year: 2026, reason: 'h3' } });
    adj[k] = await admin.attendanceAdjustment.create({ data: { attendanceDailyId: day[k].id, employeeId: e.id, date: D('2026-03-03'), approvalStatus: 'pending', adjCheckIn: '08:00' } });
  }
  if (OP === 'absenceType' || OP === 'bulkMark') for (const k of ['T', 'C']) await admin.attendanceDaily.update({ where: { id: day[k].id }, data: { status: 'absent', isAbsent: true, checkIn: null, checkOut: null, workedMinutes: 0, absenceType: 'with_permission' } });
  const app = express(); app.use(express.json());
  app.use('/api/auth', req('src/routes/auth.js')); app.use('/api/payroll', req('src/routes/payroll.js'));
  app.use('/api/attendance', req('src/routes/attendance/index.js')); app.use('/api/advances', req('src/routes/advances.js')); app.use('/api/adjustments', req('src/routes/adjustments.js'));
  const srv = http.createServer(app).listen(0, '127.0.0.1'); await new Promise((r) => srv.on('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const token = jwt.sign({ id: user.id, username: 'h3admin', name: 'h3admin', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const call = async (method, p, body) => { const t = Date.now(); try { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) }); let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j, ms: Date.now() - t }; } catch (e) { return { status: 0, body: String(e.message), ms: Date.now() - t }; } };

  const OPS = {
    payrollPut: (k) => ['PUT', `/api/payroll/${pay[k].id}`, { manualDeductionAdjustment: 7, notes: 'h3' }],
    payrollAdvance: (k) => ['PUT', `/api/payroll/${pay[k].id}/advances`, { amount: 100, reason: 'h3' }],
    advancePost: (k) => ['POST', '/api/advances', { employeeId: (k === 'T' ? T : C).id, amount: 50, date: '2026-03-10', month: 3, year: 2026, reason: 'h3' }],
    manualEdit: (k) => ['PUT', `/api/attendance/daily/${day[k].id}`, { checkIn: '08:30', reason: 'h3' }],
    advanceDelete: (k) => ['DELETE', `/api/advances/${adv[k].id}`],
    absenceType: (k) => ['PUT', `/api/attendance/${day[k].id}/absence-type`, { absenceType: 'without_permission', absenceReason: 'h3' }],
    bulkMark: (k) => ['POST', '/api/attendance/bulk-mark-unauthorized', { ids: [day[k].id], absenceReason: 'h3' }],
    bulkApprove: (k) => ['POST', '/api/adjustments/bulk-approve', { ids: [adj[k].id] }],
    manualPenalty: (k) => ['PUT', `/api/attendance/${day[k].id}/manual-penalty`, { manualLatePenaltyUnits: 1, reason: 'h3' }],
  };
  const lockTarget = (OP.startsWith('manual') || OP === 'absenceType' || OP === 'bulkMark' || OP === 'bulkApprove') ? `SELECT id FROM attendance_daily WHERE id = ${Number(day.T.id)} FOR UPDATE` : `SELECT id FROM payrolls WHERE id = ${Number(pay.T.id)} FOR UPDATE`;
  const snap = async (k, e) => ({
    audit: (await admin.manualEditAuditLog.count({ where: { employeeId: e.id } })) + (await admin.adjustmentAuditLog.count({ where: { adjustment: { employeeId: e.id } } })),
    adjustments: (await admin.attendanceAdjustment.findMany({ where: { employeeId: e.id }, orderBy: { id: 'asc' }, select: { approvalStatus: true } })).map((a) => a.approvalStatus).join(','), advances: await admin.advance.count({ where: { employeeId: e.id } }),
    payroll: JSON.stringify((({ updatedAt, ...r }) => r)(await admin.payroll.findUnique({ where: { id: pay[k].id } }))),
    daily: JSON.stringify((({ updatedAt, ...r }) => r)(await admin.attendanceDaily.findUnique({ where: { id: day[k].id } }))),
  });
  const before = await snap('T', T); const ctlBefore = await snap('C', C);
  const appPrisma = req('src/utils/prisma.js').getPrisma();

  // hold the lock from a SEPARATE connection for longer than the lock wait
  const holdMs = LW * 1000 + 5000;
  const holder = admin.$transaction(async (tx) => { await tx.$queryRawUnsafe(lockTarget); await sleep(holdMs); }, { timeout: holdMs + 30000 });
  await sleep(700);
  const [meth, p, body] = OPS[OP]('T');
  const op1 = await call(meth, p, body);

  // is the application still healthy right after the failed operation?
  const probe = []; const check = async (name, fn, ok) => { const r = await fn(); probe.push({ name, status: r.status, ok: r.status === 200 && ok(r.body), err: r.status === 200 ? undefined : JSON.stringify(r.body).slice(0, 90) }); };
  const probes = [
    () => check('auth /me', () => call('GET', '/api/auth/me'), (b) => b && b.user && b.user.role === 'admin'),
    () => check('payroll list', () => call('GET', '/api/payroll?month=3&year=2026'), (b) => Array.isArray(b) && b.some((r) => r.employeeId === T.id && r.basicSalary === 3000)),
    () => check('daily list', () => call('GET', '/api/attendance/daily?date=2026-03-03'), (b) => { const rows = Array.isArray(b) ? b : (b && (b.rows || b.data)); return Array.isArray(rows) ? rows.length === 2 : true; }),
  ];
  for (let i = 0; i < 4; i++) for (const f of probes) await f();
  await Promise.all(Array.from({ length: 4 }, () => Promise.all(probes.map((f) => f()))));
  const sessionValues = []; for (let i = 0; i < 8; i++) sessionValues.push(Number((await appPrisma.$queryRaw`SELECT @@session.innodb_lock_wait_timeout AS v`)[0].v));
  const afterFail = await snap('T', T);

  await holder.catch(() => {});
  const lockedRowUntouched = (await snap('T', T)).payroll === before.payroll && (await snap('T', T)).daily === before.daily;
  const retry = await call(...OPS[OP]('T'));                          // lock is free now: must succeed exactly once
  const afterRetry = await snap('T', T);
  const ctl = await call(...OPS[OP]('C')); const ctlAfter = await snap('C', C);     // reference run on an identical, never-locked employee
  const sessionAfter = []; for (let i = 0; i < 6; i++) sessionAfter.push(Number((await appPrisma.$queryRaw`SELECT @@session.innodb_lock_wait_timeout AS v`)[0].v));

  console.log('@@RESULT@@' + JSON.stringify({
    op: OP, lockWaitSeconds: LW, op1body: JSON.stringify(op1.body).slice(0, 300), adjustments: { before: before.adjustments, whileLocked: afterFail.adjustments, afterRetry: afterRetry.adjustments, controlAfter: ctlAfter.adjustments },
    op1: { status: op1.status, code: op1.body && op1.body.code, error: op1.body && op1.body.error, ms: op1.ms },
    probes: { total: probe.length, failed: probe.filter((x) => !x.ok).length, firstFailures: probe.filter((x) => !x.ok).slice(0, 3) },
    sessionValues: [...new Set(sessionValues)], sessionAfter: [...new Set(sessionAfter)],
    noWriteWhileLocked: JSON.stringify(afterFail) === JSON.stringify(before), lockedRowUntouched,
    retry: { status: retry.status }, control: { status: ctl.status },
    deltas: { target: { audit: afterRetry.audit - before.audit, advances: afterRetry.advances - before.advances }, control: { audit: ctlAfter.audit - ctlBefore.audit, advances: ctlAfter.advances - ctlBefore.advances } },
  }));
  srv.close(); await admin.$executeRawUnsafe('SET GLOBAL innodb_lock_wait_timeout = 5'); await wipe(); await admin.$disconnect(); process.exit(0);
})().catch(async (e) => { console.error('SCENARIO ERROR', e); try { await admin.$executeRawUnsafe('SET GLOBAL innodb_lock_wait_timeout = 5'); await wipe(); } catch { /* best effort */ } process.exit(1); });
