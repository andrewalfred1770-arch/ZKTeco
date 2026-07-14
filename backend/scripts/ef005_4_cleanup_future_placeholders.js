/**
 * EF-005.4 Phase 3 — One-time cleanup of future-dated AttendanceDaily
 * placeholder rows created by the pre-fix processMonth() bug.
 *
 * Deletes ONLY rows that are unambiguously empty placeholders:
 *   - date > today
 *   - checkIn = null, checkOut = null, workedMinutes = 0, manualEdit = false
 *   - manualLatePenaltyUnits/manualEarlyPenaltyUnits/manualConditionUnits/
 *     manualOvertimeUnits all null (no HR override ever applied)
 *   - zero AttendanceAdjustment rows referencing it
 *   - zero ManualEditAuditLog rows referencing it (the most conservative
 *     signal — if anything was ever audited against this row, it is
 *     preserved regardless of its current field values)
 *
 * Any future row that fails ANY of the above checks is preserved and
 * reported separately with the specific reason.
 *
 * SAFE BY DEFAULT: runs in DRY-RUN mode unless --execute is passed.
 * Usage:
 *   node scripts/ef005_4_cleanup_future_placeholders.js            # dry run, no writes
 *   node scripts/ef005_4_cleanup_future_placeholders.js --execute  # actually deletes
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const EXECUTE = process.argv.includes('--execute');

async function main() {
  const today = new Date(new Date().toISOString().split('T')[0]); // today, midnight UTC

  const futureRows = await prisma.attendanceDaily.findMany({
    where: { date: { gt: today } },
  });

  const futureIds = futureRows.map(r => r.id);
  const adjustedIds = new Set(
    (await prisma.attendanceAdjustment.findMany({
      where: { attendanceDailyId: { in: futureIds } },
      select: { attendanceDailyId: true },
    })).map(r => r.attendanceDailyId)
  );
  const auditedIds = new Set(
    (await prisma.manualEditAuditLog.findMany({
      where: { attendanceDailyId: { in: futureIds } },
      select: { attendanceDailyId: true },
    })).map(r => r.attendanceDailyId)
  );

  const toDelete = [];
  const preserved = [];

  for (const r of futureRows) {
    const reasons = [];
    if (r.checkIn !== null) reasons.push('has checkIn');
    if (r.checkOut !== null) reasons.push('has checkOut');
    if (r.workedMinutes > 0) reasons.push('workedMinutes > 0');
    if (r.manualEdit) reasons.push('manualEdit=true');
    if (r.manualLatePenaltyUnits !== null) reasons.push('manualLatePenaltyUnits set');
    if (r.manualEarlyPenaltyUnits !== null) reasons.push('manualEarlyPenaltyUnits set');
    if (r.manualConditionUnits !== null) reasons.push('manualConditionUnits set');
    if (r.manualOvertimeUnits !== null) reasons.push('manualOvertimeUnits set');
    if (adjustedIds.has(r.id)) reasons.push('has an AttendanceAdjustment');
    if (auditedIds.has(r.id)) reasons.push('has a ManualEditAuditLog entry');

    if (reasons.length) {
      preserved.push({ id: r.id, employeeId: r.employeeId, date: r.date.toISOString().split('T')[0], reasons });
    } else {
      toDelete.push(r.id);
    }
  }

  console.log(`Rows scanned:   ${futureRows.length}`);
  console.log(`Rows to delete: ${toDelete.length}`);
  console.log(`Rows preserved: ${preserved.length}`);
  console.log('');
  console.log('Preserved rows and why:');
  for (const p of preserved) {
    console.log(`  id=${p.id} employeeId=${p.employeeId} date=${p.date} — ${p.reasons.join(', ')}`);
  }

  if (!EXECUTE) {
    console.log('');
    console.log('DRY RUN — no rows deleted. Re-run with --execute to actually delete the', toDelete.length, 'placeholder rows.');
    await prisma.$disconnect();
    return;
  }

  const result = await prisma.attendanceDaily.deleteMany({ where: { id: { in: toDelete } } });
  console.log('');
  console.log(`Deleted ${result.count} placeholder rows.`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
