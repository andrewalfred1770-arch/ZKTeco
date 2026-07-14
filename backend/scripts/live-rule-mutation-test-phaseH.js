/**
 * live-rule-mutation-test-phaseH.js — closes the loop on half_day_deduction
 * and early_leave_penalty, which were architecturally verified in Phase D/E
 * but produced zero observable payroll delta because dailyRate/hourlyRate
 * are 0 (employee.salary = 0 for all 31 employees — documented separately).
 *
 * Temporarily sets ONE employee's salary to a nonzero test value (Prisma —
 * test fixture, like Phase G's "find a candidate row"), then drives the
 * SAME live rule toggles via the running API + recalculate-full, and
 * reverts everything (rules, salary) at the end.
 *
 * Run with: node scripts/live-rule-mutation-test-phaseH.js
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const BASE = 'http://localhost:5000/api';
const RANGE = { from: '2026-06-01', to: '2026-06-14' };
const EMP_ID = 46;
const TEST_SALARY = 6000;

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json;
}
function log(section, obj) {
  console.log(`\n===== ${section} =====`);
  if (obj !== undefined) console.log(JSON.stringify(obj, null, 2));
}
async function recalc(label) {
  const t0 = Date.now();
  const result = await api('POST', '/rules/recalculate-full', { ...RANGE, employeeId: EMP_ID });
  console.log(`  [recalc:${label}] ${Date.now() - t0}ms ->`, JSON.stringify(result).slice(0, 200));
}
async function payrollSnap() {
  const p = await prisma.payroll.findUnique({ where: { employeeId_month_year: { employeeId: EMP_ID, month: 6, year: 2026 } } });
  return { basicSalary: p.basicSalary, hourlyRate: p.hourlyRate, deductions: p.deductions, latePenalty: p.latePenalty, netSalary: p.netSalary, workDays: p.workDays, absentDays: p.absentDays };
}

async function main() {
  const emp = await prisma.employee.findUnique({ where: { id: EMP_ID }, select: { id: true, name: true, code: true, salary: true, hourlyRate: true } });
  const hdd = await prisma.rule.findUnique({ where: { key: 'half_day_deduction' } });
  const elp = await prisma.rule.findUnique({ where: { key: 'early_leave_penalty' } });

  log('SETUP', { employee: emp, half_day_deduction: { id: hdd.id, value: hdd.value, isActive: hdd.isActive }, early_leave_penalty: { id: elp.id, value: elp.value, isActive: elp.isActive } });

  const stateOriginal = await payrollSnap();
  log('STATE 0 — original (salary=0, rules off)', stateOriginal);

  // ── Step 1: set salary to test value (Prisma — test fixture) ────────────
  await prisma.employee.update({ where: { id: EMP_ID }, data: { salary: TEST_SALARY } });
  await recalc('salary-set');
  const stateSalaryOnly = await payrollSnap();
  log('STATE 1 — salary=6000, rules still off', stateSalaryOnly);

  // ── Step 2: enable half_day_deduction + early_leave_penalty (live API) ──
  await api('PUT', `/rules/${hdd.id}`, { isActive: true, changedByName: 'LIVE-CERT' });
  await api('PUT', `/rules/${elp.id}`, { isActive: true, changedByName: 'LIVE-CERT' });
  await recalc('rules-on');
  const stateRulesOn = await payrollSnap();
  log('STATE 2 — salary=6000, half_day_deduction + early_leave_penalty ACTIVE', stateRulesOn);

  const halfDays = await prisma.attendanceDaily.count({ where: { employeeId: EMP_ID, date: { gte: new Date('2026-06-01'), lte: new Date('2026-06-30') }, status: 'half_day' } });
  const earlyAgg = await prisma.attendanceDaily.aggregate({ where: { employeeId: EMP_ID, date: { gte: new Date('2026-06-01'), lte: new Date('2026-06-30') }, earlyLeaveMinutes: { gt: 0 } }, _sum: { earlyLeaveMinutes: true } });
  const dailyRate = stateRulesOn.basicSalary / 26; // 30 days - 4 Fridays (friday_is_weekend=true)
  const hourlyRate = dailyRate / 8;
  const expectedHalfDay = halfDays * 0.5 * dailyRate;
  const expectedEarlyLeave = (earlyAgg._sum.earlyLeaveMinutes / 60) * 1 * hourlyRate;
  const expectedDelta = expectedHalfDay + expectedEarlyLeave;
  const actualDelta = stateRulesOn.deductions - stateSalaryOnly.deductions;

  log('STATE 2 — formula check', {
    halfDays, earlyLeaveMinutes: earlyAgg._sum.earlyLeaveMinutes,
    dailyRate: +dailyRate.toFixed(4), hourlyRate: +hourlyRate.toFixed(4),
    expectedHalfDayDeduction: +expectedHalfDay.toFixed(2),
    expectedEarlyLeavePenalty: +expectedEarlyLeave.toFixed(2),
    expectedTotalDelta: +expectedDelta.toFixed(2),
    actualDeductionsDelta: +actualDelta.toFixed(2),
    match: Math.abs(expectedDelta - actualDelta) < 0.01,
  });

  // ── Step 3: revert rules ────────────────────────────────────────────────
  await api('PUT', `/rules/${hdd.id}`, { isActive: false, changedByName: 'LIVE-CERT' });
  await api('PUT', `/rules/${elp.id}`, { isActive: false, changedByName: 'LIVE-CERT' });
  await recalc('rules-off');
  const stateRulesOff = await payrollSnap();
  log('STATE 3 — salary=6000, rules reverted to off', { ...stateRulesOff, matchesState1: JSON.stringify(stateRulesOff) === JSON.stringify(stateSalaryOnly) });

  // ── Step 4: revert salary ───────────────────────────────────────────────
  await prisma.employee.update({ where: { id: EMP_ID }, data: { salary: emp.salary } });
  await recalc('salary-revert');
  const stateFinal = await payrollSnap();
  log('STATE 4 — fully reverted (salary back to original)', { ...stateFinal, matchesOriginal: JSON.stringify(stateFinal) === JSON.stringify(stateOriginal) });

  const ruleCheck = await prisma.rule.findMany({ where: { key: { in: ['half_day_deduction', 'early_leave_penalty'] } } });
  log('FINAL — rule state restored', ruleCheck.map(r => ({ key: r.key, value: r.value, isActive: r.isActive })));
}

main().catch(e => { console.error('FATAL', e); process.exit(1); }).finally(() => prisma.$disconnect());
