/**
 * Attendance Adjustment Routes
 * Architecture: Raw Logs → Policy Engine → Adjustments → Payroll
 *
 * Rules:
 * - Never modify raw biometric logs (attendance_logs)
 * - Adjustments overlay auto-calculated AttendanceDaily values
 * - Only approved adjustments affect payroll
 * - Every change is logged to AdjustmentAuditLog
 */
const router = require('express').Router();
const { resolveActor } = require('../utils/auditActor');
const { sendError, numericIdParam } = require('../utils/apiError');
router.param('id', numericIdParam);
const { getPrisma } = require('../utils/prisma');
const moment = require('moment');
const payrollEngine = require('../engines/payrollEngine');
const attendanceEngine = require('../engines/attendanceEngine');
const logger = require('../utils/logger');
const { authenticate, authorize } = require('../middleware/auth');
const { currentMonthRange } = require('../utils/monthRange');
const { attendanceScopeWhere } = require('../utils/employmentEligibility');
const { writeAudit } = require('../utils/manualEditAudit');

const prisma = getPrisma();

// EF-007.4: these adjustment override fields feed directly into
// applyApprovedAdjustment()'s totalDeductionUnits (payrollEngine.js), which
// is subtracted from netSalary — a negative value there increases pay
// instead of deducting it. Only validates when the field is actually
// supplied (null/undefined = "no override", unchanged, still valid).
const NUMERIC_ADJ_FIELDS = [
  'adjWorkedMinutes', 'adjLateMinutes', 'adjOvertimeHours', 'adjMorningOT', 'adjEveningOT',
  'adjLatePenalty', 'adjEarlyPenalty', 'adjTotalDeductions',
];
function validateAdjustmentNumbers(body) {
  for (const key of NUMERIC_ADJ_FIELDS) {
    const v = body[key];
    if (v === undefined || v === null) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return `${key} يجب أن تكون رقمًا موجبًا`;
  }
  return null;
}

// Production/LAN endpoint — approval-workflow mutations affect payroll and must
// be gated exactly like attendance.js/employees.js. No-op when AUTH_ENABLED=false.
router.use(authenticate);

