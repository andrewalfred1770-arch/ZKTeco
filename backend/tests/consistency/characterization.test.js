/**
 * Characterization tests: they PIN current, deliberate-or-undecided behaviour so a later change to it is noticed.
 * They are not "the system is right" tests — each one names the decision it records. See the audit report.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

const { db, emp, day, ymd, utc } = h;
const near = (a, b, msg) => assert.ok(Math.abs(Number(a) - Number(b)) < 0.005, `${msg || 'value'}: expected ${b}, got ${a}`);
const isFriday = (y, m, d) => new Date(ymd(y, m, d) + 'T12:00:00').getDay() === 5;
const working = (y, m, from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i).filter((d) => !isFriday(y, m, d));
const payrollRow = (employeeId, month, year, status = 'draft', over = {}) => ({
  id: 700 + employeeId, employeeId, month, year, status, basicSalary: 0, hourlyRate: 0, workDays: 0, absentDays: 0, latePenalty: 0, penaltyUnits: 0,
  penaltyAmount: 0, overtimeHours: 0, overtimeAmount: 0, advances: 0, manualDeductionAdjustment: 0, deductions: 0, netSalary: 0, ...over,
});
const reset = (seed) => { db._reset({ rule: [], department: [{ id: 1, name: 'D' }], branch: [{ id: 1, name: 'B' }], ...seed }); h.load('services/ruleStore').invalidate(); };

test.before(async () => { h.setNow('2026-10-14T10:00:00'); await h.start(); });
test.after(async () => { await h.stop(); });

test('CHAR-2  INTENTIONAL: in the current month "today" with no row is absent on Movement/Daily/Dashboard (live view) but never counted by payroll/reports', async () => {
  const days = working(2026, 10, 1, 13);                                          // Oct 1..13 worked; today (Wed 14th) has no row yet
  reset({ employee: [emp({ id: 1 })], attendanceDaily: days.map((d) => day(1, ymd(2026, 10, d), 'present')), payroll: [payrollRow(1, 10, 2026)] });
  const mov = (await h.getJson('/api/attendance/movement?employeeId=1&month=2026-10')).body;
  const list = (await h.getJson('/api/payroll?month=10&year=2026')).body[0];
  const monthly = (await h.getJson('/api/attendance/monthly?month=10&year=2026')).body[0];
  assert.equal(mov.summary.absentDays, 1, 'movement: today shown absent');
  assert.equal(list.absentDays, 0, 'payroll: today (still in progress) is never counted');
  assert.equal(monthly.absentDays, 0, 'monthly report: same as payroll');
});

test('CHAR-3  INTENTIONAL: raw monthly columns (hours / late minutes / OT) ignore approved adjustments; effective columns apply them', async () => {
  const sep = working(2026, 9, 1, 30);
  const target = day(1, ymd(2026, 9, 9), 'late', { lateMinutes: 40, latePenaltyUnits: 2, totalDeductionUnits: 2 });
  reset({
    employee: [emp({ id: 1 })], attendanceDaily: [...sep.filter((d) => d !== 9).map((d) => day(1, ymd(2026, 9, d), 'present')), target], payroll: [payrollRow(1, 9, 2026)],
    attendanceAdjustment: [{ id: 1, attendanceDailyId: target.id, employeeId: 1, date: target.date, approvalStatus: 'approved', ignoreLate: true }],
  });
  const monthly = (await h.getJson('/api/attendance/monthly?month=9&year=2026')).body[0];
  const mov = (await h.getJson('/api/attendance/movement?employeeId=1&month=2026-09')).body;
  const sheet = (await h.getJson('/api/payroll/final-sheet?employeeId=1&month=9&year=2026')).body;
  assert.equal(monthly.totalLateMinutes, 40, 'monthly raw late minutes still 40');
  assert.equal(mov.summary.totalLateMinutes, 0, 'movement (adjusted) 0');
  assert.equal(sheet.attendance.totalLateMin, 0, 'final sheet (adjusted) 0');
  near(monthly.totalEffectiveLatePenalty, 0, 'but the PAID late penalty is 0 everywhere');
});

test('CHAR-4  INTENTIONAL: Dashboard counts not-yet-started employees in "total employees"; Daily lists only started ones', async () => {
  reset({ employee: [emp({ id: 1 }), emp({ id: 2, hireDate: utc('2026-10-20') })], attendanceDaily: [day(1, '2026-10-14', 'present')] });
  const dash = (await h.getJson('/api/dashboard')).body;
  const daily = (await h.getJson('/api/attendance/daily?date=2026-10-14')).body;
  assert.equal(dash.totalEmployees, 2); assert.equal(daily.length, 1);
});

test('CHAR-5  hire date on the LAST day of a 30-day month: 29 days precede it => 1/30 of the salary; month_days basis (31-day month hire on the 31st => 0)', async () => {
  reset({ employee: [emp({ id: 1, hireDate: utc('2026-09-30') }), emp({ id: 2, hireDate: utc('2026-10-31') })],
    attendanceDaily: [day(1, '2026-09-30', 'present'), ...working(2026, 10, 31, 31).map((d) => day(2, ymd(2026, 10, d), 'present'))],
    payroll: [payrollRow(1, 9, 2026), payrollRow(2, 10, 2026)] });
  const sep = (await h.getJson('/api/payroll?month=9&year=2026')).body.find((r) => r.employeeId === 1);
  near(sep.basicSalary, 100, '3000 x (30-29)/30');
  h.setNow('2026-11-02T10:00:00');                                               // October has passed
  const oct = (await h.getJson('/api/payroll?month=10&year=2026')).body.find((r) => r.employeeId === 2);
  near(oct.basicSalary, 0, 'month_days=30 basis: 31st hire leaves 30 days before it => 0 paid');
  h.setNow('2026-10-14T10:00:00');
});
