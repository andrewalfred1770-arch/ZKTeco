# PAYROLL SINGLE SOURCE OF TRUTH

**Status:** Permanent architecture reference. Part of project documentation and future development rules — not a point-in-time report. If you are adding a payroll or attendance feature, read this document first.

**Origin:** Written after the Enterprise Certification Audit (Critical #1, Critical #2, HIGH #1, HIGH #2, HIGH #3), which found and closed five distinct instances of the same root architectural failure: a KPI computed independently in more than one place, eventually disagreeing with itself.

---

## SECTION 1 — System Philosophy

Every certification finding in this audit — Critical #2's deductions-table mismatch, HIGH #1's `netSalary`/`deductions.total` inconsistency, HIGH #2's overtime-split gap, HIGH #3's `workDays` divergence, and the Friday-OT investigation's Employee Movement bug — traced back to the identical root cause: **the same value was computed more than once, in more than one file, using more than one formula.** Two formulas for one concept always eventually disagree, whether from a rounding-order difference, a stale data edge case, or a field one implementation forgot to check.

The principle adopted going forward:

> **Every payroll/attendance KPI has exactly ONE canonical function that computes it. Every other consumer — routes, reports, UI components, exports, print templates — reads that value. None of them may re-derive it.**

This is not a style preference. It is the specific, proven fix for every finding in this certification. A KPI computed twice is a KPI that will eventually be wrong in one of the two places, and nothing in code review reliably catches it — every divergence in this audit was found only by comparing live production data across surfaces, not by reading either implementation in isolation.

Two layers exist, and each has its own canonical owner:

1. **Per-day layer** — `backend/src/engines/attendanceEngine.js` (`processDate` / `computeDerivedFields` / `mergeEffectivePenalty`). Owns everything about a single `AttendanceDaily` row: status, worked minutes, late/early minutes, effective penalty units, morning/evening OT hours, absence/weekend/holiday flags.
2. **Monthly-aggregate + money layer** — `backend/src/engines/payrollEngine.js` (`computePayroll` / `calculatePayroll`). Owns everything about turning a month of per-day rows into earnings, deductions, and net salary — for one employee, one month.

No third layer is permitted to independently re-aggregate `AttendanceDaily` rows for a figure either of these two already produces.

---

## SECTION 2 — Canonical Sources

| KPI | Canonical Function | Canonical File | Returned As | Consumers |
|---|---|---|---|---|
| **Attendance Status** | `computeDerivedFields()` → persisted by `upsertDaily()` | `attendanceEngine.js` | `AttendanceDaily.status` | Daily, Monthly, Movement, Payroll (`workDays`), Reports, SalaryCard |
| **Work Days** | `computePayroll()` — `status IN (present, late, early_leave)` | `payrollEngine.js` | `workDays` | Payroll, SalaryCard, Final Sheet, Reports export, Monthly (matches, verified HIGH #3) |
| **Present Days / Absent Days (Movement)** | ⚠️ **Not yet canonicalized** — see Section 7 | `routes/attendance.js` (`summarizeMovementDays`) | `presentDays`/`absentDays` | Employee Movement only |
| **Absent Days (Payroll)** | `computePayroll()` — `isAbsent` count | `payrollEngine.js` | `absentDays` | Payroll, SalaryCard, Final Sheet |
| **Late Minutes** | `computeDerivedFields()` (per-day, raw) | `attendanceEngine.js` | `AttendanceDaily.lateMinutes` | Daily, Monthly, Movement, Final Sheet (all sum the same raw per-day field — no independent formula, low risk) |
| **Late Penalty Units (effective)** | `mergeEffectivePenalty()` | `attendanceEngine.js` | `effectiveLatePenalty` | Payroll (`penaltyUnits`, `latePenalty` money), Movement, Final Sheet, Reports |
| **Early Leave Units (effective)** | `mergeEffectivePenalty()` | `attendanceEngine.js` | `effectiveEarlyPenalty` | Payroll (`earlyLeavePenalty` money), Movement, Final Sheet, Reports |
| **Overtime Units (effective)** | `mergeEffectivePenalty()` | `attendanceEngine.js` | `effectiveOvertimeUnits` | `payrollEngine.js`'s per-record OT loop (money), Movement `totalOT` (fixed, Friday-OT investigation), Monthly, Reports |
| **Morning OT Amount** | `computePayroll()` — exact integer-cent partition of `overtimeAmount` (HIGH #2) | `payrollEngine.js` | `morningOTAmount` | SalaryCard, Final Sheet, Excel export |
| **Evening OT Amount** | `computePayroll()` — same partition, absorbs unsplittable/weekend/holiday/bonus OT | `payrollEngine.js` | `eveningOTAmount` | SalaryCard, Final Sheet, Excel export |
| **Overtime Amount (total)** | `computePayroll()` — day-specific multiplier (regular/Friday/holiday/weekend) | `payrollEngine.js` | `overtimeAmount` | Payroll, SalaryCard, Final Sheet, Movement `otAmount`, Reports |
| **Hourly Rate** | `computePayroll()` — `dailyRate / workHoursPerDay` | `payrollEngine.js` | `hourlyRate` | Payroll, SalaryCard, Final Sheet |
| **Daily Rate** | `computePayroll()` — `Math.round(basicSalary / monthDays)` (HIGH #1) | `payrollEngine.js` | `dailyRate` | SalaryCard, Final Sheet |
| **Gross Salary / Earnings Total** | Sum of three already-canonical fields (`basicSalary + overtimeAmount + bonus`) at the display layer — see Section 7 note | `routes/payroll.js` (`/final-sheet`), `payrollEngine.js` (persisted) | `earnings.total` | SalaryCard, Final Sheet, Reports |
| **Deductions (total)** | `computeDeductionsBreakdown()`, called once, inside `computePayroll()` (HIGH #1) | `payrollEngine.js` | `deductions` | Payroll, SalaryCard, Final Sheet, Reports |
| **Condition Penalty (day-scoped)** | `mergeEffectivePenalty()` → aggregated in `computePayroll()` | `attendanceEngine.js` / `payrollEngine.js` | `conditionAmountDay` | SalaryCard, Final Sheet |
| **Condition Penalty (month-scoped)** | `evaluateConditionRules(..., 'month')`, evaluated once inside `computePayroll()` (HIGH #1 removed the route's duplicate call) | `payrollEngine.js` | `conditionPenaltyAmount` | Payroll, SalaryCard, Final Sheet |
| **Manual Deduction Adjustment** | Persisted HR field, preserved (never derived) by `computePayroll()` | `payrollEngine.js` | `manualDeductionAdjustment` | Payroll, SalaryCard, Final Sheet |
| **Advances** | `computePayroll()` — sum of `Advance` rows for the month | `payrollEngine.js` | `advances` | Payroll, SalaryCard, Final Sheet |
| **Bonus** | Persisted HR field, preserved (never derived) by `computePayroll()` | `payrollEngine.js` | `bonus` | Payroll, SalaryCard, Final Sheet |
| **Net Salary** | `computePayroll()` — `basic + overtime + bonus − deductions − advances` | `payrollEngine.js` | `netSalary` | Payroll, SalaryCard, Final Sheet, Reports |

**Note on Gross Salary/Earnings Total:** this is the one place a "KPI" is combined outside `computePayroll()` — but it is a straight sum of three fields that are each already canonical and already final (no independent formula, no re-derivation of any single component). It is documented here rather than hidden; see Section 7 for the recommendation to fully close even this gap.

**Note on Present/Absent Days (Movement):** HIGH #3 proved this metric uses a third formula, distinct from both `Attendance Status` and `Work Days`, and disagrees with canonical `Work Days` for any employee/month carrying a stale legacy status value. It was intentionally left unfixed in HIGH #3 (different name, different purpose, out of that finding's scope) — it remains open technical debt, tracked here so it is not forgotten.

---

## SECTION 3 — Forbidden Patterns

Every one of these was found, live, in production code, during this certification. Do not reintroduce them.

- ❌ **Recompute deductions in a route.** (`routes/payroll.js` did this before HIGH #1 — different rounding order than `payrollEngine.js`, producing a real 1-cent-plus divergence.)
- ❌ **Recompute `workDays` from flags** (`isAbsent`/`isWeekend`/`isHoliday`/`checkIn`) instead of reading `status`. (HIGH #3 — silently wrong on any stale/legacy status value.)
- ❌ **Recompute overtime amounts by multiplying hours × rate × multiplier outside `payrollEngine.js`.** (HIGH #2 — a flat multiplier applied to a morning/evening hour split that structurally excludes weekend/holiday OT.)
- ❌ **Duplicate `AttendanceDaily` aggregation** (querying and summing the same month's records independently in two files for the same figure) — acceptable only for genuinely display-only KPIs that have no canonical owner yet (documented exceptions in Section 2), never for money.
- ❌ **Multiply `hourlyRate` again inside the UI or a print template.** No frontend file may ever perform `hours * hourlyRate * multiplier` — confirmed clean (`SalaryCard.jsx`, `CompactSalarySheet.jsx`, `FinalSalaryModal.jsx`, `PrintPreviewModal.jsx` are all pure passthroughs) — keep it that way.
- ❌ **Rebuild totals inside reports** by re-summing raw attendance instead of reading the persisted/computed money fields.
- ❌ **Let a `GET` endpoint write to the database** to "fix" staleness. (Explicitly rejected during HIGH #1 — Option C and an early draft of Option D both did this and were both overruled.)
- ❌ **Trust a route's own re-derivation because a comment claims "same formula as X."** Comments drift; only a single shared function call guarantees agreement (proven: `/final-sheet`'s pre-HIGH#1 comment claimed parity with `payrollEngine.js` while using different rounding order).

---

## SECTION 4 — Approved Pattern

```
AttendanceDaily (raw + engine-computed per-day fields)
        │
        ▼
attendanceEngine.js
  processDate() / computeDerivedFields() / mergeEffectivePenalty()
  → status, lateMinutes, effectiveLatePenalty, effectiveEarlyPenalty,
    effectiveOvertimeUnits, effectiveConditionUnits, morning/eveningOvertimeHours
        │
        ▼
payrollEngine.js
  computePayroll()  — PURE, no DB writes, callable from a GET
  calculatePayroll()  — wraps computePayroll(), persists via one upsert
        │
        ├── Payroll table (persisted, via calculatePayroll)
        ├── Salary Card / Final Sheet  (GET /final-sheet → computePayroll(), never calculatePayroll())
        ├── Reports (money fields read from persisted Payroll; workDays now status-based, matching)
        ├── Print
        ├── PDF
        └── Excel
```

**Every consumer MUST read. No consumer may derive.** If a consumer needs a value `computePayroll()` doesn't currently return, the fix is to add it to `computePayroll()`'s return object (it is very likely already a local variable inside the function) — never to compute it independently at the call site. This is the exact fix pattern used in Critical #2, HIGH #1, HIGH #2, and HIGH #3.

**GET routes stay read-only.** `computePayroll()` is safe to call from any GET handler because it performs zero writes — verified by reading every Prisma call inside it. `calculatePayroll()` (which does write) is only ever called from `POST`/`PUT` routes or background services, never from a GET.

---

## SECTION 5 — Historical Findings

### Critical #1 — Cross-device duplicate punch ingestion
- **Problem:** Two `Device` rows pointing at the same physical fingerprint device caused the same punch to be ingested twice, under two different `deviceId`s.
- **Root cause:** The uniqueness constraint was `(deviceId, zkUserId, timestamp)` — deviceId-scoped, not physical-device-scoped. Nothing ever set the existing but unused `AttendanceLog.isDuplicate` flag.
- **Fix:** `deviceIntegrity.js` gained `reconcileCrossDeviceDuplicates()`, run on the existing 15-minute topology-audit tick — marks (never deletes) redundant rows as `isDuplicate=true`, a flag `attendanceEngine.js` already filtered on everywhere.
- **Canonical source:** N/A (ingestion-layer data-integrity fix, not a KPI formula).
- **Lesson:** A flag that exists in the schema but that nothing ever sets is as dangerous as a missing flag — always check both "is it read?" and "is it ever written?"

### Critical #2 — SalaryCard deductions table didn't sum to its own total
- **Problem:** The printed deductions table listed `advances` as a row (which the total explicitly excludes) and a dead `deductions.other` field (which never had data) instead of the real `conditionPenalty`.
- **Root cause:** The frontend row list was authored independently of the backend's actual field set.
- **Fix:** Corrected the row list to bind the fields that actually feed the total; moved advances to its own dedicated section (per your explicit design direction), matching the true accounting model (`net = earnings − deductions − advances`).
- **Canonical source:** `deductions.total` (backend, `payrollEngine.js`) — the frontend fix made the display match the existing canonical value; no backend change.
- **Lesson:** A UI row list and a backend total must be verified to actually reconcile — "looks plausible" is not "proven identical."

### HIGH #1 — `/final-sheet`'s `deductions.total` vs. `netSalary` mixed provenance + rounding order
- **Problem:** `deductions.total` was always freshly recomputed from live `AttendanceDaily`; `netSalary` was always the persisted `Payroll.netSalary`. The two could disagree in the same JSON response.
- **Root cause A (mixed provenance):** two different data sources combined in one document.
- **Root cause B (rounding order):** even at zero staleness, `payrollEngine.js` summed raw values and rounded once; `/final-sheet` rounded three components individually before summing — proven with real data (`669.875 + 145.625 = 815.500` vs `669.88 + 145.63 = 815.51`).
- **Fix (Option E):** `/final-sheet` now calls the existing pure `computePayroll()` directly — never `calculatePayroll()` — for every money figure. Zero new database writes.
- **Canonical source:** `computePayroll()`, `payrollEngine.js`.
- **Lesson:** "Same formula, different files" is never actually the same formula unless it's a single function call. See `PAYROLL_CONSISTENCY_ARCHITECTURE.md` for the full technical writeup.

### HIGH #2 — Morning/Evening OT split didn't sum to the overtime total
- **Problem:** `earnings.morningOT.amount + earnings.eveningOT.amount` could differ from `earnings.overtimeAmount` by hundreds of currency units whenever a month contained weekend/holiday OT (which has no morning/evening split at the attendance level).
- **Root cause:** `/final-sheet` multiplied hours by a flat multiplier itself, instead of using the day-specific multiplier logic that already existed only inside `payrollEngine.js`.
- **Fix:** `computePayroll()` now computes `morningOTAmount`/`eveningOTAmount` as an exact integer-cent partition of `overtimeAmount`, inside the same per-record loop that computes the total — proven with zero-tolerance cent-level verification across all 2,536 employee/months.
- **Canonical source:** `computePayroll()`, `payrollEngine.js`.
- **Lesson:** An "informational breakdown" that doesn't reconcile with its own total is exactly as misleading as a wrong total — precision claims require proof, not visual plausibility.

### HIGH #3 — `workDays` — four independent formulas
- **Problem:** `payroll.js` and `reports.js` computed "work days" from `isAbsent`/`isWeekend`/`isHoliday`/`checkIn` flags; `payrollEngine.js` (canonical, persisted) used `status`. They silently disagreed whenever a record carried a stale/legacy status value.
- **Root cause:** 3 real `AttendanceDaily` rows still carried `status='half_day'` — a status value removed from the business rules on 2026-06-22 — and were never recomputed after that change. The flag-based formula ignores `status` entirely and so didn't notice; the status-based formula correctly excluded the stale value.
- **Fix:** `/final-sheet` and the Reports export now use the canonical status-based formula (sourced from `computed.workDays` in `/final-sheet`'s case).
- **Canonical source:** `computePayroll()`, `payrollEngine.js`.
- **Lesson:** A formula built on raw boolean flags is fragile to any upstream status-model change; a formula built on the engine's own explicit output field is not.

### Friday-OT verification + Employee Movement OT bug (adjacent finding, same audit)
- **Verified:** the Friday-as-weekend "OT from first minute, 0-49/50-59 rounding" business rule was already fully correct in `attendanceEngine.js` — proven against 11,071 real rows plus the exact requested example. No code change required for the rule itself.
- **Found and fixed in passing:** Employee Movement's `totalOT` (`morningOT + eveningOT`) was structurally zero on every weekend/holiday day, for the same reason as HIGH #2 — silently excluding 1,518 real OT hours database-wide from that one report's KPI. Money (`otAmount`) was already correct and unaffected.
- **Lesson:** the same root defect class (a display field built from a hour-split that's legitimately zero on certain day types) recurred in a second, independent file — a strong signal this class of bug should be actively searched for whenever `morningOvertimeHours`/`eveningOvertimeHours` appear in new code.

---

## SECTION 6 — Future Development Rules

Before writing any code that touches attendance or payroll data, every future feature must:

1. **Search for an existing canonical implementation** — check Section 2 of this document first, then `payrollEngine.js`/`attendanceEngine.js` directly, before writing a single line of aggregation logic.
2. **Reuse it** — call the canonical function; do not read `AttendanceDaily` rows directly to reconstruct a value the engine already computes.
3. **Never duplicate a formula** — if you find yourself writing `hours * hourlyRate * multiplier`, `status IN (...)`, or summing `effectiveOvertimeUnits`/`effectiveLatePenalty` anywhere outside `payrollEngine.js`/`attendanceEngine.js`, stop and use the canonical function instead.
4. **Never introduce a second implementation** — if the canonical function doesn't return a field you need, add the field to its return object (per the HIGH #1/#2/#3 pattern) rather than computing it independently at the call site.
5. **Keep `GET` endpoints read-only** — display/read routes call `computePayroll()`, never `calculatePayroll()`. Only `POST`/`PUT` routes and background services persist.
6. **Preserve business logic** — attendance/payroll formulas, multipliers, and rounding rules do not change as part of a consistency fix unless runtime evidence proves the formula itself (not just its duplication) is wrong.

---

## SECTION 7 — Certification Status

**Critical: CLOSED (2/2)** — Critical #1 (cross-device duplicate punches), Critical #2 (SalaryCard deductions reconciliation).

**High: CLOSED (3/3 investigated so far)** — HIGH #1 (final-sheet mixed provenance/rounding), HIGH #2 (OT split identity), HIGH #3 (workDays formula duplication). Adjacent: Friday-OT business rule verified correct as-is; Employee Movement OT-hours display bug found and fixed in passing.

**Remaining High findings (not yet investigated):** HIGH #4 onward, per the original Enterprise Certification Report (`ENTERPRISE_CERTIFICATION_REPORT_2026-07-09.md`).

**Known accepted risks:**
- **Class B staleness** (documented in `PAYROLL_CONSISTENCY_ARCHITECTURE.md`): a persisted `Payroll` row can lag behind current `AttendanceDaily` until an operator explicitly runs `POST /payroll/calculate` — by design, since `GET` must never write. 64 employee/months currently exhibit this at time of writing.
- **Employee Movement `presentDays`/`absentDays`** uses a third, non-canonical formula and can disagree with `Payroll.workDays` for the same stale-status edge case as HIGH #3 — intentionally not fixed as part of HIGH #3 (different metric name/purpose); tracked here as open debt.

**Known technical debt:**
- `/final-sheet` still independently derives its display-only attendance KPI section (`totalLateMin`, `hasManualPenalty`, `hasManualOvertime`, raw morning/evening hour split) via its own `attRecords`/`effRecords` query — a second `AttendanceDaily` read per request, alongside `computePayroll()`'s own internal read. Documented in `PAYROLL_CONSISTENCY_ARCHITECTURE.md` Section 6.
- 3 `AttendanceDaily` rows still carry the stale `status='half_day'` value (root cause of HIGH #3) — not repaired, since that is a data operation, not a code fix.

**Open architecture improvements (proposed, not implemented):**
- A "dirty payroll" indicator (compare `Payroll.updatedAt` vs. `MAX(AttendanceDaily.updatedAt)`) to make Class B staleness visible in the UI instead of silent.
- Fully closing the "Gross Salary/Earnings Total" gap noted in Section 2 by adding a `totalEarnings` field to `computePayroll()`'s return object, so literally every payroll figure — with no exception — is a single-function-call read.
- Canonicalizing Employee Movement's `presentDays`/`absentDays` against the same `status`-based formula, once a decision is made on whether the two metrics should actually mean the same thing.

---

*This document must be updated in the same change whenever `computePayroll()`'s return shape changes, a new canonical source is introduced, or a documented exception in Section 2 is closed.*
