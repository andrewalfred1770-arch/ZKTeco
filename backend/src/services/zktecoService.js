/**
 * zktecoService.js — ZKTeco Device Sync Engine
 *
 * Responsibilities:
 *  - TCP/IP connection management (connect/disconnect/reconnect)
 *  - Pull attendance logs (incremental, dedup)
 *  - Record every sync attempt in DeviceSyncLog
 *  - Emit Socket.IO events for real-time frontend updates
 *  - Retry logic with exponential backoff
 */

const ZKLib  = require('node-zklib');
const { getPrisma } = require('../utils/prisma');
const { isValidPunchTimestamp } = require('../utils/timestamps');
const logger = require('../utils/logger');
const realtimeListener = require('./realtimeListenerService');
const { getAttendancesPaced, ZK_CHUNKED_READ_ENABLED, ZK_CHUNKED_READ_THRESHOLD } = require('./zkChunkedAttendanceReader');
const historicalRebuildService = require('./historicalRebuildService');
const attendanceEngine = require('../engines/attendanceEngine');
const moment = require('moment');

const prisma = getPrisma();

// In-memory connection store:  deviceId → { zk, device, connectedAt }
const activeConnections = new Map();

// In-memory per-device sync lock:  deviceId → { owner, startedAt, triggeredBy }
// Prevents overlapping pullLogs() calls (manual + auto) for the same device,
// which previously caused connectDevice() to yank an in-flight socket and
// throw "write after end".
//
// ATOMICITY: the lock is claimed SYNCHRONOUSLY (no await between the has()
// check and the set()) — the old code awaited a DB insert in between, so two
// near-simultaneous triggers could both enter, and the loser's finally-block
// then released the winner's lock and resumed the realtime listener mid-pull.
// Release/resume is now ownership-checked: only the lock owner may do either.
const syncLocks = new Map();
let syncOwnerCounter = 0;

// Hard ceiling for a single sync run. If exceeded, the socket is forced
// closed and the sync is marked 'failed' so it can never get stuck in
// 'running' forever (zombie sync rows).
const SYNC_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ─── Convergence-based multi-pass sync ────────────────────────────────────────
// node-zklib's getAttendances() can RESOLVE SUCCESSFULLY with a non-null `.err`
// when the device times out mid-transfer ("TIME OUT !! N PACKETS REMAIN !"),
// silently truncating the buffer (newest records lost first — the device sends
// oldest-first). A single pull is therefore never trustworthy on its own.
// We pull repeatedly, merge unique (zkUserId, timestamp) rows across passes,
// and only treat the result as a complete/converged pull once two consecutive
// passes both return with no `.err` and the same record count.
const MAX_CONVERGENCE_PASSES = 3;
const CONVERGENCE_PASS_DELAY_MS = 1500;

// Incremental checkpoint: on a converged sync we only need to re-process logs
// near/after the last confirmed newest timestamp (older ones are already in
// the DB and protected by the unique constraint). This window adds a safety
// overlap behind the checkpoint. The very first sync for a device (no
// checkpoint yet) always processes the full pulled buffer (recovery pull).
const CHECKPOINT_OVERLAP_MS = 24 * 60 * 60 * 1000; // 1 day

// Gap detection: warn if the newest punch we can see for an active,
// auto-syncing device is older than this — likely a disconnected/inactive
// physical device (topology problem), not a software bug.
const STALE_PUNCH_WARN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function attendanceKey(log) {
  return `${log.deviceUserId}|${new Date(log.recordTime).getTime()}`;
}

function isDeviceSyncRunning(deviceId) {
  return syncLocks.has(String(deviceId));
}

// ─── Status constants ──────────────────────────────────────────────────────────
const STATUS = { ONLINE: 'online', OFFLINE: 'offline', SYNCING: 'syncing', ERROR: 'error' };

// ─── Emit helper ──────────────────────────────────────────────────────────────
function emit(io, event, data) {
  if (io) {
    io.emit(event, data);
    logger.info(`[EMIT] ${event}${data && data.deviceId !== undefined ? ` device=${data.deviceId}` : ''}`);
  } else {
    logger.warn(`[EMIT] ${event} dropped — no Socket.IO instance`);
  }
}

// ─── STEP 6: runtime gap detection ────────────────────────────────────────────
// Compares the newest punch timestamp visible after this sync against "now".
// For an enabled, auto-syncing device this should normally be very recent
// (within a business day). A large gap means either the physical device is
// no longer receiving punches (wrong/disconnected entrance device — see
// topology audit) or staff stopped using it — surface it loudly either way.
function checkAttendanceGap(device, dbNewestTs, io) {
  if (!device.enabled || !device.autoSync) return;
  const reference = dbNewestTs || device.lastSuccessfulTimestamp;
  if (!reference) return;

  const ageMs = Date.now() - new Date(reference).getTime();
  if (ageMs <= STALE_PUNCH_WARN_MS) return;

  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  logger.warn(`[GAP] device=${device.id} "${device.name}": newest visible punch is ${days}d old (${new Date(reference).toISOString()}) — device may be physically disconnected or unused`);
  emit(io, 'device:gap-warning', {
    deviceId: device.id,
    name: device.name,
    newestTimestamp: reference,
    daysSinceLastPunch: days,
  });
}

