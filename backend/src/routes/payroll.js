const router = require('express').Router();
const moment = require('moment');
const { getPrisma } = require('../utils/prisma');
const { authenticate, authorize } = require('../middleware/auth');
const { calculatePayroll, calculateMonthlyPayroll, computePayroll, applyApprovedAdjustment, withPayrollKeyLock, calculatePayrollImpl, filterProtectedPayrollTargets } = require('../engines/payrollEngine');
const { mergeEffectivePenalty } = require('../engines/attendanceEngine');
const { getRules, getRulesBatch } = require('../engines/rulesEngine');
const { writeAudit } = require('../utils/manualEditAudit');
const { monthRange } = require('../utils/monthRange');
const { MONTHS_AR } = require('../utils/constants');
const { pLimit } = require('../utils/pLimit');

const prisma = getPrisma();
router.use(authenticate, authorize('admin', 'hr'));

// Phase 24.1: bounds every DB operation this route issues — the batch
// preload queries AND the per-employee computePayroll() fan-out — through
// ONE shared, module-level limiter. A limiter re-created per request only
// bounds concurrency *within* a single request; the Prisma connection pool
// is a process-wide resource, so with many simultaneous requests in flight
// (e.g. several HR users opening the payroll page around the same time)
// per-request bounding still lets N-requests × limit queries hit the pool
// at once — measured empirically: even limit=10..25 per request still
// produced 100% pool-timeout failures at HTTP-concurrency=50.
//
// Measured sweep (Load-Test DB, 1,067 employees, 50 concurrent identical
// GET /api/payroll requests, default Prisma pool=13): global limiter values
// 10/15/20/25/50 ALL produced 0 pool-timeout errors, 0 P2024, peak MySQL
// connections capped at 27 — latency plateaued at p50≈24-27s across every
// value tested (the remaining latency past ~15 is CPU-bound formula
// computation on Node's single JS thread under 50× duplicate full-company
// requests, not DB concurrency — raising this further does not help it).
// 15 is chosen to leave headroom under the 13-connection pool for other
// routes' concurrent traffic (scheduler, monthly-detail, etc.) sharing the
// same process, rather than maximizing this route's throughput in isolation.
const PAYROLL_COMPUTE_CONCURRENCY = parseInt(process.env.PAYROLL_COMPUTE_CONCURRENCY, 10) || 15;
const payrollLimit = pLimit(PAYROLL_COMPUTE_CONCURRENCY);

