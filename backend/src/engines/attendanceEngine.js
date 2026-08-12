const { getPrisma } = require('../utils/prisma');
const moment = require('moment');
const { getRules, parseTime, isWeekend, isHoliday } = require('./rulesEngine');
const {
  calcMorningOT, calcEveningOT, calcLatePenalty, calcEarlyCheckout, calcOvertimeUnits,
  timeToMinutes, hoursWithTolerance,
} = require('./policyEngine');
const { monthRangeMoment } = require('../utils/monthRange');

/**
 * Convert DB-stored time-based rule tiers to the absolute-minute format that
 * calcLatePenalty / calcEarlyCheckout expect.
 *
 * DB format  : [{fromTime:"09:21", toTime:"09:35", units:1}, ...]
 * Engine fmt : [{fromMinute:561, toMinute:575, deductionUnits:1}, ...]
 *
 * Returns null when the raw string is empty / invalid — callers fall through
 * to DEFAULT_LATE_RULES / DEFAULT_EARLY_CHECKOUT_RULES (policyEngine defaults).
 */
function parseTimeRules(raw) {
  if (!raw) return null;
  try {
    const tiers = JSON.parse(raw);
    if (!Array.isArray(tiers) || tiers.length === 0) return null;
    return tiers.map(t => ({
      fromMinute:     timeToMinutes(t.fromTime || '00:00'),
      toMinute:       timeToMinutes(t.toTime   || '23:59'),
      deductionUnits: Number(t.units ?? 0),
    }));
  } catch { return null; }
}
const logger = require('../utils/logger');

const prisma = getPrisma();

