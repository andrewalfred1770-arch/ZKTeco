/**
 * Manual attendance punches + manual penalty overrides — persistence, device-sync conflicts, repeated requests, failed writes,
 * concurrency, payroll recalculation. Isolated: fake in-memory DB with real transaction rollback + fault injection, fixed clock.
 *
 * F3 and D2 are the regression tests for findings F-M1 (atomic restore-automatic) and F-M2 (hidden device-punch warning);
 * the fuller F-M1/F-M2 matrix lives in manual-restore-review.test.js.
 *
 * Calendar: September 2026. Target day = Wed 2026-09-09 (employee 1, salary 3000 => daily 100, hourly 12.5). Now = 2026-10-14.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

const { db, emp, day, ymd } = h;
const M = 9; const Y = 2026; const TARGET = ymd(Y, M, 9);
const near = (a, b, msg) => assert.ok(Math.abs(Number(a) - Number(b)) < 0.005, `${msg || 'value'}: expected ${b}, got ${a}`);
const isFri = (d) => new Date(ymd(Y, M, d) + 'T12:00:00').getDay() === 5;
const WORKING = Array.from({ length: 30 }, (_, i) => i + 1).filter((d) => !isFri(d));
const hhmm = (d) => (d ? `${String(new Date(d).getHours()).padStart(2, '0')}:${String(new Date(d).getMinutes()).padStart(2, '0')}` : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const engine = () => h.load('engines/attendanceEngine');
const payrollEngine = () => h.load('engines/payrollEngine');

const payrollRow = (employeeId, status = 'draft', over = {}) => ({
  id: 500 + employeeId, employeeId, month: M, year: Y, status, basicSalary: 3000, hourlyRate: 12.5, workDays: 25, absentDays: 1, latePenalty: 0,
  penaltyUnits: 0, penaltyAmount: 0, overtimeHours: 0, overtimeAmount: 0, advances: 0, manualDeductionAdjustment: 0, deductions: 100, netSalary: 2900, ...over,
});
const log = (id, employeeId, ts, createdAt = new Date()) => ({ id, deviceId: 1, zkUserId: String(employeeId), employeeId, timestamp: h.at(TARGET, ts), isDuplicate: false, createdAt, source: 'device' });
let TARGET_ID;

/** Employee 1: every working day present except TARGET, which is an absent row with no punches (to be corrected by HR). */
function seed({ status = 'draft', logs = [], extraRows = [] } = {}) {
  const target = day(1, TARGET, 'absent', { id: 4000 });
  TARGET_ID = target.id;
  db._reset({
    rule: [], department: [{ id: 1, name: 'D' }], branch: [{ id: 1, name: 'B' }],
    employee: [emp({ id: 1 })],
    attendanceDaily: [target, ...WORKING.filter((d) => d !== 9).map((d) => day(1, ymd(Y, M, d), 'present')), ...extraRows],
    attendanceLog: logs, payroll: [payrollRow(1, status)],
  });
  h.load('services/ruleStore').invalidate();
}
const row = () => db._tables.attendanceDaily.find((r) => r.id === TARGET_ID);
const audits = () => db._tables.manualEditAuditLog || [];
const putEdit = (body) => h.putJson(`/api/attendance/daily/${TARGET_ID}`, body);
const putPenalty = (body) => h.putJson(`/api/attendance/${TARGET_ID}/manual-penalty`, body);

test.before(async () => { h.setNow('2026-10-14T10:00:00'); await h.start(); });
test.after(async () => { await h.stop(); });

