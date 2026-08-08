const { getPrisma } = require('../utils/prisma');
const moment = require('moment');
const { getRules, parseTime } = require('./rulesEngine');
const { mergeEffectivePenalty } = require('./attendanceEngine');
const { monthRange } = require('../utils/monthRange');
const logger = require('../utils/logger');

const prisma = getPrisma();

// ─── Overtime multiplier selection ────────────────────────────────────────────
// Single source of truth for which OT multiplier applies to a given day.
// EF-008 Finding #4: previously duplicated (with a divergent priority order)
// inside routes/attendance.js's summarizeMovementDays(); both call sites now
// share this function so the Movement report can never disagree with Payroll.
// Friday is a special overtime workday by policy — its OT multiplier applies
// regardless of isWeekend (which only governs working-day counts).
function selectOvertimeMultiplier(record, { otMultiplier, fridayOTMultiplier, holidayOTMultiplier, weekendOTMultiplier }) {
  if (record.isHoliday) return holidayOTMultiplier;
  if (moment(record.date).day() === 5) return fridayOTMultiplier;
  if (record.isWeekend) return weekendOTMultiplier;
  return otMultiplier;
}

// ─── Rate derivation ───────────────────────────────────────────────────────────
// Single source of truth for dailyRate/hourlyRate. EF-010: previously
// duplicated (identically) inside routes/attendance/movement.js; both call
// sites now share this function so Payroll and the Movement report can never
// numerically diverge. Full floating-point precision — no rounding here;
// rounding is a display-only concern (frontend formatters / Excel export).
function computeRates(basicSalary, monthDays, workHoursPerDay) {
  const dailyRate = basicSalary / (monthDays || 30);
  const hourlyRate = dailyRate / (workHoursPerDay || 8);
  return { dailyRate, hourlyRate };
}

// ─── Approved-adjustment overlay ──────────────────────────────────────────────
// Adjustments are HR-approved overrides layered on top of the auto-calculated
// AttendanceDaily values. ONLY approvalStatus='approved' rows participate.
// This is the single merge used for payroll aggregation — the same precedence
// the adjustments UI displays, so what HR sees is what payroll pays.
function applyApprovedAdjustment(r, adj) {
  if (!adj || adj.approvalStatus !== 'approved') return r;

  const eff = { ...r };
  if (adj.forcePresent) { eff.status = 'present'; eff.isAbsent = false; }
  if (adj.adjStatus != null)        eff.status = adj.adjStatus;
  if (adj.adjIsAbsent != null)      eff.isAbsent = adj.adjIsAbsent;
  if (adj.adjWorkedMinutes != null) eff.workedMinutes = adj.adjWorkedMinutes;
  if (adj.adjOvertimeHours != null) eff.overtimeHours = adj.adjOvertimeHours;
  if (adj.adjMorningOT     != null) eff.morningOvertimeHours = adj.adjMorningOT;
  if (adj.adjEveningOT     != null) eff.eveningOvertimeHours = adj.adjEveningOT;
  eff.lateMinutes = adj.ignoreLate ? 0 : (adj.adjLateMinutes ?? r.lateMinutes);
  if (adj.ignoreEarlyLeave)         eff.earlyLeaveMinutes = 0;

  // Canonical deduction-unit fields — the single implementation of the
  // approved-adjustment overlay. routes/adjustments.js imports this function
  // directly rather than maintaining its own copy, so payroll and the
  // adjustments UI can never disagree on the effective late/early penalty for
  // this day.
  const lateUnits  = adj.ignoreLate       ? 0 : (adj.adjLatePenalty  ?? r.latePenaltyUnits);
  const earlyUnits = adj.ignoreEarlyLeave ? 0 : (adj.adjEarlyPenalty ?? r.earlyCheckoutUnits);
  eff.latePenaltyUnits    = lateUnits;
  eff.earlyCheckoutUnits  = earlyUnits;
  eff.totalDeductionUnits = adj.adjTotalDeductions ?? (lateUnits + earlyUnits);

  // adjCheckIn/adjCheckOut are "HH:mm" — rebuild a Date on the row's own day so
  // the night-shift/holiday-presence checks (and the printed check-in/out
  // times) see the adjusted time.
  const rebuildTime = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number);
    const d = new Date(r.date);
    d.setHours(h || 0, m || 0, 0, 0);
    return d;
  };
  if (adj.adjCheckIn)  eff.checkIn  = rebuildTime(adj.adjCheckIn);
  if (adj.adjCheckOut) eff.checkOut = rebuildTime(adj.adjCheckOut);
  return eff;
}