// Approved adjustments are authoritative payroll inputs (payrollEngine merges
// them during aggregation) — so every approval-state change must recalculate
// the affected employee's payroll for that month, or the books go stale.
//
// F-17: this used to be fire-and-forget — the HTTP response (and so the client's
// follow-up Payroll read) could be sent BEFORE the recalculation had committed,
// and the PUT / flag routes (which turn an approved adjustment back into a
// pending one, i.e. REMOVE it from payroll) never recalculated at all. It now
// returns a promise that settles only after the canonical sequence has finished
// (commit -> calculatePayroll under the payroll lock -> realtime event), and
// callers await it before answering. It never throws: a failed recalculation is
// logged and reported as { status: 'failed' } without failing the adjustment.
// Resolves to { status: 'recalculated' | 'protected' | 'failed', payrollStatus? }.
async function recalcForAdjustment(adj, io, why) {
  if (!adj) return { status: 'skipped' };
  const m = moment(adj.date);
  const target = { employeeId: adj.employeeId, month: m.month() + 1, year: m.year() };
  // C1 canonical safety boundary: an adjustment approval/edit/revert is a
  // side-effect trigger, not the user directly opening this Payroll row, and
  // this path has no confirmation flow to fall back on (unlike cleanup.js) —
  // so a finalized/paid target here is protected (skipped, not overwritten)
  // rather than silently recalculated. See payrollEngine.
  // filterProtectedPayrollTargets() for the shared check every such cascade
  // caller (recalcEngine.recalcScope, this function, bulk-approve below) uses.
  try {
    const { protectedTargets } = await payrollEngine.filterProtectedPayrollTargets([target]);
    if (protectedTargets.length) {
      logger.warn(`[PAYROLL] adjustment ${why}: SKIPPED emp=${adj.employeeId} ${m.month() + 1}/${m.year()} — payroll is ${protectedTargets[0].status} (adj #${adj.id})`);
      // Screens still refresh: the Payroll list / Final Salary figures are computed
      // fresh (and the stored snapshot is re-synced on read), so they pick up the change.
      if (io) io.emit('attendance:processed', { employeeId: adj.employeeId, source: `adjustment-${why}` });
      return { status: 'protected', payrollStatus: protectedTargets[0].status };
    }
    await payrollEngine.calculatePayroll(adj.employeeId, m.month() + 1, m.year());
    logger.info(`[PAYROLL] adjustment ${why}: recalculated emp=${adj.employeeId} ${m.month() + 1}/${m.year()} (adj #${adj.id})`);
    if (io) io.emit('attendance:processed', { employeeId: adj.employeeId, source: `adjustment-${why}` });
    return { status: 'recalculated' };
  } catch (err) {
    logger.error(`[PAYROLL] adjustment ${why} recalc failed (adj #${adj.id}): ${err.message}`);
    return { status: 'failed' };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function toHHMM(dt) {
  if (!dt) return null;
  return moment(dt).format('HH:mm');
}

async function logAudit(adjustmentId, action, opts = {}) {
  const client = opts.tx || prisma;
  await client.adjustmentAuditLog.create({
    data: {
      adjustmentId,
      action,
      fieldName:     opts.field     || null,
      oldValue:      opts.old != null ? String(opts.old) : null,
      newValue:      opts.new != null ? String(opts.new) : null,
      changedBy:     opts.userId    || 0,
      changedByName: opts.userName  || 'System',
      changedByRole: opts.userRole  || 'system',
      reason:        opts.reason    || null,
    },
  });
}

// ── Who owns the AttendanceDaily.manualEdit lock? ─────────────────────────────
// manualEdit=true is set by TWO independent things: an inline HR edit
// (PUT /attendance/daily/:id etc.) and the APPROVAL of an adjustment. Only the
// second is this module's to undo. An adjustment never rewrites the daily row
// (it is a read-time overlay), so releasing the lock only matters when an
// independent manual edit also lives on that row — and releasing then lets the
// engine rebuild the row from raw punches, silently destroying that edit.
//
// Rejecting / reverting an adjustment therefore releases the lock ONLY when
// approving it is provably what set the lock and nothing has edited the row
// since. Every doubt resolves to "keep the lock" — the safe direction: a lock
// that is kept can still be cleared explicitly with POST /daily/:id/restore-auto.
//
//  1. Never approved (adj.approvedAt is null): this adjustment never acquired the
//     lock → never release. Decided from approvedAt, NOT from the current
//     approvalStatus: editing (PUT /:id) or flagging (POST /:id/flag) an approved
//     adjustment sets it back to 'pending' while the lock its approval set stays on.
//  2. At the FIRST approval the row was ALREADY manually edited → recorded on that
//     approval's own audit event (fieldName 'manualEdit', oldValue 'true'; see
//     planManualLock) → never release.
//  3. The row was written after the approval → an independent edit happened later →
//     never release.
//       - Approvals made with this code: the approval stamps the daily row's
//         updatedAt with EXACTLY adj.approvedAt (one shared timestamp, see the
//         approve routes). Any other writer produces a different timestamp, so
//         "updatedAt !== approvedAt" means an independent write — no time window.
//       - Older approvals (no baseline event on record) cannot be matched exactly:
//         only for those, a 5 s window around approvedAt stands in for the
//         approval's own write.
const APPROVAL_WRITE_WINDOW_MS = 5000;

async function shouldReleaseManualLock(adj, db = prisma) {
  if (!adj || !adj.approvedAt) return false;

  const daily = await db.attendanceDaily.findUnique({
    where: { id: adj.attendanceDailyId },
    select: { manualEdit: true, updatedAt: true },
  });
  if (!daily || !daily.manualEdit) return false;   // nothing to release

  const approvalEvent = await db.adjustmentAuditLog.findFirst({
    where: { adjustmentId: adj.id, action: 'approved', fieldName: 'manualEdit' },
    orderBy: { changedAt: 'asc' },
    select: { oldValue: true },
  });
  if (approvalEvent?.oldValue === 'true') return false;

  const writtenAt = daily.updatedAt ? new Date(daily.updatedAt).getTime() : NaN;
  const approvedAtMs = new Date(adj.approvedAt).getTime();
  if (approvalEvent) return writtenAt === approvedAtMs;                       // exact match
  return Math.abs(writtenAt - approvedAtMs) <= APPROVAL_WRITE_WINDOW_MS;      // legacy fallback (NaN → false)
}

// Called by both approve routes BEFORE they touch the daily row. `priorAdj` is the
// adjustment as it was before this approval ({ id, attendanceDailyId, approvedAt }).
//  - baseline: recorded ONLY on the first approval (priorAdj.approvedAt null) — what
//    the lock was before this adjustment ever acquired it. A re-approval never
//    writes a new baseline, so the original one is preserved (and the lock an
//    earlier approval set is never mistaken for an independent manual edit).
//  - skipWrite: a re-approval of a row that is already locked, where that lock is
//    not provably the earlier approval's own → an independent manual edit lives on
//    the row. Leave the row (and its updatedAt) untouched so the exact-timestamp
//    check keeps recognising it as independent.
async function planManualLock(db, priorAdj, adj) {
  const daily = await db.attendanceDaily.findUnique({
    where: { id: adj.attendanceDailyId }, select: { manualEdit: true },
  });
  const firstApproval = !priorAdj?.approvedAt;
  const skipWrite = !firstApproval && !!daily?.manualEdit
    && !(await shouldReleaseManualLock(priorAdj, db));
  return {
    skipWrite,
    baseline: firstApproval && daily
      ? { field: 'manualEdit', old: daily.manualEdit, new: true }
      : {},
  };
}

// Build the "effective" merged record (original + approved overrides).
// This is a thin UI-facing wrapper around the ONE canonical merge —
// payrollEngine.applyApprovedAdjustment + attendanceEngine.mergeEffectivePenalty
// — so this page can never disagree with what payroll actually pays. No
// deduction-unit math is duplicated here.
function mergeEffective(daily, adj) {
  if (!adj || adj.approvalStatus !== 'approved') return { ...daily, hasAdjustment: false };

  const applied = payrollEngine.applyApprovedAdjustment(daily, adj);
  const merged  = attendanceEngine.mergeEffectivePenalty(applied);

  return {
    ...merged,
    checkIn:  toHHMM(merged.checkIn),
    checkOut: toHHMM(merged.checkOut),
    // This route's existing consumers read latePenaltyUnits/earlyCheckoutUnits/
    // totalDeductionUnits as "the effective number for this row" — map the
    // canonical effective* fields onto those names so callers are unaffected.
    latePenaltyUnits:    merged.effectiveLatePenalty,
    earlyCheckoutUnits:  merged.effectiveEarlyPenalty,
    totalDeductionUnits: merged.effectiveTotalDeductionUnits,
    hasAdjustment:        true,
    adjustmentStatus:     adj.approvalStatus,
    adjustmentId:         adj.id,
  };
}

// Phase 31 (F1 fix — Phase 25 audit, Critical): these four GETs previously
// required only a valid login. Adjustment/deduction records are HR/payroll
// administrative data with no self-service view in the app, so admin/hr
// only — matching the already-correctly-gated write routes below.
// ── GET /api/adjustments — list all with filters ───────────────────────────────
router.get('/', authorize('admin', 'hr'), async (req, res) => {
  try {
    const { employeeId, branchId, from, to, status, page = 1, limit = 100 } = req.query;

    const defaultRange = currentMonthRange();
    const startDate = from ? new Date(from) : defaultRange.start.toDate();
    const endDate   = to   ? new Date(to)   : defaultRange.end.toDate();

    const empWhere = attendanceScopeWhere({ from: startDate, to: endDate });
    if (branchId) empWhere.branchId = parseInt(branchId);
    if (employeeId) empWhere.id = parseInt(employeeId);

    const employees = await prisma.employee.findMany({
      where: empWhere,
      select: { id: true },
    });
    const empIds = employees.map(e => e.id);

    const adjustments = await prisma.attendanceAdjustment.findMany({
      where: {
        employeeId: { in: empIds },
        date: { gte: startDate, lte: endDate },
        ...(status ? { approvalStatus: status } : {}),
      },
      include: {
        employee: { include: { department: true, branch: true } },
        attendanceDaily: true,
        auditLogs: { orderBy: { changedAt: 'desc' }, take: 5 },
      },
      orderBy: [{ date: 'desc' }, { updatedAt: 'desc' }],
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit),
    });

    const total = await prisma.attendanceAdjustment.count({
      where: {
        employeeId: { in: empIds },
        date: { gte: startDate, lte: endDate },
        ...(status ? { approvalStatus: status } : {}),
      },
    });

    res.json({ adjustments, total });
  } catch (err) { sendError(res, err); }
});

// ── GET /api/adjustments/daily — full attendance + adjustment overlay ──────────
// Main page data source: returns all daily records with adjustment status merged in
router.get('/daily', authorize('admin', 'hr'), async (req, res) => {
  try {
    const { employeeId, branchId, from, to, date } = req.query;

    let startDate, endDate;
    if (date) {
      startDate = endDate = new Date(date);
    } else {
      const defaultRange = currentMonthRange();
      startDate = from ? new Date(from) : defaultRange.start.toDate();
      endDate   = to   ? new Date(to)   : defaultRange.end.toDate();
    }

    const empWhere = attendanceScopeWhere({ from: startDate, to: endDate });
    if (branchId)    empWhere.branchId = parseInt(branchId);
    if (employeeId)  empWhere.id       = parseInt(employeeId);

    const employees = await prisma.employee.findMany({
      where: empWhere,
      include: { department: true, branch: true, shift: true },
    });
    const empIds = employees.map(e => e.id);
    const empMap = new Map(employees.map(e => [e.id, e]));

    const [dailyRecords, adjRecords] = await Promise.all([
      prisma.attendanceDaily.findMany({
        where: { employeeId: { in: empIds }, date: { gte: startDate, lte: endDate } },
        orderBy: [{ date: 'asc' }, { employeeId: 'asc' }],
      }),
      prisma.attendanceAdjustment.findMany({
        where: { employeeId: { in: empIds }, date: { gte: startDate, lte: endDate } },
        include: { auditLogs: { orderBy: { changedAt: 'desc' }, take: 1 } },
      }),
    ]);

    const adjMap = new Map(adjRecords.map(a => [a.attendanceDailyId, a]));

    const rows = dailyRecords.map(daily => {
      const emp = empMap.get(daily.employeeId);
      const adj = adjMap.get(daily.id);
      const effective = mergeEffective(daily, adj);
      return {
        id:               daily.id,
        employeeId:       daily.employeeId,
        employeeName:     emp?.name    || '',
        employeeCode:     emp?.code    || '',
        department:       emp?.department?.name || '',
        branch:           emp?.branch?.name     || '',
        shift:            emp?.shift?.name       || '',
        date:             moment(daily.date).format('YYYY-MM-DD'),
        // Original auto-calculated
        origCheckIn:      toHHMM(daily.checkIn),
        origCheckOut:     toHHMM(daily.checkOut),
        origWorkedHours:  +(daily.workedMinutes / 60).toFixed(2),
        origLateMinutes:  daily.lateMinutes,
        origOTHours:      daily.overtimeHours,
        origMorningOT:    daily.morningOvertimeHours,
        origEveningOT:    daily.eveningOvertimeHours,
        origLatePenalty:  daily.latePenaltyUnits,
        origEarlyPenalty: daily.earlyCheckoutUnits,
        origDeductions:   daily.totalDeductionUnits,
        origStatus:       daily.status,
        origIsAbsent:     daily.isAbsent,
        // Effective (with adjustment applied)
        checkIn:          effective.checkIn,
        checkOut:         effective.checkOut,
        workedHours:      +(((effective.workedMinutes||0) / 60).toFixed(2)),
        lateMinutes:      effective.lateMinutes,
        otHours:          effective.overtimeHours,
        latePenalty:      effective.latePenaltyUnits,
        earlyPenalty:     effective.earlyCheckoutUnits,
        totalDeductions:  effective.totalDeductionUnits,
        status:           effective.status,
        isAbsent:         effective.isAbsent,
        isWeekend:        daily.isWeekend,
        isHoliday:        daily.isHoliday,
        // Adjustment metadata
        hasAdjustment:    !!adj,
        adjustmentId:     adj?.id || null,
        adjustmentStatus: adj?.approvalStatus || null,
        adjustmentReason: adj?.reason || null,
        ignoreLate:       adj?.ignoreLate || false,
        ignoreEarlyLeave: adj?.ignoreEarlyLeave || false,
        forcePresent:     adj?.forcePresent || false,
        lastEditBy:       adj?.auditLogs?.[0]?.changedByName || null,
        lastEditAt:       adj?.auditLogs?.[0]?.changedAt || null,
      };
    });

    // Counts
    const counts = {
      total:    rows.length,
      present:  rows.filter(r => !r.isAbsent && !r.isWeekend && !r.isHoliday).length,
      absent:   rows.filter(r => r.isAbsent).length,
      adjusted: rows.filter(r => r.hasAdjustment).length,
      pending:  rows.filter(r => r.adjustmentStatus === 'pending').length,
      approved: rows.filter(r => r.adjustmentStatus === 'approved').length,
    };

    res.json({ rows, counts });
  } catch (err) { sendError(res, err); }
});

// ── GET /api/adjustments/:id — single adjustment with full audit ───────────────
router.get('/:id', authorize('admin', 'hr'), async (req, res) => {
  try {
    const adj = await prisma.attendanceAdjustment.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        employee: { include: { department: true, shift: true } },
        attendanceDaily: true,
        auditLogs: { orderBy: { changedAt: 'desc' } },
      },
    });
    if (!adj) return res.status(404).json({ error: 'Adjustment not found' });
    res.json(adj);
  } catch (err) { sendError(res, err); }
});

