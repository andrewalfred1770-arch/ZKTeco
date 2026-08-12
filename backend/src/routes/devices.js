/**
 * devices.js — Device Management API
 *
 * GET    /                    list all devices with stats
 * POST   /                    create device
 * PUT    /:id                 update device
 * DELETE /:id                 delete device
 * POST   /:id/sync            manual sync
 * POST   /sync-all            sync all enabled devices
 * POST   /test-connection     test IP:port reachability
 * POST   /:id/ping            live status ping
 * GET    /:id/sync-logs       sync history for one device
 * GET    /sync-logs/recent    last N sync events across all devices
 * GET    /stats               aggregate stats for KPI cards
 * POST   /relink              re-link all orphaned attendance_logs by zkUserId
 * GET    /relink-diagnostics  per-zkUserId link status report
 * GET    /realtime-status     realtime listener connection status (all devices)
 * POST   /:id/realtime/restart restart a device's realtime listener
 * GET    /:id/recovery-diagnostics background-recovery health + missing-day report
 */

const router = require('express').Router();
const { getPrisma } = require('../utils/prisma');
const { pullLogs, pullAllDevices, testConnection, pingDevice, getDeviceUsers } = require('../services/zktecoService');
const { relinkAttendanceLogs, getRelinkDiagnostics } = require('../services/relinkService');
const realtimeListener = require('../services/realtimeListenerService');
const { authenticate, authorize } = require('../middleware/auth');

const prisma = getPrisma();
router.use(authenticate);

// ── Helper: device with computed fields ──────────────────────────────────────
function formatDevice(d) {
  return {
    ...d,
    lastSyncAgo: d.lastSync
      ? Math.round((Date.now() - new Date(d.lastSync).getTime()) / 1000)
      : null,
  };
}