/**
 * Pure computation — fetches the inputs and computes every payroll field, but
 * never writes to the DB. `calculatePayroll` is a thin wrapper that upserts
 * the result. Used directly (no write) by the manual-edit preview endpoint.
 *
 * @param {object} [opts]
 * @param {{ id: number, fields: object }} [opts.recordsOverride] — replace the
 *   fields of the AttendanceDaily row with this `id` (after the approved-
 *   adjustment merge) before aggregation. Used to preview the payroll impact
 *   of a proposed-but-not-yet-saved manual edit.
 */
async function computePayroll(employeeId, month, year, opts = {}) {
  const { recordsOverride } = opts;

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
  });

  if (!employee) throw new Error('Employee not found');

  const rules = await getRules(employee.branchId, employee.departmentId, employee.id);

  const { startDate, endDate } = monthRange(year, month);

  const [rawRecords, monthAdjustments, existingPayroll] = await Promise.all([
    prisma.attendanceDaily.findMany({
      where: {
        employeeId,
        date: { gte: startDate, lte: endDate },
      },
    }),
    prisma.attendanceAdjustment.findMany({
      where: {
        employeeId,
        date: { gte: startDate, lte: endDate },
        approvalStatus: 'approved',
      },
    }),
    // Existing row is fetched to PRESERVE manual `bonus` and
    // `manualDeductionAdjustment` fields across recalculations — both are
    // HR-entered, never derived, and must survive every engine recalc.
    prisma.payroll.findUnique({
      where: { employeeId_month_year: { employeeId, month, year } },
      select: { bonus: true, manualDeductionAdjustment: true },
    }),
  ]);

  const adjByDailyId = new Map(monthAdjustments.map(a => [a.attendanceDailyId, a]));
  let records = rawRecords.map(r => applyApprovedAdjustment(r, adjByDailyId.get(r.id)));
  records = records.map(r => mergeEffectivePenalty(r));
  const appliedAdjustments = rawRecords.filter(r => adjByDailyId.has(r.id)).length;

  // Preview support: overlay a proposed (not-yet-persisted) edit onto its row.
  if (recordsOverride && recordsOverride.id != null) {
    records = records.map(r => r.id === recordsOverride.id
      ? { ...r, ...recordsOverride.fields }
      : r);
  }

  const basicSalary = employee.salary || 0;

  // Single source of truth — all rates derived from policy rules only.
  // Enterprise Financial Precision (Business Rule Change, approved): dailyRate
  // and hourlyRate are kept at FULL floating-point precision — no premature
  // rounding of either. Rounding is a display-only concern (frontend
  // valueFormatter/fmtCeil/fmtMoney) — Late/Early/Overtime/Payroll/Reports
  // must all use the exact value.
  const monthDays = parseFloat(rules.month_days || 30);
  const workingHours = parseFloat(rules.work_hours_per_day || 8);
  const { dailyRate, hourlyRate } = computeRates(basicSalary, monthDays, workingHours);
  const otMultiplier = parseFloat(rules.overtime_multiplier || '1.5');
  const fridayOTMultiplier   = parseFloat(rules.friday_ot_multiplier   || otMultiplier);
  const holidayOTMultiplier  = parseFloat(rules.holiday_ot_multiplier  || otMultiplier);
  const weekendOTMultiplier  = parseFloat(rules.weekend_work_multiplier|| otMultiplier);
  const holidayPayMultiplier = parseFloat(rules.holiday_pay_multiplier || '1');
  const nightShiftStartMin   = rules.night_shift_start ? parseTime(rules.night_shift_start) : null;
  const nightShiftBonusPct   = parseFloat(rules.night_shift_bonus || '0');

  // half_day removed 2026-06-22 — status set: present | late | early_leave | absent | weekend | holiday
  const workDays   = records.filter(r => ['present', 'late', 'early_leave'].includes(r.status)).length;
  const absentDays = records.filter(r => r.isAbsent).length;
  const totalLateMinutes = records.reduce((sum, r) => sum + (r.lateMinutes || 0), 0);
  const totalLatePenaltyUnits = records.reduce((sum, r) => sum + (r.effectiveLatePenalty || 0), 0);
  const totalEarlyCheckoutUnits = records.reduce((sum, r) => sum + (r.effectiveEarlyPenalty || 0), 0);
  const totalEffectiveDeductionUnits = records.reduce((sum, r) => sum + (r.effectiveTotalDeductionUnits || 0), 0);
  const lateDays = records.filter(r => (r.lateMinutes || 0) > 0).length;
  const totalOvertimeHours = records.reduce((sum, r) => sum + (r.effectiveOvertimeUnits ?? r.overtimeHours ?? 0), 0);

  // ── Overtime + bonus pay — day-specific multipliers (Friday / holiday / weekend / night shift) ──
  // Certification HIGH#2: morningOTAmount/eveningOTAmount are computed here —
  // and ONLY here — as an EXACT two-way partition of overtimeAmount. Routes
  // must never multiply hours by rate/multiplier themselves; they only ever
  // display these two fields plus overtimeAmount, all sourced from this one
  // function. See PAYROLL_CONSISTENCY_ARCHITECTURE.md.
  let overtimeAmount = 0;
  let holidayBonusAmount = 0;
  let nightShiftBonusAmount = 0;
  // Accumulated in integer CENTS, not float currency units, so the final
  // morning/evening split is an exact integer partition of the total — no
  // floating-point rounding gap is even possible, by construction.
  let morningCents = 0;
  let eveningCents = 0;
  for (const r of records) {
    const otHours = r.effectiveOvertimeUnits ?? r.overtimeHours ?? 0;
    const mult = selectOvertimeMultiplier(r, { otMultiplier, fridayOTMultiplier, holidayOTMultiplier, weekendOTMultiplier });
    const dayAmt = otHours * hourlyRate * mult;
    overtimeAmount += dayAmt;

    // Split THIS day's OT money using the SAME morning/evening hour split
    // attendanceEngine already computed for this record. Weekend/holiday
    // "all worked hours are overtime" days have no morning/evening split at
    // the attendance level (attendanceEngine.js sets both to 0 by design for
    // those days) — that money, and the flat holiday/night-shift bonuses
    // below (which are day-rate bonuses, not hourly OT, so they have no
    // morning/evening meaning either), is attributed to the evening bucket
    // by convention. This is a documented labeling choice, not a formula
    // change — every cent of overtimeAmount still lands in exactly one of
    // the two buckets, so the published total is never altered.
    const rMorningHours = r.morningOvertimeHours || 0;
    const rEveningHours = r.eveningOvertimeHours || 0;
    const splittableHours = rMorningHours + rEveningHours;
    const dayAmtCents = Math.round(dayAmt * 100);
    if (splittableHours > 0 && otHours > 0) {
      // Proportional split by this day's own morning/evening hour ratio;
      // evening takes the exact remainder so the two shares always sum to
      // dayAmtCents with no gap, even for a single record.
      const morningShareCents = Math.round(dayAmtCents * (rMorningHours / splittableHours));
      morningCents += morningShareCents;
      eveningCents += (dayAmtCents - morningShareCents);
    } else {
      eveningCents += dayAmtCents;
    }

    // holiday_pay_multiplier: extra pay for showing up to work on a public holiday
    if (r.isHoliday && r.checkIn && holidayPayMultiplier > 1) {
      holidayBonusAmount += dailyRate * (holidayPayMultiplier - 1);
    }
    // night_shift_start / night_shift_bonus: % bonus when check-in lands in the night shift
    if (nightShiftStartMin !== null && nightShiftBonusPct > 0 && r.checkIn) {
      const checkInMin = r.checkIn.getHours() * 60 + r.checkIn.getMinutes();
      if (checkInMin >= nightShiftStartMin) {
        nightShiftBonusAmount += dailyRate * (nightShiftBonusPct / 100);
      }
    }
  }
  // holidayBonusAmount/nightShiftBonusAmount are flat day-rate bonuses, not
  // hourly OT money — folded into the evening bucket (same convention as
  // unsplittable OT above), in cents, before the single final rounding.
  eveningCents += Math.round((holidayBonusAmount + nightShiftBonusAmount) * 100);

  overtimeAmount = parseFloat((overtimeAmount + holidayBonusAmount + nightShiftBonusAmount).toFixed(2));
  const overtimeAmountCents = Math.round(overtimeAmount * 100);
  // Reconcile any residual rounding cent (from the many small per-day Math.round
  // calls above vs. the single final Math.round on the summed overtimeAmount)
  // into the evening bucket, so morningCents + eveningCents === overtimeAmountCents
  // is an exact integer identity — never merely "close" — for every employee.
  eveningCents += (overtimeAmountCents - (morningCents + eveningCents));
  const morningOTAmount = morningCents / 100;
  const eveningOTAmount = eveningCents / 100;

  // ── Deductions ───────────────────────────────────────────────────────────────
  // Use HR-entered penaltyDays when set (absence permission system).
  // penaltyDays=1 → 1-day deduction (with permission), =2 → 2-day (without permission),
  // custom → any number. Explicit AttendanceDaily.penaltyDays always wins;
  // only when it's null does the configured absence_deduct_days rule apply.
  const defaultAbsenceDeductDays = parseFloat(rules.absence_deduct_days ?? '1') || 1;
  const totalAbsencePenaltyDays = records
    .filter(r => r.isAbsent)
    .reduce((sum, r) => sum + (r.penaltyDays != null ? r.penaltyDays : defaultAbsenceDeductDays), 0);
  const absentDeduction = totalAbsencePenaltyDays * dailyRate;

  // Canonical late/early-leave penalty: Policy Engine deduction units
  // (latePenaltyUnits / earlyCheckoutUnits, computed per-day by
  // attendanceEngine.computeDerivedFields from AttendancePolicy tiers,
  // post approved-adjustment overlay) × hourlyRate. 1 unit = 1 hour's pay.
  // This is the single source of truth for these deductions — it feeds
  // payroll, reports, and printing identically (see final-sheet endpoint).
  const latePenalty = totalLatePenaltyUnits * hourlyRate;
  const earlyLeavePenalty = totalEarlyCheckoutUnits * hourlyRate;

  // penaltyUnits/penaltyAmount: EVERY deduction unit that reduces net salary —
  // day-scoped effective units (late + early-leave, already summed into
  // totalEffectiveDeductionUnits by mergeEffectivePenalty). This is the
  // canonical "ساعات الخصم" figure shown on PayrollPage and the final-sheet —
  // nothing that affects netSalary is ever excluded from it.
  const penaltyUnits = parseFloat(totalEffectiveDeductionUnits.toFixed(2));
  const penaltyAmount = parseFloat((penaltyUnits * hourlyRate).toFixed(2));

  // Get advances for this month
  const advancesList = await prisma.advance.findMany({
    where: { employeeId, month, year },
  });
  const totalAdvances = advancesList.reduce((sum, a) => sum + a.amount, 0);

  // manualDeductionAdjustment: HR-entered additive deduction, preserved across
  // recalcs exactly like `bonus` — never derived by the engine.
  const manualDeductionAdjustment = existingPayroll?.manualDeductionAdjustment || 0;

  // ONE implementation of "total deductions" — shared with routes/payroll.js's
  // final-sheet route so the two can never diverge again (advances is
  // deliberately NOT a parameter here; it's always a separate top-level
  // subtraction in the net-salary formula, matching the Payroll schema).
  const breakdown = computeDeductionsBreakdown({
    absentAmount: absentDeduction,
    lateAmount: latePenalty,
    earlyAmount: earlyLeavePenalty,
    manualDeductionAdjustment,
  });
  const deductions = breakdown.total;

  // ── THE authoritative net-salary formula ────────────────────────────────────
  //   net = basic + overtime + bonus − deductions − advances
  // Identical to PUT /payroll/:id. `bonus` is a manual HR field — preserved
  // from the existing row (engine never derives or resets it).
  const bonus = existingPayroll?.bonus || 0;
  const netSalary = basicSalary + overtimeAmount + bonus - deductions - totalAdvances;

  return {
    basicSalary,
    dailyRate,
    hourlyRate,
    workDays,
    absentDays,
    totalAbsencePenaltyDays,
    // Certification HIGH#1: itemized money components, already computed above
    // as local variables — exposed here (additive only, no formula change) so
    // routes/payroll.js's /final-sheet can source every money figure from this
    // one pure function instead of independently re-deriving them.
    absentAmount: absentDeduction,
    latePenalty,
    earlyLeavePenalty,
    penaltyUnits,
    penaltyAmount,
    overtimeHours: totalOvertimeHours,
    overtimeAmount,
    // Certification HIGH#2: the ONLY place morningOTAmount/eveningOTAmount are
    // ever computed — an exact two-way partition of overtimeAmount (see the
    // integer-cents split above). Callers must never multiply hours by rate
    // themselves; they only ever display these two fields.
    morningOTAmount,
    eveningOTAmount,
    bonus,
    advances: totalAdvances,
    manualDeductionAdjustment,
    deductions,
    netSalary,
    appliedAdjustments,
  };
}

