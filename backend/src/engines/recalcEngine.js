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
const crypto = require('crypto');
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

// Every recalculation run carries a unique id. It is added (compatibly) to recalc:start / :progress /
// :done / :failed so a client can tell WHICH run an event belongs to instead of guessing by order.
const newRunId = () => crypto.randomUUID();

/**
 * Re-run attendance + payroll calculation for every active employee matching
 * the given scope, across every day in [from, to].
 *
 * `recalcRunId` (optional) lets the debounced scheduler hand in the id it already gave to callers; when
 * omitted a fresh one is generated. Any throw emits one recalc:failed (id only — never error text) and
 * is rethrown unchanged, so HTTP callers keep their existing error handling.
 */
async function recalcScope(opts = {}) {
  const recalcRunId = opts.recalcRunId || newRunId();
  try {
    return await recalcScopeImpl({ ...opts, recalcRunId });
  } catch (err) {
    emit(opts.io, 'recalc:failed', { recalcRunId, at: new Date().toISOString() });
    if (err && typeof err === 'object') err.recalcFailedEmitted = true;
    throw err;
  }
}

async function recalcScopeImpl({ from, to, branchId, departmentId, employeeId, employeeIds, io, reason, allowFinalizedPayroll = false, recalcRunId } = {}) {
  const start = moment(from).startOf('day');
  // Phase 23.4: a day that hasn't happened yet has no attendance to compute —
  // same invariant attendanceEngine.processMonth() already enforces (EF-005.4)
  // but this engine never had. Without this clamp, any caller passing a `to`
  // at or past month-end (e.g. recalcCurrentAndFuture()'s currentMonthRange())
  // walks attendanceEngine.processDate() across future dates, writing
  // synthetic "absent" AttendanceDaily rows for days that haven't occurred —
  // confirmed live: a single global rule toggle produced 2,224 such rows
  // across 106 employees in one run. This is the ONE shared recalc entry
  // point (rules.js, holidays.js, cleanup.js's cascade, and every
  // recalcCurrentAndFuture() caller all funnel through here), so clamping
  // once here — rather than in each caller — closes the gap everywhere at once.
  const end = moment.min(moment(to).endOf('day'), moment().endOf('day'));

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
  let attendanceFailed = 0;

  emit(io, 'recalc:start', {
    recalcRunId,
    employeeCount: employees.length, dayCount, reason: reason || null,
    from: start.format('YYYY-MM-DD'), to: end.format('YYYY-MM-DD'),
  });

  for (const emp of employees) {
    let d = start.clone();
    while (d.isSameOrBefore(end)) {
      try { await attendanceEngine.processDate(d.toDate(), emp.id); }
      catch (err) { attendanceFailed++; logger.error(`recalc attendance emp ${emp.id} ${d.format('YYYY-MM-DD')}: ${err.message}`); }
      done++;
      if (done % 10 === 0) emit(io, 'recalc:progress', { done, total, recalcRunId });
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

  // C1 canonical safety boundary: this cascade (rule change, holiday change,
  // or a manual "recalculate-full") is a side-effect of something unrelated
  // to any one Payroll row, so it must never silently overwrite a
  // finalized/paid row — see payrollEngine.filterProtectedPayrollTargets()
  // for the full rationale. One batched query for the whole employee×month
  // scope, evaluated fresh right before the write loop below (not from any
  // earlier/stale data), then every protected target is skipped while every
  // other target still recalculates normally — a finalized payroll for one
  // employee never blocks or contaminates the recalc of the rest of scope.
  //
  // `allowFinalizedPayroll` is an explicit opt-out for the ONE caller that
  // already has its own equivalent, stronger gate: cleanup.js's /execute
  // re-validates finalized/paid exposure itself and returns HTTP 409 unless
  // the admin explicitly sent confirmFinalizedPayroll:true — by the time
  // THAT caller reaches this function, the confirm-then-allow decision has
  // already been made, so skipping here would silently contradict an
  // explicit confirmation the admin already gave. Every other caller
  // (rules.js, holidays.js) has no such confirmation step, so they get the
  // protective default.
  const targets = [];
  for (const emp of employees) {
    for (const key of months) {
      const [year, month] = key.split('-').map(Number);
      targets.push({ employeeId: emp.id, month, year });
    }
  }
  const { allowed, protectedTargets } = allowFinalizedPayroll
    ? { allowed: targets, protectedTargets: [] }
    : await payrollEngine.filterProtectedPayrollTargets(targets);
  if (protectedTargets.length) {
    logger.warn(`recalc SKIPPED ${protectedTargets.length} finalized/paid payroll target(s): ` +
      protectedTargets.map(t => `emp=${t.employeeId} ${t.month}/${t.year} (${t.status})`).join(', '));
  }

  // Perf Batch 2: same preload pattern calculateMonthlyPayroll() uses — one
  // bounded batch (rules once for the whole employee set, then 4 queries per
  // DISTINCT month touched by `allowed`, never per employee) ahead of the
  // loop below, instead of this loop's original per-employee/per-month
  // query repeats. `employees` (fetched once above, full rows) already
  // covers every employeeId in `allowed`. The loop itself is untouched:
  // still strictly sequential, still one calculatePayroll() call at a time
  // in the same order, still individually lock-guarded — only the data each
  // call is handed changes, not when or how many run.
  const preloadMap = await payrollEngine.buildPayrollPreloadMap(allowed, employees);

  let payrollRecalculated = 0;
  let payrollFailed = 0;
  for (const { employeeId, month, year } of allowed) {
    try {
      const preload = preloadMap.get(`${employeeId}|${month}|${year}`);
      await payrollEngine.calculatePayroll(employeeId, month, year, { preload });
      payrollRecalculated++;
    }
    catch (err) { payrollFailed++; logger.error(`recalc payroll emp ${employeeId} ${month}/${year}: ${err.message}`); }
  }

  const result = {
    employeeCount: employees.length, dayCount, reason: reason || null,
    from: start.format('YYYY-MM-DD'), to: end.format('YYYY-MM-DD'),
    // C1: finalized/paid targets this run protected instead of overwriting.
    protectedPayroll: protectedTargets,
    // Additive: actual payroll rows recomputed / failed by this run (protected rows are in neither).
    payrollRecalculated, payrollFailed,
    // Additive: employee-days whose attendance recompute threw (logged, run continued).
    attendanceFailed,
    recalcRunId,
  };
  emit(io, 'recalc:done', result);
  return result;
}

/** Convenience wrapper — the auto-recalc scope: current month only. */
function recalcCurrentAndFuture({ branchId, departmentId, employeeId, io, reason, recalcRunId } = {}) {
  const { start, end } = currentMonthRange();
  return recalcScope({
    from: start.toDate(),
    to: end.toDate(),
    branchId, departmentId, employeeId, io, reason, recalcRunId,
  });
}

// ─── Debounce queue — coalesce rapid successive triggers into one run ────────
let timer = null;
let queue = [];

// Id of the run the CURRENT pending queue will become. Every caller that joins the same debounce window
// is handed the same id (they share one flush); it is consumed when flush() takes the queue, so a caller
// arriving while that flush is already running gets a NEW id for the next flush.
let pendingRunId = null;

/**
 * Debounced, coalescing recalc request. Returns the `recalcRunId` of the run that will cover this
 * request (also carried by its recalc:start/done/failed events), or null for a scoped (branch /
 * department / employee) request: scoped requests are executed as independent runs with their own ids.
 */
function scheduleRecalc(scope = {}, io, reason) {
  queue.push({ branchId: scope.branchId, departmentId: scope.departmentId, employeeId: scope.employeeId, reason });
  if (!pendingRunId) pendingRunId = newRunId();
  const isGlobalCall = !scope.branchId && !scope.departmentId && !scope.employeeId;
  const runId = isGlobalCall ? pendingRunId : null;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    flush(io).catch(err => logger.error(`recalc flush: ${err.message}`));
  }, DEBOUNCE_MS);
  return runId;
}

async function flush(io) {
  const items = queue;
  const runId = pendingRunId;
  queue = [];
  pendingRunId = null;
  timer = null;
  if (!items.length) return;

  const reason = [...new Set(items.map(i => i.reason).filter(Boolean))].join('، ');
  // A "global" edit (no branch/dept/employee scope) requires recalculating everyone.
  const isGlobal = items.some(i => !i.branchId && !i.departmentId && !i.employeeId);

  try {
    if (isGlobal) {
      // The one run that covers every caller handed `runId` above.
      await recalcCurrentAndFuture({ io, reason, recalcRunId: runId });
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
  } catch (err) {
    // recalcScope already emitted recalc:failed for its own run; this covers a failure before any run
    // existed, so the id handed to callers always reaches a terminal event. Id only — no error text.
    if (!err || !err.recalcFailedEmitted) emit(io, 'recalc:failed', { recalcRunId: runId, at: new Date().toISOString() });
    throw err;
  }
}

module.exports = {
  recalcScope, recalcCurrentAndFuture, scheduleRecalc,
};