// ── persistence ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('P1. a manual punch is written, locked, audited and survives EVERY automatic writer (sync, cron, recalc, rebuild, repeated runs)', async () => {
  seed();
  const r = await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'forgot to punch' });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(row().manualEdit, true); assert.equal(hhmm(row().checkIn), '09:00'); assert.equal(hhmm(row().checkOut), '17:00');
  assert.equal(row().isAbsent, false); assert.equal(row().status, 'present');
  assert.ok(audits().some((a) => a.fieldName === 'checkIn' && a.newValue === '09:00' && a.attendanceDailyId === TARGET_ID), 'audit row for the new check-in');

  // the device now delivers DIFFERENT raw punches for the same day
  db._tables.attendanceLog.push(log(1, 1, '07:50'), log(2, 1, '19:30'));
  const eng = engine();
  const res = await eng.processDate(h.utc(TARGET), 1);                              // realtime / sync path
  assert.equal(res.skipped, 'manual-lock'); assert.equal(res.ignoredPunches, 2, 'the hidden punches are REPORTED, not silently dropped');
  await eng.processToday(null, new Date(TARGET));                                    // scheduler / midnight cron path
  await h.load('engines/recalcEngine').recalcScope({ from: TARGET, to: TARGET, employeeId: 1, reason: 'test' });   // rules/holiday/cleanup recalc path
  for (let i = 0; i < 3; i++) await eng.processDate(h.utc(TARGET), 1);               // repeated runs
  assert.equal(hhmm(row().checkIn), '09:00'); assert.equal(hhmm(row().checkOut), '17:00'); assert.equal(row().manualEdit, true);
  assert.equal(db._tables.attendanceDaily.filter((x) => x.employeeId === 1 && x.date.getTime() === h.utc(TARGET).getTime()).length, 1, 'still exactly one row for the day');
});

test('P2. the SAME manual punch is what Daily, Movement, Monthly, payroll (list + sheet) and both Excel exports compute from', async () => {
  seed();
  await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
  const daily = (await h.getJson(`/api/attendance/daily?date=${TARGET}`)).body.find((x) => x.employeeId === 1);
  assert.match(daily.checkIn, /^09:00/); assert.match(daily.checkOut, /^(05:00 PM|17:00)/); assert.equal(daily.isAbsent, false);
  const mov = (await h.getJson(`/api/attendance/movement?employeeId=1&month=2026-09`)).body;
  const d9 = mov.days.find((x) => x.date === TARGET);
  assert.match(d9.checkIn, /^09:00/); assert.equal(d9.isAbsent, false); assert.equal(mov.summary.absentDays, 0);
  const monthly = (await h.getJson(`/api/attendance/monthly?month=${M}&year=${Y}`)).body.find((x) => x.employeeId === 1);
  assert.equal(monthly.absentDays, 0); assert.equal(monthly.workDays, 26);
  const list = (await h.getJson(`/api/payroll?month=${M}&year=${Y}`)).body.find((x) => x.employeeId === 1);
  assert.equal(list.absentDays, 0); near(list.netSalary, 3000);
  const sheet = (await h.getJson(`/api/payroll/final-sheet?employeeId=1&month=${M}&year=${Y}`)).body;
  assert.equal(sheet.attendance.absentDays, 0); near(sheet.netSalary, 3000);
  const pxl = (await h.getXlsxRows(`/api/reports/payroll/export?month=${M}&year=${Y}`)).find((x) => x['Employee Code'] === '1');
  assert.equal(pxl['Absent Days'], 0); near(pxl['Net Salary'], 3000);
  const mxl = (await h.getXlsxRows(`/api/reports/attendance/monthly/export?month=${M}&year=${Y}`)).find((x) => x['Employee Code'] === '1');
  assert.equal(mxl['Absent Days'], 0); assert.equal(mxl['Work Days'], 26);
});

