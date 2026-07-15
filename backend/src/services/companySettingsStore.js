/**
 * companySettingsStore.js — resolver for the runtime-editable "بيانات الشركة"
 * branding store. Mirrors `ruleStore.js`: an in-memory `{ key: value }` cache
 * that the settings routes invalidate after every write so edits propagate
 * immediately to every API consumer.
 *
 * It also persists a small JSON snapshot to `uploads/company/cache.json` on
 * every change — the Electron splash screen reads this file synchronously at
 * process start (before the backend is reachable) so it can show the live
 * company name/logo without waiting on a health-check round trip.
 */
const fs   = require('fs');
const path = require('path');
const { getPrisma } = require('../utils/prisma');
const { getConfigDir } = require('../utils/configDir');
const prisma = getPrisma();

// EP-010: persists under the persistent config dir so uploaded branding
// assets survive a Portable re-extraction — falls back to the pre-EP-010
// backend-relative path when CONFIG_DIR isn't set (Server Mode/dev).
const UPLOAD_DIR = path.join(getConfigDir(), 'uploads', 'company');
const CACHE_FILE = path.join(UPLOAD_DIR, 'cache.json');

const TTL_MS = 60 * 1000;
let cache = null;
let cachedAt = 0;

async function getSettingsMap() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  const rows = await prisma.companySetting.findMany();
  const map = {};
  for (const r of rows) map[r.key] = r.value ?? '';
  cache = map;
  cachedAt = Date.now();
  return map;
}

function invalidate() {
  cache = null;
  cachedAt = 0;
}

/** Writes `{ key: value }` to uploads/company/cache.json (best-effort, never throws). */
function writeSnapshot(map) {
  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(map, null, 2), 'utf8');
  } catch { /* non-fatal — splash falls back to defaults */ }
}

/** Call after any write: refreshes the cache and the on-disk snapshot together. */
async function refreshSnapshot() {
  invalidate();
  const map = await getSettingsMap();
  writeSnapshot(map);
  return map;
}

module.exports = { getSettingsMap, invalidate, refreshSnapshot, UPLOAD_DIR, CACHE_FILE };
