#!/usr/bin/env node
/**
 * create-admin-user.js — one-off, operator-run creation of a login account (role admin or hr).
 *
 * WHY: with AUTH_ENABLED=true every API call needs a login, and the application has no screen that creates an
 * admin/hr account (the employee form only creates role "employee"). This script is the supported way to create
 * the first one. It is NEVER run automatically, by the installer, the app, the seeder or CI.
 *
 *   node scripts/create-admin-user.js --dotenv-path "<full path to the server's .env>" ^
 *        --confirm-database <database name> --username <login> --role admin|hr [--name "Display name"] [--dry-run]
 *
 * SAFETY (each is enforced in code, see the exported functions and the tests):
 *   - the target database is chosen ONLY by --dotenv-path; there is no default location and no search. The process
 *     environment must not already define DATABASE_URL (two possible targets = ambiguous = refused);
 *   - the URL must be mysql:// and point at THIS machine (localhost / 127.0.0.1 / ::1); a remote host is refused;
 *   - --confirm-database must equal the database name in the URL, and the target (host:port/database, never the
 *     user or password) is printed before anything is written;
 *   - the password is typed twice at a hidden prompt on a real terminal. There is no flag, environment variable
 *     or file for it, so it can never land in shell history, process lists or logs; piped/non-interactive use is
 *     refused. Minimum 12 characters, must differ from the username;
 *   - the password and the bcrypt hash are never printed or logged;
 *   - an existing username is never modified (no overwrite, no password reset); only role admin/hr is accepted;
 *   - --dry-run validates everything (arguments, env file, target, username) and stops before the password
 *     prompt and before any database connection.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROLES = ['admin', 'hr'];
const USERNAME_RE = /^[A-Za-z0-9._-]{3,64}$/;
const MIN_PASSWORD_LENGTH = 12;
const BCRYPT_COST = 12;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

class UsageError extends Error {}

/** --key value / --key=value / --flag. Unknown arguments are refused (a typo must not silently change meaning). */
function parseArgs(argv) {
  const known = new Set(['dotenv-path', 'confirm-database', 'username', 'role', 'name', 'dry-run']);
  const flags = new Set(['dry-run']);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) throw new UsageError(`Unexpected argument "${tok}"`);
    const eq = tok.indexOf('=');
    const key = (eq === -1 ? tok.slice(2) : tok.slice(2, eq));
    if (!known.has(key)) throw new UsageError(`Unknown option --${key}`);
    if (key === 'password' || /pass/i.test(key)) throw new UsageError('The password is never accepted as an argument');
    if (flags.has(key)) { out[key] = true; continue; }
    let val = eq === -1 ? argv[++i] : tok.slice(eq + 1);
    if (val === undefined || val.startsWith('--')) throw new UsageError(`--${key} needs a value`);
    out[key] = val;
  }
  return out;
}

function validateUsername(u) {
  if (typeof u !== 'string' || !USERNAME_RE.test(u)) {
    return 'Username must be 3-64 characters: letters, digits, dot, underscore or hyphen';
  }
  return null;
}

function validateRole(r) {
  return ROLES.includes(r) ? null : `--role must be one of: ${ROLES.join(', ')}`;
}

function validatePassword(pw, username) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (pw.length > 72) return 'Password must be at most 72 characters (bcrypt limit)';
  if (username && pw.toLowerCase() === String(username).toLowerCase()) return 'Password must not equal the username';
  if (/^\s|\s$/.test(pw)) return 'Password must not start or end with whitespace';
  return null;
}

/** Reads only DATABASE_URL out of an env file. Returns the string or null. Never returns / logs anything else. */
function readDatabaseUrl(envFile, { readFile = fs.readFileSync, dotenv = require('dotenv') } = {}) {
  const parsed = dotenv.parse(readFile(envFile, 'utf8'));
  return parsed.DATABASE_URL ? String(parsed.DATABASE_URL) : null;
}

/**
 * Decide whether the database URL is an acceptable target. Returns { ok, error?, target? } where `target` holds the
 * non-secret parts only (host, port, database).
 */
