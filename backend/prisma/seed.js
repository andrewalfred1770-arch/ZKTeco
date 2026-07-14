const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const moment = require('moment');

const prisma = new PrismaClient();

// ─── Demo data ────────────────────────────────────────────────────────────────
const EMPLOYEES = [
  { name: 'أحمد محمد السيد',     zkUserId: '1',  code: 'EMP-001', position: 'مدير عام',        salary: 12000 },
  { name: 'محمد علي حسن',        zkUserId: '2',  code: 'EMP-002', position: 'محاسب أول',        salary: 8500  },
  { name: 'فاطمة أحمد إبراهيم',  zkUserId: '3',  code: 'EMP-003', position: 'مساعد إداري',      salary: 6000  },
  { name: 'عمر خالد مصطفى',      zkUserId: '4',  code: 'EMP-004', position: 'مهندس إنتاج',      salary: 9000  },
  { name: 'سارة محمود عبد الله', zkUserId: '5',  code: 'EMP-005', position: 'محاسب',            salary: 7000  },
  { name: 'يوسف إبراهيم عمر',    zkUserId: '6',  code: 'EMP-006', position: 'فني صيانة',        salary: 5500  },
  { name: 'نور الدين أحمد',       zkUserId: '7',  code: 'EMP-007', position: 'مشرف إنتاج',      salary: 7500  },
  { name: 'ليلى حسن محمد',       zkUserId: '8',  code: 'EMP-008', position: 'سكرتيرة',          salary: 5000  },
  { name: 'كريم علي عبد الرحمن', zkUserId: '9',  code: 'EMP-009', position: 'مندوب مبيعات',    salary: 6500  },
  { name: 'رانيا مصطفى السيد',   zkUserId: '10', code: 'EMP-010', position: 'مدير مالي',        salary: 11000 },
  { name: 'طارق محمود خالد',     zkUserId: '11', code: 'EMP-011', position: 'مهندس جودة',       salary: 8000  },
  { name: 'دينا أحمد عمر',       zkUserId: '12', code: 'EMP-012', position: 'محاسبة',           salary: 6800  },
  { name: 'حسام إبراهيم محمد',   zkUserId: '13', code: 'EMP-013', position: 'مساعد مهندس',      salary: 5800  },
  { name: 'مريم خالد السيد',     zkUserId: '14', code: 'EMP-014', position: 'موظفة استقبال',    salary: 4500  },
  { name: 'أنس محمد علي',        zkUserId: '15', code: 'EMP-015', position: 'سائق',              salary: 4000  },
];

