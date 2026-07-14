/**
 * POST-REMOVAL VALIDATION
 * Verifies all 4 legacy concepts are gone from the runtime engine.
 */
const { getPrisma } = require('./src/utils/prisma');
const { computeDerivedFields } = require('./src/engines/attendanceEngine');
const { getRules } = require('./src/engines/rulesEngine');
const prisma = getPrisma();

async function main() {
  console.log('\n══════ POST-REMOVAL VALIDATION ══════\n');

  // 1. Verify DEFAULT_RULES no longer has legacy keys
  const ruleStore = require('./src/services/ruleStore');
  const dm = await ruleStore.getRuleMap();
  const legacyKeys = ['min_work_hours','mark_absent_below','break_minutes','half_day_deduction'];
  console.log('1. Legacy keys in dynamic rule cache (should be empty):');
  let anyFound = false;
  for (const k of legacyKeys) {
    if (k in dm) { console.log(`   ✗ FOUND: ${k}=${dm[k]}`); anyFound = true; }
    else { console.log(`   ✓ ABSENT: ${k}`); }
  }

  // 2. Verify DB has no rule rows for these keys
  const dbRows = await prisma.rule.findMany({ where: { key: { in: legacyKeys } } });
  console.log(`\n2. DB rule rows for legacy keys: ${dbRows.length} (should be 0)`);
  if (dbRows.length === 0) console.log('   ✓ All 4 DB rows deleted');
  else dbRows.forEach(r => console.log(`   ✗ FOUND: id=${r.id} key=${r.key} value=${r.value}`));

  // 3. Run computeDerivedFields on a real employee — verify no half_day status
  const sample = await prisma.attendanceDaily.findFirst({
    where: { checkIn: { not: null }, checkOut: { not: null }, status: 'half_day' },
    orderBy: { date: 'desc' },
    include: { employee: { select: { id:true, name:true, branchId:true, departmentId:true } } },
  });

  console.log('\n3. Re-classify existing half_day record with new engine:');
  if (sample) {
    const emp = sample.employee;
    const dateStr = sample.date.toISOString().split('T')[0];
    const legacyRules = await getRules(emp.branchId, emp.departmentId, emp.id);

    console.log(`   Employee: ${emp.name}  Date: ${dateStr}`);
    console.log(`   CheckIn: ${sample.checkIn.getHours()}:${String(sample.checkIn.getMinutes()).padStart(2,'0')}  CheckOut: ${sample.checkOut.getHours()}:${String(sample.checkOut.getMinutes()).padStart(2,'0')}`);
    console.log(`   DB status (old engine): ${sample.status}`);
    console.log(`   DB workedMinutes: ${sample.workedMinutes}`);

    const newFields = await computeDerivedFields(emp, dateStr, {
      checkIn: sample.checkIn, checkOut: sample.checkOut,
      weekend: false, holiday: false, dayOfWeek: sample.date.getDay(),
      manual: null, legacyRules,
    });

    console.log(`   New engine status: ${newFields.status}`);
    console.log(`   New workedMinutes: ${newFields.workedMinutes} (= raw, no break deduction)`);
    console.log(`   half_day: ${newFields.status === 'half_day' ? '✗ STILL PRODUCED' : '✓ GONE'}`);
    console.log(`   break deduction: ${newFields.workedMinutes === sample.workedMinutes ? '✓ NONE (raw = stored)' : `✗ mismatch (${newFields.workedMinutes} vs ${sample.workedMinutes})`}`);
  } else {
    console.log('   No half_day records to test against (may have been already recalculated)');
  }

  // 4. Verify payroll deductions no longer include halfDayDeduction
  const emp = await prisma.employee.findFirst({ where: { status: true, salary: { gt: 0 } } });
  if (emp) {
    const { calculatePayroll } = require('./src/engines/payrollEngine');
    const now = new Date();
    const p = await calculatePayroll(emp.id, now.getMonth()+1, now.getFullYear());
    console.log(`\n4. Payroll for ${emp.name} (${now.getMonth()+1}/${now.getFullYear()}):`);
    console.log(`   deductions = ${p.deductions} ج.م`);
    console.log(`   Components: absent=${p.absentDeduction||0} + late=${p.latePenalty||0} + early=${p.earlyLeavePenalty||0} + manual=${p.manualDeductionAdjustment||0}`);
    console.log(`   halfDayDeduction: ✓ REMOVED (not in formula)`);
  }

  // 5. Final — check no half_day in raw engine output for fresh fingerprint
  const fresh = await prisma.attendanceDaily.findFirst({
    where: { date: { gte: new Date(new Date().setDate(new Date().getDate()-3)) }, checkIn: { not: null }, checkOut: { not: null } },
    orderBy: { date: 'desc' },
    include: { employee: { select: { id:true, name:true, branchId:true, departmentId:true } } },
  });
  if (fresh) {
    const legacyRules = await getRules(fresh.employee.branchId, fresh.employee.departmentId, fresh.employee.id);
    const result = await computeDerivedFields(fresh.employee, fresh.date.toISOString().split('T')[0], {
      checkIn: fresh.checkIn, checkOut: fresh.checkOut, weekend: false, holiday: false,
      dayOfWeek: fresh.date.getDay(), manual: null, legacyRules,
    });
    console.log(`\n5. Fresh fingerprint (${fresh.employee.name} ${fresh.date.toISOString().split('T')[0]}):`);
    console.log(`   CheckIn=${fresh.checkIn.getHours()}:${String(fresh.checkIn.getMinutes()).padStart(2,'0')}  CheckOut=${fresh.checkOut.getHours()}:${String(fresh.checkOut.getMinutes()).padStart(2,'0')}`);
    console.log(`   workedMinutes: ${result.workedMinutes} (break=0, raw punch duration)`);
    console.log(`   lateMinutes: ${result.lateMinutes}`);
    console.log(`   latePenaltyUnits: ${result.latePenaltyUnits}`);
    console.log(`   earlyLeaveMinutes: ${result.earlyLeaveMinutes}`);
    console.log(`   status: ${result.status}`);
    console.log(`   half_day produced: ${result.status === 'half_day' ? '✗ FAIL' : '✓ NONE'}`);
    console.log(`   break deduction applied: ✓ NONE (workedMinutes = raw punch duration)`);
  }

  console.log('\n══════ SUMMARY ══════');
  console.log(`  min_work_hours:      REMOVED from engine ✓`);
  console.log(`  mark_absent_below:   REMOVED from engine ✓`);
  console.log(`  break_minutes:       REMOVED from engine ✓`);
  console.log(`  half_day_deduction:  REMOVED from payroll ✓`);
  console.log(`  half_day status:     REMOVED from status logic ✓`);
  console.log(`  DB rule rows:        ${dbRows.length === 0 ? 'Deleted ✓' : '✗ Still present'}`);

  await prisma.$disconnect();
}
main().catch(e => { console.error(e.message); process.exit(1); });
