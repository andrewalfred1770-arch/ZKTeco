/**
 * deviceUserDiscoveryService.js — detects people registered on ZKTeco devices that have no
 * matching PETSHROW employee yet, so the Employees page can show them ("أشخاص جدد على أجهزة البصمة").
 *
 * READ-ONLY by construction. It never creates/links/edits employees, never writes attendance, and
 * never modifies anything on a device: the only device operation is zktecoService.readDeviceUsers(),
 * i.e. the existing getUsers() protocol read, run through the SAME exclusive device lease + connection
 * path as pullLogs / getDeviceUsers (so it can never overlap a sync or the realtime listener). It also
 * never writes Device status / error counters (a discovery connection must not mask sync health).
 * Attendance punch logs are NOT used — they do not list registered users.
 *
 * The device's realtime channel only reports attendance events (EF_ATTLOG), not enrollment, so new
 * users are found by a bounded polling scan: sequential across devices, one run at a time, each device
 * read has a hard deadline, and a failure on one device never stops the others or the attendance sync.
 *
 * Only devices with autoSync enabled are scanned (same eligibility as the scheduler and the realtime
 * listener). A device that fails is retried with a growing back-off (15 → 30 → 60 min) so unreachable
 * devices cannot cause a retry storm; a manual scan bypasses the back-off. A device the scheduler already
 * knows is OFFLINE (with errors) is not contacted; a reachable device whose last SYNC errored is scanned
 * normally and never mislabelled offline.
 *
 * A scan pauses a device's realtime listener for a few seconds. Punches made in that window are only
 * recovered by the next pull, so after any read that paused a device (and whose sync is healthy) the
 * scan asks the existing scheduler for a prompt catch-up (hook, see setCatchUpHook) — it never pulls itself.
 *
 * Matching (same canonical rule pullLogs uses to link a punch to an employee): a device user is
 * "linked" when ANY employee has Employee.zkUserId === the device user id (employee status irrelevant).
 * Never matched by name. Identity of a listed entry is (deviceId, zkUserId). The list is computed at READ
 * time from the last scan snapshot + the current employees, so linking/creating an employee removes the
 * entry immediately and a re-scan can never duplicate it.
 *
 * "Available" = registered on a scanned device AND not claimed by any employee. An ID is claimed when an employee holds it as zkUserId
 * (the punch-linking rule above) OR as code: routes/employees.js assertActiveNumberAvailable() refuses a new employee whose number equals
 * either column of ANY employee, active or stopped, so such a device user could never be added (they are reported under `reserved`, not
 * offered). Nothing is invented: the protocol exposes no free-slot range (getInfo returns counts and log capacity, not a user-id range),
 * so every offered ID is one a device actually reported. The view is deliberately auditable: each device carries how many users it
 * reported and how they split (new / already employees / reserved), `people` merges the same ID seen on several devices into ONE entry
 * (so it can be added once), and `skipped` lists devices that are not scanned at all (autoSync off).
 *
 * State is in-memory only (no schema change): after a restart the first scan repopulates it.
 */
const logger = require('../utils/logger');

const MAX_NAME_LEN = 60;
const BACKOFF_BASE_MS = 15 * 60 * 1000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;
const BACKOFF_SLACK_MS = 60 * 1000;           // scans land on 15-min boundaries; don't skip one for 1 min of jitter
const BACKOFF_REASONS = new Set(['offline', 'timeout', 'error', 'unsupported']);
// The device PIN is a fixed 9-byte ASCII field and an employee number may not contain whitespace — keep in step with
// routes/employees.js (MAX_EMPLOYEE_NUMBER_LENGTH / HAS_WHITESPACE; a regression test compares them).
const MAX_EMPLOYEE_NUMBER_LENGTH = 9;
const HAS_WHITESPACE = /[\s\u200B-\u200F\u202A-\u202E\uFEFF]/;

/** Device-reported user id → canonical comparison form (trimmed string); '' when unusable. */
function normalizeDeviceUserId(v) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/\0/g, '').trim();
}

/** Why a device user id can never become an employee number (null = it can). */
function idProblem(id) {
  if (id.length > MAX_EMPLOYEE_NUMBER_LENGTH) return 'too_long';
  if (HAS_WHITESPACE.test(id)) return 'has_whitespace';
  return null;
}

