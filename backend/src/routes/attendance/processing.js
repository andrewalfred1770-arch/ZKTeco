const router = require('express').Router();
const { getPrisma } = require('../../utils/prisma');
const { authorize } = require('../../middleware/auth');
const { processDate, processMonth, processToday } = require('../../engines/attendanceEngine');

const prisma = getPrisma();

// Process specific date
router.post('/process', authorize('admin', 'hr'), async (req, res) => {
  try {
    const { date, branchId, employeeId } = req.body;
    if (employeeId) {
      await processDate(new Date(date), parseInt(employeeId));
      return res.json({ message: 'Processing complete', skipped: false });
    }
    const result = await processToday(branchId ? parseInt(branchId) : null, date ? new Date(date) : null);
    if (result?.skipped) {
      return res.status(409).json({
        error: 'المعالجة قيد التنفيذ بالفعل — لم يتم تنفيذ أي معالجة جديدة',
        skipped: true, reason: result.reason,
      });
    }
    res.json({ message: 'Processing complete', skipped: false, processedCount: result?.processedCount ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Process full month
router.post('/process-month', authorize('admin', 'hr'), async (req, res) => {
  try {
    const { year, month, branchId } = req.body;
    await processMonth(parseInt(year), parseInt(month), branchId ? parseInt(branchId) : null);
    res.json({ message: 'Month processing complete' });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