// ─── Parse time from DateTime to HH:MM ───────────────────────────────────────
function toHHMM(dt) {
  if (!dt) return null;
  const h = dt.getHours();
  const m = dt.getMinutes();
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

// ─── Manual-edit precedence ───────────────────────────────────────────────────
// A daily row with manualEdit=true is HR-authoritative: inline grid edits
// (PUT /attendance/daily/:id) and approved adjustments both set it. The engine
// must never silently overwrite such a row — not from the cron, not from a
// recovery sync, not from a relink/recalc. Manual wins until HR reverts it.
async function isManuallyEdited(employeeId, dateStr) {
  const existing = await prisma.attendanceDaily.findUnique({
    where: { employeeId_date: { employeeId, date: new Date(dateStr) } },
    select: { manualEdit: true },
  });
  return !!existing?.manualEdit;
}

// ─── Process a single employee's attendance for a single date ─────────────────
// opts.manual — manual-override mode used by PUT /attendance/daily/:id:
//   { checkIn?: Date|null, checkOut?: Date|null, status?: string }
// In manual mode the provided times REPLACE the log-derived first/last punch,
// all derived fields (worked/late/OT/penalties) are recomputed with the same
// policy math (deterministic, internally consistent row), the weekend/holiday
// short-circuit is skipped (manual times on a weekend mean the employee really
// worked), and the row is written with manualEdit=true so no automatic path
// ever overwrites it again.
async function processDateImpl(date, employeeId, opts = {}) {
  const dateStr = moment(date).format('YYYY-MM-DD');
  const manual = opts.manual || null;

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
  });
  if (!employee) return null;

  if (!manual && await isManuallyEdited(employeeId, dateStr)) {
    logger.info(`[MANUAL-EDIT] preserved: employee=${employeeId} date=${dateStr} — engine recompute skipped (manualEdit=true)`);
    logger.info(`[REBUILD-SKIP-MANUAL] employee=${employeeId} date=${dateStr} — row frozen by manual edit`);
    return null;
  }

  // ── Weekend / Holiday check ─────────────────────────────────────────────────
  const legacyRules = await getRules(employee.branchId, employee.departmentId, employee.id);
  const dayDate = new Date(dateStr);
  const dayOfWeek = dayDate.getDay(); // 0=Sun .. 5=Fri, 6=Sat
  // friday_is_weekend: ONLY governs whether Friday is a non-working day for
  // attendance/payroll working-day counts. Company policy (2026-06): Friday is
  // a special overtime workday, NOT a closed holiday — so this defaults to
  // false. Saturday has no special flag; it is governed purely by weekend_days
  // (default '' — no automatic weekly off-day).
  const fridayIsWeekend = (legacyRules.friday_is_weekend ?? 'false') === 'true';
  const configuredWeekend = isWeekend(dayDate, legacyRules.weekend_days);
  const weekend = configuredWeekend || (fridayIsWeekend && dayOfWeek === 5);
  const holiday = await isHoliday(dayDate, employee.branchId);

  if (dayOfWeek === 5) {
    logger.info(`[WEEKEND-RULE] employee=${employeeId} date=${dateStr} Friday: friday_is_weekend=${fridayIsWeekend}, weekend_days="${legacyRules.weekend_days}" → weekend=${weekend}${weekend ? '' : ' — treated as special overtime workday'}`);
  } else if (dayOfWeek === 6) {
    logger.info(`[WEEKEND-RULE] employee=${employeeId} date=${dateStr} Saturday: weekend_days="${legacyRules.weekend_days}" → weekend=${weekend}${weekend ? '' : ' — treated as normal workday'}`);
  }

  // ── Fetch raw logs ───────────────────────────────────────────────────────────
  // Attendance is now fully dynamic — driven only by check-in / check-out punches.
  // Logs are fetched BEFORE the weekend/holiday check so that punches on a
  // non-working day (Friday overtime, holiday work) are never silently discarded.
  const startOfDay = new Date(`${dateStr}T00:00:00`);
  const endOfDay   = new Date(`${dateStr}T23:59:59`);

  if ((weekend || holiday) && !manual) {
    // Peek at logs — if none, mark as non-working day and stop.
    // If punches exist, fall through and process hours + OT (penalties zeroed below).
    const punchCount = await prisma.attendanceLog.count({
      where: { employeeId, isDuplicate: false, timestamp: { gte: startOfDay, lte: endOfDay } },
    });
    if (punchCount === 0) {
      logger.info(`[RULE-MATCH] employee=${employeeId} date=${dateStr} → status=${weekend ? 'weekend' : 'holiday'} (skipping punch processing)`);
      await upsertDaily(employeeId, dateStr, {
        isWeekend: weekend, isHoliday: holiday,
        status: weekend ? 'weekend' : 'holiday',
        absenceType: null,
        penaltyDays: null,
      });
      return;
    }
    logger.info(`[WEEKEND-PUNCH] employee=${employeeId} date=${dateStr} ${weekend ? 'weekend' : 'holiday'} — ${punchCount} punch(es) found, computing hours + OT, zeroing penalties`);
  }

  const logs = await prisma.attendanceLog.findMany({
    where: {
      employeeId,
      isDuplicate: false,
      timestamp: { gte: startOfDay, lte: endOfDay },
    },
    orderBy: { timestamp: 'asc' },
  });

  // ── Classify punches against the check-in window ────────────────────────────
  // checkin_window_start/end (default 05:00–12:00): only a punch whose
  // time-of-day falls inside this window may become checkIn. A punch outside
  // the window (before it opens or after it closes) can ONLY be a checkOut —
  // it must never be promoted to checkIn, even if it is the only punch of the day.
  const checkinWindowStartMin = parseTime(legacyRules.checkin_window_start || '05:00');
  const checkinWindowEndMin   = parseTime(legacyRules.checkin_window_end   || '12:00');
  const windowLabel = `${legacyRules.checkin_window_start || '05:00'}-${legacyRules.checkin_window_end || '12:00'}`;
  const inCheckinWindow = (ts) => {
    const m = ts.getHours() * 60 + ts.getMinutes();
    return m >= checkinWindowStartMin && m <= checkinWindowEndMin;
  };

  let logCheckIn = null;
  let logCheckOut = null;

  if (logs.length > 0) {
    const checkInLog = logs.find((l) => inCheckinWindow(l.timestamp));
    const lastLog = logs[logs.length - 1];

    if (checkInLog) {
      logCheckIn = checkInLog.timestamp;
      if (lastLog.id !== checkInLog.id) {
        logCheckOut = lastLog.timestamp;
        logger.info(`[PUNCH-CLASSIFY] employee=${employeeId} date=${dateStr} [RULE-MATCH] checkin-window(${windowLabel}): checkIn=${toHHMM(logCheckIn)} checkOut=${toHHMM(logCheckOut)}`);
      } else {
        logger.info(`[SINGLE-PUNCH] employee=${employeeId} date=${dateStr} only punch=${toHHMM(logCheckIn)} is within check-in window(${windowLabel}) → checkIn set, [MISSING-CHECKOUT]`);
      }
      for (const l of logs) {
        if (l.id !== checkInLog.id && l.id !== lastLog.id && !inCheckinWindow(l.timestamp)) {
          logger.info(`[INVALID-WINDOW] employee=${employeeId} date=${dateStr} punch=${toHHMM(l.timestamp)} outside check-in window(${windowLabel}) and not the last punch — ignored`);
        }
      }
    } else {
      // No punch falls inside the check-in window — every punch today is
      // checkout/departure only (per policy: punches after 12:00 PM are never checkIn).
      logCheckOut = lastLog.timestamp;
      logger.info(`[MISSING-CHECKIN] employee=${employeeId} date=${dateStr} [RULE-FALLBACK] no punch within check-in window(${windowLabel}) — last punch ${toHHMM(logCheckOut)} classified as checkOut only, checkIn=null`);
    }
  }

  // Manual override takes precedence over log-derived punches. An explicitly
  // provided key (even null) wins; an absent key falls back to the logs.
  const effCheckIn = manual && 'checkIn' in manual
    ? manual.checkIn
    : logCheckIn;
  const effCheckOut = manual && 'checkOut' in manual
    ? manual.checkOut
    : logCheckOut;

  // Absent ONLY when there is no punch at all (no checkIn AND no checkOut).
  // A single punch of either kind — checkIn-only or checkOut-only — means the
  // employee was physically present that day, so status must be 'present'
  // (with the missing side reflected by the null checkIn/checkOut field, not
  // by the status). See canonical business rule, EP business-rule audit.
  if (!effCheckIn && !effCheckOut) {
    const absentStatus = weekend ? 'weekend' : holiday ? 'holiday' : 'absent';
    // Phase 19.1 fix: `status` already correctly honored a manual override
    // (manual?.status || absentStatus) but `isAbsent` previously did NOT —
    // it was computed only from the real weekend/holiday calendar flags,
    // completely ignoring manual.status. That let HR mark a day's status
    // 'holiday' (or 'present'/'late'/etc.) via the "الحالة" dropdown
    // (PUT /attendance/daily/:id, no checkIn/checkOut touched) while the
    // stored row silently kept isAbsent=true underneath — a contradictory
    // status='holiday' + isAbsent=true row that every downstream absence
    // count (attendance summaries, payroll's absentDays) still counted as a
    // real absence despite displaying as a holiday. finalStatus now drives
    // BOTH fields consistently, matching the same "manual status decides
    // isAbsent" pattern already used elsewhere in this file (see
    // computeDerivedFields's finalIsAbsent below). isWeekend/isHoliday
    // themselves are untouched — still sourced only from the real
    // calendar/Holiday-table lookup above, never from a manual override, so
    // this cannot fabricate a fake official-holiday record.
    const finalStatus = manual?.status || absentStatus;
    const isAbsentFinal = finalStatus === 'absent';
    if (!manual) {
      logger.info(`[RULE-MATCH] employee=${employeeId} date=${dateStr} → status=${absentStatus} (no punches)`);
    }
    await upsertDaily(employeeId, dateStr, {
      isAbsent: isAbsentFinal, status: finalStatus,
      isWeekend: weekend, isHoliday: holiday,
      totalDeductionUnits: 0,
      ...(manual ? { manualEdit: true } : {}),
    });
    if (manual) logger.info(`[MANUAL-EDIT] applied (absent): employee=${employeeId} date=${dateStr}`);
    return;
  }

  // ── Extract first/last punch (or manual overrides) ──────────────────────────
  // Either side may still be null here (checkIn-only or checkOut-only) —
  // computeDerivedFields is null-safe for both and yields status='present'.
  const checkIn  = effCheckIn;
  const checkOut = effCheckOut;

  const fields = await computeDerivedFields(employee, dateStr, {
    checkIn, checkOut, weekend, holiday, dayOfWeek, manual, legacyRules,
  });

  // Non-working day with punches: zero all penalties; all worked hours = OT.
  // On a non-working day there is no regular shift window to subtract, so the
  // morning/evening OT split is irrelevant — every worked minute is overtime.
  // status stays 'weekend'/'holiday' so payroll applies friday_ot_multiplier.
  // Applies to BOTH automatic (fingerprint) and manual (HR-entered) check
  // in/out — a weekly holiday has no mandatory shift regardless of how the
  // punch was recorded, so manual attendance on that day must follow the
  // exact same all-worked-hours-are-overtime, no-penalty rule.
  if (weekend || holiday) {
    fields.latePenaltyUnits    = 0;
    fields.earlyCheckoutUnits  = 0;
    fields.totalDeductionUnits = 0;
    fields.lateMinutes         = 0;
    fields.earlyLeaveMinutes   = 0;
    fields.isAbsent            = false;
    fields.status              = weekend ? 'weekend' : 'holiday';
    fields.absenceType         = null;
    fields.penaltyDays         = null;

    // All worked hours count as overtime (no shift window to exclude) — this
    // eligibility scope (whole worked duration vs weekday's excess-past-shift-end)
    // is the documented, intentional business policy and is unchanged here.
    // Rounding of the trailing partial hour now uses the same tolerance-then-floor
    // treatment as calcMorningOT/calcEveningOT (hoursWithTolerance), so identical
    // overtime-eligible minutes are credited identically regardless of weekday vs
    // weekend/holiday — previously this path floored with no tolerance, silently
    // under-crediting a trailing partial hour relative to the weekday paths.
    const otMinimumMin = parseFloat(legacyRules.overtime_minimum || '0');
    const otCapHours   = parseFloat(legacyRules.overtime_cap_hours || '0');
    const workedMin    = fields.workedMinutes || 0;
    let allDayOT = workedMin >= otMinimumMin ? hoursWithTolerance(workedMin, 10) : 0;
    if (otCapHours > 0 && allDayOT > otCapHours) allDayOT = otCapHours;
    fields.overtimeHours        = allDayOT;
    fields.overtimeMinutes      = allDayOT * 60;
    fields.morningOvertimeHours = 0;
    fields.eveningOvertimeHours = 0;
    fields.overtimeRulesUnits   = null; // fall back to overtimeHours in payroll
  }

  await upsertDaily(employeeId, dateStr, {
    ...fields,
    ...(manual ? { manualEdit: true } : {}),
  });
  if (manual) {
    logger.info(
      `[MANUAL-EDIT] applied: employee=${employeeId} date=${dateStr} ` +
      `checkIn=${toHHMM(checkIn) || '—'} checkOut=${toHHMM(checkOut) || '—'} status=${manual.status || fields.status} — derived fields recomputed, row locked (manualEdit=true)`
    );
  }
}