/** Device-reported name → safe display string, or null when the device gave none. */
function normalizeDeviceName(v) {
  if (v === undefined || v === null) return null;
  // eslint-disable-next-line no-control-regex
  const s = String(v).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, MAX_NAME_LEN) : null;
}

/**
 * @param {object} deps
 * @param {() => Promise<Array<{id:number,name:string,status?:string,consecutiveErrors?:number}>>} deps.listDevices  enabled, non-archived, autoSync devices
 * @param {(deviceId:number, io?:any, opts?:{signal?:AbortSignal}) => Promise<{ok:boolean, users?:Array<{userId:*,name:*}>, reason?:string, paused?:boolean}>} deps.readUsers  never throws
 * @param {() => Promise<Array<{zkUserId:string|null, code?:string|null}>>} deps.listEmployeeNumbers  every employee row's zkUserId and code (any status)
 * @param {() => Promise<Array<{id:number,name:string}>>} [deps.listSkippedDevices]  enabled devices that are NOT scanned (autoSync off), reported only
 * @param {(deviceId:number) => void} [deps.requestCatchUp]  asks the scheduler for a prompt pull of that device
 * @param {() => number} [deps.now]
 */
function createDiscovery({ listDevices, readUsers, listEmployeeNumbers, listSkippedDevices = null, requestCatchUp = null, now = () => Date.now() }) {
  /** deviceId -> { deviceId, deviceName, status, attemptedAt, scannedAt, failStreak, nextTryAt, users: Map<zkUserId,{zkUserId,name,firstSeenAt}> } */
  const devices = new Map();
  let scanning = null;                     // the in-flight scanAll() promise (non-overlap guard)
  let abort = null;                        // AbortController of the in-flight run
  let stopped = false;                     // set at shutdown: no new scans, in-flight one is aborted
  let lastSignature = '';                  // last published visible state, for change-only events

  const iso = (ms) => new Date(ms).toISOString();

  async function currentView() {
    const linked = new Set();      // held as zkUserId by some employee → the punch already belongs to them
    const codes = new Set();       // held only as code → cannot be reused for a new employee (409), so never offered
    for (const e of await listEmployeeNumbers()) {
      const z = normalizeDeviceUserId(e && e.zkUserId);
      if (z) linked.add(z);
      const c = normalizeDeviceUserId(e && e.code);
      if (c) codes.add(c);
    }
    const items = [];
    const deviceStates = [];
    const reserved = new Map();    // zkUserId -> Set<deviceId> (occupied through code only)
    for (const d of devices.values()) {
      let newCount = 0, linkedCount = 0, reservedCount = 0;
      for (const u of d.users.values()) {
        if (linked.has(u.zkUserId)) { linkedCount++; continue; }            // already an employee → not "new"
        if (codes.has(u.zkUserId)) {
          reservedCount++;
          if (!reserved.has(u.zkUserId)) reserved.set(u.zkUserId, new Set());
          reserved.get(u.zkUserId).add(d.deviceId);
          continue;
        }
        newCount++;
        items.push({ key: `${d.deviceId}:${u.zkUserId}`, deviceId: d.deviceId, deviceName: d.deviceName, zkUserId: u.zkUserId, name: u.name });
      }
      deviceStates.push({
        deviceId: d.deviceId, deviceName: d.deviceName, status: d.status, scannedAt: d.scannedAt, attemptedAt: d.attemptedAt,
        // How many users the last SUCCESSFUL read returned and how they split — lets the operator check nothing was dropped.
        reported: d.scannedAt ? d.users.size : null, newCount, linkedCount, reservedCount,
      });
    }
    items.sort((a, b) => (a.deviceName || '').localeCompare(b.deviceName || '') || a.zkUserId.localeCompare(b.zkUserId, undefined, { numeric: true }));
    deviceStates.sort((a, b) => a.deviceId - b.deviceId);

    // One entry per user id, however many devices report it (adding it twice is impossible anyway: one employee per number).
    const byId = new Map();
    for (const it of [...items].sort((a, b) => a.deviceId - b.deviceId)) {
      let p = byId.get(it.zkUserId);
      if (!p) { const problem = idProblem(it.zkUserId); p = { key: it.zkUserId, zkUserId: it.zkUserId, name: null, addable: !problem, problem, devices: [], names: [] }; byId.set(it.zkUserId, p); }
      p.devices.push({ deviceId: it.deviceId, deviceName: it.deviceName });
      if (it.name) {
        p.names.push({ deviceId: it.deviceId, deviceName: it.deviceName, name: it.name });
        if (!p.name) p.name = it.name;                                       // lowest device id wins, deterministically
      }
    }
    const people = [...byId.values()].map((p) => {
      const distinct = new Set(p.names.map((n) => n.name.toLowerCase()));
      return { ...p, nameConflict: distinct.size > 1 };
    }).sort((a, b) => a.zkUserId.localeCompare(b.zkUserId, undefined, { numeric: true }));

    let skipped = [];
    if (!stopped && typeof listSkippedDevices === 'function') {   // a stopped service touches nothing (the view is still served)
      try { skipped = (await listSkippedDevices()).map((d) => ({ deviceId: d.id, deviceName: d.name, reason: 'autosync_off' })); }
      catch (err) { logger.warn(`[USER-DISCOVERY] skipped-device list failed: ${err.message}`); }
    }
    return {
      items, count: items.length, people, peopleCount: people.length, devices: deviceStates, skipped,
      reserved: [...reserved.entries()].map(([zkUserId, ids]) => ({ zkUserId, deviceIds: [...ids].sort((a, b) => a - b) }))
        .sort((a, b) => a.zkUserId.localeCompare(b.zkUserId, undefined, { numeric: true })),
      neverScanned: devices.size === 0,
    };
  }

  const signatureOf = (view) =>
    // 'busy' is a transient skip (another operation held the device) — it must not look like a change.
    JSON.stringify([view.items.map((i) => `${i.key}|${i.name ?? ''}`), view.devices.map((d) => `${d.deviceId}|${d.status === 'busy' ? 'ok' : d.status}`)]);

  async function scanOne(device, io, { force, signal }) {
    const t = now();
    const prev = devices.get(device.id);
    const rec = prev || { deviceId: device.id, deviceName: device.name, status: 'pending', attemptedAt: null, scannedAt: null, failStreak: 0, nextTryAt: 0, users: new Map() };
    rec.deviceName = device.name;
    devices.set(device.id, rec);

    // Retry back-off after repeated failures — keeps unreachable devices from being hammered every scan.
    if (!force && rec.nextTryAt && t < rec.nextTryAt) return;

    // The scheduler already knows this device is unreachable (offline WITH errors): don't add connect-timeout load.
    // (A reachable device whose last SYNC errored has status 'error' and IS scanned — it is not offline.)
    if (!force && device.status === 'offline' && (device.consecutiveErrors || 0) >= 1) {
      rec.status = 'offline';
      rec.attemptedAt = iso(t);
      return;
    }

    rec.attemptedAt = iso(t);
    let res;
    try {
      res = await readUsers(device.id, io, { signal });
    } catch (err) {                                      // readUsers must not throw, but never trust it
      logger.warn(`[USER-DISCOVERY] device=${device.id} read threw: ${err && err.message}`);
      res = { ok: false, reason: 'error' };
    }

    // The read paused this device's realtime listener → arrange a prompt catch-up pull (through the existing
    // scheduler, never from here). Not when the device's sync is already failing: backoff must stay in charge.
    if (res && res.paused && typeof requestCatchUp === 'function' && (device.consecutiveErrors || 0) === 0) {
      try { requestCatchUp(device.id); } catch (err) { logger.warn(`[USER-DISCOVERY] catch-up request failed: ${err.message}`); }
    }

    if (!res || !res.ok) {
      // Keep the previous snapshot: a failed scan must neither wipe the list nor re-announce anything.
      const reason = res && ['busy', 'offline', 'unsupported', 'error', 'timeout', 'aborted', 'not_found'].includes(res.reason) ? res.reason : 'error';
      if (reason === 'aborted') return;                  // shutdown: leave the record exactly as it was
      rec.status = reason;
      if (BACKOFF_REASONS.has(reason)) {
        rec.failStreak += 1;
        const wait = Math.min(BACKOFF_BASE_MS * 2 ** (rec.failStreak - 1), BACKOFF_MAX_MS);
        rec.nextTryAt = t + wait - BACKOFF_SLACK_MS;
      }
      return;
    }

    const seen = new Set();
    for (const raw of Array.isArray(res.users) ? res.users : []) {
      const zkUserId = normalizeDeviceUserId(raw && raw.userId);
      if (!zkUserId || seen.has(zkUserId)) continue;     // skip blanks and in-scan duplicates
      seen.add(zkUserId);
      const name = normalizeDeviceName(raw.name);
      const existing = rec.users.get(zkUserId);
      rec.users.set(zkUserId, { zkUserId, name, firstSeenAt: existing ? existing.firstSeenAt : iso(t) });
    }
    for (const id of [...rec.users.keys()]) if (!seen.has(id)) rec.users.delete(id);   // removed from the device
    rec.status = 'ok';
    rec.scannedAt = iso(t);
    rec.failStreak = 0;
    rec.nextTryAt = 0;
  }

  /** One non-overlapping pass over all eligible devices. `force` (manual scan) bypasses the back-off. Returns the view. */
  function scanAll(io, { force = false } = {}) {
    if (stopped) return currentView();                   // shutting down: never start a scan
    if (scanning) return scanning;                       // join the in-flight run — never start a second
    abort = new AbortController();
    const { signal } = abort;
    scanning = (async () => {
      try {
        let list = [];
        try { list = await listDevices(); }
        catch (err) { logger.warn(`[USER-DISCOVERY] device list failed: ${err.message}`); }
        const liveIds = new Set(list.map((d) => d.id));
        for (const id of [...devices.keys()]) if (!liveIds.has(id)) devices.delete(id);   // disabled/archived/autoSync-off/deleted
        for (const device of list) {
          if (signal.aborted) break;                     // shutdown requested between devices
          try { await scanOne(device, io, { force, signal }); }
          catch (err) { logger.warn(`[USER-DISCOVERY] device=${device.id} scan failed: ${err.message}`); }
        }
        const view = await currentView();
        if (signal.aborted) return view;                 // no events while shutting down
        const sig = signatureOf(view);
        if (sig !== lastSignature) {
          lastSignature = sig;
          // Payload deliberately carries no names/numbers — the page refetches through the authorized API.
          if (io) io.emit('device-users:changed', { count: view.count, at: iso(now()) });
        }
        return view;
      } finally {
        scanning = null;
        abort = null;
      }
    })();
    return scanning;
  }

  /** Stop accepting scans and abort the in-flight one (it releases its lease and resumes its listener). */
  function shutdown() {
    stopped = true;
    if (abort) abort.abort();
  }

  return { scanAll, shutdown, getView: currentView, isScanning: () => !!scanning, isStopped: () => stopped, _devices: devices };
}

