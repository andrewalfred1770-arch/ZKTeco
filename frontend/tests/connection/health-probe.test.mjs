/**
 * Connection test over http AND https (isolated: loopback servers on ephemeral ports, throw-away test CA; no database, no ZKTeco device,
 * no Electron, no production server).
 *
 * Bug: Node's http module cannot open https:// URLs (ERR_INVALID_PROTOCOL), so "Test Connection" against https://192.168.1.145 always failed.
 * Fix under test (electron/healthProbe.js): the transport follows the URL scheme; https uses a transport that verifies the certificate in
 * FULL (in the app: Electron's net = Windows trust store). Here Node's https client stands in for that transport - it also verifies fully,
 * and trusting the test CA models "the CA is installed in Windows".
 * Run:  node --test tests/connection/health-probe.test.mjs     (from frontend/)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = path.resolve(here, '..', '..', 'electron');
const P = await import(pathToFileURL(path.join(ELECTRON_DIR, 'healthProbe.js')).href);
const read = (f) => fs.readFileSync(path.join(ELECTRON_DIR, f), 'utf8');

const HEALTH = { status: 'ok', db: 'connected', ready: true, version: '9.9.9', apiVersion: 1, authEnabled: false };
const ENGINE_OPEN = '0{"sid":"abc123","upgrades":["websocket"],"pingInterval":25000,"pingTimeout":20000}';
function handler(req, res) {
  if (req.url.startsWith('/api/health')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(HEALTH)); return; }
  if (req.url.startsWith('/socket.io/')) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(ENGINE_OPEN); return; }
  res.writeHead(404); res.end('nope');
}
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const close = (server) => new Promise((r) => server.close(() => r()));

// ── test PKI (OpenSSL from Git for Windows or PATH; the TLS tests are skipped when none is available) ──────────────────────────
const OPENSSL = ['C:/Program Files/Git/usr/bin/openssl.exe', 'C:/Program Files (x86)/Git/usr/bin/openssl.exe', 'openssl']
  .find((c) => { try { return spawnSync(c, ['version']).status === 0; } catch { return false; } });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-tls-test-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const ssl = (...a) => { const r = spawnSync(OPENSSL, a, { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, `openssl ${a[0]} failed: ${r.stderr}`); };
const f = (n) => path.join(dir, n);
function makePki() {
  ssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', '/CN=Test CA', '-days', '2',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign');
  const leaf = (name, san, extra) => {
    ssl('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', `${name}.key`);
    ssl('req', '-new', '-key', `${name}.key`, '-subj', '/CN=test', '-out', `${name}.csr`);
    fs.writeFileSync(f(`${name}.ext`), `subjectAltName = ${san}\nextendedKeyUsage = serverAuth\nbasicConstraints = CA:FALSE\n`);
    ssl('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-sha256', '-extfile', `${name}.ext`, '-out', `${name}.crt`, ...extra);
  };
  leaf('good', 'IP:127.0.0.1', ['-days', '2']);
  leaf('wrongname', 'IP:10.9.9.9', ['-days', '2']);
  leaf('expired', 'IP:127.0.0.1', ['-not_before', '20200101000000Z', '-not_after', '20200102000000Z']);
}
if (OPENSSL) makePki();
const tlsTest = (name, fn) => test(name, { skip: OPENSSL ? false : 'no OpenSSL available' }, fn);
const startTls = async (leaf) => {
  const server = https.createServer({ key: fs.readFileSync(f(`${leaf}.key`)), cert: fs.readFileSync(f(`${leaf}.crt`)) }, handler);
  const port = await listen(server); return { server, base: `https://127.0.0.1:${port}` };
};
/** Stand-in for Electron's net: a FULLY verifying https client. `ca` = what the machine trusts (the Windows store, in the app). */
const verifyingGet = (ca) => (url, timeoutMs) => new Promise((resolve, reject) => {
  const req = https.get(url, ca ? { ca: fs.readFileSync(ca) } : {}, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
  req.on('error', reject); req.setTimeout(timeoutMs, () => { req.destroy(); reject(Object.assign(new Error('timeout'), { code: 'PROBE_TIMEOUT' })); });
});

// ───────────── scheme selection ─────────────
test('P1. the transport follows the URL scheme', () => {
  assert.equal(P.pickClient('http://192.168.1.145:5000'), 'http');
  assert.equal(P.pickClient('https://192.168.1.145'), 'https');
  assert.equal(P.pickClient('ftp://x'), null);
  assert.equal(P.pickClient('not a url'), null);
  assert.equal(P.pickClient(''), null);
});

// ───────────── http (behaviour unchanged) ─────────────
test('H1. http: health 200 + JSON is ok and parsed', async () => {
  const s = http.createServer(handler); const port = await listen(s);
  try { const r = await P.fetchHealth(`http://127.0.0.1:${port}`, 3000); assert.equal(r.ok, true); assert.equal(r.status, 200); assert.deepEqual(r.body, HEALTH); } finally { await close(s); }
});
test('H2. http: a non-200 or non-JSON answer is not ok, and does not throw', async () => {
  const s = http.createServer((q, r) => { if (q.url.startsWith('/api/health')) { r.writeHead(503); r.end('{"status":"starting"}'); } }); const port = await listen(s);
  const s2 = http.createServer((q, r) => { r.writeHead(200); r.end('<html>not json</html>'); }); const port2 = await listen(s2);
  try {
    const a = await P.fetchHealth(`http://127.0.0.1:${port}`, 3000); assert.equal(a.ok, false); assert.equal(a.status, 503);
    const b = await P.fetchHealth(`http://127.0.0.1:${port2}`, 3000); assert.equal(b.ok, false); assert.equal(b.body, null); assert.equal(b.status, 200);
  } finally { await close(s); await close(s2); }
});
test('H3. http: connection refused and timeout are reported as before (error text, never thrown)', async () => {
  const s = http.createServer(); const port = await listen(s); await close(s);                  // a port nobody listens on
  const a = await P.fetchHealth(`http://127.0.0.1:${port}`, 2000); assert.equal(a.ok, false); assert.match(a.error, /ECONNREFUSED/); assert.equal(a.errorCode, null);
  const hang = http.createServer(() => { /* never answers */ }); const hp = await listen(hang);
  try { const b = await P.fetchHealth(`http://127.0.0.1:${hp}`, 300); assert.equal(b.ok, false); assert.equal(b.error, 'timeout'); } finally { hang.closeAllConnections?.(); await close(hang); }
});
test('H4. an unusable URL is a clean error result (the old code threw ERR_INVALID_PROTOCOL for https)', async () => {
  const r = await P.fetchHealth('ftp://example.invalid', 500); assert.equal(r.ok, false); assert.match(r.error, /http:\/\/ or https:\/\//);
  const s = await P.fetchHealth('not-a-url', 500); assert.equal(s.ok, false);
});

// ───────────── https: the case that used to fail ─────────────
test('S0. https no longer goes through Node http: the https transport is used (and http is not)', async () => {
  let httpsCalls = 0; let httpCalls = 0;
  const r = await P.fetchHealth('https://192.168.1.145', 1000, {
    httpsGet: async (url) => { httpsCalls++; assert.equal(url, 'https://192.168.1.145/api/health'); return { status: 200, body: JSON.stringify(HEALTH) }; },
    httpGet: async () => { httpCalls++; throw new Error('http transport must not be used for https'); },
  });
  assert.equal(r.ok, true); assert.equal(httpsCalls, 1); assert.equal(httpCalls, 0);
  const h = await P.fetchHealth('http://192.168.1.145:5000', 1000, { httpGet: async () => { httpCalls++; return { status: 200, body: JSON.stringify(HEALTH) }; }, httpsGet: async () => { throw new Error('no'); } });
  assert.equal(h.ok, true); assert.equal(httpCalls, 1);
});
tlsTest('S1. https with a TRUSTED CA (model: CA installed in Windows): health is ok, certificate fully verified', async () => {
  const { server, base } = await startTls('good');
  try { const r = await P.fetchHealth(base, 3000, { httpsGet: verifyingGet(f('ca.crt')) }); assert.equal(r.ok, true); assert.deepEqual(r.body, HEALTH); } finally { await close(server); }
});
tlsTest('S2. https with an UNTRUSTED CA is refused with a specific, readable error (never waived)', async () => {
  const { server, base } = await startTls('good');
  try {
    const r = await P.fetchHealth(base, 3000, { httpsGet: verifyingGet(null) });
    assert.equal(r.ok, false); assert.equal(r.errorCode, 'CERT_UNTRUSTED'); assert.match(r.error, /غير موثوقة/); assert.match(r.error, /Trusted Root/);
    assert.ok(r.errorDetail && r.errorDetail.length > 0, 'the raw reason is kept for the log');
  } finally { await close(server); }
});
tlsTest('S3. a certificate for ANOTHER address is refused (name mismatch)', async () => {
  const { server, base } = await startTls('wrongname');
  try { const r = await P.fetchHealth(base, 3000, { httpsGet: verifyingGet(f('ca.crt')) }); assert.equal(r.ok, false); assert.equal(r.errorCode, 'CERT_NAME_MISMATCH'); assert.match(r.error, /لا تطابق العنوان/); } finally { await close(server); }
});
tlsTest('S4. an EXPIRED certificate is refused', async () => {
  const { server, base } = await startTls('expired');
  try { const r = await P.fetchHealth(base, 3000, { httpsGet: verifyingGet(f('ca.crt')) }); assert.equal(r.ok, false); assert.equal(r.errorCode, 'CERT_EXPIRED'); assert.match(r.error, /منتهية/); } finally { await close(server); }
});
test('S5. Electron-style (Chromium) certificate errors map to the same readable errors; other errors keep their text', () => {
  const m = (msg) => P.describeError(new Error(msg));
  assert.equal(m('net::ERR_CERT_AUTHORITY_INVALID').errorCode, 'CERT_UNTRUSTED');
  assert.equal(m('net::ERR_CERT_COMMON_NAME_INVALID').errorCode, 'CERT_NAME_MISMATCH');
  assert.equal(m('net::ERR_CERT_DATE_INVALID').errorCode, 'CERT_EXPIRED');
  assert.equal(m('net::ERR_CERT_REVOKED').errorCode, 'CERT_REVOKED');
  assert.equal(m('net::ERR_SSL_PROTOCOL_ERROR').errorCode, 'TLS_ERROR');
  const refused = m('net::ERR_CONNECTION_REFUSED'); assert.equal(refused.errorCode, null); assert.equal(refused.error, 'net::ERR_CONNECTION_REFUSED');
  const timedOut = m('net::ERR_TIMED_OUT'); assert.equal(timedOut.errorCode, null);
  assert.equal(P.describeError({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: 'unable to verify the first certificate' }).errorCode, 'CERT_UNTRUSTED');
  assert.equal(P.describeError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID', message: 'Hostname/IP does not match certificate\'s altnames' }).errorCode, 'CERT_NAME_MISMATCH');
  assert.equal(P.describeError({ code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' }).errorCode, 'CERT_EXPIRED');
});

// ───────────── Socket.IO reachability over https ─────────────
test('K1. https socket probe: the Engine.IO handshake means connected, or auth_required when the server needs a login', async () => {
  const ok = { httpsGet: async (url) => { assert.match(url, /\/socket\.io\/\?EIO=4&transport=polling$/); return { status: 200, body: ENGINE_OPEN }; } };
  assert.deepEqual(await P.probeSocketHandshake('https://x', 1000, { ok: true, body: { authEnabled: false } }, ok), { status: 'connected', detail: null });
  assert.equal((await P.probeSocketHandshake('https://x', 1000, { ok: true, body: { authEnabled: true } }, ok)).status, 'auth_required');
  assert.equal((await P.probeSocketHandshake('https://x', 1000, null, ok)).status, 'connected');
});
test('K2. https socket probe: wrong answers and errors are classified, TLS problems are readable', async () => {
  const one = (get) => P.probeSocketHandshake('https://x', 500, null, { httpsGet: get });
  assert.equal((await one(async () => ({ status: 403, body: 'Forbidden' }))).status, 'transport_error');
  assert.equal((await one(async () => ({ status: 200, body: '<html>' }))).status, 'network_error');
  const tls = await one(async () => { throw new Error('net::ERR_CERT_AUTHORITY_INVALID'); });
  assert.equal(tls.status, 'transport_error'); assert.match(tls.detail, /غير موثوقة/);
  assert.equal((await one(async () => { throw Object.assign(new Error('timeout'), { code: 'PROBE_TIMEOUT' }); })).status, 'timeout');
  assert.equal((await one(async () => { throw new Error('connect ECONNREFUSED 192.168.1.145:443'); })).status, 'connection_refused');
});
tlsTest('K3. https socket probe against a real TLS server: trusted CA connects, untrusted CA is refused', async () => {
  const { server, base } = await startTls('good');
  try {
    assert.equal((await P.probeSocketHandshake(base, 3000, null, { httpsGet: verifyingGet(f('ca.crt')) })).status, 'connected');
    const bad = await P.probeSocketHandshake(base, 3000, null, { httpsGet: verifyingGet(null) });
    assert.equal(bad.status, 'transport_error'); assert.match(bad.detail, /غير موثوقة/);
  } finally { await close(server); }
});

// ───────────── no security bypass, wiring ─────────────
test('G1. no certificate bypass exists in the connection code (full verification is kept)', () => {
  for (const file of ['healthProbe.js', 'backend.js', 'ipc.js', 'lifecycle.js', 'windows.js', 'security.js']) {
    const t = read(file);
    assert.doesNotMatch(t, /rejectUnauthorized\s*:\s*false/, `${file}: rejectUnauthorized:false`);
    assert.doesNotMatch(t, /NODE_TLS_REJECT_UNAUTHORIZED/, `${file}: NODE_TLS_REJECT_UNAUTHORIZED`);
    assert.doesNotMatch(t, /certificate-error|ignore-certificate-errors|ignoreCertificateErrors|setCertificateVerifyProc/, `${file}: certificate override`);
  }
});
test('G2. the app uses Electron net (Windows trust store) for https; electron is imported lazily so the module is testable', () => {
  const t = read('healthProbe.js');
  assert.match(t, /await import\('electron'\)/);
  assert.match(t, /net\.request\(\{ method: 'GET', url \}\)/);
  assert.doesNotMatch(t, /^import .* from 'electron'/m);
});
test('G3. wiring: backend.fetchHealth delegates to the probe; the connection:test handler passes the health answer to the socket probe', () => {
  const b = read('backend.js');
  assert.match(b, /import \{ fetchHealth as probeHealth, fetchStartupStatus as probeStartupStatus \} from '\.\/healthProbe\.js'/);
  assert.match(b, /return probeHealth\(baseUrl, timeoutMs\)/);
  assert.doesNotMatch(b, /http\.get\(`\$\{baseUrl\}\/api\/health`/, 'the http-only health request is gone');
  const i = read('ipc.js');
  assert.match(i, /import \{ probeSocketHandshake \} from '\.\/healthProbe\.js'/);
  assert.match(i, /if \(\/\^https:\/i\.test\(baseUrl\)\) return probeSocketHandshake\(baseUrl, timeoutMs, health\)/);
  assert.match(i, /testSocketReachable\(baseUrl, 8000, health\)/);
  assert.match(i, /socketIOClient\(baseUrl, \{ transports: \['polling', 'websocket'\], reconnection: false/, 'the http socket.io-client probe is unchanged');
});

// ───────────── startup status (Server Mode splash / readiness poll) ─────────────
const STATUS = { dbConnected: true, servicesStarted: true, ready: true };
test('T1. startup-status over http: parsed JSON; over https: uses the https transport, never Node http', async () => {
  const s = http.createServer((q, r) => { if (q.url.startsWith('/api/startup-status')) { r.writeHead(200); r.end(JSON.stringify(STATUS)); } else { r.writeHead(404); r.end(); } });
  const port = await listen(s);
  try { assert.deepEqual(await P.fetchStartupStatus(`http://127.0.0.1:${port}`, 2000), STATUS); } finally { await close(s); }
  let httpsCalls = 0; let httpCalls = 0;
  const r = await P.fetchStartupStatus('https://192.168.1.145', 500, {
    httpsGet: async (url) => { httpsCalls++; assert.equal(url, 'https://192.168.1.145/api/startup-status'); return { status: 200, body: JSON.stringify(STATUS) }; },
    httpGet: async () => { httpCalls++; throw new Error('http transport must not be used for https'); },
  });
  assert.deepEqual(r, STATUS); assert.equal(httpsCalls, 1); assert.equal(httpCalls, 0);
});
test('T2. startup-status never throws: refused, timeout, non-JSON, unusable URL and certificate errors all give null (as before)', async () => {
  const dead = http.createServer(); const dp = await listen(dead); await close(dead);
  assert.equal(await P.fetchStartupStatus(`http://127.0.0.1:${dp}`, 1000), null);
  const hang = http.createServer(() => {}); const hp = await listen(hang);
  try { assert.equal(await P.fetchStartupStatus(`http://127.0.0.1:${hp}`, 200), null); } finally { hang.closeAllConnections?.(); await close(hang); }
  const html = http.createServer((q, r) => { r.writeHead(200); r.end('<html>'); }); const hpt = await listen(html);
  try { assert.equal(await P.fetchStartupStatus(`http://127.0.0.1:${hpt}`, 1000), null); } finally { await close(html); }
  assert.equal(await P.fetchStartupStatus('ftp://x', 100), null);
  assert.equal(await P.fetchStartupStatus('not a url', 100), null);
  for (const msg of ['net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_CERT_COMMON_NAME_INVALID', 'net::ERR_CERT_DATE_INVALID']) {
    assert.equal(await P.fetchStartupStatus('https://x', 100, { httpsGet: async () => { throw new Error(msg); } }), null, msg);
  }
});
tlsTest('T3. startup-status over real TLS: trusted CA gives the status; untrusted CA / wrong name / expired certificate give null (nothing is waived)', async () => {
  const good = await startTls('good');
  try {
    assert.equal(good.server.listening, true);
    good.server.removeAllListeners('request');
    good.server.on('request', (q, r) => { r.writeHead(200); r.end(JSON.stringify(STATUS)); });
    assert.deepEqual(await P.fetchStartupStatus(good.base, 3000, { httpsGet: verifyingGet(f('ca.crt')) }), STATUS);
    assert.equal(await P.fetchStartupStatus(good.base, 3000, { httpsGet: verifyingGet(null) }), null, 'untrusted CA');
  } finally { await close(good.server); }
  for (const leaf of ['wrongname', 'expired']) {
    const t = await startTls(leaf);
    try { t.server.removeAllListeners('request'); t.server.on('request', (q, r) => { r.writeHead(200); r.end(JSON.stringify(STATUS)); });
      assert.equal(await P.fetchStartupStatus(t.base, 3000, { httpsGet: verifyingGet(f('ca.crt')) }), null, leaf); } finally { await close(t.server); }
  }
});
test('T4. wiring: backend.fetchStartupStatus keeps its signature and delegates; the old http-only request and the http import are gone; callers unchanged', () => {
  const b = read('backend.js');
  assert.match(b, /import \{ fetchHealth as probeHealth, fetchStartupStatus as probeStartupStatus \} from '\.\/healthProbe\.js'/);
  assert.match(b, /export function fetchStartupStatus\(timeoutMs = 400, baseUrl = `http:\/\/localhost:\$\{BACKEND_PORT\}`\) \{\s*\r?\n\s*return probeStartupStatus\(baseUrl, timeoutMs\);/);
  assert.doesNotMatch(b, /http\.get\(/, 'no http-only request is left in backend.js');
  assert.doesNotMatch(b, /^import http from 'http';/m);
  const l = read('lifecycle.js');
  assert.equal((l.match(/fetchStartupStatus\(statusTimeoutMs\(\), state\.backendBaseUrl\)/g) || []).length, 2, 'both lifecycle call sites are untouched');
});
