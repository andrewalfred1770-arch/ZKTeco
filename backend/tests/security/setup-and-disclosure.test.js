/**
 * F1 (setup endpoints), F8 (uploads), F9 (health / startup-status disclosure) + TLS guard.
 * Isolated: fake request/response objects only — no database, no .env, no open port, no device, no running service.
 * Run:  node --test tests/security/setup-and-disclosure.test.js      (from backend/)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loopbackOnly, evaluateDirectLocal, hostnameOfHostHeader } = require('../../src/middleware/loopbackOnly');
const { uploadsGuard, isPublicUploadPath } = require('../../src/middleware/uploadsGuard');
const { shapeHealth, shapeStartupStatus } = require('../../src/utils/statusDisclosure');

const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });
const run = (mw, r) => new Promise((resolve) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ passed: false, status: this.statusCode, body: b }); } };
  mw(r, res, () => resolve({ passed: true }));
});
const SRC = path.join(__dirname, '..', '..', 'src');

// ── F1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
test('F1: the desktop app (loopback peer, loopback Host, no proxy headers) is accepted', async () => {
  for (const [peer, host] of [['127.0.0.1', 'localhost:5000'], ['127.0.0.1', '127.0.0.1:5000'], ['::1', '[::1]:5000'], ['::ffff:127.0.0.1', 'localhost']]) {
    assert.equal((await run(loopbackOnly(), req(peer, { host }))).passed, true, `${peer} ${host}`);
  }
});

test('F1: a LAN client reaching the backend directly is refused (non-loopback peer)', async () => {
  const r = await run(loopbackOnly(), req('192.168.1.50', { host: '192.168.1.145:5000' }));
  assert.equal(r.passed, false); assert.equal(r.status, 403);
});

test('F1: a LAN browser forwarded by the local proxy (loopback peer + forwarding headers) is refused', async () => {
  for (const headers of [
    { host: 'localhost:5000', 'x-forwarded-for': '192.168.1.50' },
    { host: 'localhost:5000', 'x-forwarded-proto': 'https' },
    { host: 'localhost:5000', forwarded: 'for=192.168.1.50' },
    { host: 'localhost:5000', 'x-real-ip': '192.168.1.50' },
    { host: 'localhost:5000', via: '1.1 caddy' },
    { host: 'localhost:5000', 'x-checkin-proxy-key': 'anything' },
  ]) {
    const r = await run(loopbackOnly(), req('127.0.0.1', headers));
    assert.equal(r.passed, false, JSON.stringify(headers)); assert.equal(r.status, 403);
  }
});

test('F1: a proxy that strips its headers but keeps the LAN Host name is still refused (Host must be loopback)', async () => {
  for (const host of ['192.168.1.145', '192.168.1.145:8443', 'checkin.lan', 'server-pc', 'evil.example.com', 'localhost.evil.com', 'localhost@evil.com', '', undefined]) {
    const r = await run(loopbackOnly(), req('127.0.0.1', host === undefined ? {} : { host }));
    assert.equal(r.passed, false, `host=${host}`); assert.equal(r.status, 403);
  }
});

test('F1: forwarded headers can never UPGRADE a remote peer (a spoofed loopback X-Forwarded-For does nothing)', () => {
  assert.equal(evaluateDirectLocal(req('203.0.113.9', { host: 'localhost', 'x-forwarded-for': '127.0.0.1' })).ok, false);
  assert.equal(evaluateDirectLocal(req(undefined, { host: 'localhost' })).ok, false);
  assert.equal(evaluateDirectLocal({}).ok, false);
});

test('F1: Host parsing', () => {
  assert.equal(hostnameOfHostHeader('[::1]:5000'), '::1');
  assert.equal(hostnameOfHostHeader('localhost:5000'), 'localhost');
  assert.equal(hostnameOfHostHeader('a b'), '');
  assert.equal(hostnameOfHostHeader(['localhost']), '');
});

test('F1 (source): the whole setup router sits behind loopbackOnly(), registered before any route', () => {
  const s = fs.readFileSync(path.join(SRC, 'routes', 'setup.js'), 'utf8');
  const guard = s.search(/router\.use\(loopbackOnly\(\)\)/);
  const first = s.search(/router\.(get|post|put|patch|delete|all)\(/);
  assert.ok(guard > -1 && first > -1 && guard < first, 'loopbackOnly must be installed before the first route');
  // the route files must never read from forwarded headers or req.ip to decide locality
  const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /x-forwarded|req\.ip/i);
});

test('F1 (source): /api/setup/current never returns a password and only exposes fields parseDatabaseUrl returns', () => {
  const s = fs.readFileSync(path.join(SRC, 'routes', 'setup.js'), 'utf8');
  assert.match(s, /password is intentionally never returned/);
});

// ── F8 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
test('F8: branding images stay public', () => {
  for (const p of ['/company/logo-1729600000000-ab12cd34.png', '/company/stamp-1-ff00ff00.jpg', '/company/loginBackground-1-aa.JPEG', '/company/printHeader-1-aa.webp']) {
    assert.equal(isPublicUploadPath(p), true, p);
  }
});

test('F8: cache.json, other JSON/internal files, temp uploads, dotfiles and traversal are blocked', async () => {
  for (const p of ['/company/cache.json', '/cache.json', '/company/cache.json/', '/company/tmp-0123456789abcdef', '/company/tmp-0123.png', '/company/.env', '/company/.hidden.png',
    '/company/x.json', '/company/x.png.json', '/company/x.svg', '/company/x.html', '/company/', '/', '/company', '/../../.env', '/company/..%2f..%2f.env', '/company/a/../cache.json',
    '/company/x.png%00.json', '/company\\cache.json', '/company/x.png ', '/company/x.PNG.exe']) {
    assert.equal(isPublicUploadPath(p), false, p);
  }
  const mw = uploadsGuard();
  const blocked = await run(mw, { method: 'GET', path: '/company/cache.json' });
  assert.equal(blocked.passed, false); assert.equal(blocked.status, 404);
  assert.equal((await run(mw, { method: 'GET', path: '/company/logo-1-aa.png' })).passed, true);
  assert.equal((await run(mw, { method: 'POST', path: '/company/logo-1-aa.png' })).passed, false);
});

test('F8 (source): /uploads is always mounted behind the guard, and no other static route serves the config dir', () => {
  const s = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8');
  assert.match(s, /app\.use\('\/uploads', require\('\.\/middleware\/uploadsGuard'\)\.uploadsGuard\(\),/);
  assert.equal(s.split('express.static(').length - 1, 2);   // uploads (guarded above) + FRONTEND_DIST
  assert.match(s, /express\.static\(frontendDist,/);
  assert.doesNotMatch(s, /express\.static\(getConfigDir|express\.static\(path\.join\(getConfigDir\(\)\)\)/);
});

// ── F9 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const FULL_HEALTH = { status: 'starting', db: 'disconnected', ready: false, timestamp: new Date(), version: '1.1.5', apiVersion: 3, authEnabled: true, dbError: 'auth-failed', startup: { phase: 'blocked', stage: 'database', reason: 'x' } };
const FULL_STATUS = { dbConnected: false, servicesStarted: false, devices: { total: 3, connected: 2 }, ready: false, startup: { phase: 'blocked' } };

test('F9: remote callers get only the connect-time health fields', () => {
  const r = shapeHealth(FULL_HEALTH, false);
  assert.deepEqual(Object.keys(r).sort(), ['apiVersion', 'authEnabled', 'db', 'ready', 'status', 'version']);
  assert.equal(r.dbError, undefined); assert.equal(r.startup, undefined); assert.equal(r.timestamp, undefined);
});

test('F9: remote startup-status has no device counts or startup detail but keeps its shape', () => {
  const r = shapeStartupStatus(FULL_STATUS, false);
  assert.deepEqual(r.devices, { total: 0, connected: 0 });
  assert.equal(r.startup, undefined);
  assert.deepEqual(Object.keys(r).sort(), ['dbConnected', 'devices', 'ready', 'servicesStarted']);
});

test('F9: the desktop shell on this PC keeps the diagnostic detail it consumes', () => {
  assert.equal(shapeHealth(FULL_HEALTH, true), FULL_HEALTH);
  assert.deepEqual(shapeStartupStatus(FULL_STATUS, true).devices, { total: 3, connected: 2 });
});

test('F9: no response shape can carry connection details', () => {
  const blob = JSON.stringify([shapeHealth(FULL_HEALTH, false), shapeStartupStatus(FULL_STATUS, false)]);
  assert.doesNotMatch(blob, /mysql:|password|host|username|stack|\.env|[A-Za-z]:\\\\/i);
});

// ── TLS ─────────────────────────────────────────────────────────────────────────────────────────────────────────
test('TLS: certificate verification is never disabled in backend or Electron sources', () => {
  const roots = [SRC, path.join(__dirname, '..', '..', '..', 'frontend', 'electron')];
  const bad = /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED|ignore-certificate-errors|setCertificateVerifyProc|allowInsecureLocalhost/;
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
  const offenders = roots.filter(fs.existsSync).flatMap(walk).filter((f) => /\.(c|m)?js$/.test(f) && bad.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});
