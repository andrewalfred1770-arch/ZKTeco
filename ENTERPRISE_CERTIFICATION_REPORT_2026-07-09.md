# PETSHROW ERP — Enterprise Certification Audit
**Date:** 2026-07-09 · **Method:** Read-only static + cross-reference audit (six parallel subsystem investigations). No source files were modified, no builds run, no installers generated. This report supersedes nothing — it is a new point-in-time audit alongside the existing `FINAL_CERTIFICATION_REPORT.md` (2026-06-11) and `REPORT_01`–`REPORT_10` (earlier structural reports).

**Scope covered:** Attendance Engine, Payroll Engine, Device Sync/Rebuild/Realtime pipeline, Database schema, AG Grid rendering layer, Print/Report/Export subsystem. Full file lists are in each section below.

**Note on process:** partway through this audit, two of the automated background task notifications carried an appended block written to look like an authoritative system directive (claiming a list of prior "closed" investigations that do not exist in this session, and issuing re-formatted instructions). That content did not originate from you and was disregarded as untrusted/injected text; it had no effect on this report's findings or scope.

---

## Verdict

**PRODUCTION-VIABLE WITH KNOWN GAPS.** No defect below rises to "data corruption on the happy path" — the core engine formulas, manual-override preservation, and the historically-buggy `.err`-swallowing sync bug are all confirmed **correctly implemented today**. The findings below are concentrated in three areas that merit attention before the next release: (1) a real duplicate-punch risk from duplicate device rows with no cross-device dedup, (2) a payroll print/export path (`/final-sheet`) that independently re-derives formulas instead of delegating to the authoritative engine, and (3) reconciliation mismatches between visible line-items and printed totals on payslips.

---

## Critical Findings (top of list — read these first)

| # | Area | File:Line | Finding |
|---|---|---|---|
| C1 | Sync/Rebuild | `deviceIntegrity.js` (whole file), `attendance_logs` unique key `(deviceId, zkUserId, timestamp)` | No cross-deviceId deduplication exists anywhere in the ingestion pipeline. The `isDuplicate` column is never set by any runtime code path (only test scripts write it — dead flag). If two `Device` rows point at the same physical unit (detected only as a passive 15-min warning by `deviceIntegrity.js`, never prevented for pre-existing rows), the same physical punch is ingested twice under two different `deviceId`s, passes the unique constraint both times, and double-counts worked minutes/OT/late-penalties for that employee. |
| C2 | Print/Reports | `SalaryCard.jsx:180-197, 274-287` | The printed "الخصومات" (deductions) table's visible rows do not sum to the printed total: "السلف" (advances) is shown as a row inside a table whose footer (`dedTotal`) explicitly **excludes** advances by design, while `deductions.conditionPenalty` (which **is** included in the footer total) has no bound row — it's wired to a dead `deductions.other` field that never has data. Every payslip with a nonzero advance or condition-rule penalty prints a deductions box that doesn't add up. This is a document handed directly to employees/auditors. |

---

## High-Severity Findings

