# PHASE 25.1 — F2 & F5 FIX REPORT
## Windows Server + Mac Client + Local Mode architecture

**Date:** 2026-08-10
**Environment:** Fixes implemented in source; live-tested via real server boots against the isolated `zkteco_loadtest` DB (127.0.0.1, ports 5095-5099, never production port 5000). Production Data Modified: 0.

---

## Architecture

**Windows = Server / Source of Truth.** Owns MySQL, ZKTeco device communication, and all business logic (payroll/attendance/rules engines). Confirmed by code: `zktecoService.js` and all Prisma/MySQL access live exclusively in `backend/`, which only ever runs on the Windows machine.

**Mac = Authenticated Client.** The existing "Manager" edition (`frontend/.env.manager`, `build:manager` / `electron:build:manager:mac` scripts, already present in the codebase before this phase) is a separate Electron build that talks to the Windows backend over the PETSHROW HTTP/Socket.IO API only. Confirmed by code review: the Manager client's IPC/preload surface (`connectionSettings.js`, `ipc.js`) exposes only an API base URL and a JWT session token (`session:save/load/clear`) — no MySQL connection string, no ZKTeco device address, no database driver, ever ships to or is reachable from the Mac. This was true of the existing architecture already; no new code was needed to enforce it, only the network-binding rule below.

---

## F2 — Production Authentication / Network Exposure

### Fix implemented

New centralized module `backend/src/config/securityConfig.js` — the single place that decides what interface the backend may bind to, given `AUTH_ENABLED`:

- `AUTH_ENABLED=false` (Local Mode) → may only bind to a loopback address (`127.0.0.1`, `localhost`, `::1`). If `HOST` is explicitly set to anything else, the process logs a clear error and calls `process.exit(1)` **before** ever opening a socket. No default ever resolves to a network-reachable address in this mode.
- `AUTH_ENABLED=true` (Server/LAN Mode) → may bind to any interface, including `0.0.0.0`, with no restriction (JWT is enforced on every protected route in this mode).

`backend/src/index.js` now calls `resolveSecureHost(AUTH_ENABLED, process.env.HOST)` instead of the previous unconditional `process.env.HOST || '0.0.0.0'` default. Production's actual `.env` (`AUTH_ENABLED=false`, no `HOST` set) now resolves to `127.0.0.1` automatically — **the fix closes the exposure without requiring any `.env` edit.** Server Mode operators who set `AUTH_ENABLED=true` and leave `HOST` unset keep the pre-existing EP-009 behavior of defaulting to `0.0.0.0` (LAN-reachable with zero extra config), so nothing changes for that deployment path.

### Live test results (real server process, isolated `zkteco_loadtest` DB)

| Test | Config | Result |
|---|---|---|
| A | `AUTH_ENABLED=false`, `HOST=127.0.0.1` (explicit) | **PASS** — bound `127.0.0.1:5099`, API reachable locally |
| B | `AUTH_ENABLED=false`, `HOST=0.0.0.0` (explicit) | **PASS (fail-safe)** — process printed `[SECURITY] Unsafe configuration: AUTH_ENABLED=false cannot be used with HOST=0.0.0.0 ...` and exited with code 1; `netstat` confirmed **nothing** listening on the port |
| C | `AUTH_ENABLED=true`, `HOST=127.0.0.1` (explicit) | **PASS** — bound and served correctly |
| D | `AUTH_ENABLED=true`, `HOST=0.0.0.0` (explicit) | **PASS** — bound `0.0.0.0:5096`; unauthenticated requests to `/api/payroll`, `/api/employees`, `/api/attendance/monthly`, `/api/reports/payroll/export`, `/api/rules` all returned **401**, no data leaked |
| Production-default | `AUTH_ENABLED=false`, `HOST` unset (matches shipped `.env` exactly) | **PASS** — bound `127.0.0.1:5095` only (was `0.0.0.0` before this fix); confirmed via `netstat` |
| Local Mode UX regression | `AUTH_ENABLED=false`, `HOST=127.0.0.1` | **PASS** — `GET /api/employees` with no token returned `200` + full data, exactly as before. No login screen introduced, no functional regression. |

**Unsafe combination (`AUTH_ENABLED=false` + non-loopback bind): BLOCKED**, live-confirmed at the process level (not just unit-tested).

### Mac client architecture (documented, not live-tested — see Section 19 below)

```
Windows PC (Server)                       Mac (Manager Client)
├─ PETSHROW Backend (HOST=0.0.0.0,        ├─ PETSHROW Manager build
│  AUTH_ENABLED=true)                     │  (electron:build:manager:mac)
├─ MySQL (must stay localhost-only —      ├─ Connects to Windows API base URL
│  see open finding below)                │  (connectionSettings.js)
├─ ZKTeco device (USB/serial/LAN to       ├─ Stores only: API base URL + JWT
│  the device, backend-owned)             │  session token (session:save/load)
└─ Business logic (payroll/attendance/    └─ No DB driver, no MySQL credentials,
   rules engines) — all server-side          no ZKTeco address ever present
```

