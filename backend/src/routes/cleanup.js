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
const { sendError } = require('../utils/apiError');
const deviceLogCounts = require('../services/deviceLogCounts');
const { getPrisma } = require('../utils/prisma');
const { resolveActor } = require('../utils/auditActor');
const moment = require('moment');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { authenticate, authorize } = require('../middleware/auth');
const { currentMonthRange } = require('../utils/monthRange');
const recalcEngine = require('../engines/recalcEngine');
const { CLOSED_PAYROLL_STATUSES } = require('../engines/payrollEngine');
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

// ─── Closed-payroll protection (policy A) ───────────────────────────────────────────────────────────────────────────────
// A finalized / paid Payroll row is the only stored record of what was approved and paid, and nothing in the app can restore it
// (no restore feature; the Excel backup is a partial snapshot). So this tool NEVER deletes one, whatever the client sends:
//   • 'payroll'  — refused (HTTP 409) when ANY finalized/paid row exists in the months the range touches;
//   • 'daily'    — refused for the same months: the daily results are the basis of those approved payrolls, and deleting them
//                  would leave the approved statements without their supporting data;
//   • 'rawLogs'  — allowed (raw punches are not the payroll's basis), but the recalculation that follows is NOT run for an
//                  employee in a month where that employee's payroll is closed, so no attendance row behind it is rewritten.
// Enforced here on the server for every caller; confirmFinalizedPayroll is no longer a way around it. Re-validated inside the
// delete transaction on locked rows (SELECT … FOR UPDATE), and the payroll DELETE itself carries a status predicate, so a payroll
// finalized concurrently can never be removed.
class CleanupProtectedError extends Error {
  constructor(protectedPayroll, message) {
    super(message);
    this.name = 'CleanupProtectedError';
    this.statusCode = 409;
    this.code = 'CLEANUP_PAYROLL_PROTECTED';
    this.protectedPayroll = protectedPayroll;
  }
}
const isClosedStatus = (s) => CLOSED_PAYROLL_STATUSES.includes(String(s || '').toLowerCase());

function summarizeProtected(rows) {
  const out = { finalized: 0, paid: 0, total: 0, months: [] };
  const byMonth = new Map();
  for (const r of rows) {
    const st = String(r.status).toLowerCase();
    const key = `${r.year}-${r.month}`;
    if (!byMonth.has(key)) byMonth.set(key, { month: r.month, year: r.year, finalized: 0, paid: 0 });
    const m = byMonth.get(key);
    if (st === 'paid') { out.paid++; m.paid++; } else { out.finalized++; m.finalized++; }
    out.total++;
  }
  out.months = [...byMonth.values()].sort((a, b) => a.year - b.year || a.month - b.month);
  return out;
}
const protectedCountsText = (p) => `${p.total} سجل (${p.finalized} معتمد، ${p.paid} مدفوع)`;
const BLOCK_REASONS = {
  payroll: (p) => `لا يمكن حذف المرتبات: توجد مرتبات معتمدة/مدفوعة ضمن الفترة المحددة — ${protectedCountsText(p)}. المرتبات المعتمدة والمدفوعة محمية ولا تُحذف عبر أداة التنظيف مهما كان التأكيد. اختر أشهراً لا تتضمنها.`,
  daily: (p) => `لا يمكن حذف نتائج الحضور اليومية: توجد مرتبات معتمدة/مدفوعة ضمن الفترة المحددة — ${protectedCountsText(p)} — ونتائج الحضور هي أساس هذه المرتبات. احذف السجلات الخام فقط أو اختر أشهراً لا تتضمن مرتبات معتمدة/مدفوعة.`,
};
function protectionVerdict(types, protectedPayroll) {
  const blockedTypes = [];
  if (protectedPayroll.total > 0 && types.payroll) blockedTypes.push('payroll');
  if (protectedPayroll.total > 0 && types.daily) blockedTypes.push('daily');
  const blockedReasons = {};
  blockedTypes.forEach(k => { blockedReasons[k] = BLOCK_REASONS[k](protectedPayroll); });
  return { blocked: blockedTypes.length > 0, blockedTypes, blockedReasons, blockedMessage: blockedTypes.map(k => blockedReasons[k]).join(' | ') || null };
}

