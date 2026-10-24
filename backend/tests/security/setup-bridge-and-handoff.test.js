/**
 * F-1 (IPC request path), F-3 (adopted backend), F-4 (hand-off acknowledgement), stdin protocol, F-2 (legacy Mac bundle guard).
 * Isolated: an injected fake `http.request` and fake timers — no HTTP listener, no child process, no Electron, no database, no device.
 * Run:  node --test tests/security/setup-bridge-and-handoff.test.js      (from backend/)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');
const auth = require('../../src/utils/setupAuth');
const { createStdinCommandParser } = require('../../src/utils/stdinCommands');

const ROOT = path.join(__dirname, '..', '..', '..');
const imp = (...p) => import(pathToFileURL(path.join(ROOT, ...p)).href);
let sa; let bridge; let mojave;
test.before(async () => {
  sa = await imp('frontend', 'electron', 'setupAuth.js');
  bridge = await imp('frontend', 'electron', 'setupBridge.js');
  mojave = await imp('frontend', 'scripts', 'mojave-bundle-check.mjs');
});
test.beforeEach(() => { auth._resetForTests(); sa.clearLaunchSecret(); });

const noop = () => {};
/** A launched, acknowledged backend: Electron side + backend side share one secret. */
function readyLaunch() {
  const secret = sa.createLaunchSecret();
  let out = '';
  auth.handleStdinLine(sa.secretHandoffLine(secret).trim(), (l) => { out += l; });
  sa.consumeBackendOutput(out);
  assert.equal(sa.getHandoffState(), 'ready');
  return secret;
}
const BACKEND = { proc: { exitCode: null }, adopted: false };

/** Fake http.request: records everything, answers via `script`. */
function fakeHttp(script = {}) {
  const calls = [];
  const fn = (opts, cb) => {
    const req = new EventEmitter();
    const call = { opts, written: [], ended: false, endData: undefined, destroyed: false };
    calls.push(call);
    req.write = (d) => call.written.push(d);
    req.end = (d) => { call.ended = true; call.endData = d; if (script.timeout) { req.emit('timeout'); } else if (script.error) { req.emit('error', new Error('ECONNRESET secret-ish')); } else {
      const res = new EventEmitter(); res.statusCode = script.status ?? 200; cb(res);
      res.emit('data', Buffer.from(script.body ?? JSON.stringify({ ok: true }))); res.emit('end'); } };
    req.destroy = () => { call.destroyed = true; setImmediate(() => req.emit('error', new Error('socket hang up'))); };
    return req;
  };
  fn.calls = calls;
  return fn;
}
const run = (arg, httpRequest, backend = BACKEND) => bridge.performSetupRequest(arg, { getBackend: () => backend, port: 33071, httpRequest });
const verifyAt = (call, bodyString) => auth.verifySetupRequest({ method: call.opts.method, path: call.opts.path, bodyString, headers: call.opts.headers });

// ── F-1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
test('F-1: GET /api/setup/current sends NO body, NO Content-Length and NO Content-Type, and still verifies on the backend', async () => {
  const secret = readyLaunch(); const http = fakeHttp({ body: JSON.stringify({ host: 'h', port: '3306', database: 'd', username: 'u' }) });
  const r = await run({ op: 'current' }, http);
  assert.equal(r.status, 200); assert.equal(r.data.host, 'h');
  const c = http.calls[0];
  assert.equal(c.opts.method, 'GET'); assert.equal(c.opts.path, '/api/setup/current'); assert.equal(c.opts.host, '127.0.0.1'); assert.equal(c.opts.port, 33071);
  const names = Object.keys(c.opts.headers).map((h) => h.toLowerCase());
  assert.ok(!names.includes('content-length') && !names.includes('content-type'), names.join());
  assert.deepEqual(c.written, []); assert.equal(c.endData, undefined); assert.equal(c.ended, true);
  assert.equal(verifyAt(c, '{}'), true);                 // the backend sees req.body = {} for a body-less GET
  assert.ok(!JSON.stringify(c.opts.headers).includes(secret));
});

