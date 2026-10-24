/**
 * CORS policy (config/corsPolicy.js): allowed / rejected origins for desktop (auth OFF) and LAN-server (auth ON) modes.
 * Isolated: bare express + the real `cors` middleware on 127.0.0.1 ephemeral ports. No database, no .env, no device, no network.
 * Run:  node --test tests/consistency/cors-policy.test.js      (from backend/)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require(path.join(__dirname, '..', '..', 'node_modules', 'express'));
const cors = require(path.join(__dirname, '..', '..', 'node_modules', 'cors'));
const { isLoopbackOrigin, parseCorsOrigins, createCorsOriginCheck } = require('../../src/config/corsPolicy');

const decide = (check, origin) => new Promise((resolve) => check(origin, (err, ok) => resolve(err ? { allowed: false, status: err.status } : { allowed: !!ok })));

const DESKTOP = createCorsOriginCheck({ authEnabled: false, allowList: ['https://192.168.1.20:8443'] }); // list is ignored when auth is off
const LAN = createCorsOriginCheck({ authEnabled: true, allowList: parseCorsOrigins('https://192.168.1.20:8443, http://localhost:5100').origins });

test('desktop mode: loopback origins and no-Origin requests are allowed', async () => {
  for (const o of [undefined, '', 'http://localhost:3002', 'http://localhost', 'https://localhost:5000', 'http://127.0.0.1:5000', 'http://[::1]:5000']) {
    assert.equal((await decide(DESKTOP, o)).allowed, true, `expected allowed: ${o}`);
  }
});

test('desktop mode: private-LAN, single-label, .local/.lan, public and malformed origins are rejected with 403', async () => {
  const bad = [
    'http://192.168.1.20:5000', 'http://10.0.0.5', 'http://172.16.4.4:3000', 'https://192.168.1.20:8443', // RFC1918 (even if listed)
    'http://SERVER-PC:5000', 'http://server', 'http://printer.local', 'http://nas.lan:8080',              // single-label / mDNS
    'https://evil.example.com', 'http://localhost.evil.com', 'http://127.0.0.1.evil.com', 'http://localhost:5000@evil.com',
    'http://localhost:99999999', 'null', 'file://', 'ftp://localhost', 'http://0.0.0.0:5000', 'http://127.0.0.2:5000',
  ];
  for (const o of bad) { const r = await decide(DESKTOP, o); assert.deepEqual(r, { allowed: false, status: 403 }, `expected rejected: ${o}`); }
});

test('LAN mode: only exact listed origins; everything else (incl. loopback not listed, LAN lookalikes, .local) rejected', async () => {
  assert.equal((await decide(LAN, 'https://192.168.1.20:8443')).allowed, true);
  assert.equal((await decide(LAN, 'http://localhost:5100')).allowed, true);
  assert.equal((await decide(LAN, undefined)).allowed, true);
  for (const o of ['https://192.168.1.20', 'http://192.168.1.20:8443', 'https://192.168.1.21:8443', 'https://192.168.1.20:8443/', 'http://127.0.0.1:5100',
    'http://localhost:3002', 'http://SERVER-PC:8443', 'https://box.local:8443', 'https://evil.example.com', '*', 'null']) {
    assert.deepEqual(await decide(LAN, o), { allowed: false, status: 403 }, `expected rejected: ${o}`);
  }
});

test('parseCorsOrigins keeps only exact http(s) origins', () => {
  const r = parseCorsOrigins(' https://192.168.1.20:8443 ,http://localhost:5100,*,https://*.example.com,http://a.com/path,http://a.com/,https://u:p@a.com,ftp://a.com,not a url,HTTPS://B.com:443,https://192.168.1.20:8443');
  assert.deepEqual(r.origins, ['https://192.168.1.20:8443', 'http://localhost:5100', 'https://b.com']);
  assert.equal(r.rejected.length, 7);
  assert.deepEqual(parseCorsOrigins(undefined), { origins: [], rejected: [] });
  assert.equal(isLoopbackOrigin('http://localhost:5000'), true);
  assert.equal(isLoopbackOrigin('http://localhost:5000.evil.com'), false);
});

// ── real HTTP: preflight, credentials policy, forged headers ───────────────────────────────────────────────────────────────
function startApp(check) {
  const app = express();
  app.use(cors({ origin: check, credentials: true }));
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return new Promise((resolve) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)); });
}
const call = (port, method, headers) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/ping', method, headers }, (res) => {
    let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject); req.end();
});

test('HTTP desktop mode: preflight + credentials for loopback origin; LAN origin and forged forwarded headers rejected', async () => {
  const s = await startApp(DESKTOP); const port = s.address().port;
  try {
    const ok = await call(port, 'OPTIONS', { Origin: 'http://localhost:3002', 'Access-Control-Request-Method': 'POST' });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers['access-control-allow-origin'], 'http://localhost:3002');
    assert.equal(ok.headers['access-control-allow-credentials'], 'true');
    assert.notEqual(ok.headers['access-control-allow-origin'], '*');

    const lan = await call(port, 'OPTIONS', { Origin: 'http://192.168.1.20:5000', 'Access-Control-Request-Method': 'POST' });
    assert.equal(lan.status, 403);
    assert.equal(lan.headers['access-control-allow-origin'], undefined);

    const forged = await call(port, 'GET', {
      Origin: 'http://SERVER-PC:5000', 'X-Forwarded-For': '127.0.0.1', 'X-Forwarded-Host': 'localhost:3002',
      'X-Forwarded-Proto': 'https', Forwarded: 'for=127.0.0.1;host=localhost', 'X-Original-Host': 'localhost', 'X-Real-IP': '127.0.0.1',
    });
    assert.equal(forged.status, 403);
    assert.equal(forged.headers['access-control-allow-origin'], undefined);

    const noOrigin = await call(port, 'GET', {});
    assert.equal(noOrigin.status, 200);
    assert.equal(noOrigin.headers['access-control-allow-origin'], undefined);
  } finally { s.close(); }
});

test('HTTP LAN mode: listed HTTPS origin allowed with credentials; everything else rejected', async () => {
  const s = await startApp(LAN); const port = s.address().port;
  try {
    const ok = await call(port, 'OPTIONS', { Origin: 'https://192.168.1.20:8443', 'Access-Control-Request-Method': 'GET' });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers['access-control-allow-origin'], 'https://192.168.1.20:8443');
    assert.equal(ok.headers['access-control-allow-credentials'], 'true');
    for (const o of ['https://192.168.1.99:8443', 'http://box.local', 'http://SERVER-PC', 'https://evil.example.com']) {
      const r = await call(port, 'GET', { Origin: o, 'X-Forwarded-Host': '192.168.1.20:8443', 'X-Forwarded-Proto': 'https' });
      assert.equal(r.status, 403, o); assert.equal(r.headers['access-control-allow-origin'], undefined);
    }
  } finally { s.close(); }
});

test('index.js wires BOTH express and socket.io to the shared policy (no inline permissive checker)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.js'), 'utf8');
  assert.match(src, /createCorsOriginCheck\(\{ authEnabled: AUTH_ENABLED/);
  assert.match(src, /cors: \{ origin: corsOriginCheck, methods: \['GET', 'POST'\], credentials: true \}/);
  assert.match(src, /app\.use\(cors\(\{ origin: corsOriginCheck, credentials: true \}\)\)/);
  assert.doesNotMatch(src, /isPrivateLanOrigin|origin:\s*true|origin:\s*['"]\*['"]/);
});