// ─── Certification HIGH#6: per-employee-date serialization lock ────────────────
// Root cause (proven via a controlled reversible test against real
// processDate()/upsertDaily(), then fully reverted): two concurrent
// processDate() calls for the SAME employeeId+date (e.g. historicalRebuildService
// vs realtimeListenerService) each independently read AttendanceLog, compute,
// and upsert — with no coordination. Reproduced two real failure modes: (1) a
// Prisma P2002 unique-constraint crash when both calls race to CREATE a row
// that doesn't exist yet (the loser's entire computation is discarded, caught
// by the caller's try/catch, logged, never retried); (2) a silent last-write-
// wins overwrite when a row already exists (no exception — whichever upsert
// commits last wins, even if its read was based on a stale/incomplete punch
// snapshot).
//
// In-process only (a JS Map, not a DB-level advisory lock) — matches the
// existing lock philosophy already used elsewhere in this file/codebase
// (activeRebuild in historicalRebuildService.js, syncLocks in
// zktecoService.js, processTodayRunning below) for this codebase's actual
// deployment topology (a single embedded backend process). Verified via
// exhaustive search that no existing mutex/queue/advisory-lock/transaction
// already serializes processDate() calls by employeeId+date — this is a new,
// narrowly-scoped, additive lock, not a duplicate of existing infrastructure.
//
// Unlike this codebase's other locks (which are claim-or-skip), this is a
// queue-and-wait mutex — a caller for an already-locked key waits for its
// turn rather than being dropped — because dropping a real attendance
// recompute silently is worse than a bounded wait. A LOCK_ACQUIRE_TIMEOUT_MS
// ceiling prevents an indefinite wait if a holder hangs; on timeout the
// waiting call proceeds anyway (fail-open, logged) rather than starving
// forever, consistent with this codebase's existing fail-open error handling.
const dateKeyLocks = new Map(); // "employeeId|dateStr" -> { tail: Promise, token: object }
const LOCK_ACQUIRE_TIMEOUT_MS = 15000;