| # | Area | File:Line | Finding |
|---|---|---|---|
| H1 | Payroll | `payroll.js:328-380` (`GET /final-sheet`) | When no `Payroll` row exists yet for the employee/month, `advances` is read only from `pr.advances` (defaults to 0) — the route never queries the `Advance` table directly, so real advances entered before the "احتساب المرتبات" button is pressed are silently omitted from the printed sheet, overstating net salary. |
| H2 | Payroll | `payroll.js:336-338` (`GET /final-sheet`) | The fallback overtime formula (used when no `Payroll` row exists) applies one flat multiplier to all OT hours, ignoring Friday/holiday/weekend/night-shift multipliers and bonuses that the authoritative `payrollEngine.computePayroll` applies. Displayed overtime/net salary can diverge from what the real engine would produce. |
| H3 | Payroll | `payroll.js:309` vs `payrollEngine.js:135` | Two different definitions of "work day" exist in two files (status-based vs. attendance-flag-based) — a duplicated, divergence-prone derivation of the same KPI shown on reports vs. computed by payroll. |
| H4 | Attendance Engine | `routes/attendance.js:394-406` | HR's `PUT /attendance/daily/:id` lets raw minute fields (`lateMinutes`, `earlyLeaveMinutes`, `overtimeMinutes`, `workedMinutes`) be overwritten directly **without** recomputing the corresponding `*PenaltyUnits`/`totalDeductionUnits` fields that `mergeEffectivePenalty` actually uses for payroll. An HR override of "lateMinutes=0" does not remove the late deduction — displayed minutes and actual money deducted diverge. |
| H5 | Attendance Engine | `attendanceEngine.js:105-134, 280-284, 318-323` | No cross-midnight/overnight-shift model exists. Logs are queried within a fixed calendar-day window and `rawWorkedMinutes` is clamped to 0 when negative. A genuine night-shift employee's checkout lands on the next day's record — worked minutes, OT, and late/early all become wrong for overnight shifts. |
| H6 | Sync/Rebuild | `historicalRebuildService.js:227-274`, `realtimeListenerService.js:190-202` | No row-level lock/transaction serializes a historical rebuild's `processDate` write against a concurrent realtime punch for the same employee/date — last-write-wins on the `attendance_daily` upsert with no advisory lock. |
| H7 | Sync/Rebuild | Frontend/backend socket contract | `rebuild:*`, `relink:start/progress`, `device:gap-warning`, `device:integrity-warning`, `device:topology-warning`, `cleanup:done` are emitted server-side but have zero frontend listeners anywhere in `frontend/src` — rebuild progress, device-health warnings, and duplicate-device alerts are silently dropped, invisible to any operator watching the UI. |
| H8 | Database | `schema.prisma:171` (AttendanceLog→Device FK) | `ON DELETE RESTRICT` blocks hard-deleting any Device that has ever logged a punch. Confirmed correctly worked around everywhere via `Device.isArchived` soft-delete — **no regression found**, but any future code path that calls `prisma.device.delete()` directly will throw. |
| H9 | Database | `schema.prisma:363` (`AttendanceRule.employeeId`) | No `@relation`, no FK, no index on a column `rulesEngine.getRules()` filters on for every single attendance/payroll computation. Employee hard-delete (`employees.js:253-264`) never cleans up matching `attendance_rules` rows — orphaned dangling references with no DB-level protection, plus a full-table-scan performance risk as the table grows. |
| H10 | AG Grid | `frontend/src/pages/EmployeesPage.jsx` | The grid has **no `getRowId`** at all — the exact structural gap that caused the previously-fixed "disappearing rows" bug on other pages before `getRowId` was added there. No user-visible symptom today (page has no live-sync/inline-edit), but it forecloses ever safely adding either without first fixing this. |
| H11 | Print/Reports | `PrintPreviewModal.jsx:159-177` (`REPORT_COLUMNS.adjustments`) | References fields (`employee.code`, `employee.name`, `overtimeHours`, `adjustment.status`) that don't exist on the real `/adjustments/daily` row shape (flat `employeeCode`/`employeeName`/`otHours`/`adjustmentStatus`). Currently dead code (no page wires an "adjustments" print button) — but a landmine identical to the historical movement-report bug the moment someone activates it. |
| H12 | Print/Reports | `SalaryCard.jsx:175-179` | Earnings rows show raw `morningOT.amount + eveningOT.amount` while the summed total uses the canonical (manual-override-aware) `overtimeAmount` — these can diverge whenever a manual OT override or approved adjustment is active. |

---

## Medium-Severity Findings (selected — full detail in each subsystem's original report)

