/**
 * realtimeListenerService.js — Real-Time Biometric Event Ingestion
 *
 * Maintains ONE persistent TCP connection per enabled/auto-sync device using
 * node-zklib's getRealTimeLogs(), which sends CMD_REG_EVENT (EF_ATTLOG) on the
 * existing ZK protocol session. The device then pushes a small packet to us
 * the instant a fingerprint/card punch happens — no polling required.
 *
 * This is now the PRIMARY ingestion path:
 *   punch event → DB insert (idempotent) → recalc day/payroll → socket emit
 *
 * The convergence-poll in zktecoService.pullLogs remains as a BACKGROUND
 * RECOVERY path only (see syncScheduler) — it is never the source of truth.
 *
 * Connection lifecycle:
 *  - createSocket() + CMD_CONNECT handshake (same as a normal sync connection)
 *  - TCP keepalive enabled (OS-level dead-connection detection, no extra
 *    protocol traffic — avoids fighting the permanent CMD_REG_EVENT 'data'
 *    listener that getRealTimeLogs() installs on the socket)
 *  - on close/error → reconnect with exponential backoff (5s → 60s cap)
 *  - periodic proactive refresh (every few hours) to avoid any silently
 *    half-dead long-lived connection
 *  - pause()/resume() let a recovery poll briefly take over the device's
 *    single TCP session without the two paths fighting each other
 *
 * ─── Reconnect ownership model ────────────────────────────────────────────
 * Every connection attempt gets a unique `listenerGeneration` ("gen"). The
 * socket-level error/close handlers created during that attempt capture their
 * own gen and only act if it still matches `state.activeGen` — any code path
 * that intentionally tears down a connection (periodic refresh, heartbeat
 * self-heal, missed-events recovery, pause) bumps `activeGen` FIRST, so late
 * 'close'/'error' callbacks from the old socket are recognized as stale and
 * ignored ([RT-RECONNECT-SKIP]).
 *
 * On top of that, `state.reconnectScheduled` makes reconnect scheduling
 * single-owner: once a reconnect timer is pending, any further
 * scheduleReconnect() calls for the same device are no-ops
 * ([RT-RECONNECT-SKIP]) until the timer fires (or is cancelled,
 * [RT-RECONNECT-CANCEL]). This prevents reconnect storms / duplicate
 * [RT-RECONNECT] events for a single disconnect lifecycle.
 */

const ZKLib = require('node-zklib');
const { getPrisma } = require('../utils/prisma');
const { isValidPunchTimestamp } = require('../utils/timestamps');
const moment = require('moment');
const logger = require('../utils/logger');
const attendanceEngine = require('../engines/attendanceEngine');
const payrollEngine = require('../engines/payrollEngine');

const prisma = getPrisma();

// deviceId (Number) → listener state
const listeners = new Map();

const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 60000;
const MAX_INGEST_RETRIES = 3;
const TCP_KEEPALIVE_DELAY_MS = 30000;
// How stale "newest visible record" vs "last realtime event" must be before
// we treat the listener as having missed live events and force a reconnect.
const MISSED_EVENT_SLACK_MS = 5000;
// How often to verify a "connected" listener's socket is actually still alive.
const HEARTBEAT_INTERVAL_MS = 60000;
// A connection attempt (createSocket + CMD_REG_EVENT registration) stuck in
// 'connecting' longer than this is treated as hung and force-recycled — some
// failure modes leave both promises pending forever, and nothing else watches
// the 'connecting' state.
const CONNECT_STUCK_MS = 90 * 1000;

let heartbeatTimer = null;
// Monotonic id for reconnect timers — purely for diagnostics/logging so we
// can tell distinct scheduled reconnects apart in logs/getStatus().
let timerIdCounter = 0;

function emit(io, event, data) {
  if (io) io.emit(event, data);
}