/**
 * The ONE implementation of "itemized deductions → total deductions".
 * Used by both calculatePayroll (persisted Payroll row) and
 * routes/payroll.js's final-sheet route (printed/displayed breakdown) — the
 * only two places a "total deductions" figure is ever computed. `advances`
 * is intentionally not part of this total; it is always a separate top-level
 * subtraction in the net-salary formula (see Payroll schema / PayrollPage).
 */
function computeDeductionsBreakdown({ absentAmount, lateAmount, earlyAmount, manualDeductionAdjustment }) {
  const total = parseFloat((
    (absentAmount || 0) + (lateAmount || 0) + (earlyAmount || 0) + (manualDeductionAdjustment || 0)
  ).toFixed(2));
  return {
    absentAmount: absentAmount || 0,
    lateAmount: lateAmount || 0,
    earlyAmount: earlyAmount || 0,
    manualDeductionAdjustment: manualDeductionAdjustment || 0,
    total,
  };
}

// ─── Per-employee-month serialization (EF-003.3.2) ──────────────────────────
// calculatePayroll() is invoked from many independent trigger sources
// (attendance manual edit, adjustments, payroll edit, advances, realtime
// listener, historical rebuild, scheduler, ...) with no coordination. Two
// concurrent calls for the SAME employeeId+month+year each independently
// read the existing Payroll row (to preserve HR-entered bonus/
// manualDeductionAdjustment), compute, and upsert — whichever upsert commits
// last silently overwrites the other's preserved values with no error.
// Same in-process queue-and-wait mutex pattern as attendanceEngine.js's
// dateKeyLocks — additive, narrowly-scoped, matches this codebase's
// single-process deployment topology.
const payrollKeyLocks = new Map(); // "employeeId|month|year" -> { tail: Promise, token: object }
const PAYROLL_LOCK_ACQUIRE_TIMEOUT_MS = 15000;

