/**
 * deviceAudit.js — structured, persistent audit trail for fingerprint devices.
 *
 * Distinct from the winston logger (technical/debug text): every call here
 * writes one queryable row to `device_audit_logs`, which has no foreign key to
 * `devices` so the history survives device deletion. Device identity
 * (name/ip/port) is copied into the row at the time of the event.
 *
 * recordDeviceAudit() NEVER throws and never rejects — an audit failure is
 * logged and swallowed so it can't break (or mask the real error of) the
 * device operation being audited.
 */
const { getPrisma } = require('./prisma');
const logger = require('./logger');

const prisma = getPrisma();

const ACTION = {
  DEVICE_CREATED: 'DEVICE_CREATED',
  DEVICE_UPDATED: 'DEVICE_UPDATED',
  DEVICE_DELETED: 'DEVICE_DELETED',
  DEVICE_CONNECT_STARTED: 'DEVICE_CONNECT_STARTED',
  DEVICE_CONNECT_SUCCEEDED: 'DEVICE_CONNECT_SUCCEEDED',
  DEVICE_CONNECT_FAILED: 'DEVICE_CONNECT_FAILED',
  SYNC_STARTED: 'SYNC_STARTED',
  SYNC_COMPLETED: 'SYNC_COMPLETED',
  SYNC_FAILED: 'SYNC_FAILED',
  SYNC_BLOCKED: 'SYNC_BLOCKED',
  DEVICE_USER_DELETED: 'DEVICE_USER_DELETED',
  REALTIME_LISTENER_RESTARTED: 'REALTIME_LISTENER_RESTARTED',
};
const RESULT = { SUCCESS: 'SUCCESS', FAILED: 'FAILED', BLOCKED: 'BLOCKED', PARTIAL: 'PARTIAL' };

// Only these device fields ever enter before/after — an allowlist, so a
// credential column added to Device later can't leak into the audit trail.
const DEVICE_AUDIT_FIELDS = ['name', 'ipAddress', 'port', 'branchId', 'deviceNumber', 'syncInterval', 'autoSync', 'enabled', 'isArchived'];
function pickDeviceFields(device) {
  if (!device) return null;
  const out = {};
  for (const k of DEVICE_AUDIT_FIELDS) if (device[k] !== undefined) out[k] = device[k];
  return out;
}