function safeDisconnect(zk) {
  if (!zk) return;
  try {
    const p = zk.disconnect();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {}
}

function zkErrorMessage(err, fallback = 'unknown error') {
  if (!err) return fallback;
  if (typeof err.message === 'string' && err.message) return err.message;
  if (typeof err.getError === 'function') {
    const inner = err.getError();
    if (inner?.err?.message) return inner.err.message;
  }
  if (err.err?.message) return err.err.message;
  return fallback;
}

// ─── Checkpoint advance ────────────────────────────────────────────────────
// Realtime events become the source of truth for "newest seen" — advance
// lastSuccessfulTimestamp forward only, never backward.
async function advanceCheckpoint(deviceId, timestamp) {
  // Defense-in-depth: a poisoned (future) checkpoint makes the incremental
  // sync window skip every real record forever. Never advance with a
  // timestamp that fails sanity validation.
  if (!isValidPunchTimestamp(timestamp)) {
    logger.warn(`[TS-INVALID] device=${deviceId} checkpoint advance REFUSED for invalid timestamp ${timestamp?.toISOString?.() ?? timestamp}`);
    return;
  }
  try {
    const device = await prisma.device.findUnique({
      where: { id: deviceId },
      select: { lastSuccessfulTimestamp: true },
    });
    if (!device) return;
    if (!device.lastSuccessfulTimestamp || timestamp > device.lastSuccessfulTimestamp) {
      await prisma.device.update({
        where: { id: deviceId },
        data: { lastSuccessfulTimestamp: timestamp },
      });
    }
  } catch (err) {
    logger.warn(`[RT] device=${deviceId} checkpoint advance failed: ${err.message}`);
  }
}

// ─── Ingest a single realtime punch (exactly-once, retried) ───────────────
async function ingestPunch(deviceId, io, zkUserId, timestamp, attempt = 1) {
  try {
    // Phase 23.1: a number is now allowed to be shared by (one active +
    // N stopped) employees when reused after termination — a live punch for
    // that number always belongs to whoever currently holds it, so an
    // active match must always win over a historical one. `orderBy` (not a
    // second query) keeps this a single round-trip; MySQL boolean columns
    // sort false(0) before true(1), so `desc` puts the active row first.
    const employee = await prisma.employee.findFirst({
      where: { zkUserId },
      select: { id: true, name: true, code: true },
      orderBy: { status: 'desc' },
    });

    let inserted = true;
    try {
      await prisma.attendanceLog.create({
        data: {
          deviceId,
          zkUserId,
          employeeId: employee?.id ?? null,
          timestamp,
          verifyType: 0,
          source: 'device-realtime',
        },
      });
    } catch (e) {
      if (e.code === 'P2002') {
        // Already ingested (e.g. recovery poll got it first) — idempotent no-op.
        inserted = false;
      } else {
        throw e;
      }
    }

    const state = listeners.get(deviceId);
    const gen = state?.activeGen ?? null;

    logger.info(
      `[RT-PUNCH] device=${deviceId} gen=${gen} punch zkUserId=${zkUserId} at=${timestamp.toISOString()} ` +
      `${inserted ? 'inserted' : 'duplicate (already known)'}` +
      `${employee ? ` → employee #${employee.id} (${employee.name})` : ' → unlinked (no matching employee)'}`
    );

    if (inserted) {
      await prisma.device.update({
        where: { id: deviceId },
        data: {
          lastSync: new Date(),
          totalLogsCount: { increment: 1 },
          status: 'online',
          errorMessage: null,
          consecutiveErrors: 0,
        },
      }).catch(() => {});

      await advanceCheckpoint(deviceId, timestamp);
    }

    emit(io, 'attendance:realtime', {
      deviceId,
      zkUserId,
      timestamp,
      employeeId: employee?.id ?? null,
      employeeName: employee?.name ?? null,
      employeeCode: employee?.code ?? null,
      duplicate: !inserted,
    });

    if (inserted && employee?.id) {
      try {
        await attendanceEngine.processDate(timestamp, employee.id);
        const m = moment(timestamp);
        // C1: a live punch is an automatic background trigger, not a direct
        // edit of a Payroll row — a punch that happens to land in an
        // already-finalized/paid month (device clock skew, a backlog punch,
        // a late leaver clocking out after that month closed) must not
        // silently overwrite it. Same canonical check every other cascade
        // caller uses (Phase 13.3).
        const { allowed, protectedTargets } = await payrollEngine.filterProtectedPayrollTargets([
          { employeeId: employee.id, month: m.month() + 1, year: m.year() },
        ]);
        if (protectedTargets.length) {
          logger.warn(`[RT] payroll SKIPPED (finalized/paid) device=${deviceId} employee=${employee.id} ${m.month() + 1}/${m.year()} (${protectedTargets[0].status})`);
        } else if (allowed.length) {
          await payrollEngine.calculatePayroll(employee.id, m.month() + 1, m.year());
        }
        emit(io, 'attendance:processed', {
          employeeId: employee.id, employeeName: employee.name,
          timestamp, source: 'realtime',
        });
      } catch (err) {
        logger.error(`[RT] recalc failed device=${deviceId} employee=${employee.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[RT-ERROR] ingest failed device=${deviceId} zkUserId=${zkUserId} attempt=${attempt}: ${err.message}`);
    if (attempt < MAX_INGEST_RETRIES) {
      const delay = attempt * 2000;
      setTimeout(() => {
        ingestPunch(deviceId, io, zkUserId, timestamp, attempt + 1).catch(() => {});
      }, delay);
    } else {
      logger.error(
        `[RT-ERROR] giving up on punch device=${deviceId} zkUserId=${zkUserId} at=${timestamp.toISOString()} ` +
        `after ${attempt} attempts — will be picked up by background recovery sync`
      );
    }
  }
}

// ─── Realtime event callback (from node-zklib's CMD_REG_EVENT listener) ──
function handlePunchEvent(deviceId, io, log) {
  const state = listeners.get(deviceId);
  const receivedAt = new Date();
  if (state) state.lastEventAt = receivedAt;

  const { userId, attTime } = log || {};
  const timestamp = attTime instanceof Date ? attTime : new Date(attTime);

  if (!userId || isNaN(timestamp.getTime())) {
    logger.warn(`[RT] device=${deviceId} ignored malformed realtime event: ${JSON.stringify(log)}`);
    return;
  }

  // Quarantine garbage device-clock timestamps — they must never reach the DB,
  // the checkpoint, or the per-punch recalc path (see utils/timestamps.js).
  if (!isValidPunchTimestamp(timestamp)) {
    logger.warn(`[TS-INVALID] device=${deviceId} realtime punch REJECTED: zkUserId=${userId} at=${timestamp.toISOString()} — device clock looks wrong, punch quarantined`);
    emit(io, 'device:integrity-warning', {
      deviceId, message: `Realtime punch rejected: invalid device timestamp (${timestamp.toISOString()})`,
    });
    return;
  }

  if (state) {
    const latencyMs = receivedAt.getTime() - timestamp.getTime();
    state.lastRealtimePunchAt = receivedAt;
    state.lastEventLatencyMs = latencyMs;
    logger.info(`[RT-LATENCY] device=${deviceId} gen=${state.activeGen} zkUserId=${userId} eventLatencyMs=${latencyMs}`);
  }

  ingestPunch(deviceId, io, String(userId), timestamp).catch((err) => {
    logger.error(`[RT-ERROR] unexpected ingest error device=${deviceId}: ${err.message}`);
  });
}

// ─── Reconnect scheduling ──────────────────────────────────────────────────
// Single-owner + race-safe: a reconnect can be requested from many places
// (socket close/error, heartbeat, periodic refresh, missed-events, connect
// failure). Only ONE pending reconnect timer may exist per device at a time.
//
// `gen`, when provided, identifies the listener generation the caller's
// socket callback belongs to. If it no longer matches `state.activeGen` the
// callback is stale (its connection has already been torn down by another
// path) and the request is ignored.
function scheduleReconnect(deviceId, io, reason, immediate = false, gen = null) {
  const state = listeners.get(deviceId);
  if (!state || state.stopped || state.pausedForSync) return;

  if (gen !== null && gen !== state.activeGen) {
    logger.info(`[RT-RECONNECT-SKIP] device=${deviceId} reason="${reason}" gen=${gen} activeGen=${state.activeGen} — stale callback ignored`);
    return;
  }

  if (state.reconnectScheduled) {
    logger.info(
      `[RT-RECONNECT-SKIP] device=${deviceId} reason="${reason}" — reconnect already scheduled ` +
      `by "${state.reconnectOwner}" at ${state.reconnectScheduledAt ? state.reconnectScheduledAt.toISOString() : 'unknown'} ` +
      `(timer #${state.reconnectTimerId}) — ignoring duplicate request`
    );
    return;
  }

  state.status = 'reconnecting';
  state.zk = null;
  state.reconnectAttempts = (state.reconnectAttempts || 0) + 1;
  state.reconnectCount = (state.reconnectCount || 0) + 1;

  const delay = immediate ? 1000 : Math.min(state.reconnectAttempts * RECONNECT_BASE_MS, RECONNECT_MAX_MS);

  state.reconnectScheduled = true;
  state.reconnectOwner = reason;
  state.reconnectReason = reason;
  state.reconnectScheduledAt = new Date();
  state.reconnectTimerId = ++timerIdCounter;

  logger.warn(
    `[RT-RECONNECT] device=${deviceId} "${state.deviceName}" disconnected (${reason}) — ` +
    `reconnecting in ${Math.round(delay / 1000)}s (attempt ${state.reconnectAttempts}, total ${state.reconnectCount}, ` +
    `gen=${state.activeGen}, timer #${state.reconnectTimerId})`
  );
  emit(io, 'device:realtime-status', {
    deviceId, status: 'reconnecting', reason, attempt: state.reconnectAttempts,
    generation: state.activeGen,
  });

  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectScheduled = false;
    state.reconnectTimer = null;
    connectListener(deviceId, io);
  }, delay);
}

// ─── Connect (or reconnect) the persistent realtime listener ──────────────
async function connectListener(deviceId, io) {
  const state = listeners.get(deviceId);
  if (!state || state.stopped || state.pausedForSync) return;
  if (state.status === 'connected' || state.status === 'connecting') return;

  state.status = 'connecting';
  state.connectStartedAt = new Date(); // watched by the stuck-connecting heartbeat check
  // Claim ownership of this connection attempt: a fresh generation, no
  // pending reconnect, and any leftover "intentional teardown" flag from a
  // previous generation no longer applies.
  state.reconnectScheduled = false;
  state.intentionalDisconnect = false;
  const connGen = ++state.listenerGeneration;
  state.activeGen = connGen;

  let device;
  try {
    device = await prisma.device.findUnique({ where: { id: deviceId } });
  } catch (err) {
    logger.error(`[RT] device=${deviceId} lookup failed: ${err.message}`);
    scheduleReconnect(deviceId, io, 'db lookup failed', false, connGen);
    return;
  }

  if (!device || !device.enabled || !device.autoSync || device.isArchived) {
    logger.info(`[RT] device=${deviceId} no longer eligible for realtime listening — stopping`);
    stopListener(deviceId);
    return;
  }

  state.deviceName = device.name;

  const zk = new ZKLib(device.ipAddress, device.port, 8000, 4000);
  let settled = false;

  // Both handlers below capture `connGen`. They only act if:
  //  1. `connGen` still matches `state.activeGen` (this socket is still the
  //     "current" one — otherwise it's a late event from an already
  //     torn-down generation), AND
  //  2. the teardown wasn't intentional (i.e. nobody already scheduled a
  //     reconnect for this generation via refresh/heartbeat/missed-events).
  const onSocketError = (err) => {
    if (settled) {
      if (connGen !== state.activeGen) {
        logger.info(`[RT-RECONNECT-SKIP] device=${deviceId} stale socket error ignored (gen=${connGen}, active=${state.activeGen})`);
        return;
      }
      if (state.intentionalDisconnect) {
        state.intentionalDisconnect = false;
        logger.info(`[RT-RECONNECT-SKIP] device=${deviceId} socket error after intentional teardown ignored (gen=${connGen})`);
        return;
      }
      logger.error(`[RT-ERROR] device=${deviceId} socket error: ${zkErrorMessage(err, 'socket error')}`);
      scheduleReconnect(deviceId, io, zkErrorMessage(err, 'socket error'), false, connGen);
      return;
    }
    settled = true;
  };
  const onSocketClose = () => {
    if (settled) {
      if (connGen !== state.activeGen) {
        logger.info(`[RT-RECONNECT-SKIP] device=${deviceId} stale socket close ignored (gen=${connGen}, active=${state.activeGen})`);
        return;
      }
      if (state.intentionalDisconnect) {
        state.intentionalDisconnect = false;
        logger.info(`[RT-RECONNECT-SKIP] device=${deviceId} socket close after intentional teardown ignored (gen=${connGen})`);
        return;
      }
      scheduleReconnect(deviceId, io, 'connection closed', false, connGen);
      return;
    }
    settled = true;
  };

  try {
    await zk.createSocket(onSocketError, onSocketClose);

    // OS-level dead-connection detection — no extra protocol traffic, so it
    // never collides with the permanent CMD_REG_EVENT 'data' listener below.
    try { zk.zklibTcp?.socket?.setKeepAlive(true, TCP_KEEPALIVE_DELAY_MS); } catch {}

    await zk.getRealTimeLogs((log) => handlePunchEvent(deviceId, io, log));

    settled = true;
    state.zk = zk;
    state.status = 'connected';
    state.connectedAt = new Date();
    state.lastHeartbeat = new Date();
    state.reconnectAttempts = 0;

    await prisma.device.update({
      where: { id: deviceId },
      data: { status: 'online', errorMessage: null, consecutiveErrors: 0 },
    }).catch(() => {});

    logger.info(`[RT] device=${deviceId} "${device.name}" (${device.ipAddress}:${device.port}) realtime listener connected (gen=${connGen})`);
    emit(io, 'device:realtime-status', { deviceId, status: 'connected', name: device.name, generation: connGen });
  } catch (err) {
    settled = true;
    safeDisconnect(zk);
    logger.error(`[RT-ERROR] device=${deviceId} connect failed: ${zkErrorMessage(err, 'connect failed')}`);
    scheduleReconnect(deviceId, io, zkErrorMessage(err, 'connect failed'), false, connGen);
  }
}

// ─── Pause / Resume (coordination with recovery polls) ─────────────────────
// A recovery poll needs the device's single TCP session for itself. We
// gracefully drop our connection first so the device doesn't see two
// concurrent sessions, then reconnect once the poll is done.
function pauseListener(deviceId) {
  const id = Number(deviceId);
  const state = listeners.get(id);
  if (!state) return;

  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    logger.info(`[RT-RECONNECT-CANCEL] device=${id} cancelled pending reconnect (reason="${state.reconnectReason}", timer #${state.reconnectTimerId}) — pausing for recovery sync`);
  }
  state.reconnectTimer = null;
  state.reconnectScheduled = false;
  state.pausedForSync = true;
  state.status = 'paused';
  state.intentionalDisconnect = true;
  // Bump generation so any late close/error from the dropped socket is
  // recognized as stale and ignored.
  state.activeGen = ++state.listenerGeneration;

  if (state.zk) {
    safeDisconnect(state.zk);
    state.zk = null;
  }
  logger.info(`[RT-LISTENER-CLEANUP] device=${id} listener paused for recovery sync (gen=${state.listenerGeneration})`);
}