test('F-1: POST sends exactly the allow-listed JSON body with a matching Content-Length (multi-byte safe) and a verifying signature', async () => {
  readyLaunch(); const http = fakeHttp();
  const body = { host: 'db.local', port: 3306, database: 'checkin', username: 'root', password: 'pässwörd-✓', extra: 'dropped', __proto__: { x: 1 } };
  assert.equal((await run({ op: 'save', body }, http)).status, 200);
  const c = http.calls[0];
  const sent = c.endData;
  assert.equal(sent, JSON.stringify({ host: 'db.local', port: '3306', database: 'checkin', username: 'root', password: 'pässwörd-✓' }));
  assert.equal(c.opts.headers['content-length'], Buffer.byteLength(sent));
  assert.notEqual(c.opts.headers['content-length'], sent.length);
  assert.equal(c.opts.headers['content-type'], 'application/json');
  assert.equal(c.opts.method, 'POST'); assert.equal(c.opts.path, '/api/setup/save');
  assert.equal(verifyAt(c, JSON.stringify(JSON.parse(sent))), true);   // the backend re-serialises the parsed body
});

test('F-1: unknown / prototype operations and bad payloads are refused before any request is made', async () => {
  readyLaunch(); const http = fakeHttp();
  for (const arg of [undefined, null, 'save', {}, { op: 'drop' }, { op: '__proto__' }, { op: 'constructor' }, { op: 'toString' }, { op: ['save'] }, { op: 'save/../x' }]) {
    assert.equal((await run(arg, http)).status, 400, JSON.stringify(arg));
  }
  for (const body of [{ host: { a: 1 } }, { host: ['x'] }, { password: 'x'.repeat(257) }, { port: true }]) {
    assert.equal((await run({ op: 'test-connection', body }, http)).status, 400, JSON.stringify(body));
  }
  assert.equal(http.calls.length, 0);
});

test('F-1: a request that times out is destroyed and reported generically; transport errors never leak error text', async () => {
  readyLaunch();
  const t = await run({ op: 'current' }, fakeHttp({ timeout: true }));
  assert.deepEqual(t, { status: 0, data: { error: 'Backend unreachable' } });
  const e = await run({ op: 'save', body: { host: 'h' } }, fakeHttp({ error: true }));
  assert.deepEqual(e, { status: 0, data: { error: 'Backend unreachable' } });
});

test('F-1: a replayed IPC call is a NEW signed request (fresh nonce); two identical calls both verify, a captured one does not verify twice', async () => {
  readyLaunch(); const http = fakeHttp();
  await run({ op: 'current' }, http); await run({ op: 'current' }, http);
  assert.notEqual(http.calls[0].opts.headers['x-checkin-setup-nonce'], http.calls[1].opts.headers['x-checkin-setup-nonce']);
  assert.equal(verifyAt(http.calls[0], '{}'), true);
  assert.equal(verifyAt(http.calls[0], '{}'), false);   // replay of the captured first request
  assert.equal(verifyAt(http.calls[1], '{}'), true);
});

// ── F-3 / F-4: availability states reach the renderer as fixed codes, with no request made ───────────────────────────
test('F-3: an ADOPTED backend (not spawned by this app, no secret) fails clearly and nothing is sent', async () => {
  const http = fakeHttp();
  const r = await run({ op: 'save', body: { host: 'h' } }, http, { proc: null, adopted: true });
  assert.equal(r.status, 503); assert.equal(r.data.code, 'SETUP_ADOPTED_BACKEND'); assert.match(r.data.error, /earlier session/);
  assert.equal(http.calls.length, 0);
});

test('F-4: no backend / exited backend / unacknowledged hand-off / failed hand-off => fixed 503 codes, nothing is sent', async () => {
  const http = fakeHttp();
  assert.equal((await run({ op: 'current' }, http, { proc: null, adopted: false })).data.code, 'SETUP_UNAVAILABLE');
  const secret = sa.createLaunchSecret();                                                         // handed over, not yet acknowledged
  assert.equal((await run({ op: 'current' }, http)).data.code, 'SETUP_HANDOFF_PENDING');
  assert.equal((await run({ op: 'current' }, http, { proc: { exitCode: 1 }, adopted: false })).data.code, 'SETUP_UNAVAILABLE');
  sa.markHandoffFailed(secret);
  assert.equal((await run({ op: 'current' }, http)).data.code, 'SETUP_HANDOFF_FAILED');
  assert.equal(http.calls.length, 0);
  for (const code of ['SETUP_UNAVAILABLE', 'SETUP_ADOPTED_BACKEND', 'SETUP_HANDOFF_PENDING', 'SETUP_HANDOFF_FAILED']) assert.ok(Object.values(bridge.SETUP_UNAVAILABLE).some((f) => f().data.code === code));
});