// ─── Extract a readable message from node-zklib errors ───────────────────────
// node-zklib rejects with a `ZKError` instance ({ err, ip, command }) rather
// than a plain Error, so `.message` is always undefined on it — leading to a
// generic "Connection failed" for every failure (timeout, refused, etc.).
// Unwrap the inner `.err` (a real Error, e.g. "TIMEOUT_ON_WRITING_MESSAGE")
// so logs/UI show the actual cause.
function zkErrorMessage(err, fallback) {
  if (!err) return fallback;
  if (typeof err.message === 'string' && err.message) return err.message;
  if (typeof err.getError === 'function') {
    const inner = err.getError();
    if (inner?.err?.message) return inner.err.message;
  }
  if (err.err?.message) return err.err.message;
  return fallback;
}

// ─── Safe disconnect ────────────────────────────────────────────────────────
// node-zklib's disconnect() is async and REJECTS (ZKError "Socket isn't
// connected!") if called on a zk instance whose createSocket() never fully
// established a connection (e.g. ETIMEDOUT/EHOSTUNREACH to an unreachable
// device). A bare `try { zk.disconnect(); } catch {}` does NOT catch that —
// it's an unhandled promise rejection that crashes the whole Node process.
function safeDisconnect(zk) {
  if (!zk) return;
  try {
    const p = zk.disconnect();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {}
}

// ─── Connect ──────────────────────────────────────────────────────────────────
async function connectDevice(device) {
  const key = String(device.id);

  // If a connection is already active for this device, do NOT yank it out
  // from under whatever is using it (this used to cause "write after end"
  // when an overlapping sync force-disconnected an in-flight getAttendances()).
  // Fail fast instead — the caller (pullLogs) already guards against this via
  // syncLocks, so this should only trigger for unrelated concurrent calls
  // (e.g. getDeviceUsers while a sync is running).
  const existing = activeConnections.get(key);
  if (existing) {
    throw new Error(`Device "${device.name}" is busy (connection already active)`);
  }

  // ZKTeco's TCP handshake (CMD_CONNECT) has a hardcoded 2s reply window inside
  // node-zklib. On networks with variable latency to the device this window is
  // occasionally missed (TIMEOUT_ON_WRITING_MESSAGE) even though the device is
  // reachable and a retry succeeds within ~1s. Retry the handshake a few times
  // with a fresh socket before giving up.
  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const zk = new ZKLib(device.ipAddress, device.port, 10000, 4000);
    try {
      await zk.createSocket();
      activeConnections.set(key, { zk, device, connectedAt: new Date() });
      await setDeviceStatus(device.id, STATUS.ONLINE, null, 0);
      logger.info(`[ZK] Device "${device.name}" (${device.ipAddress}:${device.port}) connected${attempt > 1 ? ` (attempt ${attempt}/${MAX_ATTEMPTS})` : ''}`);
      return zk;
    } catch (err) {
      lastErr = err;
      safeDisconnect(zk);
      if (attempt < MAX_ATTEMPTS) {
        logger.warn(`[ZK] Connect attempt ${attempt}/${MAX_ATTEMPTS} to "${device.name}" failed (${zkErrorMessage(err, 'unknown')}), retrying...`);
        await new Promise((r) => setTimeout(r, 800));
      }
    }
  }
  throw lastErr;
}

// ─── Disconnect ───────────────────────────────────────────────────────────────
async function disconnectDevice(deviceId) {
  const conn = activeConnections.get(String(deviceId));
  if (conn) {
    safeDisconnect(conn.zk);
    activeConnections.delete(String(deviceId));
  }
  await setDeviceStatus(deviceId, STATUS.OFFLINE);
}

// ─── Update device status in DB ───────────────────────────────────────────────
async function setDeviceStatus(deviceId, status, errorMessage = null, consecutiveErrors = undefined) {
  const data = { status };
  if (errorMessage !== undefined) data.errorMessage = errorMessage;
  if (consecutiveErrors !== undefined) data.consecutiveErrors = consecutiveErrors;
  try {
    await prisma.device.update({ where: { id: deviceId }, data });
  } catch {}
}