function resumeListener(deviceId, io) {
  const id = Number(deviceId);
  const state = listeners.get(id);
  if (!state || state.stopped) return;

  state.pausedForSync = false;
  state.status = 'reconnecting';
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);

  state.reconnectScheduled = true;
  state.reconnectOwner = 'resume after pause';
  state.reconnectReason = 'resume after pause';
  state.reconnectScheduledAt = new Date();
  state.reconnectTimerId = ++timerIdCounter;

  logger.info(`[RT-RECONNECT] device=${id} resuming listener after recovery sync — reconnecting in 1.5s (timer #${state.reconnectTimerId})`);

  // Small delay so the device fully closes the recovery poll's session first.
  state.reconnectTimer = setTimeout(() => {
    state.reconnectScheduled = false;
    state.reconnectTimer = null;
    connectListener(id, io);
  }, 1500);
}

// ─── Missed-event detection ────────────────────────────────────────────────
// Called by zktecoService.pullLogs after a recovery poll. If the listener
// claims to be connected but the recovery poll found a NEWER record than the
// last realtime event we actually received, the listener silently missed
// live punches — force a reconnect.
function checkForMissedEvents(deviceId, dbNewestTs, io) {
  const id = Number(deviceId);
  const state = listeners.get(id);
  if (!state || !dbNewestTs) return;

  const newestMs = new Date(dbNewestTs).getTime();
  const referenceMs = (state.lastEventAt || state.connectedAt || new Date(0)).getTime();

  // Recovery polls call this while the listener is PAUSED (pullLogs pauses it
  // before taking the device's TCP session) — the old `status==='connected'`
  // guard made this entire check dead code. While paused, a fresh reconnect is
  // already guaranteed by resumeListener(), so detection-only is correct here:
  // log + emit the diagnostic, skip the redundant forced reconnect.
  if (state.status === 'paused') {
    if (newestMs > referenceMs + MISSED_EVENT_SLACK_MS && state.lastEventAt) {
      logger.warn(
        `[RT-MISSED] device=${id} "${state.deviceName}": recovery pull found a record ` +
        `(${new Date(dbNewestTs).toISOString()}) newer than the last realtime event ` +
        `(${state.lastEventAt.toISOString()}) — listener missed live punches; fresh connection coming via resume`
      );
      emit(io, 'device:realtime-status', {
        deviceId: id, status: 'missed-events', newest: dbNewestTs, lastEvent: state.lastEventAt,
      });
    }
    return;
  }

  if (state.status !== 'connected') return;

  if (newestMs > referenceMs + MISSED_EVENT_SLACK_MS) {
    if (state.reconnectScheduled) {
      logger.info(`[RT-RECONNECT-SKIP] device=${id} missed-events reconnect skipped — already scheduled by "${state.reconnectOwner}"`);
      return;
    }

    logger.warn(
      `[RT-RECONNECT] device=${id} "${state.deviceName}": recovery pull found a record newer ` +
      `(${new Date(dbNewestTs).toISOString()}) than the last realtime event ` +
      `(${state.lastEventAt ? state.lastEventAt.toISOString() : 'none since connect'}) — ` +
      `listener appears to have missed live events, forcing reconnect`
    );
    emit(io, 'device:realtime-status', {
      deviceId: id, status: 'missed-events', newest: dbNewestTs, lastEvent: state.lastEventAt || null,
    });
    state.intentionalDisconnect = true;
    // Bump generation so the dropped socket's late close/error is ignored.
    state.activeGen = ++state.listenerGeneration;
    safeDisconnect(state.zk);
    state.zk = null;
    state.status = 'reconnecting';
    scheduleReconnect(id, io, 'missed events detected', true);
  }
}