// ── F-4: acknowledged hand-off ───────────────────────────────────────────────────────────────────────────────────────
test('F-4: backend and Electron derive the same one-way tag; the tag is not the secret and cannot be used as a request MAC', () => {
  const s = sa.createLaunchSecret(); feed(s);
  assert.equal(auth.ackTag(), sa.ackTagFor(s));
  assert.equal(auth.ackTag().length, 32); assert.ok(!s.includes(auth.ackTag()));
  const { a } = { a: { method: 'POST', path: '/api/setup/save', bodyString: '{}' } };
  assert.equal(auth.verifySetupRequest({ ...a, headers: { 'x-checkin-setup-ts': String(Date.now()), 'x-checkin-setup-nonce': 'n'.repeat(24), 'x-checkin-setup-mac': auth.ackTag().padEnd(64, '0') } }), false);
});
function feed(s) { return auth.handleStdinLine('setup-secret ' + s, noop); }

test('F-4: the backend acknowledges a valid hand-off (and a repeat of the SAME value), never a different or malformed one, and never prints the secret', () => {
  const s = sa.createLaunchSecret(); const out = [];
  assert.equal(auth.handleStdinLine(sa.secretHandoffLine(s).trim(), (l) => out.push(l)), true);
  assert.equal(auth.handleStdinLine(sa.secretHandoffLine(s).trim(), (l) => out.push(l)), true);   // retry -> acknowledged again
  assert.equal(out.length, 2); assert.ok(out.every((l) => l === `[Setup] HANDOFF_ACK ${sa.ackTagFor(s)}\n`));
  const other = []; auth.handleStdinLine('setup-secret ' + 'Q'.repeat(43), (l) => other.push(l)); auth.handleStdinLine('setup-secret short', (l) => other.push(l));
  assert.deepEqual(other, []);
  assert.ok(!out.join('').includes(s));
});

test('F-4: Electron marks the launch ready only for the correct tag; ack lines are stripped from what gets logged; late acks still count', () => {
  const s = sa.createLaunchSecret();
  assert.equal(sa.getHandoffState(), 'pending');
  assert.equal(sa.consumeBackendOutput(`[Setup] HANDOFF_ACK ${'0'.repeat(32)}\n`), '');          // wrong tag: stripped, ignored
  assert.equal(sa.getHandoffState(), 'pending');
  assert.equal(sa.consumeBackendOutput('Server running on 127.0.0.1:5000\n'), 'Server running on 127.0.0.1:5000');
  const mixed = sa.consumeBackendOutput(`before\n[Setup] HANDOFF_ACK ${sa.ackTagFor(s)}\nServer running\n`);
  assert.equal(sa.getHandoffState(), 'ready'); assert.ok(!mixed.includes('HANDOFF_ACK')); assert.ok(mixed.includes('Server running'));
  sa.markHandoffFailed(s); assert.equal(sa.getHandoffState(), 'ready');                           // only a pending launch can fail
  const s2 = sa.createLaunchSecret(); sa.markHandoffFailed(s2); assert.equal(sa.getHandoffState(), 'failed');
  sa.consumeBackendOutput(`[Setup] HANDOFF_ACK ${sa.ackTagFor(s2)}`); assert.equal(sa.getHandoffState(), 'ready');   // late ack
  sa.consumeBackendOutput(`[Setup] HANDOFF_ACK ${sa.ackTagFor(s)}`, s);                           // stale tag for an OLD secret
  assert.equal(sa.getHandoffState(), 'ready');
});

