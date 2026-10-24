/**
 * F5 / F6: password policy, bcrypt cost, generic login failures and the stand-in hash.
 * Isolated: utils/prisma is replaced by an in-memory fake BEFORE routes/auth.js loads, so no database is ever contacted;
 * the login handler is invoked directly (no HTTP server, no port). Uses the real bcryptjs.
 * Run:  node --test tests/security/login-and-passwords.test.js      (from backend/)
 */
process.env.AUTH_ENABLED = 'true';
process.env.JWT_SECRET = 'unit-test-secret-not-a-real-secret';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { validatePassword, bcryptCostOf, getDummyHash, BCRYPT_COST, MIN_PASSWORD_LENGTH } = require('../../src/utils/passwordPolicy');

const SRC = path.join(__dirname, '..', '..', 'src');

// ── in-memory stand-in for the prisma module (installed before routes/auth.js is required) ───────────────────────
const accounts = new Map();
const updates = [];
const fakePrisma = { user: {
  findUnique: async ({ where }) => accounts.get(where.username) || null,
  update: async ({ where, data }) => { updates.push({ where, data }); return {}; },
} };
const prismaPath = require.resolve('../../src/utils/prisma');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { getPrisma: () => fakePrisma } };
const router = require('../../src/routes/auth');
const loginHandler = router.stack.find((l) => l.route && l.route.path === '/login').route.stack.pop().handle;

const login = (body) => new Promise((resolve) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
  loginHandler({ body }, res);
});

test('policy: length 12..72 BYTES, no silent truncation, no trivial passwords', () => {
  assert.equal(validatePassword('correct horse battery', 'alice'), null);
  assert.ok(validatePassword('short1', 'alice'));
  assert.ok(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH - 1), 'alice'));
  assert.equal(validatePassword('Ab1' + 'x'.repeat(69), 'alice'), null);        // exactly 72 bytes
  assert.ok(validatePassword('Ab1' + 'x'.repeat(70), 'alice'));                  // 73 bytes: would be truncated by bcrypt -> refused
  assert.ok(validatePassword('é'.repeat(37), 'alice'));                          // 37 chars but 74 BYTES -> refused
  assert.ok(validatePassword(' leading space pw', 'alice'));
  assert.ok(validatePassword('trailing space pw ', 'alice'));
  assert.ok(validatePassword('Alice-Alice-1', 'alice-alice-1'));                  // equals the username (case-insensitive)
  assert.ok(validatePassword('aaaaaaaaaaaaaaaa', 'alice'));
  for (const bad of [undefined, null, 123, {}, ['x'.repeat(20)]]) assert.ok(validatePassword(bad, 'alice'));
});

test('policy: error text never echoes the password', () => {
  const pw = 'SuperSecret-9';
  const msg = validatePassword(pw.slice(0, 6), 'x');
  assert.ok(msg); assert.ok(!msg.includes(pw.slice(0, 6)));
});

test('policy: one cost factor (12) for every newly created account, and the helper reads a hash\'s cost', async () => {
  assert.equal(BCRYPT_COST, 12);
  assert.equal(bcryptCostOf('$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123456'), 10);
  assert.equal(bcryptCostOf('not a hash'), null);
  const emp = fs.readFileSync(path.join(SRC, 'routes', 'employees.js'), 'utf8');
  assert.match(emp, /bcrypt\.hash\(password, BCRYPT_COST\)/);
  assert.doesNotMatch(emp, /bcrypt\.hash\(password, 10\)/);
  const admin = fs.readFileSync(path.join(SRC, '..', 'scripts', 'create-admin-user.js'), 'utf8');
  assert.match(admin, /const BCRYPT_COST = 12;/);
});

test('policy: the stand-in hash is a real bcrypt hash at the policy cost, generated once per process', async () => {
  const h = await getDummyHash(bcrypt);
  assert.equal(bcryptCostOf(h), BCRYPT_COST);
  assert.equal(await getDummyHash(bcrypt), h);
  assert.equal(await bcrypt.compare('anything', h), false);
  assert.doesNotMatch(fs.readFileSync(path.join(SRC, 'routes', 'auth.js'), 'utf8'), /\$2[aby]\$\d\d\$[./A-Za-z0-9]{40,}/);   // no hash literal in source
});

