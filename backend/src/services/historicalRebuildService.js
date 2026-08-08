/**
 * historicalRebuildService.js — Historical Attendance/Payroll Rebuild Engine
 *
 * Orchestration layer around the existing, UNCHANGED engines:
 *   - attendanceEngine.processDate(date, employeeId)
 *   - payrollEngine.calculatePayroll(employeeId, month, year)
 * (same calls `recalcEngine.recalcScope` already makes for on-demand
 * full-history recalcs via POST /api/rules/recalculate-full).
 *
 * Purpose: when historical AttendanceLog rows are imported (large backfill
 * sync, or a chunked recovery pull that pulls in old records), the derived
 * `attendance_daily` / `payrolls` tables for that window are stale until
 * someone runs a full recalc. This service:
 *   - discovers which date windows actually need rebuilding (REBUILD-RANGE),
 *   - runs a single-owner, lock-protected rebuild job (HIST-REBUILD),
 *   - processes employees/dates sequentially with persisted checkpoints
 *     (REBUILD-BATCH) so a crash/restart resumes exactly where it left off,
 *   - recomputes payroll per employee/month after attendance is rebuilt
 *     (PAYROLL-RECALC), and
 *   - auto-queues itself after a historical sync inserts old records.
 *
 * Locking mirrors the `syncLocks` pattern in zktecoService.js: a single
 * in-memory `activeRebuild` claimed synchronously (no await between check
 * and set). Overlapping requests are merged into `pendingRange` instead of
 * starting a second job — no concurrent rebuilds, no duplicate-recalc storms.
 */
const { getPrisma } = require('../utils/prisma');
const moment = require('moment');
const attendanceEngine = require('../engines/attendanceEngine');
const payrollEngine = require('../engines/payrollEngine');
const { clampToValidRange, MIN_VALID_TS } = require('../utils/timestamps');
const logger = require('../utils/logger');

const prisma = getPrisma();

// How many dates to process between persisted checkpoints (resumability).
const REBUILD_CHECKPOINT_DAYS = parseInt(process.env.REBUILD_CHECKPOINT_DAYS || '10', 10);

