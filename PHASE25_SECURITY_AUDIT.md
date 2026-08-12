# PHASE 25 — PETSHROW ERP SECURITY AUDIT

**Date:** 2026-08-10
**Environment tested:** Isolated `zkteco_loadtest` DB, backend bound to `127.0.0.1:5099`, `AUTH_ENABLED=true`, fresh random JWT secret. Production DB `zkteco_attendance` (port 5000, PID 1444) was never connected to, queried, or modified.
**Production Data Modified: 0** (confirmed — all test rows created were deleted from `zkteco_loadtest` after testing; test server process terminated; no writes ever targeted `zkteco_attendance`).

This is a **Round 1** audit covering the highest-risk areas end-to-end (code review + live exploitation against the isolated environment). Sections not exercised live this round are listed at the bottom as **Not Yet Tested** — do not read their absence as a PASS.

---

## Executive Summary

**Security Status: SECURE WITH WARNINGS — ONE CRITICAL FINDING BLOCKS "SECURITY READY"**

The authentication layer (JWT, bcrypt, rate limiting), mass-assignment defenses, SQL-injection resistance (Prisma parameterization), Electron hardening (contextIsolation/nodeIntegration/preload/window-open handling), and role gating on the highest-value write operations (payroll finalize, employee delete, rules) are all solid and live-verified.

However, **one Critical broken-access-control finding was reproduced live**: several read endpoints — including full payroll export — check only "is this a valid logged-in user," not "is this user allowed to see this." Any account with the lowest-privilege `employee` role (an account type the application itself creates) can read every employee's salary and export the entire company's payroll.

---

## Findings

### F1 — CRITICAL — Broken Function-Level Authorization / IDOR: low-privilege role reads all salaries and exports full payroll

- **Component:** Backend API — `routes/employees.js`, `routes/reports.js`, `routes/adjustments.js`
- **Endpoints:**
  - `GET /api/employees` — full roster including `salary`
  - `GET /api/employees/:id` — any employee record including `salary`, by ID, regardless of the caller
  - `GET /api/reports/payroll/export` — full company payroll Excel export (all employees, all salaries, all deductions)
  - `GET /api/reports/attendance/monthly/export`, `GET /api/reports/attendance/employee/:id/export` — attendance export for any employee
  - `GET /api/adjustments`, `GET /api/adjustments/:id`, `GET /api/adjustments/:id/audit` — adjustment/deduction records for any employee
  - `GET /api/devices/*` (list, stats, sync-logs, realtime-status, per-device diagnostics)
- **Description:** These routes call only `authenticate` (verifies the JWT is valid) with **no `authorize(...)` role check and no ownership/ID scoping against `req.user`**. Every field is returned regardless of caller role. Contrast: `routes/payroll.js` and `routes/rules.js` correctly apply `router.use(authenticate, authorize('admin','hr'))` — proving the codebase has working RBAC infrastructure that was simply not applied consistently to these routes.
- **Evidence (live, isolated `zkteco_loadtest` env, real HTTP requests, real JWTs):**
  ```
  POST /api/auth/login {username: sectest_employee, role: employee} → 200, valid JWT
  GET /api/employees            (Bearer employee-JWT) → 200, 1100 rows incl. salary
  GET /api/employees/303        (Bearer employee-JWT) → 200, colleague's full record incl. salary
  GET /api/reports/payroll/export?month=1&year=2026 (Bearer employee-JWT) → 200, valid .xlsx, 15785 bytes
  GET /api/reports/attendance/employee/999/export    (Bearer employee-JWT) → 200, valid .xlsx
  GET /api/payroll?month=1&year=2026 (Bearer employee-JWT) → 403 (correctly denied — proves RBAC works elsewhere)
  ```
- **Impact:** Any employee-role account — created legitimately via `POST /api/employees {createUser:true,...}` by an admin/HR user for self-service purposes — can silently harvest every colleague's salary and export the entire company payroll. A leaked or compromised low-privilege credential has near-admin read access to the most sensitive data in the system.
- **Reproduction:** Seed a `role:'employee'` user, log in, call the endpoints above with that token. No special tooling needed — plain `curl`.
- **Fix:** Add `authorize('admin','hr')` to `routes/reports.js` (all three export routes) and `routes/adjustments.js` GET routes. For `routes/employees.js`, either restrict `GET /` and `GET /:id` to `admin`/`hr`, or — if employee self-service viewing is an intended future feature — scope the query to `req.user`'s linked `employeeId` for the `employee` role and keep full access for `admin`/`hr`. Restrict `routes/devices.js` GET routes to `admin`/`hr` (device IPs/diagnostics are not employee-relevant).
- **Retest:** Required after fix — re-run the exact `curl` sequence above with a fresh `employee`-role token; expect 403 on all listed endpoints (or correctly scoped-to-self data, if self-service is intended).

