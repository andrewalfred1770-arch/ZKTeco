/**
 * recalcEngine.js — Rule-change Recalculation Engine.
 *
 * When a rule (or anything that feeds the rules — policies, holidays,
 * advances) is created/updated/deleted, the values stored in
 * `AttendanceDaily`/`Payroll` go stale. This engine re-runs the existing
 * `attendanceEngine.processDate` + `payrollEngine.calculatePayroll` for the
 * affected employees/date-range so stored data reflects the new rule
 * immediately — no manual "احتساب المرتبات" click needed.
 *
 * Scope policy (confirmed with the user): auto-recalc covers the CURRENT
 * month only (the data that's actively being worked on). A full-history
 * recalc is available on demand via `recalcScope({ from, to })` from the
 * `POST /api/rules/recalculate-full` route.
 *
 * Rapid successive edits (e.g. typing in a number field, bulk toggles) are
 * coalesced via a short debounce queue so one logical change = one recalc run.
 */
const { getPrisma } = require('../utils/prisma');
const moment = require('moment');
const attendanceEngine = require('./attendanceEngine');
const payrollEngine = require('./payrollEngine');
const { currentMonthRange } = require('../utils/monthRange');
const logger = require('../utils/logger');

const prisma = getPrisma();
const DEBOUNCE_MS = 2000;

function emit(io, event, payload) {
  if (io) io.emit(event, payload);
}

/**
 * Re-run attendance + payroll calculation for every active employee matching
 * the given scope, across every day in [from, to].
 */
async function recalcScope({ from, to, branchId, departmentId, employeeId, employeeIds, io, reason } = {}) {
  const start = moment(from).startOf('day');
  const end = moment(to).endOf('day');

  const employees = await prisma.employee.findMany({
    where: {
      status: true,
      ...(employeeIds ? { id: { in: employeeIds } } : {}),
      ...(employeeId ? { id: employeeId } : {}),
      ...(branchId ? { branchId } : {}),
      ...(departmentId ? { departmentId } : {}),
    },
  });

  const dayCount = end.diff(start, 'days') + 1;
  const total = employees.length * Math.max(dayCount, 1);
  let done = 0;

  emit(io, 'recalc:start', {
    employeeCount: employees.length, dayCount, reason: reason || null,
    from: start.format('YYYY-MM-DD'), to: end.format('YYYY-MM-DD'),
  });

  for (const emp of employees) {
    let d = start.clone();
    while (d.isSameOrBefore(end)) {
      try { await attendanceEngine.processDate(d.toDate(), emp.id); }
      catch (err) { logger.error(`recalc attendance emp ${emp.id} ${d.format('YYYY-MM-DD')}: ${err.message}`); }
      done++;
      if (done % 10 === 0) emit(io, 'recalc:progress', { done, total });
      d.add(1, 'day');
    }
  }

  // Re-run payroll for every month touched by the range.
  const months = new Set();
  const m = start.clone().startOf('month');
  while (m.isSameOrBefore(end)) {
    months.add(`${m.year()}-${m.month() + 1}`);
    m.add(1, 'month');
  }

  for (const emp of employees) {
    for (const key of months) {
      const [year, month] = key.split('-').map(Number);
      try { await payrollEngine.calculatePayroll(emp.id, month, year); }
      catch (err) { logger.error(`recalc payroll emp ${emp.id} ${month}/${year}: ${err.message}`); }
    }
  }

  const result = {
    employeeCount: employees.length, dayCount, reason: reason || null,
    from: start.format('YYYY-MM-DD'), to: end.format('YYYY-MM-DD'),
  };
  emit(io, 'recalc:done', result);
  return result;
}

/** Convenience wrapper — the auto-recalc scope: current month only. */
function recalcCurrentAndFuture({ branchId, departmentId, employeeId, io, reason } = {}) {
  const { start, end } = currentMonthRange();
  return recalcScope({
    from: start.toDate(),
    to: end.toDate(),
    branchId, departmentId, employeeId, io, reason,
  });
}

// ─── Debounce queue — coalesce rapid successive triggers into one run ────────
let timer = null;
let queue = [];

function scheduleRecalc(scope = {}, io, reason) {
  queue.push({ branchId: scope.branchId, departmentId: scope.departmentId, employeeId: scope.employeeId, reason });
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { flush(io).catch(err => logger.error(`recalc flush: ${err.message}`)); }, DEBOUNCE_MS);
}

async function flush(io) {
  const items = queue;
  queue = [];
  timer = null;
  if (!items.length) return;

  const reason = [...new Set(items.map(i => i.reason).filter(Boolean))].join('، ');
  // A "global" edit (no branch/dept/employee scope) requires recalculating everyone.
  const isGlobal = items.some(i => !i.branchId && !i.departmentId && !i.employeeId);

  if (isGlobal) {
    await recalcCurrentAndFuture({ io, reason });
    return;
  }

  const seen = new Set();
  for (const it of items) {
    const key = `${it.branchId || ''}|${it.departmentId || ''}|${it.employeeId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await recalcCurrentAndFuture({
      branchId: it.branchId, departmentId: it.departmentId, employeeId: it.employeeId, io, reason,
    });
  }
}

module.exports = {
  recalcScope, recalcCurrentAndFuture, scheduleRecalc,
};
