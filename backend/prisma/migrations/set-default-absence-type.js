/**
 * One-time migration: set absenceType = 'with_permission' for all absent
 * records that have no absenceType set yet.
 *
 * Safe to run multiple times (idempotent) — the WHERE clause ensures only
 * records with absenceType IS NULL are touched; 'without_permission' and
 * already-set 'with_permission' records are never modified.
 */

'use strict';

const { getPrisma } = require('../../src/utils/prisma');

async function run() {
  const prisma = getPrisma();

  const result = await prisma.$transaction(async (tx) => {
    const { count } = await tx.attendanceDaily.updateMany({
      where: {
        status:      'absent',
        absenceType: null,
      },
      data: {
        absenceType: 'with_permission',
      },
    });
    return count;
  });

  console.log('Records updated:', result);

  const remaining = await prisma.attendanceDaily.count({
    where: { status: 'absent', absenceType: null },
  });
  console.log('Remaining absent+null absenceType:', remaining);

  await prisma.$disconnect();
}

run().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