### F2 — HIGH (accepted-by-design, but flagged) — Zero-authentication default when network-reachable

- **Component:** `backend/src/middleware/auth.js`, `backend/src/index.js`, `backend/.env`
- **Description:** Production `.env` ships `AUTH_ENABLED=false` (the documented default for single-user Electron desktop mode) and the server binds `HOST=0.0.0.0` by default. When `AUTH_ENABLED=false`, `authenticate()`/`authorize()` are complete no-ops — **every API endpoint, including payroll and salary data, is open with zero authentication** to anything that can reach the port. CORS (`corsOriginCheck`) restricts *browser*-originated requests to `localhost` origins only in this mode (a real, deliberate prior hardening — see the `EF-007.3` comment in `index.js`), but **CORS is a browser-enforced policy and does not restrict direct HTTP clients** (curl, scripts, another machine's browser making a raw fetch is blocked, but a non-browser tool is not).
- **Impact:** If the host machine is ever reachable on a LAN, via port-forwarding, or from a shared/multi-user Windows machine, any device that can reach port 5000 has full unauthenticated read/write access to all employee, attendance, and payroll data. This is explicitly the accepted trust model for a single isolated desktop install, but nothing in the current config *enforces* that isolation — a misconfigured network is silently catastrophic.
- **Fix (defense-in-depth, doesn't change the desktop UX):** Default `HOST` to `127.0.0.1` unless `AUTH_ENABLED=true` is explicitly set (i.e., require an explicit opt-in to bind beyond loopback), so a network-exposed instance can't happen by accident.
- **Retest:** Confirm default install with unmodified `.env` binds only to `127.0.0.1`.

### F3 — HIGH — Real database password committed to git history

- **Component:** Git history, `backend/.env`
- **Description:** Commit `a1824d5` ("Initial PETSHROW ERP") committed `backend/.env` containing the real `DATABASE_URL` with the MySQL `root` password in plaintext. It was removed from tracking in the very next commit (`fe617a0`), but remains **permanently retrievable** via `git show a1824d5:backend/.env` or `git log -p` by anyone with repo access.
- **Impact:** Full database credential (root) exposed to anyone who clones the repository or has read access to it, regardless of current `.gitignore` state.
- **Fix:** Rotate the MySQL `root` password. Then rewrite git history to purge the blob (`git filter-repo` or BFG Repo-Cleaner) if the repo is ever shared/pushed beyond the current trusted environment.
- **Retest:** Confirm `git log -p -- backend/.env` no longer surfaces a real credential after history rewrite, and confirm the app connects successfully with the rotated password.

### F4 — MEDIUM — `.gitignore` doesn't cover `_loadtest.env`

- **Component:** `backend/.gitignore`
- **Description:** `backend/_loadtest.env` (contains a real-looking DB password, reused from the same root credential) is not matched by the current gitignore patterns (`_loadtest_*` requires a trailing underscore; `.env.*` requires a leading dot) — it's currently untracked only by omission, not by rule.
- **Fix:** Add `_loadtest.env` (and ideally a broader `_*.env` pattern) to `.gitignore`.

### F5 — MEDIUM — Incomplete HTML-escaping in print/report template (attribute-context XSS)

- **Component:** `frontend/src/lib/reportTemplate.js:78-81` (`esc()` helper)
- **Description:** `esc()` escapes `&`, `<`, `>` but **not `"`**. It's used both inside element text content (safe) and inside double-quoted HTML attributes, e.g. `alt="${esc(brand.name)}"`, `src="${esc(brand.logoUrl)}"` (lines ~257, 271-272, 312, 522). A value containing a `"` in an attribute context can break out and inject new attributes (e.g. an `onerror=` handler) into the generated print HTML.
- **Impact:** Currently reachable only via admin-controlled company-branding fields (name/logo URL), which limits real-world exploitability (would require an admin account to plant the payload, i.e. mostly self-XSS or a compromised-admin scenario) — not a remote unauthenticated vector today. Still a genuine escaping gap that should be closed before any field feeding this template becomes less trusted.
- **Fix:** Escape `"` (and ideally `'`) in `esc()`, or use a dedicated attribute-escaping variant for attribute contexts.

### F6 — INFORMATIONAL/interim — Dependency vulnerabilities (full detail from static scan)

Backend: 9 findings (0 Critical / 6 High / 2 Moderate / 1 Low). Most consequential runtime-reachable item: the `socket.io` transitive chain (`ws`, `socket.io-parser`, `socket.io-adapter`, `engine.io` — DoS-class, network-reachable via realtime attendance sync). `xlsx` (direct, High, no upstream fix — prototype pollution/ReDoS) is used at runtime for exports.

Frontend: 25 findings (1 Critical / 20 High / 4 Moderate). The one Critical (`tar`, via electron-builder) and most electron-builder High findings are **build-pipeline-only** risk, not shipped-app risk. The two most consequential **runtime** items: **Electron itself is many majors behind current stable** (direct dependency, is the actual app shell — carries multiple fixed CVEs including context-isolation-bypass and IPC UAF classes), and **axios** (direct, used for every API call — prototype pollution / header-leakage class issues in the installed range).

No `npm audit fix` or upgrades were performed (read-only per Section 16 instructions). Recommend a coordinated Electron + socket.io + axios upgrade pass, tested for regressions, as a follow-up piece of work — not done as part of this audit.

### F7 — LOW/INFO — No `will-navigate` guard in Electron main window

- **Component:** `frontend/electron/windows.js`
- **Description:** `setWindowOpenHandler` is correctly restricted (scheme-checked, always denies new-window creation, hands http/https off to the OS shell) — this is solid. There is, however, no `will-navigate` listener to also block **in-place** navigation of the main window itself to an unexpected origin.
- **Impact:** Low today — mitigated by `contextIsolation:true`, `nodeIntegration:false`, a narrow preload API, and no known XSS/injection vector in this app that could trigger a navigation. Still a standard Electron hardening gap worth closing defensively.
- **Fix:** Add a `will-navigate` handler that only allows navigation to the app's own local origin, denying everything else (mirroring the existing `setWindowOpenHandler` logic).

---

## Section-by-Section Status

| Section | Status | Basis |
|---|---|---|
| Authentication | **PASS** | Live: rate-limited login (10/min), bcrypt + constant-time comparison (anti-enumeration sentinel hash), bad/empty/unknown creds correctly 401/400, tampered-signature JWT rejected, `alg:none` bypass rejected, missing `Bearer` prefix rejected, unauthenticated access to protected routes correctly 401. |
| Authorization | **FAIL** | F1 — read-side authorization is inconsistently enforced (write-side is solid: payroll/employee-delete/rules all correctly 403 an `employee`-role token). |
| IDOR | **FAIL** | F1 — arbitrary employee ID substitution on `GET /api/employees/:id` and `.../export` succeeds for a low-privilege caller. |
| Privilege Escalation | **PASS** (write-path) | Live: `employee`-role token blocked (403) from payroll PUT/finalize, employee DELETE. No `/api/users` endpoint exists at all — no API path to self-elevate a role. Mass-assignment of `role`/`isAdmin`/`id`/`userId` on employee create/update is silently ignored (whitelisted field mapping, verified live). |
| API Security | **WARNING** | Solid method/role enforcement where `authorize()` is applied; F1 is a function-level-authorization gap on GETs; F2 is a config-default risk. |
| SQL Injection | **PASS** | Prisma parameterized queries throughout; only raw-SQL usage (`$executeRawUnsafe` for `OPTIMIZE TABLE`) interpolates from a hardcoded table-name whitelist, never user input. Live SQLi probes (query-param and stored-payload) had no injection effect; data integrity confirmed intact after. |
| XSS | **WARNING** | React's default JSX escaping covers the app UI (no `dangerouslySetInnerHTML`/`innerHTML=` found anywhere in frontend). F5 is a real but narrow gap in the print-template's attribute-context escaping. |
| CSRF | **PASS** (architectural) | Stateless Bearer-JWT auth (`Authorization` header, not cookies) means classic browser CSRF — which relies on automatic cookie attachment — doesn't apply to authenticated calls. |
| Mass Assignment | **PASS** | Live-verified on employee create/update: injected `role`, `isAdmin`, `id`, `userId` fields are ignored; server uses explicit whitelisted field construction, not raw spread. |
| Path Traversal | **NOT YET TESTED** | Deferred to a follow-up round — file upload/export path-handling not exercised live this session. |
| Secrets | **WARNING** | F3 (real prod DB password in git history — High) and F4 (gitignore gap — Medium). Fresh-install JWT secret generation is cryptographically sound (`crypto.randomBytes(48)`), frontend bundle and packaged Electron app carry no server secrets, no AWS/PEM/Firebase keys found. |
| Dependencies | See F6 | Backend: 0C/6H/2M/1L. Frontend: 1C/20H/4M/0L (most Critical/High are build-time-only; Electron + axios + socket.io chain are the real runtime-reachable items). |
| Database | **WARNING** | Credential-exposure issue (F3) aside, no direct evidence of excessive DB-user privilege or unintended remote exposure was gathered this round — **not yet independently audited** (MySQL user grants, remote-bind config). |
| ZKTeco | **NOT YET TESTED** | Static review found no hardcoded device IPs/credentials in source; live device-credential-handling and device-API security not exercised this round. |
| Electron | **PASS** | `contextIsolation:true`, `nodeIntegration:false`, narrow `contextBridge` API (no raw `ipcRenderer`/`require` exposure), `setWindowOpenHandler` scheme-restricted and always denies new windows, packaged app explicitly excludes `.env` from bundled resources. F7 is a minor defense-in-depth gap. |
| EXE | **NOT YET TESTED** | Packaged-EXE writable-directory/local-secret-storage review deferred to a follow-up round. |
| Audit Logs | **NOT YET TESTED** | Tamper/forge/delete testing on audit trail endpoints deferred. |
| Payroll Security | **FAIL** | F1 — payroll export and per-employee salary are readable by a non-admin/HR role; all payroll *write* operations, by contrast, are correctly admin/HR-gated (PASS on that half). |
| Attendance Security | **WARNING** | Read-side shares F1's gap (attendance export by ID, adjustments listing); write-side (recalculate, rule changes) is router-wide admin/HR-gated — not separately live-fuzzed this round. |

---

## Dependency Summary

| Severity | Backend | Frontend |
|---|---|---|
| Critical | 0 | 1 (build-time only — `tar` via electron-builder) |
| High | 6 | 20 |
| Moderate | 2 | 4 |
| Low | 1 | 0 |

Full package-level breakdown available on request — see agent output captured during this session (Electron, axios, and the socket.io chain are the priority runtime-reachable upgrades).

---

## Production Data Modified: 0
## Business Logic Diff: 0
## Payroll Calculation Diff: 0
## Attendance Calculation Diff: 0

All testing ran against `zkteco_loadtest` (synthetic data, 1,100 employees named "Employee L1/L2 N") on a backend instance bound to `127.0.0.1:5099`, fully separate from the production instance on port 5000 (never touched). Test users and test employee rows created for this audit were deleted from `zkteco_loadtest` after testing; the isolated test server process was terminated.

---

## FINAL DECISION: NOT SECURITY READY

**Blocker:**
1. **F1 (Critical)** — broken function-level authorization / IDOR on payroll export and employee salary reads must be fixed and retested before this system can be called secure, if the `employee` role is ever assigned to a real account (which the app itself supports doing).

**Should fix before considering this closed, even though not launch-blocking on their own:**
2. F2 — make network exposure require explicit opt-in (default to loopback-only).
3. F3 — rotate the exposed root DB password; scrub git history.
4. F5 — fix attribute-escaping gap in the print template.
5. F6 — upgrade Electron, axios, and the socket.io dependency chain.

**Deferred to a follow-up round (not yet tested, do not assume PASS):** path traversal, MySQL user-privilege/remote-exposure audit, ZKTeco device-credential live testing, packaged-EXE local-storage/secrets review, audit-log tamper testing, rate-limiting-under-abuse testing, and a full endpoint-by-endpoint IDOR/CSRF sweep beyond the sample tested here.

Per Section 29 (Security Regression): once F1 is fixed, re-run the exact `curl` reproduction sequence in F1's Evidence block with a fresh `employee`-role token against the isolated `zkteco_loadtest` environment, confirm all six endpoint families now return 403 (or correctly self-scoped data), and confirm `admin`/`hr` tokens still get full access with no behavior change.