// ─── Pull logs from one device ────────────────────────────────────────────────
async function pullLogs(deviceId, io, triggeredBy = 'auto') {
  const key = String(deviceId);

  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    include: { branch: true },
  });

  if (!device || !device.enabled) {
    return { count: 0, skipped: true };
  }

  // Refuse to start a second sync for the same device while one is already
  // running (manual or auto). Without this, an overlapping sync would force
  // connectDevice() to disconnect the in-flight socket and crash both syncs
  // with "write after end", leaving the first one stuck in 'running' forever.
  //
  // The check AND the claim happen synchronously — no await may sit between
  // them, or two triggers can both enter (TOCTOU).
  if (syncLocks.has(key)) {
    const held = syncLocks.get(key);
    logger.info(`[SYNC] [LOCK] device=${deviceId} skip — lock held by owner #${held.owner} (${held.triggeredBy}, since ${new Date(held.startedAt).toISOString()})`);
    return { count: 0, skipped: true, reason: 'sync already running' };
  }
  const t0 = Date.now();
  const lockOwner = ++syncOwnerCounter;
  syncLocks.set(key, { owner: lockOwner, startedAt: t0, triggeredBy });
  logger.info(`[SYNC] [LOCK] device=${deviceId} acquired by owner #${lockOwner} (${triggeredBy})`);

  // Ownership-checked release — shared by the finally block. Only the claim
  // above may undo itself; any other code path is a stale loser and must not
  // touch the lock or the paused realtime listener.
  const releaseLock = () => {
    const held = syncLocks.get(key);
    if (held?.owner !== lockOwner) {
      logger.warn(`[SYNC] [LOCK] device=${deviceId} release skipped — owner #${lockOwner} no longer holds the lock (held by #${held?.owner ?? 'none'})`);
      return false;
    }
    syncLocks.delete(key);
    logger.info(`[SYNC] [LOCK] device=${deviceId} released by owner #${lockOwner}`);
    return true;
  };

  // Create sync log entry (lock already held — a concurrent trigger now skips)
  let syncLog;
  try {
    syncLog = await prisma.deviceSyncLog.create({
      data: { deviceId, triggeredBy, status: 'running' },
    });
  } catch (err) {
    releaseLock();
    throw err;
  }

  logger.info(`[SYNC] start device=${deviceId} "${device.name}" ip=${device.ipAddress}:${device.port} trigger=${triggeredBy} syncLogId=${syncLog.id}`);
  emit(io, 'device:syncing', { deviceId, name: device.name });
  await setDeviceStatus(deviceId, STATUS.SYNCING, null);

  let zk;
  let watchdogFired = false;
  let watchdog;

  // The realtime event listener (CMD_REG_EVENT) holds the device's single
  // TCP session. Pause it before opening a recovery-poll connection so the
  // two paths never fight over the same session, then resume it afterwards.
  realtimeListener.pauseListener(deviceId);
  await sleep(500);

  try {
    try {
      zk = await connectDevice(device);
    } catch (err) {
      const msg = zkErrorMessage(err, 'Connection failed');
      logger.warn(`[ZK] Cannot connect "${device.name}": ${msg}`);

      const errCount = (device.consecutiveErrors || 0) + 1;
      await setDeviceStatus(deviceId, STATUS.OFFLINE, msg, errCount);

      await prisma.deviceSyncLog.update({
        where: { id: syncLog.id },
        data: { status: 'failed', error: msg, completedAt: new Date(), duration: Date.now() - t0 },
      });

      emit(io, 'device:offline', { deviceId, name: device.name, error: msg });
      return { count: 0, error: msg, deviceId };
    }

    // ── Device integrity pre-check (Step 4) ─────────────────────────────────
    // Cheap CMD_GET_FREE_SIZES call: gives the device's own buffer count
    // (logCounts). Compared against the last known-good total to catch a
    // device whose buffer suddenly shrank (cleared/reset/replaced device).
    let deviceLogCounts = null;
    try {
      const info = await zk.getInfo();
      deviceLogCounts = typeof info?.logCounts === 'number' ? info.logCounts : null;
      logger.info(`[INTEGRITY] device=${deviceId} "${device.name}" logCounts=${deviceLogCounts} userCounts=${info?.userCounts ?? '?'} capacity=${info?.logCapacity ?? '?'}`);
      if (deviceLogCounts != null && device.lastPullTotal && deviceLogCounts < device.lastPullTotal * 0.9) {
        logger.warn(`[INTEGRITY] device=${deviceId} "${device.name}": buffer count shrank unexpectedly (${device.lastPullTotal} → ${deviceLogCounts}) — possible reset/replaced device`);
        emit(io, 'device:integrity-warning', {
          deviceId, name: device.name,
          message: `Device buffer count shrank: ${device.lastPullTotal} → ${deviceLogCounts}`,
        });
      }
    } catch (err) {
      logger.warn(`[INTEGRITY] device=${deviceId} "${device.name}": getInfo failed (${zkErrorMessage(err, 'unknown')})`);
    }

    // Hard ceiling: if this sync is still running after SYNC_TIMEOUT_MS, force
    // the socket closed so getAttendances()/in-flight writes error out instead
    // of hanging forever (which is what left a 'running' sync log permanently
    // stuck and then collided with the next auto-sync attempt).
    watchdog = setTimeout(() => {
      watchdogFired = true;
      logger.error(`[ZK] "${device.name}": sync exceeded ${SYNC_TIMEOUT_MS / 60000} min — forcing disconnect`);
      safeDisconnect(zk);
    }, SYNC_TIMEOUT_MS);

    try {
    logger.info(`[SYNC] connected device=${deviceId} — requesting attendance buffer (convergence, max ${MAX_CONVERGENCE_PASSES} passes)`);

    // ── STEP 1+2: convergence-based multi-pass pull ─────────────────────────
    // Pull repeatedly, merging unique (zkUserId, recordTime) rows across
    // passes. A pull is only "converged" once two consecutive passes both
    // return with no `.err` and an identical record count — i.e. the device
    // had nothing left to flush and the transfer completed cleanly.
    const merged = new Map();
    let passesRun = 0;
    let prevReturned = null;
    let prevClean = false;
    let lastZkErr = null;
    let lastReturnedCount = 0;
    let converged = false;
    let quarantined = 0; // garbage timestamps rejected at merge time

    // Large buffers (20k+ records) overwhelm node-zklib's unpaced chunked
    // read and trigger "TIME OUT !! N PACKETS REMAIN !" mid-transfer, which
    // can leave the device's reply state misaligned for the next pass. Use
    // the paced chunked reader for those; small buffers keep the original,
    // already-certified zk.getAttendances() path untouched.
    const useChunkedReader = ZK_CHUNKED_READ_ENABLED
      && deviceLogCounts != null
      && deviceLogCounts > ZK_CHUNKED_READ_THRESHOLD;

    for (let pass = 1; pass <= MAX_CONVERGENCE_PASSES; pass++) {
      passesRun = pass;
      const attendance = useChunkedReader
        ? await getAttendancesPaced(zk, { syncAttemptId: syncLog.id, deviceId, deviceName: device.name }, logger)
        : await zk.getAttendances();
      const data = attendance?.data || [];
      const zkErr = attendance?.err || null;
      lastZkErr = zkErr;
      lastReturnedCount = data.length;

      for (const log of data) {
        const ts = new Date(log.recordTime);
        // Quarantine garbage timestamps HERE so they can never reach the DB,
        // newestTs (checkpoint poison) or the relink recalculator (recalc
        // storms). See utils/timestamps.js for the threat model.
        if (!isValidPunchTimestamp(ts)) {
          quarantined++;
          logger.warn(`[SYNC-QUARANTINE] device=${deviceId} "${device.name}" syncAttemptId=${syncLog.id} pass=${pass} `
            + `deviceUserId=${log.deviceUserId} userSn=${log.userSn ?? 'n/a'} rawRecordTime=${log.recordTime} `
            + `parsedTs=${Number.isNaN(ts.getTime()) ? 'Invalid' : ts.toISOString()} ip=${log.ip || device.ipAddress} `
            + `chunkId=${log._diag?.chunkId ?? 'n/a'} offsetInChunk=${log._diag?.offsetInChunk ?? 'n/a'}`);
          continue;
        }
        const k = attendanceKey(log);
        if (!merged.has(k)) merged.set(k, log);
      }

      logger.info(`[SYNC] convergence device=${deviceId} pass=${pass}/${MAX_CONVERGENCE_PASSES} returned=${data.length} merged=${merged.size} err=${zkErr ? `"${zkErr.message || zkErr}"` : 'none'}`);

      if (!zkErr && prevClean && data.length === prevReturned) {
        converged = true;
        break;
      }
      prevReturned = data.length;
      prevClean = !zkErr;

      if (pass < MAX_CONVERGENCE_PASSES) await sleep(CONVERGENCE_PASS_DELAY_MS);
    }

    const logs = Array.from(merged.values());
    // Pull is only "successful" if it converged AND the final pass had no err.
    // node-zklib sends chunks oldest-first, so a truncated pull is missing the
    // NEWEST records — partial results must never be trusted as complete.
    const success = converged && !lastZkErr;

    let oldestTs = null;
    let newestTs = null;
    for (const log of logs) {
      const ts = new Date(log.recordTime);
      if (oldestTs === null || ts < oldestTs) oldestTs = ts;
      if (newestTs === null || ts > newestTs) newestTs = ts;
    }

    // ── STEP 3: incremental checkpoint window ───────────────────────────────
    // Records older than (checkpoint - overlap) are virtually guaranteed to
    // already be in the DB (protected by the unique constraint) — skip
    // re-querying/inserting them on routine syncs. With no checkpoint yet
    // (first sync for this device), process the full pulled buffer
    // (recovery pull).
    const checkpoint = device.lastSuccessfulTimestamp;
    const cutoff = checkpoint ? new Date(checkpoint.getTime() - CHECKPOINT_OVERLAP_MS) : null;
    const toProcess = cutoff ? logs.filter((l) => new Date(l.recordTime) >= cutoff) : logs;
    const skippedOldCount = logs.length - toProcess.length;

    let newCount = 0;
    let dupCount = 0;
    let invalidCount = quarantined;
    const batchSize = 1000;

    // Prefetch the zkUserId → employeeId map ONCE instead of one findFirst per
    // log (a 27k-record first pull used to issue 27k employee lookups).
    const employees = await prisma.employee.findMany({
      where: { NOT: { zkUserId: '' } },
      select: { id: true, zkUserId: true },
    });
    const empByZk = new Map(employees.map((e) => [e.zkUserId, e.id]));

    // Matched (employeeId already resolved at insert time) employee/date pairs
    // touched by this pull — reprocessed into AttendanceDaily immediately below
    // so a sync never silently waits for the next cron tick. Orphaned rows
    // (no matching employee yet) are handled separately by relinkAttendanceLogs.
    const matchedDayPairs = new Map(); // `${employeeId}|${dateStr}` -> {employeeId, dateStr}

    for (let i = 0; i < toProcess.length; i += batchSize) {
      const batch = toProcess.slice(i, i + batchSize);

      const rows = [];
      for (const log of batch) {
        const zkUserId  = String(log.deviceUserId);
        const timestamp = new Date(log.recordTime);
        // Already validated at merge time, but toProcess is the contract here.
        if (!isValidPunchTimestamp(timestamp)) { invalidCount++; continue; }
        const employeeId = empByZk.get(zkUserId) ?? null;
        rows.push({
          deviceId,
          zkUserId,
          employeeId,
          timestamp,
          verifyType: log.verifyType ?? 0,
          source: 'device',
        });
        if (employeeId != null) {
          const dateStr = moment(timestamp).format('YYYY-MM-DD');
          matchedDayPairs.set(`${employeeId}|${dateStr}`, { employeeId, dateStr });
        }
      }
      if (!rows.length) continue;

      try {
        // skipDuplicates leans on the (deviceId, zkUserId, timestamp) unique
        // key — the same exactly-once guarantee as the old per-row P2002
        // handling, executed as one INSERT instead of 50 round-trips.
        const res = await prisma.attendanceLog.createMany({ data: rows, skipDuplicates: true });
        newCount += res.count;
        dupCount += rows.length - res.count;
      } catch (e) {
        logger.warn(`[ZK] Batch insert error (${rows.length} rows): ${e.message}`);
      }
    }

    // ── Immediate processing for matched logs ───────────────────────────────
    // Previously only orphaned logs (employeeId resolved after the fact) were
    // reprocessed post-sync — logs matched at insert time sat in AttendanceLog
    // until the next 10-min/midnight cron tick before AttendanceDaily reflected
    // them. processDate() is idempotent (it recomputes deterministically from
    // AttendanceLog), so re-running it for every touched employee/date here is
    // safe even when most of those punches were already duplicates.
    if (matchedDayPairs.size > 0) {
      logger.info(`[SYNC] processing ${matchedDayPairs.size} employee/date pair(s) into AttendanceDaily immediately (device=${deviceId})`);
      for (const { employeeId, dateStr } of matchedDayPairs.values()) {
        try {
          await attendanceEngine.processDate(new Date(`${dateStr}T12:00:00`), employeeId);
        } catch (err) {
          logger.error(`[SYNC] processDate failed employee=${employeeId} date=${dateStr}: ${err.message}`);
        }
      }
    }

    if (quarantined > 0) {
      logger.warn(`[TS-INVALID] device=${deviceId} "${device.name}": quarantined ${quarantined} record(s) with impossible timestamps (device clock garbage) — not ingested, not checkpointed`);
      emit(io, 'device:integrity-warning', {
        deviceId, name: device.name,
        message: `${quarantined} records rejected: invalid device timestamps`,
      });
    }

    const duration = Date.now() - t0;

    // Authoritative post-sync totals for the failure map
    const dbTotal = await prisma.attendanceLog.count({ where: { deviceId } });

    // Ground-truth "newest punch" for gap detection — the merged set's
    // newestTs is per-pull and can regress run-to-run depending on which
    // chunks the device happened to return (e.g. a run whose passes only
    // covered older records). The DB's actual newest row reflects everything
    // ever ingested, so it can't false-positive a "stale device" warning
    // right after a run that just inserted fresh records.
    const dbNewestRow = await prisma.attendanceLog.findFirst({
      where: { deviceId }, orderBy: { timestamp: 'desc' }, select: { timestamp: true },
    });
    const dbNewestTs = dbNewestRow?.timestamp || null;

    // Cross-check the realtime listener: if it claims to be connected but
    // missed records this recovery pull just found, force it to reconnect.
    realtimeListener.checkForMissedEvents(deviceId, dbNewestTs, io);

    // ── STEP 8: end-to-end runtime tracing (always logged) ──────────────────
    logger.info(
      `[SYNC] TRACE device=${deviceId} "${device.name}" passes=${passesRun} converged=${converged} ` +
      `returned=${lastReturnedCount} merged=${logs.length} processed=${toProcess.length} skippedOld=${skippedOldCount} ` +
      `inserted=${newCount} duplicates=${dupCount} invalid=${invalidCount} dbTotal=${dbTotal} ` +
      `oldest=${oldestTs ? oldestTs.toISOString() : 'n/a'} newest=${newestTs ? newestTs.toISOString() : 'n/a'} ` +
      `zkErr=${lastZkErr ? `"${lastZkErr.message || lastZkErr}"` : 'none'} duration=${duration}ms`
    );

    // ── Historical rebuild auto-trigger ─────────────────────────────────────
    // A converged sync that inserted records whose OLDEST timestamp is more
    // than HIST_REBUILD_TRIGGER_DAYS old is a historical backfill, not routine
    // today's-punches traffic — attendance_daily/payrolls for that window need
    // recomputing from the newly-arrived AttendanceLog rows. Fire-and-forget:
    // does not block this sync or affect the realtime listener resume below.
    if (success && newCount > 0 && oldestTs) {
      const histTriggerDays = parseInt(process.env.HIST_REBUILD_TRIGGER_DAYS || '1', 10);
      const ageDays = (Date.now() - oldestTs.getTime()) / 86400000;
      if (ageDays > histTriggerDays) {
        historicalRebuildService.queueFromSync({
          from: oldestTs,
          to: newestTs || new Date(),
          reason: `auto: device=${deviceId} historical sync inserted ${newCount} row(s), oldest=${oldestTs.toISOString()}`,
          io,
        }).catch((err) => logger.error(`[HIST-REBUILD] queue error: ${err.message}`));
      }
    }

    if (!success) {
      // Step 1: a partial/non-converged pull is NEVER treated as a successful
      // sync — checkpoint is not advanced, even though best-effort merged
      // records (which are safe due to the unique constraint) were still
      // ingested above so newer punches aren't needlessly delayed further.
      const reason = lastZkErr
        ? `Partial pull: ${zkErrorMessage(lastZkErr, 'unknown error')} (after ${passesRun} pass(es))`
        : `Pull did not converge after ${passesRun} pass(es) (returned counts kept changing)`;
      logger.warn(`[SYNC] device=${deviceId} "${device.name}": ${reason} — checkpoint NOT advanced, ${newCount} record(s) still ingested from merged passes`);

      await prisma.device.update({
        where: { id: deviceId },
        data: {
          lastSync:          new Date(),
          lastSyncCount:     newCount,
          totalLogsCount:    { increment: newCount },
          status:            STATUS.ONLINE,
          errorMessage:      reason,
          // Don't trip exponential backoff for partial pulls — the connection
          // itself succeeded (connectDevice already reset consecutiveErrors
          // to 0 on connect), so the scheduler keeps retrying at the normal
          // interval to converge over time instead of inheriting a stale
          // backoff counter from a prior connection failure.
          consecutiveErrors: 0,
          ...(deviceLogCounts != null ? { lastPullTotal: deviceLogCounts } : {}),
        },
      });

      await prisma.deviceSyncLog.update({
        where: { id: syncLog.id },
        data: {
          // 'partial' = pull never converged (timeout/changing totals) but
          // best-effort merged records were still ingested. Distinct from
          // 'failed' (connection-level errors, see the connect-failure branch
          // above) so the UI/ops can tell "device unreachable" apart from
          // "device reachable but buffer transfer incomplete".
          status:            'partial',
          newLogs:           newCount,
          totalLogs:         logs.length,
          returnedCount:     lastReturnedCount,
          duplicateCount:    dupCount,
          invalidCount,
          skippedOldCount,
          dbTotal,
          oldestTimestamp:   oldestTs,
          newestTimestamp:   newestTs,
          convergencePasses: passesRun,
          zkErr:             lastZkErr ? String(lastZkErr.message || lastZkErr) : null,
          error:             reason,
          completedAt:       new Date(),
          duration,
        },
      });

      emit(io, 'device:synced', {
        deviceId, name: device.name, newLogs: newCount, totalLogs: logs.length,
        duration, success: false, partial: true, reason,
      });

      // ── Gap detection still runs on partial pulls — newest visible
      // timestamp matters even if the pull wasn't fully converged.
      checkAttendanceGap(device, dbNewestTs, io);

      // Best-effort relink even on partial pulls — newly merged records may
      // already cover previously-orphaned zkUserIds.
      try {
        const { relinkAttendanceLogs } = require('./relinkService');
        const relinkRes = await relinkAttendanceLogs({ deviceId, io, reason: `sync-partial:${device.name}` });
        logger.info(`[SYNC] relink device=${deviceId} linked=${relinkRes?.totalLinked ?? 0} employeesAffected=${relinkRes?.employeesAffected ?? 0}`);
      } catch (err) {
        logger.error(`[Relink] post-sync relink failed for "${device.name}": ${err.message}`);
      }

      return { count: newCount, total: logs.length, duration, deviceId, success: false, partial: true, reason };
    }

    // ── Converged success: advance checkpoint ───────────────────────────────
    await prisma.device.update({
      where: { id: deviceId },
      data: {
        lastSync:          new Date(),
        lastSyncCount:     newCount,
        totalLogsCount:    { increment: newCount },
        status:            STATUS.ONLINE,
        errorMessage:      null,
        consecutiveErrors: 0,
        lastSuccessfulTimestamp: newestTs || device.lastSuccessfulTimestamp,
        ...(deviceLogCounts != null ? { lastPullTotal: deviceLogCounts } : {}),
      },
    });

    // Close sync log
    await prisma.deviceSyncLog.update({
      where: { id: syncLog.id },
      data: {
        status:            'success',
        newLogs:           newCount,
        totalLogs:         logs.length,
        returnedCount:     lastReturnedCount,
        duplicateCount:    dupCount,
        invalidCount,
        skippedOldCount,
        dbTotal,
        oldestTimestamp:   oldestTs,
        newestTimestamp:   newestTs,
        convergencePasses: passesRun,
        zkErr:             null,
        completedAt:       new Date(),
        duration,
      },
    });

    emit(io, 'device:synced', {
      deviceId,
      name:      device.name,
      newLogs:   newCount,
      totalLogs: logs.length,
      duration,
      success:   true,
      converged: true,
      passes:    passesRun,
    });

    logger.info(`[ZK] "${device.name}": ${newCount} new / ${logs.length} merged (converged in ${passesRun} pass(es), ${duration}ms)`);

    // ── STEP 6: gap detection ────────────────────────────────────────────────
    checkAttendanceGap(device, dbNewestTs, io);

    // ── Auto-Relink: catch any logs left with employeeId = NULL (e.g. an
    // employee was added/edited after some of these logs were already in the
    // DB, or insert-time matching missed them) and regenerate daily/payroll. ──
    try {
      const { relinkAttendanceLogs } = require('./relinkService');
      const relinkRes = await relinkAttendanceLogs({ deviceId, io, reason: `sync:${device.name}` });
      logger.info(`[SYNC] relink device=${deviceId} linked=${relinkRes?.totalLinked ?? 0} employeesAffected=${relinkRes?.employeesAffected ?? 0}`);
    } catch (err) {
      logger.error(`[Relink] post-sync relink failed for "${device.name}": ${err.message}`);
    }

    return { count: newCount, total: logs.length, duration, deviceId, success: true, converged: true, passes: passesRun };

    } catch (err) {
      const msg = watchdogFired
        ? `Sync timeout exceeded (${SYNC_TIMEOUT_MS / 60000} min) — connection closed`
        : zkErrorMessage(err, 'Sync error');
      logger.error(`[ZK] Sync error "${device.name}": ${msg}`);

      const errCount = (device.consecutiveErrors || 0) + 1;
      await setDeviceStatus(deviceId, STATUS.ERROR, msg, errCount);

      await prisma.deviceSyncLog.update({
        where: { id: syncLog.id },
        data: {
          status:      'failed',
          error:       msg,
          completedAt: new Date(),
          duration:    Date.now() - t0,
        },
      });

      emit(io, 'device:error', { deviceId, name: device.name, error: msg });
      return { count: 0, error: msg, deviceId };
    }
  } finally {
    clearTimeout(watchdog);
    safeDisconnect(zk);
    activeConnections.delete(key);
    // Only the lock owner may release the lock and resume the realtime
    // listener — a stale loser resuming the listener mid-pull would put two
    // sessions on the device's single TCP slot.
    if (releaseLock()) {
      realtimeListener.resumeListener(deviceId, io);
    }
  }
}