router.get('/', async (req, res) => {
  try {
    const { month, year, branchId, departmentId, employeeId } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year) || new Date().getFullYear();

    const employeeFilter = {};
    if (branchId)     employeeFilter.branchId     = parseInt(branchId);
    if (departmentId) employeeFilter.departmentId = parseInt(departmentId);

    const where = { month: m, year: y };
    if (Object.keys(employeeFilter).length) where.employee = employeeFilter;
    // EP-014: optional narrowing for realtime single-row refresh — omitted by
    // every existing caller (initial load, filters), who see identical results.
    // Also cuts computePayroll() calls below from N employees to 1.
    if (employeeId) where.employeeId = parseInt(employeeId);

    const payrolls = await prisma.payroll.findMany({
      where,
      include: {
        employee: {
          select: { code: true, name: true, status: true, effectiveStopDate: true },
        },
      },
      orderBy: { employee: { name: 'asc' } },
    });

    // Phase 22.1: authoritative eligibility rule — "استبعاد الموظف الموقوف من
    // المرتبات بعد تاريخ الإيقاف" (Rules page, category "payroll", key
    // exclude_stopped_employees_from_payroll). Gated by the rule's own
    // enabled state like every other Dynamic Rules Engine key: when the rule
    // row is inactive OR its value isn't 'true', this route applies NO
    // eligibility filtering at all (pre-Phase-20.5 raw behavior) — the
    // policy is off, not silently replaced by hardcoded logic here.
    const rules = await getRules();
    const stoppedEmployeeFilterEnabled = rules['exclude_stopped_employees_from_payroll'] === 'true';

    let eligiblePayrolls = payrolls;
    if (stoppedEmployeeFilterEnabled) {
      const inactiveIds = [...new Set(
        payrolls
          .filter(p => p.employee.status === false && !['finalized', 'paid'].includes(p.status))
          .map(p => p.employeeId)
      )];

      // Legacy fallback ONLY for inactive employees with no effectiveStopDate
      // on record (pre-Phase-22.1 data — the field is never auto-backfilled,
      // see Phase 22.1 audit). Once HR sets an effectiveStopDate for these via
      // the Employees page, this branch stops applying to them entirely and
      // the date-based rule below takes over. This is not a second competing
      // eligibility system — it's the single decision function's handling of
      // "authoritative date missing", not an independent parallel filter.
      const undatedInactiveIds = inactiveIds.filter(id => {
        const p = payrolls.find(row => row.employeeId === id);
        return p && p.employee.effectiveStopDate == null;
      });
      let eligibleUndatedIds = new Set();
      if (undatedInactiveIds.length) {
        const { startDate, endDate } = monthRange(y, m);
        const attended = await prisma.attendanceDaily.findMany({
          where: {
            employeeId: { in: undatedInactiveIds },
            date: { gte: startDate, lte: endDate },
            OR: [{ checkIn: { not: null } }, { checkOut: { not: null } }],
          },
          select: { employeeId: true },
          distinct: ['employeeId'],
        });
        eligibleUndatedIds = new Set(attended.map(a => a.employeeId));
      }

      // Month-boundary convention (Phase 22.1 §5, verified against CASE A-D):
      // eligible for month (m,y) iff effectiveStopDate is strictly AFTER the
      // first day of that month — i.e. the stop date itself is the first
      // excluded operational day. A stop date of Aug 1 excludes August
      // entirely; Aug 15 keeps August (existing partial-month payroll
      // behavior applies unchanged) but excludes September.
      const { startDate: monthStart } = monthRange(y, m);
      eligiblePayrolls = payrolls.filter(p => {
        if (p.employee.status === true) return true;
        if (['finalized', 'paid'].includes(p.status)) return true;
        if (p.employee.effectiveStopDate != null) {
          return new Date(p.employee.effectiveStopDate).getTime() > monthStart.getTime();
        }
        return eligibleUndatedIds.has(p.employeeId);
      });
    }

    // EF-017: netSalary (and the other money/attendance fields the grid
    // displays) must come from the same single canonical source every other
    // screen already uses — computePayroll(). The stored Payroll row is a
    // write-time snapshot that goes stale the moment attendance changes after
    // the last "احتساب المرتبات" run (live-proven: employee 38, July 2026 —
    // stored netSalary 6047.56 vs computePayroll() 5783.33, a full day's gap).
    // /final-sheet already sourced from computePayroll() exclusively
    // (Certification HIGH#1) — this list route was the one place that never
    // got migrated to that same rule. Only row-identity/workflow fields
    // (id/employeeId/month/year/status/notes/timestamps/employee) still come
    // from the stored row; every computed field is overlaid fresh, live, per
    // request — no value is ever persisted or cached here.
    // Phase 24.1: batch-preload the per-employee queries computePayroll()
    // would otherwise issue individually (employee, attendanceDaily,
    // attendanceAdjustment, existing payroll row) into a handful of total
    // queries, then fan out through a bounded concurrency limiter instead of
    // an unbounded Promise.all. Data handed to computePayroll() is identical
    // row-for-row to what its own per-employee queries would have returned —
    // same filters, same date range, same fields — so this is a data-access
    // change only; the formula path inside computePayroll() is untouched.
    //
    // Perf Batch 1: `rules` (rulesEngine.getRules) and `advances`
    // (prisma.advance.findMany) were the two per-employee queries this
    // preload never covered — computePayroll() kept calling them once per
    // employee even when handed a preload, undoing part of the pool-pressure
    // fix above at scale. Both are now batched the same way: one query (well,
    // one query for advances, one for rules) for the whole page instead of N.
    const empIds = eligiblePayrolls.map(p => p.employeeId);
    const { startDate: mStart, endDate: mEnd } = monthRange(y, m);
    const [preloadEmployees, preloadRecords, preloadAdjustments, preloadExistingPayrolls, preloadAdvances] = empIds.length
      ? await Promise.all([
          payrollLimit(() => prisma.employee.findMany({ where: { id: { in: empIds } } })),
          payrollLimit(() => prisma.attendanceDaily.findMany({ where: { employeeId: { in: empIds }, date: { gte: mStart, lte: mEnd } } })),
          payrollLimit(() => prisma.attendanceAdjustment.findMany({ where: { employeeId: { in: empIds }, date: { gte: mStart, lte: mEnd }, approvalStatus: 'approved' } })),
          payrollLimit(() => prisma.payroll.findMany({ where: { employeeId: { in: empIds }, month: m, year: y }, select: { employeeId: true, bonus: true, manualDeductionAdjustment: true } })),
          payrollLimit(() => prisma.advance.findMany({ where: { employeeId: { in: empIds }, month: m, year: y } })),
        ])
      : [[], [], [], [], []];

    const employeeById = new Map(preloadEmployees.map(e => [e.id, e]));
    const groupByEmployeeId = (rows) => {
      const map = new Map();
      for (const row of rows) {
        if (!map.has(row.employeeId)) map.set(row.employeeId, []);
        map.get(row.employeeId).push(row);
      }
      return map;
    };
    const recordsByEmployee = groupByEmployeeId(preloadRecords);
    const adjustmentsByEmployee = groupByEmployeeId(preloadAdjustments);
    const existingPayrollByEmployee = new Map(preloadExistingPayrolls.map(p => [p.employeeId, p]));
    const advancesByEmployee = groupByEmployeeId(preloadAdvances);

    // Rules batching needs each employee's branchId/departmentId — depends on
    // preloadEmployees above, so it runs after that Promise.all rather than
    // inside it; still exactly ONE attendanceRule query for the whole page
    // instead of one per employee.
    const rulesByEmployee = preloadEmployees.length
      ? await payrollLimit(() => getRulesBatch(preloadEmployees))
      : new Map();

    const fresh = await Promise.all(eligiblePayrolls.map(p => payrollLimit(() => computePayroll(p.employeeId, p.month, p.year, {
      preload: {
        employee: employeeById.get(p.employeeId) || null,
        rawRecords: recordsByEmployee.get(p.employeeId) || [],
        monthAdjustments: adjustmentsByEmployee.get(p.employeeId) || [],
        existingPayroll: existingPayrollByEmployee.get(p.employeeId) || null,
        rules: rulesByEmployee.get(p.employeeId),
        advancesList: advancesByEmployee.get(p.employeeId) || [],
      },
    }))));
    const result = eligiblePayrolls.map((p, i) => {
      const c = fresh[i];
      return {
        ...p,
        employee: { code: p.employee.code, name: p.employee.name },
        basicSalary: c.basicSalary,
        dailyRate: c.dailyRate,
        hourlyRate: c.hourlyRate,
        workDays: c.workDays,
        absentDays: c.absentDays,
        overtimeHours: c.overtimeHours,
        overtimeAmount: c.overtimeAmount,
        // EP-022: ساعات الخصم — same canonical penaltyUnits figure computePayroll()
        // already derives for the persisted Payroll row (late+early effective units).
        // Overlaid fresh here for the same staleness reason as the other computed
        // fields above (EF-017) — the stored row can lag behind live attendance.
        penaltyUnits: c.penaltyUnits,
        bonus: c.bonus,
        advances: c.advances,
        manualDeductionAdjustment: c.manualDeductionAdjustment,
        deductions: c.deductions,
        netSalary: c.netSalary,
        // grossEntitlements: basicSalary + overtimeAmount, computed once here
        // so the print grid (PrintPreviewModal) is a pure field passthrough —
        // it must never recompute this itself.
        grossEntitlements: c.basicSalary + c.overtimeAmount,
      };
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:employeeId', async (req, res, next) => {
  // Guard: pass non-numeric IDs through to specific string routes below
  if (isNaN(parseInt(req.params.employeeId))) return next();
  try {
    const { month, year } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year) || new Date().getFullYear();

    const payroll = await prisma.payroll.findUnique({
      where: {
        employeeId_month_year: {
          employeeId: parseInt(req.params.employeeId),
          month: m,
          year: y,
        },
      },
      include: { employee: true },
    });

    if (!payroll) return res.status(404).json({ error: 'Payroll not found' });
    res.json(payroll);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/calculate', async (req, res) => {
  try {
    const { month, year, branchId, employeeId } = req.body;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year) || new Date().getFullYear();

    if (employeeId) {
      // C1: this button has no confirmation flow — a finalized/paid month
      // must not be silently recalculated just because someone (re)pressed
      // "احتساب المرتبات" for that specific employee. Same canonical check
      // as every other cascade caller (Phase 13.3).
      const { allowed, protectedTargets } = await filterProtectedPayrollTargets([
        { employeeId: parseInt(employeeId), month: m, year: y },
      ]);
      if (protectedTargets.length) {
        return res.json({ protected: true, status: protectedTargets[0].status, message: 'مرتب هذا الموظف معتمد/مدفوع بالفعل — لم تتم إعادة الاحتساب' });
      }
      const result = await calculatePayroll(parseInt(employeeId), m, y);
      res.json(result);
    } else {
      const { results, protectedTargets } = await calculateMonthlyPayroll(m, y, branchId ? parseInt(branchId) : null);
      res.json({ count: results.length, results, protectedPayroll: protectedTargets });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual payroll adjustments — `bonus` and `manualDeductionAdjustment` are
// HR-entered amounts preserved across every `calculatePayroll` recalc (read
// back from the existing row, like `bonus` always was). Raw `deductions` and
// `advances` are NOT writable here — both are fully derived by the engine
// (advances come from the Advance table). After persisting, `calculatePayroll`
// recomputes `deductions`/`netSalary` consistently and logs [PAYROLL-RECALC].
router.put('/:id', async (req, res) => {
  try {
    const { basicSalary, bonus, manualDeductionAdjustment, notes, status, reason, modifiedBy, modifiedByName, modifiedByRole } = req.body;
    const payroll = await prisma.payroll.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!payroll) return res.status(404).json({ error: 'Payroll not found' });

    const before = { ...payroll };

    // EF-007.4: `parseFloat(x) || 0` let a negative value (truthy) through —
    // a negative bonus silently reduces totalEarnings with no deduction
    // audit trail; same class of bug the basicSalary check below already guards.
    if (bonus !== undefined && (!Number.isFinite(parseFloat(bonus)) || parseFloat(bonus) < 0)) {
      return res.status(400).json({ error: 'قيمة المكافأة يجب أن تكون رقمًا موجبًا' });
    }
    if (manualDeductionAdjustment !== undefined && (!Number.isFinite(parseFloat(manualDeductionAdjustment)) || parseFloat(manualDeductionAdjustment) < 0)) {
      return res.status(400).json({ error: 'قيمة الخصم الإضافي يجب أن تكون رقمًا موجبًا' });
    }

    const data = {};
    if (bonus !== undefined) data.bonus = parseFloat(bonus) || 0;
    if (manualDeductionAdjustment !== undefined) data.manualDeductionAdjustment = parseFloat(manualDeductionAdjustment) || 0;
    if (notes !== undefined) data.notes = notes;
    if (status !== undefined) data.status = status;

    // "الراتب الأساسي" is sourced from the EMPLOYEE record — the engine derives
    // payroll.basicSalary from employee.salary on every recompute. So persist the
    // edit on the employee, not the payroll row (otherwise it would revert).
    let newSalary = null;
    if (basicSalary !== undefined) {
      newSalary = parseFloat(basicSalary);
      if (isNaN(newSalary) || newSalary < 0) {
        return res.status(400).json({ error: 'قيمة الراتب الأساسي غير صالحة' });
      }
    }

    // EF-003.3.3 / EF-029.1: the employee-salary write, the payroll-field
    // write, the recalculation upsert, and every audit-log row for this
    // request now commit or roll back together in one prisma.$transaction —
    // previously these were separate un-transacted calls, so a crash/DB error
    // between steps (e.g. after the salary/payroll changed but before the
    // audit row was written) could leave a changed salary or payroll with no
    // audit trail. withPayrollKeyLock stays the OUTER wrapper exactly as
    // before: it serializes concurrent calls for this employee/month (an
    // in-process ordering guarantee against a DIFFERENT concurrent trigger),
    // while $transaction gives atomicity for THIS call's own writes — the two
    // solve different problems and are not redundant. calculatePayrollImpl()
    // (the unlocked implementation) is still used inside the lock, exactly as
    // before, to avoid self-deadlocking against the locked calculatePayroll()
    // wrapper. No formula, schema, or calculation logic is touched here.
    let salaryBefore = null, salaryAfter = null;
    let updated;
    await withPayrollKeyLock(payroll.employeeId, payroll.month, payroll.year, async () => {
      await prisma.$transaction(async (tx) => {
        if (newSalary !== null) {
          const emp = await tx.employee.findUnique({ where: { id: payroll.employeeId }, select: { salary: true } });
          salaryBefore = emp?.salary ?? null;
          salaryAfter = newSalary;
          await tx.employee.update({ where: { id: payroll.employeeId }, data: { salary: newSalary } });
        }

        if (Object.keys(data).length) {
          await tx.payroll.update({ where: { id: payroll.id }, data });
        }

        await calculatePayrollImpl(payroll.employeeId, payroll.month, payroll.year, { tx });

        updated = await tx.payroll.findUnique({ where: { id: payroll.id }, include: { employee: true } });

        for (const field of ['bonus', 'manualDeductionAdjustment', 'notes', 'status']) {
          const oldVal = before[field];
          const newVal = updated[field];
          if (String(oldVal ?? '') !== String(newVal ?? '')) {
            await writeAudit({
              employeeId: payroll.employeeId,
              payrollId: payroll.id,
              fieldName: field,
              oldValue: oldVal,
              newValue: newVal,
              reason: reason || null,
              userId: modifiedBy, userName: modifiedByName, userRole: modifiedByRole,
              tx,
            });
          }
        }

        // basicSalary lives on the employee record, so audit it from the
        // salary before/after captured above (not from the payroll row diff).
        if (salaryBefore !== null && String(salaryBefore) !== String(salaryAfter)) {
          await writeAudit({
            employeeId: payroll.employeeId,
            payrollId: payroll.id,
            fieldName: 'basicSalary',
            oldValue: salaryBefore,
            newValue: salaryAfter,
            reason: reason || null,
            userId: modifiedBy, userName: modifiedByName, userRole: modifiedByRole,
            tx,
          });
        }
      });
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// "السلف" (advances) is fully derived — it's the sum of `Advance` rows for
// this employee/month/year, recomputed on every `calculatePayroll`. Editing
// the cell treats the new value as the *desired total*: we create a single
// delta `Advance` record (positive or negative) so the engine recalculates
// `advances`/`netSalary` exactly like a normal advance entry, with the same
// audit trail as bonus/manualDeductionAdjustment.
router.put('/:id/advances', async (req, res) => {
  try {
    const { amount, reason, modifiedBy, modifiedByName, modifiedByRole } = req.body;
    const newTotal = parseFloat(amount);
    if (isNaN(newTotal) || newTotal < 0) return res.status(400).json({ error: 'قيمة السلف غير صالحة' });

    const payroll = await prisma.payroll.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!payroll) return res.status(404).json({ error: 'Payroll not found' });
    const { employeeId, month, year } = payroll;

    // EF-029.2: this route treats `amount` as the desired ABSOLUTE total and
    // computes a delta Advance to reach it. Previously the read-current-total
    // → create-delta step ran with no lock at all, so two near-simultaneous
    // edits of the same payroll's advances could both read the same stale
    // total and both apply their own delta — the second caller's "set to X"
    // intent silently becomes "add X minus whatever the first caller also
    // added". Wrapping the read + validation + write in the SAME
    // withPayrollKeyLock this route already needed for calculatePayroll
    // closes that window using the existing lock — no new locking primitive,
    // no schema change. The DB write itself (advance create + payroll upsert
    // + audit) is further wrapped in one prisma.$transaction so it commits or
    // rolls back as a unit, matching PUT /:id's hardening above.
    let currentTotal, delta, updated;
    await withPayrollKeyLock(employeeId, month, year, async () => {
      const existingAdvances = await prisma.advance.findMany({ where: { employeeId, month, year } });
      currentTotal = existingAdvances.reduce((s, a) => s + a.amount, 0);
      delta = parseFloat((newTotal - currentTotal).toFixed(2));

      if (delta > 0) {
        const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
        const rules = await getRules(employee.branchId, employee.departmentId, employee.id);
        const maxPercent = parseFloat(rules.advance_max_percent || '0');
        if (maxPercent > 0) {
          const maxAllowed = (employee.salary || 0) * (maxPercent / 100);
          if (newTotal > maxAllowed) {
            const err = new Error(`إجمالي السلف (${newTotal.toFixed(2)}) يتجاوز الحد الأقصى المسموح (${maxAllowed.toFixed(2)} = ${maxPercent}% من الراتب الأساسي)`);
            err.statusCode = 400;
            throw err;
          }
        }
      }

      await prisma.$transaction(async (tx) => {
        if (delta !== 0) {
          await tx.advance.create({
            data: {
              employeeId, month, year, amount: delta, date: new Date(),
              reason: reason || 'تعديل يدوي من شاشة المرتبات', status: 'approved',
            },
          });
        }

        await calculatePayrollImpl(employeeId, month, year, { tx });

        updated = await tx.payroll.findUnique({ where: { id: payroll.id }, include: { employee: true } });

        if (delta !== 0) {
          await writeAudit({
            employeeId, payrollId: payroll.id, fieldName: 'advances',
            oldValue: currentTotal, newValue: newTotal, reason: reason || null,
            userId: modifiedBy, userName: modifiedByName, userRole: modifiedByRole,
            tx,
          });
        }
      });
    });

    res.json(updated);
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Audit history for a single payroll row — newest first.
router.get('/:id/audit', async (req, res, next) => {
  if (isNaN(parseInt(req.params.id))) return next();
  try {
    const rows = await prisma.manualEditAuditLog.findMany({
      where: { payrollId: parseInt(req.params.id) },
      orderBy: { createdAt: 'desc' },
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Final Salary Sheet — single employee ────────────────────────────────────
// GET /api/payroll/final-sheet?employeeId=1&month=6&year=2026
router.get('/final-sheet', async (req, res) => {
  try {
    const { employeeId, month, year } = req.query;
    if (!employeeId || !month || !year) {
      return res.status(400).json({ error: 'employeeId, month, year required' });
    }
    const m = parseInt(month);
    const y = parseInt(year);
    const eId = parseInt(employeeId);

    // EF-008 Phase 2: now the literal same implementation as
    // payrollEngine.computePayroll — see utils/monthRange.js for why a plain
    // `new Date(y, m, 0).toISOString()` truncates to the wrong calendar day in
    // any positive-UTC-offset timezone (the bug this shared construction
    // avoids).
    const { startDate, endDate } = monthRange(y, m);

    const [payroll, employee, rawAttRecords, monthAdjustments] = await Promise.all([
      prisma.payroll.findUnique({
        where: { employeeId_month_year: { employeeId: eId, month: m, year: y } },
      }),
      prisma.employee.findUnique({
        where: { id: eId },
        select: {
          id: true, name: true, code: true, position: true, salary: true,
          department: { select: { name: true } },
          branch:     { select: { name: true, company: { select: { name: true } } } },
          shift:      { select: { name: true } },
        },
      }),
      prisma.attendanceDaily.findMany({
        where: { employeeId: eId, date: { gte: startDate, lte: endDate } },
      }),
      prisma.attendanceAdjustment.findMany({
        where: { employeeId: eId, date: { gte: startDate, lte: endDate }, approvalStatus: 'approved' },
      }),
    ]);

    if (!employee) return res.status(404).json({ error: 'Employee not found' });

    // Apply the same approved-adjustment overlay payrollEngine uses, so the
    // Final Salary Sheet's late/early figures match the engine's exactly.
    // NOTE: this local attRecords/effRecords derivation now feeds ONLY the
    // display/KPI section below (workDays, absentDays, totalLateMin, morningOT/
    // eveningOT hours, hasManualPenalty/hasManualOvertime) — it is display-only
    // and carries no money. Every money figure (earnings/deductions/netSalary)
    // comes from the single `computePayroll()` call further down.
    const adjByDailyId = new Map(monthAdjustments.map(a => [a.attendanceDailyId, a]));
    const attRecords = rawAttRecords.map(r => applyApprovedAdjustment(r, adjByDailyId.get(r.id)));
    const effRecords = attRecords.map(r => mergeEffectivePenalty(r));

    // Aggregate attendance for the month — display/KPI only, no money involved.
    // Certification HIGH#3: workDays is sourced from computed.workDays (below)
    // — payrollEngine's canonical status-based definition — not re-derived
    // here. The old local formula (!isAbsent && !isWeekend && !isHoliday &&
    // checkIn) silently disagreed with Payroll.workDays whenever a record
    // carried a stale/legacy status value the current engine no longer
    // produces (proven: 3 real employee-months in production, all traced to
    // a pre-2026-06-22 'half_day' status never recomputed since that status
    // was removed) — status-based is immune to that class of staleness since
    // it reads the engine's own explicit classification directly.
    const absentDays  = attRecords.filter(r => r.isAbsent).length;
    const totalLateMin= attRecords.reduce((s, r) => s + (r.lateMinutes || 0), 0);
    // EF-012: morningOT/eveningOT must sum to exactly totalOTHours. The old
    // formula summed morningOvertimeHours/eveningOvertimeHours — the raw,
    // pre-manual-override automatic split — while totalOTHours summed
    // effectiveOvertimeUnits (post-override, the canonical financial figure).
    // These silently disagreed whenever a manual overtime override changed a
    // day's effective hours without updating that day's raw split (e.g.
    // employee 93, June 2026: morningOT=12 + eveningOT=40 = 52 ≠ totalOTHours
    // 81, live-verified). Fixed by deriving morningOT/eveningOT from the same
    // per-day effective-hours proportional split payrollEngine.js's money
    // loop already uses for morningOTAmount/eveningOTAmount — display-only,
    // no money impact, guarantees the identity by construction.
    let morningOT = 0, eveningOT = 0;
    for (const r of effRecords) {
      const otHours = r.effectiveOvertimeUnits ?? r.overtimeHours ?? 0;
      const rMorning = r.morningOvertimeHours || 0;
      const rEvening = r.eveningOvertimeHours || 0;
      const splittable = rMorning + rEvening;
      if (splittable > 0 && otHours > 0) {
        const share = otHours * (rMorning / splittable);
        morningOT += share;
        eveningOT += (otHours - share);
      } else {
        eveningOT += otHours;
      }
    }
    morningOT = parseFloat(morningOT.toFixed(2));
    eveningOT = parseFloat((eveningOT).toFixed(2));
    const totalOTHours = parseFloat((morningOT + eveningOT).toFixed(2));
    const latePenalty = effRecords.reduce((s, r) => s + (r.effectiveLatePenalty || 0), 0);
    const earlyPenalty= effRecords.reduce((s, r) => s + (r.effectiveEarlyPenalty || 0), 0);
    const hasManualPenalty = effRecords.some(r => r.hasManualPenalty);
    const hasManualOvertime = effRecords.some(r => r.hasManualOvertime);

    const emp  = employee;
    const comp = emp?.branch?.company;
    const pr   = payroll || {};

    // Certification HIGH#1 fix: every money figure below (earnings, deductions
    // breakdown, netSalary) is sourced from ONE call to the exact same pure
    // computation payrollEngine.calculatePayroll() persists. computePayroll()
    // itself performs no DB writes — a GET route must not have side effects —
    // but it is now the ONLY place these formulas are ever computed. This
    // route no longer re-derives any of them independently, which is what
    // previously let this route's `deductions.total` (always freshly
    // recomputed) disagree with the persisted `Payroll.netSalary` (always
    // read verbatim) in the very same response — proved via a full production
    // scan across all 2,536 Payroll rows during the HIGH#1 investigation.
    const computed = await computePayroll(eId, m, y);

    const dailyRate  = computed.dailyRate;
    const hourlyRate = computed.hourlyRate;
    const workDays   = computed.workDays;

    // EF-012: full day-accounting for the period — workDays/absentDays alone
    // silently dropped weekend/holiday/future days from every statement (e.g.
    // employee 38, June 2026: workDays=5 + absentDays=21 = 26, 4 days
    // unexplained — they were real Fridays, live-verified). Additive fields
    // only; every existing field above is unchanged. Every day of the period
    // is now classified into exactly one bucket, summing to totalDays by
    // construction.
    const totalDaysInPeriod = moment(startDate).daysInMonth();
    const weeklyOffDays = attRecords.filter(r => r.isWeekend && !r.isHoliday).length;
    const holidayDays   = attRecords.filter(r => r.isHoliday).length;
    const futureDays    = totalDaysInPeriod - attRecords.length; // dates not yet reached (no AttendanceDaily row exists for them)
    // Defensive catch-all: a row can carry a legacy/unrecognized status (e.g.
    // 'half_day', removed 2026-06-22 per attendanceEngine.js's own comment,
    // but still present in old un-recomputed rows — live-verified: employee
    // 19, 2026-06-07) that matches none of the 4 buckets above. Rather than
    // let such a row silently vanish from the day count, it's explicitly
    // counted here so the identity below always holds exactly, for any data.
    const otherDays = attRecords.length - (workDays + absentDays + weeklyOffDays + holidayDays);

    const basicSalary    = computed.basicSalary;
    // Certification HIGH#2: morningOTAmt/eveningOTAmt are no longer derived
    // here — this route must never multiply hours by rate/multiplier itself.
    // Both are sourced from computePayroll(), which computes them as an
    // exact two-way partition of overtimeAmount (day-specific multipliers,
    // integer-cent split — see PAYROLL_CONSISTENCY_ARCHITECTURE.md).
    const morningOTAmt   = computed.morningOTAmount;
    const eveningOTAmt   = computed.eveningOTAmount;
    const overtimeAmount = computed.overtimeAmount;
    const bonus          = computed.bonus;
    const totalEarnings  = parseFloat((basicSalary + overtimeAmount + bonus).toFixed(2));

    const totalAbsencePenaltyDays = computed.totalAbsencePenaltyDays;
    const absentDeduct   = computed.absentAmount;
    const lateDeduct     = computed.latePenalty;
    const earlyDeduct    = computed.earlyLeavePenalty;
    const advances                  = computed.advances;
    const manualDeductionAdjustment = computed.manualDeductionAdjustment;

    const totalDeductions = computed.deductions;
    const netSalary = computed.netSalary;


    res.json({
      company:      { name: comp?.name || emp?.branch?.name || 'الشركة' },
      monthLabel:   MONTHS_AR[m - 1],
      year:         y,
      month:        m,
      employee: {
        id:         emp.id,
        name:       emp.name,
        code:       emp.code,
        position:   emp.position,
        department: emp.department?.name,
        branch:     emp.branch?.name,
        shift:      emp.shift?.name,
        salary:     emp.salary,
        hourlyRate,
        dailyRate,
      },
      attendance: {
        workDays, absentDays, totalLateMin, morningOT, eveningOT, totalOTHours, latePenalty, earlyPenalty, hasManualPenalty, hasManualOvertime,
        // EF-012: additive — full day accounting. workDays+absentDays+weeklyOffDays+holidayDays+futureDays === totalDaysInPeriod exactly.
        weeklyOffDays, holidayDays, futureDays, otherDays, totalDaysInPeriod,
      },
      earnings: {
        basicSalary,
        morningOT:     { hours: morningOT, amount: morningOTAmt },
        eveningOT:     { hours: eveningOT, amount: eveningOTAmt },
        overtimeAmount,
        bonus,
        total:         totalEarnings,
      },
      deductions: {
        absentDays,
        absentPenaltyDays: totalAbsencePenaltyDays,
        absentAmount:  absentDeduct,
        latePenalty,
        lateAmount:    lateDeduct,
        earlyPenalty,
        earlyAmount:   earlyDeduct,
        advances,
        manualDeductionAdjustment,
        total:         totalDeductions,
      },
      netSalary,
      notes:      pr.notes || '',
      status:     pr.status || 'draft',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Final Salary Sheet — bulk (all employees for month) ────────────────────
// GET /api/payroll/final-sheet/bulk?month=6&year=2026&branchId=1
router.get('/final-sheet/bulk', async (req, res) => {
  try {
    const { month, year, branchId } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();

    const empWhere = { status: true };
    if (branchId) empWhere.branchId = parseInt(branchId);

    const employees = await prisma.employee.findMany({
      where: empWhere,
      select: { id: true },
    });

    // Perf Batch 1 (Fix #6): one batched payroll.findMany() for the whole
    // page instead of one payroll.findUnique() per employee — same pattern
    // established by GET / and computePayroll()'s preload (Fix #1/#2). The
    // `employeeId_month_year` field is a unique constraint, so findMany with
    // employeeId `in:` returns at most one row per employeeId — identical
    // existence semantics to the per-employee findUnique it replaces, just
    // batched. `employees` (and therefore `ids`'s order) is untouched.
    const empIds = employees.map(e => e.id);
    const existingPayrolls = empIds.length
      ? await prisma.payroll.findMany({
          where: { employeeId: { in: empIds }, month: m, year: y },
          select: { employeeId: true },
        })
      : [];
    const employeeIdsWithPayroll = new Set(existingPayrolls.map(p => p.employeeId));

    const ids = employees
      .filter(e => employeeIdsWithPayroll.has(e.id))
      .map(e => e.id);

    res.json({ ids, month: m, year: y, count: ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

