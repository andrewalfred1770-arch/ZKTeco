/**
 * socketSessionGuard.js — periodic revalidation of CONNECTED Socket.IO sessions.
 *
 * The handshake (middleware/auth.js authenticateSocket) only vets a user when the socket connects. A socket then stays up for
 * as long as the TCP connection lives, so a user who is deactivated, deleted or re-roled afterwards would keep receiving live
 * data (punches, employee names, sync events). This guard closes that gap.
 *
 * TWO KINDS OF OUTCOME ARE DELIBERATELY KEPT APART
 *  - CONFIRMED INVALID: the lookup SUCCEEDED and says the account is missing, inactive, role-less, or its database role differs
 *    from the role the socket was admitted with. The socket is disconnected IMMEDIATELY (on the tick that sees it, or at once
 *    through dropUser() when an HTTP request has just proven the same thing — see middleware/auth.js onAccountRejected).
 *  - TEMPORARY INFRASTRUCTURE FAILURE: the lookup itself FAILED (database unreachable, timeout, ...). That says nothing about the
 *    users, so nobody is disconnected for it. The guard enters DEGRADED mode: sessions are kept, new handshakes are still refused
 *    (they cannot be verified — fail closed for NEW sessions), the tick keeps retrying every interval, and the first successful
 *    lookup ends degraded mode and applies any pending confirmed-invalid findings. Degraded mode is BOUNDED: if the failures
 *    last `maxDegradedMs` without a single success (default 10 minutes) the guard FAILS CLOSED — it can no longer vouch for any
 *    session, so every authenticated socket is disconnected. Clients reconnect on their own with exponential backoff (see
 *    frontend/src/lib/socket.js), are refused while the outage lasts, and are admitted again as soon as the database answers.
 *
 * EXACT TIMELINE OF A DATABASE OUTAGE (default 30 s tick, 10 min bound; reviewed and kept — see "WHY 10 MINUTES")
 *    t = 0        first tick whose lookup fails: DEGRADED. Nobody is disconnected. HTTP already fails closed for everyone (the same
 *                 outage makes every authenticate() lookup fail with an error response), so no data is served meanwhile.
 *    t < 600 s    every tick retries. Sessions stay up; new handshakes are refused (they cannot be verified).
 *    any success  recovered: counters reset, and the SAME tick applies any confirmed-invalid finding (inactive / missing / role changed).
 *    t = 600 s    (the 21st failing tick) still failing: FAIL CLOSED — every authenticated socket is disconnected ('revalidation-unavailable').
 *    after that   clients reconnect by themselves (backoff 1 s doubling to a 30 s cap applied AFTER the +20% jitter => never more than 30 s between attempts);
 *                 they are refused while the outage lasts and the first attempt after the database answers is admitted. Writes stay blocked
 *                 on the client for as long as the connection is down.
 *    CONFIRMED rejections never wait for any of this: an HTTP request that proves an account invalid calls dropUser() at once, and the
 *    next successful tick drops the rest.
 *
 * WHY 10 MINUTES (and not shorter): while the database is down the only thing a degraded session can still do is RECEIVE broadcast events
 * (HTTP is already refused). The sole window a shorter bound would close is "an account was deactivated in the <=30 s before the outage
 * and has not been seen by a tick yet" — a narrow race, and the events involved are the same ones every other logged-in user receives. The
 * price of a shorter bound is certain: every ordinary database restart longer than the bound (MySQL service restart, backup, disk hiccup)
 * would disconnect every user and make each of them reconnect through the refusal/backoff loop. The tests (reliability_pass_test.js) pin
 * both sides of this trade-off; the bound is kept at 10 minutes and remains a constructor option (maxDegradedMs).
 *
 * DESIGN
 *  - ONE shared interval timer for the whole server (never one per socket): nothing to leak, nothing to clean up per
 *    disconnect. The timer is unref()'d so it can never keep the process alive; start() is idempotent; stop() is called
 *    from the graceful shutdown in index.js.
 *  - Every tick makes ONE batched lookup of the distinct user ids that currently have a socket (users.id IN (...)), selecting
 *    only { id, active, role }. Cost is one small primary-key query per interval, independent of the number of sockets.
 *  - A tick that is still running when the next one fires is skipped (no overlapping lookups, no pile-up on a slow database).
 *  - INTERVAL: 30 s by default => a deactivation takes effect within ~30 s at worst (immediately if the user makes any HTTP call).
 *  - Logging happens on TRANSITIONS only (entering degraded mode, failing closed, recovery) plus one line per confirmed drop, and
 *    contains only socket ids, user ids, reasons and a generic error code — never a token, a header or an error message
 *    (database errors can embed connection details).
 *  - Disabled (no timer, no queries) when authentication is disabled.
 *
 * LIMITATION (by design): Socket.IO events are broadcast to every connected socket regardless of role, so "authorization" for a
 * socket means "authenticated, active, and holding the account's current role". Role-based event filtering (rooms per role)
 * would be a broader change and is not part of this guard.
 */
