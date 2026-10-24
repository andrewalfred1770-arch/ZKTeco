/**
 * Read-only guarantee: opening payroll pages / reports NEVER changes a stored payroll row (draft, finalized or paid);
 * only an explicit recalculation (POST /payroll/calculate) writes — and it still works, still skips closed rows.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

const { db, emp, day, ymd } = h;
const M = 9; const Y = 2026;
const near = (a, b, msg) => assert.ok(Math.abs(Number(a) - Number(b)) < 0.005, `${msg || 'value'}: expected ${b}, got ${a}`);
const isFri = (d) => new Date(ymd(Y, M, d) + 'T12:00:00').getDay() === 5;
const WORKING = Array.from({ length: 30 }, (_, i) => i + 1).filter((d) => !isFri(d));
const stored = { basicSalary: 3000, hourlyRate: 12.5, workDays: 25, absentDays: 0, deductions: 0, netSalary: 3000 };
const prow = (id, status) => ({ id: 900 + id, employeeId: id, month: M, year: Y, status, latePenalty: 0, penaltyUnits: 0, penaltyAmount: 0, overtimeHours: 0, overtimeAmount: 0, advances: 0, manualDeductionAdjustment: 0, ...stored });
// live truth for every employee: day 8 has no row => 1 derived absence => 2900 (stored snapshots say 3000)
const rows = (id) => WORKING.filter((d) => d !== 8).map((d) => day(id, ymd(Y, M, d), 'present'));

function seed() {
  db._reset({
    rule: [], department: [{ id: 1, name: 'D' }], branch: [{ id: 1, name: 'B' }],
    employee: [emp({ id: 1 }), emp({ id: 2 }), emp({ id: 3 })], attendanceDaily: [...rows(1), ...rows(2), ...rows(3)],
    payroll: [prow(1, 'draft'), prow(2, 'finalized'), prow(3, 'paid')],
  });
  h.load('services/ruleStore').invalidate();
}
const snapshot = () => JSON.stringify(db._tables.payroll.map(({ updatedAt, ...figures }) => figures));   // updatedAt is the only field a repeat recalculation touches
const settle = () => new Promise((r) => setTimeout(r, 150));      // would expose any fire-and-forget background write

test.before(async () => { h.setNow('2026-10-14T10:00:00'); await h.start(); });
test.after(async () => { await h.stop(); });

test('N1. every payroll READ leaves draft, finalized and paid rows byte-identical (zero writes)', async () => {
  seed();
  const before = snapshot();
  const reads = [
    `/api/payroll?month=${M}&year=${Y}`,
    `/api/payroll/1?month=${M}&year=${Y}`, `/api/payroll/2?month=${M}&year=${Y}`, `/api/payroll/3?month=${M}&year=${Y}`,
    `/api/payroll/final-sheet?employeeId=1&month=${M}&year=${Y}`, `/api/payroll/final-sheet?employeeId=2&month=${M}&year=${Y}`, `/api/payroll/final-sheet?employeeId=3&month=${M}&year=${Y}`,
    `/api/payroll/final-sheet/bulk?month=${M}&year=${Y}`,
    `/api/attendance/monthly?month=${M}&year=${Y}`, `/api/attendance/movement?employeeId=1&month=${Y}-09`, '/api/dashboard',
  ];
  for (const u of reads) assert.equal((await h.getJson(u)).status, 200, u);
  await h.getXlsxRows(`/api/reports/payroll/export?month=${M}&year=${Y}`);
  await h.getXlsxRows(`/api/reports/attendance/monthly/export?month=${M}&year=${Y}`);
  await settle();
  assert.deepEqual(db._writeLog, [], 'no write of any kind');
  assert.equal(snapshot(), before, 'stored rows unchanged');
});

test('N2. reads still show the truth: draft live (2900), finalized / paid as approved (3000) — detail, list and sheet agree', async () => {
  seed();
  const list = (await h.getJson(`/api/payroll?month=${M}&year=${Y}`)).body;
  for (const [id, net] of [[1, 2900], [2, 3000], [3, 3000]]) {
    near(list.find((r) => r.employeeId === id).netSalary, net, `list ${id}`);
    const d = (await h.getJson(`/api/payroll/${id}?month=${M}&year=${Y}`)).body;
    near(d.netSalary, net, `detail ${id}`); assert.equal(d.employee.id, id);
    near((await h.getJson(`/api/payroll/final-sheet?employeeId=${id}&month=${M}&year=${Y}`)).body.netSalary, net, `sheet ${id}`);
  }
  assert.equal((await h.getJson(`/api/payroll/1?month=${M}&year=${Y}`)).body.absentDays, 1);
  assert.equal((await h.getJson(`/api/payroll/99?month=${M}&year=${Y}`)).status, 404);
});

test('N3. explicit recalculation works: updates the DRAFT only, never finalized / paid, and is idempotent', async () => {
  seed();
  const closedBefore = JSON.stringify(db._tables.payroll.filter((p) => p.status !== 'draft'));
  const r = await h.postJson('/api/payroll/calculate', { month: M, year: Y });
  assert.equal(r.status, 200);
  near(db._tables.payroll.find((p) => p.employeeId === 1).netSalary, 2900, 'draft persisted');
  assert.equal(db._tables.payroll.find((p) => p.employeeId === 1).absentDays, 1);
  assert.equal(JSON.stringify(db._tables.payroll.filter((p) => p.status !== 'draft')), closedBefore, 'closed rows untouched');
  const once = snapshot();
  await h.postJson('/api/payroll/calculate', { month: M, year: Y });
  await h.postJson('/api/payroll/calculate', { month: M, year: Y, employeeId: 1 });
  assert.equal(snapshot(), once, 'repeat is idempotent');
  assert.equal(db._tables.payroll.length, 3, 'no duplicates');
  const single = await h.postJson('/api/payroll/calculate', { month: M, year: Y, employeeId: 2 });
  assert.equal(single.body.protected, true, 'finalized single-employee recalculation is refused');
});

test('N4. stale drafts stay stale until explicitly recalculated, however many times the pages are opened', async () => {
  seed();
  for (let i = 0; i < 5; i++) { await h.getJson(`/api/payroll?month=${M}&year=${Y}`); await h.getJson(`/api/payroll/1?month=${M}&year=${Y}`); }
  await settle();
  near(db._tables.payroll.find((p) => p.employeeId === 1).netSalary, 3000, 'stored draft still the old snapshot');
  await h.postJson('/api/payroll/calculate', { month: M, year: Y });
  near(db._tables.payroll.find((p) => p.employeeId === 1).netSalary, 2900);
});
