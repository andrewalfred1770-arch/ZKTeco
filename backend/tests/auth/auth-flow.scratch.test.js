/**
 * Authentication flow — REAL MySQL regression test (scratch database ONLY), AUTH_ENABLED=true.
 *
 * Runs the real routes/auth.js + routes/employees.js + routes/advances.js (+ middleware/auth.js, rate limiter) from an ISOLATED COPY of
 * the backend against a disposable MySQL database, with synthetic accounts. Nothing here touches the application database, reads an
 * .env file, or contacts a device. The JWT secret below is a throwaway used only inside this test process.
 * Same guards and environment as tests/payroll-advances (every test is SKIPPED unless all hold; port 3306 is refused):
 *   SCRATCH_BACKEND_DIR   absolute path to a backend COPY (src, node_modules incl. generated Prisma client, prisma), NO .env* files, src in sync with the repo
 *   SCRATCH_DATABASE_URL  mysql://user[:pw]@127.0.0.1:PORT/scratch_<name>
 *   I_CONFIRM_THIS_IS_A_DISPOSABLE_SCRATCH_DATABASE   must equal that exact database name
 * Scope: login success / wrong password / unknown user / inactive / missing fields (no user enumeration), protected routes without
 * token / garbage / expired / foreign-signature / valid / deactivated-after-issue, role check taken from the account (not the JWT claim),
 * /auth/me, logout, login rate limit, public endpoints.
 * Login is limited to 10 attempts/minute per client, so only the L tests and the final burst (R1) call /auth/login; every other test signs
 * its token with the throwaway secret (the same signature the server would issue).
 * Run:  node --test tests/auth/auth-flow.scratch.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const DIR = process.env.SCRATCH_BACKEND_DIR;
const URL_ = process.env.SCRATCH_DATABASE_URL;
const CONFIRM = process.env.I_CONFIRM_THIS_IS_A_DISPOSABLE_SCRATCH_DATABASE;
const REPO_SRC = path.resolve(__dirname, '..', '..', 'src');
const TEST_ONLY_SECRET = 'scratch-auth-flow-test-only-secret';     // never a real secret: exists only inside this test process
const PW = 'scratch-flow-pw-1';                                      // throwaway password of the synthetic accounts

function refuse() {
  if (!DIR || !URL_ || !CONFIRM) return 'SCRATCH_BACKEND_DIR / SCRATCH_DATABASE_URL / confirmation not set';
  const m = /^mysql:\/\/[^/@]*@(127\.0\.0\.1|localhost):(\d+)\/(scratch_[a-z0-9_]+)$/.exec(URL_);
  if (!m) return 'SCRATCH_DATABASE_URL must be mysql://…@127.0.0.1:PORT/scratch_<name>';
  if (Number(m[2]) === 3306) return 'port 3306 is the default MySQL port and is refused as a scratch target — use a dedicated scratch port';
  if (CONFIRM !== m[3]) return 'confirmation does not equal the exact database name';
  if (!path.isAbsolute(DIR) || !fs.existsSync(path.join(DIR, 'src', 'routes', 'auth.js'))) return 'SCRATCH_BACKEND_DIR is not a backend copy';
  const repoBackend = path.resolve(REPO_SRC, '..');
  if (path.resolve(DIR) === repoBackend || path.resolve(DIR).startsWith(repoBackend + path.sep)) return 'SCRATCH_BACKEND_DIR must be a copy outside the repository backend';
  for (const d of [DIR, path.join(DIR, 'prisma')]) if (fs.readdirSync(d).some((n) => n === '.env' || n.startsWith('.env.'))) return 'the backend copy contains an env file';
  for (const rel of ['routes/auth.js', 'middleware/auth.js', 'routes/employees.js', 'routes/advances.js']) {
    const h = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    if (h(path.join(DIR, 'src', rel)) !== h(path.join(REPO_SRC, rel))) return `backend copy is stale: src/${rel} differs from the repository`;
  }
  return null;
}
const REFUSAL = refuse();
const T = (name, fn) => test(name, { skip: REFUSAL || false }, fn);
if (REFUSAL) console.log(`[auth-flow] SKIPPED: ${REFUSAL}`);

let admin; let srv; let base; let cfgDir; let prismaApp; let jwt; let bcrypt;
let verified = false;                                   // wipe in after() only once the scratch checks passed
const users = {};

test.before(async () => {
  if (REFUSAL) return;
  process.env.DATABASE_URL = URL_;
  process.env.AUTH_ENABLED = 'true';                   // read once when middleware/auth.js loads — set BEFORE requiring anything from the copy
  process.env.JWT_SECRET = TEST_ONLY_SECRET;
  delete process.env.JWT_EXPIRES;
  cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-flow-'));
  process.env.CONFIG_DIR = cfgDir;
  process.env.NODE_PATH = path.join(DIR, 'node_modules');
  require('module')._initPaths();
  const req = (p) => require(path.join(DIR, p));
  const express = req('node_modules/express');
  jwt = req('node_modules/jsonwebtoken'); bcrypt = req('node_modules/bcryptjs');
  const { PrismaClient } = req('node_modules/@prisma/client');
  admin = new PrismaClient({ datasources: { db: { url: URL_ } } });
  const db = (await admin.$queryRaw`SELECT DATABASE() AS d`)[0].d;
  assert.equal(db, CONFIRM, 'connected database is the confirmed scratch database');
  for (const t of ['users', 'employees']) assert.equal(Number((await admin.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM ${t}`))[0].c), 0, `scratch table ${t} must be empty at start`);
  verified = true;
  const hash = await bcrypt.hash(PW, 4);
  for (const [key, role, active] of [['admin', 'admin', true], ['plain', 'employee', true], ['inactive', 'hr', false]]) {
    users[key] = await admin.user.create({ data: { username: `flow_${key}`, name: `Flow ${key}`, password: hash, role, active } });
  }
  prismaApp = req('src/utils/prisma.js').getPrisma();
  const app = express(); app.use(express.json());
  app.use('/api/auth', req('src/routes/auth.js'));
  app.use('/api/employees', req('src/routes/employees.js'));
  app.use('/api/advances', req('src/routes/advances.js'));
  app.get('/api/health', (_rq, rs) => rs.json({ status: 'ok' }));
  srv = http.createServer(app).listen(0, '127.0.0.1'); await new Promise((r) => srv.on('listening', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(async () => {
  if (REFUSAL) return;
  if (verified) { try { await admin.user.deleteMany({}); } catch { /* best effort */ } }
  if (srv) await new Promise((r) => srv.close(r));
  if (admin) await admin.$disconnect();
  if (prismaApp) await prismaApp.$disconnect();
  if (cfgDir) fs.rmSync(cfgDir, { recursive: true, force: true });
});