// ─── Lifecycle: start / stop / restart / startAll / refreshAll ────────────
function startListener(deviceId, io) {
  const id = Number(deviceId);
  if (listeners.has(id)) return;
  listeners.set(id, {
    status: 'disconnected',
    reconnectAttempts: 0,
    reconnectCount: 0,
    stopped: false,
    pausedForSync: false,
    zk: null,
    connectedAt: null,
    connectStartedAt: null,
    lastEventAt: null,
    lastRealtimePunchAt: null,
    lastEventLatencyMs: null,
    lastHeartbeat: null,
    reconnectTimer: null,
    reconnectTimerId: null,
    reconnectScheduled: false,
    reconnectOwner: null,
    reconnectReason: null,
    reconnectScheduledAt: null,
    listenerGeneration: 0,
    activeGen: 0,
    deviceName: null,
    intentionalDisconnect: false,
  });
  connectListener(id, io);
}

function stopListener(deviceId) {
  const id = Number(deviceId);
  const state = listeners.get(id);
  if (!state) return;

  state.stopped = true;
  // Bump generation so any in-flight socket callback from the current
  // connection is recognized as stale and does nothing once we delete state.
  state.activeGen = ++state.listenerGeneration;

  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    logger.info(`[RT-RECONNECT-CANCEL] device=${id} cancelled pending reconnect (reason="${state.reconnectReason}", timer #${state.reconnectTimerId}) — listener stopping`);
  }
  state.reconnectTimer = null;
  state.reconnectScheduled = false;

  if (state.zk) safeDisconnect(state.zk);
  listeners.delete(id);
  logger.info(`[RT-LISTENER-CLEANUP] device=${id} realtime listener stopped (final gen=${state.listenerGeneration})`);
}