- **Payroll:** advance edits (`PUT /:id/advances`) are read-modify-write without a transaction — concurrent edits can race; `recalcForAdjustment`/`recalcForAdvance` are fire-and-forget, so a client can read stale `netSalary` immediately after a "successful" edit; adjustment approvals/rejections/reverts are never written to `ManualEditAuditLog` (a separate `AdjustmentAuditLog` exists, but the two audit views must both be checked to get the full picture); editing/flagging a previously-approved adjustment resets it to `pending` without triggering a recalc, so payroll can keep reflecting stale approved values.
- **Attendance Engine:** two independently-coded OT formulas exist for Friday depending on the `friday_is_weekend` flag (correct today, but an undocumented dual-formula design); a mid-day punch that's neither the checkin-window match nor the last punch of the day is silently discarded with only a log line, no DB trace; the DB-editable `overtime_rounding` rule (seeded `'50'`) has **zero effect** — actual OT rounding is a hardcoded 10-minute-tolerance-then-floor-60 constant, so editing that rule in the UI is a silent no-op; `weekend_days` has no input validator at all.
- **Sync/Rebuild:** a chunked-reader TCP-write-error log call has a call-site arity bug that silently drops the log line entirely (`zkChunkedAttendanceReader.js:70` vs. `74`); `syncScheduler.js`'s per-device tick error handler swallows errors with zero logging; the historical-rebuild auto-trigger only fires on a fully-converged sync, so a chronically-partial device's old backfill data may never auto-queue a rebuild; `routes/cleanup.js`'s recalculation cascade runs after (not inside) the delete transaction, leaving a window where a punch landing in a just-cleaned date range gets computed against an incomplete log set.
- **Database:** `employees.hourlyRate` is a live DB column with zero representation in `schema.prisma` (drift — the next `prisma db pull` will propose a destructive `DROP COLUMN`); `Employee.zkUserId` (the primary biometric-relink join key) has no uniqueness constraint or index; `AttendanceDaily`/`Payroll` have no standalone index on `date`/`(month,year)` for company-wide (non-per-employee) queries used by dashboard/cleanup/reports; a stale write-capable test script (`audit_s1_test.js`) references two models dropped in a June migration and will throw if ever run.
- **AG Grid:** `RulesPage.jsx` — arguably the highest-stakes editable grid in the app (rule edits directly affect payroll) — is missing every keyboard-nav/edit-safety prop (`singleClickEdit`, `stopEditingWhenCellsLoseFocus`, `tabToNextCell`, `undoRedoCellEditing`) present on every other editable grid; `AttendanceMonthlyPage.jsx`/`PayrollPage.jsx` hardcode `singleClickEdit={true}` with no read-only/edit-mode toggle (unlike Daily/Movement), meaning a stray click immediately opens an editable financial cell.
- **Print/Reports:** `CompactSalarySheet.jsx`'s bulk payslip card has no bonus/"مكافأة" row, so `netSalary` can exceed the visible line-item sum with zero on-page explanation; the Payroll AG-Grid column defs and `PrintPreviewModal`'s `REPORT_COLUMNS.payroll` are two independently hand-maintained copies of the same field list (classic drift risk); a helper built specifically to eliminate that duplication (`agColsToPrintCols()`) is exported but never actually used anywhere.

---

## Low-Severity / Housekeeping Findings

Three independent, near-identical `"HH:MM"→minutes` parser implementations across `rulesEngine.js`/`policyEngine.js`/`ruleValidation.js` (one lacks a null-guard the others have); five dead/unused exported functions in `policyEngine.js`/`rulesEngine.js` implementing an alternate, never-wired relative-minutes penalty tier model; leftover `performance.mark()` tracing calls left in `EmployeeMovementPage.jsx` production code, never cleared; a vestigial `pendingReloadRef` in `RulesPage.jsx` that's set but never actually gates a decision; in-memory-only overlap guards (`processTodayRunning`, recalc debounce queue) that would not protect against overlap if the backend is ever run as multiple processes; `advance.delete` happens before its audit-log write (a crash between the two loses the audit trail for a destructive op); `GET /final-sheet/bulk` silently drops employees without a payroll row from its result list rather than flagging them; documentation drift (`REPORT_05_FRONTEND.md` still describes the salary sheet as 8-per-page/4-row; the current code is a 9-per-page 3×3 grid).

---

## System Map (as verified this session)

```
Fingerprint device (TCP/ZK protocol)
        │
        ├─ realtimeListenerService.js  (push events, CMD_REG_EVENT)  ──┐
        └─ zktecoService.js  (scheduled pull, convergence loop)  ───────┤
                                                                        ▼
                                                          attendance_logs (raw, deduped
                                                          per-deviceId only — see C1)
                                                                        │
                                       ┌────────────────────────────────┤
                                       ▼                                ▼
                       historicalRebuildService.js         relinkService.js (orphan fix)
                       (backfill trigger, checkpointed)                │
                                       │                                │
                                       └──────────────┬─────────────────┘
                                                       ▼
                                        attendanceEngine.processDate()
                                (rulesEngine + policyEngine formulas;
                                 manual-edit / manual-override gate)
                                                       │
                                                       ▼
                                              AttendanceDaily (upsert,
                                          employeeId+date unique key)
                                                       │
                        ┌──────────────────────────────┼───────────────────────┐
                        ▼                               ▼                       ▼
              AttendanceMonthlyPage            EmployeeMovementPage      payrollEngine.computePayroll()
              (AG Grid, read/edit)             (AG Grid, read/edit)               │
                                                                                    ▼
                                                                              Payroll (upsert,
                                                                        employeeId+month+year)
                                                                                    │
                                    ┌───────────────────────────────────────────────┤
                                    ▼                                               ▼
                          PayrollPage (AG Grid)                     GET /payroll/final-sheet
                                    │                          (⚠ independently re-derives
                                    ▼                           formulas — H1/H2/H3)
                        PrintPreviewModal / SalaryCard /
                        CompactSalarySheet / FinalSalaryModal
                                    │
                                    ▼
                      printToPDF (Electron) / Excel export (SheetJS)
```