// ── POST /api/adjustments — create from a daily record ────────────────────────
router.post('/', authorize('admin', 'hr'), async (req, res) => {
  try {
    const {
      attendanceDailyId, reason, hrComment,
      adjCheckIn, adjCheckOut, adjWorkedMinutes, adjLateMinutes,
      adjOvertimeHours, adjMorningOT, adjEveningOT,
      adjLatePenalty, adjEarlyPenalty, adjTotalDeductions,
      adjStatus, adjIsAbsent,
      ignoreLate, ignoreEarlyLeave, forcePresent,
    } = req.body;
    // F-10: the authenticated session is the actor; body-claimed actor fields are ignored.
    const { id: createdBy, name: createdByName, role: createdByRole } = resolveActor(req, { id: req.body.createdBy, name: req.body.createdByName, role: req.body.createdByRole });

    const numErr = validateAdjustmentNumbers(req.body);
    if (numErr) return res.status(400).json({ error: numErr });

    const daily = await prisma.attendanceDaily.findUnique({
      where: { id: parseInt(attendanceDailyId) },
    });
    if (!daily) return res.status(404).json({ error: 'Attendance record not found' });

    // EF-016.1: future attendance modification is never allowed, by company
    // policy — same guard already enforced on every manual-edit route in
    // routes/attendance/manual.js. An adjustment is a manual override just
    // like those, so it must be rejected at creation for a future date too.
    if (moment(daily.date).startOf('day').isAfter(moment().startOf('day'))) {
      return res.status(400).json({ error: 'لا يمكن تعديل أيام مستقبلية.' });
    }

    // Check if adjustment already exists
    const existing = await prisma.attendanceAdjustment.findUnique({
      where: { attendanceDailyId: parseInt(attendanceDailyId) },
    });
    if (existing) return res.status(409).json({ error: 'Adjustment already exists. Use PUT to update.', adjustmentId: existing.id });

    const adj = await prisma.attendanceAdjustment.create({
      data: {
        attendanceDailyId: parseInt(attendanceDailyId),
        employeeId: daily.employeeId,
        date: daily.date,
        // Snapshot
        snapCheckIn:         toHHMM(daily.checkIn),
        snapCheckOut:        toHHMM(daily.checkOut),
        snapWorkedMinutes:   daily.workedMinutes,
        snapLateMinutes:     daily.lateMinutes,
        snapOvertimeHours:   daily.overtimeHours,
        snapMorningOT:       daily.morningOvertimeHours,
        snapEveningOT:       daily.eveningOvertimeHours,
        snapLatePenalty:     daily.latePenaltyUnits,
        snapEarlyPenalty:    daily.earlyCheckoutUnits,
        snapTotalDeductions: daily.totalDeductionUnits,
        snapStatus:          daily.status,
        snapIsAbsent:        daily.isAbsent,
        // Overrides
        adjCheckIn, adjCheckOut,
        adjWorkedMinutes: adjWorkedMinutes != null ? parseInt(adjWorkedMinutes) : null,
        adjLateMinutes:   adjLateMinutes   != null ? parseInt(adjLateMinutes)   : null,
        adjOvertimeHours: adjOvertimeHours != null ? parseFloat(adjOvertimeHours) : null,
        adjMorningOT:     adjMorningOT     != null ? parseFloat(adjMorningOT)     : null,
        adjEveningOT:     adjEveningOT     != null ? parseFloat(adjEveningOT)     : null,
        adjLatePenalty:   adjLatePenalty   != null ? parseFloat(adjLatePenalty)   : null,
        adjEarlyPenalty:  adjEarlyPenalty  != null ? parseFloat(adjEarlyPenalty)  : null,
        adjTotalDeductions: adjTotalDeductions != null ? parseFloat(adjTotalDeductions) : null,
        adjStatus, adjIsAbsent,
        // Flags
        ignoreLate:       !!ignoreLate,
        ignoreEarlyLeave: !!ignoreEarlyLeave,
        forcePresent:     !!forcePresent,
        // Workflow
        reason, hrComment,
        approvalStatus: 'pending',
        createdBy, createdByName, createdByRole,
      },
    });

    await logAudit(adj.id, 'created', { userId: createdBy, userName: createdByName, userRole: createdByRole, reason });

    res.status(201).json(adj);
  } catch (err) { sendError(res, err); }
});