async function withEmployeeDateLock(employeeId, dateStr, fn) {
  const key = `${employeeId}|${dateStr}`;
  const entry = dateKeyLocks.get(key);
  const previousTail = entry ? entry.tail : Promise.resolve();

  let markDone;
  const ourCompletion = new Promise((resolve) => { markDone = resolve; });
  const ourTail = previousTail.then(() => ourCompletion, () => ourCompletion);
  const token = {};
  dateKeyLocks.set(key, { tail: ourTail, token });

  let timedOut = false;
  await Promise.race([
    previousTail.catch(() => {}),
    new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(); }, LOCK_ACQUIRE_TIMEOUT_MS)),
  ]);
  if (timedOut) {
    logger.error(`[DATE-LOCK] timeout after ${LOCK_ACQUIRE_TIMEOUT_MS}ms waiting for employee=${employeeId} date=${dateStr} — proceeding without serialization (fail-open)`);
  }

  try {
    return await fn();
  } finally {
    markDone();
    // Only remove the map entry if nobody has queued behind us since.
    const current = dateKeyLocks.get(key);
    if (current && current.token === token) dateKeyLocks.delete(key);
  }
}

// ─── Public entry point — unchanged signature/behavior, now serialized ─────────
// Thin wrapper: computes the same dateStr processDateImpl always computed
// first, then runs the entire existing implementation inside the lock. No
// business logic, formula, or computed value is touched — this only changes
// the ordering guarantee when two calls for the same employee+date overlap.
async function processDate(date, employeeId, opts = {}) {
  const dateStr = moment(date).format('YYYY-MM-DD');
  return withEmployeeDateLock(employeeId, dateStr, () => processDateImpl(date, employeeId, opts));
}

