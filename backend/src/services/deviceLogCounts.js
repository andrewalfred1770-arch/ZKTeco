/**
 * deviceLogCounts.js — per-device raw log counts for GET /api/devices.
 *
 * The device list reports `rawLogCount` = the number of attendance_logs rows per
 * device. It was computed with a `groupBy` over the WHOLE attendance_logs table on
 * every request (the Devices page re-fetches on every device/sync event), which
 * grows linearly with the table: ~20 ms at 63k rows, > 1 s at a few million.
 *
 * The counts are now computed once and kept exact incrementally:
 *   - the only code paths that add rows tell us how many (adjust(): the sync's
 *     createMany count, each inserted realtime punch);
 *   - the only path that removes rows (data cleanup) calls invalidate();
 *   - an invalidated/expired cache is rebuilt by ONE groupBy, shared by every
 *     concurrent caller (single-flight);
 *   - a TTL re-derives the figures from the table now and then, so a writer this
 *     process does not know about (another backend instance on the same DB, a
 *     manual SQL change) can never leave the number wrong for long.
 * A rebuild that overlaps an adjust()/invalidate() is returned to its caller but
 * not cached (epoch check), so a stale snapshot can never replace a fresher one.
 * Values and response shape are exactly what the groupBy produced.
 */
const { getPrisma } = require('../utils/prisma');

const prisma = getPrisma();
const TTL_MS = 60 * 1000;

let cache = null;      // { map: Map<deviceId, number>, at: ms }
let inflight = null;   // Promise<Map> of the rebuild in progress
let epoch = 0;         // bumped by every adjust()/invalidate()

async function load() {
  const startEpoch = epoch;
  const rows = await prisma.attendanceLog.groupBy({ by: ['deviceId'], _count: { id: true } });
  const map = new Map(rows.map((r) => [r.deviceId, r._count.id]));
  if (epoch === startEpoch) cache = { map, at: Date.now() };
  return map;
}

/** Map<deviceId, rawLogCount>. */
async function getCounts() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.map;
  if (!inflight) inflight = load().finally(() => { inflight = null; });
  return inflight;
}

/** Rows were added (delta > 0) or removed (delta < 0) for one device. */
function adjust(deviceId, delta) {
  epoch++;
  if (!cache || !delta) return;
  cache.map.set(deviceId, Math.max(0, (cache.map.get(deviceId) || 0) + delta));
}

/** Rows changed in a way the caller cannot count (e.g. date-range cleanup). */
function invalidate() {
  epoch++;
  cache = null;
}

module.exports = { getCounts, adjust, invalidate };