function restartListener(deviceId, io) {
  const id = Number(deviceId);
  stopListener(id);
  startListener(id, io);
}

async function startAll(io) {
  try {
    const devices = await prisma.device.findMany({
      where: { enabled: true, autoSync: true, isArchived: false },
      select: { id: true, name: true },
    });
    for (const d of devices) startListener(d.id, io);
    logger.info(`[RT] started realtime listeners for ${devices.length} device(s)`);
  } catch (err) {
    logger.error(`[RT] startAll failed: ${err.message}`);
  }

  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => checkHeartbeats(io), HEARTBEAT_INTERVAL_MS);
  }
}

// ─── Graceful shutdown ──────────────────────────────────────────────────────
// Stops every listener (cancelling pending reconnect timers, closing sockets)
// and the heartbeat interval — so process exit leaves no orphan timers and no
// half-open device sessions the device would have to time out on its own.
function stopAll() {
  const ids = [...listeners.keys()];
  for (const id of ids) stopListener(id);
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  logger.info(`[SHUTDOWN] realtime listeners stopped (${ids.length} device(s)), heartbeat cleared`);
}

// ─── Heartbeat / stale-listener self-heal ─────────────────────────────────
// A "connected" listener relies on TCP keepalive + the OS to notice a dead
// socket, but some failure modes (e.g. a frozen remote stack) leave the
// socket object looking open with no error/close ever firing. Periodically
// verify the underlying socket is still usable; if not, force a reconnect.
function checkHeartbeats(io) {
  for (const [deviceId, state] of listeners) {
    if (state.stopped || state.pausedForSync) continue;

    // Stuck-'connecting' watchdog: if createSocket()/getRealTimeLogs() hang
    // without ever resolving OR rejecting, the listener would previously sit
    // in 'connecting' forever — invisible to every other recovery path, which
    // only watches 'connected'. Recycle the attempt after CONNECT_STUCK_MS.
    if (state.status === 'connecting'
        && state.connectStartedAt
        && Date.now() - state.connectStartedAt.getTime() > CONNECT_STUCK_MS) {
      if (state.reconnectScheduled) continue;
      logger.warn(`[RT-RECONNECT] device=${deviceId} "${state.deviceName}": connect attempt stuck for >${CONNECT_STUCK_MS / 1000}s — recycling (gen=${state.activeGen})`);
      state.intentionalDisconnect = true;
      state.activeGen = ++state.listenerGeneration; // orphan the hung attempt's callbacks
      safeDisconnect(state.zk);
      state.zk = null;
      state.status = 'reconnecting';
      scheduleReconnect(deviceId, io, 'heartbeat: stuck connecting', true);
      continue;
    }

    if (state.status !== 'connected') continue;

    const socket = state.zk?.zklibTcp?.socket;
    const dead = !socket || socket.destroyed || socket.readyState === 'closed';

    if (dead) {
      if (state.reconnectScheduled) {
        logger.info(`[RT-RECONNECT-SKIP] device=${deviceId} heartbeat dead-socket reconnect skipped — already scheduled by "${state.reconnectOwner}"`);
        continue;
      }

      logger.warn(`[RT-RECONNECT] device=${deviceId} "${state.deviceName}": heartbeat check found a dead/destroyed socket — forcing reconnect`);
      state.intentionalDisconnect = true;
      // Bump generation so the dead socket's late close/error (if any) is ignored.
      state.activeGen = ++state.listenerGeneration;
      state.zk = null;
      state.status = 'reconnecting';
      scheduleReconnect(deviceId, io, 'heartbeat: dead socket', true);
      continue;
    }

    state.lastHeartbeat = new Date();
  }
}

