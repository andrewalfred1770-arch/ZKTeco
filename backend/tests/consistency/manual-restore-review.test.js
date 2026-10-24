/**
 * F-M1 (restore-automatic is atomic) and F-M2 (a hidden device punch stays reported until HR reviews the punch TIMES).
 * Same isolated setup as manual-edit.test.js: fake DB with transaction rollback + fault injection, fixed clock 2026-10-14.
 * Target day = Wed 2026-09-09, employee 1 (salary 3000 => daily 100).
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
const log = (id, ts, createdAt = new Date()) => ({ id, deviceId: 1, zkUserId: '1', employeeId: 1, timestamp: h.at(TARGET, ts), isDuplicate: false, createdAt, source: 'device' });
const payrollRow = () => ({
  id: 501, employeeId: 1, month: M, year: Y, status: 'draft', basicSalary: 3000, hourlyRate: 12.5, workDays: 25, absentDays: 1, latePenalty: 0,
  penaltyUnits: 0, penaltyAmount: 0, overtimeHours: 0, overtimeAmount: 0, advances: 0, manualDeductionAdjustment: 0, deductions: 100, netSalary: 2900,
});
let ID;
function seed({ logs = [] } = {}) {
  const target = day(1, TARGET, 'absent', { id: 4000 });
  ID = target.id;
  db._reset({
    rule: [], department: [{ id: 1, name: 'D' }], branch: [{ id: 1, name: 'B' }], employee: [emp({ id: 1 })],
    attendanceDaily: [target, ...WORKING.filter((d) => d !== 9).map((d) => day(1, ymd(Y, M, d), 'present'))], attendanceLog: logs, payroll: [payrollRow()],
  });
  h.load('services/ruleStore').invalidate();
}
const row = (id = ID) => db._tables.attendanceDaily.find((r) => r.id === id);
const audits = () => db._tables.manualEditAuditLog || [];
const putEdit = (body) => h.putJson(`/api/attendance/daily/${ID}`, body);
const putPenalty = (body) => h.putJson(`/api/attendance/${ID}/manual-penalty`, body);
const restore = (id = ID, body = { reason: 'x' }) => h.postJson(`/api/attendance/daily/${id}/restore-auto`, body);
const rowsForDay = () => db._tables.attendanceDaily.filter((x) => x.employeeId === 1 && x.date.getTime() === h.utc(TARGET).getTime()).length;

test.before(async () => { h.setNow('2026-10-14T10:00:00'); await h.start(); });
test.after(async () => { await h.stop(); });

// ── F-M1 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('F-M1a. a failed restore leaves the row exactly as HR saved it (locked, times intact), no audit, payroll untouched; the next sync still cannot overwrite it; a retry succeeds', async () => {
  seed();
  await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
  db._tables.attendanceLog.push(log(1, '08:00'), log(2, '18:00'));
  const lockedBefore = JSON.stringify(row()); const auditsBefore = audits().length; const netBefore = db._tables.payroll[0].netSalary;
  db._failNext('attendanceDaily', 'upsert', new Error('db down'));
  const r = await restore();
  assert.ok(r.status >= 400);
  assert.equal(JSON.stringify(row()), lockedBefore, 'row byte-identical');
  assert.equal(audits().length, auditsBefore, 'no "restored" audit for a restore that did not happen');
  assert.equal(db._tables.payroll[0].netSalary, netBefore);
  const sync = await engine().processDate(h.utc(TARGET), 1);
  assert.equal(sync.skipped, 'manual-lock'); assert.equal(hhmm(row().checkIn), '09:00');
  const ok = await restore(ID, { reason: 'retry' });
  assert.equal(ok.status, 200); assert.equal(row().manualEdit, false); assert.equal(hhmm(row().checkIn), '08:00'); assert.equal(hhmm(row().checkOut), '18:00');
});

test('F-M1b. a failure in the unlock write itself (first and every attempt) never produces an unlocked row that still holds manual values', async () => {
  seed();
  await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
  db._tables.attendanceLog.push(log(1, '08:00'), log(2, '18:00'));
  db._failNext('attendanceDaily', 'upsert', new Error('db down'), 5);
  for (let i = 0; i < 3; i++) await restore();
  db._clearFailures();
  assert.equal(row().manualEdit, true); assert.equal(hhmm(row().checkIn), '09:00');
  assert.equal(await engine().processDate(h.utc(TARGET), 1).then((x) => x.skipped), 'manual-lock');
});

test('F-M1c. a successful restore: lock cleared in the same write, recomputed from the raw logs, audited, payroll re-settled, still one row, row automatic again', async () => {
  seed({ logs: [log(1, '09:00'), log(2, '17:00')] });
  await putEdit({ checkIn: '10:30', checkOut: '15:00', reason: 'r' });
  assert.equal(hhmm(row().checkIn), '10:30');
  const r = await restore(ID, { reason: 'back to device' });
  assert.equal(r.status, 200);
  assert.equal(row().manualEdit, false); assert.equal(hhmm(row().checkIn), '09:00'); assert.equal(hhmm(row().checkOut), '17:00'); assert.equal(row().status, 'present');
  assert.ok(audits().some((a) => a.fieldName === 'manualEdit' && a.oldValue === 'true' && a.newValue === 'false'));
  near(db._tables.payroll[0].netSalary, 3000, 'payroll re-settled from the restored on-time day');
  assert.equal(rowsForDay(), 1);
  db._tables.attendanceLog.push(log(3, '18:10'));
  assert.equal((await engine().processDate(h.utc(TARGET), 1))?.skipped, undefined, 'no longer locked');
  assert.equal(hhmm(row().checkOut), '18:10');
});

test('F-M1d. restore on a weekly-off day with no raw punches: the no-punch branch clears the lock in the same write', async () => {
  seed();
  db._tables.attendanceDaily.push(day(1, ymd(Y, M, 11), 'weekend', { id: 4100 }));
  assert.equal((await h.putJson('/api/attendance/daily/4100', { checkIn: '10:00', checkOut: '14:00', reason: 'worked Friday' })).status, 200);
  assert.equal(row(4100).manualEdit, true);
  assert.equal((await restore(4100)).status, 200);
  assert.equal(row(4100).manualEdit, false); assert.equal(row(4100).status, 'weekend'); assert.equal(row(4100).isAbsent, false); assert.equal(row(4100).checkIn, null);
});

test('F-M1e. restore is refused for an unlocked row, and a restore racing a manual save and a sync ends consistent (one row, one lock state)', async () => {
  seed({ logs: [log(1, '08:00'), log(2, '18:00')] });
  assert.equal((await restore()).status, 400, 'not manually edited');
  await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
  await Promise.all([restore(), putEdit({ checkIn: '09:15', reason: 'r' }), engine().processDate(h.utc(TARGET), 1), restore()]);
  assert.equal(rowsForDay(), 1);
  if (row().manualEdit) assert.ok(['09:00', '09:15'].includes(hhmm(row().checkIn)) || hhmm(row().checkIn) === '09:15', 'locked => HR value kept');
  else assert.ok(['08:00', '09:15'].includes(hhmm(row().checkIn)), 'unlocked => recomputed from raw logs (or the later manual save)');
});

// ── F-M2 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function lockWithHiddenPunch() {
  seed();
  await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
  await sleep(15);
  db._tables.attendanceLog.push(log(1, '18:20', new Date()));                    // arrives AFTER the manual save
  assert.equal((await engine().processDate(h.utc(TARGET), 1)).ignoredPunches, 1);
  await sleep(15);
}
const hidden = async () => (await engine().processDate(h.utc(TARGET), 1)).ignoredPunches;

test('F-M2a. manual penalty / overtime changes do not hide the unreviewed punch (engine, PUT response, Monthly-detail)', async () => {
  await lockWithHiddenPunch();
  assert.equal((await putPenalty({ manualLatePenaltyUnits: 1, manualOvertimeUnits: 2, reason: 'unrelated' })).status, 200);
  assert.equal(await hidden(), 1);
  const detail = (await h.getJson(`/api/attendance/monthly-detail?month=${M}&year=${Y}`)).body.find((x) => x.id === ID);
  assert.equal(detail.ignoredPunches, 1); assert.equal(detail.lockedPunchConflict, true);
});

test('F-M2b. a status change does not hide it', async () => {
  await lockWithHiddenPunch();
  assert.equal((await putPenalty({ status: 'late', reason: 'status only' })).status, 200);
  assert.equal(await hidden(), 1);
});

test('F-M2c. an adjustment approval (manualEdit + fresh updatedAt on the daily row) and an absence-type edit do not hide it', async () => {
  await lockWithHiddenPunch();
  await db.attendanceDaily.update({ where: { id: ID }, data: { manualEdit: true, updatedAt: new Date() } });   // the write POST /adjustments/:id/approve makes
  assert.equal(await hidden(), 1);
  seed();                                                                         // absent row, locked, with a device punch beside it
  await db.attendanceDaily.update({ where: { id: ID }, data: { manualEdit: true } });   // locked (e.g. by an adjustment approval)
  db._tables.attendanceLog.push(log(1, '09:05', new Date()));
  assert.equal((await h.putJson(`/api/attendance/${ID}/absence-type`, { absenceType: 'without_permission' })).status, 200);
  assert.equal(await hidden(), 1);
});

test('F-M2d. a genuine punch-time review is honoured: covering or trimming the times marks earlier punches as seen; a LATER punch is news again', async () => {
  await lockWithHiddenPunch();
  const r = await putEdit({ checkOut: '18:30', reason: 'extended to cover the device punch' });
  assert.equal(r.status, 200); assert.equal(r.body.ignoredPunches, 0);
  assert.equal(await hidden(), 0);
  await sleep(15);
  db._tables.attendanceLog.push(log(2, '19:45', new Date()));
  assert.equal(await hidden(), 1);
  await sleep(15);
  assert.equal((await putEdit({ checkOut: '17:45', reason: 'trimmed' })).status, 200);   // HR looked and deliberately trimmed
  assert.equal(await hidden(), 0, 'seen and deliberately overridden');
});

test('F-M2e. a locked row with no audited punch-time change reports every unreflected punch (conservative); a punch inside the row span is never a conflict', async () => {
  seed({ logs: [log(1, '09:00'), log(2, '17:00')] });
  await engine().processDate(h.utc(TARGET), 1);
  await putPenalty({ status: 'late', reason: 'lock without touching the times' });
  assert.equal(row().manualEdit, true); assert.equal(audits().some((a) => a.fieldName === 'checkIn' || a.fieldName === 'checkOut'), false);
  db._tables.attendanceLog.push(log(3, '12:00'));
  assert.equal(await hidden(), 0);
  db._tables.attendanceLog.push(log(4, '18:05'));
  assert.equal(await hidden(), 1);
});