async function withPayrollKeyLock(employeeId, month, year, fn) {
  const key = `${employeeId}|${month}|${year}`;
  const entry = payrollKeyLocks.get(key);
  const previousTail = entry ? entry.tail : Promise.resolve();

  let markDone;
  const ourCompletion = new Promise((resolve) => { markDone = resolve; });
  const ourTail = previousTail.then(() => ourCompletion, () => ourCompletion);
  const token = {};
  payrollKeyLocks.set(key, { tail: ourTail, token });

  let timedOut = false;
  await Promise.race([
    previousTail.catch(() => {}),
    new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(); }, PAYROLL_LOCK_ACQUIRE_TIMEOUT_MS)),
  ]);
  if (timedOut) {
    logger.error(`[PAYROLL-LOCK] timeout after ${PAYROLL_LOCK_ACQUIRE_TIMEOUT_MS}ms waiting for employee=${employeeId} ${month}/${year} — proceeding without serialization (fail-open)`);
  }

  try {
    return await fn();
  } finally {
    markDone();
    // Only remove the map entry if nobody has queued behind us since.
    const current = payrollKeyLocks.get(key);
    if (current && current.token === token) payrollKeyLocks.delete(key);
  }
}

// ─── Public entry point — unchanged signature/behavior, now serialized ─────
async function calculatePayroll(employeeId, month, year) {
  return withPayrollKeyLock(employeeId, month, year, () => calculatePayrollImpl(employeeId, month, year));
}

