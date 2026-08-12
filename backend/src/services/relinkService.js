/**
 * relinkService.js — Runtime Relinking System
 *
 * Problem: attendance_logs rows pulled from the ZK device are stored with a
 * `zkUserId` (the device's internal user id) but `employeeId` is only set if
 * a matching `Employee.zkUserId` already existed at insert time. If logs were
 * pulled before the matching employee was created (or the employee's zkUserId
 * was fixed later), those logs are stuck with `employeeId = NULL` forever and
 * never show up in Daily Attendance / Movement / Reports / Payroll / Dashboard
 * (all of which key off `employeeId`).
 *
 * This service re-links any orphaned `attendance_logs` rows to the matching
 * `Employee` (same `zkUserId`), then regenerates `attendance_daily` and
 * recalculates payroll for the affected employees / date ranges so the data
 * appears immediately everywhere without a new sync.
 */

const { getPrisma } = require('../utils/prisma');
const { clampToValidRange } = require('../utils/timestamps');
const logger = require('../utils/logger');
const attendanceEngine = require('../engines/attendanceEngine');
const payrollEngine = require('../engines/payrollEngine');
const moment = require('moment');

const prisma = getPrisma();

function emit(io, event, data) {
  if (io) io.emit(event, data);
}

/**
 * Re-link orphaned attendance_logs (employeeId IS NULL) to employees sharing
 * the same zkUserId, then regenerate attendance_daily + payroll for the
 * affected employees / date ranges.
 *
 * @param {Object}  opts
 * @param {number}  [opts.employeeId]  Limit relink to a single employee (e.g. just created/edited)
 * @param {number}  [opts.deviceId]    Limit relink to logs from a single device
 * @param {object}  [opts.io]          Socket.IO instance for live progress events
 * @param {string}  [opts.reason]      Human-readable reason, surfaced in events/logs
 */
async function relinkAttendanceLogs({ employeeId, deviceId, io, reason } = {}) {
  // Orphans-first: find which zkUserIds actually HAVE unlinked logs before
  // touching any employee. This runs after every sync — without this filter
  // it issued an aggregate query per employee per sync even when there was
  // nothing to relink.
  const orphanIds = await prisma.attendanceLog.findMany({
    where: { employeeId: null, ...(deviceId ? { deviceId } : {}) },
    distinct: ['zkUserId'],
    select: { zkUserId: true },
  });
  if (!orphanIds.length) {
    emit(io, 'relink:start', { reason: reason || null, employeeCount: 0 });
    const empty = { totalLinked: 0, employeesAffected: 0, affected: [], reason: reason || null };
    emit(io, 'relink:done', empty);
    return empty;
  }
  const orphanZkSet = new Set(orphanIds.map((r) => r.zkUserId));

  const employeeWhere = {
    NOT: { zkUserId: '' },
    zkUserId: { in: [...orphanZkSet] },
  };
  if (employeeId) employeeWhere.id = employeeId;

  // Phase 23.1: a zkUserId can now be shared by (one active + N stopped)
  // employees when a number is reused after termination. This loop claims
  // orphaned logs for a zkUserId on a first-come basis (the first employee
  // processed wins; later ones for the same zkUserId find count=0 and
  // no-op) — ordering active first ensures a genuinely orphaned live punch
  // for a reused number always attaches to whoever currently holds it, not
  // to whichever stopped historical row `findMany` happened to return first.
  const employees = await prisma.employee.findMany({
    where: employeeWhere,
    select: { id: true, name: true, code: true, zkUserId: true, status: true },
    orderBy: { status: 'desc' },
  });

  emit(io, 'relink:start', { reason: reason || null, employeeCount: employees.length });

  let totalLinked = 0;
  const affected = [];

  for (const emp of employees) {
    if (!emp.zkUserId) continue;

    const logsWhere = {
      zkUserId: emp.zkUserId,
      employeeId: null,
      ...(deviceId ? { deviceId } : {}),
    };

    const agg = await prisma.attendanceLog.aggregate({
      where: logsWhere,
      _min: { timestamp: true },
      _max: { timestamp: true },
      _count: { _all: true },
    });

    const count = agg._count._all;
    if (!count) continue;

    const result = await prisma.attendanceLog.updateMany({
      where: logsWhere,
      data: { employeeId: emp.id },
    });

    totalLinked += result.count;
    affected.push({
      employeeId: emp.id,
      name: emp.name,
      code: emp.code,
      zkUserId: emp.zkUserId,
      count: result.count,
      from: agg._min.timestamp,
      to: agg._max.timestamp,
    });

    logger.info(`[Relink] ${result.count} log(s) linked to employee #${emp.id} (${emp.name}, zkUserId=${emp.zkUserId})`);
  }

  // ── Regenerate attendance_daily + payroll for every affected employee/range ──
  for (const aff of affected) {
    try {
      if (aff.from && aff.to) {
        await recalcDateRangeForEmployee(aff.employeeId, aff.from, aff.to);
      }
    } catch (err) {
      logger.error(`[Relink] recalc failed for employee #${aff.employeeId}: ${err.message}`);
    }
    emit(io, 'relink:progress', {
      employeeId: aff.employeeId, name: aff.name, count: aff.count,
    });
  }

  const result = {
    totalLinked,
    employeesAffected: affected.length,
    affected: affected.map(a => ({
      employeeId: a.employeeId, name: a.name, code: a.code, zkUserId: a.zkUserId,
      count: a.count, from: a.from, to: a.to,
    })),
    reason: reason || null,
  };

  emit(io, 'relink:done', result);
  return result;
}