// Proactive periodic refresh of long-lived connections — cheap insurance
// against any silently half-dead socket TCP keepalive didn't catch.
function refreshAll(io) {
  for (const [deviceId, state] of listeners) {
    if (state.status === 'connected' && !state.pausedForSync) {
      if (state.reconnectScheduled) {
        logger.info(`[RT-RECONNECT-SKIP] device=${deviceId} periodic refresh skipped — reconnect already scheduled by "${state.reconnectOwner}"`);
        continue;
      }

      logger.info(`[RT] device=${deviceId} periodic connection refresh (gen ${state.listenerGeneration} -> ${state.listenerGeneration + 1})`);
      state.intentionalDisconnect = true;
      // Bump generation BEFORE disconnecting so the old socket's late
      // close/error callbacks are recognized as stale and ignored.
      state.activeGen = ++state.listenerGeneration;
      const oldZk = state.zk;
      state.zk = null;
      state.status = 'reconnecting';
      safeDisconnect(oldZk);
      scheduleReconnect(deviceId, io, 'periodic refresh', true);
    }
  }
}

// ─── Telemetry ──────────────────────────────────────────────────────────────
function getStatus() {
  const result = {};
  for (const [deviceId, state] of listeners) {
    result[deviceId] = {
      status: state.status,
      listenerState: state.status,
      connectedAt: state.connectedAt,
      realtimeConnectedAt: state.connectedAt,
      lastEventAt: state.lastEventAt,
      lastRealtimePunchAt: state.lastRealtimePunchAt,
      lastHeartbeat: state.lastHeartbeat,
      eventLatencyMs: state.lastEventLatencyMs,
      reconnectAttempts: state.reconnectAttempts,
      reconnectCount: state.reconnectCount || 0,
      pausedForSync: state.pausedForSync,
      // Lifecycle / ownership diagnostics (Task #7 hardening)
      listenerGeneration: state.listenerGeneration,
      activeGeneration: state.activeGen,
      reconnectScheduled: state.reconnectScheduled,
      reconnectOwner: state.reconnectOwner,
      reconnectReason: state.reconnectReason,
      reconnectScheduledAt: state.reconnectScheduledAt,
      reconnectTimerId: state.reconnectTimerId,
    };
  }
  return result;
}