// ── PUT /api/adjustments/:id — update overrides ────────────────────────────────
router.put('/:id', authorize('admin', 'hr'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.attendanceAdjustment.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Adjustment not found' });

    // EF-016.1: same future-date guard as creation — see POST / above.
    if (moment(existing.date).startOf('day').isAfter(moment().startOf('day'))) {
      return res.status(400).json({ error: 'لا يمكن تعديل أيام مستقبلية.' });
    }

    const numErr = validateAdjustmentNumbers(req.body);
    if (numErr) return res.status(400).json({ error: numErr });

    const {
      reason, hrComment,
      adjCheckIn, adjCheckOut, adjWorkedMinutes, adjLateMinutes,
      adjOvertimeHours, adjMorningOT, adjEveningOT,
      adjLatePenalty, adjEarlyPenalty, adjTotalDeductions,
      adjStatus, adjIsAbsent,
      ignoreLate, ignoreEarlyLeave, forcePresent,
    } = req.body;
    const { id: changedBy, name: changedByName, role: changedByRole } = resolveActor(req, { id: req.body.changedBy, name: req.body.changedByName, role: req.body.changedByRole });

    const updated = await prisma.attendanceAdjustment.update({
      where: { id },
      data: {
        reason, hrComment,
        adjCheckIn, adjCheckOut,
        adjWorkedMinutes: adjWorkedMinutes != null ? parseInt(adjWorkedMinutes) : undefined,
        adjLateMinutes:   adjLateMinutes   != null ? parseInt(adjLateMinutes)   : undefined,
        adjOvertimeHours: adjOvertimeHours != null ? parseFloat(adjOvertimeHours) : undefined,
        adjMorningOT:     adjMorningOT     != null ? parseFloat(adjMorningOT)     : undefined,
        adjEveningOT:     adjEveningOT     != null ? parseFloat(adjEveningOT)     : undefined,
        adjLatePenalty:   adjLatePenalty   != null ? parseFloat(adjLatePenalty)   : undefined,
        adjEarlyPenalty:  adjEarlyPenalty  != null ? parseFloat(adjEarlyPenalty)  : undefined,
        adjTotalDeductions: adjTotalDeductions != null ? parseFloat(adjTotalDeductions) : undefined,
        adjStatus: adjStatus ?? undefined,
        adjIsAbsent: adjIsAbsent ?? undefined,
        ignoreLate:       ignoreLate       !== undefined ? !!ignoreLate       : undefined,
        ignoreEarlyLeave: ignoreEarlyLeave !== undefined ? !!ignoreEarlyLeave : undefined,
        forcePresent:     forcePresent     !== undefined ? !!forcePresent     : undefined,
        approvalStatus: 'pending', // reset to pending on edit
        updatedAt: new Date(),
      },
    });

    // L1 fix: audit EVERY writable field this route can persist (previously
    // only 7 of the ~16 actual fields in the update() block above were ever
    // checked — adjTotalDeductions, adjIsAbsent, forcePresent, ignoreEarlyLeave,
    // adjWorkedMinutes, adjMorningOT, adjEveningOT, adjEarlyPenalty, adjStatus,
    // hrComment could all change with zero audit trail). Also moved AFTER the
    // update succeeds and compared against the ACTUALLY-persisted `updated`
    // row (not the raw request body) — previously this ran BEFORE the write,
    // so a request whose update() call failed could still leave behind audit
    // rows describing a change that was never actually applied.
    const auditFields = [
      'adjCheckIn', 'adjCheckOut', 'adjWorkedMinutes', 'adjLateMinutes',
      'adjOvertimeHours', 'adjMorningOT', 'adjEveningOT',
      'adjLatePenalty', 'adjEarlyPenalty', 'adjTotalDeductions',
      'adjStatus', 'adjIsAbsent',
      'ignoreLate', 'ignoreEarlyLeave', 'forcePresent',
      'reason', 'hrComment',
    ];
    for (const k of auditFields) {
      const oldV = existing[k];
      const newV = updated[k];
      if (String(oldV ?? '') !== String(newV ?? '')) {
        await logAudit(id, 'field_changed', { field: k, old: oldV, new: newV, userId: changedBy, userName: changedByName, userRole: changedByRole });
      }
    }

    // An edit resets an APPROVED adjustment to pending, i.e. it stops counting in
    // payroll — settle payroll before answering (no-op for an already-pending one).
    const payroll = existing.approvalStatus === 'approved' ? await recalcForAdjustment(updated, req.io, 'edited') : undefined;
    res.json(payroll ? { ...updated, payroll } : updated);
  } catch (err) { sendError(res, err); }
});

