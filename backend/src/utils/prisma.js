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

async function checkDbConnection() {
  try {
    const p = getPrisma();
    await p.$queryRaw`SELECT 1`;
    return true;
  } catch (err) {
    logger.warn(`DB not available: ${err.message}`);
    return false;
  }
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

module.exports = { getPrisma, checkDbConnection, disconnectPrisma };