// ─── Runtime invariant checks ──────────────────────────────────────────────
// Per device, at any time there must be AT MOST one active socket
// (status==='connected' with a live zk) and AT MOST one pending reconnect
// timer — and never both at once. Logs [RT-RECONNECT] errors loudly if an
// invariant is ever violated so regressions are caught immediately.
function getDiagnostics() {
  let activeListenerCount = 0;
  let activeReconnectTimerCount = 0;
  const issues = [];

  for (const [deviceId, state] of listeners) {
    const hasTimer = !!state.reconnectTimer;

    if (state.status === 'connected' && state.zk) activeListenerCount++;
    if (hasTimer) activeReconnectTimerCount++;

    if (state.status === 'connected' && hasTimer) {
      issues.push(`device=${deviceId} has an active connection AND a pending reconnect timer (gen=${state.activeGen}, timer #${state.reconnectTimerId})`);
    }
    if (state.reconnectScheduled !== hasTimer) {
      issues.push(`device=${deviceId} reconnectScheduled=${state.reconnectScheduled} inconsistent with timer presence=${hasTimer}`);
    }
  }

  if (issues.length) {
    logger.error(`[RT-RECONNECT] diagnostics violation detected: ${issues.join('; ')}`);
  }

  return {
    deviceCount: listeners.size,
    activeListenerCount,
    activeReconnectTimerCount,
    issues,
  };
}

module.exports = {
  startAll,
  stopAll,
  startListener,
  stopListener,
  restartListener,
  refreshAll,
  pauseListener,
  resumeListener,
  checkForMissedEvents,
  getStatus,
  getDiagnostics,
};
