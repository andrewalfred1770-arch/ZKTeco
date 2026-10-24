/**
 * mutation.js — hand-written mutation testing for the consistency suite.
 * Copies backend/src to a scratch directory (NEVER mutates the working tree), applies ONE mutation at a time, runs the suite against the
 * copy via CONSISTENCY_SRC, and reports whether the suite noticed (killed) or not (survived).
 *
 *   node tests/consistency/mutation.js <scratchDir>
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..', '..', 'src');
const scratch = path.resolve(process.argv[2] || '');
if (!process.argv[2] || scratch.startsWith(path.resolve(path.join(__dirname, '..', '..')))) { console.error('usage: node mutation.js <scratch dir OUTSIDE the repo>'); process.exit(2); }

const MUTATIONS = [
  ['payrollEngine.js', 'derived absence priced at 2 days', 'engines/payrollEngine.js', 'derivedAbsentDays * AUTOMATIC_ABSENCE_PENALTY_DAYS', 'derivedAbsentDays * 2'],
  ['payrollEngine.js', 'derived absences not counted in absentDays', 'engines/payrollEngine.js', 'records.filter(r => r.isAbsent).length + derivedAbsentDays;', 'records.filter(r => r.isAbsent).length;'],
  ['payrollEngine.js', 'paid OT hours = raw overtimeHours', 'engines/payrollEngine.js', 'sum + (r.effectiveOvertimeUnits ?? r.overtimeHours ?? 0), 0);', 'sum + (r.overtimeHours ?? 0), 0);'],
  ['payrollEngine.js', 'net ignores advances', 'engines/payrollEngine.js', 'basicSalary + overtimeAmount - deductions - totalAdvances', 'basicSalary + overtimeAmount - deductions'],
  ['payrollEngine.js', 'no start-of-employment guard', 'engines/payrollEngine.js', 'if (!opts.precomputed) {\n    const empRow', 'if (false) {\n    const empRow'],
  ['payrollEngine.js', 'paid payroll not write-protected', 'engines/payrollEngine.js', "CLOSED_PAYROLL_STATUSES = Object.freeze(['finalized', 'paid'])", "CLOSED_PAYROLL_STATUSES = Object.freeze(['finalized'])"],
  ['payrollEngine.js', 'manual deduction not preserved', 'engines/payrollEngine.js', 'const manualDeductionAdjustment = existingPayroll?.manualDeductionAdjustment || 0;', 'const manualDeductionAdjustment = 0;'],
  ['payrollPeriod.js', 'today counted as absent', 'utils/payrollPeriod.js', 'if (ds >= today) break;', 'if (ds > today) break;'],
  ['payrollPeriod.js', 'proration over 31 days', 'utils/payrollPeriod.js', '(md - preHireDays) / md', '(md - preHireDays) / 31'],
  ['payrollPeriod.js', 'Friday not excluded', 'utils/payrollPeriod.js', 'getDay() === 5 || isWeekendDay(ds)', 'isWeekendDay(ds)'],
  ['payrollPeriod.js', 'holidays not excluded', 'utils/payrollPeriod.js', 'if (isHolidayOn(ds, employee.branchId)) continue;', ''],
  ['payrollPeriod.js', 'stop date ignored', 'utils/payrollPeriod.js', 'if (stop && ds >= stop) continue;', ''],
  ['payrollPeriod.js', 'hire date ignored', 'utils/payrollPeriod.js', 'if (hire && ds < hire) continue;', ''],
  ['absencePolicy.js', 'automatic absence = 2 days', 'utils/absencePolicy.js', 'const AUTOMATIC_ABSENCE_PENALTY_DAYS = 1;', 'const AUTOMATIC_ABSENCE_PENALTY_DAYS = 2;'],
  ['dayClassification.js', 'branch holiday applied to every branch', 'utils/dayClassification.js', "(dateStr, branchId) => all.has(dateStr) || (branchId !== null && branchId !== undefined && !!byBranch.get(branchId) && byBranch.get(branchId).has(dateStr))", "(dateStr, branchId) => all.has(dateStr) || [...byBranch.values()].some((s) => s.has(dateStr))"],
  ['dayClassification.js', 'post-stop days become absences', 'utils/dayClassification.js', 'if ((stop && dateStr >= stop) || (stopped && !stop)) {', 'if (false) {'],
  ['dayClassification.js', 'pre-hire days become absences', 'utils/dayClassification.js', 'return h !== null && dateStr < h;', 'return false;'],
  ['payroll.js', 'final sheet shows stored-rows-only absences', 'routes/payroll.js', 'const absentDays = computed.absentDays;', 'const absentDays = storedAbsentDays;'],
  ['monthly.js', 'monthly report omits derived absences', 'routes/attendance/monthly.js', "+ countDerivedAbsences({ employee: emp, month: m, year: y, rawRecords: records, rules: rulesByEmployee.get(emp.id), holidayRows: monthHolidays });", ';'],
  ['reports.js', 'monthly Excel omits derived absences', 'routes/reports.js', "+ countDerivedAbsences({ employee: emp, month: m, year: y, rawRecords: records, rules: rulesByEmployee.get(emp.id), holidayRows: monthHolidays });", ';'],
  ['reports.js', 'payroll Excel ignores approved (closed) rows', 'routes/reports.js', 'const c = displayedFigures(p, fresh[i]);', 'const c = fresh[i];'],
  ['reports.js', 'payroll Excel lists every row', 'routes/reports.js', 'const filtered = await selectListablePayrolls(prisma, allForMonth, m, y, await getRules());', 'const filtered = allForMonth;'],
  ['payrollListScope.js', 'paid rows treated as open', 'utils/payrollListScope.js', "s === 'finalized' || s === 'paid'", "s === 'finalized'"],
  ['payrollListScope.js', 'stopped-employee rule disabled', 'utils/payrollListScope.js', 'if (stoppedEmployeeFilterEnabled) {', 'if (false) {'],
  ['payrollListScope.js', 'unstarted drafts listed', 'utils/payrollListScope.js', 'if (unstarted.length) {', 'if (false) {'],
  ['movement.js', 'movement ignores Friday for rowless days', 'routes/attendance/movement.js', 'isWeekendDay: dayDate.getDay() === 5 || isWeekend(dayDate, rules.weekend_days),', 'isWeekendDay: isWeekend(dayDate, rules.weekend_days),'],
  ['movement.js', 'movement ignores configured weekend', 'routes/attendance/movement.js', 'isWeekendDay: dayDate.getDay() === 5 || isWeekend(dayDate, rules.weekend_days),', 'isWeekendDay: dayDate.getDay() === 5,'],
  ['attendanceRow.js', 'rowless absent day gets no penalty days', 'utils/attendanceRow.js', 'penaltyDays: isWeekendOrHoliday ? null : (rowIsAbsent ? effectiveAbsencePenaltyDays(merged || {})', 'penaltyDays: isWeekendOrHoliday ? null : (rowIsAbsent ? (merged ? effectiveAbsencePenaltyDays(merged) : 0)'],
  ['dashboard.js', 'dashboard counts unstarted employee absent', 'routes/dashboard.js', 'missingDay: classifyToday && !effByEmployeeId.has(emp.id) ? classifyToday(emp) : null', 'missingDay: null'],
  ['employmentEligibility.js', 'hire on last day treated as not started', 'utils/employmentEligibility.js', "if (hire.format('YYYY-MM-DD') <= moment(period.to).format('YYYY-MM-DD')) return true;", "if (hire.format('YYYY-MM-DD') < moment(period.to).format('YYYY-MM-DD')) return true;"],
  ['payroll.js', 'final sheet writes on read', 'routes/payroll.js', 'const computed = await computePayroll(eId, m, y);', 'const { computed } = await syncStoredPayroll(eId, m, y);'],
  ['payroll.js', 'detail returns stale stored draft', 'routes/payroll.js', 'res.json({ ...payroll, ...live });', 'res.json(payroll);'],
  ['payroll.js', 'detail writes on read', 'routes/payroll.js', "res.json({ ...payroll, ...live });", "await syncStoredPayroll(employeeId, m, y); res.json({ ...payroll, ...live });"],
  ['payrollEngine.js', 'helper ignores holidays', 'engines/payrollEngine.js', 'isHolidayOn: holidayOn,', 'isHolidayOn: () => false,'],
  ['attendanceEngine.js', 'engine ignores the manual lock', 'engines/attendanceEngine.js', 'if (!manual && !opts.restoreAuto && await isManuallyEdited(employeeId, dateStr)) {', 'if (false) {'],
  ['attendanceEngine.js', 'unnamed time re-read from logs not the row', 'engines/attendanceEngine.js', ': (manual && before ? before.checkIn : logCheckIn);', ': logCheckIn;'],
  ['attendanceEngine.js', 'manual late override ignored', 'engines/attendanceEngine.js', ': (hasManualLate  ? record.manualLatePenaltyUnits  : baseLat);', ': baseLat;'],
  ['manual.js', 'no-op saves still lock and audit', 'routes/attendance/manual.js', 'if (fresh && isNoopManualSave(', 'if (false && isNoopManualSave('],
  ['manual.js', 'manual edit not atomic (engine write outside tx)', 'routes/attendance/manual.js', '{ manual, tx, lockHeld: true }', '{ manual, lockHeld: true }'],
  ['manual.js', 'closed payroll recalculated by manual edit', 'routes/attendance/manual.js', 'const { allowed, protectedTargets } = await filterProtectedPayrollTargets([{ employeeId, month, year }]);', 'const protectedTargets = [];'],
  ['attendanceEngine.js', 'restore-auto skipped by the lock again', 'engines/attendanceEngine.js', 'if (!manual && !opts.restoreAuto && await isManuallyEdited', 'if (!manual && await isManuallyEdited'],
  ['attendanceEngine.js', 'restore does not clear the lock', 'engines/attendanceEngine.js', 'const unlock = opts.restoreAuto && !manual ? { manualEdit: false } : {};', 'const unlock = {};'],
  ['manual.js', 'restore unlocks in a separate step first', 'routes/attendance/manual.js', '{ lockHeld: true, restoreAuto: true }', '{ lockHeld: true, restoreAuto: true, __x: await prisma.attendanceDaily.update({ where: { id: rec.id }, data: { manualEdit: false } }) }'],
  ['lockedPunchConflict.js', 'review time = any later write again', 'utils/lockedPunchConflict.js', 'row && row.timesReviewedAt ? new Date(row.timesReviewedAt).getTime() : null;', 'row && (row.updatedAt || row.timesReviewedAt) ? new Date(row.updatedAt || row.timesReviewedAt).getTime() : null;'],
  ['manualEditAudit.js', 'any audited field counts as a time review', 'utils/manualEditAudit.js', 'where: { attendanceDailyId: { in: recordIds }, fieldName: { in: PUNCH_TIME_FIELDS } },', 'where: { attendanceDailyId: { in: recordIds } },'],
];

function run(srcRoot) {
  const r = spawnSync(process.execPath, ['--test', path.join(__dirname, 'cross-page.test.js'), path.join(__dirname, 'characterization.test.js'), path.join(__dirname, 'readonly.test.js'), path.join(__dirname, 'manual-edit.test.js'), path.join(__dirname, 'manual-restore-review.test.js')], {
    env: { ...process.env, TZ: 'Asia/Riyadh', CONSISTENCY_SRC: srcRoot }, encoding: 'utf8', cwd: path.join(__dirname, '..', '..'),
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const fail = Number((out.match(/ℹ fail (\d+)/) || [])[1] ?? NaN);
  const pass = Number((out.match(/ℹ pass (\d+)/) || [])[1] ?? NaN);
  const firstFail = (out.match(/^✖ ([^\n(]+)/m) || [])[1];
  return { fail, pass, firstFail, crashed: Number.isNaN(fail) };
}

fs.rmSync(scratch, { recursive: true, force: true });
let killed = 0; let survived = 0; const survivors = [];
const base = path.join(scratch, 'baseline');
fs.cpSync(SRC, base, { recursive: true });
const b = run(base);
console.log(`baseline (unmutated copy): pass=${b.pass} fail=${b.fail}`);
if (b.fail !== 0 || b.crashed) { console.error('baseline is not green — aborting'); process.exit(1); }

MUTATIONS.forEach(([file, name, rel, from, to], i) => {
  const dir = path.join(scratch, `m${i}`);
  fs.cpSync(SRC, dir, { recursive: true });
  const target = path.join(dir, rel);
  const text = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
  const count = text.split(from).length - 1;
  if (count !== 1) { console.log(`?? #${i + 1} ${name}: snippet found ${count}x in ${rel} — mutation NOT applied`); survivors.push(`#${i + 1} (not applied)`); return; }
  fs.writeFileSync(target, text.replace(from, () => to));
  const r = run(dir);
  const dead = r.crashed || r.fail > 0;
  if (dead) killed++; else { survived++; survivors.push(`#${i + 1} ${name}`); }
  console.log(`${dead ? 'KILLED  ' : 'SURVIVED'} #${String(i + 1).padStart(2)} ${file.padEnd(24)} ${name}${dead ? `   (${r.crashed ? 'crash' : r.fail + ' failing'}: ${(r.firstFail || '').slice(0, 40)})` : ''}`);
  fs.rmSync(dir, { recursive: true, force: true });
});
console.log(`\nmutants: ${MUTATIONS.length}  killed: ${killed}  survived/not-applied: ${survived + (MUTATIONS.length - killed - survived)}`);
if (survivors.length) console.log('survivors:\n  ' + survivors.join('\n  '));
