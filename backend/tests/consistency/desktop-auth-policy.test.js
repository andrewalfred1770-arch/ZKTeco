/**
 * Single-PC desktop guarantees for authentication + network binding (isolated: pure functions and the auth middleware, no database,
 * no .env, no devices, no network).
 *
 * The intended Windows desktop ("Server" edition, local backend) runs with AUTH_ENABLED=false: it opens straight into the app (no login),
 * and because every request is then accepted without a token, the API may ONLY listen on loopback. LAN / Manager use needs
 * AUTH_ENABLED=true and keeps the full login + role checks. These tests lock exactly that contract.
 * Run:  node --test tests/consistency/desktop-auth-policy.test.js      (from backend/)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.resolve(__dirname, '..', '..', 'src');
const { parseAuthEnabled, isLoopbackHost, resolveSecureHost } = require(path.join(SRC, 'config', 'securityConfig.js'));

const resolveFor = (rawAuth, host) => {
  const a = parseAuthEnabled(rawAuth);
  return resolveSecureHost({ authEnabled: a.enabled, authStatus: a.status, authRaw: a.raw, host });
};

test('A. the installed desktop value AUTH_ENABLED="false" (quoted, as the persistent .env holds it), "false", unset and empty all mean: login OFF', () => {
  for (const raw of ['"false"', "'false'", 'false', ' FALSE ', undefined, null, '', '   ']) {
    const r = parseAuthEnabled(raw);
    assert.equal(r.enabled, false, `${JSON.stringify(raw)} must not enable authentication`);
    assert.ok(['disabled', 'unset'].includes(r.status), `${JSON.stringify(raw)} -> ${r.status}`);
  }
});

test('B. authentication turns ON only for the exact word "true" — a typo can never silently enable (or expose) anything', () => {
  for (const raw of ['true', 'TRUE', ' "true" ']) assert.equal(parseAuthEnabled(raw).enabled, true, raw);
  for (const raw of ['ture', '1', 'yes', 'on', 'enabled', 'truee', '0']) {
    const r = parseAuthEnabled(raw);
    assert.equal(r.enabled, false, raw); assert.equal(r.status, 'invalid', raw);
  }
});

test('C. desktop: auth off + HOST unset → bound to 127.0.0.1 only, with a loud (not silent) security warning', () => {
  for (const host of [undefined, '', '127.0.0.1', 'localhost', '::1', '[::1]', '127.0.0.5']) {
    const r = resolveFor('"false"', host);
    assert.equal(r.ok, true, String(host)); assert.equal(r.exposure, 'loopback', String(host));
    assert.ok(isLoopbackHost(r.host), `${r.host} is loopback`);
    assert.ok(r.warnings.some((w) => /Authentication is DISABLED/.test(w) && /loopback only/.test(w)), 'the "login is off, loopback only" warning is emitted');
  }
  assert.equal(resolveFor('false', undefined).host, '127.0.0.1');
});

test('D. NO unauthenticated exposure: auth off + any non-loopback HOST (0.0.0.0, LAN IP, hostname, IPv6 any) is REFUSED at startup', () => {
  for (const host of ['0.0.0.0', '192.168.1.145', '10.0.0.7', '172.16.0.2', '::', 'myserver.local', '[::]', '0:0:0:0:0:0:0:0']) {
    for (const raw of ['false', undefined, 'ture']) {
      const r = resolveFor(raw, host);
      assert.equal(r.ok, false, `${host} with AUTH_ENABLED=${raw}`);
      assert.equal(r.error.code, 'UNSAFE_BIND'); assert.equal(r.host, null);
    }
  }
});

test('E. an unrecognised AUTH_ENABLED value is treated as OFF (restricted to this machine) and reported — never as ON', () => {
  const r = resolveFor('ture', undefined);
  assert.equal(r.ok, true); assert.equal(r.exposure, 'loopback');
  assert.ok(r.warnings.some((w) => /not a recognized value/.test(w)));
});

test('F. Server/Manager (LAN) use is preserved: auth ON allows the LAN default 0.0.0.0 or an explicit LAN host', () => {
  const lan = resolveFor('true', undefined);
  assert.equal(lan.ok, true); assert.equal(lan.host, '0.0.0.0'); assert.equal(lan.exposure, 'network');
  assert.equal(resolveFor('true', '192.168.1.145').host, '192.168.1.145');
  assert.equal(resolveFor('true', '127.0.0.1').exposure, 'loopback');
});

// ── the middleware itself: loaded fresh for each mode (it reads AUTH_ENABLED / JWT_SECRET once at load) ──────────────────────────
function loadAuthMiddleware(env) {
  const saved = { A: process.env.AUTH_ENABLED, J: process.env.JWT_SECRET };
  for (const k of ['AUTH_ENABLED', 'JWT_SECRET']) delete process.env[k];
  Object.assign(process.env, env);
  const file = require.resolve(path.join(SRC, 'middleware', 'auth.js'));
  delete require.cache[file];
  try { return require(file); } finally {
    for (const [k, v] of [['AUTH_ENABLED', saved.A], ['JWT_SECRET', saved.J]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const fakeRes = () => { const r = { code: null, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const run = async (mw, req) => { const res = fakeRes(); let nexted = false; await mw(req, res, () => { nexted = true; }); return { nexted, code: res.code, body: res.body }; };

test('G. auth OFF (desktop): authenticate() and authorize() let a token-less request through — nothing is blocked or 401', async () => {
  const m = loadAuthMiddleware({ AUTH_ENABLED: '"false"' });
  assert.equal(m.AUTH_ENABLED, false);
  const a = await run(m.authenticate, { headers: {} });
  assert.equal(a.nexted, true); assert.equal(a.code, null);
  const z = await run(m.authorize('admin'), { headers: {}, user: undefined });
  assert.equal(z.nexted, true); assert.equal(z.code, null);
});

test('H. auth ON (Server/Manager): authenticate() refuses a token-less / garbage-token request with 401, and authorize() still enforces roles', async () => {
  const m = loadAuthMiddleware({ AUTH_ENABLED: 'true', JWT_SECRET: 'desktop-policy-test-only-secret' });
  assert.equal(m.AUTH_ENABLED, true);
  const none = await run(m.authenticate, { headers: {} });
  assert.equal(none.nexted, false); assert.equal(none.code, 401);
  const bad = await run(m.authenticate, { headers: { authorization: 'Bearer not-a-jwt' } });
  assert.equal(bad.nexted, false); assert.equal(bad.code, 401);
  const wrongRole = await run(m.authorize('admin', 'hr'), { headers: {}, user: { id: 1, role: 'employee' } });
  assert.equal(wrongRole.nexted, false); assert.equal(wrongRole.code, 403);
  const okRole = await run(m.authorize('admin', 'hr'), { headers: {}, user: { id: 1, role: 'hr' } });
  assert.equal(okRole.nexted, true);
});

test('I. auth ON without a real JWT_SECRET refuses to start (exit 78) — it can never fall back to the insecure default', () => {
  const { spawnSync } = require('child_process');
  const env = { ...process.env, AUTH_ENABLED: 'true' }; delete env.JWT_SECRET;
  const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(SRC, 'middleware', 'auth.js'))})`], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 78);
  assert.match(String(r.stderr), /JWT_SECRET/);
});
