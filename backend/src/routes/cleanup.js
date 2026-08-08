/**
 * /api/cleanup — "تنظيف الحركات" (operational-data cleanup).
 *
 * Lets HR/admins purge old Raw Logs / AttendanceDaily / Payroll rows for a
 * chosen date range to keep the database lean, WITHOUT ever touching master
 * data (employees, departments, rules, devices, base salaries, settings).
 *
 * Flow: preview (read-only dry-run) → execute (backup → transactional,
 * batched, FK-ordered delete → consistency check → OPTIMIZE TABLE →
 * recalculation cascade → audit log). Mirrors the Rules Engine's
 * audit/recalc/live-push patterns (see routes/rules.js) so the rest of the
 * app refreshes itself with no new wiring.
 */
const router = require('express').Router();
const { getPrisma } = require('../utils/prisma');
const moment = require('moment');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { authenticate, authorize } = require('../middleware/auth');
const { currentMonthRange } = require('../utils/monthRange');
const recalcEngine = require('../engines/recalcEngine');
const { getConfigDir } = require('../utils/configDir');

const prisma = getPrisma();
router.use(authenticate, authorize('admin'));

const TYPE_LABELS = {
  rawLogs: 'السجلات الخام (Raw Logs)',
  daily: 'نتائج الحضور اليومية',
  payroll: 'المرتبات والتجميعات الشهرية',
};
// EP-010: backups persist under the config dir, surviving a Portable
// re-extraction — falls back to the pre-EP-010 path when CONFIG_DIR is unset.
const BACKUP_DIR = path.join(getConfigDir(), 'backups');

function emit(io, event, payload) { if (io) io.emit(event, payload); }

/** Parse + validate a {from, to} request range into moment day-boundaries. */
function parseRange(from, to) {
  const f = moment(from, 'YYYY-MM-DD', true).startOf('day');
  const t = moment(to, 'YYYY-MM-DD', true).endOf('day');
  if (!f.isValid() || !t.isValid() || t.isBefore(f)) return null;
  return { from: f, to: t };
}

/** Every {month, year} touched by [f, t] — used to scope Payroll deletes. */
function monthsInRange(f, t) {
  const months = [];
  const m = f.clone().startOf('month');
  while (m.isSameOrBefore(t)) {
    months.push({ month: m.month() + 1, year: m.year() });
    m.add(1, 'month');
  }
  return months;
}

/** Split [f, t] into ~week-sized windows so deletes can be batched with progress. */
function dateSlices(f, t, days = 7) {
  const slices = [];
  let cur = f.clone();
  while (cur.isSameOrBefore(t)) {
    const end = moment.min(cur.clone().add(days - 1, 'days').endOf('day'), t);
    slices.push([cur.clone(), end.clone()]);
    cur = end.clone().add(1, 'second');
  }
  return slices;
}

function currentPeriodOverlap(f, t) {
  const { start, end } = currentMonthRange();
  return !(t.isBefore(start) || f.isAfter(end));
}