// ─── Pure derivation — checkIn/checkOut + context → full computed-fields object ─
// Extracted from processDate so the manual-edit preview endpoint (POST
// /attendance/daily/:id/preview) can compute "what would this row look like"
// without writing to the DB. Returns exactly the fields object processDate
// passes to upsertDaily (minus manualEdit, which the caller adds).
async function computeDerivedFields(employee, dateStr, { checkIn, checkOut, weekend, holiday, dayOfWeek, manual, legacyRules }) {
  const employeeId = employee.id;

  const checkInStr  = toHHMM(checkIn);
  const checkOutStr = toHHMM(checkOut);
  const checkInMin  = checkIn
    ? checkIn.getHours() * 60 + checkIn.getMinutes()
    : null;
  const checkOutMin = checkOut
    ? checkOut.getHours() * 60 + checkOut.getMinutes()
    : null;

  // Shift config — driven by global attendance rules (work_start / work_end).
  // Late / early-leave rules stored in DB as {fromTime,toTime,units} tiers.
  // parseTimeRules() converts HH:MM → absolute minutes for calcLatePenalty/calcEarlyCheckout.
  // Empty → falls back to DEFAULT_LATE_RULES / DEFAULT_EARLY_CHECKOUT_RULES.
  const lateAbsRules  = parseTimeRules(legacyRules.late_rules)  || [];
  const earlyAbsRules = parseTimeRules(legacyRules.early_rules) || [];

  // RESERVED for a future release: type='overtime' PenaltyRule tiers (graduated
  // checkout-time → bonus units, see policyEngine.calcOvertimeUnits) have no data
  // model/UI to populate them yet, so this is always empty and calcOvertimeUnits
  // always returns null → overtimeRulesUnits falls back to the hour-based
  // overtimeHours below (unchanged current behavior). Not exposed in any UI today.
  const penaltyRules = [];
  const policyConfig = {
    shiftStartTime: legacyRules.work_start || '09:00',
    shiftEndTime:   legacyRules.work_end   || '17:00',
    morningOTStart: '06:00',
    eveningOTEnd:   '23:59',
    otToleranceMin: 10,
  };

  // ── Work reference times — from global rules (work_start / work_end) ─────────
  const workStartMin = timeToMinutes(policyConfig.shiftStartTime || '09:00');
  const workEndMin   = timeToMinutes(policyConfig.shiftEndTime   || '17:00');

  // ── Shift-relative deduction fields ─────────────────────────────────────────
  // No checkIn → no late calculation is possible (there is nothing to compare
  // against work_start); lateMinutes stays 0 and status is never 'late'.
  const lateMinutes = checkInMin !== null ? Math.max(0, checkInMin - workStartMin) : 0;
  const earlyLeaveMinutes = (checkOutMin !== null && checkOutMin < workEndMin)
    ? workEndMin - checkOutMin : 0;
  // early_leave_grace: minutes tolerated before an early checkout counts as a violation
  const earlyLeaveGraceMin = parseInt(legacyRules.early_leave_grace) || 0;
  const earlyLeaveExceedsGrace = earlyLeaveMinutes > earlyLeaveGraceMin;
  // Worked duration requires BOTH punches — a single-sided punch (missing
  // checkIn or missing checkOut) has no measurable duration.
  const rawWorkedMinutes = (checkIn && checkOut)
    ? Math.round((checkOut.getTime() - checkIn.getTime()) / 60000)
    : 0;

  // Worked minutes = actual punch duration (no break deduction — removed 2026-06-22)
  const workedMinutes = Math.max(0, rawWorkedMinutes);
  // OT start = configured work_end (falls back to overtime_start rule, then 17:00).
  const effectiveOTStart = policyConfig.shiftEndTime || legacyRules.overtime_start || '17:00';
  const eveningPolicyConfig = { ...policyConfig, shiftEndTime: effectiveOTStart };

  let morningOT = checkInMin !== null ? calcMorningOT(checkInMin, policyConfig) : 0;
  let eveningOT = checkOutMin !== null ? calcEveningOT(checkOutMin, eveningPolicyConfig) : 0;

  // overtime_minimum: discard overtime below the configured floor (in minutes)
  const otMinimumMin = parseFloat(legacyRules.overtime_minimum || '0');
  if ((morningOT + eveningOT) * 60 < otMinimumMin) { morningOT = 0; eveningOT = 0; }

  // overtime_cap_hours: clamp daily overtime at the configured ceiling (0 = no cap)
  const otCapHours = parseFloat(legacyRules.overtime_cap_hours || '0');
  if (otCapHours > 0 && (morningOT + eveningOT) > otCapHours) {
    eveningOT = Math.max(0, otCapHours - morningOT);
  }

  // Single path: Grace (status only) → Late Rules tier table → Penalty.
  // `late_limit` is DEPRECATED and intentionally never read here — it used to
  // duplicate/conflict with the Late Rules tier table's own threshold (the
  // tier table already encodes "how late before what penalty" via its own
  // fromTime boundaries, e.g. a 09:00-09:20:0 tier already covers the grace
  // period). A separately-configured late_limit silently zeroed out real tier
  // matches whenever it didn't agree with the tier table's own boundaries —
  // see the certified production defect this fixed. calcLatePenalty's own
  // tier lookup is the only gate now; empty lateAbsRules falls back to
  // DEFAULT_LATE_RULES (policyEngine.js).
  const latePenalty = checkInMin !== null ? calcLatePenalty(checkInMin, lateAbsRules) : 0;

  // Early leave: tiered rule table lookup (key: early_rules).
  // Falls back to DEFAULT_EARLY_CHECKOUT_RULES when no custom rules are configured.
  const earlyPenalty = (checkOutMin !== null && checkOutMin < workEndMin && earlyLeaveExceedsGrace)
    ? calcEarlyCheckout(checkOutMin, earlyAbsRules)
    : 0;

  // overtime PenaltyRules (type='overtime'): graduated checkout-time → bonus
  // units. null = none configured for this policy — effectiveOvertimeUnits
  // then falls back to overtimeHours (legacy behavior, unchanged).
  const overtimeRulesUnits = checkOutMin !== null
    ? calcOvertimeUnits(checkOutMin, penaltyRules)
    : null;

  const totalDeductions = latePenalty + earlyPenalty;

  // ── Total overtime (morning + evening) ──────────────────────────────────────
  const totalOTHours = morningOT + eveningOT;

  // ── Status — driven by punch times only (no half_day, no worked-hours gate) ──
  // Removed: mark_absent_below (absent-by-hours), min_work_hours (half_day), break_minutes
  // Status is now: present | late | early_leave | absent | weekend | holiday
  let status = 'present';
  let isAbsent = false;
  if (checkInMin !== null && lateMinutes > (parseInt(legacyRules.late_grace) || 0)) status = 'late';
  if (earlyLeaveExceedsGrace && status === 'present') status = 'early_leave';

  if (checkIn === null) {
    logger.info(`[MISSING-CHECKIN] employee=${employeeId} date=${dateStr} checkOut=${checkOutStr} present with no checkin punch — workedMinutes=0, status=${manual?.status || status}`);
  } else if (checkOut === null) {
    logger.info(`[MISSING-CHECKOUT] employee=${employeeId} date=${dateStr} checkIn=${checkInStr} present with no checkout punch — workedMinutes=0, status=${manual?.status || status}`);
  }

  // ── ABSOLUTE POLICY (no exceptions — not manual override, not legacy data,
  // not HR judgment): a day with at least one punch (checkIn or checkOut) can
  // NEVER be 'absent'. This is enforced here, at the single canonical
  // computation point every write path (automatic, realtime, rebuild, manual
  // edit) funnels through, so no current or future caller can bypass it —
  // a `manual.status: 'absent'` override is silently ignored (falls back to
  // the naturally-computed present/late/early_leave status) whenever a punch
  // exists on the row. Callers that need to reject such a request outright
  // with a clear error (rather than a silent override) validate before
  // calling in (see routes/attendance/manual.js).
  const hasPunch = !!(checkIn || checkOut);
  let finalStatus = manual?.status || status;
  if (hasPunch && finalStatus === 'absent') finalStatus = status;
  const finalIsAbsent = hasPunch ? false : (manual?.status ? manual.status === 'absent' : isAbsent);

  // overtime_start / friday_ot_multiplier: Friday is a special overtime workday —
  // OT earned on Friday is paid at friday_ot_multiplier (handled in payrollEngine),
  // independent of whether Friday counts as a "weekend" day.
  if (dayOfWeek === 5 && (morningOT > 0 || eveningOT > 0)) {
    logger.info(`[OVERTIME-RULE] employee=${employeeId} date=${dateStr} Friday special workday — morningOT=${morningOT}h eveningOT=${eveningOT}h (friday_ot_multiplier applies in payroll)`);
  }

  if (!manual) {
    logger.info(`[RULE-MATCH] employee=${employeeId} date=${dateStr} → status=${status} checkIn=${checkInStr} checkOut=${checkOutStr || '—'} workedMinutes=${workedMinutes} OT=${totalOTHours}h`);
  }

  return {
    checkIn,
    checkOut,
    workedMinutes,
    lateMinutes,
    overtimeMinutes:      (morningOT + eveningOT) * 60,
    overtimeHours:        totalOTHours,
    overtimeRulesUnits,
    earlyLeaveMinutes,
    morningOvertimeHours: morningOT,
    eveningOvertimeHours: eveningOT,
    latePenaltyUnits:     latePenalty,
    earlyCheckoutUnits:   earlyPenalty,
    totalDeductionUnits:  totalDeductions,
    isAbsent:             finalIsAbsent,
    isWeekend:            weekend,
    isHoliday:            holiday,
    status:               finalStatus,
  };
}

