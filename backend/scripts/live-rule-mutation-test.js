/**
 * live-rule-mutation-test.js — LIVE RUNTIME RULE-ENFORCEMENT CERTIFICATION.
 *
 * Drives the RUNNING backend (http://localhost:5000) through real PUT/POST
 * calls — same as the Rules UI — so cache invalidation, debounced recalcs,
 * and socket emits all execute in the live server process. Prisma is used
 * ONLY for read-only snapshots/queries (finding test subjects, verifying
 * persisted results). Every mutation is reverted at the end and verified.
 *
 * Run with: node scripts/live-rule-mutation-test.js
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const moment = require('moment');

const BASE = 'http://localhost:5000/api';
const RANGE = { from: '2026-06-01', to: '2026-06-14' };
const FRIDAYS = ['2026-06-05', '2026-06-12'];
const TARGET_KEYS = [
  'weekend_days', 'friday_is_weekend', 'checkin_window_start', 'checkin_window_end',
  'weekend_work_multiplier', 'late_penalty_per_minute', 'half_day_deduction', 'early_leave_penalty',
];

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

async function snapshotDaily() {
  const rows = await prisma.attendanceDaily.findMany({
    where: { date: { gte: new Date(RANGE.from), lte: new Date(RANGE.to) } },
    select: {
      id: true, employeeId: true, date: true, status: true, isWeekend: true, isHoliday: true,
      isAbsent: true, checkIn: true, checkOut: true, workedMinutes: true, lateMinutes: true,
      earlyLeaveMinutes: true, overtimeHours: true, manualEdit: true,
    },
    orderBy: [{ date: 'asc' }, { employeeId: 'asc' }],
  });
  const map = new Map();
  for (const r of rows) map.set(`${r.employeeId}|${moment(r.date).format('YYYY-MM-DD')}`, r);
  return map;
}

async function snapshotPayroll() {
  const rows = await prisma.payroll.findMany({
    where: { month: 6, year: 2026 },
    select: { employeeId: true, latePenalty: true, deductions: true, overtimeAmount: true, netSalary: true, workDays: true, absentDays: true, overtimeHours: true },
    orderBy: { employeeId: 'asc' },
  });
  const map = new Map();
  for (const r of rows) map.set(r.employeeId, r);
  return map;
}

function fridaySummary(dailyMap) {
  const out = [];
  for (const d of FRIDAYS) {
    let weekend = 0, other = 0, statuses = {};
    for (const [k, r] of dailyMap) {
      if (k.endsWith(`|${d}`)) {
        if (r.isWeekend) weekend++; else other++;
        statuses[r.status] = (statuses[r.status] || 0) + 1;
      }
    }
    out.push({ date: d, isWeekendTrue: weekend, isWeekendFalse: other, statuses });
  }
  return out;
}

function diffPayroll(before, after, label) {
  const changed = [];
  for (const [empId, b] of before) {
    const a = after.get(empId);
    if (!a) continue;
    if (b.netSalary !== a.netSalary || b.deductions !== a.deductions || b.latePenalty !== a.latePenalty || b.overtimeAmount !== a.overtimeAmount) {
      changed.push({
        employeeId: empId,
        netSalary: { before: b.netSalary, after: a.netSalary, delta: +(a.netSalary - b.netSalary).toFixed(2) },
        deductions: { before: b.deductions, after: a.deductions, delta: +(a.deductions - b.deductions).toFixed(2) },
        latePenalty: { before: b.latePenalty, after: a.latePenalty },
        overtimeAmount: { before: b.overtimeAmount, after: a.overtimeAmount },
        workDays: { before: b.workDays, after: a.workDays },
        absentDays: { before: b.absentDays, after: a.absentDays },
      });
    }
  }
  log(label, { changedEmployeeCount: changed.length, sample: changed.slice(0, 5) });
  return changed;
}

async function recalc(reasonLabel) {
  const t0 = Date.now();
  const result = await api('POST', '/rules/recalculate-full', { ...RANGE });
  console.log(`  [recalc:${reasonLabel}] ${Date.now() - t0}ms ->`, JSON.stringify(result).slice(0, 300));
  return result;
}

async function main() {
  const report = { startedAt: new Date().toISOString() };

  // ── Load current rule rows for target keys ──────────────────────────────
  const rulesBefore = await prisma.rule.findMany({ where: { key: { in: TARGET_KEYS } } });
  const ruleById = Object.fromEntries(rulesBefore.map(r => [r.key, r]));
  log('BASELINE RULES', rulesBefore.map(r => ({ key: r.key, id: r.id, value: r.value, isActive: r.isActive })));

  // ── Global baseline snapshots ────────────────────────────────────────────
  const baseDaily = await snapshotDaily();
  const basePayroll = await snapshotPayroll();
  log('BASELINE — Friday rows (2026-06-05 / 2026-06-12)', fridaySummary(baseDaily));
  log('BASELINE — payroll sample', [...basePayroll.values()].slice(0, 3));

  // =========================================================================
  // PHASE A — friday_is_weekend  (true -> false -> recalc -> revert -> recalc)
  // =========================================================================
  const fiw = ruleById['friday_is_weekend'];
  log('PHASE A — friday_is_weekend toggle START', { id: fiw.id, before: { value: fiw.value, isActive: fiw.isActive } });

  await api('PUT', `/rules/${fiw.id}`, { value: 'false', changedByName: 'LIVE-CERT' });
  await recalc('A-off');
  const aOffDaily = await snapshotDaily();
  const aOffPayroll = await snapshotPayroll();
  log('PHASE A — AFTER friday_is_weekend=false — Friday rows', fridaySummary(aOffDaily));
  const aOffSample = FRIDAYS.flatMap(d => [...aOffDaily.entries()].filter(([k]) => k.endsWith(`|${d}`)).slice(0, 2).map(([k, r]) => ({ key: k, status: r.status, isWeekend: r.isWeekend, checkIn: r.checkIn, checkOut: r.checkOut, isAbsent: r.isAbsent })));
  log('PHASE A — AFTER friday_is_weekend=false — sample Friday rows', aOffSample);
  diffPayroll(basePayroll, aOffPayroll, 'PHASE A — payroll delta (friday_is_weekend=false)');

  await api('PUT', `/rules/${fiw.id}`, { value: 'true', changedByName: 'LIVE-CERT' });
  await recalc('A-revert');
  const aRevertDaily = await snapshotDaily();
  const aRevertPayroll = await snapshotPayroll();
  log('PHASE A — AFTER REVERT friday_is_weekend=true — Friday rows', fridaySummary(aRevertDaily));

  // Verify revert matches baseline exactly for Friday rows
  let aMismatches = 0;
  for (const d of FRIDAYS) {
    for (const [k, r] of aRevertDaily) {
      if (!k.endsWith(`|${d}`)) continue;
      const b = baseDaily.get(k);
      if (!b || b.status !== r.status || b.isWeekend !== r.isWeekend) aMismatches++;
    }
  }
  diffPayroll(basePayroll, aRevertPayroll, 'PHASE A — payroll delta after revert (should be empty)');
  log('PHASE A — RESULT', { fridayRowMismatchesAfterRevert: aMismatches });

  // =========================================================================
  // PHASE B — checkin_window_end  (12:00 -> 09:00 -> recalc -> revert -> recalc)
  // =========================================================================
  const cwe = ruleById['checkin_window_end'];
  // Find a real row in range with checkIn between 09:01 and 12:00
  let targetRow = null;
  for (const [k, r] of baseDaily) {
    if (!r.checkIn) continue;
    const mins = r.checkIn.getHours() * 60 + r.checkIn.getMinutes();
    if (mins > 9 * 60 && mins <= 12 * 60) { targetRow = { key: k, ...r }; break; }
  }
  log('PHASE B — checkin_window_end toggle START', {
    id: cwe.id, before: { value: cwe.value, isActive: cwe.isActive },
    targetRow: targetRow && { key: targetRow.key, checkIn: targetRow.checkIn, checkOut: targetRow.checkOut, status: targetRow.status },
  });

  await api('PUT', `/rules/${cwe.id}`, { value: '09:00', changedByName: 'LIVE-CERT' });
  await recalc('B-narrow');
  const bNarrowDaily = await snapshotDaily();
  if (targetRow) {
    const after = bNarrowDaily.get(targetRow.key);
    log('PHASE B — AFTER checkin_window_end=09:00 — target row', {
      before: { checkIn: targetRow.checkIn, checkOut: targetRow.checkOut, status: targetRow.status, isAbsent: targetRow.isAbsent },
      after: { checkIn: after.checkIn, checkOut: after.checkOut, status: after.status, isAbsent: after.isAbsent },
    });
  } else {
    log('PHASE B — no row found with checkIn in 09:01-12:00 window in range', null);
  }

  await api('PUT', `/rules/${cwe.id}`, { value: '12:00', changedByName: 'LIVE-CERT' });
  await recalc('B-revert');
  const bRevertDaily = await snapshotDaily();
  if (targetRow) {
    const after = bRevertDaily.get(targetRow.key);
    log('PHASE B — AFTER REVERT checkin_window_end=12:00 — target row', {
      matchesBaseline: after.checkIn?.getTime() === targetRow.checkIn?.getTime() && after.status === targetRow.status,
      after: { checkIn: after.checkIn, checkOut: after.checkOut, status: after.status },
    });
  }

  // =========================================================================
  // PHASE C — late_penalty_per_minute  (disabled,0 -> enabled,1 -> revert)
  // =========================================================================
  const lpm = ruleById['late_penalty_per_minute'];
  // Find employee(s) with late minutes in June
  const lateAgg = await prisma.attendanceDaily.groupBy({
    by: ['employeeId'],
    where: { date: { gte: new Date('2026-06-01'), lte: new Date('2026-06-30') }, lateMinutes: { gt: 0 } },
    _sum: { lateMinutes: true },
  });
  log('PHASE C — late_penalty_per_minute toggle START', {
    id: lpm.id, before: { value: lpm.value, isActive: lpm.isActive },
    employeesWithLateMinutes: lateAgg.map(a => ({ employeeId: a.employeeId, totalLateMinutes: a._sum.lateMinutes })),
  });

  await api('PUT', `/rules/${lpm.id}`, { value: '1', isActive: true, changedByName: 'LIVE-CERT' });
  await recalc('C-enable');
  const cEnablePayroll = await snapshotPayroll();
  const cChanged = diffPayroll(basePayroll, cEnablePayroll, 'PHASE C — payroll delta (late_penalty_per_minute=1, active)');
  log('PHASE C — expected vs actual latePenalty', lateAgg.map(a => {
    const after = cEnablePayroll.get(a.employeeId);
    return { employeeId: a.employeeId, totalLateMinutes: a._sum.lateMinutes, expectedLatePenalty: a._sum.lateMinutes * 1, actualLatePenalty: after?.latePenalty };
  }));

  await api('PUT', `/rules/${lpm.id}`, { value: '0', isActive: false, changedByName: 'LIVE-CERT' });
  await recalc('C-revert');
  const cRevertPayroll = await snapshotPayroll();
  diffPayroll(basePayroll, cRevertPayroll, 'PHASE C — payroll delta after revert (should be empty)');

  // =========================================================================
  // PHASE D — half_day_deduction  (disabled,0.5 -> enabled,0.5 -> revert)
  // =========================================================================
  const hdd = ruleById['half_day_deduction'];
  const halfDayAgg = await prisma.attendanceDaily.groupBy({
    by: ['employeeId'],
    where: { date: { gte: new Date('2026-06-01'), lte: new Date('2026-06-30') }, status: 'half_day' },
    _count: { _all: true },
  });
  log('PHASE D — half_day_deduction toggle START', {
    id: hdd.id, before: { value: hdd.value, isActive: hdd.isActive },
    employeesWithHalfDays: halfDayAgg.map(a => ({ employeeId: a.employeeId, halfDays: a._count._all })),
  });

  await api('PUT', `/rules/${hdd.id}`, { isActive: true, changedByName: 'LIVE-CERT' });
  await recalc('D-enable');
  const dEnablePayroll = await snapshotPayroll();
  diffPayroll(basePayroll, dEnablePayroll, 'PHASE D — payroll delta (half_day_deduction enabled)');

  await api('PUT', `/rules/${hdd.id}`, { isActive: false, changedByName: 'LIVE-CERT' });
  await recalc('D-revert');
  const dRevertPayroll = await snapshotPayroll();
  diffPayroll(basePayroll, dRevertPayroll, 'PHASE D — payroll delta after revert (should be empty)');

  // =========================================================================
  // PHASE E — early_leave_penalty  (disabled,1 -> enabled,1 -> revert)
  // =========================================================================
  const elp = ruleById['early_leave_penalty'];
  const earlyAgg = await prisma.attendanceDaily.groupBy({
    by: ['employeeId'],
    where: { date: { gte: new Date('2026-06-01'), lte: new Date('2026-06-30') }, earlyLeaveMinutes: { gt: 0 } },
    _sum: { earlyLeaveMinutes: true },
  });
  log('PHASE E — early_leave_penalty toggle START', {
    id: elp.id, before: { value: elp.value, isActive: elp.isActive },
    employeesWithEarlyLeave: earlyAgg.map(a => ({ employeeId: a.employeeId, totalEarlyLeaveMinutes: a._sum.earlyLeaveMinutes })),
  });

  await api('PUT', `/rules/${elp.id}`, { isActive: true, changedByName: 'LIVE-CERT' });
  await recalc('E-enable');
  const eEnablePayroll = await snapshotPayroll();
  diffPayroll(basePayroll, eEnablePayroll, 'PHASE E — payroll delta (early_leave_penalty enabled)');

  await api('PUT', `/rules/${elp.id}`, { isActive: false, changedByName: 'LIVE-CERT' });
  await recalc('E-revert');
  const eRevertPayroll = await snapshotPayroll();
  diffPayroll(basePayroll, eRevertPayroll, 'PHASE E — payroll delta after revert (should be empty)');

  // =========================================================================
  // PHASE F — weekend_work_multiplier (non-mutating preview, Friday row)
  // =========================================================================
  const wwm = ruleById['weekend_work_multiplier'];
  const fridayRow = await prisma.attendanceDaily.findFirst({
    where: { date: new Date('2026-06-05'), isWeekend: true },
    orderBy: { employeeId: 'asc' },
  });
  log('PHASE F — weekend_work_multiplier (preview-only) START', {
    id: wwm.id, before: { value: wwm.value, isActive: wwm.isActive },
    fridayRow: fridayRow && { id: fridayRow.id, employeeId: fridayRow.employeeId, date: fridayRow.date, status: fridayRow.status, isWeekend: fridayRow.isWeekend },
  });

  if (fridayRow) {
    const hypothetical = { checkIn: '06:00', checkOut: '20:00', status: 'present' };
    const preview1 = await api('POST', `/attendance/daily/${fridayRow.id}/preview`, hypothetical);
    log('PHASE F — preview #1 (weekend_work_multiplier disabled, value=1.5)', { proposed: preview1.proposed, delta: preview1.delta });

    await api('PUT', `/rules/${wwm.id}`, { value: '3', isActive: true, changedByName: 'LIVE-CERT' });
    const preview2 = await api('POST', `/attendance/daily/${fridayRow.id}/preview`, hypothetical);
    log('PHASE F — preview #2 (weekend_work_multiplier ENABLED, value=3.0)', { proposed: preview2.proposed, delta: preview2.delta });

    log('PHASE F — RESULT', {
      overtimeAmountUnchanged: preview1.proposed.overtimeAmount === preview2.proposed.overtimeAmount,
      explanation: 'Friday rows select fridayOTMultiplier before the isWeekend branch in payrollEngine — weekend_work_multiplier is inert for Friday OT regardless of its value/active state.',
    });

    await api('PUT', `/rules/${wwm.id}`, { value: '1.5', isActive: false, changedByName: 'LIVE-CERT' });
    await recalc('F-revert-noop-check');
    const fRevertPayroll = await snapshotPayroll();
    diffPayroll(basePayroll, fRevertPayroll, 'PHASE F — payroll delta after weekend_work_multiplier revert (should be empty)');
  }

  // =========================================================================
  // PHASE G — manual edit lock + rebuild interplay (Task 8/9/10)
  // =========================================================================
  const candidate = await prisma.attendanceDaily.findFirst({
    where: {
      date: { gte: new Date(RANGE.from), lte: new Date(RANGE.to) },
      checkIn: { not: null }, manualEdit: false,
      status: { in: ['present', 'late', 'early_leave'] },
      isWeekend: false, isHoliday: false,
    },
    orderBy: { id: 'asc' },
  });
  log('PHASE G — manual edit / rebuild START', candidate && {
    id: candidate.id, employeeId: candidate.employeeId, date: candidate.date,
    before: { checkIn: candidate.checkIn, checkOut: candidate.checkOut, status: candidate.status, lateMinutes: candidate.lateMinutes, workedMinutes: candidate.workedMinutes, overtimeHours: candidate.overtimeHours },
  });

  if (candidate) {
    const dateStr = moment(candidate.date).format('YYYY-MM-DD');
    const origCheckIn = moment(candidate.checkIn).format('HH:mm');
    const origCheckOut = candidate.checkOut ? moment(candidate.checkOut).format('HH:mm') : null;
    // Shift checkIn 60 minutes earlier (clamped to >= 00:00) -> visibly different result
    const newCheckIn = moment(candidate.checkIn).subtract(60, 'minutes').format('HH:mm');

    const beforePayrollRow = (await snapshotPayroll()).get(candidate.employeeId);

    const editRes = await api('PUT', `/attendance/daily/${candidate.id}`, {
      checkIn: newCheckIn, checkOut: origCheckOut,
      reason: 'LIVE-CERT manual edit lock test', modifiedByName: 'LIVE-CERT',
    });
    log('PHASE G — AFTER manual edit', {
      checkIn: editRes.checkIn, checkOut: editRes.checkOut, status: editRes.status, lateMinutes: editRes.lateMinutes,
      manualEdit: editRes.manualEdit, payrollNetSalary: editRes.payroll?.netSalary,
    });

    // Rebuild for this single date — should hit isManuallyEdited short-circuit
    const rebuildRes = await api('POST', '/attendance/rebuild', { from: dateStr, to: dateStr });
    log('PHASE G — rebuild triggered', rebuildRes);
    // Give the rebuild job a moment to run (single date x ~31 employees is fast)
    await new Promise(r => setTimeout(r, 4000));
    const rebuildStatus = await api('GET', '/attendance/rebuild-status');
    log('PHASE G — rebuild status', { active: rebuildStatus.active && { status: rebuildStatus.active.status, processedDates: rebuildStatus.active.processedDates }, lastJob: rebuildStatus.lastJob && { id: rebuildStatus.lastJob.id, status: rebuildStatus.lastJob.status, processedDates: rebuildStatus.lastJob.processedDates, processedEmployees: rebuildStatus.lastJob.processedEmployees } });

    const afterRebuild = await prisma.attendanceDaily.findUnique({ where: { id: candidate.id } });
    log('PHASE G — row AFTER rebuild (should be unchanged from manual edit)', {
      checkIn: afterRebuild.checkIn, checkOut: afterRebuild.checkOut, status: afterRebuild.status,
      manualEdit: afterRebuild.manualEdit,
      survivedRebuild: moment(afterRebuild.checkIn).format('HH:mm') === newCheckIn && afterRebuild.manualEdit === true,
    });

    // Restore automatic calculation
    const restoreRes = await api('POST', `/attendance/daily/${candidate.id}/restore-auto`, { reason: 'LIVE-CERT cleanup', modifiedByName: 'LIVE-CERT' });
    log('PHASE G — AFTER restore-auto', {
      checkIn: restoreRes.checkIn, checkOut: restoreRes.checkOut, status: restoreRes.status, lateMinutes: restoreRes.lateMinutes,
      manualEdit: restoreRes.manualEdit, payrollNetSalary: restoreRes.payroll?.netSalary,
      matchesOriginal: moment(restoreRes.checkIn).format('HH:mm') === origCheckIn && restoreRes.status === candidate.status && restoreRes.manualEdit === false,
    });
    log('PHASE G — payroll restored?', { before: beforePayrollRow?.netSalary, after: restoreRes.payroll?.netSalary });
  } else {
    log('PHASE G — no suitable candidate row found', null);
  }

  // =========================================================================
  // FINAL — verify all 8 target rules restored to original {value, isActive}
  // =========================================================================
  const rulesAfter = await prisma.rule.findMany({ where: { key: { in: TARGET_KEYS } } });
  const finalCheck = rulesAfter.map(r => {
    const b = ruleById[r.key];
    return { key: r.key, value: { before: b.value, after: r.value, match: b.value === r.value }, isActive: { before: b.isActive, after: r.isActive, match: b.isActive === r.isActive } };
  });
  log('FINAL — rule restoration check', finalCheck);

  const finalDaily = await snapshotDaily();
  const finalPayroll = await snapshotPayroll();
  log('FINAL — Friday rows', fridaySummary(finalDaily));
  diffPayroll(basePayroll, finalPayroll, 'FINAL — payroll delta vs original baseline (should be empty)');

  log('DONE', { finishedAt: new Date().toISOString() });
}

main().catch(e => { console.error('FATAL', e); process.exit(1); }).finally(() => prisma.$disconnect());