function validateTarget(databaseUrl, confirmDatabase, { processEnvDatabaseUrl } = {}) {
  if (processEnvDatabaseUrl) {
    return { ok: false, error: 'DATABASE_URL is also set in the process environment: two possible targets. Unset it and rely on --dotenv-path only.' };
  }
  if (!databaseUrl) return { ok: false, error: 'The env file has no DATABASE_URL' };
  let u;
  try { u = new URL(databaseUrl); } catch { return { ok: false, error: 'DATABASE_URL is not a valid URL' }; }
  if (u.protocol !== 'mysql:') return { ok: false, error: 'DATABASE_URL must use the mysql:// scheme' };
  const host = u.hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    return { ok: false, error: `Refusing a non-local database host "${host}". Run this script on the server PC whose MySQL it targets.` };
  }
  const database = decodeURIComponent((u.pathname || '').replace(/^\//, ''));
  if (!database) return { ok: false, error: 'DATABASE_URL names no database' };
  if (!confirmDatabase) return { ok: false, error: '--confirm-database is required' };
  if (confirmDatabase !== database) {
    return { ok: false, error: `--confirm-database does not match the database in the env file ("${database}")` };
  }
  return { ok: true, target: { host, port: u.port || '3306', database } };
}

/** Hidden, double-entry password prompt. Refuses non-interactive stdin. */
function promptPassword(label, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      reject(new UsageError('A password can only be entered at an interactive terminal (piped input is refused)'));
      return;
    }
    output.write(label);
    let buf = '';
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') { done(); resolve(buf); return; }
        if (ch === String.fromCharCode(3)) { done(); output.write('\n'); reject(new UsageError('Cancelled')); return; }
        if (ch === String.fromCharCode(127) || ch === '\b') { buf = buf.slice(0, -1); continue; }
        buf += ch;
      }
    };
    const done = () => { input.setRawMode(false); input.pause(); input.removeListener('data', onData); output.write('\n'); };
    input.setRawMode(true); input.resume(); input.on('data', onData);
  });
}

/**
 * Creates the account. `prisma` and `bcrypt` are injected so tests can run without a database.
 * Never overwrites: an existing username is an error.
 */
async function createAccount({ prisma, bcrypt, username, name, role, password }) {
  const existing = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  if (existing) throw new UsageError(`A user named "${username}" already exists. This script never changes existing accounts.`);
  const hash = await bcrypt.hash(password, BCRYPT_COST);
  const user = await prisma.user.create({
    data: { username, password: hash, name: name || username, role, active: true },
    select: { id: true, username: true, role: true },
  });
  return user;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args['dotenv-path']) throw new UsageError('--dotenv-path is required (there is no default location)');
  if (!path.isAbsolute(args['dotenv-path'])) throw new UsageError('--dotenv-path must be an absolute path');
  if (!fs.existsSync(args['dotenv-path'])) throw new UsageError('The env file does not exist');
  if (!args.username) throw new UsageError('--username is required');
  const bad = validateUsername(args.username) || validateRole(args.role);
  if (bad) throw new UsageError(bad);

  const verdict = validateTarget(readDatabaseUrl(args['dotenv-path']), args['confirm-database'], { processEnvDatabaseUrl: process.env.DATABASE_URL });
  if (!verdict.ok) throw new UsageError(verdict.error);
  const { host, port, database } = verdict.target;
  process.stderr.write(`Target database: ${host}:${port}/${database}\nAccount: ${args.username} (role ${args.role})\n`);
  if (args['dry-run']) { process.stderr.write('Dry run: everything above is valid. Nothing was written and no database connection was made.\n'); return 0; }

  const pw1 = await promptPassword('New password: ');
  const bad1 = validatePassword(pw1, args.username);
  if (bad1) throw new UsageError(bad1);
  const pw2 = await promptPassword('Repeat password: ');
  if (pw1 !== pw2) throw new UsageError('The two passwords do not match');

  // Only now is the database touched. DATABASE_URL is taken from the chosen env file and nothing else.
  process.env.DATABASE_URL = readDatabaseUrl(args['dotenv-path']);
  const { PrismaClient } = require('@prisma/client');
  const bcrypt = require('bcryptjs');
  const prisma = new PrismaClient();
  try {
    const user = await createAccount({ prisma, bcrypt, username: args.username, name: args.name, role: args.role, password: pw1 });
    process.stderr.write(`Created ${user.role} account "${user.username}" (id ${user.id}).\n`);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    process.stderr.write(`${err instanceof UsageError ? 'Refused' : 'Failed'}: ${err.message}\n`);
    process.exit(err instanceof UsageError ? 2 : 1);
  });
}

module.exports = { parseArgs, validateUsername, validateRole, validatePassword, validateTarget, readDatabaseUrl, createAccount, promptPassword, UsageError, ROLES, MIN_PASSWORD_LENGTH };
