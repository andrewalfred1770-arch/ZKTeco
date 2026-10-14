# ZKTeco Attendance & Payroll System — Setup Guide

## Prerequisites

- Node.js 18+
- MySQL 8.0+
- A ZKTeco fingerprint device on your network

---

## 1. Database Setup

Create a MySQL database:

```sql
CREATE DATABASE zkteco_attendance CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

---

## 2. Backend Setup

```bash
cd backend

# Copy environment file
copy .env.example .env
```

Edit `.env` and set your MySQL credentials:
```
DATABASE_URL="mysql://root:YOUR_PASSWORD@localhost:3306/zkteco_attendance"
JWT_SECRET="change-this-to-a-random-secret"
```

Install and initialize:
```bash
npm install
npx prisma migrate dev --name init
node prisma/seed.js
npm run dev
```

Backend runs on **http://localhost:5000**

---

## 3. Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

Frontend runs on **http://localhost:3000**

---

## 4. Default Login

| Field    | Value      |
|----------|------------|
| Username | `admin`    |
| Password | `admin123` |

**Change this password immediately after first login.**

---

## 5. Add Your First Device

1. Go to **Devices** → **Add Device**
2. Enter device name, IP address (e.g. `192.168.1.201`), port (`4370`)
3. Select branch
4. Click **Test Connection** to verify
5. Click **Sync Now** to pull logs

---

## 6. Add Employees

1. Go to **Employees** → **Add Employee**
2. Fill in name, ZK User ID (the number registered on the device), salary, shift
3. Save

The ZK User ID must match the user ID stored on the fingerprint device.

---

## 7. Configure Attendance Rules

Go to **Attendance Rules** and configure:

- **Work Start / End Time** — e.g. 09:00 / 17:00
- **Late Grace Period** — minutes after start before marking late (default: 20)
- **OT Rounding Period** — every N minutes = 1 OT hour (default: 50)
- **OT Multiplier** — overtime pay rate (default: 1.5×)
- **Weekend Days** — 5=Friday, 6=Saturday (default: `5,6`)

---

## 8. Add Shifts

Go to **Shifts** to define work schedules:
- Morning Shift: 09:00–17:00
- Evening Shift: 14:00–22:00
- Night Shift: 22:00–06:00 (enable Night Shift toggle)

---

## 9. Daily Workflow

The system runs automatically. Manual steps:

1. **Sync** — Click "Sync All Devices" on dashboard (auto-runs every 5 min)
2. **Process** — Click "Process" on Daily Attendance (auto-runs every 10 min)
3. **Payroll** — At month end, go to Payroll → "Calculate Payroll"
4. **Export** — Export Excel/CSV from any screen

---

## Architecture

```
frontend/          React + Vite + Tailwind + AG Grid   (port 3000)
backend/
  src/
    index.js       Express server entry point          (port 5000)
    engines/
      attendanceEngine.js    Processes logs → daily records
      payrollEngine.js       Calculates monthly payroll
      rulesEngine.js         Dynamic rules (company/branch/dept/employee)
    services/
      zktecoService.js       ZKTeco TCP connection & log sync
      syncScheduler.js       Cron: sync every 5min, process every 10min
    routes/        REST API endpoints
  prisma/
    schema.prisma  Database schema
    seed.js        Initial data + admin user
```

---

## Overtime Logic

Policy: **Every 50 minutes = 1 overtime hour**

| Minutes After End | OT Hours |
|-------------------|----------|
| 0–49 min          | 0        |
| 50–99 min         | 1        |
| 100–149 min       | 2        |
| 150–199 min       | 3        |

Configurable via `overtime_rounding` rule.

---

## Production Deployment

```bash
# Backend
cd backend
npm run build  # or use pm2
pm2 start src/index.js --name zkteco-backend