/** Read-only impact analysis shared by /preview and the pre-execute re-validation. */
async function analyzeImpact({ f, t, types }) {
  const months = monthsInRange(f, t);
  const employeeIds = new Set();
  const counts = {};
  const warnings = [];
  let finalizedPayroll = [];

  if (types.rawLogs) {
    counts.rawLogs = await prisma.attendanceLog.count({
      where: { timestamp: { gte: f.toDate(), lte: t.toDate() } },
    });
    (await prisma.attendanceLog.findMany({
      where: { timestamp: { gte: f.toDate(), lte: t.toDate() }, employeeId: { not: null } },
      distinct: ['employeeId'], select: { employeeId: true },
    })).forEach(r => r.employeeId && employeeIds.add(r.employeeId));
  }

  let daysAffected = 0;
  if (types.daily) {
    counts.daily = await prisma.attendanceDaily.count({
      where: { date: { gte: f.toDate(), lte: t.toDate() } },
    });
    const dailyRows = await prisma.attendanceDaily.findMany({
      where: { date: { gte: f.toDate(), lte: t.toDate() } },
      select: { employeeId: true, date: true },
    });
    const dateSet = new Set();
    dailyRows.forEach(r => { employeeIds.add(r.employeeId); dateSet.add(moment(r.date).format('YYYY-MM-DD')); });
    daysAffected = dateSet.size;
  }

  const monthsOr = months.map(({ month, year }) => ({ month, year }));

  if (types.payroll) {
    counts.payroll = monthsOr.length ? await prisma.payroll.count({ where: { OR: monthsOr } }) : 0;
    if (monthsOr.length) {
      (await prisma.payroll.findMany({ where: { OR: monthsOr }, distinct: ['employeeId'], select: { employeeId: true } }))
        .forEach(r => employeeIds.add(r.employeeId));
    }
  }

  // C1 FIX: finalized/paid Payroll rows for the months this range spans are
  // at risk from TWO paths, not just an explicit Payroll-type deletion —
  // the recalculation cascade below (types.rawLogs || types.daily) also
  // reaches them via recalcEngine.recalcScope() -> payrollEngine.
  // calculatePayroll(), which unconditionally upserts over the existing row
  // regardless of its status. This check previously ran only inside the
  // `if (types.payroll)` block above, so a Daily/Raw-Logs-only cleanup could
  // trigger that cascade against a finalized/paid month with no warning and
  // no confirmation gate. Computing it here — independent of which types
  // were selected — means the SAME confirmFinalizedPayroll gate at /execute
  // (which reads impact.finalizedPayroll) now protects both paths from one
  // canonical check, instead of duplicating a second check per caller.
  if (monthsOr.length) {
    finalizedPayroll = await prisma.payroll.findMany({
      where: { OR: monthsOr, status: { in: ['finalized', 'paid'] } },
      select: {
        employeeId: true, month: true, year: true, status: true,
        employee: { select: { name: true, code: true } },
      },
    });
    if (finalizedPayroll.length) {
      warnings.push(`⚠️ توجد ${finalizedPayroll.length} سجلات مرتبات معتمدة/مدفوعة ضمن هذه الفترة — قد تتأثر بإعادة الاحتساب أو الحذف، وتتطلب تأكيدًا إضافيًا.`);
    }
  }

  const overlap = currentPeriodOverlap(f, t);
  if (overlap) warnings.push('⚠️ الفترة المحددة تشمل الشهر الحالي — حذف بياناته الجارية يتطلب تأكيدًا إضافيًا.');

  return {
    from: f.format('YYYY-MM-DD'), to: t.format('YYYY-MM-DD'),
    months, counts, daysAffected, employeesAffected: employeeIds.size,
    // EP-020: expose the actual id list (not just its count) so callers can
    // scope a post-delete recalc to exactly the employees touched, instead
    // of recalcScope() falling back to its "every active employee" default.
    employeeIds: Array.from(employeeIds),
    currentPeriodOverlap: overlap, finalizedPayroll, warnings,
  };
}

/** Build an .xlsx snapshot of exactly the rows about to be deleted (one sheet per type). */
async function buildBackupWorkbook({ f, t, months, types }) {
  const wb = XLSX.utils.book_new();
  let any = false;

  if (types.rawLogs) {
    const rows = await prisma.attendanceLog.findMany({
      where: { timestamp: { gte: f.toDate(), lte: t.toDate() } },
      include: { employee: { select: { name: true, code: true } } },
      orderBy: { timestamp: 'asc' },
    });
    if (rows.length) {
      const ws = XLSX.utils.json_to_sheet(rows.map(r => ({
        ID: r.id, 'كود الموظف': r.employee?.code || '', 'اسم الموظف': r.employee?.name || '',
        'الوقت': moment(r.timestamp).format('YYYY-MM-DD HH:mm:ss'), 'النوع': r.verifyType, 'المصدر': r.source,
      })));
      XLSX.utils.book_append_sheet(wb, ws, 'Raw Logs');
      any = true;
    }
  }

  if (types.daily) {
    const rows = await prisma.attendanceDaily.findMany({
      where: { date: { gte: f.toDate(), lte: t.toDate() } },
      include: { employee: { select: { name: true, code: true } } },
      orderBy: { date: 'asc' },
    });
    if (rows.length) {
      const ws = XLSX.utils.json_to_sheet(rows.map(r => ({
        ID: r.id, 'كود الموظف': r.employee?.code || '', 'اسم الموظف': r.employee?.name || '',
        'التاريخ': moment(r.date).format('YYYY-MM-DD'), 'الحالة': r.status,
        'دقائق العمل': r.workedMinutes, 'دقائق التأخير': r.lateMinutes,
        'ساعات الإضافي': r.overtimeHours, 'ساعات الخصم': r.totalDeductionUnits,
        'غائب': r.isAbsent ? 'نعم' : 'لا',
      })));
      XLSX.utils.book_append_sheet(wb, ws, 'Attendance Daily');
      any = true;
    }
  }

  if (types.payroll) {
    const or = months.map(({ month, year }) => ({ month, year }));
    const rows = or.length ? await prisma.payroll.findMany({
      where: { OR: or },
      include: { employee: { select: { name: true, code: true } } },
      orderBy: [{ year: 'asc' }, { month: 'asc' }],
    }) : [];
    if (rows.length) {
      const ws = XLSX.utils.json_to_sheet(rows.map(r => ({
        ID: r.id, 'كود الموظف': r.employee?.code || '', 'اسم الموظف': r.employee?.name || '',
        'الشهر': r.month, 'السنة': r.year, 'الراتب الأساسي': r.basicSalary,
        'صافي الراتب': r.netSalary, 'الحالة': r.status,
      })));
      XLSX.utils.book_append_sheet(wb, ws, 'Payroll');
      any = true;
    }
  }

  return any ? XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) : null;
}

