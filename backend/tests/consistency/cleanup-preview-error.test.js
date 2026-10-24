/**
 * Data Cleanup impact preview — error-message mapping (frontend/src/lib/cleanupPreviewError.js).
 * Real 400 / 200 / 500 bodies come from the actual /api/cleanup/preview route on the in-memory fake DB (preview only: nothing is
 * ever deleted); 401 / 403 / 503 / timeout / network are shaped exactly like axios errors. No real DB, devices or .env.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { pathToFileURL } = require('url');
const h = require('./harness');

const FRONTEND = path.join(__dirname, '..', '..', '..', 'frontend', 'src');
let M; let srv; let base;
const faults = {};

test.before(async () => {
  M = await import(pathToFileURL(path.join(FRONTEND, 'lib', 'cleanupPreviewError.js')).href);
  // db wrapper so one read can be made to throw (as a real Prisma failure would)
  const wrapped = new Proxy(h.db, { get(t, p) {
    const v = t[p];
    if (typeof p !== 'string' || p.startsWith('_') || p.startsWith('$') || p === 'then') return v;
    return new Proxy(v, { get(m, op) { return (...a) => { const f = faults[`${p}.${String(op)}`]; if (f) throw f; return m[op](...a); }; } });
  } });
  require.cache[require.resolve(path.join(h.SRC, 'utils/prisma.js'))].exports.getPrisma = () => wrapped;
  const app = express(); app.use(express.json()); app.use('/api/cleanup', h.load('routes/cleanup'));
  srv = http.createServer(app).listen(0, '127.0.0.1'); await new Promise((r) => srv.on('listening', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  h.setNow('2026-10-14T10:00:00');
  h.db._reset({ employee: [h.emp({ id: 1 })], attendanceDaily: [], attendanceLog: [], payroll: [] });
});
test.after(() => srv.close());

const axiosErr = (status, data) => ({ message: `Request failed with status code ${status}`, response: { status, data } });
async function realPreview(body) {
  const r = await fetch(`${base}/api/cleanup/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
}

test('E1. each failure class gets its own clear explanation', () => {
  assert.equal(M.describePreviewError(axiosErr(401, { error: 'غير مصرح — يجب تسجيل الدخول أولاً' })).kind, 'session-expired');
  assert.match(M.describePreviewError(axiosErr(401, {})).message, /انتهت الجلسة/);
  const f = M.describePreviewError(axiosErr(403, { error: 'غير مخول لهذا الإجراء' }));
  assert.equal(f.kind, 'forbidden'); assert.match(f.message, /لمدير النظام فقط/); assert.match(f.message, /HTTP 403/);
  const b = M.describePreviewError(axiosErr(400, { error: 'يجب تحديد نوع بيانات واحد على الأقل' }));
  assert.equal(b.kind, 'invalid-input'); assert.match(b.message, /يجب تحديد نوع بيانات/);
  const u = M.describePreviewError(axiosErr(503, { error: 'الخادم غير جاهز — تعذّرت تهيئة قاعدة البيانات عند بدء التشغيل', code: 'APP_NOT_READY' }));
  assert.equal(u.kind, 'backend-unavailable'); assert.match(u.message, /الخادم غير جاهز/); assert.match(u.message, /HTTP 503/);
  const t = M.describePreviewError({ code: 'ECONNABORTED', message: 'timeout of 600000ms exceeded' });
  assert.equal(t.kind, 'timeout'); assert.match(t.message, /انتهت مهلة/);
  assert.equal(M.describePreviewError(axiosErr(504, {})).kind, 'timeout');
  const n = M.describePreviewError({ message: 'Network Error', code: 'ERR_NETWORK', request: {} });
  assert.equal(n.kind, 'network'); assert.match(n.message, /تعذّر الاتصال بالخادم/);
  assert.equal(M.describePreviewError(axiosErr(500, { error: 'خطأ في الخادم' })).kind, 'server-error');
  assert.equal(M.describePreviewError(new Error('boom')).kind, 'unknown');
  assert.equal(M.describePreviewError(null).kind, 'unknown');
});

test('E2. unsafe server text is never displayed (stack, SQL, Prisma, connection string, credentials, paths, markup)', () => {
  const bad = [
    'Invalid `prisma.attendanceLog.count()` invocation: Can\'t reach database server at 127.0.0.1:3306',
    'SELECT id FROM payrolls WHERE month = 9 FOR UPDATE',
    'Error: connect ECONNREFUSED 127.0.0.1:3306\n    at TCPConnectWrap.afterConnect (node:net:1:1)',
    'mysql://petshrow:Sup3rSecret@127.0.0.1:3306/zkteco',
    'password authentication failed for user x',
    'JWT token invalid: Bearer abc.def.ghi',
    'C:\\Users\\Admin\\Desktop\\ZKTeco\\backend\\src\\routes\\cleanup.js',
    '<html><body>Internal Server Error</body></html>',
    'x'.repeat(500),
  ];
  for (const text of bad) {
    for (const status of [400, 500, 503, 418]) {
      const out = M.describePreviewError(axiosErr(status, { error: text })).message;
      for (const leak of ['prisma', 'SELECT', 'mysql://', 'Sup3rSecret', 'ECONNREFUSED', 'Bearer', 'C:\\', '<html', 'xxxxxxxxxx']) assert.ok(!out.includes(leak), `leaked "${leak}" for status ${status}`);
    }
  }
  assert.equal(M.describePreviewError(axiosErr(400, '<!DOCTYPE html><pre>SyntaxError at JSON.parse</pre>')).kind, 'invalid-input');
  assert.ok(!M.describePreviewError(axiosErr(400, '<!DOCTYPE html><pre>SyntaxError</pre>')).message.includes('<'));
});

test('E3. real route responses: invalid input shows the server\'s own safe Arabic message; a DB failure shows only the generic text', async () => {
  const none = await realPreview({ from: '2026-09-01', to: '2026-09-30', types: { rawLogs: false, daily: false, payroll: false } });
  assert.equal(none.status, 400);
  const m1 = M.describePreviewError(axiosErr(none.status, none.data));
  assert.equal(m1.kind, 'invalid-input'); assert.ok(m1.message.includes('يجب تحديد نوع بيانات واحد على الأقل'));
  const range = await realPreview({ from: '2026-09-30', to: '2026-09-01', types: { rawLogs: true } });
  assert.equal(range.status, 400);
  assert.ok(M.describePreviewError(axiosErr(range.status, range.data)).message.includes('نطاق تاريخ غير صالح'));
  faults['attendanceLog.count'] = Object.assign(new Error('Timed out fetching a new connection from the connection pool'), { name: 'PrismaClientKnownRequestError', code: 'P2024' });
  const dbFail = await realPreview({ from: '2026-09-01', to: '2026-09-30', types: { rawLogs: true } });
  delete faults['attendanceLog.count'];
  assert.equal(dbFail.status, 500);
  const m2 = M.describePreviewError(axiosErr(dbFail.status, dbFail.data));
  assert.equal(m2.kind, 'server-error'); assert.match(m2.message, /HTTP 500/); assert.ok(!/P2024|connection pool/i.test(m2.message)); assert.match(m2.message, /لم يُحذف أي شيء/);
  const ok = await realPreview({ from: '2026-09-01', to: '2026-09-30', types: { rawLogs: true } });
  assert.equal(ok.status, 200);
  assert.deepEqual(h.db._writeLog, [], 'the preview wrote nothing');
});

test('E4. static: the page still sends the same preview request and only the failure text changed; the helper has no network or storage access', () => {
  const page = fs.readFileSync(path.join(FRONTEND, 'pages', 'DataCleanupPage.jsx'), 'utf8');
  assert.ok(page.includes("api.post('/cleanup/preview', { from: form.from, to: form.to, types: form.types }, LONG_OP)"), 'request unchanged');
  assert.ok(page.includes('setPreviewError(describePreviewError(err).message)'));
  assert.ok(page.includes("api.post('/cleanup/execute'"), 'execute untouched');
  const lib = fs.readFileSync(path.join(FRONTEND, 'lib', 'cleanupPreviewError.js'), 'utf8');
  assert.ok(!/from ['"][^'"]*(api|axios)['"]|\bfetch\(|localStorage|sessionStorage|api\.(get|post|put|delete)\(/.test(lib));
});