# Frontend
cd frontend
npm run build
# Serve dist/ with nginx or IIS
```

---

## Server Mode & Manager Edition (multi-machine deployments)

The desktop app supports two editions built from this same repository:

- **PETSHROW ERP Server** — runs Electron + React + the full backend (Express,
  Prisma, MySQL, Socket.IO server). This is the default build
  (`npm run electron:build`) and behaves exactly as described above.
- **PETSHROW ERP Manager** — a thin Electron + React client with no backend
  of its own (`npm run electron:build:manager`, in `frontend/`). It connects
  to a Server instance over the network via REST + Socket.IO and never spawns
  a backend process, never opens MySQL, and never runs a migration or seed.

**Single-machine desktop use (one PC, one user) needs no changes** —
`AUTH_ENABLED` stays `false` by default, exactly as today.

**If you deploy a Server instance and connect one or more Manager Clients to
it over a LAN**, you must secure that Server before doing so:

1. In the Server's `.env` (`%APPDATA%\PETSHROW ERP\.env` for a packaged
   install, or `backend/.env` in dev), set:
   ```
   AUTH_ENABLED=true
   JWT_SECRET="a long random string — do not reuse the example above"
   ```
   The backend refuses to start with `AUTH_ENABLED=true` and no real
   `JWT_SECRET` — this is enforced in code, not just documented here.
2. Restart the Server. Every Manager Client connecting to it will now be
   required to log in with a valid user account before it can use the app.
   The Server edition's own window shows the same login screen once
   authentication is on. The application has no screen that creates an
   `admin`/`hr` account (the Employees form only creates `employee`-role
   accounts, which can read company-wide attendance — do not use it in LAN
   mode). Create the first account once, on the Server PC, with the
   operator-run script (never run automatically; it prompts for the password
   at a hidden terminal prompt and never prints it or its hash):
   ```
   cd backend
   node scripts/create-admin-user.js --dotenv-path "%APPDATA%\PETSHROW ERP\.env" ^
        --confirm-database <database name> --username <login> --role admin --dry-run
   ```
   Run it with `--dry-run` first to check the target, then again without it.
   It refuses a remote database host, an ambiguous `DATABASE_URL`, an
   existing username and any role other than `admin`/`hr`. The database
   setup endpoints (`/api/setup/*`) answer only to requests from the Server
   PC itself.
3. On each Manager Client, run the app once — it shows a first-run
   **Connection Wizard** asking for the Server's address (e.g.
   `http://192.168.1.10:5000`). Test the connection, then Connect; the app
   relaunches pointed at that Server and, since `AUTH_ENABLED=true`, prompts
   for login.

If you skip step 1, the Server is **not reachable from the LAN at all**: with
authentication disabled the backend binds to loopback (`127.0.0.1`) only, so
Manager Clients cannot connect. This is deliberate — an unauthenticated API is
never exposed to the network. If `HOST` is explicitly set to a LAN address
(or `0.0.0.0`) while `AUTH_ENABLED` is not `true`, the backend refuses to
start (exit code 78) and prints what to fix. `AUTH_ENABLED` accepts `true` /
`false` in any letter case; any other value is treated as `false` and logged
as a warning. With `AUTH_ENABLED=true` and `HOST` unset the Server listens on
all interfaces (`0.0.0.0`) as before. Windows Firewall rules are not managed
by the app — open the port only on networks you trust.

---

## Data Cleanup tool and approved payroll

The admin-only **Data Cleanup** page ("تنظيف الحركات") deletes old raw punches, daily attendance results and payroll rows for a
date range. **Finalized and paid payroll is protected and can never be deleted with this tool**, whatever is sent to the API:

- **Payroll (monthly totals):** refused if *any* finalized/paid payroll exists in the months the range touches (even if the same
  month also contains draft rows — the whole request is refused and nothing is deleted). Ranges that contain only draft payroll
  can still be cleaned as before.
- **Daily attendance results:** refused for the same months, because they are the basis of the approved payroll.
- **Raw punches:** still allowed. The follow-up recalculation is **not** run for an employee in a month where that employee's
  payroll is finalized/paid, so the approved payroll and the attendance rows behind it are never rewritten.
- The Preview step shows the protected counts per status and month; the Execute step re-checks inside the database transaction
  (rows are locked), and a refused attempt is recorded in the cleanup history with status `blocked`.
- There is no confirmation checkbox that bypasses this (`confirmFinalizedPayroll` is ignored). To purge old approved payroll you
  need a separate, deliberate archive procedure — it is intentionally not part of this tool.
- Unchanged safeguards: admin only, typed confirmation, executor name, extra confirmation for the current month, optional Excel
  backup of what is deleted (partial snapshot — it is not a restore point; take a database backup first).
