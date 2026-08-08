const router = require('express').Router();
const { getPrisma } = require('../../utils/prisma');
const moment = require('moment');
const { authorize } = require('../../middleware/auth');
const { processDate, computeDerivedFields, mergeEffectivePenalty, parseTimeRules } = require('../../engines/attendanceEngine');
const { calculatePayroll, computePayroll, applyApprovedAdjustment, filterProtectedPayrollTargets } = require('../../engines/payrollEngine');
const { getRules, isWeekend, isHoliday } = require('../../engines/rulesEngine');
const { calcLatePenalty, calcEarlyCheckout, timeToMinutes } = require('../../engines/policyEngine');
const { writeAudit, resolveVerifiedManualEditIds } = require('../../utils/manualEditAudit');
const { buildAttendanceRow } = require('../../utils/attendanceRow');
const logger = require('../../utils/logger');

const prisma = getPrisma();

// Fields tracked for the manual-edit audit trail / diagnostic logs. checkIn
// and checkOut are Dates — formatted to HH:mm for readable audit values.
const AUDITED_FIELDS = [
  'checkIn', 'checkOut', 'status',
  'workedMinutes', 'lateMinutes', 'earlyLeaveMinutes', 'overtimeMinutes', 'overtimeHours',
];

function fmtAuditVal(v) {
  if (v instanceof Date) return moment(v).format('HH:mm');
  return v;
}

// C1: a manual attendance edit is a direct, targeted action on ONE employee's
// ONE day — but the payroll recalc it triggers is still an automatic SIDE
// EFFECT of that edit, not the user directly opening/editing the Payroll row
// itself (that's payroll.js's PUT /:id, which stays unconditional on
// purpose). Same shape as adjustments.js's recalcForAdjustment() — no
// confirmation flow exists here, so a month that's already finalized/paid
// must be protected (skipped, reported), not silently overwritten by an
// attendance correction the HR user may not realize touches a closed period.
// Reuses the exact Phase 13.3 canonical check — no new policy invented.
async function recalcPayrollProtected(employeeId, month, year, source) {
  const { allowed, protectedTargets } = await filterProtectedPayrollTargets([{ employeeId, month, year }]);
  if (protectedTargets.length) {
    logger.warn(`[PAYROLL-PROTECTED] employee=${employeeId} ${month}/${year} source=${source} — payroll is ${protectedTargets[0].status}, recalculation skipped`);
    return { payroll: null, payrollError: null, payrollProtected: protectedTargets[0].status };
  }
  try {
    const payroll = await calculatePayroll(employeeId, month, year);
    return { payroll, payrollError: null, payrollProtected: null };
  } catch (payrollErr) {
    logger.error(`[PAYROLL-RECALC-FAILED] employee=${employeeId} month=${month} year=${year} source=${source} error=${payrollErr.message}`);
    return { payroll: null, payrollError: payrollErr.message, payrollProtected: null };
  }
}

// Builds a normalized attendance row in the exact same shape as GET /daily
// and GET /monthly-detail. All three now share ONE row builder —
// buildAttendanceRow() in utils/attendanceRow.js (Phase 12.1) — so the
// frontend can never again see a different field set from one endpoint vs
// another for the same conceptual row.
async function buildDailyResponseRow(rec) {
  const emp = await prisma.employee.findUnique({
    where: { id: rec.employeeId },
    include: { department: true, branch: true, shift: true },
  });
  const adj = await prisma.attendanceAdjustment.findFirst({
    where: { attendanceDailyId: rec.id, approvalStatus: 'approved' },
  });
  const merged = mergeEffectivePenalty(applyApprovedAdjustment(rec, adj));
  // EF-014: resolve manualEdit against real evidence — see resolveVerifiedManualEditIds.
  const verifiedManualIds = merged.manualEdit ? await resolveVerifiedManualEditIds([merged.id]) : new Set();
  return buildAttendanceRow({ employee: emp, merged, verifiedManualIds, adj });
}

