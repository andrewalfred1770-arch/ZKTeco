/**
 * syncScheduler.js — Background Sync Scheduler
 *
 * - Runs a master tick every minute
 * - Each device has its own syncInterval (default 5 min)
 * - Tracks last sync per device to respect individual intervals
 * - Auto-reconnect on failure (exponential backoff, max 30 min)
 * - Non-blocking: device sync runs in parallel
 */

const cron = require('node-cron');
const { getPrisma } = require('../utils/prisma');
const { pullLogs, isDeviceSyncRunning, recoverStaleSyncState } = require('./zktecoService');
const { pruneDeviceAuditLogs } = require('../utils/deviceAudit');
const { auditDeviceTopology, reconcileCrossDeviceDuplicates } = require('./deviceIntegrity');
const realtimeListener = require('./realtimeListenerService');
const { processToday } = require('../engines/attendanceEngine');
const logger = require('../utils/logger');
const deviceUserDiscovery = require('./deviceUserDiscoveryService');

const prisma = getPrisma();

// In-memory: deviceId → lastSyncAttempt (ms timestamp)
const lastSyncAttempt = new Map();

// Realtime events (CMD_REG_EVENT) are now the PRIMARY ingestion path. The
// convergence-poll below is demoted to a BACKGROUND RECOVERY job — it never
// needs to run as often as a "live" sync did. Enforce a floor on top of each
// device's configured syncInterval so existing device configs (e.g. 5 min)
// don't keep contending with the realtime listener for the device's single
// TCP session.
const RECOVERY_MIN_INTERVAL_MINUTES = 15;

let io;

const DISCOVERY_FIRST_RUN_DELAY_MS = 90 * 1000;
let discoveryStartTimer = null;
// Handles for every cron task — kept so stopSyncScheduler() can tear them all
// down during graceful shutdown (orphan cron timers keep the event loop alive
// and fire into a half-shutdown process otherwise).
const cronTasks = [];

function schedule(expr, fn) {
  cronTasks.push(cron.schedule(expr, fn));
}

// A device-user scan pauses a device's realtime listener for a few seconds; punches made in that window are not
// pushed live and are only picked up by the next recovery pull. Rather than add a competing sync path, the scan
// asks THIS scheduler to treat the device as due: clearing its last-attempt marker makes the very next one-minute
// tick run the normal checkDevice() → pullLogs() path (same lease, same eligibility checks, same 'auto' trigger,
// idempotent inserts). If a pull is already running the tick skips and simply retries a minute later.
function requestPromptSync(deviceId) {
  lastSyncAttempt.delete(deviceId);
  logger.info(`[Scheduler] device=${deviceId} catch-up sync requested after a device-user scan — next tick`);
}

// ─── Per-device sync check ────────────────────────────────────────────────────
async function checkDevice(device, now) {
  const lastAttempt = lastSyncAttempt.get(device.id) || 0;
  const since = lastAttempt ? `${Math.round((now - lastAttempt) / 1000)}s` : 'never';
  // Eligibility verdict at info level — production runs with logger level
  // 'info', so debug logs are invisible there; this is the only way to see
  // why a device does or doesn't sync on a given tick.
  const verdict = (decision) =>
    logger.info(`[AUTO-SYNC] device=${device.id} "${device.name}" enabled=${device.enabled} autoSync=${device.autoSync} interval=${device.syncInterval || 5}m errors=${device.consecutiveErrors || 0} lastAttempt=${since} → ${decision}`);

  if (!device.enabled || !device.autoSync) { verdict('skip: disabled or autoSync off'); return; }

  // A previous sync (manual or auto) for this device is still in flight —
  // skip this tick rather than letting pullLogs collide with it.
  if (isDeviceSyncRunning(device.id)) {
    verdict('skip: sync already running');
    return;
  }

  const effectiveMinutes = Math.max(device.syncInterval || 5, RECOVERY_MIN_INTERVAL_MINUTES);
  const intervalMs = effectiveMinutes * 60 * 1000;

  if (now - lastAttempt < intervalMs) { verdict('wait: interval not reached'); return; }

  // Respect exponential backoff for errored devices
  const errors = device.consecutiveErrors || 0;
  if (errors > 0) {
    const backoffMs = Math.min(errors * errors * 60 * 1000, 30 * 60 * 1000); // max 30 min
    if (now - lastAttempt < backoffMs) {
      verdict(`wait: error backoff ${Math.round(backoffMs/60000)} min`);
      return;
    }
  }

  lastSyncAttempt.set(device.id, now);
  verdict('RUN: starting sync');

  // Non-blocking — let it run in background
  pullLogs(device.id, io, 'auto').then(result => {
    if (result.count > 0) {
      logger.info(`[Scheduler] "${device.name}": ${result.count} new logs`);
    }
  }).catch(err => {
    logger.error(`[Scheduler] "${device.name}" error: ${err.message}`);
  });
}

