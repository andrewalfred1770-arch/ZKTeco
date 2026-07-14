# PETSHROW ERP v2.0.0 — Final Remediation & Certification Report

**Date:** 2026-06-11 (final validation phase, evening)
**Certified build:** `BUILD: 2026-06-11-final-cert` — installer `dist-electron\PETSHROW ERP-2.0.0-Setup.exe` (134,503,525 bytes, built 19:54)
**Installed & validated at:** `%LOCALAPPDATA%\Programs\PETSHROW ERP\`

---

## Verdict: **PRODUCTION READY WITH WARNINGS**

Upgradeable to **production stable** once the two open items below are closed. Every
infrastructure-level validation passed; the two open items are a live-hardware
confirmation and a business-data prerequisite — not code defects found today.

**Open item 1 — live realtime punch (Task 4, pending human action).**
The production database contains **zero** rows with `source='device-realtime'`:
every punch ever ingested arrived through the recovery/sync path. The realtime
ingest path (`[RT-PUNCH]` → insert → attendance recalc → payroll recalc → socket
emit) is code-complete, hash-verified in the shipped build, and its listener is
connected right now (gen tracking live, diagnostics clean) — but it has never
written to this production DB. A physical punch on 192.168.1.217 while the app
runs is required to close it. Monitoring is armed; the moment a punch occurs the
exactly-once chain can be confirmed from `main.log` + DB.

**Open item 2 — employee salaries are all zero.**
All 31 real employees (ids 19–49) have `salary = 0`, so every June-2026 payroll
row computes to net 0. Verified live: `POST /api/payroll/calculate` ran the
unified engine across all 31 employees correctly (workDays/absentDays computed,
rows rewritten) — the zeros are an input-data state, not an engine fault.
Payroll cannot be considered operational until HR enters base salaries.

---

## 1. All fixes applied (today's final phase — on top of the 13 remediation fixes)

| # | Fix | File |
|---|-----|------|
| F1 | `process.on('unhandledRejection')` handler — non-fatal, logs with stack; benign pipe rejections filtered | `frontend/electron.js` |
| F2 | Persistent file logging restored — console tee to `%APPDATA%\petshrow-erp\logs\main.log` with 5 MB startup rotation (electron-log had been dropped; packaged GUI app had **no log sink at all**) | `frontend/electron.js` |
| F3 | Single-instance `ready` guard — a losing second instance no longer executes startup work (its `killStaleBackend()` could taskkill the primary's live backend during an event-loop stall) | `frontend/electron.js` |

## 2. Root causes resolved

- **Silent main-process death (observed live, 17:32 launch):** renderer alive, main gone,
  port 5000 closed, zero log output. Cause class: unhandled promise rejection in startup →
  Node re-raises as uncaughtException → hardened handler `process.exit(1)` → silent death
  (no console in GUI mode, no file log). F1 removes the fatality; F2 removes the blindness.
  Did not reproduce in 4 subsequent launches (race-dependent); the entire class is now non-fatal and logged.
- **Instance-collision hazard:** NSIS auto-run after silent install + a second manual launch
  showed the loser running diagnostics + port probing before quit. F3 eliminates it.

## 3. Files modified today
`frontend/electron.js` only (3 surgical additions, no architecture change). Backend untouched —
all 13 critical backend files hash-identical between dev tree, win-unpacked, and installed app.

## 4. Realtime lifecycle validation — PASS
- Listener connects on boot (~1.5–7.6 s cold), gen=1; recovery sync pause/resume → gen=3; `issues: []` at every checkpoint.
- Generation ownership proven live: `stale socket close ignored (gen=1, active=2)` during every pause cycle.
- Reconnect-storm evidence (real 2.5 h device-offline window): **118 reconnects scheduled, 112 duplicate requests deduped, 15 stale-generation callbacks ignored, 0 EPIPE, 0 uncaught, 0 diagnostics violations**, backoff capped at 60 s through 67 attempts, exactly one pending timer at all times.
- Automatic clean reconnect the instant the device returned to the network.

## 5. Attendance integrity validation — PASS
- Sync path exactly-once: 27,982 device records converged; re-pulls produced `inserted=0, duplicates=27978/191` (idempotent), `dbTotal` stable at 27,994 across kill/reinstall cycles.
- Checkpoint windowing: post-reinstall first sync processed only 191 recent records, skipped 27,791 older-than-checkpoint; checkpoint = newest valid record (16:08:06).
- `processToday` (10-min owner) correctly materialized today's daily rows (verified: emp 19 check-in 06:09 / check-out 14:03 written at the 20:00 tick).

## 6. Payroll integrity validation — PASS (engine), BLOCKED (data)
- `POST /payroll/calculate` recalculated all 31 employees live; derived fields correct.
- **Warning (design, not regression):** no cron recalculates payroll; recovery-path punches update attendance but leave payroll stale until a realtime punch, manual edit/adjustment, or explicit recalc. Acceptable for month-end-driven payroll, but mid-month payroll views can lag attendance.
- All-zero outputs pending salary data entry (open item 2).

## 7. Migration validation — PASS (carried forward)
`migrate deploy` from empty DB reproduces the schema with zero diff (verified in remediation phase; migrations unchanged since). Live DB connects and serves all APIs.

## 8. Installer validation — PASS
- All 13 critical backend files + preload + frontend dist hash-MATCH source; asar `electron.js` = dev source (`cd8370f0…`); single frontend bundle `index-Be-OhiEV.js` (`57e6c33d…`), no duplicate dist in asar.
- No `backups/`, no `*.log`, no `.env.example`, empty `uploads/` in the package. `.env` ships (runtime requirement, accepted risk).
- Clean reinstall: silent uninstall → 0 files remain → silent install → 4,709 files, hashes match, app boots, DB connects, listener connects.
- **Confirmed live hazard:** reinstall wipes `resources\backend\uploads\` — the company logo file referenced by `cache.json` was already missing from the previous reinstall. Mutable data in the install dir remains a known risk (see §13).

## 9. Electron lifecycle validation — PASS
- Boot: backend ready 1.5–7.6 s; startup diagnostics print build marker, asar path, bundle hash on every launch — now also persisted to `main.log` (verified written in GUI-launch mode).
- Single-instance: loser prints one line and exits; primary unaffected (verified on final build).
- Graceful shutdown on the exact shipped binary: stdin `shutdown` sent **mid-sync** → 5 crons stopped, listener stopped, heartbeat cleared, sockets closed, Prisma disconnected, **exit 0** in ~35 ms.

## 10. Crash-recovery validation — PASS (twice, second time mid-sync)
| Metric | Run 1 (remediation build) | Run 2 (final build, killed mid-sync) |
|---|---|---|
| Backend respawn → port listening | ~4.4 s | ~4.8 s (5.5 s incl. detection) |
| Realtime listener reconnected | ~6.2 s | ~7 s |
| EPIPE / uncaughtException | 0 / 0 | 0 / 0 |
| Electron main survival | yes | yes |
| Renderer socket re-attach | automatic | automatic |
| Duplicate spawns/listeners/timers | none | none |

## 11. Reconnect-stability validation — PASS
See §4 storm evidence. Additionally: listener restart endpoint → clean stop/start fresh gen;
5 concurrent manual syncs → exactly 1 winner, 4 rejected in ~230 ms (`sync already running`);
manual-during-auto and auto-during-manual both rejected; lock owner id matched on acquire/release every time.

## 12. Exactly-once ingestion validation — PASS (sync path) / PENDING (realtime path)
- Sync path: proven repeatedly (idempotent re-pulls, stable dbTotal, unique-key dedupe `P2002` → no-op).
- Realtime path: never exercised against the production DB (0 rows `source='device-realtime'`). Awaiting physical punch (open item 1). The path's retry ladder (3 attempts → falls back to recovery sync) and timestamp quarantine are code-verified in the shipped binary.

## 13. Remaining known risks (accepted or flagged)
1. Mutable `uploads/` lives in the install dir — wiped by every reinstall (logo loss confirmed today). Move to `%APPDATA%` eventually.
2. No payroll recalc trigger on recovery-path ingestion (mid-month staleness; see §6).
3. Event-loop stalls (~10 s/pass) during 27k-record buffer parse — node-zklib synchronous parsing; sync of a full buffer takes 20–30 s with 2 convergence passes.
4. No auth / CORS `*` — accepted for localhost-only desktop.
5. Float money columns; OT rule `overtime_rounding` still dormant (policy engine floor((min+10)/60) is the active math — business decision pending).
6. Overnight shifts unsupported; legacy 1999-epoch junk + cross-deviceId duplicate rows remain in `attendance_logs` (quarantine blocks new garbage only).
7. Heartbeat dead-socket self-heal not separately fault-injected (requires admin firewall rules); covered indirectly by the real offline window + code review. Stuck-connecting watchdog (90 s) untested live for the same reason.
8. NSIS auto-runs the app after silent install — harmless now (F3) but surprising during scripted deployments.
9. `.env` with DB password ships in the installer (runtime requirement, localhost MySQL).

## 14. Long-term scalability concerns
- Single device proven; multiple devices multiply sync windows and the parse stalls (§13.3) — the 1-min master tick + per-device locks should hold, but >3–4 devices warrants moving parsing off the main thread (worker) or chunked merges.
- `attendance_logs` at 58,920 rows incl. legacy duplicates — table will grow ~10–30k/device/year; indexes added in remediation are adequate for years at this site's scale, but the cross-deviceId duplication should be cleaned before any reporting that aggregates across devices.
- Payroll consistency model (manual/event-driven recalc) is fine for one accountant; a scheduled nightly recalc would remove the staleness class entirely.

## 15. Production readiness reassessment
All six audit-day critical defects remain fixed and re-verified on the final build. Today's
phase found and fixed two additional main-process lifecycle defects (silent rejection death,
instance-collision hazard) and restored production observability (main.log). Packaging,
reinstall, crash-recovery, reconnect stability, sync exactly-once, graceful shutdown, and
diagnostics are all demonstrated live on the shipped binary.

**PRODUCTION READY WITH WARNINGS** — close open items 1 (one physical punch observed
end-to-end) and 2 (enter base salaries, re-run payroll) to certify **production stable**.
"Enterprise-grade stable" is intentionally not claimed: no auth, no automated test suite,
no crash telemetry, single-site scale only.