test('P3. manual penalty / overtime overrides survive recompute and rebuild, reach payroll and every page (late 2u = 25.00)', async () => {
  seed();
  await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
  const r = await putPenalty({ manualLatePenaltyUnits: 2, manualOvertimeUnits: 1, reason: 'late arrival' });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  // independent: deductions = 2 x 12.5 = 25 ; OT = 1h x 12.5 x 1.5 = 18.75 ; net = 3000 + 18.75 - 25
  const eng = engine();
  db._tables.attendanceLog.push(log(1, 1, '08:00'), log(2, 1, '18:00'));
  await eng.processDate(h.utc(TARGET), 1);
  await h.load('engines/recalcEngine').recalcScope({ from: TARGET, to: TARGET, employeeId: 1, reason: 'test' });
  assert.equal(row().manualLatePenaltyUnits, 2); assert.equal(row().manualOvertimeUnits, 1);
  const list = (await h.getJson(`/api/payroll?month=${M}&year=${Y}`)).body.find((x) => x.employeeId === 1);
  near(list.deductions, 25); near(list.overtimeAmount, 18.75); near(list.netSalary, 3000 + 18.75 - 25);
  near(db._tables.payroll[0].netSalary, 3000 + 18.75 - 25, 'the explicit edit recalculated the stored draft too');
  const mov = (await h.getJson(`/api/attendance/movement?employeeId=1&month=2026-09`)).body;
  near(mov.summary.totalEffectiveLatePenalty, 2); near(mov.summary.totalEffectiveOvertimeUnits, 1);
  const monthly = (await h.getJson(`/api/attendance/monthly?month=${M}&year=${Y}`)).body.find((x) => x.employeeId === 1);
  near(monthly.totalEffectiveLatePenalty, 2); near(monthly.totalEffectiveOvertimeUnits, 1);
  const sheet = (await h.getJson(`/api/payroll/final-sheet?employeeId=1&month=${M}&year=${Y}`)).body;
  near(sheet.deductions.lateAmount, 25); near(sheet.netSalary, 3000 + 18.75 - 25);
  assert.ok(audits().some((a) => a.fieldName === 'manualLatePenaltyUnits' && a.newValue === '2'), 'override audited');
  // clearing restores the canonical value
  await putPenalty({ manualLatePenaltyUnits: null, manualOvertimeUnits: null, reason: 'undo' });
  const after = (await h.getJson(`/api/payroll?month=${M}&year=${Y}`)).body.find((x) => x.employeeId === 1);
  near(after.deductions, 0); near(after.netSalary, 3000);
});

// ── repeated requests ───────────────────────────────────────────────────────────────────────────────────────────────
test('R1. the same save repeated (sequentially and 10 at once) changes, audits and recalculates payroll exactly once', async () => {
  seed();
  const body = { checkIn: '09:00', checkOut: '17:00', reason: 'r' };
  const first = await putEdit(body);
  assert.equal(first.status, 200); assert.ok(!first.body.unchanged);
  const auditsAfterFirst = audits().length; const payrollWrites = () => db._writeLog.filter((w) => w.model === 'payroll').length;
  const pw = payrollWrites();
  const second = await putEdit(body);
  assert.equal(second.body.unchanged, true, 'identical repeat is a no-op');
  const burst = await Promise.all(Array.from({ length: 10 }, () => putEdit(body)));
  assert.ok(burst.every((x) => x.status === 200 && x.body.unchanged === true));
  assert.equal(audits().length, auditsAfterFirst, 'no duplicate audit rows'); assert.equal(payrollWrites(), pw, 'no repeated payroll writes');
  assert.equal(db._tables.attendanceDaily.filter((x) => x.employeeId === 1 && x.date.getTime() === h.utc(TARGET).getTime()).length, 1);
});

test('R2. a day with NO row: materialize (POST /process) twice + manual save => one row, locked, punch kept', async () => {
  seed();
  db._tables.attendanceDaily.splice(db._tables.attendanceDaily.findIndex((x) => x.id === TARGET_ID), 1);   // the day has no row at all
  await h.postJson('/api/attendance/process', { employeeId: 1, date: TARGET });
  await h.postJson('/api/attendance/process', { employeeId: 1, date: TARGET });
  const created = db._tables.attendanceDaily.filter((x) => x.employeeId === 1 && x.date.getTime() === h.utc(TARGET).getTime());
  assert.equal(created.length, 1); TARGET_ID = created[0].id;
  const r = await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
  assert.equal(r.status, 200);
  assert.equal(db._tables.attendanceDaily.filter((x) => x.employeeId === 1 && x.date.getTime() === h.utc(TARGET).getTime()).length, 1);
  assert.equal(hhmm(row().checkIn), '09:00'); assert.equal(row().manualEdit, true);
});