/**
 * Regenerate attendance_daily for every day in [from, to] for a single
 * employee, then recalc payroll for every month touched — even if the
 * employee is currently inactive (status:false), unlike recalcEngine.recalcScope
 * which only targets active employees.
 */
async function recalcDateRangeForEmployee(employeeId, from, to) {
  // Clamp to the valid punch window. Without this, a single garbage-dated log
  // (1999-epoch rows exist in this DB) that gets relinked would make this loop
  // walk day-by-day from 1999 → today: ~9,800 processDate calls + ~330 payroll
  // recalcs for ONE employee, occupying the sync pipeline for hours.
  const clamped = clampToValidRange(from, to);
  if (clamped.from.getTime() !== new Date(from).getTime() || clamped.to.getTime() !== new Date(to).getTime()) {
    logger.warn(
      `[TS-INVALID] relink recalc range clamped for employee #${employeeId}: ` +
      `${moment(from).format('YYYY-MM-DD')}→${moment(to).format('YYYY-MM-DD')} ` +
      `⇒ ${moment(clamped.from).format('YYYY-MM-DD')}→${moment(clamped.to).format('YYYY-MM-DD')}`
    );
  }
  const start = moment(clamped.from).startOf('day');
  const end = moment(clamped.to).endOf('day');

  let d = start.clone();
  while (d.isSameOrBefore(end)) {
    try {
      await attendanceEngine.processDate(d.toDate(), employeeId);
    } catch (err) {
      logger.error(`[Relink] processDate emp ${employeeId} ${d.format('YYYY-MM-DD')}: ${err.message}`);
    }
    d.add(1, 'day');
  }

  const months = new Set();
  const m = start.clone().startOf('month');
  while (m.isSameOrBefore(end)) {
    months.add(`${m.year()}-${m.month() + 1}`);
    m.add(1, 'month');
  }

  // C1: relinking is an automatic side-effect (newly-matched attendance logs
  // for this employee), not a direct edit of any Payroll row — a finalized/
  // paid month caught in this range must be protected, not silently
  // overwritten. Same canonical, batched check Phase 13.3 wired into
  // recalcEngine.recalcScope() and adjustments.js.
  const targets = [...months].map((key) => {
    const [year, month] = key.split('-').map(Number);
    return { employeeId, month, year };
  });
  const { allowed, protectedTargets } = await payrollEngine.filterProtectedPayrollTargets(targets);
  if (protectedTargets.length) {
    logger.warn(`[Relink] payroll SKIPPED (finalized/paid) emp ${employeeId}: ` +
      protectedTargets.map(t => `${t.month}/${t.year} (${t.status})`).join(', '));
  }
  for (const { month, year } of allowed) {
    try {
      await payrollEngine.calculatePayroll(employeeId, month, year);
    } catch (err) {
      logger.error(`[Relink] payroll emp ${employeeId} ${month}/${year}: ${err.message}`);
    }
  }
}

/**
 * Diagnostic view: for every distinct zkUserId present in attendance_logs,
 * report whether a matching Employee exists, plus linked/unlinked counts.
 */
async function getRelinkDiagnostics() {
  const distinctRows = await prisma.attendanceLog.findMany({
    distinct: ['zkUserId'],
    select: { zkUserId: true },
    orderBy: { zkUserId: 'asc' },
  });

  const employees = await prisma.employee.findMany({
    where: { NOT: { zkUserId: '' } },
    select: { id: true, name: true, code: true, zkUserId: true, status: true },
    orderBy: { status: 'asc' }, // Phase 23.1: active processed last, wins the Map.set overwrite for a reused number.
  });
  const empByZk = new Map(employees.map(e => [e.zkUserId, e]));

  const rows = [];
  let totalLinked = 0;
  let totalUnlinked = 0;

  for (const { zkUserId } of distinctRows) {
    const [linkedCount, unlinkedCount] = await Promise.all([
      prisma.attendanceLog.count({ where: { zkUserId, employeeId: { not: null } } }),
      prisma.attendanceLog.count({ where: { zkUserId, employeeId: null } }),
    ]);
    const emp = empByZk.get(zkUserId) || null;

    rows.push({
      zkUserId,
      employee: emp ? { id: emp.id, name: emp.name, code: emp.code, status: emp.status } : null,
      linkedCount,
      unlinkedCount,
      totalCount: linkedCount + unlinkedCount,
    });

    totalLinked += linkedCount;
    totalUnlinked += unlinkedCount;
  }

  // Unlinked-first, then by total volume — surfaces the most actionable rows first
  rows.sort((a, b) => {
    if (!!a.employee !== !!b.employee) return a.employee ? 1 : -1;
    return b.unlinkedCount - a.unlinkedCount;
  });

  return {
    rows,
    summary: {
      totalZkUserIds: rows.length,
      linkedZkUserIds: rows.filter(r => r.employee).length,
      unlinkedZkUserIds: rows.filter(r => !r.employee).length,
      totalLinkedLogs: totalLinked,
      totalUnlinkedLogs: totalUnlinked,
    },
  };
}

module.exports = { relinkAttendanceLogs, getRelinkDiagnostics, recalcDateRangeForEmployee };
