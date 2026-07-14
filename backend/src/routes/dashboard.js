const router = require('express').Router();
const { getPrisma } = require('../utils/prisma');
const moment = require('moment');
const { applyApprovedAdjustment } = require('../engines/payrollEngine');
const { mergeEffectivePenalty } = require('../engines/attendanceEngine');
const { authenticate } = require('../middleware/auth');

const prisma = getPrisma();

// Production/LAN endpoint — read-only aggregation, but must still require a
// valid session like every other data route. No-op when AUTH_ENABLED=false.
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const { branchId } = req.query;
    const today = new Date(moment().format('YYYY-MM-DD'));

    const empWhere = { status: true };
    if (branchId) empWhere.branchId = parseInt(branchId);

    // Core counts
    const [totalEmployees, devices, todayRecords] = await Promise.all([
      prisma.employee.count({ where: empWhere }),
      prisma.device.findMany({ where: { isArchived: false, ...(branchId ? { branchId: parseInt(branchId) } : {}) } }),
      prisma.attendanceDaily.findMany({
        where: { date: today, employee: empWhere },
        include: { employee: { select: { name: true } } },
      }),
    ]);

    // Effective late-penalty units — Policy Engine canonical units, post
    // approved-adjustment overlay and manual-override layer. This is the
    // single source of truth for "late" status, never raw lateMinutes.
    const todayAdjustments = await prisma.attendanceAdjustment.findMany({
      where: {
        attendanceDailyId: { in: todayRecords.map(r => r.id) },
        approvalStatus: 'approved',
      },
    });
    const todayAdjByDailyId = new Map(todayAdjustments.map(a => [a.attendanceDailyId, a]));
    const effTodayRecords = todayRecords.map(r =>
      mergeEffectivePenalty(applyApprovedAdjustment(r, todayAdjByDailyId.get(r.id))));

    const present  = todayRecords.filter(r =>
      ['present', 'late', 'early_leave'].includes(r.status)
    ).length;
    const absent   = todayRecords.filter(r => r.isAbsent).length;
    const late     = effTodayRecords.filter(r => (r.effectiveLatePenalty || 0) > 0).length;
    const overtime = effTodayRecords.filter(r => (r.effectiveOvertimeUnits || 0) > 0).length;
    const onTime   = effTodayRecords.filter(r => r.status === 'present' && (r.effectiveLatePenalty || 0) === 0).length;

    // Weekly data — count present and absent per day (last 7 days)
    const weekStart = moment().subtract(6, 'days').startOf('day').toDate();
    const weekRecords = await prisma.attendanceDaily.findMany({
      where: {
        date: { gte: weekStart, lte: today },
        employee: empWhere,
        isWeekend: false,
        isHoliday: false,
      },
      select: { date: true, isAbsent: true, status: true },
    });

    const weeklyData = [];
    for (let i = 6; i >= 0; i--) {
      const d = moment().subtract(i, 'days');
      const dateStr = d.format('YYYY-MM-DD');
      const dayRecs = weekRecords.filter(r => moment(r.date).format('YYYY-MM-DD') === dateStr);
      weeklyData.push({
        date:    dateStr,
        day:     d.format('ddd'),
        present: dayRecs.filter(r => !r.isAbsent).length,
        absent:  dayRecs.filter(r => r.isAbsent).length,
      });
    }

    // Late employees today
    const lateToday = effTodayRecords
      .filter(r => (r.effectiveLatePenalty || 0) > 0)
      .map(r => ({ name: r.employee.name, latePenaltyUnits: r.effectiveLatePenalty }))
      .slice(0, 5);

    // OT employees today
    const otToday = effTodayRecords
      .filter(r => (r.effectiveOvertimeUnits || 0) > 0)
      .map(r => ({ name: r.employee.name, effectiveOvertimeUnits: r.effectiveOvertimeUnits }))
      .slice(0, 5);

    res.json({
      totalEmployees, present, absent, late, overtime, onTime,
      devices: {
        total:   devices.length,
        online:  devices.filter(d => d.status === 'online').length,
        offline: devices.filter(d => d.status === 'offline').length,
      },
      weeklyData,
      lateToday,
      otToday,
      lastUpdated: new Date(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