test('F5 (source): employee + login account are created in ONE transaction; no manual cleanup; invalid credentials rejected before any write', () => {
  const s = fs.readFileSync(path.join(SRC, 'routes', 'employees.js'), 'utf8');
  const create = s.slice(s.indexOf("router.post('/', authorize"), s.indexOf("router.put('/:id'"));
  assert.ok(create.indexOf('validatePassword(password, uname)') > -1);
  assert.ok(create.indexOf('validatePassword') < create.indexOf('$transaction'), 'validation must precede the transaction');
  assert.match(create, /tx\.user\.create\(/);
  assert.doesNotMatch(create, /prisma\.user\.(create|delete)\(/);
  assert.doesNotMatch(create, /logger\.[a-z]+\([^)]*password/i);
});

test('F6: unknown user, disabled user and wrong password get the SAME 401 body; bcrypt runs in every case', async () => {
  const good = 'correct horse battery';
  accounts.set('active', { id: 1, username: 'active', name: 'A', role: 'hr', active: true, password: await bcrypt.hash(good, BCRYPT_COST) });
  accounts.set('disabled', { id: 2, username: 'disabled', name: 'D', role: 'employee', active: false, password: await bcrypt.hash(good, BCRYPT_COST) });

  const realCompare = bcrypt.compare; let compares = 0;
  bcrypt.compare = (...a) => { compares++; return realCompare.apply(bcrypt, a); };
  try {
    const unknown = await login({ username: 'nobody', password: good });
    const wrong = await login({ username: 'active', password: 'wrong password!!' });
    const off = await login({ username: 'disabled', password: good });   // right password, disabled account
    assert.equal(compares, 3, 'bcrypt.compare must run for unknown, wrong and disabled alike');
    for (const r of [unknown, wrong, off]) assert.equal(r.status, 401);
    assert.deepEqual(unknown.body, wrong.body); assert.deepEqual(wrong.body, off.body);
    assert.deepEqual(Object.keys(unknown.body), ['error']);
    const ok = await login({ username: 'active', password: good });
    assert.equal(ok.status, 200); assert.ok(ok.body.token); assert.equal(ok.body.user.password, undefined);
  } finally { bcrypt.compare = realCompare; }
});

test('F6: non-string / oversized input is handled without bcrypt work and without a type-dependent oracle', async () => {
  for (const body of [{ username: { $ne: '' }, password: 'x' }, { username: 'a', password: ['x'] }, { username: 5, password: 5 }, undefined, {}]) {
    assert.equal((await login(body)).status, 400);
  }
  assert.equal((await login({ username: 'a'.repeat(65), password: 'x' })).status, 401);
  assert.equal((await login({ username: 'a', password: 'x'.repeat(1025) })).status, 401);
});

test('F6: a legacy cost-10 hash is transparently upgraded to the policy cost after a successful login', async () => {
  const good = 'legacy password 123';
  accounts.set('legacy', { id: 9, username: 'legacy', name: 'L', role: 'employee', active: true, password: await bcrypt.hash(good, 10) });
  updates.length = 0;
  assert.equal((await login({ username: 'legacy', password: good })).status, 200);
  await new Promise((r) => setTimeout(r, 1500));   // the upgrade runs after the response
  assert.equal(updates.length, 1);
  assert.equal(bcryptCostOf(updates[0].data.password), BCRYPT_COST);
  assert.equal(await bcrypt.compare(good, updates[0].data.password), true);
  // a failed login never rewrites a hash
  updates.length = 0;
  await login({ username: 'legacy', password: 'wrong password!!' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(updates.length, 0);
});

test('F6 (source): login responses and the limiter expose no IP address or internal detail', () => {
  const rl = fs.readFileSync(path.join(SRC, 'middleware', 'rateLimiter.js'), 'utf8');
  assert.doesNotMatch(rl.slice(rl.indexOf('res.status(429)')), /ip\b[^\n]*json|json[^\n]*\bip\b/);
  assert.doesNotMatch(fs.readFileSync(path.join(SRC, 'routes', 'auth.js'), 'utf8'), /req\.ip|remoteAddress/);
});