const RULES = [
  { ruleKey: 'work_start',              ruleValue: '09:00', description: 'وقت بداية الدوام' },
  { ruleKey: 'work_end',                ruleValue: '17:00', description: 'وقت نهاية الدوام' },
  { ruleKey: 'late_grace',              ruleValue: '20',    description: 'فترة سماح التأخير (دقيقة)' },
  { ruleKey: 'overtime_rounding',       ruleValue: '50',    description: 'وحدة احتساب الإضافي: كل 50 دقيقة = ساعة' },
  { ruleKey: 'overtime_minimum',        ruleValue: '50',    description: 'الحد الأدنى للإضافي (دقيقة)' },
  { ruleKey: 'overtime_multiplier',     ruleValue: '1.5',   description: 'معامل راتب الإضافي' },
  { ruleKey: 'overtime_cap_hours',      ruleValue: '0',     description: 'الحد الأقصى للإضافي يومياً (0=بلا حد)' },
  { ruleKey: 'weekend_days',            ruleValue: '5,6',   description: 'أيام الإجازة الأسبوعية (5=جمعة، 6=سبت)' },
  { ruleKey: 'late_penalty_per_minute', ruleValue: '0',     description: 'غرامة التأخير لكل دقيقة' },
  { ruleKey: 'early_leave_grace',       ruleValue: '0',     description: 'سماح الانصراف المبكر (دقيقة)' },
];

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateAttendance(empIndex, date, workStart = '09:00', workEnd = '17:00') {
  const dayOfWeek = date.day(); // 0=Sun, 5=Fri, 6=Sat
  if (dayOfWeek === 5 || dayOfWeek === 6) return { isWeekend: true, status: 'weekend', isAbsent: false };

  // 8% absence rate
  if (Math.random() < 0.08) return { isAbsent: true, status: 'absent', isWeekend: false };

  const [sh, sm] = workStart.split(':').map(Number);
  const [eh, em] = workEnd.split(':').map(Number);

  // Late check-in (30% chance of being late)
  const isLate = Math.random() < 0.30;
  const lateMinutes = isLate ? randomBetween(1, 60) : 0;
  const checkInHour   = sh + Math.floor((sm + lateMinutes) / 60);
  const checkInMinute = (sm + lateMinutes) % 60;

  // Overtime (40% chance)
  const hasOT = Math.random() < 0.40;
  const otMinutes = hasOT ? randomBetween(50, 180) : randomBetween(0, 49);

  const checkOutHour   = eh + Math.floor((em + otMinutes) / 60);
  const checkOutMinute = (em + otMinutes) % 60;

  const workedMinutes = (checkOutHour * 60 + checkOutMinute) - (checkInHour * 60 + checkInMinute);
  const overtimeMinutes = Math.max(0, (checkOutHour * 60 + checkOutMinute) - (eh * 60 + em));
  // OT rule: every 50 minutes = 1 hour
  const overtimeHours = Math.floor(overtimeMinutes / 50);

  const checkIn = date.clone().hour(checkInHour).minute(checkInMinute).second(0);
  const checkOut = date.clone().hour(checkOutHour).minute(checkOutMinute).second(0);

  return {
    checkIn: checkIn.toDate(),
    checkOut: checkOut.toDate(),
    workedMinutes: Math.max(0, workedMinutes),
    lateMinutes: isLate ? lateMinutes : 0,
    overtimeMinutes,
    overtimeHours,
    earlyLeaveMinutes: 0,
    isAbsent: false,
    isWeekend: false,
    status: lateMinutes > 20 ? 'late' : 'present',
    manualEdit: false,
  };
}