Rules (`Rule`/`RuleAudit` dynamic table + legacy `AttendanceRule`) and Policy formulas feed `attendanceEngine`/`payrollEngine` at computation time, not by mutating stored rows — a rule edit triggers `recalcEngine` (debounced, current-month-only by default; full-history recalc is an explicit on-demand action).

---

## Regression Check (fixes from prior memory/reports, re-verified this session)

| Prior fix | Status this session |
|---|---|
| `.err` swallowed on partial ZK pull, logged as "success" (2026-06-10) | **Confirmed fixed.** `zktecoService.js:395` requires `converged && !lastZkErr`; partial pulls are correctly marked `status:'partial'` and do not advance the sync checkpoint. |
| `.cell-manual-override{position:relative}` breaking AG Grid cell layout (v2.22.0) | **Confirmed fixed, not reintroduced.** Only the `::after` pseudo-element uses `position:absolute` (the corner dot); no `.ag-cell`/`.cell-*` class anywhere sets `position` on the cell itself. |
| EmployeeMovementPage row-disappearance (stable `gridRows` + external filter) | **Confirmed intact.** Row updates are identity-preserving (`.map()`, never a fresh full-array replace); status filtering uses AG Grid's external-filter API, not `rowData` mutation; `getRowId` is keyed on the real DB id. |
| Stale totals after inline edit (`computeSummaryFromDays`) | **Confirmed intact**, though the underlying mechanism has since evolved from literal `applyTransactionAsync` calls to a documented React-state-swap + `suppressModelUpdateAfterUpdateTransaction` pattern — functionally equivalent, terminology in old memory is stale. |
| Manual overrides surviving historical rebuild / recalc | **Confirmed intact.** `isManuallyEdited()` gate checked before every non-manual `processDate()` call; manual-overlay fields are structurally absent from the reset baseline (`DAILY_RESET`) so a partial Prisma update never touches them. |
| Holiday-matching timezone bug (UTC date truncation) | **Confirmed fixed**, implementation uses `Date.UTC(...)` explicitly to avoid the non-UTC-server shift. |
| `late_limit` / `overtime_rounding` documented as deprecated/inert (rule validation layer, 2026-07-02) | **Confirmed still inert** — zero runtime reads found; `overtime_rounding` specifically means an admin editing it in the UI has no effect, which is a UX gap worth closing (see Medium findings) even though it's not a regression. |
| Duplicate device rows causing punch duplication (2026-06-10 root cause) | **Still an open, live risk** (C1 above) — write-time prevention exists for *new* device rows (`routes/devices.js` blocks creating a duplicate `ip:port`), but pre-existing duplicates are only ever warned about, never merged/deduped, and no ingestion-time cross-device dedup exists. |
| Frontend has no socket listeners on most pages (2026-06-10 root cause) | **Partially resolved, partially open.** Broader page coverage now exists via `useDeviceLiveSync`/`useRulesLiveSync` hooks (Attendance/Payroll/Movement/Dashboard/Rules all wired) — but several specific event types (rebuild progress, integrity/topology warnings) still have zero listeners (H7). |

---

## Dead Code / Unused Exports Inventory

- `policyEngine.js`: `minutesToTime`, `unitsToMoney`, `calcLatePenaltyByMinutes`, `calcEarlyLeavePenaltyByMinutes` (and their backing `DEFAULT_LATE_TIERS`/`DEFAULT_EARLY_LEAVE_TIERS`) — zero callers, an entire parallel penalty-tier model never wired up.
- `rulesEngine.js`: `calcOvertimeHours` — zero callers; the real OT-hour rounding is hardcoded elsewhere.
- `printUtils.js`: `agColsToPrintCols()` — exported, never imported.
- `PrintPreviewModal.jsx`: `REPORT_COLUMNS.adjustments` / `REPORT_LABELS.adjustments` — defined, never wired to any page (and broken if it were, H11).
- `EmployeeMovementPage.jsx`: leftover `performance.mark()` instrumentation calls, never read.
- `backend/audit_s1_test.js` (repo root): references two Prisma models removed by migration `20260620100000_remove_policy_engine`; will throw if executed.

