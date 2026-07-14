const http = require('http');
const { PrismaClient } = require('@prisma/client');

async function httpReq(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: 5000, path, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload ? Buffer.byteLength(payload) : 0 }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function main() {
  const prisma = new PrismaClient();
  console.log('=== SECTION 1: Per-policy lateMinutes fix ===');

  const empCode = 'DEF01_' + Date.now();
  let emp, pol;

  try {
    emp = await prisma.employee.create({
      data: { name: 'DefectTest01', code: empCode, zkUserId: 'def01', status: true, salary: 6000 }
    });
    console.log('Created employee:', emp.id);

    pol = await prisma.attendancePolicy.create({
      data: { name: 'Shift10_' + Date.now(), shiftStartTime: '10:00', shiftEndTime: '18:00', morningOTStart: '07:00', eveningOTEnd: '23:59', otToleranceMin: 10, workHoursPerDay: 8 }
    });
    await prisma.employeePolicy.create({ data: { employeeId: emp.id, policyId: pol.id } });
    console.log('Policy 10:00 shift assigned, policy id:', pol.id);

    // checkIn=09:30 (30 min BEFORE 10:00 shift → should NOT be late)
    // checkOut=17:00 (1 hr BEFORE 18:00 shift end → earlyLeaveMinutes=60)
    await prisma.attendanceLog.create({ data: { employeeId: emp.id, timestamp: new Date('2026-06-18T09:30:00'), source: 'test', isDuplicate: false } });
    await prisma.attendanceLog.create({ data: { employeeId: emp.id, timestamp: new Date('2026-06-18T17:00:00'), source: 'test', isDuplicate: false } });
    console.log('Logs injected: 09:30 in, 17:00 out on 2026-06-18 (Thursday)');

    const r = await httpReq('POST', '/api/attendance/process', { date: '2026-06-18', employeeId: emp.id });
    console.log('Process:', r.status, JSON.stringify(r.body));

    await new Promise(res => setTimeout(res, 2000));
    const daily = await prisma.attendanceDaily.findUnique({
      where: { employeeId_date: { employeeId: emp.id, date: new Date('2026-06-18T00:00:00') } }
    });

    if (daily) {
      const passLate   = daily.lateMinutes === 0;
      const passStatus = daily.status === 'present' || daily.status === 'early_leave';
      const passEarly  = daily.earlyLeaveMinutes === 60;
      const passPenalty = daily.latePenaltyUnits === 0;
      console.log('\n--- Daily Record ---');
      console.log('lateMinutes:',      daily.lateMinutes,      '→', passLate   ? 'PASS(expect 0)'  : 'FAIL');
      console.log('status:',           daily.status,           '→', passStatus ? 'PASS'            : 'FAIL');
      console.log('earlyLeaveMinutes:',daily.earlyLeaveMinutes,'→', passEarly  ? 'PASS(expect 60)' : 'FAIL');
      console.log('latePenaltyUnits:',  daily.latePenaltyUnits, '→', passPenalty? 'PASS(expect 0)'  : 'FAIL');
      console.log('workedMinutes:',     daily.workedMinutes);
      const all = passLate && passStatus && passEarly && passPenalty;
      console.log('\n=== RESULT:', all ? '4/4 PASS — DEFECT-01 FIXED' : 'FAIL', '===');
    } else {
      console.log('ERROR: no daily record');
    }
  } finally {
    if (emp) {
      await prisma.attendanceLog.deleteMany({ where: { employeeId: emp.id } });
      await prisma.attendanceDaily.deleteMany({ where: { employeeId: emp.id } });
      await prisma.employeePolicy.deleteMany({ where: { employeeId: emp.id } });
      if (pol) await prisma.attendancePolicy.delete({ where: { id: pol.id } }).catch(() => {});
      await prisma.employee.delete({ where: { id: emp.id } }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}
main().catch(console.error);
