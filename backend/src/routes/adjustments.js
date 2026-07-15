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
const { getPrisma } = require('../utils/prisma');
const moment = require('moment');
const payrollEngine = require('../engines/payrollEngine');
const attendanceEngine = require('../engines/attendanceEngine');
const logger = require('../utils/logger');
const { authenticate, authorize } = require('../middleware/auth');
const { currentMonthRange } = require('../utils/monthRange');

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
function recalcForAdjustment(adj, io, why) {
  if (!adj) return;
  const m = moment(adj.date);
  payrollEngine.calculatePayroll(adj.employeeId, m.month() + 1, m.year())
    .then(() => {
      logger.info(`[PAYROLL] adjustment ${why}: recalculated emp=${adj.employeeId} ${m.month() + 1}/${m.year()} (adj #${adj.id})`);
      if (io) io.emit('attendance:processed', { employeeId: adj.employeeId, source: `adjustment-${why}` });
    })
    .catch(err => logger.error(`[PAYROLL] adjustment ${why} recalc failed (adj #${adj.id}): ${err.message}`));
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function toHHMM(dt) {
  if (!dt) return null;
  return moment(dt).format('HH:mm');
}

async function logAudit(adjustmentId, action, opts = {}) {
  await prisma.adjustmentAuditLog.create({
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

// ── GET /api/adjustments — list all with filters ───────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { employeeId, branchId, from, to, status, page = 1, limit = 100 } = req.query;

    const defaultRange = currentMonthRange();
    const startDate = from ? new Date(from) : defaultRange.start.toDate();
    const endDate   = to   ? new Date(to)   : defaultRange.end.toDate();

    const empWhere = { status: true };
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/adjustments/daily — full attendance + adjustment overlay ──────────
// Main page data source: returns all daily records with adjustment status merged in
router.get('/daily', async (req, res) => {
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

    const empWhere = { status: true };
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/adjustments/:id — single adjustment with full audit ───────────────
router.get('/:id', async (req, res) => {
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
      createdBy = 0, createdByName = 'HR', createdByRole = 'hr',
    } = req.body;

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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
      changedBy = 0, changedByName = 'HR', changedByRole = 'hr',
    } = req.body;

    // Audit changed fields
    const fields = { adjCheckIn, adjCheckOut, adjLateMinutes, adjOvertimeHours, adjLatePenalty, ignoreLate, reason };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && String(v) !== String(existing[k])) {
        await logAudit(id, 'field_changed', { field: k, old: existing[k], new: v, userId: changedBy, userName: changedByName, userRole: changedByRole });
      }
    }

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
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/adjustments/:id/approve ─────────────────────────────────────────
router.post('/:id/approve', authorize('admin', 'hr'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { approvedBy = 0, approvedByName = 'HR Manager', comment } = req.body;

    const adj = await prisma.attendanceAdjustment.update({
      where: { id },
      data: {
        approvalStatus: 'approved',
        approvedBy, approvedByName,
        approvedAt: new Date(),
        hrComment: comment || null,
        updatedAt: new Date(),
      },
    });

    await logAudit(id, 'approved', { userId: approvedBy, userName: approvedByName, userRole: 'hr', reason: comment });

    // Mark the daily record as manually edited — the engine will no longer
    // overwrite it, and payroll consumes the adjustment as authoritative.
    await prisma.attendanceDaily.update({
      where: { id: adj.attendanceDailyId },
      data: { manualEdit: true, updatedAt: new Date() },
    });

    recalcForAdjustment(adj, req.io, 'approved');

    res.json({ message: 'تم الاعتماد بنجاح', adjustment: adj });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/adjustments/:id/reject ──────────────────────────────────────────
router.post('/:id/reject', authorize('admin', 'hr'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rejectedBy = 0, rejectedByName = 'HR Manager', reason } = req.body;

    const adj = await prisma.attendanceAdjustment.update({
      where: { id },
      data: { approvalStatus: 'rejected', hrComment: reason || null, updatedAt: new Date() },
    });

    // A rejected adjustment no longer protects the daily row — auto values are
    // authoritative again, so release the manual-edit hold and re-settle payroll.
    await prisma.attendanceDaily.update({
      where: { id: adj.attendanceDailyId },
      data: { manualEdit: false, updatedAt: new Date() },
    }).catch(() => {});
    recalcForAdjustment(adj, req.io, 'rejected');

    await logAudit(id, 'rejected', { userId: rejectedBy, userName: rejectedByName, userRole: 'hr', reason });
    res.json({ message: 'تم الرفض', adjustment: adj });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/adjustments/:id/revert ──────────────────────────────────────────
router.post('/:id/revert', authorize('admin', 'hr'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { revertedBy = 0, revertedByName = 'System' } = req.body;

    const adj = await prisma.attendanceAdjustment.delete({ where: { id } });

    // Remove manualEdit flag from daily record
    await prisma.attendanceDaily.update({
      where: { id: adj.attendanceDailyId },
      data: { manualEdit: false, updatedAt: new Date() },
    });

    // Regenerate the day from raw logs (allowed again now manualEdit is off),
    // then re-settle payroll for the month.
    try { await attendanceEngine.processDate(adj.date, adj.employeeId); }
    catch (err) { logger.error(`[Adjustments] revert reprocess failed (adj #${id}): ${err.message}`); }
    recalcForAdjustment(adj, req.io, 'reverted');

    await logAudit(id, 'reverted', { userId: revertedBy, userName: revertedByName, userRole: 'hr' }).catch(() => {});
    res.json({ message: 'تم الإلغاء واسترجاع القيم الأصلية' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/adjustments/:id/flag — quick flag toggles ───────────────────────
router.post('/:id/flag', authorize('admin', 'hr'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { flag, value, userId = 0, userName = 'HR' } = req.body;

    const validFlags = ['ignoreLate', 'ignoreEarlyLeave', 'forcePresent'];
    if (!validFlags.includes(flag)) return res.status(400).json({ error: 'Invalid flag' });

    const existing = await prisma.attendanceAdjustment.findUnique({ where: { id } });
    const old = existing?.[flag];

    const adj = await prisma.attendanceAdjustment.update({
      where: { id },
      data: { [flag]: !!value, approvalStatus: 'pending', updatedAt: new Date() },
    });

    await logAudit(id, 'flag_toggled', { field: flag, old, new: value, userId, userName });
    res.json(adj);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/adjustments/:id/audit — full audit trail ─────────────────────────
router.get('/:id/audit', async (req, res) => {
  try {
    const logs = await prisma.adjustmentAuditLog.findMany({
      where: { adjustmentId: parseInt(req.params.id) },
      orderBy: { changedAt: 'desc' },
    });
    res.json(logs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/adjustments/bulk-approve ────────────────────────────────────────
router.post('/bulk-approve', authorize('admin', 'hr'), async (req, res) => {
  try {
    const { ids = [], approvedBy = 0, approvedByName = 'HR Manager' } = req.body;
    const results = [];
    for (const id of ids) {
      try {
        const adj = await prisma.attendanceAdjustment.update({
          where: { id: parseInt(id) },
          data: { approvalStatus: 'approved', approvedBy, approvedByName, approvedAt: new Date(), updatedAt: new Date() },
        });
        await prisma.attendanceDaily.update({
          where: { id: adj.attendanceDailyId },
          data: { manualEdit: true, updatedAt: new Date() },
        }).catch(() => {});
        await logAudit(parseInt(id), 'approved', { userId: approvedBy, userName: approvedByName, userRole: 'hr', reason: 'Bulk approve' });
        results.push({ id, success: true, adj });
      } catch { results.push({ id, success: false }); }
    }

    // EF-003.3.1: recalc once per unique employee/month — not once per
    // adjustment — so concurrent calculatePayroll() calls for the same
    // employee/month (racing on the preserved bonus/manualDeductionAdjustment
    // fields) cannot happen within a single bulk-approve request.
    const recalcKeys = new Map();
    for (const r of results) {
      if (!r.success || !r.adj) continue;
      const m = moment(r.adj.date);
      const key = `${r.adj.employeeId}|${m.month() + 1}|${m.year()}`;
      if (!recalcKeys.has(key)) recalcKeys.set(key, { employeeId: r.adj.employeeId, month: m.month() + 1, year: m.year() });
    }
    for (const { employeeId, month, year } of recalcKeys.values()) {
      try {
        await payrollEngine.calculatePayroll(employeeId, month, year);
        logger.info(`[PAYROLL] adjustment bulk-approved: recalculated emp=${employeeId} ${month}/${year}`);
        if (req.io) req.io.emit('attendance:processed', { employeeId, source: 'adjustment-bulk-approved' });
      } catch (err) {
        logger.error(`[PAYROLL] adjustment bulk-approved recalc failed (emp=${employeeId} ${month}/${year}): ${err.message}`);
      }
    }

    res.json({ results: results.map(({ id, success }) => ({ id, success })), count: results.filter(r => r.success).length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
