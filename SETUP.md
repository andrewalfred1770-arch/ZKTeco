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
   required to log in with a valid user account (created via the same
   **Employees**/user-management flow as any other account) before it can
   use the app.
3. On each Manager Client, run the app once — it shows a first-run
   **Connection Wizard** asking for the Server's address (e.g.
   `http://192.168.1.10:5000`). Test the connection, then Connect; the app
   relaunches pointed at that Server and, since `AUTH_ENABLED=true`, prompts
   for login.

If you skip step 1, Manager Clients can still connect and use the app, but
with **no login enforced** — anyone who can reach the Server's IP on the LAN
can use the API. The Manager app shows a visible warning banner in this case
to make the unsecured state obvious, but does not block usage on its own.