/** The blocked attempt is part of the audit trail too (status 'blocked', who tried, what range, how many protected rows). */
async function logBlocked(req, range, types, protectedPayroll, message, startedAt) {
  try {
    await prisma.cleanupLog.create({
      data: {
        fromDate: range.from.toDate(), toDate: range.to.toDate(), dataTypes: JSON.stringify(types || {}),
        status: 'blocked', durationMs: Date.now() - startedAt,
        executedByName: String((req.user ? resolveActor(req).name : req.body?.executedByName) || '—').trim(),
        notes: `رُفض بسبب مرتبات معتمدة/مدفوعة: ${protectedCountsText(protectedPayroll)} — ${message}`.slice(0, 60000),
      },
    });
  } catch { /* audit-trail best effort */ }
}

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
    // Only rows the tool is allowed to delete (not finalized/paid) are counted; protected rows are reported separately.
    const deletable = { OR: monthsOr, status: { notIn: CLOSED_PAYROLL_STATUSES.slice() } };
    counts.payroll = monthsOr.length ? await prisma.payroll.count({ where: deletable }) : 0;
    if (monthsOr.length) {
      (await prisma.payroll.findMany({ where: deletable, distinct: ['employeeId'], select: { employeeId: true } }))
        .forEach(r => employeeIds.add(r.employeeId));
    }
  }

  // Finalized/paid Payroll rows in the months this range spans — computed whatever the selected types are, because they decide
  // which types are refused (policy A, see the block near the top) and which employee-months are excluded from the recalculation.
  if (monthsOr.length) {
    finalizedPayroll = await prisma.payroll.findMany({
      where: { OR: monthsOr, status: { in: CLOSED_PAYROLL_STATUSES.slice() } },
      select: {
        employeeId: true, month: true, year: true, status: true,
        employee: { select: { name: true, code: true } },
      },
    });
  }
  const protectedPayroll = summarizeProtected(finalizedPayroll);
  const verdict = protectionVerdict(types, protectedPayroll);
  if (verdict.blocked) {
    verdict.blockedTypes.forEach(k => warnings.push('⛔ ' + verdict.blockedReasons[k]));
  } else if (protectedPayroll.total > 0) {
    warnings.push(`🛡️ توجد ${protectedCountsText(protectedPayroll)} من المرتبات المعتمدة/المدفوعة ضمن الفترة: هي محمية — لن تُحذف ولن تُعاد احتسابها، ولن يُعاد احتساب الحضور لهؤلاء الموظفين في تلك الأشهر.`);
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
    currentPeriodOverlap: overlap, warnings,
    // `finalizedPayroll` (the protected rows) is kept for existing consumers; it is informational only now — it can no longer be confirmed away.
    finalizedPayroll, protectedPayroll, ...verdict, canExecute: !verdict.blocked,
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
  } catch (err) { sendError(res, err); }
});