// Manual edit — runs the SAME policy math as automatic processing, but with
// the HR-provided times as authoritative input, then locks the row
// (manualEdit=true) so no cron/sync/recalc path can silently revert it, and
// re-settles the month's payroll so the edit has financial effect immediately.
// Numeric overrides (workedMinutes/lateMinutes/earlyLeaveMinutes/overtimeMinutes)
// apply on top of that recompute and require a `reason` — every changed field
// is written to ManualEditAuditLog via writeAudit().
router.put('/daily/:id', authorize('admin', 'hr'), async (req, res) => {
  try {
    const {
      checkIn, checkOut, status,
      workedMinutes, lateMinutes, earlyLeaveMinutes, overtimeMinutes,
      reason, modifiedBy, modifiedByName, modifiedByRole, source,
    } = req.body;
    const rec = await prisma.attendanceDaily.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!rec) return res.status(404).json({ error: 'Record not found' });
    // EF-005.4 Phase 2: a day that hasn't occurred yet has no attendance to edit.
    if (moment(rec.date).startOf('day').isAfter(moment().startOf('day'))) {
      return res.status(400).json({ error: 'لا يمكن تعديل بيانات حضور ليوم لم يحدث بعد' });
    }

    const numericOverrideKeys = { workedMinutes, lateMinutes, earlyLeaveMinutes, overtimeMinutes };
    const hasNumericOverride = Object.values(numericOverrideKeys).some(v => v !== undefined);
    if (hasNumericOverride && !reason) {
      return res.status(400).json({ error: 'reason مطلوب عند تعديل قيم الحضور يدويًا' });
    }

    // EF-007.4: these were parsed via `parseInt(x) || 0` with no bound — a
    // negative or absurdly large value (e.g. overtimeMinutes: -999999) would
    // persist as-is and flow into payroll as negative/inflated pay. A day
    // has at most 1440 minutes.
    const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
    for (const [k, v] of Object.entries(numericOverrideKeys)) {
      if (v === undefined) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1440) {
        return res.status(400).json({ error: `قيمة ${k} غير صالحة (يجب أن تكون بين 0 و 1440)` });
      }
    }
    if (checkIn && !HHMM_RE.test(checkIn)) {
      return res.status(400).json({ error: 'صيغة وقت الحضور غير صحيحة (HH:mm)' });
    }
    if (checkOut && !HHMM_RE.test(checkOut)) {
      return res.status(400).json({ error: 'صيغة وقت الانصراف غير صحيحة (HH:mm)' });
    }

    const before = { ...rec };

    const dateStr = moment(rec.date).format('YYYY-MM-DD');
    const manual = {
      checkIn:  checkIn  !== undefined ? (checkIn  ? new Date(`${dateStr}T${checkIn}`)  : null) : rec.checkIn,
      checkOut: checkOut !== undefined ? (checkOut ? new Date(`${dateStr}T${checkOut}`) : null) : rec.checkOut,
      ...(status ? { status } : {}),
    };
    // ABSOLUTE POLICY, no exceptions: reject outright rather than let the
    // engine's clamp silently reinterpret it — see manual-penalty above.
    if (manual.status === 'absent' && (manual.checkIn || manual.checkOut)) {
      return res.status(400).json({ error: 'لا يمكن تصنيف يوم به بصمة حضور أو انصراف كـ"غائب" — الموظف حاضر ببصمة واحدة على الأقل' });
    }

    await processDate(rec.date, rec.employeeId, { manual });

    // ── Explicit numeric overrides — applied on top of the recompute above ────
    const overrideData = {};
    if (workedMinutes !== undefined) overrideData.workedMinutes = parseInt(workedMinutes) || 0;

    // Certification HIGH#4: a manual lateMinutes/earlyLeaveMinutes correction
    // must also recompute the penalty-UNIT fields (latePenaltyUnits/
    // earlyCheckoutUnits) that mergeEffectivePenalty() actually reads for
    // payroll money — using the exact same tier-lookup formula
    // attendanceEngine.computeDerivedFields() uses (calcLatePenalty/
    // calcEarlyCheckout), never a second implementation. Proven live on
    // production data: before this fix, overriding lateMinutes to 0 left
    // latePenaltyUnits/effectiveLatePenalty/the persisted payroll deduction
    // completely unchanged — HR believed the late mark was cleared, but the
    // employee was still charged the original penalty.
    if (lateMinutes !== undefined || earlyLeaveMinutes !== undefined) {
      const employee = await prisma.employee.findUnique({ where: { id: rec.employeeId } });
      const rules = await getRules(employee.branchId, employee.departmentId, employee.id);
      const workStartMin = timeToMinutes(rules.work_start || '09:00');
      const workEndMin   = timeToMinutes(rules.work_end   || '17:00');
      const lateAbsRules  = parseTimeRules(rules.late_rules)  || [];
      const earlyAbsRules = parseTimeRules(rules.early_rules) || [];

      if (lateMinutes !== undefined) {
        const newLateMinutes = parseInt(lateMinutes) || 0;
        overrideData.lateMinutes = newLateMinutes;
        // Inverse of computeDerivedFields' `lateMinutes = max(0, checkInMin - workStartMin)`.
        overrideData.latePenaltyUnits = newLateMinutes > 0
          ? calcLatePenalty(workStartMin + newLateMinutes, lateAbsRules)
          : 0;
      }
      if (earlyLeaveMinutes !== undefined) {
        const newEarlyLeaveMinutes = parseInt(earlyLeaveMinutes) || 0;
        overrideData.earlyLeaveMinutes = newEarlyLeaveMinutes;
        const earlyLeaveGraceMin = parseInt(rules.early_leave_grace) || 0;
        // Inverse of `earlyLeaveMinutes = workEndMin - checkOutMin`; grace
        // gates the penalty lookup exactly like the automatic engine does.
        overrideData.earlyCheckoutUnits = (newEarlyLeaveMinutes > 0 && newEarlyLeaveMinutes > earlyLeaveGraceMin)
          ? calcEarlyCheckout(workEndMin - newEarlyLeaveMinutes, earlyAbsRules)
          : 0;
      }
      // EF-003.2a: fall back to the row's post-processDate() state, not the
      // pre-recompute `rec` snapshot — processDate() above may have already
      // committed different latePenaltyUnits/earlyCheckoutUnits than what
      // `rec` was read with at the top.
      const postEngineRec = await prisma.attendanceDaily.findUnique({ where: { id: rec.id } });
      overrideData.totalDeductionUnits =
        (overrideData.latePenaltyUnits  ?? postEngineRec.latePenaltyUnits  ?? 0) +
        (overrideData.earlyCheckoutUnits ?? postEngineRec.earlyCheckoutUnits ?? 0);
    }

    if (overtimeMinutes !== undefined) {
      const ot = parseInt(overtimeMinutes) || 0;
      overrideData.overtimeMinutes = ot;
      overrideData.overtimeHours = ot / 60;
    }
    // ── Transaction boundary (EF-003.2): the override write and its audit
    // trail commit atomically — either both persist or neither does.
    const { updated, auditEntries } = await prisma.$transaction(async (tx) => {
      if (Object.keys(overrideData).length) {
        await tx.attendanceDaily.update({
          where: { id: rec.id },
          data: { ...overrideData, manualEdit: true },
        });
      }

      const updated = await tx.attendanceDaily.findUnique({ where: { id: rec.id } });

      const auditEntries = [];
      for (const field of AUDITED_FIELDS) {
        const oldVal = fmtAuditVal(before[field]);
        const newVal = fmtAuditVal(updated[field]);
        if (String(oldVal ?? '') !== String(newVal ?? '')) {
          await tx.manualEditAuditLog.create({
            data: {
              employeeId: rec.employeeId,
              attendanceDailyId: rec.id,
              payrollId: null,
              fieldName: field,
              oldValue: oldVal != null ? String(oldVal) : null,
              newValue: newVal != null ? String(newVal) : null,
              reason: reason || null,
              modifiedBy: modifiedBy ?? 0,
              modifiedByName: modifiedByName ?? 'HR',
              modifiedByRole: modifiedByRole ?? 'hr',
              source: source || 'inline-grid',
            },
          });
          auditEntries.push({ field, oldVal, newVal });
        }
      }

      return { updated, auditEntries };
    });

    // ── Diagnostics + audit trail logging — kept outside the transaction ────
    if (updated.status !== before.status) {
      logger.info(`[STATUS-OVERRIDE] employee=${rec.employeeId} attendanceDailyId=${rec.id} date=${dateStr} ${before.status} → ${updated.status} by=${modifiedByName || 'HR'}`);
    }
    if (updated.overtimeMinutes !== before.overtimeMinutes) {
      logger.info(`[OVERTIME-ADJUST] employee=${rec.employeeId} attendanceDailyId=${rec.id} date=${dateStr} overtimeMinutes ${before.overtimeMinutes} → ${updated.overtimeMinutes} by=${modifiedByName || 'HR'}`);
    }
    for (const { field, oldVal, newVal } of auditEntries) {
      logger.info(
        `[AUDIT-WRITE] employee=${rec.employeeId} field=${field} ` +
        `old=${oldVal ?? '—'} new=${newVal ?? '—'} by=${modifiedByName || 'HR'}` +
        ` attendanceDailyId=${rec.id}` +
        (reason ? ` reason="${reason}"` : '')
      );
    }

    // Manual attendance changes must reach payroll deterministically.
    // EF-022.1: the attendance edit itself already committed — do not fail
    // the request on a recalc failure. C1: protected/skipped separately from
    // a genuine failure — see recalcPayrollProtected().
    const m = moment(rec.date);
    const { payroll, payrollError, payrollProtected } = await recalcPayrollProtected(rec.employeeId, m.month() + 1, m.year(), 'manual-edit');

    if (req.io) req.io.emit('attendance:processed', { employeeId: rec.employeeId, source: 'manual-edit' });

    res.json({ ...await buildDailyResponseRow(updated), payroll, payrollError, payrollProtected });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Manual Penalty Override — direct, immediate HR overlay on top of the
// canonical Policy Engine units (and any approved AttendanceAdjustment).
// Setting a field to null clears the override and restores the canonical value.
const VALID_OVERRIDE_STATUSES = ['present', 'late', 'early_leave', 'absent', 'holiday'];

router.put('/:id/manual-penalty', authorize('admin', 'hr'), async (req, res) => {
  try {
    const {
      manualLatePenaltyUnits, manualEarlyPenaltyUnits, manualOvertimeUnits,
      status, reason, overrideReason, modifiedBy, modifiedByName, modifiedByRole, source,
    } = req.body;
    const effReason = reason ?? overrideReason;
    const rec = await prisma.attendanceDaily.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!rec) return res.status(404).json({ error: 'Record not found' });
    // EF-005.4 Phase 2: a day that hasn't occurred yet has no attendance to edit.
    if (moment(rec.date).startOf('day').isAfter(moment().startOf('day'))) {
      return res.status(400).json({ error: 'لا يمكن تعديل بيانات حضور ليوم لم يحدث بعد' });
    }

    if (
      manualLatePenaltyUnits === undefined && manualEarlyPenaltyUnits === undefined &&
      manualOvertimeUnits === undefined && status === undefined
    ) {
      return res.status(400).json({ error: 'يجب إرسال manualLatePenaltyUnits أو manualEarlyPenaltyUnits أو manualOvertimeUnits أو status' });
    }

    for (const [key, val] of [
      ['manualLatePenaltyUnits', manualLatePenaltyUnits],
      ['manualEarlyPenaltyUnits', manualEarlyPenaltyUnits],
      ['manualOvertimeUnits', manualOvertimeUnits],
    ]) {
      if (val !== undefined && val !== null) {
        const n = Number(val);
        if (!Number.isFinite(n) || n < 0) {
          return res.status(400).json({ error: 'يجب أن تكون قيمة الخصم/الإضافي رقمًا أكبر من أو يساوي صفر' });
        }
        // EF-015: a single calendar day has at most 24 hours — this is a
        // physical fact, not a business policy, so it's safe to enforce
        // regardless of any rule configuration. Root cause of a live data
        // defect: manualOvertimeUnits had no upper bound at all, and a value
        // of 33 (physically impossible for one day) was accepted and flowed
        // through to payroll as real money (employee code 17, 2026-03-06 and
        // 2026-03-13, live-verified).
        if (key === 'manualOvertimeUnits' && n > 24) {
          return res.status(400).json({ error: 'قيمة الإضافي اليدوي لا يمكن أن تتجاوز 24 ساعة لليوم الواحد' });
        }
        // Late/early penalty units must be whole hours — reject fractions (0.1, 0.5, 1.5, …)
        if (key !== 'manualOvertimeUnits' && !Number.isInteger(n)) {
          const LABELS = { manualLatePenaltyUnits: 'خصم التأخير', manualEarlyPenaltyUnits: 'خصم الانصراف المبكر' };
          return res.status(400).json({ error: `${LABELS[key]} يجب أن يكون عدداً صحيحاً (0، 1، 2، 3، 4) — الكسور العشرية غير مسموح بها` });
        }
      }
    }

    if (status !== undefined && !VALID_OVERRIDE_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status يجب أن يكون أحد: ${VALID_OVERRIDE_STATUSES.join(', ')}` });
    }
    // ABSOLUTE POLICY, no exceptions: a day with a checkIn or checkOut punch
    // can never be marked 'absent' — not even by HR manual override. Reject
    // outright with a clear error rather than silently reinterpreting it (the
    // canonical engine also enforces this as defense-in-depth, but a rejected
    // request here gives HR an actionable reason instead of a silent no-op).
    if (status === 'absent' && (rec.checkIn || rec.checkOut)) {
      return res.status(400).json({ error: 'لا يمكن تصنيف يوم به بصمة حضور أو انصراف كـ"غائب" — الموظف حاضر ببصمة واحدة على الأقل' });
    }

    const changedFields = [];
    if (manualLatePenaltyUnits !== undefined && manualLatePenaltyUnits !== rec.manualLatePenaltyUnits) {
      changedFields.push({ field: 'manualLatePenaltyUnits', old: rec.manualLatePenaltyUnits, new: manualLatePenaltyUnits });
    }
    if (manualEarlyPenaltyUnits !== undefined && manualEarlyPenaltyUnits !== rec.manualEarlyPenaltyUnits) {
      changedFields.push({ field: 'manualEarlyPenaltyUnits', old: rec.manualEarlyPenaltyUnits, new: manualEarlyPenaltyUnits });
    }
    if (manualOvertimeUnits !== undefined && manualOvertimeUnits !== rec.manualOvertimeUnits) {
      changedFields.push({ field: 'manualOvertimeUnits', old: rec.manualOvertimeUnits, new: manualOvertimeUnits });
    }
    if (status !== undefined && status !== rec.status) {
      changedFields.push({ field: 'status', old: rec.status, new: status });
    }

    if (!changedFields.length) {
      return res.json({ ...await buildDailyResponseRow(rec), unchanged: true });
    }

    if (!effReason?.trim()) {
      return res.status(400).json({ error: 'سبب التعديل مطلوب عند تغيير قيمة الخصم/الإضافي/الحالة اليدوي' });
    }

    const updateData = {
      manualPenaltyReason: effReason,
      manualPenaltyBy: modifiedBy ?? null,
      manualPenaltyByName: modifiedByName ?? null,
      manualPenaltyAt: new Date(),
    };
    if (manualLatePenaltyUnits !== undefined)  updateData.manualLatePenaltyUnits  = manualLatePenaltyUnits;
    if (manualEarlyPenaltyUnits !== undefined) updateData.manualEarlyPenaltyUnits = manualEarlyPenaltyUnits;
    if (manualOvertimeUnits !== undefined)     updateData.manualOvertimeUnits    = manualOvertimeUnits;
    if (status !== undefined) {
      updateData.status = status;
      // Keep isAbsent in lockstep with status — this endpoint used to write
      // status alone, leaving isAbsent stale (e.g. status flipped to 'present'
      // while isAbsent stayed true, or vice versa), which double-counted the
      // row in payrollEngine (workDays reads status, absentDays reads isAbsent
      // independently). Weekend/holiday overrides never count as absent.
      if (!rec.isWeekend && !rec.isHoliday) {
        updateData.isAbsent = status === 'absent';
      }
      updateData.manualEdit = true;
    }

    const updated = await prisma.attendanceDaily.update({ where: { id: rec.id }, data: updateData });

    for (const c of changedFields) {
      await writeAudit({
        employeeId: rec.employeeId,
        attendanceDailyId: rec.id,
        fieldName: c.field,
        oldValue: c.old,
        newValue: c.new,
        reason: effReason,
        userId: modifiedBy, userName: modifiedByName, userRole: modifiedByRole,
        source: source || 'inline-grid',
      });
    }

    // EF-022.1 / C1: see manual-edit handler above for rationale.
    const m = moment(rec.date);
    const { payroll, payrollError, payrollProtected } = await recalcPayrollProtected(rec.employeeId, m.month() + 1, m.year(), 'manual-penalty');

    if (req.io) req.io.emit('attendance:processed', { employeeId: rec.employeeId, source: 'manual-penalty' });

    res.json({ ...await buildDailyResponseRow(updated), payroll, payrollError, payrollProtected });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Absence Permission Type — HR sets absenceType + penaltyDays on an absent row ──
// absenceType: 'with_permission' | 'without_permission' | 'custom'
// penaltyDays: the deduction multiplier for this specific absent day
//   with_permission → 1, without_permission → 2, custom → any positive number
// These fields are HR-overlay: they survive every engine recompute (not in DAILY_RESET).
const VALID_ABSENCE_TYPES = ['with_permission', 'without_permission', 'custom'];
const ABSENCE_TYPE_DEFAULT_DAYS = { with_permission: 1, without_permission: 2 };

router.put('/:id/absence-type', authorize('admin', 'hr'), async (req, res) => {
  try {
    const { absenceType, penaltyDays, absenceReason, modifiedBy, modifiedByName, modifiedByRole, source } = req.body;
    const rec = await prisma.attendanceDaily.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!rec) return res.status(404).json({ error: 'Record not found' });
    // EF-005.4 Phase 2: a day that hasn't occurred yet has no attendance to edit.
    if (moment(rec.date).startOf('day').isAfter(moment().startOf('day'))) {
      return res.status(400).json({ error: 'لا يمكن تعديل بيانات حضور ليوم لم يحدث بعد' });
    }
    if (!rec.isAbsent) return res.status(400).json({ error: 'السجل ليس غياباً — نوع الغياب يطبق فقط على أيام الغياب' });
    if (!absenceType) return res.status(400).json({ error: 'absenceType مطلوب' });
    if (!VALID_ABSENCE_TYPES.includes(absenceType)) {
      return res.status(400).json({ error: `absenceType يجب أن يكون أحد: ${VALID_ABSENCE_TYPES.join(', ')}` });
    }

    // Derive penaltyDays: explicit value wins, else from type, else keep existing
    let pd;
    if (penaltyDays != null) {
      pd = parseFloat(penaltyDays);
      if (!Number.isFinite(pd) || pd < 0) {
        return res.status(400).json({ error: 'أيام الخصم يجب أن تكون رقمًا موجبًا' });
      }
    } else {
      pd = ABSENCE_TYPE_DEFAULT_DAYS[absenceType] ?? rec.penaltyDays ?? 1;
    }

    const before = { absenceType: rec.absenceType, penaltyDays: rec.penaltyDays, absenceReason: rec.absenceReason };

    const updated = await prisma.attendanceDaily.update({
      where: { id: rec.id },
      data: {
        absenceType,
        penaltyDays: pd,
        absenceReason: absenceReason ?? rec.absenceReason,
        absenceSetBy:  modifiedByName ?? rec.absenceSetBy,
        absenceSetAt:  new Date(),
      },
    });

    // Audit trail
    for (const [field, oldVal, newVal] of [
      ['absenceType',   before.absenceType,   updated.absenceType],
      ['penaltyDays',   before.penaltyDays,   updated.penaltyDays],
      ['absenceReason', before.absenceReason, updated.absenceReason],
    ]) {
      if (String(oldVal ?? '') !== String(newVal ?? '')) {
        await writeAudit({
          employeeId: rec.employeeId,
          attendanceDailyId: rec.id,
          fieldName: field,
          oldValue: oldVal,
          newValue: newVal,
          reason: absenceReason || `تحديد نوع الغياب: ${absenceType}`,
          userId: modifiedBy, userName: modifiedByName, userRole: modifiedByRole,
          source: source || 'absence-type-modal',
        });
      }
    }

    // Recalculate payroll — penalty days change affects the deduction amount.
    // EF-022.1 / C1: see manual-edit handler above for rationale.
    const m = moment(rec.date);
    const { payroll, payrollError, payrollProtected } = await recalcPayrollProtected(rec.employeeId, m.month() + 1, m.year(), 'absence-type');

    if (req.io) req.io.emit('attendance:processed', { employeeId: rec.employeeId, source: 'absence-type' });

    res.json({ ...await buildDailyResponseRow(updated), payroll, payrollError, payrollProtected });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Audit history for a single attendance_daily row — newest first.
router.get('/daily/:id/audit', authorize('admin', 'hr'), async (req, res) => {
  try {
    const rows = await prisma.manualEditAuditLog.findMany({
      where: { attendanceDailyId: parseInt(req.params.id) },
      orderBy: { createdAt: 'desc' },
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Manual-edit preview — no writes ────────────────────────────────────────
// Computes "what would this row + that month's payroll look like" for a
// proposed edit, without touching the DB. Used by the Manual Edit drawer's
// "معاينة الأثر على الراتب" button before HR confirms the save.
router.post('/daily/:id/preview', authorize('admin', 'hr'), async (req, res) => {
  try {
    const { checkIn, checkOut, status, workedMinutes, lateMinutes, earlyLeaveMinutes, overtimeMinutes } = req.body;
    const rec = await prisma.attendanceDaily.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!rec) return res.status(404).json({ error: 'Record not found' });

    const employee = await prisma.employee.findUnique({
      where: { id: rec.employeeId },
      include: { branch: true, department: true },
    });

    const dateStr = moment(rec.date).format('YYYY-MM-DD');
    const legacyRules = await getRules(employee.branchId, employee.departmentId, employee.id);
    const dayDate = new Date(dateStr);
    const dayOfWeek = dayDate.getDay();
    const fridayIsWeekend = (legacyRules.friday_is_weekend ?? 'false') === 'true';
    const configuredWeekend = isWeekend(dayDate, legacyRules.weekend_days);
    const weekend = configuredWeekend || (fridayIsWeekend && dayOfWeek === 5);
    const holiday = await isHoliday(dayDate, employee.branchId);

    const effCheckIn = checkIn !== undefined
      ? (checkIn ? new Date(`${dateStr}T${checkIn}`) : null)
      : rec.checkIn;
    const effCheckOut = checkOut !== undefined
      ? (checkOut ? new Date(`${dateStr}T${checkOut}`) : null)
      : rec.checkOut;

    let proposedFields;
    if (effCheckIn) {
      proposedFields = await computeDerivedFields(employee, dateStr, {
        checkIn: effCheckIn, checkOut: effCheckOut, weekend, holiday, dayOfWeek,
        manual: status ? { status } : null, legacyRules,
      });
    } else {
      proposedFields = {
        checkIn: null, checkOut: effCheckOut,
        workedMinutes: 0, lateMinutes: 0, overtimeMinutes: 0, overtimeHours: 0,
        earlyLeaveMinutes: 0, morningOvertimeHours: 0, eveningOvertimeHours: 0,
        latePenaltyUnits: 0, earlyCheckoutUnits: 0, totalDeductionUnits: 0,
        isAbsent: true, isWeekend: weekend, isHoliday: holiday,
        status: status || 'absent',
      };
    }

    // Explicit numeric overrides apply on top of the recomputed fields.
    if (workedMinutes !== undefined) proposedFields.workedMinutes = parseInt(workedMinutes) || 0;
    if (lateMinutes !== undefined) proposedFields.lateMinutes = parseInt(lateMinutes) || 0;
    if (earlyLeaveMinutes !== undefined) proposedFields.earlyLeaveMinutes = parseInt(earlyLeaveMinutes) || 0;
    if (overtimeMinutes !== undefined) {
      const ot = parseInt(overtimeMinutes) || 0;
      proposedFields.overtimeMinutes = ot;
      proposedFields.overtimeHours = ot / 60;
    }

    const m = moment(rec.date);
    const month = m.month() + 1, year = m.year();

    const [current, proposed] = await Promise.all([
      computePayroll(rec.employeeId, month, year),
      computePayroll(rec.employeeId, month, year, { recordsOverride: { id: rec.id, fields: proposedFields } }),
    ]);

    logger.info(
      `[PREVIEW-CALC] employee=${rec.employeeId} attendanceDailyId=${rec.id} date=${dateStr} ` +
      `netSalary ${current.netSalary.toFixed(2)} → ${proposed.netSalary.toFixed(2)} ` +
      `(Δ=${(proposed.netSalary - current.netSalary).toFixed(2)})`
    );

    res.json({
      current: {
        checkIn: rec.checkIn ? moment(rec.checkIn).format('HH:mm') : null,
        checkOut: rec.checkOut ? moment(rec.checkOut).format('HH:mm') : null,
        status: rec.status,
        workedMinutes: rec.workedMinutes,
        lateMinutes: rec.lateMinutes,
        earlyLeaveMinutes: rec.earlyLeaveMinutes,
        overtimeMinutes: rec.overtimeMinutes,
        overtimeAmount: current.overtimeAmount,
        deductions: current.deductions,
        netSalary: current.netSalary,
      },
      proposed: {
        checkIn: proposedFields.checkIn ? moment(proposedFields.checkIn).format('HH:mm') : null,
        checkOut: proposedFields.checkOut ? moment(proposedFields.checkOut).format('HH:mm') : null,
        status: proposedFields.status,
        workedMinutes: proposedFields.workedMinutes,
        lateMinutes: proposedFields.lateMinutes,
        earlyLeaveMinutes: proposedFields.earlyLeaveMinutes,
        overtimeMinutes: proposedFields.overtimeMinutes,
        overtimeAmount: proposed.overtimeAmount,
        deductions: proposed.deductions,
        netSalary: proposed.netSalary,
      },
      delta: {
        overtimeAmount: parseFloat((proposed.overtimeAmount - current.overtimeAmount).toFixed(2)),
        deductions: parseFloat((proposed.deductions - current.deductions).toFixed(2)),
        netSalary: parseFloat((proposed.netSalary - current.netSalary).toFixed(2)),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Restore automatic calculation ──────────────────────────────────────────
// Clears manualEdit on a row, re-runs the engine from raw AttendanceLog data,
// and re-settles that month's payroll. Writes an audit row recording the
// reversal.
router.post('/daily/:id/restore-auto', authorize('admin', 'hr'), async (req, res) => {
  try {
    const { reason, modifiedBy, modifiedByName, modifiedByRole } = req.body || {};
    const rec = await prisma.attendanceDaily.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!rec) return res.status(404).json({ error: 'Record not found' });
    // EF-005.4 Phase 2: a day that hasn't occurred yet has no attendance to edit.
    if (moment(rec.date).startOf('day').isAfter(moment().startOf('day'))) {
      return res.status(400).json({ error: 'لا يمكن تعديل بيانات حضور ليوم لم يحدث بعد' });
    }
    if (!rec.manualEdit) return res.status(400).json({ error: 'هذا السجل غير معدّل يدويًا' });

    const dateStr = moment(rec.date).format('YYYY-MM-DD');

    // Clear the lock so processDate recomputes this row from raw logs.
    await prisma.attendanceDaily.update({ where: { id: rec.id }, data: { manualEdit: false } });
    await processDate(rec.date, rec.employeeId);

    const updated = await prisma.attendanceDaily.findUnique({ where: { id: rec.id } });

    await writeAudit({
      employeeId: rec.employeeId,
      attendanceDailyId: rec.id,
      fieldName: 'manualEdit',
      oldValue: 'true',
      newValue: 'false',
      reason: reason || 'استرجاع الحساب التلقائي',
      userId: modifiedBy, userName: modifiedByName, userRole: modifiedByRole,
    });

    logger.info(`[RESTORE-AUTO] employee=${rec.employeeId} attendanceDailyId=${rec.id} date=${dateStr} — manualEdit cleared, engine recomputed`);

    // EF-022.1 / C1: see manual-edit handler above for rationale.
    const m = moment(rec.date);
    const { payroll, payrollError, payrollProtected } = await recalcPayrollProtected(rec.employeeId, m.month() + 1, m.year(), 'restore-auto');

    if (req.io) req.io.emit('attendance:processed', { employeeId: rec.employeeId, source: 'restore-auto' });

    res.json({ ...updated, payroll, payrollError, payrollProtected });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
