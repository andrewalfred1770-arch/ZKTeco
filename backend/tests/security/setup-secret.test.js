/**
 * F1 stage 2: per-launch secret for /api/setup/*. Isolated: fake req/res objects and in-process calls only — no HTTP listener, no
 * database, no .env, no device, no Electron. The Electron-side signer (frontend/electron/setupAuth.js, plain ESM using only `crypto`)
 * is imported directly so signer and verifier are tested against each other.
 * Run:  node --test tests/security/setup-secret.test.js      (from backend/)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const auth = require('../../src/utils/setupAuth');
const { loopbackOnly } = require('../../src/middleware/loopbackOnly');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const feed = (line) => auth.handleStdinLine(line, () => {});   // never write the acknowledgement to the real stdout in tests
let signer;
test.before(async () => { signer = await import(pathToFileURL(path.join(ROOT, 'frontend', 'electron', 'setupAuth.js')).href); });
test.beforeEach(() => auth._resetForTests());

const launch = () => { const s = signer.createLaunchSecret(); assert.ok(feed(signer.secretHandoffLine(s).trim())); return s; };
const sign = (secret, over = {}) => {
  const a = { method: 'POST', path: '/api/setup/save', bodyString: JSON.stringify({ host: 'h', port: '3306', database: 'd', username: 'u', password: 'p' }), ...over };
  return { a, headers: signer.signSetupRequest(a, secret, over.now) };
};
const verify = (a, headers, now) => auth.verifySetupRequest({ method: a.method, path: a.path, bodyString: a.bodyString, headers }, now);

// full chain as mounted in routes/setup.js: loopbackOnly -> requireSetupAuth
function chain({ peer = '127.0.0.1', headers = {}, method = 'POST', url = '/api/setup/save', body = {} }) {
  const req = { socket: { remoteAddress: peer }, headers: { host: 'localhost:5000', ...headers }, method, originalUrl: url, body };
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ ok: false, status: this.statusCode, body: b, req }); } };
    loopbackOnly()(req, res, () => auth.requireSetupAuth()(req, res, () => resolve({ ok: true, req })));
  });
}
const signedChain = (secret, over = {}, extra = {}) => {
  const body = over.body ?? { host: 'h', port: '3306', database: 'd', username: 'u', password: 'p' };
  const headers = signer.signSetupRequest({ method: over.method || 'POST', path: over.url || '/api/setup/save', bodyString: JSON.stringify(body) }, secret);
  return chain({ ...over, body, headers: { ...headers, ...(extra.headers || {}) }, peer: extra.peer });
};

test('valid: the Electron signer and the backend verifier agree; the request passes and the MAC headers are stripped', async () => {
  const s = launch();
  const r = await signedChain(s);
  assert.equal(r.ok, true);
  assert.equal(r.req.headers['x-checkin-setup-mac'], undefined);
  const g = await signedChain(s, { method: 'GET', url: '/api/setup/current', body: undefined });   // body-less GET signs '{}'
  assert.equal(g.ok, true);
});

test('missing: no secret configured in the backend => everything refused (fail closed), even a "valid-looking" request', async () => {
  const forged = signer.signSetupRequest({ method: 'POST', path: '/api/setup/save', bodyString: '{}' }, 'A'.repeat(43));
  assert.equal(auth.isConfigured(), false);
  const r = await chain({ headers: forged, body: {} });
  assert.equal(r.ok, false); assert.equal(r.status, 403);
  assert.equal((await chain({ body: {} })).status, 403);   // no headers at all
});

test('missing headers / malformed headers are refused', async () => {
  const s = launch();
  const { headers } = sign(s);
  for (const drop of ['x-checkin-setup-ts', 'x-checkin-setup-nonce', 'x-checkin-setup-mac']) {
    const h = { ...headers }; delete h[drop];
    assert.equal((await chain({ headers: h, body: JSON.parse('{"host":"h","port":"3306","database":"d","username":"u","password":"p"}') })).ok, false, drop);
  }
  const { a } = sign(s);
  assert.equal(verify(a, { ...headers, 'x-checkin-setup-mac': 'zz' }), false);
  assert.equal(verify(a, { ...headers, 'x-checkin-setup-mac': [headers['x-checkin-setup-mac']] }), false);   // repeated header
  assert.equal(verify(a, { ...headers, 'x-checkin-setup-ts': 'abc' }), false);
  assert.equal(verify(a, { ...headers, 'x-checkin-setup-nonce': 'short' }), false);
});

test('invalid: wrong secret, wrong method/path/body, stale or future timestamp are refused', () => {
  const s = launch();
  const wrong = sign('B'.repeat(43)); assert.equal(verify(wrong.a, wrong.headers), false);
  let x = sign(s); assert.equal(verify({ ...x.a, bodyString: x.a.bodyString.replace('"h"', '"evil"') }, x.headers), false);   // altered body
  x = sign(s); assert.equal(verify({ ...x.a, path: '/api/setup/test-connection' }, x.headers), false);                       // other endpoint
  x = sign(s); assert.equal(verify({ ...x.a, method: 'GET' }, x.headers), false);
  x = sign(s, { now: () => Date.now() - 31_000 }); assert.equal(verify(x.a, x.headers), false);                              // expired
  x = sign(s, { now: () => Date.now() + 31_000 }); assert.equal(verify(x.a, x.headers), false);                              // from the future
  x = sign(s); assert.equal(verify(x.a, x.headers), true);                                                                   // control
});

test('replayed: a captured, correctly signed request works once and never again', () => {
  const s = launch();
  const { a, headers } = sign(s);
  assert.equal(verify(a, headers), true);
  assert.equal(verify(a, headers), false);
  assert.equal(verify(a, { ...headers }), false);
});

test('replayed across launches: a request signed with a previous launch\'s secret is useless against the next one', () => {
  const first = launch();
  const old = sign(first);
  auth._resetForTests();                       // backend restarted
  const second = launch();
  assert.notEqual(first, second);              // never reused
  assert.equal(verify(old.a, old.headers), false);
  const fresh = sign(second); assert.equal(verify(fresh.a, fresh.headers), true);
});

test('externally supplied: the secret (or look-alikes) sent as a header, query, cookie or body field authorizes nothing', async () => {
  const s = launch();
  for (const headers of [
    { 'x-checkin-setup-secret': s }, { 'x-setup-secret': s }, { authorization: `Bearer ${s}` }, { cookie: `setup=${s}` },
    { 'x-checkin-setup-mac': s, 'x-checkin-setup-ts': String(Date.now()), 'x-checkin-setup-nonce': 'n'.repeat(24) },
    { 'x-checkin-proxy-key': s },
  ]) assert.equal((await chain({ headers, body: { secret: s } })).ok, false, JSON.stringify(Object.keys(headers)));
  assert.equal((await chain({ url: `/api/setup/save?secret=${s}`, body: { secret: s } })).ok, false);
});

test('set-once: a later hand-off line (e.g. from a compromised pipe) cannot replace the launch secret; junk lines are ignored', () => {
  const s = launch();
  assert.equal(feed('setup-secret ' + 'Z'.repeat(43)), true);   // consumed...
  const { a, headers } = sign(s); assert.equal(verify(a, headers), true);       // ...but the original secret still rules
  auth._resetForTests();
  assert.equal(auth.setLaunchSecret('short'), false);
  assert.equal(auth.setLaunchSecret('has space ' + 'a'.repeat(40)), false);
  assert.equal(feed('shutdown'), false);
  assert.equal(auth.isConfigured(), false);
});

test('proxy / header spoofing: a PERFECTLY signed request is still refused when it arrives via a proxy, a LAN peer or a foreign Host', async () => {
  const s = launch();
  assert.equal((await signedChain(s, {}, { peer: '127.0.0.1' })).ok, true);                                              // control
  assert.equal((await signedChain(s, {}, { peer: '192.168.1.50' })).status, 403);                                         // LAN client directly
  assert.equal((await signedChain(s, {}, { headers: { 'x-forwarded-for': '192.168.1.50' } })).status, 403);               // Caddy-forwarded
  assert.equal((await signedChain(s, {}, { headers: { 'x-checkin-proxy-key': 'k', 'x-forwarded-for': '10.0.0.2' } })).status, 403);
  assert.equal((await signedChain(s, {}, { headers: { host: 'checkin.lan' } })).status, 403);
  // and forged headers without a MAC never help, whatever they claim
  const spoof = await chain({ headers: { 'x-forwarded-for': '127.0.0.1', forwarded: 'for=127.0.0.1', 'x-real-ip': '127.0.0.1' }, body: {} });
  assert.equal(spoof.status, 403);
});

test('every refusal is the same 403 body (no oracle for configured / wrong / expired / replayed)', async () => {
  const s = launch();
  const bodies = [];
  bodies.push((await chain({ body: {} })).body);
  const { headers } = sign(s, { now: () => Date.now() - 60_000 });
  bodies.push((await chain({ headers, body: {} })).body);
  const ok = await signedChain(s); assert.equal(ok.ok, true);
  const replay = signer.signSetupRequest({ method: 'POST', path: '/api/setup/save', bodyString: '{}' }, 'C'.repeat(43));
  bodies.push((await chain({ headers: replay, body: {} })).body);
  for (const b of bodies) assert.deepEqual(b, bodies[0]);
  assert.doesNotMatch(JSON.stringify(bodies[0]), /secret|\bmac\b|nonce|expired|replay/i);
});

test('the Electron signer fails closed without a secret and never returns it', () => {
  signer.clearLaunchSecret();
  assert.equal(signer.hasLaunchSecret(), false);
  assert.throws(() => signer.signSetupRequest({ method: 'GET', path: '/api/setup/current', bodyString: '{}' }), /unavailable/);
  const s = signer.createLaunchSecret();
  assert.ok(s.length >= 43); assert.notEqual(signer.createLaunchSecret(), s);
  const h = signer.signSetupRequest({ method: 'GET', path: '/api/setup/current', bodyString: '{}' });
  assert.ok(!JSON.stringify(h).includes(signer.createLaunchSecret()));
  signer.clearLaunchSecret();
});

test('(source) trust boundary: secret handed over stdin only, never env/file/log/renderer/URL', () => {
  const backendJs = read('frontend', 'electron', 'backend.js');
  assert.match(backendJs, /startHandoff\(\{[\s\S]*proc\.stdin\.write\(line\)/);   // the hand-off goes to the child's stdin only
  assert.doesNotMatch(backendJs, /env\.[A-Z_]*SETUP[A-Z_]*\s*=|console\.[a-z]+\([^)]*setupSecret/);
  const ipc = read('frontend', 'electron', 'ipc.js');
  const handler = ipc.slice(ipc.indexOf("secureHandle('setup:request'"), ipc.indexOf("secureHandle('app:version'"));
  assert.match(handler, /performSetupRequest\(/);
  assert.match(read('frontend', 'electron', 'setupBridge.js'), /signSetupRequest\(/);
  assert.doesNotMatch(handler, /console\.|getLaunchSecret|launchSecret/);
  assert.doesNotMatch(read('frontend', 'preload.cjs'), /getLaunchSecret|launchSecret|x-checkin-setup|createLaunchSecret/);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const leaks = walk(path.join(ROOT, 'frontend', 'src')).filter((f) => /\.(jsx?|tsx?)$/.test(f) && /x-checkin-setup|launchSecret|setup-secret/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(leaks, []);
  assert.doesNotMatch(read('frontend', 'src', 'components', 'DatabaseSetupWizard.jsx'), /api\.(get|post)\('\/setup/);
  const be = read('backend', 'src', 'utils', 'setupAuth.js');
  assert.match(be, /crypto\.timingSafeEqual\(/);
  assert.doesNotMatch(be.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), /writeFile|process\.env|logger|console\./);
  const setupRoute = read('backend', 'src', 'routes', 'setup.js');
  const iL = setupRoute.indexOf('router.use(loopbackOnly())'); const iA = setupRoute.indexOf('router.use(requireSetupAuth())');
  const iFirst = setupRoute.search(/router\.(get|post)\(/);
  assert.ok(iL > -1 && iA > iL && iA < iFirst, 'requireSetupAuth must follow loopbackOnly and precede every route');
  const index = read('backend', 'src', 'index.js');
  assert.match(index, /createStdinCommandParser\(\{/);
});
