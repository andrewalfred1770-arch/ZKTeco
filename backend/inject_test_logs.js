const { getPrisma } = require('./src/utils/prisma');
const prisma = getPrisma();

async function main() {
  const checkIn  = new Date('2026-06-19T09:30:00.000Z');
  const checkOut = new Date('2026-06-19T17:00:00.000Z');
  
  // Only use fields confirmed available: zkUserId, employeeId, timestamp, deviceId, verifyType, source, isDuplicate
  const r1 = await prisma.attendanceLog.create({ data: { zkUserId:'99992', employeeId:131, timestamp: checkIn,  deviceId:5 } });
  const r2 = await prisma.attendanceLog.create({ data: { zkUserId:'99992', employeeId:131, timestamp: checkOut, deviceId:5 } });
  const r3 = await prisma.attendanceLog.create({ data: { zkUserId:'99993', employeeId:132, timestamp: checkIn,  deviceId:5 } });
  const r4 = await prisma.attendanceLog.create({ data: { zkUserId:'99993', employeeId:132, timestamp: checkOut, deviceId:5 } });
  console.log('OK', r1.id, r2.id, r3.id, r4.id);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e.message); process.exit(1); });