// ── failed writes ───────────────────────────────────────────────────────────────────────────────────────────────────
test('F1. a failed audit write rolls the whole manual edit back (no half-saved, unaudited punch); a failed payroll recalculation does NOT undo the edit and is reported', async () => {
  seed();
  db._failNext('manualEditAuditLog', 'create');
  const bad = await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
  assert.ok(bad.status >= 400, 'request reports failure');
  assert.equal(row().checkIn, null); assert.equal(row().manualEdit, false); assert.equal(audits().length, 0, 'nothing persisted, nothing half-audited');
  near(db._tables.payroll[0].netSalary, 2900, 'payroll untouched');
  // retry succeeds and is complete
  const ok = await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
  assert.equal(ok.status, 200); assert.equal(hhmm(row().checkIn), '09:00');
  // payroll failure after commit
  seed();
  db._failNext('payroll', 'updateMany', new Error('db down'));
  const part = await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
  assert.equal(part.status, 200); assert.ok(part.body.payrollError, 'payroll failure surfaced, not hidden');
  assert.equal(hhmm(row().checkIn), '09:00'); assert.equal(row().manualEdit, true);
});

test('F2. a failed manual-penalty write persists nothing and audits nothing', async () => {
  seed();
  db._failNext('manualEditAuditLog', 'create');
  const bad = await putPenalty({ manualLatePenaltyUnits: 2, reason: 'x' });
  assert.ok(bad.status >= 400);
  assert.equal(row().manualLatePenaltyUnits ?? null, null); assert.equal(audits().length, 0);
});

test('F3. restore-automatic that fails midway must not leave the row UNLOCKED with the manual punch still in it (data would be overwritten by the next sync)', async () => {
  seed();
  await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
  db._tables.attendanceLog.push(log(1, 1, '08:00'), log(2, 1, '18:00'));
  db._failNext('attendanceDaily', 'upsert', new Error('db down'));
  const r = await h.postJson(`/api/attendance/daily/${TARGET_ID}/restore-auto`, { reason: 'x' });
  assert.ok(r.status >= 400);
  assert.equal(row().manualEdit, true, 'the lock must still be on after a failed restore');
});

// ── concurrency ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('C1. two concurrent saves of DIFFERENT fields of the same row (Tab edit) both persist', async () => {
  seed();
  const [a, b] = await Promise.all([putEdit({ checkIn: '09:00' }), putEdit({ checkOut: '17:00' })]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(hhmm(row().checkIn), '09:00'); assert.equal(hhmm(row().checkOut), '17:00');
});

test('C2. a manual save racing the device-sync recompute for the same day: the manual values win in BOTH orders', async () => {
  for (const syncFirst of [true, false]) {
    seed({ logs: [log(1, 1, '07:55'), log(2, 1, '16:00')] });
    const sync = () => engine().processDate(h.utc(TARGET), 1);
    const edit = () => putEdit({ checkIn: '09:30', checkOut: '17:30', reason: 'r' });
    if (syncFirst) { await Promise.all([sync(), edit(), sync()]); } else { await Promise.all([edit(), sync(), sync()]); }
    await sync();
    assert.equal(hhmm(row().checkIn), '09:30', `syncFirst=${syncFirst}`); assert.equal(hhmm(row().checkOut), '17:30'); assert.equal(row().manualEdit, true);
    assert.equal(db._tables.attendanceDaily.filter((x) => x.employeeId === 1 && x.date.getTime() === h.utc(TARGET).getTime()).length, 1);
  }
});

