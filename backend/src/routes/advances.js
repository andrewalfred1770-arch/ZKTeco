const router = require('express').Router();
const { getPrisma } = require('../utils/prisma');
const moment = require('moment');
const { authenticate, authorize } = require('../middleware/auth');
const recalcEngine = require('../engines/recalcEngine');
const { getRules } = require('../engines/rulesEngine');
const { monthRangeMoment } = require('../utils/monthRange');
const logger = require('../utils/logger');
const prisma = getPrisma();
router.use(authenticate);

/** Resolve that month's payroll id (if it exists yet) for the audit row. */
async function payrollIdFor(employeeId, month, year) {
  const payroll = await prisma.payroll.findUnique({
    where: { employeeId_month_year: { employeeId, month, year } },
    select: { id: true },
  });
  return payroll?.id ?? null;
}

/**
 * An advance only changes ONE employee's payroll for ONE month — recalc just that.
 * EF-022.2: previously fire-and-forget with a silent `.catch(() => {})` — the
 * response could reach the client before (or regardless of whether) payroll
 * actually settled, and a failure left no trace anywhere. Now returns its
 * promise so callers await it (consistent with the canonical
 * PUT /api/payroll/:id/advances, which already awaits calculatePayroll before
 * responding), and logs failures instead of discarding them. recalcScope()
 * itself — and the calculation it performs — is unchanged.
 */
function recalcForAdvance(advance, io) {
  if (!advance) return Promise.resolve();
  const { start: monthStart, end: monthEnd } = monthRangeMoment(advance.year, advance.month);
  return recalcEngine.recalcScope({
    from: monthStart.toDate(), to: monthEnd.toDate(),
    employeeId: advance.employeeId, io,
    reason: `سلفة للموظف #${advance.employeeId} (${advance.month}/${advance.year})`,
  }).catch((err) => {
    logger.error(`[PAYROLL-RECALC-FAILED] employee=${advance.employeeId} month=${advance.month} year=${advance.year} source=advance error=${err.message}`);
  });
}

router.get('/', async (req, res) => {
  try {
    const { employeeId, month, year } = req.query;
    const where = {};
    if (employeeId) where.employeeId = parseInt(employeeId);
    if (month) where.month = parseInt(month);
    if (year) where.year = parseInt(year);
    const advances = await prisma.advance.findMany({
      where,
      include: { employee: true },
      orderBy: { date: 'desc' },
    });
    res.json(advances);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', authorize('admin', 'hr'), async (req, res) => {
  try {
    const { employeeId, amount, date, month, year, reason } = req.body;

    // EF-007.4: the old guard only rejected amounts that were too LARGE
    // (`parseFloat(amount) > maxAllowed`) — a negative amount is never
    // greater than a positive maxAllowed, so it silently passed through and
    // became a net addition to pay via recalcForAdvance. NaN similarly
    // failed to trip `NaN > maxAllowed` (always false).
    const amountNum = parseFloat(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'قيمة السلفة يجب أن تكون رقمًا موجبًا' });
    }
    const monthNum = parseInt(month);
    const yearNum = parseInt(year);
    if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) {
      return res.status(400).json({ error: 'الشهر غير صالح' });
    }
    if (!Number.isInteger(yearNum) || yearNum < 2000 || yearNum > 2100) {
      return res.status(400).json({ error: 'السنة غير صالحة' });
    }

    // advance_max_percent: requested amount may not exceed this % of the employee's basic salary
    const employee = await prisma.employee.findUnique({ where: { id: parseInt(employeeId) } });
    if (!employee) return res.status(404).json({ error: 'الموظف غير موجود' });
    const rules = await getRules(employee.branchId, employee.departmentId, employee.id);
    const maxPercent = parseFloat(rules.advance_max_percent || '0');
    if (maxPercent > 0) {
      const maxAllowed = (employee.salary || 0) * (maxPercent / 100);
      if (parseFloat(amount) > maxAllowed) {
        return res.status(400).json({
          error: `السلفة المطلوبة (${parseFloat(amount).toFixed(2)}) تتجاوز الحد الأقصى المسموح (${maxAllowed.toFixed(2)} = ${maxPercent}% من الراتب الأساسي)`,
        });
      }
    }

    const { modifiedBy, modifiedByName, modifiedByRole } = req.body;
    const payrollId = await payrollIdFor(parseInt(employeeId), monthNum, yearNum);

    // EF-007.6: the create and its audit row must commit atomically — a
    // failure between them previously left an unaudited advance (same class
    // of issue already fixed for attendance.js's manual-edit route).
    // writeAudit() itself uses its own singleton client, so it can't join
    // this transaction — inlined here, matching that route's pattern.
    const advance = await prisma.$transaction(async (tx) => {
      const created = await tx.advance.create({
        data: {
          employeeId: parseInt(employeeId),
          amount: amountNum,
          date: new Date(date),
          month: monthNum,
          year: yearNum,
          reason,
          status: 'approved',
        },
        include: { employee: true },
      });
      await tx.manualEditAuditLog.create({
        data: {
          employeeId: created.employeeId, payrollId, fieldName: 'advance',
          oldValue: null, newValue: String(created.amount), reason: created.reason || null,
          modifiedBy: modifiedBy || 0, modifiedByName: modifiedByName || 'HR', modifiedByRole: modifiedByRole || 'hr',
          source: 'inline-grid',
        },
      });
      return created;
    });
    logger.info(`[AUDIT-WRITE] employee=${advance.employeeId} field=advance old=— new=${advance.amount} by=${modifiedByName || 'HR'}${payrollId ? ` payrollId=${payrollId}` : ''}${advance.reason ? ` reason="${advance.reason}"` : ''}`);

    await recalcForAdvance(advance, req.io);
    res.status(201).json(advance);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', authorize('admin', 'hr'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.advance.findUnique({ where: { id } });
    const { modifiedBy, modifiedByName, modifiedByRole, reason } = req.body || {};
    const payrollId = existing ? await payrollIdFor(existing.employeeId, existing.month, existing.year) : null;

    // EF-007.6: delete + audit must commit atomically — see the POST handler above.
    await prisma.$transaction(async (tx) => {
      await tx.advance.delete({ where: { id } });
      if (existing) {
        await tx.manualEditAuditLog.create({
          data: {
            employeeId: existing.employeeId, payrollId, fieldName: 'advance',
            oldValue: String(existing.amount), newValue: null, reason: reason || existing.reason || null,
            modifiedBy: modifiedBy || 0, modifiedByName: modifiedByName || 'HR', modifiedByRole: modifiedByRole || 'hr',
            source: 'inline-grid',
          },
        });
      }
    });
    if (existing) {
      logger.info(`[AUDIT-WRITE] employee=${existing.employeeId} field=advance old=${existing.amount} new=—${payrollId ? ` payrollId=${payrollId}` : ''}`);
    }

    await recalcForAdvance(existing, req.io);
    res.json({ message: 'Advance deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