To run this mode: set `AUTH_ENABLED=true` on the Windows backend's `.env` (leave `HOST` unset to keep the automatic `0.0.0.0` LAN-reachable default, or set it explicitly), create a manager-role login via the existing employee `createUser` flow or a seeded `User` row, then point the Mac Manager build's connection settings at `http://<windows-lan-ip>:5000` and log in with that account.

### Mac → MySQL / Mac → ZKTeco

- **Mac → MySQL: architecturally BLOCKED** — the Manager client contains no MySQL driver, connection string, or credential anywhere in its code or IPC surface (confirmed by grep across `frontend/electron/*.js`). It cannot reach MySQL through the app even if it wanted to; it would have to open a raw TCP connection to port 3306 itself, same as any other device on the LAN.
- **Open finding (not part of F2/F5, reported per your instruction not to fix it now):** MySQL 8.0 on this machine is currently listening on `0.0.0.0:3306` (no `bind-address` set in `my.ini` — the Windows-installer default), meaning the database port itself is reachable from the LAN today, independent of the PETSHROW app. The app always connects via `localhost`, so this has no functional purpose. **You asked me not to modify or restart the production MySQL service during this audit** — this is recorded as an open item for a scheduled maintenance window: add `bind-address=127.0.0.1` to `C:\ProgramData\MySQL\MySQL Server 8.0\my.ini` and restart the MySQL service. This is a brief production-adjacent interruption (the currently-running backend on port 5000 shares this MySQL instance and will reconnect automatically after restart), which is why it wasn't done automatically.
- **Mac → ZKTeco: architecturally BLOCKED** — `zktecoService.js` (the only ZKTeco device-communication code in the repo) exists solely in `backend/`, which only runs on the Windows machine. No ZKTeco device address, port, or protocol code exists anywhere in the frontend/Electron/Manager-client code.

### Firewall (Section 10)

**Could not be verified this session** — `Get-NetFirewallRule` requires elevated (admin) PowerShell and returned "Access is denied" under the current session's privileges. Recommend running as Administrator: confirm only the PETSHROW API port (5000, or whatever `PORT` is configured to) has an inbound-allow rule for the LAN/Private profile, and that port 3306 (MySQL) has no such rule (Windows Firewall blocks inbound-by-default on unlisted ports, so absence of a rule is itself a pass — but should be explicitly confirmed, not assumed).

### Network failure behavior (Section 12)

Not live-tested against a real Mac (see Section 19), but the underlying mechanism already exists and was confirmed present by code review, unmodified by this phase: `frontend/src/components/ConnectionStatusBanner.jsx` + `frontend/src/hooks/useRulesLiveSync.js`'s `createGuardedReload` — a guarded reconnect-triggered reload (only fires on a genuine `disconnected/reconnecting → connected` transition, never on a normal mount) that was built and live-tested in a prior phase (EP-025 Connection Recovery, see project memory). This phase did not touch that code.

---

## F5 — Print Template HTML Escaping

### Fix implemented

`frontend/src/lib/reportTemplate.js`'s single, centralized `esc()` helper (the only HTML-escaping function in the frontend — confirmed via repo-wide grep, no duplicates) now escapes all 5 HTML-significant characters instead of 3:

```js
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
```

All 24 call sites in the file (element text content: table cells, labels, headers, footers; **and** attribute contexts: `alt="${esc(...)}"`, `src="${esc(...)}"` for company logo/branding) use this same function — no separate/duplicate escaping logic exists elsewhere, so this one change closes the gap everywhere it applied.

### Test matrix results

| Input | Escaped output | Result |
|---|---|---|
| `Company "Name"` | `Company &quot;Name&quot;` | PASS |
| `Company <Name>` | `Company &lt;Name&gt;` | PASS |
| `Company & Sons` | `Company &amp; Sons` | PASS |
| `Company 'Name'` | `Company &#39;Name&#39;` | PASS |
| `<script>alert(1)</script>` | `&lt;script&gt;alert(1)&lt;/script&gt;` | PASS — no executable markup |
| `شركة "بتشرو" للأنظمة` (Arabic + quotes) | `شركة &quot;بتشرو&quot; للأنظمة` | PASS — Arabic characters unaffected (no HTML significance), quotes correctly escaped |
| Attribute-breakout attempt: `"><img src=x onerror=alert(1)>` used as `brand.name` inside `alt="${esc(brand.name)}"` | `<img src="logo.png" alt="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">` | **PASS** — payload stays fully inside the `alt` attribute as literal text; no new tag or event handler is created |

### Print regression