// Baseline for every engine write. Each upsert overlays its computed values on
// top of THIS — so a weekend/holiday/absent write fully clears checkIn/OT/etc.
// from a previous "present" computation instead of inheriting stale values
// (which used to leak overtime pay into absent/holiday rows downstream).
//
// manualLatePenaltyUnits/manualEarlyPenaltyUnits/manualPenalty* are deliberately
// NOT part of this reset (and not written by computeDerivedFields) — Prisma's
// partial update in upsertDaily below only touches keys present in `full`, so
// these HR-overlay fields survive every recompute/rebuild untouched. Effective
// values are derived at read time via mergeEffectivePenalty().
const DAILY_RESET = {
  checkIn: null,
  checkOut: null,
  workedMinutes: 0,
  lateMinutes: 0,
  overtimeMinutes: 0,
  overtimeHours: 0,
  overtimeRulesUnits: null,
  earlyLeaveMinutes: 0,
  morningOvertimeHours: 0,
  eveningOvertimeHours: 0,
  latePenaltyUnits: 0,
  earlyCheckoutUnits: 0,
  totalDeductionUnits: 0,
  isAbsent: false,
  isHoliday: false,
  isWeekend: false,
  status: 'present',
};

async function upsertDaily(employeeId, dateStr, data) {
  const date = new Date(dateStr);
  const full = { ...DAILY_RESET, ...data };
  // Fix 1: absent records must never have a null absenceType in the DB.
  // Create path: inject the default directly into the INSERT payload.
  // Update path: if the record transitions from present→absent and absenceType is still null
  //   (i.e. HR has not set it yet), set it via a conditional updateMany.
  //   The WHERE absenceType=null guard ensures HR-set values (e.g. 'without_permission') are
  //   never silently overwritten by engine recomputes.
  const absenceDefault = (full.isAbsent && !full.absenceType) ? { absenceType: 'with_permission' } : {};
  await prisma.attendanceDaily.upsert({
    where: { employeeId_date: { employeeId, date } },
    update: { ...full, updatedAt: new Date() },
    create: { employeeId, date, ...full, ...absenceDefault },
  });
  if (full.isAbsent) {
    await prisma.attendanceDaily.updateMany({
      where: { employeeId, date, absenceType: null },
      data:  { absenceType: 'with_permission' },
    });
  }
}