// ─── Preview (Dry Run / Safe Simulation — read-only, nothing logged) ─────────
router.post('/preview', async (req, res) => {
  try {
    const { from, to, types = {} } = req.body;
    const range = parseRange(from, to);
    if (!range) return res.status(400).json({ error: 'نطاق تاريخ غير صالح (from/to مطلوبة بصيغة YYYY-MM-DD، و from يجب ألا يكون بعد to)' });
    if (!types.rawLogs && !types.daily && !types.payroll) {
      return res.status(400).json({ error: 'يجب تحديد نوع بيانات واحد على الأقل' });
    }
    const impact = await analyzeImpact({ f: range.from, t: range.to, types });
    res.json(impact);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Execute (the real, destructive operation — admin-only) ─────────────────
router.post('/execute', authorize('admin'), async (req, res) => {
  const startedAt = Date.now();
  try {
    const {
      from, to, types = {}, backupFirst = true, executedByName, confirmText,
      confirmCurrentPeriod = false, confirmFinalizedPayroll = false,
    } = req.body;

    if (!executedByName || !String(executedByName).trim()) {
      return res.status(400).json({ error: 'اسم منفّذ العملية مطلوب لسجل التدقيق' });
    }
    // EP-019: the "type حذف to confirm" gate was previously UI-only — the
    // frontend disabled its own Execute button but this endpoint never read
    // or checked the value, so a direct API call could destroy data with no
    // confirmation at all. Enforce it here, at the one place every caller
    // (UI or otherwise) goes through.
    if (String(confirmText || '').trim() !== 'حذف') {
      return res.status(400).json({ error: 'يجب إرسال نص التأكيد "حذف" لتنفيذ عملية الحذف' });
    }
    const range = parseRange(from, to);
    if (!range) return res.status(400).json({ error: 'نطاق تاريخ غير صالح' });
    if (!types.rawLogs && !types.daily && !types.payroll) {
      return res.status(400).json({ error: 'يجب تحديد نوع بيانات واحد على الأقل' });
    }
    const { from: f, to: t } = range;

    // ── Re-validate guards server-side — never trust the client ─────────────
    const impact = await analyzeImpact({ f, t, types });
    if (impact.currentPeriodOverlap && !confirmCurrentPeriod) {
      return res.status(409).json({
        error: 'الفترة المحددة تشمل الشهر الحالي — يلزم تأكيد إضافي (confirmCurrentPeriod)',
        requiresConfirmation: 'currentPeriod', impact,
      });
    }
    if (impact.finalizedPayroll.length && !confirmFinalizedPayroll) {
      return res.status(409).json({
        error: 'توجد مرتبات معتمدة/مدفوعة ضمن هذه الفترة — يلزم تأكيد إضافي (confirmFinalizedPayroll)',
        requiresConfirmation: 'finalizedPayroll', impact,
      });
    }

    // ── Backup-before-delete (Excel snapshot of exactly what will be removed) ─
    let backupFile = null;
    if (backupFirst) {
      const buf = await buildBackupWorkbook({ f, t, months: impact.months, types });
      if (buf) {
        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
        backupFile = `cleanup_${f.format('YYYYMMDD')}-${t.format('YYYYMMDD')}_${Date.now()}.xlsx`;
        fs.writeFileSync(path.join(BACKUP_DIR, backupFile), buf);
      }
    }

    // ── Ordered, batched, transactional delete (req. #14/#21/#25) ───────────
    // Conceptual order (source → derived): Raw Logs → Attendance Results →
    // Monthly Aggregates. Executable order is adjusted to satisfy FK
    // constraints: AttendanceAdjustment (+ its cascade-audit children) must be
    // removed before its parent AttendanceDaily row.
    const stages = [];
    if (types.rawLogs) stages.push({ key: 'rawLogs', label: TYPE_LABELS.rawLogs, slices: dateSlices(f, t) });
    if (types.daily) stages.push({ key: 'daily', label: TYPE_LABELS.daily, slices: dateSlices(f, t) });
    if (types.payroll) stages.push({ key: 'payroll', label: TYPE_LABELS.payroll, slices: impact.months.map(m => [m]) });

    const totalSteps = stages.reduce((s, st) => s + st.slices.length, 0) || 1;
    let doneSteps = 0;
    const counts = { rawLogsDeleted: 0, dailyDeleted: 0, payrollDeleted: 0 };

    emit(req.io, 'cleanup:start', { from: impact.from, to: impact.to, types, totalSteps, employeesAffected: impact.employeesAffected });

    await prisma.$transaction(async (tx) => {
      for (const stage of stages) {
        for (const slice of stage.slices) {
          if (stage.key === 'rawLogs') {
            const [s, e] = slice;
            const r = await tx.attendanceLog.deleteMany({ where: { timestamp: { gte: s.toDate(), lte: e.toDate() } } });
            counts.rawLogsDeleted += r.count;
          } else if (stage.key === 'daily') {
            const [s, e] = slice;
            const adjustments = await tx.attendanceAdjustment.findMany({
              where: { date: { gte: s.toDate(), lte: e.toDate() } }, select: { id: true },
            });
            const adjIds = adjustments.map(a => a.id);
            if (adjIds.length) {
              await tx.adjustmentAuditLog.deleteMany({ where: { adjustmentId: { in: adjIds } } });
              await tx.attendanceAdjustment.deleteMany({ where: { id: { in: adjIds } } });
            }
            const r = await tx.attendanceDaily.deleteMany({ where: { date: { gte: s.toDate(), lte: e.toDate() } } });
            counts.dailyDeleted += r.count;
          } else if (stage.key === 'payroll') {
            const { month, year } = slice[0];
            const r = await tx.payroll.deleteMany({ where: { month, year } });
            counts.payrollDeleted += r.count;
          }
          doneSteps++;
          emit(req.io, 'cleanup:progress', { stage: stage.key, label: stage.label, done: doneSteps, total: totalSteps });
        }
      }
    }, { timeout: 5 * 60 * 1000, maxWait: 30 * 1000 });

    // ── Scoped consistency check (req. #26) ─────────────────────────────────
    // MySQL/InnoDB enforces FK constraints, and our delete order guarantees no
    // orphans CAN be created — this asserts the exact range we touched is
    // fully clean (a proportional sanity check, not a whole-DB integrity scan).
    const consistencyNotes = [];
    if (types.daily) {
      const leftoverAdj = await prisma.attendanceAdjustment.count({ where: { date: { gte: f.toDate(), lte: t.toDate() } } });
      if (leftoverAdj > 0) consistencyNotes.push(`تنبيه اتساق: تبقّى ${leftoverAdj} سجل تعديل ضمن الفترة بعد الحذف`);
    }

    // ── MySQL space reclamation (req. #10) — outside the transaction (DDL/maintenance) ─
    let optimizeRun = false;
    try {
      const tables = [];
      if (types.rawLogs) tables.push('attendance_logs');
      if (types.daily) tables.push('attendance_daily', 'attendance_adjustments');
      if (types.payroll) tables.push('payrolls');
      if (tables.length) {
        await prisma.$executeRawUnsafe(`OPTIMIZE TABLE ${tables.join(', ')}`);
        optimizeRun = true;
      }
    } catch (e) { consistencyNotes.push(`تعذّر تنفيذ OPTIMIZE TABLE: ${e.message}`); }

    // ── Recalculation cascade (req. #17/#18) — regenerates correct derived data
    // AND triggers the existing useRulesLiveSync/recalc:done live-refresh on
    // every dependent screen for free (no new frontend wiring needed). ───────
    let recalcTriggered = false;
    // Recalc after deleting raw logs OR daily rows — deleting daily rows
    // without regenerating left payroll aggregates referencing data that no
    // longer existed (stale derived state until someone manually recalculated).
    if (types.rawLogs || types.daily) {
      // EP-020: scope the recalc to exactly the employees analyzeImpact()
      // found in this range — previously omitted, so recalcScope() fell
      // back to its "every active employee" default and regenerated
      // placeholder AttendanceDaily/Payroll rows company-wide for every
      // cleanup, even ones touching a single employee.
      await recalcEngine.recalcScope({
        from: f.toDate(), to: t.toDate(), io: req.io,
        employeeIds: impact.employeeIds,
        reason: `تنظيف الحركات: إعادة احتساب بعد الحذف (${impact.from} → ${impact.to})`,
        // This route already re-validated finalized/paid exposure above
        // (impact.finalizedPayroll) and returned HTTP 409 unless the admin
        // explicitly confirmed via confirmFinalizedPayroll — recalcScope's
        // own protective default would otherwise silently skip those same
        // rows even after that explicit confirmation, contradicting it.
        allowFinalizedPayroll: true,
      });
      recalcTriggered = true;
    }

    const durationMs = Date.now() - startedAt;
    const log = await prisma.cleanupLog.create({
      data: {
        fromDate: f.toDate(), toDate: t.toDate(),
        dataTypes: JSON.stringify(types),
        status: 'completed',
        rawLogsDeleted: counts.rawLogsDeleted,
        dailyDeleted: counts.dailyDeleted,
        payrollDeleted: counts.payrollDeleted,
        employeesAffected: impact.employeesAffected,
        backupTaken: !!backupFile,
        recalcTriggered, optimizeRun, durationMs,
        executedByName: String(executedByName).trim(),
        notes: [
          backupFile ? `نسخة احتياطية: ${backupFile}` : null,
          ...consistencyNotes,
        ].filter(Boolean).join(' | ') || null,
      },
    });

    const summary = {
      id: log.id,
      from: impact.from, to: impact.to,
      deleted: counts, employeesAffected: impact.employeesAffected,
      backupFile, recalcTriggered, optimizeRun, durationMs,
      consistencyNotes,
    };
    emit(req.io, 'cleanup:done', summary);
    res.json(summary);
  } catch (err) {
    // Failed runs belong in the audit trail too — the schema always supported
    // status='failed' but nothing ever wrote it.
    try {
      const r = parseRange(req.body?.from, req.body?.to);
      if (r) {
        await prisma.cleanupLog.create({
          data: {
            fromDate: r.from.toDate(), toDate: r.to.toDate(),
            dataTypes: JSON.stringify(req.body?.types || {}),
            status: 'failed',
            durationMs: Date.now() - startedAt,
            executedByName: String(req.body?.executedByName || '—').trim(),
            notes: `فشل التنفيذ: ${err.message}`,
          },
        });
      }
    } catch { /* audit-trail best effort */ }
    emit(req.io, 'cleanup:done', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── Download a backup produced by /execute ──────────────────────────────────
router.get('/backups/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // strip any path traversal
  const filePath = path.join(BACKUP_DIR, filename);
  if (!filePath.startsWith(BACKUP_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'الملف غير موجود' });
  }
  res.download(filePath);
});

// ─── History — the audit trail / activity-feed for this feature ─────────────
router.get('/logs', async (req, res) => {
  try {
    const take = Math.min(parseInt(req.query.limit) || 20, 100);
    const logs = await prisma.cleanupLog.findMany({ orderBy: { createdAt: 'desc' }, take });
    res.json(logs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