// ─── Main scheduler entry point ───────────────────────────────────────────────
function startSyncScheduler(socketIo) {
  io = socketIo;

  // Primary ingestion path: persistent realtime (CMD_REG_EVENT) listeners,
  // one per enabled/auto-sync device.
  realtimeListener.startAll(io);

  // Periodically refresh long-lived realtime connections — cheap insurance
  // against a silently half-dead socket that TCP keepalive missed.
  schedule('0 */6 * * *', () => {
    try {
      realtimeListener.refreshAll(io);
    } catch (err) {
      logger.error(`[Scheduler] realtime refresh: ${err.message}`);
    }
  });

  // Master tick: every minute, check which devices need syncing
  schedule('* * * * *', async () => {
    const now = Date.now();
    try {
      const devices = await prisma.device.findMany({
        where: { enabled: true },
        select: { id: true, name: true, enabled: true, autoSync: true, syncInterval: true, consecutiveErrors: true },
      });
      logger.info(`[AUTO-SYNC] tick — ${devices.length} enabled device(s)`);
      for (const device of devices) {
        checkDevice(device, now).catch(() => {});
      }
    } catch (err) {
      logger.error(`[Scheduler] tick error: ${err.message}`);
    }
  });

  // Process today's attendance every 10 minutes
  schedule('*/10 * * * *', async () => {
    try {
      await processToday(null);
      if (io) io.emit('attendance:processed', { timestamp: new Date() });
    } catch (err) {
      logger.error(`[Scheduler] attendance processing: ${err.message}`);
    }
  });

  // Midnight reset
  schedule('0 0 * * *', async () => {
    try {
      await processToday(null);
    } catch (err) {
      logger.error(`[Scheduler] midnight processing: ${err.message}`);
    }
  });

  // Step 5: device topology audit — detect duplicate device rows (same
  // ip:port) every 15 minutes. Read-only: logs warnings + emits
  // device:topology-warning so the UI can surface it.
  //
  // Certification C1 fix: immediately follow the read-only audit with a
  // reconciliation pass that marks (never deletes) AttendanceLog rows that
  // are re-ingestions of the same physical punch across duplicate device
  // rows. This only sets isDuplicate=true, a flag every attendance read
  // already filters on — no attendance/payroll calculation changes.
  schedule('*/15 * * * *', async () => {
    try {
      await auditDeviceTopology(io);
      await reconcileCrossDeviceDuplicates(io);
    } catch (err) {
      logger.error(`[Scheduler] topology audit: ${err.message}`);
    }
  });

  // Housekeeping (bounded, never throws into the scheduler):
  //  - stale sync state left by a crash/timeout: once at startup, then every 15 min
  //  - routine device-audit retention: once at startup, then daily at 03:30
  const housekeeping = {
    staleSync: () => recoverStaleSyncState().catch((err) => logger.error(`[Scheduler] stale sync recovery: ${err.message}`)),
    auditPrune: () => pruneDeviceAuditLogs().catch(() => {}),
  };
  // New-person discovery (read-only): list the users registered on each device and surface the ones that
  // have no employee yet on the Employees page. The realtime channel carries attendance only, so this is a
  // bounded poll — every 15 min, devices strictly one after another, a single run at a time, and a device
  // that is busy (sync / realtime recovery holds its lease) or unreachable is skipped without affecting the
  // others or the attendance sync. One delayed first run so the list is populated shortly after start-up.
  const discover = () => deviceUserDiscovery.scanAll(io).catch((err) => logger.warn(`[USER-DISCOVERY] scan failed: ${err.message}`));
  schedule('*/15 * * * *', discover);
  deviceUserDiscovery.setCatchUpHook(requestPromptSync);
  discoveryStartTimer = setTimeout(discover, DISCOVERY_FIRST_RUN_DELAY_MS);
  if (discoveryStartTimer.unref) discoveryStartTimer.unref();

  schedule('*/15 * * * *', housekeeping.staleSync);
  schedule('30 3 * * *', housekeeping.auditPrune);
  setImmediate(() => { housekeeping.staleSync(); housekeeping.auditPrune(); });

  logger.info(`[Scheduler] Started — realtime listeners primary, recovery polls every >=${RECOVERY_MIN_INTERVAL_MINUTES}min (1-min master tick)`);
}

// ─── Graceful shutdown ──────────────────────────────────────────────────────
function stopSyncScheduler() {
  if (discoveryStartTimer) { clearTimeout(discoveryStartTimer); discoveryStartTimer = null; }
  // No new scans from here on; an in-flight one is aborted (it releases its lease and resumes its listener).
  try { deviceUserDiscovery.shutdown(); } catch { /* shutting down anyway */ }
  deviceUserDiscovery.setCatchUpHook(null);
  for (const task of cronTasks) {
    try { task.stop(); } catch {}
  }
  logger.info(`[SHUTDOWN] sync scheduler stopped (${cronTasks.length} cron task(s))`);
  cronTasks.length = 0;
}

module.exports = { startSyncScheduler, stopSyncScheduler, requestPromptSync };
