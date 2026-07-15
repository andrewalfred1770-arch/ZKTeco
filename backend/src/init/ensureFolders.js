/**
 * ensureFolders.js — creates the runtime folders a fresh install needs
 * (EP-007 Task 7). Purely synchronous, safe to call on every startup —
 * fs.mkdirSync(..., {recursive:true}) is already a no-op when the
 * directory exists, so this is idempotent by construction.
 */
const fs = require('fs');
const path = require('path');
const { getConfigDir } = require('../utils/configDir');

const REQUIRED_FOLDERS = ['uploads', 'logs', 'backups', 'exports', 'temp'];

function ensureFolders() {
  const created = [];
  const root = getConfigDir();
  for (const name of REQUIRED_FOLDERS) {
    const dir = path.join(root, name);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      created.push(name);
    }
  }
  return created;
}

module.exports = { ensureFolders, REQUIRED_FOLDERS };