// ── POST /api/adjustments/:id/approve ─────────────────────────────────────────
router.post('/:id/approve', authorize('admin', 'hr'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { comment } = req.body;
    const { id: approvedBy, name: approvedByName, role: approvedByRole } = resolveActor(req, { id: req.body.approvedBy, name: req.body.approvedByName }, { name: 'HR Manager' });

    // The adjustment as it was BEFORE this approval — whether it was ever approved
    // decides if a baseline is recorded (see planManualLock / shouldReleaseManualLock).
    const priorAdj = await prisma.attendanceAdjustment.findUnique({
      where: { id }, select: { id: true, attendanceDailyId: true, approvedAt: true },
    });

    // ONE timestamp for both writes: adjustment.approvedAt and the daily row's
    // updatedAt. A later reject/revert recognises "the row was written by this
    // approval" by exact equality, and anything else as an independent write.
    const approvedAt = new Date();

    const adj = await prisma.attendanceAdjustment.update({
      where: { id },
      data: {
        approvalStatus: 'approved',
        approvedBy, approvedByName,
        approvedAt,
        hrComment: comment || null,
        updatedAt: new Date(),
      },
    });

    const lockPlan = await planManualLock(prisma, priorAdj, adj);
    await logAudit(id, 'approved', {
      userId: approvedBy, userName: approvedByName, userRole: approvedByRole, reason: comment,
      ...lockPlan.baseline,
    });

    // Mark the daily record as manually edited — the engine will no longer
    // overwrite it, and payroll consumes the adjustment as authoritative. Skipped
    // only when an independent manual edit already holds the lock (re-approval).
    if (!lockPlan.skipWrite) {
      await prisma.attendanceDaily.update({
        where: { id: adj.attendanceDailyId },
        data: { manualEdit: true, updatedAt: approvedAt },
      });
    }

    const payroll = await recalcForAdjustment(adj, req.io, 'approved');

    res.json({ message: 'تم الاعتماد بنجاح', adjustment: adj, payroll });
  } catch (err) { sendError(res, err); }
});

