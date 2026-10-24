/**
 * LAN "no login" mode — allowlisted devices behind the local HTTPS proxy (isolated: no database, no real .env, no devices, no MySQL).
 *
 * Covers: allowlist parsing, the start-up policy (desktop untouched, fail closed), the per-request decision (allowed / denied, forged
 * forwarding headers, arbitrary loopback callers, direct backend access), a real Express app + Engine.IO server behind the gate, CORS,
 * audit attribution (a device, never a claimed person) and the device-operation guard on a SKIP_SCHEDULER instance.
 * Run:  node --test tests/consistency/client-allowlist.test.js      (from backend/)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

const SRC = path.resolve(__dirname, '..', '..', 'src');
const sec = require(path.join(SRC, 'config', 'securityConfig.js'));
const { evaluateClient, createClientGate, createEngineAllowRequest } = require(path.join(SRC, 'middleware', 'clientAllowlist.js'));
const { createCorsOriginCheck } = require(path.join(SRC, 'config', 'corsPolicy.js'));
const { resolveActor, hasServerIdentity } = require(path.join(SRC, 'utils', 'auditActor.js'));

const KEY = 'k'.repeat(10) + 'A1_-'.repeat(10);                       // 50 chars, valid shape; never a real secret
const LIST = '192.168.1.50   # Ahmed phone\n192.168.1.51\n# 192.168.1.99  (commented out)\n';
const quiet = { warn() {}, error() {}, info() {} };

const lanPolicy = (over = {}) => sec.resolveLanClientPolicy({
  authEnabled: false, trustProxyValue: 'loopback', host: '127.0.0.1', allowedText: LIST, proxyKey: KEY, skipScheduler: true, ...over,
});

// ── A. allowlist parsing ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('A1. parse: exact private host addresses with optional label; comments and blanks ignored', () => {
  const r = sec.parseAllowedClients(LIST);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.entries.map((e) => [e.cidr, e.label]), [['192.168.1.50/32', 'Ahmed phone'], ['192.168.1.51/32', '']]);
});

test('A1b. parse: a UTF-8 byte-order mark (Notepad / PowerShell -Encoding UTF8) and CRLF line endings do not break a valid list', () => {
  const r = sec.parseAllowedClients('﻿192.168.1.50   # Ahmed phone\r\n192.168.1.51\r\n');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.entries.map((e) => e.ip), ['192.168.1.50', '192.168.1.51']);
});

test('A2. parse: only private hosts and networks no broader than /24 are accepted; everything else is refused', () => {
  const bad = ['0.0.0.0', '255.255.255.255', '127.0.0.1', '8.8.8.8', '169.254.1.5', '192.168.1.0', '192.168.1.255', '192.168.1.*',
    '192.168.1.1-20', '192.168.01.5', '192.168.1', '192.168.1.256', '::1', 'fe80::1', '10.0.0.0/8', 'phone.local', '172.32.0.5', '192.169.1.5',
    // networks: too broad, public, misaligned, malformed prefixes
    '192.168.0.0/16', '192.168.0.0/23', '10.0.0.0/16', '172.16.0.0/12', '0.0.0.0/0', '192.168.1.0/0', '8.8.8.0/24', '127.0.0.0/24', '169.254.1.0/24',
    '192.168.1.5/24', '192.168.1.1/24', '192.168.1.128/24', '192.168.1.0/25x', '192.168.1.0/33', '192.168.1.0/024', '192.168.1.0/-1', '192.168.1.0/', '192.168.1.0 /24',
    '192.168.1.0/255.255.255.0', '172.32.0.0/24', '192.169.1.0/24', '192.168.1.0/24/24', '2001:db8::/32'];
  for (const b of bad) assert.ok(sec.parseAllowedClients(b).errors.length > 0, `${b} must be rejected`);
  for (const g of ['10.1.2.3', '172.16.0.9', '172.31.255.254', '192.168.100.7', '192.168.1.0/24', '192.168.1.0/25', '192.168.1.128/25', '10.20.30.0/24', '172.16.5.0/24',
    '172.31.255.0/24', '192.168.255.0/24', '192.168.1.64/26', '192.168.1.50/32']) assert.deepEqual(sec.parseAllowedClients(g).errors, [], g);
});

test('A2b. parse: the trusted-network rules in detail (/24 floor, alignment, overlap, labels)', () => {
  const ok = sec.parseAllowedClients('192.168.1.0/24   # Office Wi-Fi\n');
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.entries.map((e) => [e.cidr, e.label, e.size]), [['192.168.1.0/24', 'Office Wi-Fi', 256]]);
  assert.equal(sec.MIN_PREFIX, 24);
  const msg = (t) => sec.parseAllowedClients(t).errors.join(' | ');
  assert.match(msg('192.168.0.0/16'), /broader than \/24/);
  assert.match(msg('192.168.1.5/24'), /host bits set - write the network address \(192\.168\.1\.0\/24\)/);
  assert.match(msg('8.8.8.0/24'), /not a private LAN address/);
  // overlap / duplicates, in either order; a host inside a listed network is redundant => error (list each thing once)
  assert.match(msg('192.168.1.0/24\n192.168.1.50'), /overlaps 192\.168\.1\.0\/24/);
  assert.match(msg('192.168.1.50\n192.168.1.0/24'), /overlaps 192\.168\.1\.50\/32/);
  assert.match(msg('192.168.1.0/25\n192.168.1.64/26'), /overlaps/);
  assert.match(msg('192.168.1.0/24\n192.168.1.0/24'), /overlaps/);
  assert.deepEqual(sec.parseAllowedClients('192.168.1.0/25\n192.168.1.128/25\n192.168.2.0/24').errors, [], 'adjacent, non-overlapping networks are fine');
  assert.deepEqual(sec.parseAllowedClients('192.168.1.0/24\n10.0.0.0/24\n172.16.0.0/24').entries.length, 3);
});

test('A2c. membership: the edges of a /24, a /25 and a single host; one address outside is never inside', () => {
  const E = (t) => sec.parseAllowedClients(t).entries[0];
  const n24 = E('192.168.1.0/24');
  for (const ip of ['192.168.1.1', '192.168.1.57', '192.168.1.145', '192.168.1.254', '192.168.1.0', '192.168.1.255']) assert.equal(sec.entryContains(n24, ip), true, ip);
  for (const ip of ['192.168.0.255', '192.168.2.0', '192.168.2.1', '192.167.1.1', '193.168.1.1', '10.0.0.1', '127.0.0.1', '8.8.8.8', '192.168.1.1.1', '192.168.1', '', 'abc']) assert.equal(sec.entryContains(n24, ip), false, ip);
  const n25 = E('192.168.1.128/25');
  assert.equal(sec.entryContains(n25, '192.168.1.128'), true); assert.equal(sec.entryContains(n25, '192.168.1.255'), true);
  assert.equal(sec.entryContains(n25, '192.168.1.127'), false); assert.equal(sec.entryContains(n25, '192.168.1.1'), false);
  const h = E('10.1.2.3'); assert.equal(sec.entryContains(h, '10.1.2.3'), true); assert.equal(sec.entryContains(h, '10.1.2.4'), false);
  const p10 = E('10.20.30.0/24'); assert.equal(sec.entryContains(p10, '10.20.30.200'), true); assert.equal(sec.entryContains(p10, '10.20.31.1'), false);
});

test('A3. parse: duplicates, bad labels and absurd sizes are errors (the backend refuses to start on any error)', () => {
  assert.ok(sec.parseAllowedClients('192.168.1.5\n192.168.1.5').errors.length);
  assert.ok(sec.parseAllowedClients('192.168.1.5 # <script>').errors.length);
  assert.ok(sec.parseAllowedClients(`192.168.1.5 # ${'x'.repeat(41)}`).errors.length);
  const many = Array.from({ length: 65 }, (_, i) => `10.0.${Math.floor(i / 200)}.${(i % 200) + 1}`).join('\n');
  assert.ok(sec.parseAllowedClients(many).errors.some((e) => /more than/.test(e)));
});

// ── B. start-up policy ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('B1. desktop is untouched: auth off WITHOUT TRUST_PROXY → mode "desktop", no allowlist, no proxy key needed', () => {
  const r = sec.resolveLanClientPolicy({ authEnabled: false, trustProxyValue: false, host: '127.0.0.1', skipScheduler: false });
  assert.equal(r.ok, true); assert.equal(r.mode, 'desktop'); assert.equal(r.allowed.length, 0);
  const r2 = sec.resolveLanClientPolicy({ authEnabled: false, trustProxyValue: false, host: '127.0.0.1', allowedText: LIST, proxyKey: KEY, skipScheduler: true });
  assert.equal(r2.mode, 'desktop', 'an allowlist alone never switches the desktop backend into LAN mode');
});

test('B2. login-protected LAN backend is untouched: AUTH_ENABLED=true → mode "authenticated" (allowlist ignored)', () => {
  const r = sec.resolveLanClientPolicy({ authEnabled: true, trustProxyValue: 'loopback', host: '127.0.0.1', skipScheduler: true });
  assert.equal(r.ok, true); assert.equal(r.mode, 'authenticated');
});

test('B3. LAN no-login mode requires EVERYTHING and fails closed otherwise', () => {
  assert.equal(lanPolicy().ok, true);
  assert.equal(lanPolicy().mode, 'lan-nologin');
  const fails = [
    ['no proxy key', { proxyKey: undefined }], ['short proxy key', { proxyKey: 'short' }], ['no allowlist file', { allowedText: null }],
    ['unreadable file', { allowedText: null, allowedFileError: 'ENOENT' }], ['empty list', { allowedText: '# nobody\n' }],
    ['invalid entry', { allowedText: '192.168.1.0/20' }], ['network broader than /24', { allowedText: '192.168.0.0/16' }], ['misaligned network', { allowedText: '192.168.1.5/24' }], ['scheduler owner', { skipScheduler: false }], ['non-loopback bind', { host: '0.0.0.0' }],
  ];
  for (const [name, over] of fails) { const r = lanPolicy(over); assert.equal(r.ok, false, name); assert.equal(r.error.code, 'UNSAFE_LAN_NOLOGIN', name); }
});

// ── C. per-request decision (pure) ──────────────────────────────────────────────────────────────────────────────────────────────────
const P = () => lanPolicy();
const req = (over = {}) => ({ peer: '127.0.0.1', xff: '192.168.1.50', key: KEY, method: 'GET', path: '/api/employees', ...over });

test('C1. allowed device through the proxy → served, identified as that DEVICE', () => {
  const d = evaluateClient(req(), P());
  assert.equal(d.ok, true); assert.deepEqual(d.client, { ip: '192.168.1.50', label: 'Ahmed phone', network: '192.168.1.50/32' });
  assert.equal(evaluateClient(req({ xff: '192.168.1.51', peer: '::ffff:127.0.0.1' }), P()).ok, true, 'IPv4-mapped loopback peer');
});

test('C2. a device that is not on the list is denied', () => {
  for (const ip of ['192.168.1.52', '192.168.1.145', '10.0.0.5', '8.8.8.8']) assert.equal(evaluateClient(req({ xff: ip }), P()).reason, 'client-not-allowlisted', ip);
});

test('C3. arbitrary LOOPBACK callers are not trusted: no key → denied, even with a forged allowlisted X-Forwarded-For', () => {
  assert.equal(evaluateClient(req({ key: undefined }), P()).reason, 'missing-or-invalid-proxy-identity');
  assert.equal(evaluateClient(req({ key: 'wrong' + KEY }), P()).reason, 'missing-or-invalid-proxy-identity');
  assert.equal(evaluateClient(req({ key: '' }), P()).reason, 'missing-or-invalid-proxy-identity');
  assert.equal(evaluateClient(req({ key: [KEY, KEY] }), P()).reason, 'missing-or-invalid-proxy-identity', 'duplicated key header');
  assert.equal(evaluateClient(req({ xff: undefined, key: undefined }), P()).ok, false, 'no proxy identity at all');
});

test('C4. forged / malformed forwarding is denied: chains, empty, non-IPv4, hostnames; a valid key does not help', () => {
  for (const xff of ['192.168.1.50, 192.168.1.51', '8.8.8.8, 192.168.1.50', '', undefined, 'localhost', '192.168.1.50:80', '::1', 'abc', '192.168.1.0/24', '127.0.0.1']) {
    assert.equal(evaluateClient(req({ xff }), P()).ok, false, `xff=${JSON.stringify(xff)}`);
  }
  assert.equal(evaluateClient(req({ xff: ['192.168.1.50', '192.168.1.51'] }), P()).ok, false, 'two XFF header lines');
});

test('C5. direct backend access from a non-loopback peer is denied (defence in depth behind the loopback bind)', () => {
  for (const peer of ['192.168.1.77', '10.0.0.4', '192.168.1.145', undefined, '']) assert.equal(evaluateClient(req({ peer }), P()).reason, 'peer-not-loopback', String(peer));
});

test('C6. the ONLY exemption is the local readiness probe: GET /api/health from loopback without any proxy headers', () => {
  assert.equal(evaluateClient(req({ xff: undefined, key: undefined, path: '/api/health' }), P()).reason, 'local-health');
  for (const over of [{ method: 'POST' }, { path: '/api/employees' }, { path: '/api/health/x' }, { path: '/api/healthz' }, { xff: '8.8.8.8' }, { key: 'bad' }]) {
    assert.equal(evaluateClient(req({ xff: undefined, key: undefined, path: '/api/health', ...over }), P()).ok, false, JSON.stringify(over));
  }
});

// ── D. real Express app + Engine.IO server behind the gate ──────────────────────────────────────────────────────────────────────────
const call = (port, { method = 'GET', pathName = '/', headers = {}, body } = {}) => new Promise((resolve) => {
  const h = { ...headers }; let data;
  if (body !== undefined) { data = JSON.stringify(body); h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(data); }
  const r = http.request({ host: '127.0.0.1', port, method, path: pathName, headers: h }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
  r.on('error', (e) => resolve({ error: e.code })); if (data) r.write(data); r.end();
});
const viaProxy = (ip, extra = {}) => ({ 'x-forwarded-for': ip, 'x-checkin-proxy-key': KEY, ...extra });

test('D. live: Express + Socket.IO behind the gate (allowed, denied, forged headers, key never leaks, CORS, audit)', async () => {
  const express = require('express'); const cors = require('cors'); const { Server } = require('socket.io');
  const policy = P();
  const app = express(); app.set('trust proxy', 'loopback');
  app.use(createClientGate(policy, quiet));
  app.use(cors({ origin: createCorsOriginCheck({ authEnabled: false, allowList: ['https://192.168.1.145'], proxyNoLogin: true }), credentials: true }));
  app.use(express.json());
  app.get('/api/health', (_q, s) => s.json({ ok: true }));
  app.all('/api/echo', (q, s) => s.json({
    lan: q.lanClient || null, keyHeaderSeen: q.headers['x-checkin-proxy-key'] !== undefined,
    actor: resolveActor(q, { id: 99, name: 'Admin Boss', role: 'admin' }), serverIdentity: hasServerIdentity(q),
  }));
  const server = http.createServer(app);
  const io = new Server(server, { allowRequest: createEngineAllowRequest(policy, quiet) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    // allowed device
    let r = await call(port, { pathName: '/api/echo', headers: viaProxy('192.168.1.50') });
    assert.equal(r.status, 200); const j = JSON.parse(r.body);
    assert.deepEqual(j.lan, { ip: '192.168.1.50', label: 'Ahmed phone', network: '192.168.1.50/32' });
    assert.equal(j.keyHeaderSeen, false, 'the proxy key must be stripped before the app sees the request');
    // audit attribution: device, not the person the client claims to be
    r = await call(port, { method: 'POST', pathName: '/api/echo', headers: viaProxy('192.168.1.50'), body: { modifiedByName: 'Admin Boss', modifiedBy: 99, modifiedByRole: 'admin' } });
    const a = JSON.parse(r.body).actor;
    assert.equal(a.name, 'LAN device 192.168.1.50 (Ahmed phone)'); assert.equal(a.role, 'lan-device'); assert.equal(a.id, 0);
    assert.equal(JSON.parse(r.body).serverIdentity, true);
    // denied: not on list / no key / forged XFF from a local caller / chain
    assert.equal((await call(port, { pathName: '/api/echo', headers: viaProxy('192.168.1.52') })).status, 403);
    assert.equal((await call(port, { pathName: '/api/echo', headers: { 'x-forwarded-for': '192.168.1.50' } })).status, 403);
    assert.equal((await call(port, { pathName: '/api/echo' })).status, 403);
    assert.equal((await call(port, { pathName: '/api/echo', headers: viaProxy('192.168.1.50, 192.168.1.51') })).status, 403);
    assert.equal((await call(port, { pathName: '/api/echo', headers: viaProxy('192.168.1.50', { 'x-checkin-proxy-key': 'nope' }) })).status, 403);
    // a denied response carries no data
    assert.equal(JSON.parse((await call(port, { pathName: '/api/echo' })).body).error, 'Forbidden');
    // readiness probe only
    assert.equal((await call(port, { pathName: '/api/health' })).status, 200);
    assert.equal((await call(port, { pathName: '/api/health?x=1' })).status, 200);
    assert.equal((await call(port, { method: 'POST', pathName: '/api/health', body: {} })).status, 403);
    // CORS: only the exact proxy origin (allowed device)
    r = await call(port, { pathName: '/api/echo', headers: viaProxy('192.168.1.50', { origin: 'https://192.168.1.145' }) });
    assert.equal(r.headers['access-control-allow-origin'], 'https://192.168.1.145');
    for (const bad of ['https://evil.example', 'http://192.168.1.145', 'http://localhost:5100', 'http://127.0.0.1:5100', 'https://192.168.1.145:8443', 'null']) {
      r = await call(port, { method: 'POST', pathName: '/api/echo', headers: viaProxy('192.168.1.50', { origin: bad }), body: {} });
      assert.equal(r.status, 403, `origin ${bad}`); assert.equal(r.headers['access-control-allow-origin'], undefined, bad);
    }
    // Socket.IO / Engine.IO: no session for an unapproved or unidentified client; a session for an approved device
    const eio = (headers) => call(port, { pathName: '/socket.io/?EIO=4&transport=polling', headers });
    assert.equal((await eio({})).status, 403, 'no proxy identity');
    assert.equal((await eio({ 'x-forwarded-for': '192.168.1.50' })).status, 403, 'forged XFF without key');
    assert.equal((await eio(viaProxy('192.168.1.52'))).status, 403, 'not allowlisted');
    assert.equal((await eio(viaProxy('192.168.1.50, 10.0.0.1'))).status, 403, 'chain');
    r = await eio(viaProxy('192.168.1.50')); assert.equal(r.status, 200); assert.match(r.body, /"sid":"/);
  } finally { io.close(); await new Promise((r) => server.close(r)); }
});

// ── D2. trusted NETWORK (192.168.1.0/24): every device on it is served with no registration; nothing outside it is ──────────────────
test('D2. live: a trusted /24 serves any device inside it and refuses everything outside, through the same gate (headers, audit, CORS, Engine.IO)', async () => {
  const express = require('express'); const cors = require('cors'); const { Server } = require('socket.io');
  const policy = lanPolicy({ allowedText: '192.168.1.0/24   # Office Wi-Fi\n' });
  assert.equal(policy.ok, true); assert.deepEqual(policy.allowed.map((e) => e.cidr), ['192.168.1.0/24']);
  assert.match(policy.warnings[0], /192\.168\.1\.0\/24/); assert.match(policy.warnings[0], /256 addresses/);
  const app = express(); app.set('trust proxy', 'loopback');
  app.use(createClientGate(policy, quiet));
  app.use(cors({ origin: createCorsOriginCheck({ authEnabled: false, allowList: ['https://192.168.1.145'], proxyNoLogin: true }), credentials: true }));
  app.use(express.json());
  app.all('/api/echo', (q, s) => s.json({ lan: q.lanClient || null, actor: resolveActor(q, { id: 99, name: 'Admin Boss', role: 'admin' }) }));
  const server = http.createServer(app);
  const io = new Server(server, { allowRequest: createEngineAllowRequest(policy, quiet) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const echo = (ip, extra = {}, method = 'GET', body) => call(port, { method, pathName: '/api/echo', headers: viaProxy(ip, extra), body });
  try {
    // any device inside the network is served - nothing was registered for it
    for (const ip of ['192.168.1.1', '192.168.1.57', '192.168.1.145', '192.168.1.200', '192.168.1.254']) {
      const r = await echo(ip); assert.equal(r.status, 200, ip);
      assert.deepEqual(JSON.parse(r.body).lan, { ip, label: 'Office Wi-Fi', network: '192.168.1.0/24' });
    }
    // audit: the ADDRESS (+ network label), never the person the request claims to be
    const w = await echo('192.168.1.57', {}, 'POST', { modifiedByName: 'Admin Boss', modifiedBy: 99, modifiedByRole: 'admin' });
    const a = JSON.parse(w.body).actor; assert.equal(a.name, 'LAN device 192.168.1.57 (Office Wi-Fi)'); assert.equal(a.role, 'lan-device'); assert.equal(a.id, 0);
    // outside the network (neighbouring subnets, other private ranges, public, the broadcast-adjacent edge) is refused
    for (const ip of ['192.168.0.255', '192.168.2.1', '192.168.2.145', '192.168.11.57', '192.167.1.1', '10.0.0.5', '172.16.0.5', '8.8.8.8', '127.0.0.1']) {
      assert.equal((await echo(ip)).status, 403, ip);
    }
    // forged forwarding still cannot help: no key / wrong key / chains / a trusted address claimed by an outsider without the key
    assert.equal((await call(port, { pathName: '/api/echo', headers: { 'x-forwarded-for': '192.168.1.57' } })).status, 403);
    assert.equal((await call(port, { pathName: '/api/echo', headers: { 'x-forwarded-for': '192.168.1.57', 'x-checkin-proxy-key': 'nope' } })).status, 403);
    assert.equal((await echo('192.168.1.57, 192.168.2.9')).status, 403); assert.equal((await echo('192.168.2.9, 192.168.1.57')).status, 403);
    assert.equal((await echo('192.168.1.0/24')).status, 403, 'a CIDR string is not an address'); assert.equal((await echo('192.168.1.57 ')).status, 200, 'surrounding whitespace is trimmed, as Node does');
    assert.equal((await call(port, { pathName: '/api/echo' })).status, 403, 'direct, no identity');
    // CORS is unchanged: only the exact proxy origin
    let r = await echo('192.168.1.57', { origin: 'https://192.168.1.145' }); assert.equal(r.headers['access-control-allow-origin'], 'https://192.168.1.145');
    r = await echo('192.168.1.57', { origin: 'https://192.168.1.57' }, 'POST', {}); assert.equal(r.status, 403, 'another LAN host as a web origin is refused');
    // Engine.IO: sessions only inside the network
    const eio = (headers) => call(port, { pathName: '/socket.io/?EIO=4&transport=polling', headers });
    assert.equal((await eio(viaProxy('192.168.1.199'))).status, 200); assert.equal((await eio(viaProxy('192.168.9.199'))).status, 403); assert.equal((await eio({})).status, 403);
  } finally { io.close(); await new Promise((r) => server.close(r)); }
});

// ── E. audit attribution (no login, no server identity ⇒ unchanged desktop behaviour) ───────────────────────────────────────────────
test('E. resolveActor: LAN device wins over any claim; desktop keeps its app-sent label; a real login still wins', () => {
  const claim = { id: 7, name: 'Someone Else', role: 'admin' };
  assert.equal(resolveActor({ lanClient: { ip: '10.0.0.5', label: '' } }, claim).name, 'LAN device 10.0.0.5');
  assert.equal(resolveActor({ lanClient: { ip: '10.0.0.5', label: '' } }, claim).role, 'lan-device');
  assert.equal(resolveActor({}, claim).name, 'Someone Else', 'desktop (no identity): the label the app sends is kept — unchanged');
  assert.equal(hasServerIdentity({}), false); assert.equal(hasServerIdentity({ lanClient: {} }), true);
  assert.equal(resolveActor({ user: { id: 3, name: 'Real User', role: 'hr' }, lanClient: { ip: '10.0.0.5', label: '' } }, claim).name, 'Real User');
  const long = resolveActor({ lanClient: { ip: '10.0.0.5', label: 'x'.repeat(40) } }).name; assert.ok(long.length <= 100);
});

// ── F. CORS modes ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('F. CORS: desktop stays loopback-only; LAN no-login accepts only the exact proxy origin; login mode unchanged', () => {
  const run = (cfg, origin) => new Promise((res) => createCorsOriginCheck(cfg)(origin, (err, ok) => res(err ? 'deny' : ok ? 'allow' : 'deny')));
  return Promise.all([
    run({ authEnabled: false }, 'http://localhost:5000').then((v) => assert.equal(v, 'allow')),
    run({ authEnabled: false }, 'https://192.168.1.145').then((v) => assert.equal(v, 'deny', 'desktop must still reject LAN origins')),
    run({ authEnabled: false, allowList: ['https://192.168.1.145'], proxyNoLogin: false }, 'https://192.168.1.145').then((v) => assert.equal(v, 'deny')),
    run({ authEnabled: false, allowList: ['https://192.168.1.145'], proxyNoLogin: true }, 'https://192.168.1.145').then((v) => assert.equal(v, 'allow')),
    run({ authEnabled: false, allowList: ['https://192.168.1.145'], proxyNoLogin: true }, 'http://localhost:5000').then((v) => assert.equal(v, 'deny')),
    run({ authEnabled: false, allowList: [], proxyNoLogin: true }, undefined).then((v) => assert.equal(v, 'allow', 'no Origin header: not a browser request')),
    run({ authEnabled: true, allowList: ['https://192.168.1.145'] }, 'https://192.168.1.145').then((v) => assert.equal(v, 'allow')),
  ]);
});

// ── G. fail closed at process start (spawns the real entry point; temp config; dead DB port; exits before any database work) ──────
test('G. index.js refuses to start (exit 78) in LAN no-login mode with a missing key / list / scheduler guard', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-nologin-'));
  const allowed = path.join(tmp, 'allowed.txt'); fs.writeFileSync(allowed, '192.168.1.50 # test\n');
  const empty = path.join(tmp, 'empty.txt'); fs.writeFileSync(empty, '# nobody\n');
  const broad = path.join(tmp, 'broad.txt'); fs.writeFileSync(broad, '192.168.0.0/16\n');
  const misaligned = path.join(tmp, 'misaligned.txt'); fs.writeFileSync(misaligned, '192.168.1.5/24\n');
  const pub = path.join(tmp, 'pub.txt'); fs.writeFileSync(pub, '8.8.8.0/24\n');
  const base = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: tmp, TMP: tmp,
    DOTENV_CONFIG_PATH: path.join(tmp, 'x.env'), CONFIG_DIR: tmp,
    DATABASE_URL: 'mysql://nobody@127.0.0.1:1/none',            // dead port: even a bug cannot reach MySQL
    AUTH_ENABLED: 'false', TRUST_PROXY: 'loopback', HOST: '127.0.0.1', PORT: '5399', SKIP_SCHEDULER: 'true',
    PROXY_SHARED_SECRET: KEY, ALLOWED_CLIENT_IPS_FILE: allowed,
  };
  const run = (over) => spawnSync(process.execPath, [path.join(SRC, 'index.js')], { env: { ...base, ...over }, encoding: 'utf8', timeout: 20000 });
  const cases = [
    ['network broader than /24', { ALLOWED_CLIENT_IPS_FILE: broad }], ['misaligned network', { ALLOWED_CLIENT_IPS_FILE: misaligned }], ['public network', { ALLOWED_CLIENT_IPS_FILE: pub }],
    ['no proxy key', { PROXY_SHARED_SECRET: '' }], ['empty allowlist', { ALLOWED_CLIENT_IPS_FILE: empty }],
    ['missing file', { ALLOWED_CLIENT_IPS_FILE: path.join(tmp, 'nope.txt') }], ['no file configured', { ALLOWED_CLIENT_IPS_FILE: '' }],
    ['scheduler not skipped', { SKIP_SCHEDULER: 'false' }],
  ];
  for (const [name, over] of cases) {
    const r = run(over);
    assert.equal(r.status, 78, `${name}: exit ${r.status}\n${r.stderr}`);
    assert.match(String(r.stderr), /LAN no-login mode/, name);
    assert.doesNotMatch(String(r.stderr) + String(r.stdout), new RegExp(KEY), 'the proxy key must never be printed');
  }
});
