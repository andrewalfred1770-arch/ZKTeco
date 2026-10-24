/**
 * F2 / F3 / F4 / F7 + AUTH_ENABLED matrix: authorization, self-service scoping, account deactivation, socket role isolation.
 * Isolated: fake request/response/database objects, and short-lived `node -e` child processes ONLY to load middleware/auth.js with a
 * given AUTH_ENABLED value (it is parsed once at require time). No database, no .env, no open port, no device, no running service.
 * Run:  node --test tests/security/authorization.test.js      (from backend/)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { deactivateEmployeeAccount } = require('../../src/utils/accountLifecycle');
const { STAFF_ROOM, joinScopes, installScopedEmit, scopeFor } = require('../../src/services/socketScopes');

const SRC = path.join(__dirname, '..', '..', 'src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const call = (mw, reqObj) => new Promise((resolve) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ passed: false, status: this.statusCode, body: b }); } };
  mw(reqObj, res, () => resolve({ passed: true, req: reqObj }));
});

// ── AUTH_ENABLED matrix (real middleware/auth.js, loaded in a child process per mode) ──────────────────────────────
function authProbe(authEnabled) {
  const code = `
    const { authorize, authenticate, AUTH_ENABLED } = require(${JSON.stringify(path.join(SRC, 'middleware', 'auth.js'))});
    const run = (mw, req) => new Promise((resolve) => { const res = { status(c){ this.c=c; return this; }, json(){ resolve(this.c); } }; mw(req, res, () => resolve('next')); });
    (async () => {
      const out = { enabled: AUTH_ENABLED };
      out.noUserAdminRoute    = await run(authorize('admin'), {});
      out.employeeAdminRoute  = await run(authorize('admin', 'hr'), { user: { role: 'employee' } });
      out.hrAdminRoute        = await run(authorize('admin', 'hr'), { user: { role: 'hr' } });
      out.hrAdminOnlyRoute    = await run(authorize('admin'), { user: { role: 'hr' } });
      out.adminAdminOnlyRoute = await run(authorize('admin'), { user: { role: 'admin' } });
      out.noTokenAuthenticate = await run(authenticate, { headers: {} });
      console.log(JSON.stringify(out));
    })();`;
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, AUTH_ENABLED: authEnabled, JWT_SECRET: 'unit-test-secret-not-a-real-secret' };
  const r = spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('AUTH_ENABLED=true: unauthenticated rejected, employee rejected from admin/hr routes, hr/admin keep access', () => {
  const o = authProbe('true');
  assert.equal(o.enabled, true);
  assert.equal(o.noTokenAuthenticate, 401);
  assert.equal(o.noUserAdminRoute, 401);
  assert.equal(o.employeeAdminRoute, 403);
  assert.equal(o.hrAdminRoute, 'next');
  assert.equal(o.hrAdminOnlyRoute, 403);
  assert.equal(o.adminAdminOnlyRoute, 'next');
});

test('AUTH_ENABLED=false (desktop mode): single trusted operator, role checks are a no-op — unchanged behaviour', () => {
  const o = authProbe('false');
  assert.equal(o.enabled, false);
  for (const k of ['noTokenAuthenticate', 'noUserAdminRoute', 'employeeAdminRoute', 'hrAdminRoute', 'hrAdminOnlyRoute', 'adminAdminOnlyRoute']) assert.equal(o[k], 'next', k);
});

// ── F2 (revised by owner decision): everyone may VIEW attendance/salary; only editor identities + personal identifiers are withheld ──
const { viewerScope, redactEmployeeForViewer } = require('../../src/middleware/employeeAccess');
const EMP = { id: 5, name: 'A', salary: 1000, nationalId: '123', phone: '055', email: 'a@x', user: { id: 1, username: 'a' }, branch: { name: 'B' } };

test('F2: with authentication off nothing is withheld (no-login deployment: every caller sees everything, as approved)', () => {
  assert.equal(redactEmployeeForViewer(EMP, {}, false), EMP);
  const req = {}; viewerScope(req, {}, () => {}); assert.equal(req.restrictedView, false);
});

test('F2: an authenticated employee can see other employees\' salary and attendance fields, but not personal identifiers or the login account', () => {
  const r = redactEmployeeForViewer(EMP, { user: { id: 9, role: 'employee' } }, true);
  assert.equal(r.salary, 1000); assert.equal(r.name, 'A'); assert.deepEqual(r.branch, { name: 'B' });
  for (const k of ['nationalId', 'phone', 'email', 'user']) assert.equal(k in r, false, k);
  assert.ok('nationalId' in EMP, 'input must not be mutated');
});

test('F2: admin and hr always get the full record', () => {
  for (const role of ['admin', 'hr']) assert.equal(redactEmployeeForViewer(EMP, { user: { role } }, true), EMP);
});

test('F2 (source): the attendance/dashboard/employee reads carry NO role restriction; writes keep theirs', () => {
  const daily = read('routes', 'attendance', 'daily.js'), monthly = read('routes', 'attendance', 'monthly.js'), movement = read('routes', 'attendance', 'movement.js');
  assert.match(daily, /router\.get\('\/daily', async/);
  assert.match(monthly, /router\.get\('\/monthly', async/);
  assert.match(monthly, /router\.get\('\/monthly-detail', async/);
  assert.match(monthly, /router\.get\('\/employee\/:id\/monthly', viewerScope, async/);
  assert.match(movement, /router\.get\('\/movement', async/);
  assert.doesNotMatch(read('routes', 'dashboard.js'), /authorize\(/);
  const emp = read('routes', 'employees.js');
  assert.match(emp, /router\.get\('\/', async/);
  assert.match(emp, /router\.post\('\/', authorize\('admin', 'hr'\)/);
  assert.match(emp, /router\.put\('\/:id', authorize\('admin', 'hr'\)/);
  assert.match(emp, /router\.delete\('\/:id', authorize\('admin'\)/);
  const manual = read('routes', 'attendance', 'manual.js');
  assert.match(manual, /router\.put\('\/daily\/:id', authorize\('admin', 'hr'\)/);
  assert.match(read('routes', 'payroll.js'), /router\.use\(authenticate, authorize\('admin', 'hr'\)\)/);   // payroll sheets unchanged
});

test('F2 (source): the restricted attendance view strips editor identities / reasons; AttendanceDaily has no money columns', () => {
  const monthly = read('routes', 'attendance', 'monthly.js');
  const m = /ADMIN_ONLY_DAILY_FIELDS = new Set\(\[([^\]]*)\]/.exec(monthly);
  for (const f of ['manualPenaltyBy', 'manualPenaltyByName', 'manualPenaltyReason', 'absenceSetBy', 'absenceReason', 'notes']) assert.ok(m[1].includes(`'${f}'`), f);
  assert.match(monthly, /req\.restrictedView \? rows\.map/);
  const schema = fs.readFileSync(path.join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8');
  assert.doesNotMatch(/model AttendanceDaily \{([^}]*)\}/.exec(schema)[1], /salary|amount|net|pay/i);
});

// ── LAN no-login: operations that stay with the server PC ───────────────────────────────────────────────────────────
const { lanLocalOnlyOps, isLocalOnlyPath } = require('../../src/middleware/lanLocalOnlyOps');
test('LAN no-login: an allow-listed LAN client cannot reach setup or cleanup; the server PC (no lanClient) and normal routes are unaffected', async () => {
  const run = (r) => call(lanLocalOnlyOps(), r);
  for (const url of ['/api/setup/save', '/api/setup/current', '/api/cleanup/execute', '/api/cleanup/backups/x.sql', '/API/CLEANUP/preview', '/api/cleanup?x=1']) {
    const r = await run({ lanClient: { ip: '192.168.1.5' }, originalUrl: url });
    assert.equal(r.passed, false, url); assert.equal(r.status, 403);
  }
  for (const url of ['/api/attendance/daily', '/api/payroll', '/api/employees', '/api/cleanupx', '/api/health']) assert.equal((await run({ lanClient: { ip: '192.168.1.5' }, originalUrl: url })).passed, true, url);
  assert.equal((await run({ originalUrl: '/api/cleanup/execute' })).passed, true);   // direct local desktop request: handled by the route's own rules
  assert.equal(isLocalOnlyPath('/api/setup'), true);
});

test('LAN no-login (source): the gate is mounted only in LAN no-login mode, right after the client allow-list gate', () => {
  const index = read('index.js');
  const a = index.indexOf('if (lanNoLogin) app.use(createClientGate('); const b = index.indexOf("if (lanNoLogin) app.use(require('./middleware/lanLocalOnlyOps')");
  assert.ok(a > -1 && b > a);
  assert.ok(b < index.indexOf("app.use(require('./middleware/securityHeaders'))"));
});

// ── F3 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('F3 (source): company-settings audit trail is admin-only; writes/uploads/deletes are admin-only', () => {
  const s = read('routes', 'settings-company.js');
  assert.match(s, /router\.get\('\/audit', authorize\('admin'\)/);
  assert.match(s, /router\.put\('\/', authorize\('admin'\)/);
  assert.match(s, /router\.post\('\/upload\/:field', authorize\('admin'\)/);
  assert.match(s, /router\.delete\('\/upload\/:field', authorize\('admin'\)/);
  assert.match(s, /router\.use\(authenticate\)/);
  assert.match(read('routes', 'audit.js'), /authenticate, authorize\('admin', 'hr'\)/);
});

// ── F4 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('F4: archiving/deleting an employee deactivates ONLY the linked employee-role account (never deletes, never touches staff accounts)', async () => {
  const users = [{ id: 1, role: 'admin', active: true }, { id: 2, role: 'employee', active: true }, { id: 3, role: 'employee', active: false }];
  const db = { user: { updateMany: async ({ where, data }) => {
    const hit = users.filter((u) => u.id === where.id && u.role === where.role && u.active === where.active);
    hit.forEach((u) => Object.assign(u, data)); return { count: hit.length };
  } } };
  assert.equal(await deactivateEmployeeAccount(db, 2), 1);
  assert.equal(users[1].active, false);
  assert.equal(await deactivateEmployeeAccount(db, 1), 0);       // an admin linked to an employee row stays active
  assert.equal(users[0].active, true);
  assert.equal(await deactivateEmployeeAccount(db, 3), 0);       // already inactive: nothing to do
  assert.equal(await deactivateEmployeeAccount(db, null), 0);
  assert.equal(await deactivateEmployeeAccount(db, undefined), 0);
  assert.equal(users.length, 3);
});

test('F4 (source): all four employee exits deactivate the account; reactivation is NOT automatic', () => {
  const s = read('routes', 'employees.js');
  assert.match(s, /if \(status === false\) await deactivateEmployeeAccount\(tx, updatedEmployee\.userId\)/);          // PUT /:id
  assert.match(s, /await deactivateEmployeeAccount\(tx, stopped\.userId\)/);                                         // DELETE /:id
  assert.match(s, /await deactivateEmployeeAccount\(prisma, emp\.userId\)/);                                         // delete-confirm (archive)
  assert.match(s, /prisma\.user\.updateMany\(\{ where: \{ id: emp\.userId, role: 'employee', active: true \}/);       // delete-confirm (hard delete)
  assert.doesNotMatch(s, /user\.delete\(/);                                                                           // accounts are never deleted
});

test('F4 (source): login and every authenticated request refuse a disabled account', () => {
  assert.match(read('routes', 'auth.js'), /!user \|\| !user\.active \|\| !valid/);
  const a = read('middleware', 'auth.js');
  assert.match(a, /return user && user\.active \? user : null/);
  assert.match(a, /if \(!account \|\| !account\.role\)/);
});

// ── F7 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
function fakeIo() {
  const sent = [];
  const io = { emit: (...a) => sent.push({ room: '*', args: a }), to: (room) => ({ emit: (...a) => sent.push({ room, args: a }) }) };
  return { io, sent };
}
const fakeSocket = (user) => { const s = { user, rooms: new Set(), join(r) { this.rooms.add(r); } }; return s; };

test('F7: admin and hr sockets join the staff room; employee and anonymous sockets do not', () => {
  const admin = fakeSocket({ id: 1, role: 'admin' }); const hr = fakeSocket({ id: 2, role: 'hr' });
  const emp = fakeSocket({ id: 3, role: 'employee' }); const anon = fakeSocket(undefined); const odd = fakeSocket({ id: 4, role: 'ADMIN' });
  for (const s of [admin, hr, emp, anon, odd]) joinScopes(s, true);
  assert.ok(admin.rooms.has(STAFF_ROOM) && hr.rooms.has(STAFF_ROOM));
  assert.equal(emp.rooms.size, 0); assert.equal(anon.rooms.size, 0); assert.equal(odd.rooms.size, 0);
  assert.equal(scopeFor(emp), null);
});

test('F7: with authentication on, io.emit is delivered to the staff room only (so an employee socket never receives it)', () => {
  const { io, sent } = fakeIo();
  installScopedEmit(io, true);
  io.emit('attendance:processed', { employeeId: 5 });
  io.emit('rules:changed', {});
  assert.deepEqual(sent.map((s) => s.room), [STAFF_ROOM, STAFF_ROOM]);
  installScopedEmit(io, true);                       // idempotent: no double wrapping
  io.emit('x'); assert.equal(sent.length, 3);
});

test('F7: with authentication off (desktop / LAN no-login) nothing changes — broadcast reaches every socket', () => {
  const { io, sent } = fakeIo();
  installScopedEmit(io, false);
  const s = fakeSocket(undefined); assert.equal(joinScopes(s, false), null);
  io.emit('attendance:processed', {});
  assert.deepEqual(sent.map((x) => x.room), ['*']);
});

test('F7 (source): no code path bypasses io.emit with a global broadcast, and index.js installs the scoping', () => {
  const index = read('index.js');
  assert.match(index, /installScopedEmit\(io, AUTH_ENABLED\)/);
  assert.match(index, /joinScopes\(socket, AUTH_ENABLED\)/);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const offenders = walk(SRC).filter((f) => f.endsWith('.js') && /io\.sockets\.emit|io\.of\([^)]*\)\.emit|\.broadcast\.emit|socket\.emit\(/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => path.relative(SRC, f)), []);
});
