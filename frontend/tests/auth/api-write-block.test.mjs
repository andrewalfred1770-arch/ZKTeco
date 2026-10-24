/**
 * Login must stay possible while the realtime socket is down — isolated test (no backend, no database, no Electron, no network).
 *
 * Why it exists: with authentication enabled the server refuses the shared socket until someone signs in, so the app reports
 * "disconnected" BEFORE any login. EP-025's write block (lib/api.js) rejected every non-GET while "disconnected" — including the
 * POST /auth/login that would have reconnected the socket — so nobody could sign in (observed in a real browser against a scratch
 * auth-enabled backend: no request was sent, the screen showed "لا يمكن الحفظ الآن" and stayed on the login form).
 *
 * The REAL src/lib/api.js and src/lib/socket.js are bundled with esbuild; only socket.io-client (a controllable fake) and
 * react-hot-toast (a recorder) are replaced, and axios gets a recording adapter instead of the network.
 * Run:  node --test tests/auth/api-write-block.test.mjs     (from frontend/)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..', '..', 'src');
const AUTH_REFUSAL = 'غير مصرح — يجب تسجيل الدخول أولاً';        // the server's own fixed handshake refusal (middleware/auth.js)

// ── fakes ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const FAKE_SOCKET_IO = `
export const sockets = [];
export function io(base, opts) {
  const handlers = {};
  const s = { id: 'fake-1', active: true, opts,
    on(ev, fn) { (handlers[ev] ||= []).push(fn); return s; },
    emit() { return s; }, connect() { return s; }, disconnect() { return s; }, close() { return s; },
    io: { on() {}, off() {} }, off() { return s; },
    __fire(ev, ...a) { (handlers[ev] || []).forEach((f) => f(...a)); } };
  sockets.push(s); return s;
}
`;
const FAKE_TOAST = `
export const toasts = [];
const toast = Object.assign((m) => { toasts.push(['msg', m]); }, { error: (m) => { toasts.push(['error', m]); }, success: (m) => { toasts.push(['success', m]); } });
export default toast;
`;
const ENTRY = `
import api, { setAuthToken, setSessionBlocked } from ${JSON.stringify(path.join(SRC, 'lib', 'api.js').replace(/\\/g, '/'))};
import { getSocket, getConnectionStatus } from ${JSON.stringify(path.join(SRC, 'lib', 'socket.js').replace(/\\/g, '/'))};
import { sockets } from 'socket.io-client';
import { toasts } from 'react-hot-toast';
export { api, setAuthToken, setSessionBlocked, getSocket, getConnectionStatus, sockets, toasts };
`;

let M;                       // the bundled modules
let calls;                   // every request that actually reached the (fake) network adapter

test.before(async () => {
  globalThis.window = globalThis.window || {};                    // lib/api.js and lib/socket.js read window.electron at import time
  const fakesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-write-block-'));
  fs.writeFileSync(path.join(fakesDir, 'socket.io-client.js'), FAKE_SOCKET_IO);
  fs.writeFileSync(path.join(fakesDir, 'react-hot-toast.js'), FAKE_TOAST);
  const out = path.join(fakesDir, 'bundle.mjs');
  await build({
    stdin: { contents: ENTRY, resolveDir: SRC, sourcefile: 'entry.js', loader: 'js' },
    bundle: true, format: 'esm', platform: 'browser', outfile: out, logLevel: 'silent',   // browser build: what the renderer really runs (axios XHR build)
    alias: { 'socket.io-client': path.join(fakesDir, 'socket.io-client.js'), 'react-hot-toast': path.join(fakesDir, 'react-hot-toast.js') },
  });
  M = await import(pathToFileURL(out).href);
  M.api.defaults.adapter = async (config) => { calls.push({ method: config.method, url: config.url, auth: config.headers && config.headers.Authorization }); return { data: {}, status: 200, statusText: 'OK', headers: {}, config }; };
  M.getSocket();                                                 // the app creates the shared socket at start, before any login
  assert.equal(M.sockets.length, 1);
});
test.beforeEach(() => { calls = []; M.toasts.length = 0; M.setAuthToken(null); M.setSessionBlocked(false); });

const sock = () => M.sockets[0];
const goConnected = () => sock().__fire('connect');
const goAuthRefused = () => sock().__fire('connect_error', new Error(AUTH_REFUSAL));   // → status "disconnected", no retry loop
const sent = (method, url) => calls.some((c) => c.method === method && c.url === url);

test('A. connected: ordinary writes go out (baseline, unchanged)', async () => {
  goConnected();
  assert.equal(M.getConnectionStatus(), 'connected');
  await M.api.post('/employees', { name: 'x' });
  assert.ok(sent('post', '/employees'));
});

test('B. THE BUG: socket refused before login → status "disconnected" → POST /auth/login must still be sent', async () => {
  goAuthRefused();
  assert.equal(M.getConnectionStatus(), 'disconnected');
  const res = await M.api.post('/auth/login', { username: 'u', password: 'p' });
  assert.equal(res.status, 200);
  assert.ok(sent('post', '/auth/login'), 'the login request reached the network layer');
  assert.deepEqual(M.toasts, [], 'no "cannot save now" toast for a login');
});

test('C. the other /auth endpoints are also reachable while disconnected (logout, me)', async () => {
  goAuthRefused();
  await M.api.post('/auth/logout');
  await M.api.get('/auth/me');
  assert.ok(sent('post', '/auth/logout')); assert.ok(sent('get', '/auth/me'));
});

test('D. SAFETY: every other write is STILL blocked while disconnected — nothing is sent, the user is told, no retry is queued', async () => {
  goAuthRefused();
  for (const [method, url] of [['post', '/employees'], ['put', '/payroll/1'], ['delete', '/advances/1'], ['post', '/payroll/calculate'], ['patch', '/rules/3']]) {
    await assert.rejects(() => M.api.request({ method, url, data: {} }), (e) => e.isConnectionBlocked === true && e.config._noRetry === true, `${method} ${url} must be blocked`);
  }
  assert.deepEqual(calls, [], 'not one blocked request reached the network layer');
  assert.ok(M.toasts.some(([k, m]) => k === 'error' && /لا يمكن الحفظ الآن/.test(m)));
});

test('E. reads are never blocked (unchanged)', async () => {
  goAuthRefused();
  await M.api.get('/employees');
  assert.ok(sent('get', '/employees'));
});

test('F. same exemption while "reconnecting" (transient outage), writes still blocked', async () => {
  sock().active = false;                                          // socket.io gave up on its own → the app schedules its own retry
  sock().__fire('connect_error', new Error('timeout'));           // transient (not an auth refusal) → scheduleReconnect() → "reconnecting"
  assert.equal(M.getConnectionStatus(), 'reconnecting');
  await M.api.post('/auth/login', { username: 'u', password: 'p' });
  assert.ok(sent('post', '/auth/login'));
  await assert.rejects(() => M.api.post('/employees', {}), (e) => e.isConnectionBlocked === true);
  sock().active = true;
});

test('G. the exemption adds no credentials and does not weaken token handling: no Authorization header before login, Bearer after', async () => {
  goAuthRefused();
  await M.api.post('/auth/login', { username: 'u', password: 'p' });
  assert.equal(calls[0].auth, undefined, 'a login request carries no token');
  M.setAuthToken('tok-123'); goConnected();
  await M.api.post('/employees', {});
  assert.equal(calls[1].auth, 'Bearer tok-123');
});

test('H. the session-expired block is unchanged: data writes rejected, /auth/* allowed (sign back in)', async () => {
  goConnected(); M.setSessionBlocked(true);
  await assert.rejects(() => M.api.post('/employees', {}), (e) => e.isSessionExpired === true);
  await M.api.post('/auth/login', { username: 'u', password: 'p' });
  assert.ok(sent('post', '/auth/login')); assert.ok(!sent('post', '/employees'));
});

test('I. the exemption is limited to /auth/login|me|logout: look-alike paths are not exempt', async () => {
  goAuthRefused();
  for (const url of ['/auth/register', '/auth/login-as', '/authx/login', '/auth']) {
    await assert.rejects(() => M.api.post(url, {}), (e) => e.isConnectionBlocked === true, url);
  }
  assert.deepEqual(calls, []);
});