async function processMonth(year, month, branchId) {
  const { start, end: monthEnd } = monthRangeMoment(year, month);
  // EF-005.4 Phase 1: never process dates after today — a day that hasn't
  // occurred yet has no attendance to compute.
  const end   = moment.min(monthEnd, moment().endOf('day'));
  const employees = await prisma.employee.findMany({
    where: { status: true, branchId: branchId || undefined },
  });
  for (const emp of employees) {
    let d = start.clone();
    while (d.isSameOrBefore(end)) {
      try { await processDate(d.toDate(), emp.id); }
      catch (err) { logger.error(`processMonth emp ${emp.id} on ${d.format('YYYY-MM-DD')}: ${err.message}`); }
      d.add(1, 'day');
    }
  }
}

// Overlap guard: processToday can be triggered by the scheduler cron, the
// midnight cron, and the manual /attendance/process route. Running two passes
// concurrently is wasted work and racy (concurrent upserts on the same rows) —
// only one pass may be in flight at a time.
let processTodayRunning = false;

async function processToday(branchId, targetDate = null) {
  if (processTodayRunning) {
    logger.info('[ATT-ENGINE] processToday skipped — a pass is already running');
    return { skipped: true, reason: 'already_running', processedCount: 0 };
  }
  processTodayRunning = true;
  try {
    const today = targetDate ? moment(targetDate).format('YYYY-MM-DD') : moment().format('YYYY-MM-DD');
    logger.info(`[ATT-ENGINE] processToday → processing date=${today} branchId=${branchId || 'all'}`);
    const employees = await prisma.employee.findMany({
      where: { status: true, branchId: branchId || undefined },
    });
    let processedCount = 0;
    for (const emp of employees) {
      try { await processDate(new Date(today), emp.id); processedCount++; }
      catch (err) { logger.error(`processToday emp ${emp.id}: ${err.message}`); }
    }
    return { skipped: false, processedCount, date: today };
  } finally {
    processTodayRunning = false;
  }
}