// ── POST /api/adjustments/:id/reject ──────────────────────────────────────────
router.post('/:id/reject', authorize('admin', 'hr'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = req.body;
    const { id: rejectedBy, name: rejectedByName, role: rejectedByRole } = resolveActor(req, { id: req.body.rejectedBy, name: req.body.rejectedByName }, { name: 'HR Manager' });

    // Decided from the adjustment's state BEFORE it is rejected.
    const beforeAdj = await prisma.attendanceAdjustment.findUnique({ where: { id } });
    const releaseLock = await shouldReleaseManualLock(beforeAdj);

    const adj = await prisma.attendanceAdjustment.update({
      where: { id },
      data: { approvalStatus: 'rejected', hrComment: reason || null, updatedAt: new Date() },
    });

    // A rejected adjustment no longer protects the daily row — but ONLY release
    // the manual-edit hold when this adjustment's approval is what set it. An
    // independent manual edit on the same row stays protected.
    if (releaseLock) {
      await prisma.attendanceDaily.update({
        where: { id: adj.attendanceDailyId },
        data: { manualEdit: false, updatedAt: new Date() },
      }).catch(() => {});
    }
    const payroll = await recalcForAdjustment(adj, req.io, 'rejected');

    await logAudit(id, 'rejected', { userId: rejectedBy, userName: rejectedByName, userRole: rejectedByRole, reason });
    res.json({ message: 'تم الرفض', adjustment: adj, payroll });
  } catch (err) { sendError(res, err); }
});