async function calculatePayrollImpl(employeeId, month, year) {
  const computed = await computePayroll(employeeId, month, year);
  const {
    basicSalary, hourlyRate, workDays, absentDays, latePenalty,
    penaltyUnits, penaltyAmount,
    overtimeHours, overtimeAmount, bonus, advances, manualDeductionAdjustment,
    deductions, netSalary, appliedAdjustments,
  } = computed;

  logger.info(
    `[PAYROLL] [PAYROLL-RECALC] recalc emp=${employeeId} ${month}/${year}: basic=${basicSalary} ot=${overtimeAmount} ` +
    `bonus=${bonus}${bonus ? ' (preserved)' : ''} manualDeductionAdj=${manualDeductionAdjustment} ` +
    `deductions=${deductions.toFixed(2)} advances=${advances} ` +
    `net=${netSalary.toFixed(2)} adjustmentsApplied=${appliedAdjustments}`
  );

  const payroll = await prisma.payroll.upsert({
    where: { employeeId_month_year: { employeeId, month, year } },
    update: {
      basicSalary,
      hourlyRate,
      workDays,
      absentDays,
      latePenalty,
      penaltyUnits,
      penaltyAmount,
      overtimeHours,
      overtimeAmount,
      bonus,
      advances,
      manualDeductionAdjustment,
      deductions,
      netSalary,
      updatedAt: new Date(),
    },
    create: {
      employeeId,
      month,
      year,
      basicSalary,
      hourlyRate,
      workDays,
      absentDays,
      latePenalty,
      penaltyUnits,
      penaltyAmount,
      overtimeHours,
      overtimeAmount,
      bonus,
      advances,
      manualDeductionAdjustment,
      deductions,
      netSalary,
    },
  });

  return payroll;
}

