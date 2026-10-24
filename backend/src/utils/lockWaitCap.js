/**
 * lockWaitCap.js — H3: keep a MySQL lock wait SHORTER than Prisma's interactive-transaction timeout.
 *
 * The problem (reproduced on scratch MySQL with plain Prisma 5.22): when a statement inside `prisma.$transaction(cb, { timeout })` blocks on a
 * row lock held by someone else for LONGER than `timeout`, Prisma does not cancel the blocked statement. The transaction is reported as
 * expired only when MySQL finally answers (innodb_lock_wait_timeout, 50 s by default), and the pooled connection is left in a bad state: the
 * next query that lands on it fails with "Server has closed the connection". With the lock wait capped BELOW the transaction timeout, MySQL
 * itself ends the wait with error 1205 while the transaction is still open and healthy, Prisma rolls it back normally, and the connection is
 * reused without incident (verified: 0 follow-up failures, vs. 1 per poisoned connection before).
 *
 * lockCappedTransaction(prisma, cb, options) is a drop-in for `prisma.$transaction(cb, options)` (interactive form):
 *   1. reads the server's GLOBAL innodb_lock_wait_timeout (what every pooled connection starts with; nothing in this application sets a
 *      session value otherwise) and, ONLY if it is longer than the cap, lowers the session value for THIS transaction
 *      (cap = 60 % of the transaction timeout, at least 1 s; the Prisma default timeout is 5 s → 3 s);
 *   2. runs the callback;
 *   3. in a `finally` — success, rollback-causing error, or lock-wait error alike — restores the global value while the transaction
 *      (and therefore the connection) is still ours. Restoring the GLOBAL value (not "whatever it was") also heals a connection that an
 *      earlier transaction left capped (see the known limit below) the next time that connection runs a capped transaction;
 *   4. turns a lock-wait failure into LockWaitTimeoutError (HTTP 409, code LOCK_WAIT_TIMEOUT, safe Arabic message) — nothing was written.
 * If the settings cannot be read (or the server value is already at/below the cap) nothing is lowered and the call behaves exactly like
 * prisma.$transaction.
 *
 * Known limit: if Prisma itself expires the transaction for a reason other than a lock wait (the callback is merely slow), the `finally`
 * can no longer reach the connection and the capped value stays on that pooled connection until its next capped transaction restores it (it
 * can only make LATER lock waits on that connection shorter — never longer, never a wrong result). That situation is detected (Prisma code P2028,
 * meta.error "…on an expired transaction") and logged as a warning with the caller site; the warning only makes the risk observable, it restores nothing.
 * Only transactions that take row locks other writers can hold (payroll rows, attendance rows) use this helper. No schema, API-shape or business
 * rule is touched.
 */
const logger = require('./logger');

const PRISMA_DEFAULT_TX_TIMEOUT_MS = 5000;

class LockWaitTimeoutError extends Error {
  constructor() {
    super('السجل مشغول بعملية أخرى حالياً — لم يُحفظ أي تغيير. أعد المحاولة بعد لحظات.');
    this.name = 'LockWaitTimeoutError';
    this.statusCode = 409;
    this.code = 'LOCK_WAIT_TIMEOUT';
  }
}

/** MySQL error 1205 as it reaches us through Prisma (raw query error text, or the engine's meta code). */
function isLockWaitError(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  if (/Lock wait timeout exceeded/i.test(msg)) return true;
  if (/`1205`/.test(msg)) return true;
  return String(err.meta && err.meta.code) === '1205';
}

/** Seconds the lock wait may last: well inside the transaction timeout, never below 1 s. */
function lockWaitCapSeconds(txTimeoutMs) {
  return Math.max(1, Math.floor((txTimeoutMs * 0.6) / 1000));
}

/**
 * Prisma 5.22 reports an interactive transaction that outlived its `timeout` as PrismaClientKnownRequestError code P2028 whose structured
 * `meta.error` reads "Transaction already closed: A query|commit cannot be executed on an expired transaction. …" (verified on scratch MySQL).
 * The other P2028 variants differ in `meta.error` and are NOT expiry: "Unable to start a transaction in the given time." (maxWait — the
 * callback never ran, nothing was capped) and "… cannot be executed on a committed|rolled back transaction". Both fields must match.
 */
