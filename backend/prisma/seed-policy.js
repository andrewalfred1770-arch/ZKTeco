/**
 * Seed default attendance policy + penalty rules
 * Run: node prisma/seed-policy.js
 */
const { PrismaClient } = require('@prisma/client');
const { DEFAULT_LATE_RULES, DEFAULT_EARLY_CHECKOUT_RULES } = require('../src/engines/policyEngine');

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding default attendance policy...');

  // Create or update default policy
  const existing = await prisma.attendancePolicy.findFirst({ where: { isDefault: true } });

  let policy;
  if (existing) {
    policy = await prisma.attendancePolicy.update({
      where: { id: existing.id },
      data: {
        name:           'السياسة الافتراضية',
        shiftStartTime: '09:00',
        shiftEndTime:   '17:00',
        morningOTStart: '06:00',
        eveningOTEnd:   '23:59',
        otToleranceMin: 10,
        workHoursPerDay: 8,
        isDefault:       true,
      },
    });
    // Delete old rules
    await prisma.penaltyRule.deleteMany({ where: { policyId: policy.id } });
    console.log(`Updated policy: ${policy.name} (ID ${policy.id})`);
  } else {
    policy = await prisma.attendancePolicy.create({
      data: {
        name:           'السياسة الافتراضية',
        description:    'قواعد الحضور والانصراف الافتراضية للشركة',
        shiftStartTime: '09:00',
        shiftEndTime:   '17:00',
        morningOTStart: '06:00',
        eveningOTEnd:   '23:59',
        otToleranceMin: 10,
        workHoursPerDay: 8,
        isDefault:      true,
      },
    });
    console.log(`Created policy: ${policy.name} (ID ${policy.id})`);
  }

  // Seed late penalty rules
  const lateRules = DEFAULT_LATE_RULES.map((r, i) => ({
    policyId:       policy.id,
    type:           'late',
    fromMinute:     r.fromMinute,
    toMinute:       r.toMinute,
    deductionUnits: r.deductionUnits,
    label:          r.label,
    sortOrder:      i,
  }));

  // Seed early checkout rules
  const earlyRules = DEFAULT_EARLY_CHECKOUT_RULES.map((r, i) => ({
    policyId:       policy.id,
    type:           'early_checkout',
    fromMinute:     r.fromMinute,
    toMinute:       r.toMinute,
    deductionUnits: r.deductionUnits,
    label:          r.label,
    sortOrder:      i,
  }));

  await prisma.penaltyRule.createMany({ data: [...lateRules, ...earlyRules] });

  console.log(`Seeded ${lateRules.length} late rules + ${earlyRules.length} early checkout rules`);
  console.log('');
  console.log('Policy summary:');
  console.log(`  Shift:      ${policy.shiftStartTime} → ${policy.shiftEndTime}`);
  console.log(`  Morning OT: from ${policy.morningOTStart}`);
  console.log(`  Evening OT: until ${policy.eveningOTEnd}`);
  console.log(`  Tolerance:  ${policy.otToleranceMin} min`);
  console.log('');
  console.log('✅ Policy seed complete');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