// ── production wiring (lazy: requiring this module never touches Prisma or a device) ──
let singleton = null;
let catchUpHook = null;                    // set by syncScheduler: (deviceId) => schedule a prompt sync
function instance() {
  if (!singleton) {
    const { getPrisma } = require('../utils/prisma');
    const prisma = getPrisma();
    const zk = require('./zktecoService');
    singleton = createDiscovery({
      // autoSync mirrors the scheduler and the realtime listener: a device the operator turned auto-sync off for
      // is never contacted automatically.
      listDevices: () => prisma.device.findMany({
        where: { enabled: true, isArchived: false, autoSync: true },
        select: { id: true, name: true, status: true, consecutiveErrors: true },
        orderBy: { id: 'asc' },
      }),
      readUsers: (id, io, opts) => zk.readDeviceUsers(id, io, opts),
      // zkUserId AND code, every status: routes/employees.js refuses a new employee whose number equals either column of any row.
      listEmployeeNumbers: () => prisma.employee.findMany({ select: { zkUserId: true, code: true } }),
      listSkippedDevices: () => prisma.device.findMany({
        where: { enabled: true, isArchived: false, autoSync: false },
        select: { id: true, name: true },
        orderBy: { id: 'asc' },
      }),
      requestCatchUp: (id) => { if (catchUpHook) catchUpHook(id); },
    });
  }
  return singleton;
}

// A shutdown that arrives before the first scan ever created the instance must still block later scans.
let shutdownRequested = false;

module.exports = {
  createDiscovery, normalizeDeviceUserId, normalizeDeviceName, idProblem, MAX_EMPLOYEE_NUMBER_LENGTH,
  scanAll: (io, opts) => {
    const d = instance();
    if (shutdownRequested) d.shutdown();
    return d.scanAll(io, opts);
  },
  getView: () => instance().getView(),
  isScanning: () => (singleton ? singleton.isScanning() : false),
  shutdown: () => { shutdownRequested = true; if (singleton) singleton.shutdown(); },
  setCatchUpHook: (fn) => { catchUpHook = typeof fn === 'function' ? fn : null; },
};