// ─── Sync all enabled devices (parallel) ─────────────────────────────────────
// Per-device sync locks already prevent overlapping syncs for the same device,
// so parallel execution across different devices is safe.
async function pullAllDevices(io) {
  const devices = await prisma.device.findMany({
    where: { enabled: true, autoSync: true, isArchived: false },
  });

  const results = await Promise.all(
    devices.map(device =>
      pullLogs(device.id, io, 'auto')
        .then(r  => ({ deviceId: device.id, name: device.name, ...r }))
        .catch(err => ({ deviceId: device.id, name: device.name, count: 0, error: err.message }))
    )
  );
  return results;
}

// ─── Test connection (no sync, no DB write) ───────────────────────────────────
async function testConnection(ipAddress, port) {
  const zk = new ZKLib(ipAddress, parseInt(port) || 4370, 5000, 2000);
  const t0 = Date.now();
  try {
    await zk.createSocket();
    let info = {};
    try { info = await zk.getInfo(); } catch {}
    safeDisconnect(zk);
    return { success: true, info, latency: Date.now() - t0 };
  } catch (err) {
    return { success: false, error: zkErrorMessage(err, 'Connection failed'), latency: Date.now() - t0 };
  }
}

// ─── Live status ping (fast) ──────────────────────────────────────────────────
// If the realtime listener already holds a healthy session to this device,
// answer from that instead of opening a second TCP session — the extra
// connection used to fight the listener for the device's single session AND
// a transient ping failure would mark a perfectly-connected device OFFLINE.
async function pingDevice(deviceId) {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) return { online: false };

  const rtState = realtimeListener.getStatus()[deviceId];
  if (rtState?.status === 'connected') {
    await setDeviceStatus(deviceId, STATUS.ONLINE, null);
    return { online: true, latency: 0, deviceId, viaRealtime: true };
  }

  const result = await testConnection(device.ipAddress, device.port);
  const status = result.success ? STATUS.ONLINE : STATUS.OFFLINE;
  await setDeviceStatus(deviceId, status, result.success ? null : result.error);
  return { online: result.success, latency: result.latency, deviceId };
}

