/**
 * harness.js — boots the REAL routers + engines (from SRC) on an Express app backed by the in-memory fakeDb.
 *
 *   - no database, no .env, no devices, no network beyond 127.0.0.1 ephemeral ports
 *   - the clock is fixed through moment.now (every "today" in the code under test goes through moment())
 *   - SRC can point at a mutated COPY of backend/src (mutation.js); the working tree is never touched
 */
const path = require('path');
const Module = require('module');

const SRC = path.resolve(process.env.CONSISTENCY_SRC || path.join(__dirname, '..', '..', 'src'));
const BACKEND_MODULES = path.join(__dirname, '..', '..', 'node_modules');
process.env.NODE_PATH = [BACKEND_MODULES, process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
Module._initPaths();

// The real backend pins its business timezone before anything formats a date (src/index.js, line 15). This harness boots the
// routers WITHOUT index.js, so it must apply the same guard, from the same SRC, or a host west of UTC would run the code under
// test in a configuration the product never uses (dates stored at UTC midnight would read as the previous local day).
// East of UTC (including the UTC+3 production host) the guard does nothing.
require(path.join(SRC, 'utils', 'businessTimezone.js')).applyBusinessTimezone();

const { createFakeDb } = require('./fakeDb');
const db = createFakeDb();

function stub(rel, exports) {
  const file = require.resolve(path.join(SRC, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] };
}
stub('utils/prisma.js', {
  getPrisma: () => db,
  checkDbConnection: async () => true,
  disconnectPrisma: async () => {},
  getLastDbErrorReason: () => null,
  classifyDbError: () => 'unknown',
});
const silent = { info() {}, warn() {}, error() {}, debug() {}, verbose() {}, log() {} };
stub('utils/logger.js', silent);

const moment = require('moment');
let FIXED_NOW = null;
function setNow(isoLocal) {              // e.g. '2026-10-14T10:00:00' (local time of the process TZ)
  FIXED_NOW = new Date(isoLocal).getTime();
  moment.now = () => FIXED_NOW;
}

const express = require('express');
const http = require('http');
const load = (rel) => require(path.join(SRC, rel));

const app = express();
app.use(express.json());
app.use('/api/attendance', load('routes/attendance'));
app.use('/api/payroll', load('routes/payroll'));
app.use('/api/reports', load('routes/reports'));
app.use('/api/dashboard', load('routes/dashboard'));

let server; let base;
async function start() {
  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
}
async function stop() { await new Promise((r) => server.close(r)); }

async function getJson(url) {
  const res = await fetch(base + url);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}
async function postJson(url, body = {}) {
  const res = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let out; try { out = JSON.parse(text); } catch { out = text; }
  return { status: res.status, body: out };
}
async function putJson(url, body = {}) {
  const res = await fetch(base + url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let out; try { out = JSON.parse(text); } catch { out = text; }
  return { status: res.status, body: out };
}
async function getXlsxRows(url) {
  const XLSX = require('xlsx');
  const res = await fetch(base + url);
  if (res.status !== 200) throw new Error(`export ${url} -> HTTP ${res.status}`);
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
}

// ── scenario helpers ────────────────────────────────────────────────────────────────────────────────────────────────────
const utc = (ds) => new Date(`${ds}T00:00:00.000Z`);          // AttendanceDaily.date / Holiday.date are stored at UTC midnight
const at = (ds, hhmm) => new Date(`${ds}T${hhmm}:00`);        // a punch, local time

let seq = 1;
function emp(over = {}) {
  const id = over.id || (seq++ + 100);
  return { id, name: `Emp ${id}`, code: String(id), status: true, salary: 3000, hireDate: utc('2020-01-01'), effectiveStopDate: null,
           branchId: 1, departmentId: 1, shiftId: 1, position: 'x', isMonitored: false, monitorColor: null, ...over };
}
let rowSeq = 1;
/** A stored AttendanceDaily row. kind: 'present' | 'absent' | 'weekend' | 'holiday' (override any field). */
function day(employeeId, ds, kind = 'present', over = {}) {
  const base = { id: 10000 + rowSeq++, employeeId, date: utc(ds), checkIn: null, checkOut: null, status: kind, isAbsent: false, isWeekend: false, isHoliday: false,
    workedMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0, overtimeHours: 0, morningOvertimeHours: 0, eveningOvertimeHours: 0,
    latePenaltyUnits: 0, earlyCheckoutUnits: 0, totalDeductionUnits: 0, overtimeRulesUnits: null, manualEdit: false,
    manualLatePenaltyUnits: null, manualEarlyPenaltyUnits: null, manualOvertimeUnits: null, absenceType: null, penaltyDays: null };
  if (kind === 'present') Object.assign(base, { checkIn: at(ds, '09:00'), checkOut: at(ds, '17:00'), workedMinutes: 480 });
  if (kind === 'absent') base.isAbsent = true;
  if (kind === 'weekend') base.isWeekend = true;
  if (kind === 'holiday') base.isHoliday = true;
  return { ...base, ...over };
}
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

module.exports = { SRC, db, setNow, start, stop, getJson, postJson, putJson, getXlsxRows, utc, at, emp, day, ymd, load, moment };