// Pause between employees — keeps a long rebuild from saturating the shared
// Prisma pool while the realtime listener / sync are also writing.
const REBUILD_INTER_EMPLOYEE_DELAY_MS = parseInt(process.env.REBUILD_INTER_EMPLOYEE_DELAY_MS || '50', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Single-owner lock state ────────────────────────────────────────────────
let activeRebuild = null; // { jobId, owner, generation }
let rebuildOwnerCounter = 0;
let rebuildGeneration = 0;

// A request that arrived while a rebuild was already running is merged here
// (min(from)/max(to)) and started automatically once the active job finishes.
let pendingRange = null;

function emit(io, event, payload) {
  if (io) io.emit(event, payload);
}

function isRebuildRunning() {
  return !!activeRebuild;
}

function clearActiveIfOwner(jobId) {
  if (activeRebuild && activeRebuild.jobId === jobId) activeRebuild = null;
}

// ─── Range discovery (requirement 7) ────────────────────────────────────────
// Single bounded query: one row per distinct day that has AttendanceLog rows,
// compared against attendance_daily's per-day "has a real check-in" coverage.
// A day "needs rebuild" if logs exist for it but attendance_daily has no row
// (or no checked-in row) for that day. Consecutive flagged days collapse into
// ranges. Bounded to [MIN_VALID_TS, today] — drops 1999/2000 sentinel rows and
// future placeholder rows automatically.
async function discoverRanges() {
  const today = moment().endOf('day').toDate();

  const logDays = await prisma.$queryRaw`
    SELECT DATE(timestamp) as d, COUNT(*) as c
    FROM attendance_logs
    WHERE isDuplicate = false AND timestamp >= ${MIN_VALID_TS} AND timestamp <= ${today}
    GROUP BY DATE(timestamp)
    ORDER BY d ASC
  `;

  if (!logDays.length) {
    logger.info('[REBUILD-RANGE] no attendance_logs in valid range — nothing to discover');
    return [];
  }

  const minD = logDays[0].d;
  const maxD = logDays[logDays.length - 1].d;

  const dailyDays = await prisma.$queryRaw`
    SELECT date as d, SUM(CASE WHEN checkIn IS NOT NULL THEN 1 ELSE 0 END) as hasCheckin
    FROM attendance_daily
    WHERE date >= ${minD} AND date <= ${maxD}
    GROUP BY date
  `;

  const dailyMap = new Map(dailyDays.map((r) => [moment(r.d).format('YYYY-MM-DD'), Number(r.hasCheckin)]));

  const needsRebuild = [];
  for (const row of logDays) {
    const key = moment(row.d).format('YYYY-MM-DD');
    const hasCheckin = dailyMap.get(key);
    if (hasCheckin === undefined || hasCheckin === 0) needsRebuild.push(key);
  }

  const ranges = [];
  for (const dateStr of needsRebuild) {
    const last = ranges[ranges.length - 1];
    if (last && moment(dateStr).diff(moment(last.to), 'days') === 1) {
      last.to = dateStr;
    } else {
      ranges.push({ from: dateStr, to: dateStr });
    }
  }

  logger.info(`[REBUILD-RANGE] discovered ${ranges.length} range(s): ${ranges.map((r) => `${r.from}→${r.to}`).join(', ') || 'none'}`);
  return ranges;
}

// ─── Start a rebuild job (single owner, merges overlaps into pendingRange) ──
async function startRebuild({ from, to, employeeId, reason, triggeredBy = 'manual', io } = {}) {
  if (!from || !to) throw new Error('from and to are required');

  // Check-then-claim happens synchronously below — no await between the
  // `if (activeRebuild)` check and setting `activeRebuild`, mirroring the
  // TOCTOU-safe syncLocks pattern in zktecoService.pullLogs.
  if (activeRebuild) {
    const f = moment(from);
    const t = moment(to);
    if (!pendingRange) {
      pendingRange = { from: f.toDate(), to: t.toDate(), reason };
    } else {
      if (f.isBefore(pendingRange.from)) pendingRange.from = f.toDate();
      if (t.isAfter(pendingRange.to)) pendingRange.to = t.toDate();
    }
    logger.info(`[HIST-REBUILD] queued — merged into pending range ${moment(pendingRange.from).format('YYYY-MM-DD')}→${moment(pendingRange.to).format('YYYY-MM-DD')} (active jobId=${activeRebuild.jobId})`);
    return { queued: true, pending: pendingRange };
  }

  let { from: clampedFrom, to: clampedTo } = clampToValidRange(from, to);
  const today = moment().endOf('day');
  if (moment(clampedTo).isAfter(today)) clampedTo = today.toDate();
  if (moment(clampedFrom).isAfter(clampedTo)) clampedFrom = clampedTo;

  const fromDate = moment(clampedFrom).startOf('day').toDate();
  const toDate = moment(clampedTo).startOf('day').toDate();

  const job = await prisma.historicalRebuildJob.create({
    data: {
      fromDate,
      toDate,
      employeeId: employeeId ?? null,
      status: 'running',
      triggeredBy,
      reason: reason || null,
      cursorDate: fromDate,
    },
  });

  rebuildGeneration++;
  activeRebuild = { jobId: job.id, owner: ++rebuildOwnerCounter, generation: rebuildGeneration };

  logger.info(`[HIST-REBUILD] start jobId=${job.id} range=${moment(fromDate).format('YYYY-MM-DD')}→${moment(toDate).format('YYYY-MM-DD')} employeeScope=${employeeId ?? 'all'} trigger=${triggeredBy} gen=${rebuildGeneration} reason="${reason || ''}"`);
  emit(io, 'rebuild:start', { jobId: job.id, from: moment(fromDate).format('YYYY-MM-DD'), to: moment(toDate).format('YYYY-MM-DD'), employeeId: employeeId ?? null, triggeredBy });

  runRebuild(job.id, io).catch((err) => {
    logger.error(`[REBUILD-ERROR] jobId=${job.id} unexpected: ${err.message}`);
  });

  return { started: true, jobId: job.id };
}

/** Auto-trigger wrapper used by zktecoService after a historical sync. */
async function queueFromSync({ from, to, reason, io }) {
  return startRebuild({ from, to, reason, triggeredBy: 'auto-sync', io });
}

// ─── Core rebuild loop (batched, resumable, single owner) ──────────────────
async function runRebuild(jobId, io) {
  try {
    const job = await prisma.historicalRebuildJob.findUnique({ where: { id: jobId } });
    if (!job) {
      logger.warn(`[REBUILD-ERROR] jobId=${jobId} not found — aborting`);
      return;
    }

    const employees = await prisma.employee.findMany({
      where: { status: true, ...(job.employeeId ? { id: job.employeeId } : {}) },
      orderBy: { id: 'asc' },
    });

    if (job.totalEmployees !== employees.length) {
      await prisma.historicalRebuildJob.update({ where: { id: jobId }, data: { totalEmployees: employees.length } });
    }

    const fromMoment = moment(job.fromDate).startOf('day');
    const toMoment = moment(job.toDate).endOf('day');

    // Months touched by this range — payroll recalculated once per employee
    // for each, after that employee's attendance_daily rows are rebuilt.
    const months = [];
    {
      const m = fromMoment.clone().startOf('month');
      while (m.isSameOrBefore(toMoment)) {
        months.push({ month: m.month() + 1, year: m.year() });
        m.add(1, 'month');
      }
    }

    let errorCount = job.errorCount;
    let processedDates = job.processedDates;
    let processedEmployees = job.processedEmployees;
    let datesSinceCheckpoint = 0;
    let resuming = job.cursorEmployeeId != null;

    for (const emp of employees) {
      if (resuming && emp.id < job.cursorEmployeeId) continue;

      let d = fromMoment.clone();
      if (resuming && emp.id === job.cursorEmployeeId && job.cursorDate) {
        d = moment(job.cursorDate).startOf('day');
      }
      resuming = false; // only the cursor employee resumes mid-range

      while (d.isSameOrBefore(toMoment)) {
        if (!activeRebuild || activeRebuild.jobId !== jobId) {
          logger.warn(`[HIST-REBUILD] jobId=${jobId} lost ownership — stopping (cursor preserved for resume)`);
          return;
        }

        try {
          await attendanceEngine.processDate(d.toDate(), emp.id);
          logger.info(`[ATTENDANCE-RECALC] jobId=${jobId} employee=${emp.id} date=${d.format('YYYY-MM-DD')}`);
        } catch (err) {
          errorCount++;
          logger.error(`[REBUILD-ERROR] jobId=${jobId} employee=${emp.id} date=${d.format('YYYY-MM-DD')} attendance: ${err.message}`);
        }

        processedDates++;
        datesSinceCheckpoint++;

        if (datesSinceCheckpoint >= REBUILD_CHECKPOINT_DAYS) {
          await prisma.historicalRebuildJob.update({
            where: { id: jobId },
            data: { cursorEmployeeId: emp.id, cursorDate: d.toDate(), processedDates, errorCount },
          });
          logger.info(`[REBUILD-BATCH] jobId=${jobId} employee=${emp.id} date=${d.format('YYYY-MM-DD')} processedDates=${processedDates} processedEmployees=${processedEmployees}/${employees.length}`);
          emit(io, 'rebuild:progress', { jobId, employeeId: emp.id, date: d.format('YYYY-MM-DD'), processedDates, processedEmployees, totalEmployees: employees.length });
          datesSinceCheckpoint = 0;
        }

        d.add(1, 'day');
      }

      // C1: a historical rebuild is a background side-effect of newly-imported
      // AttendanceLog rows, not a direct edit of any Payroll row — protect
      // finalized/paid months the same way every other cascade caller does
      // (Phase 13.3's canonical, batched check), instead of silently
      // overwriting them just because they fall inside the rebuilt range.
      const monthTargets = months.map(({ month, year }) => ({ employeeId: emp.id, month, year }));
      const { allowed: allowedMonths, protectedTargets } = await payrollEngine.filterProtectedPayrollTargets(monthTargets);
      if (protectedTargets.length) {
        logger.warn(`[REBUILD] jobId=${jobId} employee=${emp.id}: SKIPPED finalized/paid ` +
          protectedTargets.map(t => `${t.month}/${t.year} (${t.status})`).join(', '));
      }
      for (const { month, year } of allowedMonths) {
        try {
          await payrollEngine.calculatePayroll(emp.id, month, year);
          logger.info(`[PAYROLL-RECALC] jobId=${jobId} employee=${emp.id} month=${month}/${year}`);
        } catch (err) {
          errorCount++;
          logger.error(`[REBUILD-ERROR] jobId=${jobId} employee=${emp.id} month=${month}/${year} payroll: ${err.message}`);
        }
      }

      processedEmployees++;
      await prisma.historicalRebuildJob.update({
        where: { id: jobId },
        data: { cursorEmployeeId: emp.id, cursorDate: toMoment.toDate(), processedEmployees, processedDates, errorCount },
      });

      if (REBUILD_INTER_EMPLOYEE_DELAY_MS > 0) await sleep(REBUILD_INTER_EMPLOYEE_DELAY_MS);
    }

    await prisma.historicalRebuildJob.update({
      where: { id: jobId },
      data: { status: 'completed', completedAt: new Date(), processedEmployees, processedDates, errorCount },
    });
    logger.info(`[REBUILD-COMPLETE] jobId=${jobId} employees=${processedEmployees}/${employees.length} dates=${processedDates} errors=${errorCount}`);
    emit(io, 'rebuild:complete', { jobId, processedEmployees, processedDates, errorCount });
  } catch (err) {
    logger.error(`[REBUILD-ERROR] jobId=${jobId} fatal: ${err.message}`);
    await prisma.historicalRebuildJob.update({
      where: { id: jobId },
      data: { status: 'failed', lastError: err.message },
    }).catch(() => {});
  } finally {
    clearActiveIfOwner(jobId);

    if (pendingRange) {
      const next = pendingRange;
      pendingRange = null;
      startRebuild({ from: next.from, to: next.to, reason: next.reason, triggeredBy: 'auto-sync', io }).catch((err) => {
        logger.error(`[HIST-REBUILD] chained start error: ${err.message}`);
      });
    }
  }
}

// ─── Crash safety: resume any job left 'running' by a process that died ────
async function resumeInterruptedJobs(io) {
  const stuck = await prisma.historicalRebuildJob.findMany({ where: { status: 'running' } });
  for (const job of stuck) {
    if (activeRebuild) {
      logger.warn(`[HIST-REBUILD] jobId=${job.id} left 'running' but jobId=${activeRebuild.jobId} is already active — marking failed for manual review`);
      await prisma.historicalRebuildJob.update({
        where: { id: job.id },
        data: { status: 'failed', lastError: 'interrupted, superseded by another active rebuild on resume' },
      }).catch(() => {});
      continue;
    }

    rebuildGeneration++;
    activeRebuild = { jobId: job.id, owner: ++rebuildOwnerCounter, generation: rebuildGeneration };
    logger.info(`[HIST-REBUILD] resuming jobId=${job.id} from cursor employee=${job.cursorEmployeeId ?? 'start'} date=${job.cursorDate ? moment(job.cursorDate).format('YYYY-MM-DD') : 'start'} gen=${rebuildGeneration}`);
    await runRebuild(job.id, io);
  }
}

// ─── Diagnostics (requirement 8) ────────────────────────────────────────────
async function getStatus() {
  let active = null;
  if (activeRebuild) {
    const row = await prisma.historicalRebuildJob.findUnique({ where: { id: activeRebuild.jobId } });
    if (row) active = { ...row, generation: activeRebuild.generation };
  }
  const lastJob = await prisma.historicalRebuildJob.findFirst({ orderBy: { id: 'desc' } });
  return { active, pending: pendingRange, lastJob };
}

module.exports = {
  startRebuild,
  queueFromSync,
  resumeInterruptedJobs,
  discoverRanges,
  getStatus,
  isRebuildRunning,
};
