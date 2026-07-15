/**
 * ruleStore.js — resolver for the Dynamic Rules Engine.
 *
 * Single source of truth that the attendance/payroll engines read rule values
 * from. Returns a `{ key: value }` map of ACTIVE rules (highest `priority` wins
 * on duplicate keys — keys are unique today, but priority is honoured for
 * future branch/role variants). Values are strings; callers coerce by type.
 *
 * Cached for 60s; `invalidate()` is called by the rules routes after any write
 * so edits take effect immediately.
 */
const { getPrisma } = require('../utils/prisma');
const prisma = getPrisma();

const TTL_MS = 60 * 1000;
let cache = null;
let cachedAt = 0;

async function getRuleMap() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  const rules = await prisma.rule.findMany({
    where: { isActive: true },
    orderBy: { priority: 'asc' }, // higher priority applied last → wins
  });
  const map = {};
  for (const r of rules) map[r.key] = r.value;
  cache = map;
  cachedAt = Date.now();
  return map;
}

/** Single value with fallback (string). */
async function getRuleValue(key, fallback = null) {
  const map = await getRuleMap();
  return map[key] !== undefined ? map[key] : fallback;
}

function invalidate() {
  cache = null;
  cachedAt = 0;
}

module.exports = { getRuleMap, getRuleValue, invalidate };