function isTransactionExpiredError(err) {
  return !!err && err.code === 'P2028' && typeof (err.meta && err.meta.error) === 'string' && /\bon an expired transaction\b/.test(err.meta.error);
}

/** "routes/payroll.js:324" — the code location that called lockCappedTransaction (first frame of the stack captured at entry), reduced to the last two
 *  path segments and the line. No user directory, no data. */
function callerSite(stack) {
  const frame = String(stack || '').split('\n')[1];
  if (!frame) return 'unknown';
  const m = /([^()]+?):(\d+):\d+\)?\s*$/.exec(frame.trim().replace(/^at\s+(?:async\s+)?/, ''));
  return m ? `${m[1].replace(/\\/g, '/').split('/').slice(-2).join('/')}:${m[2]}` : 'unknown';
}

async function lockCappedTransaction(prisma, callback, options = {}) {
  const timeoutMs = Number.isFinite(options.timeout) ? options.timeout : PRISMA_DEFAULT_TX_TIMEOUT_MS;
  const cap = lockWaitCapSeconds(timeoutMs);
  const entry = {}; Error.captureStackTrace(entry, lockCappedTransaction);   // formatted only if the expiry warning below is ever needed
  const startedAt = Date.now();
  try {
    return await prisma.$transaction(async (tx) => {
      let restoreTo = null;
      try {
        const rows = await tx.$queryRaw`SELECT @@session.innodb_lock_wait_timeout AS s, @@global.innodb_lock_wait_timeout AS g`;
        const session = Number(rows && rows[0] && rows[0].s);
        const server = Number(rows && rows[0] && rows[0].g);
        if (Number.isFinite(session) && Number.isFinite(server)) {
          if (server > cap) {
            await tx.$executeRawUnsafe(`SET SESSION innodb_lock_wait_timeout = ${cap}`);   // cap is an integer computed above, never request data
            restoreTo = server;
          } else if (session !== server) {
            restoreTo = server;   // heal-only: the server value is already short enough, but this connection was left with another value
          }
        }
      } catch (err) {
        // Could not read/lower the setting: run exactly as before (uncapped). The transaction itself is unaffected.
        logger.warn(`[LOCK-CAP] not applied: ${err.message}`);
        restoreTo = null;
      }
      try {
        return await callback(tx);
      } finally {
        if (restoreTo !== null) {
          try { await tx.$executeRawUnsafe(`SET SESSION innodb_lock_wait_timeout = ${restoreTo}`); }
          catch (err) {
            if (isTransactionExpiredError(err)) {
              // Observability only — nothing is restored here. Prisma expired the transaction (the callback was slow), so this pooled
              // connection may keep the capped value until a later capped transaction on it restores the server value.
              logger.warn(`[LOCK-CAP] transaction expired before innodb_lock_wait_timeout could be restored: this pooled connection may keep the capped value `
                + `(${cap}s instead of ${restoreTo}s) until its next capped transaction (caller=${callerSite(entry.stack)}, tx timeout ${timeoutMs}ms, elapsed ${Date.now() - startedAt}ms)`);
            } else {
              logger.warn(`[LOCK-CAP] could not restore innodb_lock_wait_timeout=${restoreTo}: ${String(err.message).split('\n').filter(Boolean).slice(-1)[0]}`);
            }
          }
        }
      }
    }, options);
  } catch (err) {
    if (isLockWaitError(err)) {
      logger.warn(`[LOCK-WAIT] transaction ended by a lock wait (capped at ${cap}s, tx timeout ${timeoutMs}ms): ${String(err.message).split('\n').filter(Boolean).slice(-1)[0]}`);
      throw new LockWaitTimeoutError();
    }
    throw err;
  }
}

module.exports = { lockCappedTransaction, LockWaitTimeoutError, isLockWaitError, isTransactionExpiredError, lockWaitCapSeconds };