const call = async (method, p, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, body: j };
};
const login = (username, password) => call('POST', '/api/auth/login', { body: { username, password } });
const sign = (claims, opts = {}, secret = TEST_ONLY_SECRET) => jwt.sign(claims, secret, { expiresIn: '1h', ...opts });
const claimsOf = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role });

T('L1. login success: 200, a signed token for that account, user profile without the password hash', async () => {
  const r = await login('flow_admin', PW);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(typeof r.body.token, 'string');
  const decoded = jwt.verify(r.body.token, TEST_ONLY_SECRET);
  assert.equal(decoded.id, users.admin.id); assert.equal(decoded.role, 'admin');
  assert.deepEqual(Object.keys(r.body.user).sort(), ['id', 'name', 'role', 'username']);
  assert.ok(!JSON.stringify(r.body).includes('$2'), 'no bcrypt hash in the response');
});

T('L2. wrong password, unknown user and inactive account all answer the same 401 (no user enumeration), no token', async () => {
  const wrong = await login('flow_admin', 'not-the-password');
  const unknown = await login('flow_nobody', PW);
  const inactive = await login('flow_inactive', PW);                 // correct password, but the account is deactivated
  for (const r of [wrong, unknown, inactive]) { assert.equal(r.status, 401); assert.equal(r.body.token, undefined); }
  assert.equal(wrong.body.error, unknown.body.error); assert.equal(wrong.body.error, inactive.body.error);
});

