/**
 * Device-route guard + reverse-proxy trust (isolated: stubbed Prisma / device services / auth, 127.0.0.1 ephemeral ports,
 * no database, no .env, no ZKTeco device, no real network).
 *
 * A backend started with SKIP_SCHEDULER=true (the LAN instance) must NEVER open a ZKTeco session, not even from a manual route.
 * Run:  node --test tests/consistency/device-ops-guard.test.js      (from backend/)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const http = require('http');
const Module = require('module');

const SRC = path.resolve(__dirname, '..', '..', 'src');
process.env.NODE_PATH = [path.join(__dirname, '..', '..', 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
Module._initPaths();

const stub = (rel, exports) => {
  const file = require.resolve(path.join(SRC, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] };
};

// ── counting fakes for everything that can touch a device ──────────────────────────────────────────────────────────────
const calls = [];
const rec = (name, ret) => async (...a) => { calls.push(name); return typeof ret === 'function' ? ret(...a) : ret; };
const silent = { info() {}, warn() {}, error() {}, debug() {}, verbose() {}, log() {} };
const dbRows = { device: [{ id: 1, name: 'd', ipAddress: '192.0.2.10', port: 4370, enabled: true, isArchived: false, branchId: 1 }], employee: [{ id: 5, zkUserId: '77', isArchived: false, name: 'x', branch: {} }] };
const prismaFake = new Proxy({}, {
  get: (_t, model) => new Proxy({}, {
    get: (_m, op) => async (args) => {
      calls.push(`db:${String(model)}.${String(op)}`);
      const rows = dbRows[model] || [];
      if (op === 'findMany') return rows;
      if (op === 'findUnique' || op === 'findFirst') return rows[0] || null;
      if (op === 'count') return rows.length;
      return rows[0] || {};
    },
  }),
  // $transaction(fn|array) support
  $transaction: async (x) => (typeof x === 'function' ? x(prismaFake) : Promise.all(x)),
});
stub('utils/logger.js', silent);
stub('utils/prisma.js', { getPrisma: () => prismaFake, checkDbConnection: async () => true, disconnectPrisma: async () => {}, getLastDbErrorReason: () => null, classifyDbError: () => 'unknown' });
stub('services/zktecoService.js', {
  pullLogs: rec('zk.pullLogs', { skipped: true }), pullAllDevices: rec('zk.pullAllDevices', []),
  testConnection: rec('zk.testConnection', { ok: true }), pingDevice: rec('zk.pingDevice', { ok: true }),
  getDeviceUsers: rec('zk.getDeviceUsers', []), deleteDeviceUser: rec('zk.deleteDeviceUser', { ok: true }),
});
stub('services/realtimeListenerService.js', {
  startListener: rec('rt.startListener'), stopListener: rec('rt.stopListener'), restartListener: rec('rt.restartListener'),
  getStatus: () => ({}), getAllStatus: () => ({}), getListenerStatus: () => ({}),
});
stub('services/deviceUserDiscoveryService.js', { scanAll: rec('disc.scanAll', {}), getNewUsers: async () => [], getState: () => ({}) });
// auth fake: role comes from x-role (absent -> 401); authorize(...roles) -> 403 when the role is not listed. (The real JWT / role code
// is exercised in the live LAN run and backend/tests/auth; this file tests the ORDER and the guard.)
stub('middleware/auth.js', {
  authenticate: (req, res, next) => { const r = req.headers['x-role']; if (!r) return res.status(401).json({ error: 'auth' }); req.user = { role: r }; next(); },
  authorize: (...roles) => (req, res, next) => (roles.length && !roles.includes(req.user.role) ? res.status(403).json({ error: 'role' }) : next()),
});

const express = require('express');
const guardMod = require(path.join(SRC, 'middleware', 'deviceOpsGuard.js'));
const devicesRouter = require(path.join(SRC, 'routes', 'devices.js'));
const employeesRouter = require(path.join(SRC, 'routes', 'employees.js'));

const app = express();
app.use(express.json());
app.use('/api/devices', devicesRouter);
app.use('/api/employees', employeesRouter);
let server; let base;
test.before(async () => { await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => new Promise((r) => server.close(r)));

const call = async (method, p, role, body) => {
  const headers = { 'content-type': 'application/json' };
  if (role) headers['x-role'] = role;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, json: j };
};
const deviceCalls = () => calls.filter((c) => /^(zk|rt|disc)\./.test(c));
const withSkip = async (value, fn) => {
  const prev = process.env.SKIP_SCHEDULER;
  if (value === undefined) delete process.env.SKIP_SCHEDULER; else process.env.SKIP_SCHEDULER = value;
  try { await fn(); } finally { if (prev === undefined) delete process.env.SKIP_SCHEDULER; else process.env.SKIP_SCHEDULER = prev; }
};

// Every route that opens (or manages) a device session. method, path, minimal role that is allowed, body
const DEVICE_ROUTES = [
  ['POST', '/api/devices', 'admin', { name: 'n', ipAddress: '192.0.2.10', port: 4370, branchId: 1 }],
  ['PUT', '/api/devices/1', 'admin', { name: 'n', ipAddress: '192.0.2.10', port: 4370, enabled: true }],
  ['DELETE', '/api/devices/1', 'admin', {}],
  ['POST', '/api/devices/1/sync', 'hr', {}],
  ['POST', '/api/devices/sync-all', 'hr', {}],
  ['POST', '/api/devices/test-connection', 'admin', { ipAddress: '192.0.2.10', port: 4370 }],
  ['POST', '/api/devices/1/ping', 'hr', {}],
  ['POST', '/api/devices/1/realtime/restart', 'hr', {}],
  ['POST', '/api/devices/new-users/scan', 'hr', {}],
  ['POST', '/api/devices/relink', 'hr', {}],
  ['GET', '/api/devices/1/users', 'admin'],
];

test('A. SKIP_SCHEDULER=true: every device-contacting route answers 409 DEVICE_OPERATIONS_DISABLED and opens NO device session / does no DB write', async () => {
  await withSkip('true', async () => {
    for (const [m, p, role, body] of DEVICE_ROUTES) {
      calls.length = 0;
      const r = await call(m, p, role, body);
      assert.equal(r.status, 409, `${m} ${p}`);
      assert.equal(r.json.code, 'DEVICE_OPERATIONS_DISABLED', `${m} ${p}`);
      assert.deepEqual(calls, [], `${m} ${p} must not reach the handler (no device call, no DB access): ${calls}`);
    }
  });
});

test('B. employee delete-confirm with includeDevice → 409 BEFORE anything is read or deleted; without includeDevice it is not blocked', async () => {
  await withSkip('true', async () => {
    calls.length = 0;
    const r = await call('POST', '/api/employees/5/delete-confirm', 'admin', { includeDevice: true });
    assert.equal(r.status, 409); assert.equal(r.json.code, 'DEVICE_OPERATIONS_DISABLED');
    assert.deepEqual(calls, [], `nothing may run before the refusal: ${calls}`);
    calls.length = 0;
    const ok = await call('POST', '/api/employees/5/delete-confirm', 'admin', { includeDevice: false });
    assert.notEqual(ok.status, 409, 'a DB-only delete is not a device operation');
    assert.deepEqual(deviceCalls(), []);
  });
});

test('C. SKIP_SCHEDULER unset / "false" / any non-"true" value: the desktop behaves exactly as before (handlers run, device service is called)', async () => {
  for (const v of [undefined, 'false', '', 'TRUE', '1', 'yes']) {
    await withSkip(v, async () => {
      calls.length = 0;
      const r = await call('POST', '/api/devices/1/sync', 'hr', {});
      assert.notEqual(r.status, 409, `SKIP_SCHEDULER=${JSON.stringify(v)} must not block (index.js treats only the exact word "true" as skip)`);
      assert.ok(calls.includes('zk.pullLogs'), `SKIP_SCHEDULER=${JSON.stringify(v)}: the sync handler must run`);
    });
  }
  assert.equal(guardMod.isSkipSchedulerInstance({ SKIP_SCHEDULER: 'true' }), true);
  assert.equal(guardMod.isSkipSchedulerInstance({ SKIP_SCHEDULER: 'TRUE' }), false);
});

test('D. role checks still win over the guard: no token → 401, wrong role → 403 (never a 409 that leaks the instance mode); allowed role → 409', async () => {
  await withSkip('true', async () => {
    for (const [m, p, , body] of DEVICE_ROUTES) {
      assert.equal((await call(m, p, null, body)).status, 401, `unauthenticated ${m} ${p}`);
      assert.equal((await call(m, p, 'employee', body)).status, 403, `employee role ${m} ${p}`);
    }
    // admin-only routes reject hr with 403, hr-allowed routes give hr the 409
    assert.equal((await call('POST', '/api/devices', 'hr', {})).status, 403);
    assert.equal((await call('POST', '/api/devices/1/sync', 'hr', {})).status, 409);
    assert.equal((await call('POST', '/api/employees/5/delete-confirm', 'hr', { includeDevice: true })).status, 403);
  });
});

test('E. read-only device pages (DB / in-memory data) stay available on the LAN instance', async () => {
  await withSkip('true', async () => {
    calls.length = 0;
    for (const p of ['/api/devices', '/api/devices/stats', '/api/devices/audit-logs', '/api/devices/sync-logs/recent', '/api/devices/relink-diagnostics', '/api/devices/realtime-status', '/api/devices/new-users', '/api/devices/1', '/api/devices/1/sync-logs']) {
      const r = await call('GET', p, 'admin');
      assert.notEqual(r.status, 409, `GET ${p} is a read and must not be refused`);
      assert.notEqual(r.status, 401); assert.notEqual(r.status, 403);
    }
    assert.deepEqual(deviceCalls(), [], 'the reads must not open a device session');
  });
});

test('F. STRUCTURE: every route in devices.js is either carrying deviceOpsGuard or on the explicit read-only allow-list (a new route cannot slip through)', () => {
  const READ_ONLY = new Set([
    'GET /', 'GET /stats', 'GET /audit-logs', 'GET /sync-logs/recent', 'GET /relink-diagnostics', 'GET /realtime-status',
    'GET /new-users', 'GET /:id', 'GET /:id/sync-logs', 'GET /:id/recovery-diagnostics',
  ]);
  const seen = [];
  for (const layer of devicesRouter.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      const key = `${method.toUpperCase()} ${layer.route.path}`;
      const guarded = layer.route.stack.some((s) => s.handle === guardMod.deviceOpsGuard);
      seen.push(key);
      if (READ_ONLY.has(key)) assert.equal(guarded, false, `${key} is read-only and should not be blocked`);
      else assert.ok(guarded, `${key} is not on the read-only allow-list and has NO deviceOpsGuard`);
    }
  }
  for (const k of READ_ONLY) assert.ok(seen.includes(k), `allow-list entry ${k} no longer exists — update the list deliberately`);
  assert.equal(seen.length - READ_ONLY.size, 11, 'exactly the 11 guarded routes carry the guard (10 device-contacting + POST /relink, a DB writer kept off the LAN instance)');
});

test('G. STRUCTURE: only devices.js and employees.js (routes) import a device-contacting service; index/scheduler paths are skipped by SKIP_SCHEDULER; relinkService is device-free', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const DEVICE_SVC = /require\(\s*['"][^'"]*(zktecoService|realtimeListenerService|deviceUserDiscoveryService|zkChunkedAttendanceReader|deviceGate)['"]\s*\)|require\(\s*['"](zklib|zkteco-js|node-zklib)/;
  const importers = walk(path.join(SRC, 'routes')).filter((f) => f.endsWith('.js') && DEVICE_SVC.test(strip(fs.readFileSync(f, 'utf8'))))
    .map((f) => path.relative(path.join(SRC, 'routes'), f).replace(/\\/g, '/')).sort();
  assert.deepEqual(importers, ['devices.js', 'employees.js'], 'a new route file reaches a device service: guard it, then add it here');
  assert.ok(!DEVICE_SVC.test(strip(fs.readFileSync(path.join(SRC, 'services', 'relinkService.js'), 'utf8'))), 'relinkService must stay device-free');
  const sockets = strip(fs.readFileSync(path.join(SRC, 'index.js'), 'utf8'));
  assert.ok(/isSkipSchedulerInstance\(\)/.test(sockets) && !/process\.env\.SKIP_SCHEDULER\s*===/.test(sockets), 'index.js must use the shared SKIP_SCHEDULER definition');
});

test('H. employees.js: the only device call is behind includeDevice AND the guard (static check of the handler)', () => {
  const t = fs.readFileSync(path.join(SRC, 'routes', 'employees.js'), 'utf8');
  const uses = t.match(/deleteDeviceUser\(/g) || [];
  assert.equal(uses.length, 1, 'exactly one deleteDeviceUser call site');
  assert.ok(t.indexOf('refuseDeviceOps(req, res)') > -1 && t.indexOf('refuseDeviceOps(req, res)') < t.indexOf('deleteDeviceUser('), 'the refusal must come before the device call');
});

// ── trust proxy ────────────────────────────────────────────────────────────────────────────────────────────────────────
const { resolveTrustProxy } = require(path.join(SRC, 'config', 'securityConfig.js'));

test('I. resolveTrustProxy: off by default; only the literal "loopback" on a loopback bind turns it on; everything else is off or refused', () => {
  for (const raw of [undefined, null, '', 'false', '0', 'off', ' "false" ']) {
    const r = resolveTrustProxy({ raw, host: '127.0.0.1' }); assert.equal(r.ok, true); assert.equal(r.value, false, String(raw));
  }
  const on = resolveTrustProxy({ raw: 'loopback', host: '127.0.0.1' });
  assert.deepEqual([on.ok, on.value], [true, 'loopback']);
  assert.equal(resolveTrustProxy({ raw: ' "Loopback" ', host: 'localhost' }).value, 'loopback');
  for (const host of ['0.0.0.0', '192.168.1.145', '::']) {
    const r = resolveTrustProxy({ raw: 'loopback', host });
    assert.equal(r.ok, false, `loopback proxy trust on a ${host} bind must be refused`); assert.equal(r.error.code, 'UNSAFE_TRUST_PROXY');
  }
  // broad values are never honoured, on any bind
  for (const raw of ['true', '1', 'yes', '192.168.1.1', '10.0.0.0/8', 'uniquelocal', 'linklocal', '2', 'loopback, 192.168.1.5']) {
    for (const host of ['127.0.0.1', '192.168.1.145']) {
      const r = resolveTrustProxy({ raw, host });
      assert.equal(r.ok, true); assert.equal(r.value, false, `${raw} on ${host}`); assert.ok(r.warnings.length >= 1, `${raw} must warn`);
    }
  }
});

test('J. Express "trust proxy"=loopback: X-Forwarded-For is honoured only from a loopback peer; a LAN peer cannot spoof its address or scheme; default (off) ignores it entirely', async () => {
  const mk = (trust) => {
    const a = express();
    if (trust) a.set('trust proxy', trust);
    a.get('/who', (req, res) => res.json({ ip: req.ip, secure: req.secure }));
    return a;
  };
  const probe = async (a, headers) => {
    const s = await new Promise((r) => { const x = http.createServer(a).listen(0, '127.0.0.1', () => r(x)); });
    try {
      const r = await fetch(`http://127.0.0.1:${s.address().port}/who`, { headers });
      return await r.json();
    } finally { await new Promise((r) => s.close(r)); }
  };
  const xff = { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' };
  // peer here is 127.0.0.1 (a "local proxy")
  const viaProxy = await probe(mk(resolveTrustProxy({ raw: 'loopback', host: '127.0.0.1' }).value), xff);
  assert.equal(viaProxy.ip, '203.0.113.9'); assert.equal(viaProxy.secure, true);
  const off = await probe(mk(resolveTrustProxy({ raw: undefined, host: '127.0.0.1' }).value), xff);
  assert.match(off.ip, /127\.0\.0\.1/); assert.equal(off.secure, false);
  // a non-loopback peer: Express's own "loopback" matcher (proxy-addr) — simulate by asking it directly
  const proxyaddr = require('proxy-addr');
  const compiled = require('express/lib/utils').compileTrust('loopback');
  const fakeReq = (remote, xffv) => ({ connection: { remoteAddress: remote }, headers: { 'x-forwarded-for': xffv } });
  assert.equal(proxyaddr(fakeReq('::ffff:127.0.0.1', '203.0.113.9'), compiled), '203.0.113.9');
  assert.equal(proxyaddr(fakeReq('192.168.1.77', '203.0.113.9'), compiled), '192.168.1.77', 'a LAN client\'s forged X-Forwarded-For is ignored');
  assert.equal(proxyaddr(fakeReq('192.168.1.77', '127.0.0.1'), compiled), '192.168.1.77', 'a LAN client claiming to be loopback is ignored');
});

test('K. wiring: index.js applies the resolver output only (no literal "trust proxy" with a broad value anywhere in src)', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const hits = walk(SRC).filter((f) => f.endsWith('.js')).flatMap((f) => (fs.readFileSync(f, 'utf8').match(/\.set\(\s*['"]trust proxy['"][^\n]*/g) || []).map((m) => `${path.relative(SRC, f)}: ${m}`));
  assert.equal(hits.length, 1, hits.join('\n'));
  assert.match(hits[0], /index\.js: \.set\('trust proxy', trustProxy\.value/);
});