// ─── Main seed ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('🌱 Seeding database...');

  // Company
  const company = await prisma.company.upsert({
    where: { id: 1 },
    update: { name: 'شركة الأفق للتجارة والصناعة' },
    create: { name: 'شركة الأفق للتجارة والصناعة', address: 'القاهرة، مصر', phone: '02-12345678' },
  });
  console.log(`✓ Company: ${company.name}`);

  // Branches
  const branch1 = await prisma.branch.upsert({
    where: { id: 1 },
    update: { name: 'المقر الرئيسي' },
    create: { name: 'المقر الرئيسي', companyId: company.id, address: 'مدينة نصر، القاهرة' },
  });
  const branch2 = await prisma.branch.upsert({
    where: { id: 2 },
    update: { name: 'فرع الإسكندرية' },
    create: { name: 'فرع الإسكندرية', companyId: company.id, address: 'المنتزه، الإسكندرية' },
  });
  console.log(`✓ Branches: ${branch1.name}, ${branch2.name}`);

  // Departments
  const depts = [
    { id: 1, name: 'الإدارة العامة',  branchId: branch1.id },
    { id: 2, name: 'المالية والحسابات', branchId: branch1.id },
    { id: 3, name: 'الإنتاج والتشغيل', branchId: branch1.id },
    { id: 4, name: 'المبيعات والتسويق', branchId: branch2.id },
  ];
  const deptMap = {};
  for (const d of depts) {
    const dept = await prisma.department.upsert({
      where: { id: d.id }, update: { name: d.name },
      create: { name: d.name, branchId: d.branchId },
    });
    deptMap[d.id] = dept;
  }
  console.log(`✓ Departments: ${Object.values(deptMap).map(d => d.name).join(', ')}`);

  // Shifts
  const shift1 = await prisma.shift.upsert({
    where: { id: 1 }, update: { name: 'الشيفت الصباحي' },
    create: { name: 'الشيفت الصباحي', startTime: '09:00', endTime: '17:00', gracePeriod: 20, workingHours: 8 },
  });
  const shift2 = await prisma.shift.upsert({
    where: { id: 2 }, update: { name: 'الشيفت المسائي' },
    create: { name: 'الشيفت المسائي', startTime: '14:00', endTime: '22:00', gracePeriod: 15, workingHours: 8 },
  });
  const shift3 = await prisma.shift.upsert({
    where: { id: 3 }, update: { name: 'شيفت إداري' },
    create: { name: 'شيفت إداري', startTime: '08:00', endTime: '16:00', gracePeriod: 30, workingHours: 8 },
  });
  console.log(`✓ Shifts: ${shift1.name}, ${shift2.name}, ${shift3.name}`);

  // Attendance rules
  await prisma.attendanceRule.deleteMany({});
  for (const rule of RULES) {
    await prisma.attendanceRule.create({ data: rule });
  }
  console.log(`✓ Attendance rules: ${RULES.length} rules`);

  // Demo device
  await prisma.device.upsert({
    where: { id: 1 }, update: { name: 'جهاز المدخل الرئيسي' },
    create: {
      name: 'جهاز المدخل الرئيسي', ipAddress: '192.168.1.201',
      port: 4370, branchId: branch1.id, status: 'offline', enabled: true,
    },
  });
  console.log(`✓ Device added`);

  // Employees
  const empBranchDept = [
    { branchId: branch1.id, departmentId: deptMap[1].id, shiftId: shift3.id },
    { branchId: branch1.id, departmentId: deptMap[2].id, shiftId: shift1.id },
    { branchId: branch1.id, departmentId: deptMap[1].id, shiftId: shift3.id },
    { branchId: branch1.id, departmentId: deptMap[3].id, shiftId: shift1.id },
    { branchId: branch1.id, departmentId: deptMap[2].id, shiftId: shift1.id },
    { branchId: branch1.id, departmentId: deptMap[3].id, shiftId: shift2.id },
    { branchId: branch1.id, departmentId: deptMap[3].id, shiftId: shift2.id },
    { branchId: branch1.id, departmentId: deptMap[1].id, shiftId: shift3.id },
    { branchId: branch2.id, departmentId: deptMap[4].id, shiftId: shift1.id },
    { branchId: branch1.id, departmentId: deptMap[2].id, shiftId: shift3.id },
    { branchId: branch1.id, departmentId: deptMap[3].id, shiftId: shift1.id },
    { branchId: branch1.id, departmentId: deptMap[2].id, shiftId: shift1.id },
    { branchId: branch1.id, departmentId: deptMap[3].id, shiftId: shift2.id },
    { branchId: branch2.id, departmentId: deptMap[4].id, shiftId: shift1.id },
    { branchId: branch1.id, departmentId: deptMap[1].id, shiftId: shift3.id },
  ];

  const createdEmployees = [];
  for (let i = 0; i < EMPLOYEES.length; i++) {
    const empData = EMPLOYEES[i];
    const loc = empBranchDept[i];
    const hourlyRate = +(empData.salary / (22 * 8)).toFixed(2);

    const emp = await prisma.employee.upsert({
      where: { code: empData.code },
      update: { name: empData.name, salary: empData.salary },
      create: {
        name: empData.name, zkUserId: empData.zkUserId, code: empData.code,
        position: empData.position, salary: empData.salary, hourlyRate,
        branchId: loc.branchId, departmentId: loc.departmentId, shiftId: loc.shiftId,
        status: true,
      },
    });
    createdEmployees.push({ emp, shift: loc.shiftId === shift1.id ? shift1 : (loc.shiftId === shift2.id ? shift2 : shift3) });
  }
  console.log(`✓ Employees: ${createdEmployees.length} created`);

  // Generate attendance logs and daily records for last 45 days
  console.log('Generating attendance data for last 45 days...');
  const today = moment().startOf('day');
  const device = await prisma.device.findFirst();

  let logsCreated = 0;
  let dailyCreated = 0;

  for (let i = 44; i >= 0; i--) {
    const date = today.clone().subtract(i, 'days');
    const dateStr = date.format('YYYY-MM-DD');

    for (let eIdx = 0; eIdx < createdEmployees.length; eIdx++) {
      const { emp, shift } = createdEmployees[eIdx];
      const att = generateAttendance(eIdx, date, shift.startTime, shift.endTime);

      // Create attendance_daily record
      try {
        await prisma.attendanceDaily.upsert({
          where: { employeeId_date: { employeeId: emp.id, date: new Date(dateStr) } },
          update: {},
          create: {
            employeeId: emp.id,
            date: new Date(dateStr),
            checkIn:           att.checkIn || null,
            checkOut:          att.checkOut || null,
            workedMinutes:     att.workedMinutes || 0,
            lateMinutes:       att.lateMinutes || 0,
            overtimeMinutes:   att.overtimeMinutes || 0,
            overtimeHours:     att.overtimeHours || 0,
            earlyLeaveMinutes: 0,
            isAbsent:          att.isAbsent || false,
            isWeekend:         att.isWeekend || false,
            isHoliday:         false,
            status:            att.status || 'present',
            manualEdit:        false,
          },
        });
        dailyCreated++;
      } catch {}

      // Create raw attendance logs (check-in and check-out)
      if (att.checkIn && device) {
        try {
          await prisma.attendanceLog.upsert({
            where: { deviceId_zkUserId_timestamp: { deviceId: device.id, zkUserId: emp.zkUserId, timestamp: att.checkIn } },
            update: {},
            create: { employeeId: emp.id, deviceId: device.id, zkUserId: emp.zkUserId, timestamp: att.checkIn, verifyType: 1, source: 'seed' },
          });
          logsCreated++;
        } catch {}

        if (att.checkOut) {
          try {
            await prisma.attendanceLog.upsert({
              where: { deviceId_zkUserId_timestamp: { deviceId: device.id, zkUserId: emp.zkUserId, timestamp: att.checkOut } },
              update: {},
              create: { employeeId: emp.id, deviceId: device.id, zkUserId: emp.zkUserId, timestamp: att.checkOut, verifyType: 1, source: 'seed' },
            });
            logsCreated++;
          } catch {}
        }
      }
    }
  }
  console.log(`✓ Attendance: ${dailyCreated} daily records, ${logsCreated} raw logs`);

  // Generate payroll for current month
  const currentMonth = today.month() + 1;
  const currentYear  = today.year();

  for (const { emp } of createdEmployees) {
    const records = await prisma.attendanceDaily.findMany({
      where: {
        employeeId: emp.id,
        date: {
          gte: moment(`${currentYear}-${String(currentMonth).padStart(2,'0')}-01`).toDate(),
          lte: moment(`${currentYear}-${String(currentMonth).padStart(2,'0')}-01`).endOf('month').toDate(),
        },
      },
    });

    const workDays  = records.filter(r => !r.isAbsent && !r.isWeekend && !r.isHoliday).length;
    const absentDays = records.filter(r => r.isAbsent).length;
    const totalOTHours = records.reduce((s, r) => s + (r.overtimeHours || 0), 0);
    const totalLateMin = records.reduce((s, r) => s + (r.lateMinutes  || 0), 0);

    const workingDaysInMonth = 22;
    const dailyRate  = emp.salary / workingDaysInMonth;
    const hourlyRate = emp.hourlyRate || +(emp.salary / (workingDaysInMonth * 8)).toFixed(2);
    const otAmount   = +(totalOTHours * hourlyRate * 1.5).toFixed(2);
    const absentDeduction = +(absentDays * dailyRate).toFixed(2);
    const netSalary  = +(emp.salary + otAmount - absentDeduction).toFixed(2);

    try {
      await prisma.payroll.upsert({
        where: { employeeId_month_year: { employeeId: emp.id, month: currentMonth, year: currentYear } },
        update: {},
        create: {
          employeeId: emp.id, month: currentMonth, year: currentYear,
          basicSalary: emp.salary, hourlyRate, workDays, absentDays,
          latePenalty: 0, overtimeHours: totalOTHours, overtimeAmount: otAmount,
          bonus: 0, advances: 0, deductions: absentDeduction, netSalary,
        },
      });
    } catch {}
  }
  console.log(`✓ Payroll generated for ${currentMonth}/${currentYear}`);

  // Summary
  console.log('');
  console.log('══════════════════════════════════════════');
  console.log('✅ Seed complete!');
  console.log(`   Employees:  ${createdEmployees.length}`);
  console.log(`   Attendance: ${dailyCreated} records (45 days)`);
  console.log(`   Raw logs:   ${logsCreated}`);
  console.log(`   Payroll:    ${createdEmployees.length} employees`);
  console.log('══════════════════════════════════════════');
}

main()
  .catch(e => { console.error('❌ Seed error:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