T('L3. missing / blank credentials are a 400 (nothing is looked up)', async () => {
  assert.equal((await call('POST', '/api/auth/login', { body: { username: 'flow_admin' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/login', { body: { username: '   ', password: PW } })).status, 400);
  assert.equal((await call('POST', '/api/auth/login', { body: {} })).status, 400);
});

T('P1. protected route without a token → 401; with garbage / foreign-signature / expired tokens → 401 (expiry has its own message)', async () => {
  assert.equal((await call('GET', '/api/employees')).status, 401);
  assert.equal((await call('GET', '/api/employees', { token: 'garbage' })).status, 401);
  assert.equal((await call('GET', '/api/employees', { token: sign(claimsOf(users.admin), {}, 'some-other-secret') })).status, 401, 'signed with a different secret');
  const expired = await call('GET', '/api/employees', { token: sign(claimsOf(users.admin), { expiresIn: -30 }) });
  assert.equal(expired.status, 401);
  const garbage = await call('GET', '/api/employees', { token: 'garbage' });
  assert.notEqual(expired.body.error, garbage.body.error, 'an expired session is reported as expired');
  assert.equal((await call('GET', '/api/employees', { token: sign({ id: users.admin.id }, { algorithm: 'none' }, '') .toString() })).status, 401, 'unsigned token');
});

T('P2. valid token → protected route works (200) for an active account', async () => {
  const r = await call('GET', '/api/employees', { token: sign(claimsOf(users.admin)) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

T('P3. a still-unexpired token stops working the moment its account is deactivated, and works again when reactivated', async () => {
  const tok = sign(claimsOf(users.admin));
  assert.equal((await call('GET', '/api/employees', { token: tok })).status, 200);
  await admin.user.update({ where: { id: users.admin.id }, data: { active: false } });
  try { assert.equal((await call('GET', '/api/employees', { token: tok })).status, 401); }
  finally { await admin.user.update({ where: { id: users.admin.id }, data: { active: true } }); }
  assert.equal((await call('GET', '/api/employees', { token: tok })).status, 200);
});

T('P4. authorization comes from the account, not the token claim: an "employee" account with a forged admin claim is still refused (403) on an admin/hr route', async () => {
  const forged = sign({ ...claimsOf(users.plain), role: 'admin' });
  assert.equal((await call('GET', '/api/advances', { token: forged })).status, 403);
  const honest = sign(claimsOf(users.plain));
  assert.equal((await call('GET', '/api/advances', { token: honest })).status, 403);
  const adminTok = sign(claimsOf(users.admin));
  assert.equal((await call('GET', '/api/advances', { token: adminTok })).status, 200);
});

T('M1. /auth/me: 401 without a token, the account profile with one', async () => {
  assert.equal((await call('GET', '/api/auth/me')).status, 401);
  const tok = sign(claimsOf(users.admin));
  const me = await call('GET', '/api/auth/me', { token: tok });
  assert.equal(me.status, 200);
  assert.equal(JSON.stringify(me.body).includes('flow_admin'), true);
});

T('M2. logout answers 200 and is stateless (the client discards the token); public /health stays open without a token', async () => {
  assert.equal((await call('POST', '/api/auth/logout')).status, 200);
  assert.equal((await call('GET', '/api/health')).status, 200);
});

T('R1. the login endpoint is rate-limited per client (a burst of attempts ends in 429) and a limited attempt never yields a token', async () => {
  const seen = [];
  for (let i = 0; i < 14; i++) seen.push(await login('flow_admin', 'wrong-' + i));
  const limited = seen.filter((r) => r.status === 429);
  assert.ok(limited.length >= 1, `expected a 429 within the burst, got ${seen.map((r) => r.status).join(',')}`);
  assert.ok(seen.every((r) => r.body && r.body.token === undefined));
});
