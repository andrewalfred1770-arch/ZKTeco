const express = require('express');
const { getPrisma } = require('../utils/prisma');
const { authorize } = require('../middleware/auth');

const router  = express.Router();
const prisma  = getPrisma();

// GET /api/audit-logs
// Query: employeeId, from, to, field, source, page (default 1), limit (default 50)
router.get('/', authorize('admin', 'hr'), async (req, res) => {
  try {
    const { employeeId, from, to, field, source, page = 1, limit = 50 } = req.query;

    const where = {};
    if (employeeId) where.employeeId = parseInt(employeeId);
    if (field)      where.fieldName  = { contains: field };
    if (source)     where.source     = source;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to)   where.createdAt.lte = new Date(new Date(to).setHours(23, 59, 59, 999));
    }

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const take  = parseInt(limit);

    const [total, rows] = await Promise.all([
      prisma.manualEditAuditLog.count({ where }),
      prisma.manualEditAuditLog.findMany({
        where,
        include: { employee: { select: { name: true, code: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
    ]);

    res.json({
      total,
      page:  parseInt(page),
      pages: Math.ceil(total / take),
      rows:  rows.map(r => ({
        id:              r.id,
        employeeId:      r.employeeId,
        employeeName:    r.employee?.name || '',
        employeeCode:    r.employee?.code || '',
        attendanceDailyId: r.attendanceDailyId,
        payrollId:       r.payrollId,
        fieldName:       r.fieldName,
        oldValue:        r.oldValue,
        newValue:        r.newValue,
        reason:          r.reason,
        modifiedByName:  r.modifiedByName,
        modifiedByRole:  r.modifiedByRole,
        source:          r.source,
        createdAt:       r.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