// Defence in depth for free-form metadata: drop anything credential-shaped.
const SENSITIVE_KEY = /pass(word)?|pwd|token|secret|credential|authorization|api[-_]?key/i;
function sanitize(value, depth = 0) {
  if (value == null || depth > 4) return value ?? null;
  if (Array.isArray(value)) return value.slice(0, 50).map(v => sanitize(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(k)) continue;
      out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.length > 500 ? value.slice(0, 500) : value;
  return value;
}

/** Actor from an Express request: authenticated user if any, else local desktop. */
function actorFromReq(req) {
  const u = req && req.user;
  if (u && u.id != null) {
    return { actorType: 'user', actorId: u.id, actorName: u.name || u.username || null, actorRole: u.role || null };
  }
  return { actorType: 'local', actorId: null, actorName: null, actorRole: null };
}
const SYSTEM_ACTOR = { actorType: 'system', actorId: null, actorName: 'scheduler', actorRole: null };

async function recordDeviceAudit({
  action, result, actor = null, device = null, deviceRef = null,
  before = null, after = null, metadata = null, errorCode = null, errorMessage = null,
}) {
  try {
    const d = device || deviceRef || {};
    const a = actor || SYSTEM_ACTOR;
    await prisma.deviceAuditLog.create({
      data: {
        actorType: a.actorType || 'system',
        actorId: a.actorId ?? null,
        actorName: a.actorName ?? null,
        actorRole: a.actorRole ?? null,
        action,
        result,
        deviceId: d.id ?? null,
        deviceName: d.name ?? null,
        deviceIp: d.ipAddress ?? d.deviceIp ?? null,
        devicePort: d.port ?? d.devicePort ?? null,
        errorCode,
        errorMessage: errorMessage != null ? String(errorMessage).slice(0, 2000) : null,
        before: before ? sanitize(before) : undefined,
        after: after ? sanitize(after) : undefined,
        metadata: metadata ? sanitize(metadata) : undefined,
      },
    });
  } catch (err) {
    logger.warn(`[DEVICE-AUDIT] failed to record ${action}/${result}: ${err.message}`);
  }
}

// ─── Retention ───────────────────────────────────────────────────────────────
// device_audit_logs is append-only; a device that stays offline writes ~2 rows
// per scheduler attempt (CONNECT_FAILED + SYNC_FAILED), i.e. tens of thousands a
// year per device. Policy:
//   - ROUTINE operational rows (sync/connect lifecycle, listener restarts) are
//     pruned once older than the retention window (default 90 days, never less
//     than 30, 0 disables pruning entirely);
//   - ADMINISTRATIVE rows (device created/updated/deleted, device user deleted)
//     are never pruned — low volume, and they are the history that matters;
//   - any action not listed here is never pruned (allow-list, so a future audit
//     action is safe by default).
// Each run is bounded (batchSize × maxBatches rows) and yields between batches.
const ROUTINE_ACTIONS = [
  ACTION.SYNC_STARTED, ACTION.SYNC_COMPLETED, ACTION.SYNC_FAILED, ACTION.SYNC_BLOCKED,
  ACTION.DEVICE_CONNECT_STARTED, ACTION.DEVICE_CONNECT_SUCCEEDED, ACTION.DEVICE_CONNECT_FAILED,
  ACTION.REALTIME_LISTENER_RESTARTED,
];
const MIN_RETENTION_DAYS = 30;
const DEFAULT_RETENTION_DAYS = 90;

function retentionDays() {
  const raw = process.env.DEVICE_AUDIT_RETENTION_DAYS;
  const n = raw === undefined || raw === '' ? DEFAULT_RETENTION_DAYS : Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RETENTION_DAYS;
  return n === 0 ? 0 : Math.max(n, MIN_RETENTION_DAYS);
}

/**
 * Delete routine audit rows older than the retention window, in bounded batches.
 * Never throws. Returns { deleted, cutoff, disabled? }.
 */
async function pruneDeviceAuditLogs({ days = retentionDays(), batchSize = 500, maxBatches = 20, now = Date.now() } = {}) {
  if (!days) return { deleted: 0, disabled: true };
  const cutoff = new Date(now - Math.max(days, MIN_RETENTION_DAYS) * 24 * 60 * 60 * 1000);
  let deleted = 0;
  try {
    for (let i = 0; i < maxBatches; i++) {
      const ids = await prisma.deviceAuditLog.findMany({
        where: { action: { in: ROUTINE_ACTIONS }, createdAt: { lt: cutoff } },
        select: { id: true }, orderBy: { id: 'asc' }, take: batchSize,
      });
      if (!ids.length) break;
      const r = await prisma.deviceAuditLog.deleteMany({ where: { id: { in: ids.map((x) => x.id) } } });
      deleted += r.count;
      if (ids.length < batchSize) break;
      await new Promise((resolve) => setImmediate(resolve));   // let other work run between batches
    }
    if (deleted) logger.info(`[DEVICE-AUDIT] retention: pruned ${deleted} routine row(s) older than ${cutoff.toISOString()}`);
  } catch (err) {
    logger.warn(`[DEVICE-AUDIT] retention pass failed: ${err.message}`);
  }
  return { deleted, cutoff };
}

module.exports = { recordDeviceAudit, actorFromReq, pickDeviceFields, pruneDeviceAuditLogs, ROUTINE_ACTIONS, ACTION, RESULT, SYSTEM_ACTOR };
