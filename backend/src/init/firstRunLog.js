/**
 * firstRunLog.js — append-only initialization log (EP-007 Task 8).
 *
 * SECURITY: never pass a secret (JWT_SECRET, DATABASE_URL with credentials,
 * raw error stacks) into logInit() — only short, human-readable status
 * lines. Callers are responsible for keeping messages secret-free; this
 * module does not attempt to redact, so it must never receive one.
 */
const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.join(__dirname, '..', '..');
const LOG_DIR = path.join(BACKEND_ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'first-run.log');

function timestamp() {
  return new Date().toISOString();
}

/** Appends one status line to logs/first-run.log. Never throws. */
function logInit(message) {
  const line = `[${timestamp()}] ${message}`;
  console.log(`[Init] ${message}`);
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {
    // Logging must never be able to crash startup.
  }
}

module.exports = { logInit, LOG_FILE };
