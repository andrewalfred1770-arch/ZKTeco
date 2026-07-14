/**
 * deviceIntegrity.js — Device Topology Audit (Step 5)
 *
 * Detects multiple non-archived Device rows pointing at the same physical
 * device (same ipAddress:port). This is how attendance ends up duplicated
 * across deviceIds and how a single physical sensor silently masquerades as
 * "multiple devices" in the UI.
 *
 * auditDeviceTopology() is read-only: only logs warnings + emits a socket
 * event for the UI. Never deletes/merges Device rows automatically — that
 * requires an admin decision.
 *
 * reconcileCrossDeviceDuplicates() (Certification C1 fix) DOES write, but
 * only ever sets AttendanceLog.isDuplicate = true on redundant rows — it
 * never deletes/merges anything and never touches AttendanceDaily/Payroll.
 * attendanceEngine.processDate() already filters every log read on
 * `isDuplicate: false` (see attendanceEngine.js), so marking a row here is
 * the same "not counted" outcome the rest of the system already understands;
 * no attendance/payroll formula changes are required.
 */

const { getPrisma } = require('../utils/prisma');
const logger = require('../utils/logger');

const prisma = getPrisma();

// "ip:port" → non-archived Device rows sharing that physical endpoint.
// Shared by auditDeviceTopology() (reporting) and
// reconcileCrossDeviceDuplicates() (remediation) so both always agree on
// which device rows are considered duplicates of each other.
async function getDuplicateDeviceGroups() {
  const devices = await prisma.device.findMany({
    where: { isArchived: false },
    select: { id: true, name: true, ipAddress: true, port: true, enabled: true, autoSync: true },
  });

  const groups = new Map(); // "ip:port" → device[]
  for (const d of devices) {
    const key = `${d.ipAddress}:${d.port}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }

  return [...groups.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([endpoint, rows]) => ({ endpoint, devices: rows }));
}

async function auditDeviceTopology(io) {
  const duplicateGroups = await getDuplicateDeviceGroups();

  for (const { endpoint, devices: rows } of duplicateGroups) {
    const activeAutoSync = rows.filter((d) => d.enabled && d.autoSync);
    logger.warn(
      `[TOPOLOGY] duplicate device rows for ${endpoint}: ` +
      `ids=[${rows.map((d) => d.id).join(', ')}] names=[${rows.map((d) => `"${d.name}"`).join(', ')}] ` +
      `— same physical device ingested under ${rows.length} deviceId(s)` +
      (activeAutoSync.length > 1
        ? ` — ${activeAutoSync.length} of them have autoSync ENABLED, causing duplicate ingestion`
        : '')
    );

    if (activeAutoSync.length > 1) {
      logger.warn(
        `[TOPOLOGY] BLOCK RECOMMENDED: disable autoSync on all but one of ` +
        `[${activeAutoSync.map((d) => d.id).join(', ')}] for ${endpoint} to stop duplicate attendance ingestion`
      );
    }
  }

  if (duplicateGroups.length && io) {
    io.emit('device:topology-warning', {
      duplicates: duplicateGroups.map((g) => ({
        endpoint: g.endpoint,
        devices: g.devices.map((d) => ({ id: d.id, name: d.name, enabled: d.enabled, autoSync: d.autoSync })),
      })),
    });
  }

  return { duplicates: duplicateGroups };
}

/**
 * reconcileCrossDeviceDuplicates() — Certification finding C1 fix.
 *
 * For every group of non-archived Device rows sharing one physical
 * ip:port endpoint, find AttendanceLog rows that represent the SAME
 * physical punch (same employeeId + zkUserId + timestamp) but were stored
 * under more than one deviceId in that group — this is only possible
 * because the uniqueness constraint is (deviceId, zkUserId, timestamp),
 * so one physical event polled via two duplicate device rows inserts two
 * distinct rows today.
 *
 * For each such collision, the earliest-inserted row (lowest id) is kept
 * as canonical (isDuplicate stays false); every other row in that
 * collision is marked isDuplicate = true. It is never deleted, so the
 * ingestion history remains fully auditable.
 *
 * This does not recompute AttendanceDaily/Payroll itself — those are only
 * ever recomputed by the existing rebuild/recalc code paths, all of which
 * already read AttendanceLog with `isDuplicate: false`. Marking a
 * historical duplicate here means the NEXT rebuild/recalc for that
 * employee/date will exclude it; already-computed AttendanceDaily rows are
 * left untouched until that happens (same "no silent recompute" contract
 * every other write path in this codebase already follows).
 */
async function reconcileCrossDeviceDuplicates(io) {
  const duplicateGroups = await getDuplicateDeviceGroups();
  if (!duplicateGroups.length) return { markedCount: 0, collisions: 0 };

  let markedCount = 0;
  let collisions = 0;

  for (const { endpoint, devices: rows } of duplicateGroups) {
    const deviceIds = rows.map((d) => d.id);

    const logs = await prisma.attendanceLog.findMany({
      where: {
        deviceId: { in: deviceIds },
        isDuplicate: false,
        employeeId: { not: null },
      },
      select: { id: true, employeeId: true, zkUserId: true, timestamp: true, deviceId: true },
      orderBy: { id: 'asc' },
    });

    const byKey = new Map(); // "employeeId|zkUserId|timestampISO" → log rows (across deviceIds in this group)
    for (const l of logs) {
      const key = `${l.employeeId}|${l.zkUserId}|${l.timestamp.toISOString()}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(l);
    }

    const idsToMark = [];
    for (const [, rowsForKey] of byKey) {
      if (rowsForKey.length <= 1) continue;
      // rowsForKey is already ascending by id (source `logs` was ordered by id).
      // Keep the first (earliest-inserted) row canonical; mark the rest.
      collisions++;
      for (const l of rowsForKey.slice(1)) idsToMark.push(l.id);
    }

    if (idsToMark.length) {
      await prisma.attendanceLog.updateMany({
        where: { id: { in: idsToMark } },
        data: { isDuplicate: true },
      });
      markedCount += idsToMark.length;
      logger.warn(
        `[TOPOLOGY-DEDUP] endpoint=${endpoint} marked ${idsToMark.length} AttendanceLog row(s) as isDuplicate ` +
        `(cross-device re-ingestion of the same physical punch across deviceIds=[${deviceIds.join(', ')}])`
      );
    }
  }

  if (markedCount && io) {
    io.emit('device:topology-dedup', { markedCount, collisions });
  }

  return { markedCount, collisions };
}

module.exports = { auditDeviceTopology, reconcileCrossDeviceDuplicates };