// ─── C1 canonical safety boundary ──────────────────────────────────────────
// Finalized/paid Payroll rows must never be silently overwritten by an
// indirect recalculation cascade (rule change, holiday change, adjustment
// approval, cleanup's recalc cascade — none of these are the user directly
// opening and re-saving THAT payroll row, unlike PUT /payroll/:id or the
// explicit "احتساب المرتبات" button in payroll.js, which intentionally keep
// working unconditionally and are NOT touched by this function).
//
// This is a shared, batched pre-check — ONE Prisma query regardless of how
// many {employeeId, month, year} targets are passed — used by every current
// cascade caller (recalcEngine.recalcScope, adjustments.js) instead of each
// duplicating its own finalized/paid lookup. calculatePayroll() itself is
// deliberately left unmodified: it has no way to distinguish "an intentional
// direct edit of this exact row" from "a side-effect of an unrelated change
// elsewhere", so the decision belongs at each cascade's call site, not inside
// the engine's single canonical write function.
//
// Returns { allowed, protectedTargets } — `allowed` is the subset of
// `targets` safe to pass to calculatePayroll(); `protectedTargets` is the
// subset that was finalized/paid and must be skipped, each annotated with
// its current `status` for reporting/logging.
async function filterProtectedPayrollTargets(targets) {
  const list = (targets || []).filter(t => t && t.employeeId != null && t.month != null && t.year != null);
  if (!list.length) return { allowed: [], protectedTargets: [] };

  const employeeIds = [...new Set(list.map(t => t.employeeId))];
  const monthOr = [...new Set(list.map(t => `${t.month}-${t.year}`))]
    .map(k => { const [month, year] = k.split('-').map(Number); return { month, year }; });

  const finalizedRows = await prisma.payroll.findMany({
    where: { employeeId: { in: employeeIds }, OR: monthOr, status: { in: ['finalized', 'paid'] } },
    select: { employeeId: true, month: true, year: true, status: true },
  });
  const protectedMap = new Map(finalizedRows.map(r => [`${r.employeeId}|${r.month}|${r.year}`, r.status]));

  const allowed = [];
  const protectedTargets = [];
  for (const t of list) {
    const key = `${t.employeeId}|${t.month}|${t.year}`;
    if (protectedMap.has(key)) protectedTargets.push({ ...t, status: protectedMap.get(key) });
    else allowed.push(t);
  }
  return { allowed, protectedTargets };
}