// Final/highest-precedence overlay — call on a record that has ALREADY passed
// through applyApprovedAdjustment/mergeEffective (the AttendanceAdjustment
// approval-gated overlay). Adds effective* fields used by payroll/UI/reports.
function mergeEffectivePenalty(record) {
  if (!record) return record;
  const baseLat  = record.latePenaltyUnits        || 0;
  const baseEar  = record.earlyCheckoutUnits      || 0;
  const baseTot  = record.totalDeductionUnits     || 0;

  const hasManualLate      = record.manualLatePenaltyUnits  != null;
  const hasManualEarly     = record.manualEarlyPenaltyUnits != null;
  const hasManualOvertime  = record.manualOvertimeUnits      != null;

  // Rule A: absent records — no late/early-leave deductions (only absence policy applies).
  // Rule B/C: weekend/holiday records — no attendance deductions (OT still applies).
  // Manual overrides on these statuses are intentionally ignored — the business rule is absolute.
  const isNonWorkingOrAbsent = record.isAbsent || record.isWeekend || record.isHoliday;

  const effectiveLatePenalty  = isNonWorkingOrAbsent ? 0
    : (hasManualLate  ? record.manualLatePenaltyUnits  : baseLat);
  const effectiveEarlyPenalty = isNonWorkingOrAbsent ? 0
    : (hasManualEarly ? record.manualEarlyPenaltyUnits : baseEar);

  // Overtime: graduated PenaltyRule (type='overtime') result if configured
  // for this policy, else falls back to the raw hour-based overtimeHours.
  const baseOvertime = record.overtimeRulesUnits ?? (record.overtimeHours || 0);
  const effectiveOvertimeUnits = hasManualOvertime ? record.manualOvertimeUnits : baseOvertime;

  return {
    ...record,
    originalLatePenaltyUnits:    baseLat,
    originalEarlyCheckoutUnits:  baseEar,
    originalTotalDeductionUnits: baseTot,
    originalOvertimeUnits:       baseOvertime,
    effectiveLatePenalty,
    effectiveEarlyPenalty,
    effectiveOvertimeUnits,
    effectiveTotalDeductionUnits: effectiveLatePenalty + effectiveEarlyPenalty,
    // hasManualPenalty is false for absent/weekend/holiday — the override is suppressed,
    // so the UI should not show the "manual override active" indicator for those rows.
    hasManualPenalty:  !isNonWorkingOrAbsent && (hasManualLate || hasManualEarly),
    hasManualOvertime,
    manualLatePenaltyUnits:  record.manualLatePenaltyUnits  ?? null,
    manualEarlyPenaltyUnits: record.manualEarlyPenaltyUnits ?? null,
    manualOvertimeUnits:     record.manualOvertimeUnits     ?? null,
    manualPenaltyReason:     record.manualPenaltyReason     ?? null,
    manualPenaltyBy:         record.manualPenaltyBy         ?? null,
    manualPenaltyByName:     record.manualPenaltyByName     ?? null,
    manualPenaltyAt:         record.manualPenaltyAt         ?? null,
  };
}

// Certification HIGH#4: exported (additive only, no behavior change) so
// routes/attendance.js can recompute latePenaltyUnits/earlyCheckoutUnits
// from a manually-corrected lateMinutes/earlyLeaveMinutes using the exact
// same tier-parsing this module already uses internally — never a second,
// duplicate implementation of "HH:MM tier JSON → absolute-minute tiers".
module.exports = { processDate, processMonth, processToday, computeDerivedFields, mergeEffectivePenalty, parseTimeRules };