test('F-4: a tag for an old launch cannot ready a new launch; clearing and re-launching resets the state', () => {
  const old = sa.createLaunchSecret(); const oldTag = sa.ackTagFor(old);
  sa.clearLaunchSecret(old); assert.equal(sa.getHandoffState(), 'none');
  sa.createLaunchSecret(); sa.consumeBackendOutput(`[Setup] HANDOFF_ACK ${oldTag}`);
  assert.equal(sa.getHandoffState(), 'pending');
  const cur = sa.createLaunchSecret(); sa.clearLaunchSecret(old);                                // exit of the OLD process must not clear the new secret
  assert.equal(sa.hasLaunchSecret(), true); assert.equal(sa.getHandoffState(), 'pending'); sa.clearLaunchSecret(cur);
});

function fakeTimers() {
  const q = []; let id = 0;
  return { setTimer: (fn, ms) => { const t = { id: ++id, fn, ms }; q.push(t); return t; }, clearTimer: (t) => { const i = q.indexOf(t); if (i >= 0) q.splice(i, 1); }, pending: () => q.length, fire: () => { const t = q.shift(); if (t) t.fn(); return !!t; } };
}

test('F-4: the hand-off is retried a BOUNDED number of times, stops at the first ack, and ends as FAILED with a secret-free callback', () => {
  const s = sa.createLaunchSecret(); const tm = fakeTimers(); const writes = []; let gaveUp = 0;
  sa.startHandoff({ write: (l) => writes.push(l), secret: s, maxAttempts: 3, onGiveUp: () => { gaveUp += 1; }, ...tm });
  assert.equal(writes.length, 1);
  while (tm.fire()) { /* run every scheduled retry */ }
  assert.equal(writes.length, 3); assert.equal(gaveUp, 1); assert.equal(sa.getHandoffState(), 'failed');
  assert.ok(writes.every((l) => l === sa.secretHandoffLine(s)));
  assert.equal(tm.pending(), 0);

  const s2 = sa.createLaunchSecret(); const w2 = []; const t2 = fakeTimers();
  sa.startHandoff({ write: (l) => w2.push(l), secret: s2, maxAttempts: 5, ...t2 });
  t2.fire(); sa.consumeBackendOutput(`[Setup] HANDOFF_ACK ${sa.ackTagFor(s2)}`);
  while (t2.fire()) { /* nothing more may be written */ }
  assert.equal(w2.length, 2); assert.equal(sa.getHandoffState(), 'ready');
});

test('F-4: write failures are retried within the bound, cancel() stops everything, and a superseded launch stops writing', () => {
  const s = sa.createLaunchSecret(); const tm = fakeTimers(); let n = 0;
  sa.startHandoff({ write: () => { n += 1; throw new Error('EPIPE'); }, secret: s, maxAttempts: 2, ...tm });
  while (tm.fire()) { /* drain */ }
  assert.equal(n, 2); assert.equal(sa.getHandoffState(), 'failed');
  const s2 = sa.createLaunchSecret(); const t2 = fakeTimers(); let m = 0;
  const h = sa.startHandoff({ write: () => { m += 1; }, secret: s2, maxAttempts: 9, ...t2 }); h.cancel();
  assert.equal(t2.pending(), 0); assert.equal(m, 1);
  const s3 = sa.createLaunchSecret(); const t3 = fakeTimers(); let k = 0;
  sa.startHandoff({ write: () => { k += 1; }, secret: s3, maxAttempts: 9, ...t3 });
  sa.createLaunchSecret();                                                                          // a newer launch replaced it
  while (t3.fire()) { /* drain */ }
  assert.equal(k, 1);
});