// ── POST /api/adjustments/:id/revert ──────────────────────────────────────────
router.post('/:id/revert', authorize('admin', 'hr'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { id: revertedBy, name: revertedByName, role: revertedByRole } = resolveActor(req, { id: req.body.revertedBy, name: req.body.revertedByName }, { name: 'System' });

    // Decided BEFORE the delete: the approval's audit event (which records
    // whether the row was already manually edited) cascades away with the row.
    const existingAdj = await prisma.attendanceAdjustment.findUnique({ where: { id } });
    const releaseLock = await shouldReleaseManualLock(existingAdj);

    const adj = await prisma.attendanceAdjustment.delete({ where: { id } });

    // Remove the manualEdit flag only if this adjustment's approval set it; an
    // independent manual edit on the row keeps its protection.
    if (releaseLock) {
      await prisma.attendanceDaily.update({
        where: { id: adj.attendanceDailyId },
        data: { manualEdit: false, updatedAt: new Date() },
      });
    }

    // Regenerate the day from raw logs (a no-op for a row that is still locked —
    // processDate skips manualEdit rows), then re-settle payroll for the month.
    try { await attendanceEngine.processDate(adj.date, adj.employeeId); }
    catch (err) { logger.error(`[Adjustments] revert reprocess failed (adj #${id}): ${err.message}`); }
    const payroll = await recalcForAdjustment(adj, req.io, 'reverted');

    // L1 fix: AdjustmentAuditLog.adjustmentId has onDelete: Cascade against
    // AttendanceAdjustment (schema.prisma) — the delete() above already
    // wiped out every prior audit row for this adjustment (created/approved/
    // rejected/field_changed, its entire history), and logAudit(id,
    // 'reverted', ...) here would try to INSERT a new row referencing an
    // adjustmentId that no longer exists, violating that same foreign key.
    // That's exactly why the previous code's `.catch(() => {})` always fired
    // silently — this action has NEVER actually recorded an audit entry.
    // Fix: write to the OTHER existing audit mechanism this codebase already
    // uses for records that must survive independent of one specific row's
    // lifecycle (writeAudit()/ManualEditAuditLog — used by payroll.js and
    // attendance/manual.js) — keyed by employeeId/attendanceDailyId, neither
    // of which this delete touches, so the record is durable. Not a new
    // audit system: this is the pre-existing employee-level trail, reused.
    await writeAudit({
      employeeId: adj.employeeId,
      attendanceDailyId: adj.attendanceDailyId,
      fieldName: 'adjustment',
      oldValue: `adjustment #${id} (${adj.approvalStatus})`,
      newValue: 'reverted',
      reason: 'إلغاء التعديل واسترجاع القيم الأصلية',
      userId: revertedBy, userName: revertedByName, userRole: revertedByRole,
      source: 'adjustment-revert',
    }).catch((err) => logger.error(`[Adjustments] revert audit write failed (adj #${id}): ${err.message}`));

    res.json({ message: 'تم الإلغاء واسترجاع القيم الأصلية', payroll });
  } catch (err) { sendError(res, err); }
});

// ── POST /api/adjustments/:id/flag — quick flag toggles ───────────────────────
router.post('/:id/flag', authorize('admin', 'hr'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { flag, value } = req.body;
    const { id: userId, name: userName } = resolveActor(req, { id: req.body.userId, name: req.body.userName });

    const validFlags = ['ignoreLate', 'ignoreEarlyLeave', 'forcePresent'];
    if (!validFlags.includes(flag)) return res.status(400).json({ error: 'Invalid flag' });

    const existing = await prisma.attendanceAdjustment.findUnique({ where: { id } });
    const old = existing?.[flag];

    const adj = await prisma.attendanceAdjustment.update({
      where: { id },
      data: { [flag]: !!value, approvalStatus: 'pending', updatedAt: new Date() },
    });

    await logAudit(id, 'flag_toggled', { field: flag, old, new: value, userId, userName });
    const payroll = existing && existing.approvalStatus === 'approved' ? await recalcForAdjustment(adj, req.io, 'flag-toggled') : undefined;
    res.json(payroll ? { ...adj, payroll } : adj);
  } catch (err) { sendError(res, err); }
});

