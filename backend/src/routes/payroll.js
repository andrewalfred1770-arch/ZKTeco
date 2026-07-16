const router = require('express').Router();
const moment = require('moment');
const { getPrisma } = require('../utils/prisma');
const { authenticate, authorize } = require('../middleware/auth');
const { calculatePayroll, calculateMonthlyPayroll, computePayroll, applyApprovedAdjustment, withPayrollKeyLock, calculatePayrollImpl } = require('../engines/payrollEngine');
const { mergeEffectivePenalty } = require('../engines/attendanceEngine');
const { getRules } = require('../engines/rulesEngine');
const { writeAudit } = require('../utils/manualEditAudit');
const { monthRange } = require('../utils/monthRange');
const { MONTHS_AR } = require('../utils/constants');

const prisma = getPrisma();
router.use(authenticate, authorize('admin', 'hr'));

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
          select: { code: true, name: true },
        },
      },
      orderBy: { employee: { name: 'asc' } },
    });

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
    const fresh = await Promise.all(payrolls.map(p => computePayroll(p.employeeId, p.month, p.year)));
    const result = payrolls.map((p, i) => {
      const c = fresh[i];
      return {
        ...p,
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
      const result = await calculatePayroll(parseInt(employeeId), m, y);
      res.json(result);
    } else {
      const results = await calculateMonthlyPayroll(m, y, branchId ? parseInt(branchId) : null);
      res.json({ count: results.length, results });
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
    let salaryBefore = null, salaryAfter = null;
    if (basicSalary !== undefined) {
      const newSalary = parseFloat(basicSalary);
      if (isNaN(newSalary) || newSalary < 0) {
        return res.status(400).json({ error: 'قيمة الراتب الأساسي غير صالحة' });
      }
      const emp = await prisma.employee.findUnique({ where: { id: payroll.employeeId }, select: { salary: true } });
      salaryBefore = emp?.salary ?? null;
      salaryAfter  = newSalary;
      await prisma.employee.update({ where: { id: payroll.employeeId }, data: { salary: newSalary } });
    }

    // EF-003.3.3: the bonus/manualDeductionAdjustment write and the recalc
    // that immediately follows share the SAME payroll-key lock introduced in
    // EF-003.3.2 — closing the window where a concurrent calculatePayroll()
    // call (from an unrelated trigger) could read these fields between this
    // write committing and this route's own recalc running. Calls
    // calculatePayrollImpl() (the unlocked implementation) rather than the
    // locked calculatePayroll() wrapper, since this block already holds the
    // lock for this key — calling the locked wrapper here would self-deadlock
    // (the inner acquisition would wait on this same block's own completion).
    await withPayrollKeyLock(payroll.employeeId, payroll.month, payroll.year, async () => {
      if (Object.keys(data).length) {
        await prisma.payroll.update({ where: { id: payroll.id }, data });
      }

      await calculatePayrollImpl(payroll.employeeId, payroll.month, payroll.year);
    });

    const updated = await prisma.payroll.findUnique({
      where: { id: payroll.id },
      include: { employee: true },
    });

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
        });
      }
    }

    // basicSalary lives on the employee record, so audit it from the salary
    // before/after captured above (not from the payroll row diff).
    if (salaryBefore !== null && String(salaryBefore) !== String(salaryAfter)) {
      await writeAudit({
        employeeId: payroll.employeeId,
        payrollId: payroll.id,
        fieldName: 'basicSalary',
        oldValue: salaryBefore,
        newValue: salaryAfter,
        reason: reason || null,
        userId: modifiedBy, userName: modifiedByName, userRole: modifiedByRole,
      });
    }

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

    const existingAdvances = await prisma.advance.findMany({ where: { employeeId, month, year } });
    const currentTotal = existingAdvances.reduce((s, a) => s + a.amount, 0);
    const delta = parseFloat((newTotal - currentTotal).toFixed(2));

    if (delta !== 0) {
      if (delta > 0) {
        const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
        const rules = await getRules(employee.branchId, employee.departmentId, employee.id);
        const maxPercent = parseFloat(rules.advance_max_percent || '0');
        if (maxPercent > 0) {
          const maxAllowed = (employee.salary || 0) * (maxPercent / 100);
          if (newTotal > maxAllowed) {
            return res.status(400).json({
              error: `إجمالي السلف (${newTotal.toFixed(2)}) يتجاوز الحد الأقصى المسموح (${maxAllowed.toFixed(2)} = ${maxPercent}% من الراتب الأساسي)`,
            });
          }
        }
      }

      await prisma.advance.create({
        data: {
          employeeId, month, year, amount: delta, date: new Date(),
          reason: reason || 'تعديل يدوي من شاشة المرتبات', status: 'approved',
        },
      });
    }

    await calculatePayroll(employeeId, month, year);

    const updated = await prisma.payroll.findUnique({
      where: { id: payroll.id },
      include: { employee: true },
    });

    if (delta !== 0) {
      await writeAudit({
        employeeId, payrollId: payroll.id, fieldName: 'advances',
        oldValue: currentTotal, newValue: newTotal, reason: reason || null,
        userId: modifiedBy, userName: modifiedByName, userRole: modifiedByRole,
      });
    }

    res.json(updated);
  } catch (err) {
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

    // Fetch all in parallel
    const sheets = await Promise.allSettled(
      employees.map(e =>
        prisma.payroll.findUnique({
          where: { employeeId_month_year: { employeeId: e.id, month: m, year: y } },
          select: { id: true },
        })
      )
    );

    const ids = sheets
      .map((s, i) => s.status === 'fulfilled' && s.value ? employees[i].id : null)
      .filter(Boolean);

    res.json({ ids, month: m, year: y, count: ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