// ── stdin protocol (shutdown vs hand-off) ────────────────────────────────────────────────────────────────────────────
function parser() {
  const events = []; const secretLines = [];
  const feedChunk = createStdinCommandParser({ handleHandoffLine: (l) => { const h = auth.handleStdinLine(l, noop); if (h) secretLines.push('handoff'); return h; }, onShutdown: () => events.push('shutdown') });
  return { feedChunk, events, secretLines };
}
test('stdin: a hand-off is never mistaken for shutdown, and "shutdown" never for a hand-off; split chunks and CRLF are reassembled', () => {
  const secret = sa.createLaunchSecret(); const p = parser(); const line = sa.secretHandoffLine(secret);
  p.feedChunk(line.slice(0, 20)); assert.equal(auth.isConfigured(), false);       // truncated: not applied
  p.feedChunk(line.slice(20)); assert.equal(auth.isConfigured(), true);
  p.feedChunk('shutdown\r\n'); assert.deepEqual(p.events, ['shutdown']);
  const q = parser(); q.feedChunk('shutd'); q.feedChunk('own\n'); assert.deepEqual(q.events, ['shutdown']);
  const r = parser(); r.feedChunk('shutdown'); assert.deepEqual(r.events, ['shutdown']);            // legacy unterminated form
  const t = parser(); t.feedChunk('xshutdown\nshutdown now\nsetup-secret shutdown\n'); assert.deepEqual(t.events, []);
  assert.equal(auth.isConfigured(), true);
});

test('stdin: a secret that merely CONTAINS "shutdown" does not stop the backend; a hand-off and a shutdown in one chunk both run in order', () => {
  auth._resetForTests();
  const p = parser(); const secret = 'a'.repeat(20) + 'shutdown' + 'b'.repeat(20);
  p.feedChunk(`setup-secret ${secret}\nshutdown\n`);
  assert.deepEqual(p.events, ['shutdown']); assert.equal(p.secretLines.length, 1); assert.equal(auth.isConfigured(), true);
  const q = parser(); q.feedChunk('x'.repeat(10000)); q.feedChunk('\nshutdown\n'); assert.deepEqual(q.events, ['shutdown']);   // over-long junk is bounded
});

// ── F-2: the legacy Mac bundle can never ship without the setup handler ──────────────────────────────────────────────
test('F-2: the bundle check requires every setup-auth marker, and rejects a stale / empty bundle', () => {
  const full = mojave.REQUIRED_MARKERS.join('\n');
  assert.deepEqual(mojave.checkBundleText(full), { ok: true, missing: [] });
  for (const m of mojave.REQUIRED_MARKERS) assert.deepEqual(mojave.checkBundleText(full.replace(m, '')).missing, [m]);
  assert.equal(mojave.checkBundleText('').ok, false); assert.equal(mojave.checkBundleText(undefined).ok, false);
  assert.equal(mojave.checkBundleText('secureHandle("app:version")').ok, false);
});

test('F-2: markers really come from the sources bundled into electron.mojave.cjs, and the build workflow enforces the check', () => {
  const src = ['ipc.js', 'setupAuth.js', 'setupBridge.js'].map((f) => fs.readFileSync(path.join(ROOT, 'frontend', 'electron', f), 'utf8')).join('\n');
  for (const m of mojave.REQUIRED_MARKERS) assert.ok(src.includes(m), `marker not in sources: ${m}`);
  const entry = fs.readFileSync(path.join(ROOT, 'frontend', 'electron.js'), 'utf8');
  assert.match(entry, /\.\/electron\/ipc\.js/);                                                    // the bundle entry pulls ipc.js (and so the setup code)
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend', 'package.json'), 'utf8')).scripts;
  assert.match(pkg['build:mojave-main'], /build-mojave-main\.mjs && node scripts\/verify-mojave-main\.mjs/);
  const legacy = pkg['electron:build:mac:legacy'];
  assert.ok(legacy.indexOf('build:mojave-main') > -1 && legacy.indexOf('verify:mojave-main') > legacy.indexOf('dist:verify') && legacy.indexOf('verify:mojave-main') < legacy.indexOf('electron-builder'));
  assert.match(fs.readFileSync(path.join(ROOT, 'frontend', 'scripts', 'build-mojave-main.mjs'), 'utf8'), /checkBundleText\(/);
  const verify = fs.readFileSync(path.join(ROOT, 'frontend', 'scripts', 'verify-mojave-main.mjs'), 'utf8');
  assert.match(verify, /process\.exit\(1\)/); assert.doesNotMatch(verify, /writeFileSync|esbuild/);   // read-only, never regenerates
});