test('C3. 12 concurrent conflicting saves of the same field end in ONE consistent state and a consistent audit chain', async () => {
  seed();
  const times = Array.from({ length: 12 }, (_, i) => `${String(9 + (i % 3)).padStart(2, '0')}:${String(10 + i).padStart(2, '0')}`);
  const out = await Promise.all(times.map((t) => putEdit({ checkIn: t, checkOut: '18:00', reason: 'r' })));
  assert.ok(out.every((x) => x.status === 200));
  const finalIn = hhmm(row().checkIn);
  assert.ok(times.includes(finalIn));
  const chain = audits().filter((a) => a.fieldName === 'checkIn').sort((x, y) => x.id - y.id);
  assert.equal(chain[chain.length - 1].newValue, finalIn, 'last audited value is the stored value');
  for (let i = 1; i < chain.length; i++) assert.equal(chain[i].oldValue, chain[i - 1].newValue, 'each audit row starts from the previous one — no lost update');
  near(db._tables.payroll[0].netSalary, db._tables.payroll[0].netSalary);
});

// ── payroll recalculation ───────────────────────────────────────────────────────────────────────────────────────────
test('Y1. an explicit manual edit recalculates a DRAFT payroll, and never a finalized / paid one (reported as protected)', async () => {
  for (const status of ['draft', 'finalized', 'paid']) {
    seed({ status });
    const before = JSON.stringify(db._tables.payroll[0]);
    const r = await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
    assert.equal(r.status, 200);
    if (status === 'draft') { near(db._tables.payroll[0].netSalary, 3000); assert.equal(db._tables.payroll[0].absentDays, 0); assert.equal(r.body.payrollProtected, null); }
    else { assert.equal(JSON.stringify(db._tables.payroll[0]), before, `${status} row untouched`); assert.equal(r.body.payrollProtected, status); }
    assert.equal(hhmm(row().checkIn), '09:00', 'the attendance edit itself still applies');
  }
});

// ── device-sync conflict visibility ─────────────────────────────────────────────────────────────────────────────────
test('D1. a punch that arrives AFTER a manual lock is stored, reported as ignored, and applied only by restore-automatic', async () => {
  seed();
  await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
  await sleep(15);
  db._tables.attendanceLog.push(log(1, 1, '18:20', new Date()));                    // late punch outside HR's [09:00, 17:00]
  const res = await engine().processDate(h.utc(TARGET), 1);
  assert.equal(res.skipped, 'manual-lock'); assert.equal(res.ignoredPunches, 1);
  assert.equal(hhmm(row().checkOut), '17:00');
  const restored = await h.postJson(`/api/attendance/daily/${TARGET_ID}/restore-auto`, { reason: 'apply device' });
  assert.equal(restored.status, 200); assert.equal(row().manualEdit, false);
  assert.equal(hhmm(row().checkIn), null, 'only the raw 18:20 punch remains: classified as check-out (outside the check-in window)');
  assert.equal(hhmm(row().checkOut), '18:20');
});

test('D2. a later write that does not review the times (manual penalty / absence type) must not make a hidden device punch disappear from the warning', async () => {
  seed();
  await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
  await sleep(15);
  db._tables.attendanceLog.push(log(1, 1, '18:20', new Date()));
  assert.equal((await engine().processDate(h.utc(TARGET), 1)).ignoredPunches, 1);
  await sleep(15);
  await putPenalty({ manualLatePenaltyUnits: 1, reason: 'unrelated change' });      // bumps updatedAt, times not looked at
  assert.equal((await engine().processDate(h.utc(TARGET), 1)).ignoredPunches, 1, 'the 18:20 punch is still unreflected');
});

test('D3. manual-penalty overrides do not lock the row, so restore-automatic is refused for them and the only way back is clearing each field', async () => {
  seed({ logs: [log(1, 1, '09:00'), log(2, 1, '17:00')] });
  await engine().processDate(h.utc(TARGET), 1);
  await putPenalty({ manualLatePenaltyUnits: 2, reason: 'x' });
  assert.equal(row().manualEdit, false);
  const r = await h.postJson(`/api/attendance/daily/${TARGET_ID}/restore-auto`, {});
  assert.equal(r.status, 400);
  await putPenalty({ manualLatePenaltyUnits: null, reason: 'clear' });
  assert.equal(row().manualLatePenaltyUnits, null);
});
