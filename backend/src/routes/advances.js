const router = require('express').Router();
const { sendError, numericIdParam } = require('../utils/apiError');
router.param('id', numericIdParam);
const { getPrisma } = require('../utils/prisma');
const { modifier } = require('../utils/auditActor');
const moment = require('moment');
const { authenticate, authorize } = require('../middleware/auth');
const recalcEngine = require('../engines/recalcEngine');
const { withPayrollKeyLock, syncStoredPayroll } = require('../engines/payrollEngine');
const { monthRangeMoment } = require('../utils/monthRange');
const logger = require('../utils/logger');
const { parseMoney, hasMoneyPrecision } = require('../utils/numeric');
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
  }).then(async (result) => {
    // recalcScope deliberately skips finalized/paid payrolls (indirect cascades never overwrite
    // a closed row), so for those the stored snapshot would still hold the OLD advances/net
    // until some later read repaired it. Advances ARE allowed after close, so bring the stored
    // row in line with the canonical figures before this request reports completion. This is
    // the existing write-through (syncStoredPayroll: one computation under the payroll lock,
    // writes only if something differs, never changes status) — no new write path, no formula.
    // Draft rows were already written by recalcScope, so they are not recomputed here.
    const row = await prisma.payroll.findUnique({
      where: { employeeId_month_year: { employeeId: advance.employeeId, month: advance.month, year: advance.year } },
      select: { status: true },
    });
    if (row && (row.status === 'finalized' || row.status === 'paid')) {
      const s = await syncStoredPayroll(advance.employeeId, advance.month, advance.year, { allowClosed: true });
      if (s && s.lockTimeout) logger.warn(`[PAYROLL-SYNC] employee=${advance.employeeId} ${advance.month}/${advance.year} source=advance — payroll lock busy, stored ${row.status} row left for the next read to repair`);
    }
    return result;
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
  } catch (err) { sendError(res, err); }
});

