/**
 * `prisma migrate deploy` cache location (isolated: stubbed child_process / Prisma / init log; no database, no .env, no network).
 *
 * Bug: a per-machine install (C:\Program Files\CheckIn) is read-only for a normal user, and Prisma's CLI wants to create
 * <backend>\node_modules\.cache\prisma -> EPERM -> migration "failed" -> backend blocked -> "cannot reach the server".
 * Fix under test: when the app runs with a persistent CONFIG_DIR, the migrate child gets CACHE_DIR=<CONFIG_DIR>\cache.
 * Run:  node --test tests/consistency/migrate-cache-dir.test.js      (from backend/)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const childProcess = require('child_process');

const SRC = path.resolve(process.env.CONSISTENCY_SRC || path.join(__dirname, '..', '..', 'src'));
process.env.NODE_PATH = [path.join(__dirname, '..', '..', 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
Module._initPaths();

const stub = (rel, exports) => {
  const file = require.resolve(path.join(SRC, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] };
};
stub('utils/prisma.js', {
  getPrisma: () => ({ company: { count: async () => 1 } }),      // "existing data" -> the seeders never run
  checkDbConnection: async () => true, disconnectPrisma: async () => {}, getLastDbErrorReason: () => null, classifyDbError: () => 'unknown',
});
stub('init/firstRunLog.js', { logInit() {} });

const realExec = childProcess.execFileSync;
const MARKER = 'migrate-cache-dir-test';
function loadFresh() {
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(SRC, 'init', 'migrateAndSeed')) || k.startsWith(path.join(SRC, 'utils', 'configDir'))) delete require.cache[k];
  return require(path.join(SRC, 'init', 'migrateAndSeed.js'));
}

/** Runs the real bootstrap with a recording stand-in for the Prisma CLI; returns what the migrate child was given. */
async function runBootstrap({ configDir, cacheDir }) {
  const saved = { CONFIG_DIR: process.env.CONFIG_DIR, CACHE_DIR: process.env.CACHE_DIR, MARK: process.env[MARKER] };
  for (const [k, v] of [['CONFIG_DIR', configDir], ['CACHE_DIR', cacheDir]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  process.env[MARKER] = 'passes-through';
  const calls = [];
  childProcess.execFileSync = (exe, args, opts) => { calls.push({ exe, args, opts }); return Buffer.from('No pending migrations to apply.'); };
  try {
    const mod = loadFresh();
    const res = await mod.runMigrationsAndSeed();
    return { res, calls };
  } finally {
    childProcess.execFileSync = realExec;
    for (const [k, v] of Object.entries({ CONFIG_DIR: saved.CONFIG_DIR, CACHE_DIR: saved.CACHE_DIR })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (saved.MARK === undefined) delete process.env[MARKER]; else process.env[MARKER] = saved.MARK;
  }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-cache-test-'));

test('M1. with a persistent CONFIG_DIR the migrate child gets CACHE_DIR=<CONFIG_DIR>\\cache, and the folder exists', async () => {
  const cfg = tmp();
  try {
    const { res, calls } = await runBootstrap({ configDir: cfg });
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1, 'exactly one prisma invocation');
    assert.deepEqual(calls[0].args.slice(1), ['migrate', 'deploy']);
    assert.equal(calls[0].opts.env.CACHE_DIR, path.join(cfg, 'cache'));
    assert.ok(fs.statSync(path.join(cfg, 'cache')).isDirectory());
  } finally { fs.rmSync(cfg, { recursive: true, force: true }); }
});

test('M2. an explicit CACHE_DIR is respected (not overwritten, no folder invented)', async () => {
  const cfg = tmp(); const mine = path.join(tmp(), 'my-cache');
  try {
    const { calls } = await runBootstrap({ configDir: cfg, cacheDir: mine });
    assert.equal(calls[0].opts.env.CACHE_DIR, mine);
    assert.equal(fs.existsSync(path.join(cfg, 'cache')), false);
  } finally { fs.rmSync(cfg, { recursive: true, force: true }); fs.rmSync(path.dirname(mine), { recursive: true, force: true }); }
});

test('M3. without CONFIG_DIR (dev / tests / server mode) the environment is unchanged - no CACHE_DIR is added', async () => {
  const { calls } = await runBootstrap({});
  assert.equal(calls.length, 1);
  assert.equal('CACHE_DIR' in calls[0].opts.env, false);
});

test('M4. the rest of the environment and the invocation are untouched (cwd, node, CLI path, other variables pass through)', async () => {
  const cfg = tmp();
  try {
    const { calls } = await runBootstrap({ configDir: cfg });
    const c = calls[0];
    assert.equal(c.exe, process.execPath);
    assert.match(c.args[0].replace(/\\/g, '/'), /prisma\/build\/index\.js$/);
    assert.equal(path.resolve(c.opts.cwd), path.resolve(SRC, '..'));
    assert.equal(c.opts.env[MARKER], 'passes-through');
    assert.equal(c.opts.env.CONFIG_DIR, cfg);
    assert.equal(c.opts.timeout, 60000);
    assert.equal(c.opts.stdio, 'pipe');
  } finally { fs.rmSync(cfg, { recursive: true, force: true }); }
});

test('M5. an unwritable CONFIG_DIR does not hide the real error: Prisma keeps its default and the failure is reported as before', async () => {
  const cfg = tmp();
  const blocker = path.join(cfg, 'cache');
  fs.writeFileSync(blocker, 'a FILE where the cache folder would go');            // mkdir(recursive) on it fails
  try {
    const { res, calls } = await runBootstrap({ configDir: cfg });
    assert.equal(res.ok, true);
    assert.equal('CACHE_DIR' in calls[0].opts.env, false, 'no CACHE_DIR when the folder cannot be created');
  } finally { fs.rmSync(cfg, { recursive: true, force: true }); }
});

test('M6. a failing migration still blocks startup (the fix does not mask a real migration failure)', async () => {
  const cfg = tmp();
  const saved = process.env.CONFIG_DIR; process.env.CONFIG_DIR = cfg; delete process.env.CACHE_DIR;
  childProcess.execFileSync = () => { const e = new Error('boom'); e.status = 1; e.stderr = Buffer.from('Error: EPERM: operation not permitted'); throw e; };
  try {
    const res = await loadFresh().runMigrationsAndSeed();
    assert.equal(res.ok, false);
    assert.match(String(res.stage || ''), /migration/i);
  } finally { childProcess.execFileSync = realExec; if (saved === undefined) delete process.env.CONFIG_DIR; else process.env.CONFIG_DIR = saved; fs.rmSync(cfg, { recursive: true, force: true }); }
});

test('M7. guard: the cache override lives only in migrateAndSeed.js and uses Prisma\'s CACHE_DIR variable', () => {
  const src = fs.readFileSync(path.join(SRC, 'init', 'migrateAndSeed.js'), 'utf8');
  assert.equal((src.match(/env\.CACHE_DIR\s*=/g) || []).length, 1);
  assert.match(src, /env: migrateEnv\(\)/);
  assert.doesNotMatch(src, /env: process\.env,\s*\r?\n\s*stdio: 'pipe',\s*\r?\n\s*timeout: 60000/, 'the migrate call no longer passes the raw environment');
});