// ── GET /api/adjustments/:id/audit — full audit trail ─────────────────────────
router.get('/:id/audit', authorize('admin', 'hr'), async (req, res) => {
  try {
    const logs = await prisma.adjustmentAuditLog.findMany({
      where: { adjustmentId: parseInt(req.params.id) },
      orderBy: { changedAt: 'desc' },
    });
    res.json(logs);
  } catch (err) { sendError(res, err); }
});

// ── POST /api/adjustments/bulk-approve ────────────────────────────────────────
router.post('/bulk-approve', authorize('admin', 'hr'), async (req, res) => {
  try {
    const { ids = [] } = req.body;
    const { id: approvedBy, name: approvedByName, role: approvedByRole } = resolveActor(req, { id: req.body.approvedBy, name: req.body.approvedByName }, { name: 'HR Manager' });
    const results = [];
    // EF-029.4: the 3 writes for one adjustment (adjustment status,
    // AttendanceDaily.manualEdit flag, audit log) now commit or roll back
    // together per adjustment. Previously the AttendanceDaily write had a
    // swallowing `.catch(() => {})`, so an adjustment could be reported
    // success:true while its daily row silently never got manualEdit=true
    // (losing the flag that protects the override from later auto-reprocess);
    // and a failure at the audit-log step could leave the adjustment already
    // approved with no rollback and no audit row. Each adjustment's own
    // transaction is independent, so the existing per-id "some fail, some
    // succeed" bulk contract is unchanged — only now every reported result
    // accurately reflects what was actually persisted.
    for (const id of ids) {
      try {
        const adj = await prisma.$transaction(async (tx) => {
          const priorAdj = await tx.attendanceAdjustment.findUnique({
            where: { id: parseInt(id) }, select: { id: true, attendanceDailyId: true, approvedAt: true },
          });
          // One shared timestamp for the adjustment and the daily row — see the
          // single approve route and shouldReleaseManualLock().
          const approvedAt = new Date();
          const adj = await tx.attendanceAdjustment.update({
            where: { id: parseInt(id) },
            data: { approvalStatus: 'approved', approvedBy, approvedByName, approvedAt, updatedAt: new Date() },
          });
          const lockPlan = await planManualLock(tx, priorAdj, adj);
          if (!lockPlan.skipWrite) {
            await tx.attendanceDaily.update({
              where: { id: adj.attendanceDailyId },
              data: { manualEdit: true, updatedAt: approvedAt },
            });
          }
          await logAudit(parseInt(id), 'approved', {
            userId: approvedBy, userName: approvedByName, userRole: approvedByRole, reason: 'Bulk approve', tx,
            ...lockPlan.baseline,
          });
          return adj;
        });
        results.push({ id, success: true, adj });
      } catch { results.push({ id, success: false }); }
    }

    // EF-003.3.1: recalc once per unique employee/month — not once per
    // adjustment — so concurrent calculatePayroll() calls for the same
    // employee/month (racing on the preserved manualDeductionAdjustment
    // field) cannot happen within a single bulk-approve request.
    const recalcKeys = new Map();
    for (const r of results) {
      if (!r.success || !r.adj) continue;
      const m = moment(r.adj.date);
      const key = `${r.adj.employeeId}|${m.month() + 1}|${m.year()}`;
      if (!recalcKeys.has(key)) recalcKeys.set(key, { employeeId: r.adj.employeeId, month: m.month() + 1, year: m.year() });
    }
    // C1 canonical safety boundary: same protection as recalcForAdjustment()
    // above, applied here as one batched pre-check (not per-key) so a bulk
    // approval touching many employees/months still issues a single extra
    // query instead of one per key.
    const { allowed: allowedRecalcTargets, protectedTargets } =
      await payrollEngine.filterProtectedPayrollTargets([...recalcKeys.values()]);
    if (protectedTargets.length) {
      logger.warn(`[PAYROLL] adjustment bulk-approved: SKIPPED ${protectedTargets.length} finalized/paid target(s): ` +
        protectedTargets.map(t => `emp=${t.employeeId} ${t.month}/${t.year} (${t.status})`).join(', '));
    }
    for (const { employeeId, month, year } of allowedRecalcTargets) {
      try {
        await payrollEngine.calculatePayroll(employeeId, month, year);
        logger.info(`[PAYROLL] adjustment bulk-approved: recalculated emp=${employeeId} ${month}/${year}`);
        if (req.io) req.io.emit('attendance:processed', { employeeId, source: 'adjustment-bulk-approved' });
      } catch (err) {
        logger.error(`[PAYROLL] adjustment bulk-approved recalc failed (emp=${employeeId} ${month}/${year}): ${err.message}`);
      }
    }

    res.json({
      results: results.map(({ id, success }) => ({ id, success })),
      count: results.filter(r => r.success).length,
      protectedPayroll: protectedTargets,
    });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