// Phase 31 (F1 fix — Phase 25 audit, Critical): device/ZKTeco diagnostic GETs
// previously required only a valid login. Device IPs and sync diagnostics
// aren't employee-relevant data, so admin/hr only — matching the
// already-correctly-gated write routes below.
// ── List all devices ──────────────────────────────────────────────────────────
router.get('/', authorize('admin', 'hr'), async (req, res) => {
  try {
    const devices = await prisma.device.findMany({
      where: { isArchived: false },
      include: { branch: true },
      orderBy: { name: 'asc' },
    });
    // Attach total raw-log count per device
    const logCounts = await prisma.attendanceLog.groupBy({
      by: ['deviceId'],
      _count: { id: true },
    });
    const countMap = Object.fromEntries(logCounts.map(r => [r.deviceId, r._count.id]));

    res.json(devices.map(d => formatDevice({
      ...d,
      rawLogCount: countMap[d.id] || 0,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Aggregate stats for KPI cards ─────────────────────────────────────────────
router.get('/stats', authorize('admin', 'hr'), async (req, res) => {
  try {
    const devices = await prisma.device.findMany({ where: { isArchived: false }, select: { status: true, lastSync: true, totalLogsCount: true } });
    const online   = devices.filter(d => d.status === 'online').length;
    const offline  = devices.filter(d => d.status === 'offline' || d.status === 'error').length;
    const syncing  = devices.filter(d => d.status === 'syncing').length;
    const lastSync = devices
      .filter(d => d.lastSync)
      .sort((a, b) => new Date(b.lastSync) - new Date(a.lastSync))[0]?.lastSync || null;
    const totalLogs = devices.reduce((s, d) => s + (d.totalLogsCount || 0), 0);

    // Last 24h sync count
    const yesterday = new Date(Date.now() - 86400000);
    const recentSyncs = await prisma.deviceSyncLog.count({
      where: { startedAt: { gte: yesterday }, status: 'success' },
    });

    res.json({ total: devices.length, online, offline, syncing, lastSync, totalLogs, recentSyncs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Recent sync logs (all devices) ────────────────────────────────────────────
router.get('/sync-logs/recent', authorize('admin', 'hr'), async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const logs = await prisma.deviceSyncLog.findMany({
      orderBy: { startedAt: 'desc' },
      take: limit,
      include: { device: { select: { name: true, ipAddress: true, branch: { select: { name: true } } } } },
    });
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Relink diagnostics ────────────────────────────────────────────────────────
// Per-zkUserId report: linked Employee (if any), linked/unlinked log counts.
// Must be registered before GET /:id so it isn't shadowed by the :id matcher.
router.get('/relink-diagnostics', authorize('admin', 'hr'), async (req, res) => {
  try {
    const result = await getRelinkDiagnostics();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Realtime listener status (all devices) ───────────────────────────────────
// Must be registered before GET /:id so it isn't shadowed by the :id matcher.
router.get('/realtime-status', authorize('admin', 'hr'), async (req, res) => {
  try {
    res.json({
      devices: realtimeListener.getStatus(),
      diagnostics: realtimeListener.getDiagnostics(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Get single device ─────────────────────────────────────────────────────────
router.get('/:id', authorize('admin', 'hr'), async (req, res) => {
  try {
    const device = await prisma.device.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { branch: true },
    });
    if (!device) return res.status(404).json({ error: 'Device not found' });
    res.json(formatDevice(device));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sync logs for one device ───────────────────────────────────────────────────
router.get('/:id/sync-logs', authorize('admin', 'hr'), async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const logs = await prisma.deviceSyncLog.findMany({
      where: { deviceId: parseInt(req.params.id) },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Recovery diagnostics ──────────────────────────────────────────────────────
// Background-recovery health for one device: overall log coverage, last
// convergence result, and a missing-day report over a recent rolling window
// (older history can contain device-clock garbage timestamps and isn't
// actionable, so the gap report focuses on what recovery can realistically fix).
const RECOVERY_WINDOW_DAYS = 90;

router.get('/:id/recovery-diagnostics', authorize('admin', 'hr'), async (req, res) => {
  try {
    const deviceId = parseInt(req.params.id);
    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) return res.status(404).json({ error: 'Device not found' });

    const agg = await prisma.attendanceLog.aggregate({
      where: { deviceId },
      _min: { timestamp: true },
      _max: { timestamp: true },
      _count: { id: true },
    });

    const lastConvergenceLog = await prisma.deviceSyncLog.findFirst({
      where: { deviceId, status: { in: ['success', 'partial'] } },
      orderBy: { startedAt: 'desc' },
    });

    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - RECOVERY_WINDOW_DAYS * 86400000);
    const recentLogs = await prisma.attendanceLog.findMany({
      where: { deviceId, timestamp: { gte: windowStart, lte: windowEnd } },
      select: { timestamp: true },
    });
    const daysWithLogs = new Set(recentLogs.map(l => l.timestamp.toISOString().slice(0, 10)));
    const missingDays = [];
    for (let d = new Date(windowStart); d <= windowEnd; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      if (!daysWithLogs.has(key)) missingDays.push(key);
    }

    res.json({
      deviceId,
      deviceName: device.name,
      totalLogs: agg._count.id,
      oldestTimestamp: agg._min.timestamp,
      newestTimestamp: agg._max.timestamp,
      lastSuccessfulTimestamp: device.lastSuccessfulTimestamp,
      lastConvergence: lastConvergenceLog ? {
        startedAt: lastConvergenceLog.startedAt,
        completedAt: lastConvergenceLog.completedAt,
        status: lastConvergenceLog.status,
        convergencePasses: lastConvergenceLog.convergencePasses,
        newLogs: lastConvergenceLog.newLogs,
        zkErr: lastConvergenceLog.zkErr,
      } : null,
      recoveryWindowDays: RECOVERY_WINDOW_DAYS,
      missingDaysCount: missingDays.length,
      missingDays,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Topology guard ────────────────────────────────────────────────────────────
// Two active device rows pointing at the same ip:port = the same physical
// punches ingested twice under different deviceIds (the dedup unique key
// includes deviceId, so it can't save you). This already duplicated 16k+ rows
// once — block it at write time instead of only warning at audit time.
async function findDuplicateEndpoint(ipAddress, port, excludeId = null) {
  return prisma.device.findFirst({
    where: {
      ipAddress,
      port,
      isArchived: false,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, name: true },
  });
}

// ── Create device ─────────────────────────────────────────────────────────────
router.post('/', authorize('admin'), async (req, res) => {
  try {
    const { name, ipAddress, port, branchId, enabled, deviceNumber, syncInterval, autoSync } = req.body;
    const portNum = parseInt(port) || 4370;

    const dup = await findDuplicateEndpoint(ipAddress, portNum);
    if (dup) {
      return res.status(409).json({
        error: `يوجد جهاز نشط بنفس العنوان ${ipAddress}:${portNum} ("${dup.name}" #${dup.id}) — تكرار الجهاز يسبب ازدواج البصمات`,
      });
    }

    const device = await prisma.device.create({
      data: {
        name,
        ipAddress,
        port:         portNum,
        branchId:     parseInt(branchId),
        deviceNumber: parseInt(deviceNumber) || 1,
        syncInterval: parseInt(syncInterval) || 5,
        autoSync:     autoSync !== false,
        enabled:      enabled  !== false,
      },
      include: { branch: true },
    });

    // New eligible devices get their realtime listener immediately — they used
    // to wait for a backend restart or a subsequent device update.
    if (device.enabled && device.autoSync) {
      realtimeListener.startListener(device.id, req.io);
    }

    res.status(201).json(formatDevice(device));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Update device ─────────────────────────────────────────────────────────────
router.put('/:id', authorize('admin'), async (req, res) => {
  try {
    const { name, ipAddress, port, branchId, enabled, deviceNumber, syncInterval, autoSync } = req.body;
    const id = parseInt(req.params.id);
    const portNum = parseInt(port) || 4370;

    const dup = await findDuplicateEndpoint(ipAddress, portNum, id);
    if (dup) {
      return res.status(409).json({
        error: `يوجد جهاز نشط آخر بنفس العنوان ${ipAddress}:${portNum} ("${dup.name}" #${dup.id}) — تكرار الجهاز يسبب ازدواج البصمات`,
      });
    }

    const device = await prisma.device.update({
      where: { id },
      data: {
        name,
        ipAddress,
        port:         portNum,
        branchId:     parseInt(branchId),
        deviceNumber: parseInt(deviceNumber) || 1,
        syncInterval: parseInt(syncInterval) || 5,
        autoSync:     autoSync !== false,
        enabled:      enabled  !== false,
      },
      include: { branch: true },
    });

    // Connection details, enable/autoSync flags, or archival status may have
    // changed — restart (or stop) the realtime listener to match.
    if (device.enabled && device.autoSync && !device.isArchived) {
      realtimeListener.restartListener(device.id, req.io);
    } else {
      realtimeListener.stopListener(device.id);
    }

    res.json(formatDevice(device));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Delete device ─────────────────────────────────────────────────────────────
// Strategy: attempt a hard delete (removing the device + its sync logs). Raw
// attendance logs are NEVER deleted — they reference the device via a RESTRICT
// foreign key. If any raw logs exist, the hard delete throws (FK constraint), so
// we fall back to a soft delete (isArchived = true) which hides the device from
// every list/stat query while preserving its biometric history.
router.delete('/:id', authorize('admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'معرف الجهاز غير صالح' });

  try {
    const device = await prisma.device.findUnique({ where: { id } });
    if (!device) return res.status(404).json({ error: 'الجهاز غير موجود' });

    // EF-029.5: the physical device/listener can't participate in a DB
    // transaction, so the two are ordered instead — the in-memory listener is
    // only ever stopped AFTER a DB write is confirmed committed, never
    // before. Previously stopListener() ran unconditionally up front: if
    // every DB path below then failed, the device row stayed untouched
    // (still enabled) while its listener had already gone dark — a live
    // device silently stops receiving punches with no DB-visible sign
    // anything changed. Now, if nothing below commits, the listener is never
    // touched either — DB and in-memory state stay consistent on failure.

    // Does the device have raw attendance logs that must be preserved?
    const rawLogs = await prisma.attendanceLog.count({ where: { deviceId: id } });

    if (rawLogs > 0) {
      // Soft delete — keep biometric history intact.
      await prisma.device.update({
        where: { id },
        data: { isArchived: true, enabled: false, autoSync: false, status: 'offline' },
      });
      realtimeListener.stopListener(id); // DB confirmed archived — safe to stop now.
      return res.json({ message: 'Device archived', mode: 'soft', preservedLogs: rawLogs });
    }

    // No raw logs → attempt hard delete. Both statements now commit or roll
    // back together (previously two separate calls): a late-arriving
    // FK-restrict error — e.g. a new AttendanceLog row inserted by a
    // concurrent sync between the count above and this delete — could
    // previously leave the sync-log history already deleted while the device
    // row itself survived the failed delete. A single $transaction closes
    // that partial-state window; the outer catch below still falls back to
    // archiving on any failure, unchanged.
    await prisma.$transaction([
      prisma.deviceSyncLog.deleteMany({ where: { deviceId: id } }),
      prisma.device.delete({ where: { id } }),
    ]);
    realtimeListener.stopListener(id); // DB confirmed deleted — safe to stop now.
    return res.json({ message: 'Device deleted', mode: 'hard' });
  } catch (err) {
    // Last-resort fallback: if the hard delete still hit an FK constraint, archive.
    try {
      await prisma.device.update({
        where: { id },
        data: { isArchived: true, enabled: false, autoSync: false, status: 'offline' },
      });
      realtimeListener.stopListener(id); // DB confirmed archived — safe to stop now.
      return res.json({ message: 'Device archived', mode: 'soft-fallback' });
    } catch (err2) {
      // Neither the hard delete nor the fallback archive persisted anything —
      // the device row is untouched, and the listener was never stopped
      // either, so DB state and in-memory state remain consistent (both
      // still "active") rather than reporting or half-applying a change that
      // never actually happened.
      return res.status(500).json({ error: err2.message });
    }
  }
});

// ── Manual sync ───────────────────────────────────────────────────────────────
router.post('/:id/sync', authorize('admin', 'hr'), async (req, res) => {
  try {
    const deviceId = parseInt(req.params.id);
    const result   = await pullLogs(deviceId, req.io, 'manual');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sync all enabled devices ──────────────────────────────────────────────────
router.post('/sync-all', authorize('admin', 'hr'), async (req, res) => {
  try {
    const results = await pullAllDevices(req.io);
    const total   = results.reduce((s, r) => s + (r.count || 0), 0);
    res.json({ results, totalNewLogs: total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Test connection ───────────────────────────────────────────────────────────
router.post('/test-connection', authorize('admin'), async (req, res) => {
  try {
    const { ipAddress, port } = req.body;
    const result = await testConnection(ipAddress, port);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Live ping ─────────────────────────────────────────────────────────────────
router.post('/:id/ping', authorize('admin', 'hr'), async (req, res) => {
  try {
    const result = await pingDevice(parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Restart realtime listener ─────────────────────────────────────────────────
router.post('/:id/realtime/restart', authorize('admin', 'hr'), async (req, res) => {
  try {
    const deviceId = parseInt(req.params.id);
    realtimeListener.restartListener(deviceId, req.io);
    res.json({ message: 'Realtime listener restart requested', deviceId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Re-link orphaned attendance logs (إعادة ربط البصمات) ─────────────────────
// Re-links ALL attendance_logs with employeeId = NULL to any Employee sharing
// the same zkUserId, then regenerates attendance_daily + recalculates payroll
// for the affected employees/date ranges. No new sync required.
router.post('/relink', authorize('admin', 'hr'), async (req, res) => {
  try {
    const result = await relinkAttendanceLogs({ io: req.io, reason: 'manual-relink' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Device users ──────────────────────────────────────────────────────────────
router.get('/:id/users', authorize('admin'), async (req, res) => {
  try {
    const users = await getDeviceUsers(parseInt(req.params.id));
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