// ─── Get device users ─────────────────────────────────────────────────────────
// Needs a full protocol session — pause the realtime listener around it (same
// coordination pullLogs uses) so two sessions never fight over the device.
async function getDeviceUsers(deviceId) {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) throw new Error(`Device ${deviceId} not found`);

  realtimeListener.pauseListener(deviceId);
  await sleep(500);
  let zk;
  try {
    zk = await connectDevice(device);
    const users = await zk.getUsers();
    return users?.data || [];
  } finally {
    safeDisconnect(zk);
    activeConnections.delete(String(deviceId));
    realtimeListener.resumeListener(deviceId, null);
  }
}

// ─── Delete a user from one device ────────────────────────────────────────────
// Finds the device-internal UID matching zkUserId, then sends CMD_DELETE_USER
// (18) followed by CMD_DELETE_USERTEMP (19, fingerprint templates) and
// CMD_REFRESHDATA (1013) to commit the change on the device.
// Returns { success, deviceId, deviceName, uid? } — never throws.
async function deleteDeviceUser(deviceId, zkUserId) {
  const CMD_DELETE_USER     = 18;
  const CMD_DELETE_USERTEMP = 19;
  const CMD_REFRESHDATA     = 1013;

  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) return { success: false, error: 'الجهاز غير موجود', deviceId };
  if (!device.enabled || device.isArchived) {
    return { success: false, error: 'الجهاز غير مفعّل', deviceId, deviceName: device.name };
  }

  realtimeListener.pauseListener(deviceId);
  await sleep(400);
  let zk;
  try {
    zk = await connectDevice(device);

    // Map zkUserId → device-internal UID
    const usersResult = await zk.getUsers();
    const users = usersResult?.data || [];
    const target = users.find(u => String(u.userId).trim() === String(zkUserId).trim());

    if (!target) {
      return {
        success: false, notFound: true,
        error: `ZK ID ${zkUserId} غير موجود على الجهاز`,
        deviceId, deviceName: device.name,
      };
    }

    const uidBuf = Buffer.alloc(2);
    uidBuf.writeUInt16LE(target.uid, 0);

    await zk.executeCmd(CMD_DELETE_USER, uidBuf);
    await zk.executeCmd(CMD_DELETE_USERTEMP, uidBuf).catch(() => {});
    await zk.executeCmd(CMD_REFRESHDATA, '').catch(() => {});

    logger.info(
      `[ZK-DELETE] Removed zkUserId=${zkUserId} (uid=${target.uid}) ` +
      `from device "${device.name}" (${device.ipAddress}:${device.port})`
    );
    return { success: true, deviceId, deviceName: device.name, uid: target.uid };
  } catch (err) {
    const msg = zkErrorMessage(err, err.message || 'فشل حذف المستخدم من الجهاز');
    logger.error(`[ZK-DELETE] device=${deviceId} zkUserId=${zkUserId}: ${msg}`);
    return { success: false, error: msg, deviceId, deviceName: device.name };
  } finally {
    safeDisconnect(zk);
    activeConnections.delete(String(deviceId));
    realtimeListener.resumeListener(deviceId, null);
  }
}

module.exports = {
  connectDevice,
  disconnectDevice,
  pullLogs,
  pullAllDevices,
  testConnection,
  pingDevice,
  getDeviceUsers,
  deleteDeviceUser,
  isDeviceSyncRunning,
  STATUS,
};