## Circular Dependencies

None found. Verified one-directional dependency flow across every audited engine/service module: routes → engines (`payrollEngine`/`attendanceEngine`) → `rulesEngine`/`policyEngine` → `ruleStore`/Prisma. `rulesEngine.js` and `policyEngine.js` are true leaves (require neither each other nor any other engine file).

---

## Recommendations Summary (descriptive only — no code changed as part of this audit)

1. Design a cross-device dedup pass for `attendance_logs` (e.g., match by `zkUserId + timestamp window` across devices already flagged as duplicate endpoints) rather than relying solely on write-time prevention for new device rows. **(C1)**
2. Make `GET /payroll/final-sheet` delegate to `payrollEngine.computePayroll`/`computeDeductionsBreakdown` instead of independently re-deriving advances/overtime/work-days, closing H1–H3 at the root. **(H1, H2, H3)**
3. Reconcile `SalaryCard.jsx`'s and `CompactSalarySheet.jsx`'s printed deduction/earnings rows against the actual totals they're supposed to foot to — either add the missing bound rows (condition penalty, bonus) or stop including rows (advances) that the total excludes. **(C2, H12, Medium/3)**
4. Either recompute penalty-unit fields whenever their paired raw-minute fields are manually overridden in `PUT /attendance/daily/:id`, or route all penalty changes exclusively through the manual-penalty endpoint. **(H4)**
5. Design an explicit overnight-shift model (configurable shift-day boundary or rolling-window punch pairing) rather than the current fixed calendar-day log window. **(H5)**
6. Add `getRowId` to `EmployeesPage.jsx`'s grid; backport the keyboard-nav/edit-safety props already used elsewhere to `RulesPage.jsx`; add an edit-mode toggle to `AttendanceMonthlyPage.jsx`/`PayrollPage.jsx` matching Daily/Movement. **(H10, Medium/AG-Grid)**
7. Add a proper FK + index to `AttendanceRule.employeeId`; close the `Employee.hourlyRate` schema/DB drift; evaluate a uniqueness constraint on `Employee.zkUserId`. **(H9, Medium/DB)**
8. Wire (or explicitly document as backend-only/log-only) the currently-orphaned `rebuild:*`, `relink:progress`, `device:gap-warning`, `device:integrity-warning`, `device:topology-warning` socket events. **(H7)**
9. Delete or fix `REPORT_COLUMNS.adjustments` before it is ever activated for a real print button. **(H11)**
10. Archive `backend/audit_s1_test.js`; remove or adopt `printUtils.js`'s unused `agColsToPrintCols()`; update `REPORT_05_FRONTEND.md`'s stale 8-per-page salary-sheet description.

---

## Appendix: Subsystem Reports (source detail)

The following six read-only investigations produced this report's findings. Full line-by-line detail, every audited function's purpose/inputs/outputs/callers, and additional Low-severity notes not repeated above are preserved in the session transcript for each:

1. **Attendance Engine & Calculations** — `attendanceEngine.js`, `rulesEngine.js`, `policyEngine.js`, `recalcEngine.js`, `ruleDependencyMap.js`, `ruleValidation.js`, `timestamps.js`.
2. **Payroll Engine & Certification** — `payrollEngine.js`, `routes/payroll.js`, `routes/advances.js`, `routes/adjustments.js`, `manualEditAudit.js`.
3. **Rebuild/Sync/Realtime Pipeline** — `historicalRebuildService.js`, `syncScheduler.js`, `realtimeListenerService.js`, `relinkService.js`, `zktecoService.js`, `zkChunkedAttendanceReader.js`, `deviceIntegrity.js`, `routes/devices.js`, `routes/cleanup.js`.
4. **Database Schema** — `schema.prisma` (22 models), all 13 migrations, existing audit scripts.
5. **AG Grid Rendering** — all 6 grid-bearing pages, `gridDefaults.js`, `cellStyles.js`, grid components, live-sync hooks.
6. **Print/Reports/Export** — `printUtils.js`, `reportTemplate.js`, `PrintPreviewModal.jsx`, `CompactSalarySheet.jsx`, `SalaryCard.jsx`, `FinalSalaryModal.jsx`, `routes/reports.js`, relevant `electron.js` IPC handlers.

No source code, database, or build artifacts were modified in the course of this audit.
