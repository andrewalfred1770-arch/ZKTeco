const router = require('express').Router();
const { sendError } = require('../../utils/apiError');
const { getPrisma } = require('../../utils/prisma');
const { authorize } = require('../../middleware/auth');
const { processDate, processMonth, processToday } = require('../../engines/attendanceEngine');

const prisma = getPrisma();

// Process specific date
router.post('/process', authorize('admin', 'hr'), async (req, res) => {
  try {
    const { date, branchId, employeeId } = req.body;
    if (employeeId) {
      const one = await processDate(new Date(date), parseInt(employeeId));
      const skippedClosedPayroll = [];
      if (one && one.skipped === 'closed-evidence-loss') skippedClosedPayroll.push({ employeeId: one.employeeId, month: one.month, year: one.year, payrollStatus: one.payrollStatus, days: [one.date] });
      return res.json({ message: 'Processing complete', skipped: false, ...(skippedClosedPayroll.length ? { skippedClosedPayroll } : {}) });
    }
    const result = await processToday(branchId ? parseInt(branchId) : null, date ? new Date(date) : null);
    if (result?.skipped) {
      return res.status(409).json({
        error: 'المعالجة قيد التنفيذ بالفعل — لم يتم تنفيذ أي معالجة جديدة',
        skipped: true, reason: result.reason,
      });
    }
    res.json({ message: 'Processing complete', skipped: false, processedCount: result?.processedCount ?? null, ...(result?.skippedClosedPayroll?.length ? { skippedClosedPayroll: result.skippedClosedPayroll } : {}) });
  } catch (err) {
    sendError(res, err);
  }
});

// Process full month
router.post('/process-month', authorize('admin', 'hr'), async (req, res) => {
  try {
    const { year, month, branchId } = req.body;
    const result = await processMonth(parseInt(year), parseInt(month), branchId ? parseInt(branchId) : null);
    // Additive: a day skipped (e.g. its date lock timed out and was rejected) is reported, not hidden.
    res.json({
      message: 'Month processing complete',
      ...(result && result.failedDays > 0 ? { failedDays: result.failedDays } : {}),
      // Additive: closed (finalized/paid) employee-months whose days were left untouched because their raw punches are missing.
      ...(result?.skippedClosedPayroll?.length ? { skippedClosedPayroll: result.skippedClosedPayroll } : {}),
    });
  } catch (err) {
    sendError(res, err);
  }
});

// Raw logs
router.get('/logs', authorize('admin', 'hr'), async (req, res) => {
  try {
    const { employeeId, deviceId, from, to, page = 1, limit = 100 } = req.query;
    const where = {};
    if (employeeId) where.employeeId = parseInt(employeeId);
    if (deviceId) where.deviceId = parseInt(deviceId);
    if (from || to) {
      where.timestamp = {};
      if (from) where.timestamp.gte = new Date(from);
      if (to) where.timestamp.lte = new Date(to);
    }

    const [logs, total] = await Promise.all([
      prisma.attendanceLog.findMany({
        where,
        include: {
          employee: { select: { name: true } },
          device:   { select: { name: true } },
        },
        orderBy: { timestamp: 'desc' },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
      }),
      prisma.attendanceLog.count({ where }),
    ]);

    res.json({ logs, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