router.post('/', authorize('admin', 'hr'), async (req, res) => {
  try {
    const { employeeId, amount, date, month, year, reason } = req.body;

    // EF-007.4: the amount must be a real, strictly positive number — a negative
    // or NaN value would otherwise become a net ADDITION to pay via
    // recalcForAdvance. There is deliberately no upper business limit (F-04).
    const amountNum = parseMoney(amount);
    if (amountNum === null && parseMoney(amount, { max: Number.MAX_VALUE }) !== null) {
      // Not a business cap: beyond MAX_MONEY (utils/numeric.js) the value can no longer be
      // summed/stored as a DOUBLE amount without precision loss or Infinity.
      return res.status(400).json({ error: 'قيمة السلفة خارج النطاق الرقمي المدعوم تقنيًا', code: 'ADVANCE_NUMERIC_RANGE' });
    }
    if (amountNum === null || amountNum <= 0) {
      return res.status(400).json({ error: 'قيمة السلفة يجب أن تكون رقمًا موجبًا' });
    }
    // F-11: money is stored to the cent everywhere else (Payroll, Excel); a
    // third decimal here would be silently invisible in every total.
    if (!hasMoneyPrecision(amountNum)) {
      return res.status(400).json({ error: 'قيمة السلفة يجب ألا تتجاوز خانتين عشريتين', code: 'ADVANCE_PRECISION' });
    }
    const monthNum = Number(month);
    const yearNum = Number(year);
    if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) {
      return res.status(400).json({ error: 'الشهر غير صالح' });
    }
    if (!Number.isInteger(yearNum) || yearNum < 2000 || yearNum > 2100) {
      return res.status(400).json({ error: 'السنة غير صالحة' });
    }
    if (!/^\d{1,10}$/.test(String(employeeId)) || parseInt(employeeId) < 1) {
      return res.status(400).json({ error: 'معرّف الموظف غير صالح', code: 'INVALID_ID' });
    }
    // F-11: the advance date must be a real date and must fall inside the payroll
    // month/year it is charged to. (Entering an advance AFTER that payroll was
    // finalized/paid is still allowed — only a date that belongs to a different
    // period is rejected.)
    const dm = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || ''));
    const advDate = dm ? new Date(Date.UTC(+dm[1], +dm[2] - 1, +dm[3])) : null;
    if (!advDate || Number.isNaN(advDate.getTime()) || advDate.getUTCMonth() !== +dm[2] - 1) {
      return res.status(400).json({ error: 'تاريخ السلفة غير صالح', code: 'ADVANCE_DATE_INVALID' });
    }
    if (advDate.getUTCFullYear() !== yearNum || advDate.getUTCMonth() + 1 !== monthNum) {
      return res.status(400).json({ error: 'تاريخ السلفة لا يقع ضمن شهر/سنة الراتب المحددين', code: 'ADVANCE_PERIOD_MISMATCH' });
    }

    // F-04: there is NO business limit on advances (no per-advance, monthly,
    // yearly, count or %-of-salary cap). The employee only has to exist.
    const employee = await prisma.employee.findUnique({ where: { id: parseInt(employeeId) }, select: { id: true } });
    if (!employee) return res.status(404).json({ error: 'الموظف غير موجود' });

    const { modifiedBy, modifiedByName, modifiedByRole } = modifier(req);

    // EF-007.6: the create and its audit row must commit atomically — a
    // failure between them previously left an unaudited advance (same class
    // of issue already fixed for attendance.js's manual-edit route).
    // writeAudit() itself uses its own singleton client, so it can't join
    // this transaction — inlined here, matching that route's pattern.
    // Monthly scoping: an employee's advances for ONE payroll month are a single
    // monthly total, and the Payroll-grid edit ("desired total for this month")
    // computes its delta from that total under the employee-month payroll lock.
    // This write takes the SAME lock (the existing one, keyed employee+month+year), so a
    // grid edit can never read the total, miss an advance committed meanwhile, and then
    // audit/apply a stale delta. The recalculation below runs AFTER the lock is released
    // (calculatePayroll takes the same lock).
    let payrollId = null;
    const advance = await withPayrollKeyLock(parseInt(employeeId), monthNum, yearNum, async () => {
     payrollId = await payrollIdFor(parseInt(employeeId), monthNum, yearNum);
     return prisma.$transaction(async (tx) => {
      const created = await tx.advance.create({
        data: {
          employeeId: parseInt(employeeId),
          amount: amountNum,
          date: advDate,
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
    });
    logger.info(`[AUDIT-WRITE] employee=${advance.employeeId} field=advance old=— new=${advance.amount} by=${modifiedByName || 'HR'}${payrollId ? ` payrollId=${payrollId}` : ''}${advance.reason ? ` reason="${advance.reason}"` : ''}`);

    await recalcForAdvance(advance, req.io);
    res.status(201).json(advance);
  } catch (err) { sendError(res, err); }
});

router.delete('/:id', authorize('admin', 'hr'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.advance.findUnique({ where: { id } });
    const { reason } = req.body || {};
    const { modifiedBy, modifiedByName, modifiedByRole } = modifier(req);
    let payrollId = null;

    // EF-007.6: delete + audit must commit atomically — see the POST handler above.
    // Same employee-month payroll lock as POST and the Payroll-grid edit (monthly total consistency).
    const runDelete = () => prisma.$transaction(async (tx) => {
      // The Payroll grid lowers a month's total by adding a NEGATIVE delta row, so a month's rows can
      // legitimately be e.g. [+1000, -600] (total 400). Deleting the +1000 row on its own would leave
      // [-600]: a negative monthly total that INCREASES pay above salary. Inside this same payroll lock
      // and transaction (so no other advance write can slip in between), refuse a delete that would
      // leave the month's total below zero. Nothing is written: no delete, no audit, no recalculation.
      if (existing) {
        const current = await tx.advance.findUnique({ where: { id } });
        if (current) {
          const agg = await tx.advance.aggregate({ _sum: { amount: true }, where: { employeeId: current.employeeId, month: current.month, year: current.year } });
          const remaining = (agg._sum.amount || 0) - current.amount;
          if (Math.round(remaining * 100) < 0) {
            const err = new Error('لا يمكن حذف السلفة لأن ذلك سيؤدي إلى إجمالي سلف سالب للشهر');
            err.statusCode = 409;
            err.code = 'ADVANCE_NEGATIVE_TOTAL';
            throw err;
          }
        }
      }
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
      await withPayrollKeyLock(existing.employeeId, existing.month, existing.year, async () => {
        payrollId = await payrollIdFor(existing.employeeId, existing.month, existing.year);
        await runDelete();
      });
    } else {
      await runDelete();
    }
    if (existing) {
      logger.info(`[AUDIT-WRITE] employee=${existing.employeeId} field=advance old=${existing.amount} new=—${payrollId ? ` payrollId=${payrollId}` : ''}`);
    }

    await recalcForAdvance(existing, req.io);
    res.json({ message: 'Advance deleted' });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
