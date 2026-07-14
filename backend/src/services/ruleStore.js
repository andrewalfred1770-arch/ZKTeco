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
let conditionCache = null;
let conditionCachedAt = 0;

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

/** Active condition-type rules ({ key, value, conditionJson }) — feeds the generic condition evaluator. */
async function getConditionRules() {
  if (conditionCache && Date.now() - conditionCachedAt < TTL_MS) return conditionCache;
  const rows = await prisma.rule.findMany({
    where: { isActive: true, type: 'condition' },
    orderBy: { priority: 'desc' },
  });
  conditionCache = rows.map(r => ({ key: r.key, value: r.value, conditionJson: r.conditionJson }));
  conditionCachedAt = Date.now();
  return conditionCache;
}

function invalidate() {
  cache = null;
  cachedAt = 0;
  conditionCache = null;
  conditionCachedAt = 0;
}

module.exports = { getRuleMap, getRuleValue, getConditionRules, invalidate };