async function calculateMonthlyPayroll(month, year, branchId) {
  const employees = await prisma.employee.findMany({
    where: { status: true, branchId: branchId || undefined },
  });

  // C1: this is the "احتساب المرتبات" bulk button — a whole-month/branch
  // batch generation, not a targeted edit of any one Payroll row, and it has
  // no confirmation flow. A month where SOME employees were already
  // finalized/paid (a normal mid-cycle state: HR finalizes leavers early,
  // then later reruns the bulk calc for everyone else still in draft) must
  // not silently overwrite those already-closed rows. Same canonical,
  // batched check every other cascade caller uses (Phase 13.3).
  const targets = employees.map((emp) => ({ employeeId: emp.id, month, year }));
  const { allowed, protectedTargets } = await filterProtectedPayrollTargets(targets);
  if (protectedTargets.length) {
    logger.warn(`[PAYROLL] calculateMonthlyPayroll ${month}/${year}: SKIPPED ${protectedTargets.length} finalized/paid employee(s): ` +
      protectedTargets.map(t => `emp=${t.employeeId} (${t.status})`).join(', '));
  }

  const results = [];
  for (const { employeeId } of allowed) {
    try {
      const p = await calculatePayroll(employeeId, month, year);
      results.push(p);
    } catch (err) {
      logger.error(`Payroll error emp ${employeeId}: ${err.message}`);
    }
  }
  return { results, protectedTargets };
}

module.exports = { calculatePayroll, calculateMonthlyPayroll, computePayroll, applyApprovedAdjustment, computeDeductionsBreakdown, withPayrollKeyLock, calculatePayrollImpl, selectOvertimeMultiplier, computeRates, filterProtectedPayrollTargets };