Verified by direct inspection of all 24 `esc()` call sites: every one already routes through this single function today (before and after the fix), so the change is a drop-in tightening of an existing, universally-applied escaping step — not a new code path. `cssStr()`, the separate helper used for the one CSS `content:` property (line 556), is untouched and independently scoped, so no interaction risk there. No layout-affecting code was touched — only the character-substitution table inside `esc()`. Arabic text (which contains none of the 5 escaped characters in normal use) round-trips unchanged, confirmed in the test matrix above. A full rendered-PDF visual diff across every report type (salary statement, payroll, attendance, employee reports) was not performed this session — recommend a quick visual spot-check next time those reports are generated, though the code-path analysis above gives high confidence of no regression.

---

## Remaining Security Findings (not touched this phase, per instruction)

- **F1 (Critical, still open):** Broken function-level authorization on `GET /api/employees`, `GET /api/reports/payroll/export`, `GET /api/reports/attendance/*/export`, `GET /api/adjustments`, `GET /api/devices/*` — any `employee`-role account can read all salaries and export full payroll. **Not fixed in this phase.**
- **F3 (High, still open):** Real MySQL root password permanently retrievable from git history (initial commit). **Not fixed in this phase.**
- **F4 (Medium, still open):** `.gitignore` doesn't cover `_loadtest.env`. **Not fixed in this phase.**
- **F6 (dependency findings, still open):** Outdated Electron (direct runtime dependency), axios, and the socket.io DoS-class chain. **Not fixed in this phase.**
- **New open item (found during this phase's Section 8 verification, deferred at your request):** MySQL bound to `0.0.0.0:3306` instead of `127.0.0.1:3306` — schedule `bind-address=127.0.0.1` + service restart for a maintenance window.
- **Firewall rule audit:** blocked this session by lack of admin PowerShell privileges — needs to be run elevated.

---

## Business Logic / Data Integrity

- Payroll Calculation Diff: **0** — no payroll/attendance/rules engine files touched.
- Attendance Calculation Diff: **0** — no attendance engine files touched.
- Employee identity / ID-mapping logic: untouched.
- ZKTeco logic: untouched.
- Database schema: untouched.
- API contracts (request/response shapes): untouched — only the server's bind-address resolution and one HTML-escaping helper changed.
- Production Data Modified: **0** — all live tests ran against `zkteco_loadtest` on isolated ports (5095-5099); production's port-5000 process was never connected to, and its MySQL database was never queried or written to.

---

# F2 FINAL RESULT

## Architecture
Windows = Server / Source of Truth. Mac = Authenticated Client (existing Manager edition, API-only, confirmed no DB/device credentials in its code).

## Local Mode
`127.0.0.1` + authentication disabled → **PASS** (live-tested: starts, no login required, full functionality, confirmed not network-reachable via `netstat`)

## Server/LAN Mode
`0.0.0.0` + authentication required → **PASS** (live-tested: starts, unauthenticated requests to 5 sensitive endpoint families all returned 401, no data leaked)

## Unauthorized Network Exposure
**BLOCKED** — live-tested: the unsafe combination causes the real server process to exit before opening a socket.

## Mac → API
**NOT YET LIVE TESTED** — no physical Mac available this session. Architecture, connection-settings mechanism, and required configuration are documented above; the Manager edition already exists in the codebase (pre-dates this phase) and its client-side connection code was reviewed, but end-to-end login/data-access/permission behavior on a real Mac has not been exercised.

## Mac → MySQL
**BLOCKED** (architecturally — no MySQL driver/credentials anywhere in the Mac client's code). Underlying MySQL service itself is currently over-exposed at the network-binding level (see open finding above); that is a separate, deferred item, not a Mac-client-code issue.

## Mac → ZKTeco
**BLOCKED** (architecturally — no ZKTeco code exists outside `backend/`, which only runs on Windows).

## Authentication
**PASS** — enforced in Server/LAN mode, live-verified (401 on all tested protected endpoints without a token).

## Authorization
**NOT FULLY PASS** — the existing admin/hr role-gating on write operations works correctly (live-verified in the Phase 25 audit), but F1 (broken authorization on several read/export endpoints) remains open and unfixed in this phase, per your explicit instruction to only fix F2/F5. Do not read "Authentication: PASS" as "the API is safe to expose to untrusted users" until F1 is resolved.

## Firewall
**WARNING — could not verify** (requires elevated PowerShell, not available this session).

## Payroll Calculation Diff
0

## Attendance Calculation Diff
0

## Production Data Modified
0

## Final Status

**F2: PASS** — all tested requirements (Local Mode, Server/LAN Mode, unsafe-combination blocking, unauthenticated-request rejection) verified live against the isolated environment.

**F5: PASS** — full 5-character escaping verified against the required test matrix including an attribute-breakout attempt; no regression path identified via full call-site review.

**Overall Phase 25.1: PASS for F2 and F5 specifically.** This does **not** mean "PETSHROW is secure" — F1, F3, F4, F6, the MySQL bind-address exposure, and the firewall audit remain open and are explicitly out of scope for this phase.