const DEFAULT_INTERVAL_MS = 30 * 1000;
const DEFAULT_MAX_DEGRADED_MS = 10 * 60 * 1000;

function createSocketSessionGuard({
  io,
  loadUsers,
  intervalMs = DEFAULT_INTERVAL_MS,
  maxDegradedMs = DEFAULT_MAX_DEGRADED_MS,
  logger = require('../utils/logger'),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  now = Date.now,
  authEnabled,
} = {}) {
  const enabled = authEnabled === undefined ? require('../middleware/auth').AUTH_ENABLED : !!authEnabled;
  const load = loadUsers || (async (ids) => {
    const { getPrisma } = require('../utils/prisma');   // lazy: no database import unless the guard actually runs
    return getPrisma().user.findMany({ where: { id: { in: ids } }, select: { id: true, active: true, role: true } });
  });
  let timer = null;
  let running = false;
  let failures = 0;          // consecutive failed lookups
  let failingSince = null;   // timestamp of the first failure of the current streak, null when healthy
  let failClosed = false;    // true once the bounded degraded period has been exceeded

  const drop = (socket, reason) => {
    try {
      logger.info(`[SOCKET-REVALIDATE] disconnecting socket=${socket.id} user=${socket.user && socket.user.id !== undefined ? socket.user.id : 'none'} reason=${reason}`);
      socket.disconnect(true);
    } catch { /* already gone */ }
  };

  /** Disconnect every socket of one user NOW (an HTTP request has just confirmed the account is invalid). No database access. */
  function dropUser(userId, reason = 'account-invalid') {
    if (!enabled || !io || !io.sockets) return 0;
    let n = 0;
    for (const s of [...io.sockets.sockets.values()]) {
      if (s.user && s.user.id === userId) { drop(s, reason); n++; }
    }
    return n;
  }

  async function runOnce() {
    if (!enabled) return { skipped: 'disabled' };
    if (running) return { skipped: 'overlap' };
    running = true;
    try {
      const sockets = [...io.sockets.sockets.values()];
      // No sockets => nothing to vouch for (and, after a fail-closed drop, nothing left to drop): a clean slate for the streak
      // accounting. New handshakes are verified by their own lookup, so an outage still keeps new sessions out.
      if (!sockets.length) { failures = 0; failingSince = null; failClosed = false; return { checked: 0 }; }
      const ids = [...new Set(sockets.map((s) => s.user && s.user.id).filter(Number.isInteger))];
      let accounts = [];
      try {
        if (ids.length) accounts = await load(ids);
        if (failingSince !== null) {
          logger.warn(`[SOCKET-REVALIDATE] recovered: account lookups work again after ${failures} failed check(s)`);
        }
        failures = 0; failingSince = null; failClosed = false;
      } catch (err) {
        failures++;
        if (failingSince === null) {
          failingSince = now();
          logger.warn(`[SOCKET-REVALIDATE] account lookup failed (code=${(err && err.code) || 'error'}) — DEGRADED mode: existing sessions are kept, new connections are refused, retrying every interval (fail-closed after ${Math.round(maxDegradedMs / 1000)}s)`);
        }
        if (!failClosed && now() - failingSince >= maxDegradedMs) {
          failClosed = true;
          logger.warn(`[SOCKET-REVALIDATE] lookups have failed for ${Math.round((now() - failingSince) / 1000)}s — sessions can no longer be vouched for: failing closed, disconnecting all authenticated sockets`);
          for (const s of sockets) drop(s, 'revalidation-unavailable');
        }
        return { degraded: true, failures, failClosed };
      }
      const byId = new Map((accounts || []).map((a) => [a.id, a]));
      let dropped = 0;
      for (const s of sockets) {
        const u = s.user;
        if (!u || !Number.isInteger(u.id)) { drop(s, 'no-authenticated-user'); dropped++; continue; }
        const acc = byId.get(u.id);
        if (!acc || !acc.active) { drop(s, 'account-missing-or-inactive'); dropped++; continue; }
        if (!acc.role || acc.role !== u.role) { drop(s, 'role-changed'); dropped++; continue; }
      }
      return { checked: sockets.length, dropped };
    } catch (err) {
      logger.warn(`[SOCKET-REVALIDATE] tick error (code=${(err && err.code) || 'error'})`);
      return { failed: true };
    } finally {
      running = false;
    }
  }

  function start() {
    if (!enabled || timer) return;
    timer = setIntervalFn(() => { runOnce().catch(() => {}); }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  function stop() {
    if (timer) { clearIntervalFn(timer); timer = null; }
  }

  return {
    start, stop, runOnce, dropUser,
    isRunning: () => !!timer,
    status: () => ({ degraded: failingSince !== null, failures, failClosed, since: failingSince }),
  };
}

module.exports = { createSocketSessionGuard, DEFAULT_INTERVAL_MS, DEFAULT_MAX_DEGRADED_MS };
