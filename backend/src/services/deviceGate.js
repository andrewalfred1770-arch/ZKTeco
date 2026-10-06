/**
 * deviceGate.js — the ONE per-device concurrency gate for every ZKTeco
 * connection path.
 *
 * A ZKTeco device serves a single TCP session. Four things used to open one
 * independently: the sync engine (pullLogs), device operations (users /
 * delete user / ping / test-connection) and the persistent realtime listener.
 * Only pullLogs had a lock (a private map in zktecoService), so the others
 * could — and did — open a second session while it ran.
 *
 * The gate has two states per device:
 *
 *   EXCLUSIVE  held by exactly one short-lived device operation (sync, users,
 *              delete, ping, test). Claimed SYNCHRONOUSLY (no await between the
 *              check and the claim, so two triggers can never both win) and
 *              released through an ownership-checked lease, so a stale or
 *              duplicate release can never free someone else's claim.
 *
 *   REALTIME   a realtime-listener connection ATTEMPT is in flight (the window
 *              between "start connecting" and "session established"). Only one
 *              attempt per device, and none may start while EXCLUSIVE is held.
 *
 * An exclusive claim does not wait for the realtime side: it ABANDONS any
 * in-flight attempt (the listener closes that socket and the attempt tears
 * itself down when it next resumes), and drops an established listener
 * session through the existing pause/resume protocol. Nothing in here waits
 * on a timer, so there is no delay to tune and nothing that can hang a lease.
 *
 * Process-local and in-memory by design (one backend process owns the device
 * connections; a second process is excluded by SKIP_SCHEDULER, see index.js).
 */
const gates = new Map();   // String(deviceId) -> { holder, attempt }
let ownerSeq = 0;

function entry(deviceId, create) {
  const key = String(deviceId);
  let g = gates.get(key);
  if (!g && create) { g = { holder: null, attempt: null }; gates.set(key, g); }
  return g || null;
}

function prune(deviceId) {
  const key = String(deviceId);
  const g = gates.get(key);
  if (g && !g.holder && !g.attempt) gates.delete(key);
}

/**
 * Claim exclusive use of the device. Synchronous. Returns a lease
 * `{ owner, label, release() }`, or null if the device is already claimed.
 * `release()` returns true only the first time, and only if this lease still
 * owns the claim.
 */
function tryAcquireExclusive(deviceId, label) {
  const g = entry(deviceId, true);
  if (g.holder) { prune(deviceId); return null; }
  const owner = ++ownerSeq;
  g.holder = { owner, label, startedAt: Date.now() };
  return {
    owner,
    label,
    release() {
      const cur = entry(deviceId, false);
      if (!cur || !cur.holder || cur.holder.owner !== owner) return false;
      cur.holder = null;
      prune(deviceId);
      return true;
    },
  };
}

/** `{ owner, label, startedAt }` of the current exclusive holder, or null. */
function heldBy(deviceId) {
  const g = entry(deviceId, false);
  return g && g.holder ? { ...g.holder } : null;
}

const isExclusiveHeld = (deviceId) => heldBy(deviceId) !== null;

/**
 * Register a realtime connection attempt. Returns an attempt token
 * `{ done() }`, or null when the attempt must not start (an exclusive
 * operation holds the device, or another attempt is already in flight).
 * `done()` is idempotent and a no-op if the attempt was abandoned meanwhile.
 */
function beginRealtimeConnect(deviceId) {
  const g = entry(deviceId, true);
  if (g.holder || g.attempt) { prune(deviceId); return null; }
  const token = {
    done() {
      const cur = entry(deviceId, false);
      if (cur && cur.attempt === token) { cur.attempt = null; prune(deviceId); }
    },
  };
  g.attempt = token;
  return token;
}

/** Drop the in-flight realtime attempt's claim (its socket is closed by the caller). */
function abandonRealtimeConnect(deviceId) {
  const g = entry(deviceId, false);
  if (g && g.attempt) { g.attempt = null; prune(deviceId); }
}

const isRealtimeConnecting = (deviceId) => !!(entry(deviceId, false)?.attempt);

module.exports = {
  tryAcquireExclusive, heldBy, isExclusiveHeld,
  beginRealtimeConnect, abandonRealtimeConnect, isRealtimeConnecting,
};