// ─── Execute (the real, destructive operation — admin-only) ─────────────────
router.post('/execute', authorize('admin'), async (req, res) => {
  const startedAt = Date.now();
  try {
    const {
      from, to, types = {}, backupFirst = true, confirmText,
      confirmCurrentPeriod = false,
      // confirmFinalizedPayroll is still ACCEPTED (older clients send it) but ignored: closed payroll is protected regardless.
    } = req.body;
    // F-10: with auth on, the executor is the authenticated user, never a body-claimed name.
    const executedByName = req.user ? resolveActor(req).name : req.body.executedByName;

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
    if (impact.blocked) {
      await logBlocked(req, range, types, impact.protectedPayroll, impact.blockedMessage, startedAt);
      return res.status(409).json({
        error: impact.blockedMessage, code: 'CLEANUP_PAYROLL_PROTECTED',
        blockedTypes: impact.blockedTypes, protectedPayroll: impact.protectedPayroll, impact,
      });
    }
    if (impact.currentPeriodOverlap && !confirmCurrentPeriod) {
      return res.status(409).json({
        error: 'الفترة المحددة تشمل الشهر الحالي — يلزم تأكيد إضافي (confirmCurrentPeriod)',
        requiresConfirmation: 'currentPeriod', impact,
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
      // Re-validate the protection INSIDE the transaction, on locked rows: SELECT … FOR UPDATE on the payroll rows of every
      // month the range touches stops a concurrent finalization until this transaction ends, and the statuses are read AFTER
      // the lock is granted. Anything closed → throw before a single row is deleted (the whole transaction rolls back).
      const draftRowsByMonth = new Map();
      if (types.payroll || types.daily) {
        for (const { month, year } of impact.months) {
          const rows = await tx.$queryRaw`SELECT id, status FROM payrolls WHERE month = ${month} AND year = ${year} FOR UPDATE`;
          const closedNow = rows.filter(r => isClosedStatus(r.status));
          if (closedNow.length) {
            const p = summarizeProtected(closedNow.map(r => ({ status: r.status, month, year })));
            const kind = types.payroll ? 'payroll' : 'daily';
            throw new CleanupProtectedError(p, BLOCK_REASONS[kind](p));
          }
          draftRowsByMonth.set(`${year}-${month}`, rows.length);
        }
      }
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
            // The status predicate is evaluated by MySQL at delete time: a closed row is never deleted, even by mistake.
            const r = await tx.payroll.deleteMany({ where: { month, year, status: { notIn: CLOSED_PAYROLL_STATUSES.slice() } } });
            if (r.count !== draftRowsByMonth.get(`${year}-${month}`)) {
              const p = summarizeProtected([{ status: 'finalized', month, year }]);
              throw new CleanupProtectedError(p, BLOCK_REASONS.payroll(p));   // a row changed state under us → roll everything back
            }
            counts.payrollDeleted += r.count;
          }
          doneSteps++;
          emit(req.io, 'cleanup:progress', { stage: stage.key, label: stage.label, done: doneSteps, total: totalSteps });
        }
      }
    }, { timeout: 5 * 60 * 1000, maxWait: 30 * 1000 });
    deviceLogCounts.invalidate();   // raw logs were deleted: per-device counts are no longer exact

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
    // Employee-months whose payroll is finalized/paid are EXCLUDED from the recalculation: their attendance rows are not rewritten
    // (so the data behind an approved payroll is never invalidated) and their payroll rows are never touched. Done month by month so
    // an employee can be left out of exactly the months where his payroll is closed.
    const closedKeys = new Set(impact.finalizedPayroll.map(r => `${r.employeeId}|${r.month}|${r.year}`));
    let recalcSkippedEmployeeMonths = 0;
    if (types.rawLogs || types.daily) {
      for (const { month, year } of impact.months) {
        const mStart = moment({ year, month: month - 1, day: 1 }).startOf('month');
        const from = moment.max(f, mStart), to = moment.min(t, mStart.clone().endOf('month'));
        const ids = impact.employeeIds.filter(id => !closedKeys.has(`${id}|${month}|${year}`));
        recalcSkippedEmployeeMonths += impact.employeeIds.length - ids.length;
        if (!ids.length) continue;
        // EP-020: scoped to exactly the employees analyzeImpact() found. No allowFinalizedPayroll: closed payroll stays protected.
        await recalcEngine.recalcScope({
          from: from.toDate(), to: to.toDate(), io: req.io, employeeIds: ids,
          reason: `تنظيف الحركات: إعادة احتساب بعد الحذف (${impact.from} → ${impact.to})`,
        });
        recalcTriggered = true;
      }
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
          impact.protectedPayroll.total > 0 ? `مرتبات معتمدة/مدفوعة محمية (لم تُمسّ): ${protectedCountsText(impact.protectedPayroll)} — استُبعد ${recalcSkippedEmployeeMonths} موظف-شهر من إعادة الاحتساب` : null,
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
      // protected closed payroll that this run left untouched (always 0 deleted), and what was excluded from the recalculation
      protectedPayroll: impact.protectedPayroll, recalcSkippedEmployeeMonths,
    };
    emit(req.io, 'cleanup:done', summary);
    res.json(summary);
  } catch (err) {
    if (err instanceof CleanupProtectedError) {
      const r = parseRange(req.body?.from, req.body?.to);
      if (r) await logBlocked(req, r, req.body?.types, err.protectedPayroll, err.message, startedAt);
      emit(req.io, 'cleanup:done', { error: err.message });
      return res.status(409).json({ error: err.message, code: err.code, protectedPayroll: err.protectedPayroll });
    }
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
            executedByName: String((req.user ? resolveActor(req).name : req.body?.executedByName) || '—').trim(),
            notes: `فشل التنفيذ: ${err.message}`,
          },
        });
      }
    } catch { /* audit-trail best effort */ }
    emit(req.io, 'cleanup:done', { error: err.message });
    sendError(res, err);
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
  } catch (err) { sendError(res, err); }
});

module.exports = router;
