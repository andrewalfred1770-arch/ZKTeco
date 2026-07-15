# PAYROLL CONSISTENCY ARCHITECTURE

**Status:** Permanent reference document. **Do not delete or treat as a one-time report** — this explains a load-bearing architectural decision (Option E) that future payroll work must not accidentally undo.

**Origin:** Written during the HIGH #1 certification fix (2026-07-09), which resolved a defect discovered while fixing Critical #2 (SalaryCard deductions-table reconciliation): `GET /api/payroll/final-sheet` could return a `deductions.total` that disagreed with its own `netSalary` in the same JSON response.

**Files this document governs:** `backend/src/engines/payrollEngine.js`, `backend/src/routes/payroll.js`.

---

## 1. Root Cause A — Mixed Provenance

Before this fix, a single `/final-sheet` response mixed two different data sources for numbers that are supposed to describe one document:

- `deductions.total` was **always freshly recomputed** from live `AttendanceDaily` on every request.
- `earnings.total`'s components (`basicSalary`, `overtimeAmount`, `bonus`) and — critically — **`netSalary`** were read from the **persisted** `Payroll` row whenever one existed (`pr.netSalary ?? ...`, and since a `Payroll` row existed for every real employee/month ever calculated, the `??` fallback never actually executed in practice).

Whenever `AttendanceDaily` changed after the last time `calculatePayroll()` ran for that employee/month (a manual attendance edit, a rebuild, a rule-triggered recalc, an approved adjustment — all legitimate, all common), the persisted `Payroll.netSalary` became stale relative to the freshly-recomputed `deductions.total` sitting right next to it in the same response. The document contradicted itself.

**Proof (production data, 2026-07-09):** a full scan of all 2,536 `Payroll` rows found 68 employee/months where `deductions.total` and `netSalary` did not reconcile. In every single one, `netDiff = 0` — because `netSalary` never actually changed with the fresh data; it was unconditionally the persisted value. That is the fingerprint of mixed provenance, not of two independently-wrong formulas.

## 2. Root Cause B — Rounding Order

Separately, even when `AttendanceDaily` had *not* changed (zero staleness), the route's own re-derivation and `payrollEngine.computePayroll()` could still disagree by a cent or more, because they rounded in a different order:

- `payrollEngine.computePayroll()` kept `absentDeduction`, `latePenalty`, `earlyLeavePenalty` as **raw, unrounded floats**, summed all five deduction components, and rounded **once**, at the end (inside `computeDeductionsBreakdown()`).
- The old `/final-sheet` route rounded `absentDeduct`, `lateDeduct`, `earlyDeduct` to two decimals **individually, before summing** them into the same shared `computeDeductionsBreakdown()`.

Classic "round-then-sum vs. sum-then-round" floating-point divergence. Proven concretely with real attendance data for employee 93 (June 2026): `669.875 + 145.625 = 815.500` (round once → `815.50`) vs. `669.88 + 145.63 = 815.51` (round twice, each `.5` boundary independently rounds up). This defect existed **even at the exact same instant**, with zero staleness involved — confirmed by recalculating `payroll.updatedAt` was 27ms *after* the last `AttendanceDaily` write, yet the mismatch still occurred.

## 3. Why Option E Was Selected

