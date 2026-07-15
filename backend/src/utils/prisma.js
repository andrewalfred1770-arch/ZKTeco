/**
 * prisma.js — THE single shared PrismaClient for the whole backend.
 *
 * Every route/service/engine must obtain its client via getPrisma().
 * Creating additional PrismaClient instances fragments the MySQL connection
 * pool (28 separate pools at one point) and exhausts max_connections over
 * long uptimes — never call `new PrismaClient()` outside this file.
 */
const { PrismaClient } = require('@prisma/client');
const logger = require('./logger');

let _prisma = null;
let _lastDbErrorReason = null;

function getPrisma() {
  if (!_prisma) {
    _prisma = new PrismaClient({
      log: [{ emit: 'event', level: 'error' }],
      errorFormat: 'minimal',
    });

    _prisma.$on('error', (e) => {
      logger.error(`Prisma error: ${e.message}`);
    });
  }
  return _prisma;
}

// Classifies a connection failure into a fixed, safe category — never the
// raw error text (which can vary by Prisma version) and never the
// connection string/credentials. Lets /api/health surface WHY the DB is
// unreachable (auth vs. unreachable vs. missing DB) without exposing
// anything sensitive, so this is diagnosable from the API response alone
// instead of requiring log-file access.
function classifyDbError(err) {
  const msg = String(err?.message || '');
  if (/Authentication failed/i.test(msg)) return 'auth-failed';
  if (/Can't reach database server|ECONNREFUSED/i.test(msg)) return 'unreachable';
  if (/Unknown database|does not exist on the database server/i.test(msg)) return 'database-missing';
  return 'unknown';
}

async function checkDbConnection() {
  try {
    const p = getPrisma();
    await p.$queryRaw`SELECT 1`;
    _lastDbErrorReason = null;
    return true;
  } catch (err) {
    logger.warn(`DB not available: ${err.message}`);
    _lastDbErrorReason = classifyDbError(err);
    return false;
  }
}

/** Safe-to-expose reason for the most recent checkDbConnection() failure. */
function getLastDbErrorReason() {
  return _lastDbErrorReason;
}

/** Graceful-shutdown hook — flushes and closes the single pool. */
async function disconnectPrisma() {
  if (!_prisma) return;
  try {
    await _prisma.$disconnect();
    logger.info('[SHUTDOWN] Prisma pool disconnected');
  } catch (err) {
    logger.warn(`[SHUTDOWN] Prisma disconnect failed: ${err.message}`);
  } finally {
    _prisma = null;
  }
}

module.exports = { getPrisma, checkDbConnection, disconnectPrisma, getLastDbErrorReason, classifyDbError };
