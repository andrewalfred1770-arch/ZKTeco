/**
 * Cross-page / cross-API consistency tests (isolated: fake in-memory DB, fixed clock, no DB / .env / devices / network).
 *
 * Every expected number below is derived BY HAND from the scenario data (salary 3000 / month_days 30 => daily 100, hourly 12.5)
 * — never by calling the code under test — so a passing test proves the surfaces agree with an independent calculation,
 * not merely with each other.
 *
 * Calendar: September 2026 (Tue 1st). Fridays: 4, 11, 18, 25. "Now" = Wed 2026-10-14 10:00 local.
 * Run:  TZ=Asia/Riyadh node --test tests/consistency/        (also run with TZ=UTC)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

const { db, emp, day, ymd, utc } = h;
const M = 9; const Y = 2026;
const near = (a, b, msg) => assert.ok(Math.abs(Number(a) - Number(b)) < 0.005, `${msg || 'value'}: expected ${b}, got ${a}`);
const isFriday = (d) => new Date(ymd(Y, M, d) + 'T12:00:00').getDay() === 5;
const SEP_DAYS = Array.from({ length: 30 }, (_, i) => i + 1);
const WORKING = SEP_DAYS.filter((d) => !isFriday(d));                       // 26 non-Friday days

const payrollRow = (employeeId, status = 'draft', over = {}) => ({
  id: 500 + employeeId, employeeId, month: M, year: Y, status, basicSalary: 0, hourlyRate: 0, workDays: 0, absentDays: 0, latePenalty: 0,
  penaltyUnits: 0, penaltyAmount: 0, overtimeHours: 0, overtimeAmount: 0, advances: 0, manualDeductionAdjustment: 0, deductions: 0, netSalary: 0, ...over,
});
const present = (id, days, over = {}) => days.map((d) => day(id, ymd(Y, M, d), 'present', over));
const ruleStore = () => h.load('services/ruleStore');

function reset(seed, rules = []) {
  db._reset({ rule: rules.map((r, i) => ({ id: i + 1, isActive: true, priority: 1, ...r })), department: [{ id: 1, name: 'D' }], branch: [{ id: 1, name: 'B1' }, { id: 2, name: 'B2' }], ...seed });
  ruleStore().invalidate();
}
const codeOf = (id) => String(id);
async function surfaces(id) {
  const list = (await h.getJson(`/api/payroll?month=${M}&year=${Y}`)).body.find((r) => r.employeeId === id);
  const sheet = (await h.getJson(`/api/payroll/final-sheet?employeeId=${id}&month=${M}&year=${Y}`)).body;
  const mov = (await h.getJson(`/api/attendance/movement?employeeId=${id}&month=${Y}-${String(M).padStart(2, '0')}`)).body;
  const monthly = (await h.getJson(`/api/attendance/monthly?month=${M}&year=${Y}`)).body.find((r) => r.employeeId === id);
  const mxl = (await h.getXlsxRows(`/api/reports/attendance/monthly/export?month=${M}&year=${Y}`)).find((r) => r['Employee Code'] === codeOf(id));
  const pxl = (await h.getXlsxRows(`/api/reports/payroll/export?month=${M}&year=${Y}`)).find((r) => r['Employee Code'] === codeOf(id));
  return { list, sheet, mov, monthly, mxl, pxl };
}

test.before(async () => { h.setNow('2026-10-14T10:00:00'); await h.start(); });
test.after(async () => { await h.stop(); });

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('A. absence reconciliation — 9 stored absent rows + 1 working day with no row = 10 absences on EVERY surface', async () => {
  const E = emp({ id: 1 });
  const absentDays = [1, 2, 3, 5, 6, 7, 9, 10, 12];                           // 9 stored absences (none is a Friday)
  const rows = [...absentDays.map((d) => day(1, ymd(Y, M, d), 'absent')), ...present(1, WORKING.filter((d) => d >= 13))];   // day 8 has NO row
  reset({ employee: [E], attendanceDaily: rows, payroll: [payrollRow(1)] });
  const s = await surfaces(1);
  // independent expectation: 10 absences x 1 salary day x 100 = 1000 deducted; 16 present days; net = 3000 - 1000
  assert.equal(s.list.absentDays, 10, 'payroll list');
  assert.equal(s.sheet.attendance.absentDays, 10, 'final sheet attendance.absentDays');
  assert.equal(s.sheet.deductions.absentDays, 10, 'final sheet deductions.absentDays');
  assert.equal(s.sheet.deductions.absentPenaltyDays, 10, 'final sheet penalty days');
  near(s.sheet.deductions.absentAmount, 1000, 'final sheet absent amount');
  assert.equal(s.mov.summary.absentDays, 10, 'movement');
  assert.equal(s.mov.summary.totalPenaltyDays, 10, 'movement penalty days');
  assert.equal(s.monthly.absentDays, 10, 'monthly attendance');
  assert.equal(s.mxl['Absent Days'], 10, 'monthly attendance Excel');
  assert.equal(s.pxl['Absent Days'], 10, 'payroll Excel');
  near(s.list.netSalary, 2000, 'list net'); near(s.sheet.netSalary, 2000, 'sheet net'); near(s.pxl['Net Salary'], 2000, 'excel net');
  assert.equal(s.list.workDays, 16); assert.equal(s.mov.summary.presentDays, 16);
  // the day with no row, on the Daily screen
  const daily = (await h.getJson('/api/attendance/daily?date=2026-09-08')).body.find((r) => r.employeeId === 1);
  assert.equal(daily.isAbsent, true, 'daily screen shows the no-row working day as absent');
});

test('B. overtime reconciliation — raw 33h vs effective (paid) 30h; every PAID figure is 30h, raw columns stay labelled raw', async () => {
  const E = emp({ id: 2 });
  const ot = (d, extra = {}) => day(2, ymd(Y, M, d), 'present', { overtimeHours: 11, eveningOvertimeHours: 11, ...extra });
  const rows = [...present(2, WORKING.filter((d) => ![15, 16, 17].includes(d))), ot(15), ot(16), ot(17, { manualOvertimeUnits: 8 })];
  reset({ employee: [E], attendanceDaily: rows, payroll: [payrollRow(2)] });
  const s = await surfaces(2);
  // independent: effective OT = 11 + 11 + 8 = 30h ; amount = 30 x 12.5 x 1.5 = 562.5 ; net = 3000 + 562.5
  near(s.list.overtimeHours, 30, 'list OT hours'); near(s.list.overtimeAmount, 562.5, 'list OT amount');
  near(s.sheet.attendance.totalOTHours, 30, 'sheet OT hours'); near(s.sheet.earnings.overtimeAmount, 562.5, 'sheet OT amount');
  near(s.mov.summary.totalOTHours, 30, 'movement OT hours'); near(s.mov.summary.otAmount, 562.5, 'movement OT amount');
  near(s.monthly.totalEffectiveOvertimeUnits, 30, 'monthly effective OT'); near(s.mxl['Overtime (Units)'], 30, 'monthly Excel effective OT');
  near(s.pxl['OT Hours'], 30, 'payroll Excel OT hours'); near(s.pxl['OT Amount'], 562.5, 'payroll Excel OT amount');
  near(s.list.netSalary, 3562.5, 'net'); near(s.sheet.netSalary, 3562.5); near(s.pxl['Net Salary'], 3562.5);
  // INTENTIONAL difference (documented): the raw, pre-override column is 33 and is labelled raw
  near(Number(s.monthly.totalOvertimeHours), 33, 'monthly raw OT'); near(s.mxl['Overtime Hours (Raw)'], 33, 'monthly Excel raw OT');
});

test('B2. approved adjustment overtime reaches payroll, movement and the effective monthly column', async () => {
  const E = emp({ id: 12 });
  const target = day(12, ymd(Y, M, 20), 'present', { overtimeHours: 2, eveningOvertimeHours: 2 });
  reset({
    employee: [E], attendanceDaily: [...present(12, WORKING.filter((d) => d !== 20)), target], payroll: [payrollRow(12)],
    attendanceAdjustment: [{ id: 1, attendanceDailyId: target.id, employeeId: 12, date: target.date, approvalStatus: 'approved', adjOvertimeHours: 5 }],
  });
  const s = await surfaces(12);
  near(s.list.overtimeHours, 5); near(s.sheet.attendance.totalOTHours, 5); near(s.mov.summary.totalOTHours, 5);
  near(s.monthly.totalEffectiveOvertimeUnits, 5); near(s.pxl['OT Hours'], 5);
  near(s.list.overtimeAmount, 5 * 12.5 * 1.5, 'OT amount 93.75');
});

test('C. hire date inside the month: 15 of 30 days paid, pre-hire days are never absences, missing post-hire day is one', async () => {
  const E3 = emp({ id: 3, hireDate: utc('2026-09-16') });
  const E3b = emp({ id: 13, hireDate: utc('2026-09-16') });
  const post = WORKING.filter((d) => d >= 16);                                   // 16,17,19..24,26..30 = 13 days
  reset({
    employee: [E3, E3b], attendanceDaily: [...present(3, post), ...present(13, post.filter((d) => d !== 21))],
    payroll: [payrollRow(3), payrollRow(13)],
  });
  const a = await surfaces(3);
  near(a.list.basicSalary, 1500, 'pro-rated basic = 3000 x 15/30'); assert.equal(a.list.absentDays, 0); assert.equal(a.list.workDays, 13);
  near(a.list.netSalary, 1500); near(a.sheet.netSalary, 1500); near(a.pxl['Net Salary'], 1500); near(a.pxl['Basic Salary'], 1500);
  assert.equal(a.mov.summary.absentDays, 0); assert.equal(a.monthly.absentDays, 0); assert.equal(a.mxl['Absent Days'], 0);
  assert.equal(a.mov.days.filter((d) => d.isPreHire).length, 15, 'Movement flags the 15 pre-hire days');
  assert.equal(a.mov.days.filter((d) => d.isPreHire && d.isAbsent).length, 0);
  const b = await surfaces(13);
  assert.equal(b.list.absentDays, 1); assert.equal(b.mov.summary.absentDays, 1); assert.equal(b.monthly.absentDays, 1); assert.equal(b.sheet.attendance.absentDays, 1);
  near(b.list.netSalary, 1400, '1500 - one salary day (100, from the FULL salary rate)'); near(b.sheet.netSalary, 1400); near(b.pxl['Net Salary'], 1400);
});

test('C2. employee hired after the month: no payroll is created, a stale draft is not listed/exported; punches override', async () => {
  const late = emp({ id: 14, hireDate: utc('2026-10-05') });                      // stale draft row exists, no punches
  const lateNoRow = emp({ id: 15, hireDate: utc('2026-10-05') });                  // no payroll row at all
  const lateWithPunch = emp({ id: 16, hireDate: utc('2026-10-05') });              // but real punches in September
  reset({ employee: [late, lateNoRow, lateWithPunch], attendanceDaily: [day(16, ymd(Y, M, 29), 'present')], payroll: [payrollRow(14)] });
  const list = (await h.getJson(`/api/payroll?month=${M}&year=${Y}`)).body;
  assert.equal(list.some((r) => r.employeeId === 14), false, 'stale draft of an unstarted employee is not listed');
  const xl = await h.getXlsxRows(`/api/reports/payroll/export?month=${M}&year=${Y}`);
  assert.equal(xl.some((r) => r['Employee Code'] === '14'), false, 'and not exported either');
  const calc = await h.postJson('/api/payroll/calculate', { month: M, year: Y });
  assert.equal(calc.status, 200);
  assert.equal(db._tables.payroll.some((p) => p.employeeId === 15), false, 'no payroll created for the unstarted employee');
  assert.equal(db._tables.payroll.some((p) => p.employeeId === 16), true, 'punch evidence wins: payroll is created');
});

test('D. Friday / holiday / branch holiday / configured weekend: only a genuinely working day without a row is an absence', async () => {
  const E4 = emp({ id: 4 }); const E5 = emp({ id: 5 });
  const without = (id, skip) => present(id, WORKING.filter((d) => !skip.includes(d)));
  reset({
    employee: [E4, E5],
    attendanceDaily: [...without(4, [22]), ...without(5, [23])],                  // Fridays never have rows; 22 / 23 deliberately have none
    holiday: [{ id: 1, date: utc('2026-09-22'), branchId: null }, { id: 2, date: utc('2026-09-23'), branchId: 2 }],
    payroll: [payrollRow(4), payrollRow(5)],
  });
  const a = await surfaces(4); const b = await surfaces(5);
  assert.equal(a.list.absentDays, 0, 'company-wide holiday + 4 Fridays are not absences');
  assert.equal(a.mov.summary.absentDays, 0); assert.equal(a.monthly.absentDays, 0); assert.equal(a.sheet.attendance.absentDays, 0);
  assert.equal(b.list.absentDays, 1, "another branch's holiday does not excuse this branch");
  assert.equal(b.mov.summary.absentDays, 1); assert.equal(b.monthly.absentDays, 1); assert.equal(b.pxl['Absent Days'], 1);
  near(b.list.netSalary, 2900);
});

test('D2. configured weekend_days=sat is honoured identically by payroll, movement and the monthly report', async () => {
  const E = emp({ id: 6 });
  const SAT = [5, 12, 19, 26];
  reset({ employee: [E], attendanceDaily: present(6, WORKING.filter((d) => !SAT.includes(d))), payroll: [payrollRow(6)] }, [{ key: 'weekend_days', value: 'sat' }]);
  const s = await surfaces(6);
  assert.equal(s.list.absentDays, 0); assert.equal(s.mov.summary.absentDays, 0); assert.equal(s.monthly.absentDays, 0); assert.equal(s.pxl['Absent Days'], 0);
  near(s.list.netSalary, 3000);
});

test('E. incomplete punches and manual punches are never absences and are counted as worked days everywhere', async () => {
  const E = emp({ id: 7 });
  const rows = [
    ...present(7, WORKING.filter((d) => ![8, 9, 10].includes(d))),
    day(7, ymd(Y, M, 8), 'present', { checkOut: null, workedMinutes: 0 }),                                       // check-in only
    day(7, ymd(Y, M, 9), 'present', { checkIn: null, workedMinutes: 0 }),                                        // check-out only
    day(7, ymd(Y, M, 10), 'early_leave', { manualEdit: true, checkIn: h.at(ymd(Y, M, 10), '10:00'), checkOut: h.at(ymd(Y, M, 10), '15:00'), workedMinutes: 300 }),
  ];
  reset({ employee: [E], attendanceDaily: rows, payroll: [payrollRow(7)] });
  const s = await surfaces(7);
  for (const [name, v] of [['list', s.list.absentDays], ['movement', s.mov.summary.absentDays], ['monthly', s.monthly.absentDays], ['sheet', s.sheet.attendance.absentDays], ['excel', s.pxl['Absent Days']]]) assert.equal(v, 0, name);
  assert.equal(s.list.workDays, 26); assert.equal(s.mov.summary.presentDays, 26); assert.equal(s.monthly.workDays, 26);
});

test('F. stopped employee: days on/after the stop date are not absences on ANY surface; stop at month start is excluded everywhere', async () => {
  const E8 = emp({ id: 8, status: false, effectiveStopDate: utc('2026-09-16') });
  const E18 = emp({ id: 18, status: false, effectiveStopDate: utc('2026-09-01') });
  reset({
    employee: [E8, E18], attendanceDaily: present(8, WORKING.filter((d) => d <= 15)), payroll: [payrollRow(8), payrollRow(18)],
  }, [{ key: 'exclude_stopped_employees_from_payroll', value: 'true' }]);
  const s = await surfaces(8);
  assert.equal(s.list.absentDays, 0, 'payroll'); assert.equal(s.pxl['Absent Days'], 0);
  assert.equal(s.mov.summary.absentDays, 0, 'movement must not invent absences after the stop date');
  assert.equal(s.monthly.absentDays, 0);
  const daily = (await h.getJson('/api/attendance/daily?date=2026-09-20')).body.find((r) => r.employeeId === 8);
  assert.ok(!daily || daily.isAbsent === false, 'daily screen: not listed, or at least not absent, after the stop date');
  const list = (await h.getJson(`/api/payroll?month=${M}&year=${Y}`)).body;
  const xl = await h.getXlsxRows(`/api/reports/payroll/export?month=${M}&year=${Y}`);
  assert.equal(list.some((r) => r.employeeId === 18), false, 'list excludes stop-at-month-start');
  assert.equal(xl.some((r) => r['Employee Code'] === '18'), false, 'export excludes it too (same row set as the grid)');
});

test('G. advances + manual deduction + late + early + classified absences + OT reconcile to 2117.50 on every surface', async () => {
  const E = emp({ id: 9 });
  const special = [2, 3, 10, 14, 15];
  const rows = [
    ...present(9, WORKING.filter((d) => !special.includes(d))),
    day(9, ymd(Y, M, 2), 'absent'),                                              // automatic: 1 salary day
    day(9, ymd(Y, M, 3), 'absent', { penaltyDays: 2, absenceType: 'without_permission' }),
    day(9, ymd(Y, M, 10), 'late', { checkIn: h.at(ymd(Y, M, 10), '09:30'), lateMinutes: 30, latePenaltyUnits: 2, totalDeductionUnits: 2 }),
    day(9, ymd(Y, M, 14), 'early_leave', { earlyLeaveMinutes: 60, earlyCheckoutUnits: 1, totalDeductionUnits: 1 }),
    day(9, ymd(Y, M, 15), 'present', { overtimeHours: 4, eveningOvertimeHours: 4 }),
  ];
  reset({ employee: [E], attendanceDaily: rows, advance: [{ id: 1, employeeId: 9, month: M, year: Y, amount: 500 }], payroll: [payrollRow(9, 'draft', { manualDeductionAdjustment: 120 })] });
  // independent: absence 3 days x 100 = 300 ; late 2u x 12.5 = 25 ; early 1u x 12.5 = 12.5 ; manual 120  => deductions 457.5
  //              OT 4h x 12.5 x 1.5 = 75 ; net = 3000 + 75 - 457.5 - 500 = 2117.5 ; penaltyUnits = 3
  const s = await surfaces(9);
  near(s.list.deductions, 457.5, 'list deductions'); near(s.list.advances, 500); near(s.list.overtimeAmount, 75); near(s.list.penaltyUnits, 3); near(s.list.netSalary, 2117.5);
  near(s.sheet.deductions.total, 457.5); near(s.sheet.deductions.absentAmount, 300); near(s.sheet.deductions.lateAmount, 25); near(s.sheet.deductions.earlyAmount, 12.5);
  near(s.sheet.deductions.advances, 500); near(s.sheet.deductions.manualDeductionAdjustment, 120); near(s.sheet.netSalary, 2117.5);
  near(s.pxl['Deductions'], 457.5); near(s.pxl['Advances'], 500); near(s.pxl['Manual Deduction'], 120); near(s.pxl['Penalty Units'], 3); near(s.pxl['Net Salary'], 2117.5);
  assert.equal(s.mov.summary.totalPenaltyDays, 3); near(s.mov.summary.totalEffectiveDeductionUnits, 3); near(s.mov.summary.otAmount, 75);
  near(s.sheet.earnings.total + 0, 3075); near(s.sheet.earnings.total - s.sheet.deductions.total - s.sheet.deductions.advances, s.sheet.netSalary, 'sheet arithmetic identity');
});

test('G2. missing salary configuration (null and 0): zero money everywhere, never NaN/Infinity/negative', async () => {
  const E = emp({ id: 10, salary: null }); const Z = emp({ id: 20, salary: 0 });
  reset({ employee: [E, Z], attendanceDaily: [...present(10, WORKING.filter((d) => d !== 2)), day(10, ymd(Y, M, 2), 'absent'), ...present(20, WORKING)], payroll: [payrollRow(10), payrollRow(20)] });
  for (const id of [10, 20]) {
    const s = await surfaces(id);
    for (const v of [s.list.basicSalary, s.list.hourlyRate, s.list.netSalary, s.list.deductions, s.sheet.netSalary, s.pxl['Net Salary'], s.pxl['Basic Salary']]) {
      assert.ok(Number.isFinite(Number(v)) && Number(v) === 0, `id ${id}: ${v}`);
    }
  }
});

test('H. draft shows live figures; finalized and paid show the APPROVED stored figures on list, final sheet AND Excel — and are never written by reads', async () => {
  const stored = { basicSalary: 3000, hourlyRate: 12.5, workDays: 24, absentDays: 0, deductions: 0, netSalary: 3000 };
  const mk = (id) => [...present(id, WORKING.filter((d) => ![2, 3].includes(d))), day(id, ymd(Y, M, 2), 'absent'), day(id, ymd(Y, M, 3), 'absent')];   // live: 2 absences => 200
  reset({
    employee: [emp({ id: 31 }), emp({ id: 32 }), emp({ id: 33 })], attendanceDaily: [...mk(31), ...mk(32), ...mk(33)],
    payroll: [payrollRow(31, 'draft', stored), payrollRow(32, 'finalized', stored), payrollRow(33, 'paid', stored)],
  });
  const list = (await h.getJson(`/api/payroll?month=${M}&year=${Y}`)).body;
  const xl = await h.getXlsxRows(`/api/reports/payroll/export?month=${M}&year=${Y}`);
  for (const id of [32, 33]) {
    const l = list.find((r) => r.employeeId === id); const x = xl.find((r) => r['Employee Code'] === String(id));
    const sheet = (await h.getJson(`/api/payroll/final-sheet?employeeId=${id}&month=${M}&year=${Y}`)).body;
    near(l.netSalary, 3000, `list ${id}`); near(sheet.netSalary, 3000, `sheet ${id}`); near(x['Net Salary'], 3000, `excel ${id}`); assert.equal(x['Absent Days'], 0, `excel absent ${id}`);
  }
  const d = list.find((r) => r.employeeId === 31); near(d.netSalary, 2800, 'draft is live: 3000 - 2 x 100');
  near(xl.find((r) => r['Employee Code'] === '31')['Net Salary'], 2800);
  await h.postJson('/api/payroll/calculate', { month: M, year: Y });
  await h.postJson('/api/payroll/calculate', { month: M, year: Y, employeeId: 32 });
  const closedWrites = db._writeLog.filter((w) => w.model === 'payroll' && w.ids.some((i) => [532, 533].includes(i)));
  assert.deepEqual(closedWrites, [], 'finalized / paid rows are never written');
  assert.equal(db._tables.payroll.find((p) => p.id === 532).netSalary, 3000);
  assert.equal(db._tables.payroll.find((p) => p.id === 533).netSalary, 3000);
});

test('I. repeated recalculation is idempotent; 10 concurrent calculations create exactly one row; manual deduction is preserved', async () => {
  const E = emp({ id: 41 });
  reset({ employee: [E], attendanceDaily: [...present(41, WORKING.filter((d) => d !== 2)), day(41, ymd(Y, M, 2), 'absent')], payroll: [] });
  const engine = h.load('engines/payrollEngine');
  const first = await engine.calculatePayroll(41, M, Y);
  for (let i = 0; i < 4; i++) await engine.calculatePayroll(41, M, Y);
  await Promise.all(Array.from({ length: 10 }, () => engine.calculatePayroll(41, M, Y)));
  const rows = db._tables.payroll.filter((p) => p.employeeId === 41);
  assert.equal(rows.length, 1, 'one row, no duplicates');
  assert.equal(db._writeLog.filter((w) => w.op === 'create' && w.model === 'payroll').length, 1);
  near(rows[0].netSalary, 2900); near(first.netSalary, 2900);
  db._tables.payroll[0].manualDeductionAdjustment = 120;                          // HR-entered, must survive recalculation
  await engine.calculatePayroll(41, M, Y);
  near(db._tables.payroll[0].manualDeductionAdjustment, 120); near(db._tables.payroll[0].netSalary, 2780);
  const a = await h.postJson('/api/payroll/calculate', { month: M, year: Y });
  const b = await h.postJson('/api/payroll/calculate', { month: M, year: Y });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(db._tables.payroll.filter((p) => p.employeeId === 41).length, 1);
  near(db._tables.payroll[0].netSalary, 2780);
});

test('J. dashboard "absent today" == Daily screen absent count for the same day; not-yet-hired is neither', async () => {
  const A = emp({ id: 51 }); const B = emp({ id: 52, hireDate: utc('2026-10-20') }); const C = emp({ id: 53 });
  reset({ employee: [A, B, C], attendanceDaily: [day(53, '2026-10-14', 'present')] });
  const dash = (await h.getJson('/api/dashboard')).body;
  const daily = (await h.getJson('/api/attendance/daily?date=2026-10-14')).body;
  assert.equal(dash.absent, 1, 'dashboard: only the started employee with no punch');
  assert.equal(daily.filter((r) => r.isAbsent).length, 1, 'daily agrees');
  assert.equal(dash.present, 1);
});

test('K. reconciliation — one mixed company: list, Excel and final sheet agree row-for-row and net = basic + OT - deductions - advances', async () => {
  const ids = [61, 62, 63, 64, 65, 66];
  const E = [
    emp({ id: 61 }), emp({ id: 62, hireDate: utc('2026-09-10') }), emp({ id: 63, salary: 4500 }),
    emp({ id: 64, status: false, effectiveStopDate: utc('2026-09-20') }), emp({ id: 65, salary: 0 }), emp({ id: 66, salary: 2100 }),
  ];
  const rows = [
    ...present(61, WORKING.filter((d) => d !== 7)),                                         // 1 derived absence
    ...present(62, WORKING.filter((d) => d >= 10 && d !== 14)),                              // pro-rated + 1 derived
    ...present(63, WORKING, { overtimeHours: 1, eveningOvertimeHours: 1 }),                  // 26h OT
    ...present(64, WORKING.filter((d) => d < 20)),
    ...present(65, WORKING),
    ...present(66, WORKING.filter((d) => d !== 3)), day(66, ymd(Y, M, 3), 'absent', { penaltyDays: 0.5 }),
  ];
  reset({ employee: E, attendanceDaily: rows, payroll: ids.map((i) => payrollRow(i)), advance: [{ id: 1, employeeId: 63, month: M, year: Y, amount: 250.25 }] },
    [{ key: 'exclude_stopped_employees_from_payroll', value: 'true' }]);
  const list = (await h.getJson(`/api/payroll?month=${M}&year=${Y}`)).body;
  const xl = await h.getXlsxRows(`/api/reports/payroll/export?month=${M}&year=${Y}`);
  assert.deepEqual(xl.map((r) => r['Employee Code']).sort(), list.map((r) => String(r.employeeId)).sort(), 'same row set');
  let sumList = 0; let sumXl = 0;
  for (const l of list) {
    const x = xl.find((r) => r['Employee Code'] === String(l.employeeId));
    const sheet = (await h.getJson(`/api/payroll/final-sheet?employeeId=${l.employeeId}&month=${M}&year=${Y}`)).body;
    near(x['Basic Salary'], l.basicSalary, `basic ${l.employeeId}`); near(x['Net Salary'], l.netSalary, `net ${l.employeeId}`);
    near(x['Deductions'], l.deductions, `ded ${l.employeeId}`); near(x['OT Amount'], l.overtimeAmount, `ot ${l.employeeId}`);
    assert.equal(x['Absent Days'], l.absentDays, `absent ${l.employeeId}`); assert.equal(x['Work Days'], l.workDays);
    near(sheet.netSalary, l.netSalary, `sheet net ${l.employeeId}`); assert.equal(sheet.attendance.absentDays, l.absentDays, `sheet absent ${l.employeeId}`);
    near(l.netSalary, Math.max(0, l.basicSalary + l.overtimeAmount - l.deductions - l.advances), `identity ${l.employeeId}`);
    sumList += l.netSalary; sumXl += x['Net Salary'];
  }
  near(sumXl, sumList, 'sum of net: Excel vs list');
  // hand-computed spot checks: 61 -> 3000-100 ; 62 -> 3000x21/30=2100, -100 ; 63 -> 4500 + 26h x 18.75 x 1.5 - 250.25 ; 66 -> 2100 - 0.5 x 70
  const byId = (i) => list.find((r) => r.employeeId === i);
  near(byId(61).netSalary, 2900); near(byId(62).netSalary, 2000); near(byId(63).netSalary, 4500 + 26 * 18.75 * 1.5 - 250.25); near(byId(66).netSalary, 2065);
});

test('L. engine-level guards (reached directly, bypassing the callers that pre-filter): unstarted employee gets no payroll; finalized/paid rows are never written', async () => {
  const engine = h.load('engines/payrollEngine');
  const stored = { basicSalary: 3000, hourlyRate: 12.5, workDays: 24, absentDays: 0, deductions: 0, netSalary: 3000 };
  reset({
    employee: [emp({ id: 71, hireDate: utc('2026-10-05') }), emp({ id: 72 }), emp({ id: 73 })],
    attendanceDaily: [...present(72, WORKING.filter((d) => d !== 2)), day(72, ymd(Y, M, 2), 'absent'), ...present(73, WORKING.filter((d) => d !== 2)), day(73, ymd(Y, M, 2), 'absent')],
    payroll: [payrollRow(72, 'finalized', stored), payrollRow(73, 'paid', stored)],
  });
  const none = await engine.calculatePayroll(71, M, Y);
  assert.ok(!none, 'no payroll for an employee hired after the month'); assert.equal(db._tables.payroll.some((p) => p.employeeId === 71), false);
  for (const id of [72, 73]) {
    const r = await engine.calculatePayroll(id, M, Y);
    near(r.netSalary, 3000, `closed row ${id} returned as approved`);
    assert.equal(db._tables.payroll.find((p) => p.employeeId === id).netSalary, 3000);
  }
  assert.deepEqual(db._writeLog.filter((w) => w.model === 'payroll'), [], 'nothing was written to a closed row');
});

test('M. boundary: hired on the LAST day (a past working day, no punches): still part of that month — basic 1/30, and the hire day itself is the one derived absence (approved rule)', async () => {
  reset({ employee: [emp({ id: 81, hireDate: utc('2026-09-30') })], attendanceDaily: [], payroll: [payrollRow(81)] });
  const list = (await h.getJson(`/api/payroll?month=${M}&year=${Y}`)).body;
  assert.equal(list.length, 1, 'listed');
  near(list[0].basicSalary, 100, '3000 x 1/30'); assert.equal(list[0].absentDays, 1); near(list[0].netSalary, 0, '100 - 100, floored at 0');
  const xl = await h.getXlsxRows(`/api/reports/payroll/export?month=${M}&year=${Y}`);
  assert.equal(xl.length, 1);
});