Four architectures were evaluated (see the HIGH #1 investigation transcript for the full comparison table):

- **Option A** (always return persisted values) — would require new `Payroll` schema columns for itemized breakdown fields that aren't currently persisted (`absentAmount`, day-scoped `conditionAmountDay`), and permanently enshrines staleness for any month nobody has re-calculated.
- **Option B** (always recompute fresh, ignore persisted `Payroll` entirely) — internally consistent, but can make the printed slip disagree with what `GET /payroll`'s grid shows at the same instant, trading one inconsistency for another.
- **Option C** (detect staleness, auto-recalculate on read) — fixes staleness but not the rounding-order bug, and makes a `GET` request perform a conditional database write.
- **Option E (selected)** — `payrollEngine.js` already contained the correct shape: a pure `computePayroll()` and a persisting wrapper `calculatePayroll()`. The fix was to point `/final-sheet` at the **pure** function directly, and additively expose the two itemized fields (`absentAmount`, `conditionAmountDay`, plus `dailyRate`) it was already computing internally but not returning. This eliminates *both* root causes at once — one formula, computed once, used for both the persisted row and the printed document — with **zero schema change**, **zero new heuristics**, and **zero new database writes**.

## 4. Why GET Must Remain Read-Only

`GET /api/payroll/final-sheet` is called far more often than its name suggests — every open of the Final Salary Sheet modal, and once per employee in `FinalSalaryModal.jsx`'s bulk-print path (`loadBulk`, sequentially, for every employee in the selected month). A GET endpoint that silently writes on every view:

- violates basic REST semantics (GET must be safe/idempotent-with-no-side-effects), which matters here because the frontend, caching layers, or future tooling may assume GETs are free to retry, prefetch, or call speculatively;
- turns "print 100 payslips" into "recalculate and persist 100 payroll rows," which is surprising, hard to reason about, and not something an operator asked for just by opening a print preview;
- was explicitly rejected during this investigation (Option D, an earlier draft of this fix, called `calculatePayroll()` — the persisting wrapper — from `/final-sheet` and was rejected for exactly this reason before being replaced with Option E).

Recalculation remains an explicit, HR-triggered action (`POST /payroll/calculate`, the "احتساب المرتبات" button) — as it always has been in this codebase. This fix does not change when persistence happens, only guarantees that when a document is *displayed*, its own numbers agree with each other.

## 5. Why `computePayroll()` Is Now the Single Computation Source

`payrollEngine.computePayroll(employeeId, month, year)` is confirmed pure — every database call inside it is a read (`employee.findUnique`, `attendanceDaily.findMany`, `attendanceAdjustment.findMany`, `payroll.findUnique` for preserving `bonus`/`manualDeductionAdjustment`, `advance.findMany`, `evaluateConditionRules`). It already computed every money figure needed for both persistence and display; it simply didn't *return* two of them (`absentAmount`, `conditionAmountDay`) and a display convenience (`dailyRate`).

Every consumer of "compute this employee's payroll for this month" should call this one function:

| Caller | Uses |
|---|---|
| `calculatePayroll()` | Wraps `computePayroll()`, persists the result via `prisma.payroll.upsert()`. Called by `POST /payroll/calculate`, `PUT /payroll/:id`, `PUT /payroll/:id/advances`, attendance manual-edit routes, `routes/adjustments.js`, `historicalRebuildService`, `relinkService`, `realtimeListenerService`, `recalcEngine`. |
| `GET /final-sheet` | Calls `computePayroll()` directly — never persists. |
| `POST /attendance/daily/:id/preview` | Already called `computePayroll()` directly (current vs. proposed), a pre-existing correct usage that predates this fix. |

There is now exactly **one** place late/early/absence/overtime/net-salary formulas exist in this codebase. `computeDeductionsBreakdown()` — the final summation step — likewise now has exactly one call site (inside `computePayroll()`).

**Rule for future work:** if you need "this employee's payroll for this month," call `computePayroll()` (read-only) or `calculatePayroll()` (persists). Never re-derive absent/late/early/overtime money from `AttendanceDaily` anywhere else. If a new consumer needs a field `computePayroll()` doesn't currently return, add it to `computePayroll()`'s return object (it likely already computes it as a local variable) — do not recompute it independently.

## 6. Known Technical Debt

- **Duplicated `AttendanceDaily`/`AttendanceAdjustment` reads in `/final-sheet`.** The route still independently queries and merges (`applyApprovedAdjustment` + `mergeEffectivePenalty`) attendance records to build the display-only `attendance` KPI section (`workDays`, `absentDays`, `totalLateMin`, `morningOT`/`eveningOT` hours, `hasManualPenalty`, `hasManualOvertime`) — none of which `computePayroll()` currently returns. This means the same month's attendance is read from the database twice per `/final-sheet` request (once by the route, once inside `computePayroll()`). Not a correctness risk — both derivations are proven identical — but a performance/maintainability cost. Resolving it would mean extending `computePayroll()`'s return object further (it would need to also expose `totalLateMinutes`, `lateDays`, `hasManualPenalty`, `hasManualOvertime`, and the raw `morningOT`/`eveningOT` hour split) and deleting the route's local `attRecords`/`effRecords` block entirely. Deliberately deferred — out of scope for HIGH #1, which was scoped strictly to money-figure consistency.
- **Stale `Payroll` workflow.** Because `GET /final-sheet` never persists (by design, see §4), a `Payroll` row can remain stale — reflecting an earlier `AttendanceDaily` state — until an operator explicitly re-runs `POST /payroll/calculate`. `GET /payroll`'s grid reads the persisted row directly, so it can show different numbers than a freshly-opened Final Salary Sheet for the same employee/month until that recalculation happens. This is not a regression introduced by this fix — it is the same recalculation-is-explicit workflow this codebase has always had — but it is now more *visible* (the final-sheet document is always fresh and correct, exposing that the grid might not be).

## 7. Future Improvement Ideas (not yet implemented — proposals only)

- **Dirty-payroll indicator.** Track (or compute on demand, e.g. via `MAX(AttendanceDaily.updatedAt)` per employee/month vs. `Payroll.updatedAt`) whether a persisted `Payroll` row is stale relative to current `AttendanceDaily`, and surface it in the UI (e.g., a badge on `PayrollPage`'s grid: "يحتاج إعادة احتساب"). This would close the visibility gap in the stale-workflow debt above without ever making a GET request write.
- **Incremental payroll recalculation.** Today, any recalculation re-reads and re-aggregates an employee's entire month of `AttendanceDaily` rows. For a single-day attendance edit, this is more work than necessary. A future design could recompute only the affected day's contribution and adjust the persisted aggregate incrementally — a larger architectural change, not attempted here given "do not change payroll formulas unless absolutely required."
- **Performance optimization for `/final-sheet`.** Once a dirty-indicator exists, `/final-sheet` could short-circuit: if the persisted `Payroll` row is *not* stale, skip the `computePayroll()` recomputation entirely and read the persisted row (which would then be provably fresh) — regaining the performance of Option A without its correctness problems. This is essentially Option C's staleness-detection idea, but used only to decide whether a *read-only shortcut* is safe, never to trigger a write from a GET.

---

*This document reflects the codebase state immediately after the HIGH #1 fix (2026-07-09). If `payrollEngine.computePayroll()`'s return shape or `/final-sheet`'s consumption of it changes, update this document in the same change.*
