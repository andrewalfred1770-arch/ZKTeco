/**
 * generateEnv.js — self-initializing backend/.env (EP-007 Tasks 1-3, 11, 12).
 *
 * Runs ONCE, synchronously, before dotenv.config() loads anything — if
 * backend/.env already exists this is a pure no-op (idempotent: never
 * overwrites an existing file, never regenerates JWT_SECRET, never touches
 * an install that's already configured).
 *
 * Mode detection: backend.js (Electron main process, unchanged) already sets
 * ELECTRON_APP=1 on the child it spawns in Local Mode. Its absence means this
 * is Server Mode (run directly via `node src/index.js`, e.g. a systemd/LAN
 * deployment) — in that case DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME
 * process env vars (set by whoever deploys the server) are honored if
 * present, falling back to the same localhost defaults otherwise.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const { logInit } = require('./firstRunLog');

const BACKEND_ROOT = path.join(__dirname, '..', '..');
const EXAMPLE_PATH = path.join(BACKEND_ROOT, '.env.example');

function buildDatabaseUrl() {
  const host     = process.env.DB_HOST     || 'localhost';
  const port     = process.env.DB_PORT     || '3306';
  const user     = process.env.DB_USER     || 'root';
  const password = process.env.DB_PASSWORD || '';
  const name     = process.env.DB_NAME     || 'zkteco_attendance';
  const auth = password ? `${user}:${password}` : user;
  return `mysql://${auth}@${host}:${port}/${name}`;
}

/**
 * Ensures backend/.env exists. `envPath` is the exact path the caller
 * (backend/src/index.js) is about to load via dotenv.config() — passing it
 * in guarantees we generate the SAME file that gets read, whether that's
 * the default `.env` in cwd or an Electron-provided DOTENV_CONFIG_PATH.
 */
function ensureEnvFile(envPath) {
  const targetPath = envPath || path.join(BACKEND_ROOT, '.env');

  if (fs.existsSync(targetPath)) {
    return { created: false, path: targetPath };
  }

  logInit('Creating configuration...');

  const isDesktop = process.env.ELECTRON_APP === '1';

  let template = {};
  try {
    template = dotenv.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'));
  } catch {
    // .env.example missing is unexpected but must never crash first run —
    // fall through with an empty template; the explicit fields below still
    // produce a complete, working .env.
  }

  const generated = {
    ...template,
    DATABASE_URL: buildDatabaseUrl(),
    PORT: template.PORT || '5000',
    NODE_ENV: process.env.NODE_ENV || 'production',
    FRONTEND_URL: template.FRONTEND_URL || 'http://localhost:3002',
    AUTH_ENABLED: template.AUTH_ENABLED || 'false',
    // Never a static string — a fresh, cryptographically random secret per install.
    JWT_SECRET: crypto.randomBytes(48).toString('hex'),
    JWT_EXPIRES: template.JWT_EXPIRES || '8h',
    CORS_ORIGINS: template.CORS_ORIGINS || 'http://localhost:3002,http://localhost:5000',
  };

  const content = Object.entries(generated)
    .map(([key, value]) => `${key}="${value}"`)
    .join('\n') + '\n';

  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // mode 0o600: best-effort owner-only permissions (POSIX; Windows ignores
  // the bits but the call itself is harmless there).
  fs.writeFileSync(targetPath, content, { encoding: 'utf8', mode: 0o600 });

  // Never log the generated values themselves — only that it happened, and
  // non-sensitive metadata (mode, host/port — not user/password).
  logInit(`Configuration created (${isDesktop ? 'Desktop' : 'Server'} mode) — database target ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || '3306'}`);

  return { created: true, path: targetPath };
}

module.exports = { ensureEnvFile };
