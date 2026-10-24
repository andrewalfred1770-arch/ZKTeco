/**
 * What the Server-edition login gate renders (isolated: the pure gate function only — no backend, no Electron, no network).
 *
 * Single-PC desktop = Server edition talking to its own backend with AUTH_ENABLED=false: the backend answers GET /auth/me with
 * { authEnabled:false }, the store records authEnabled=false, and the gate renders the app directly — never the login screen, with or
 * without a stored token, with or without unsaved edits. The login screen appears ONLY when the backend itself reports authEnabled:true
 * and there is no session token (LAN Server / Manager use).
 * Run:  node --test tests/auth/auth-gate.test.mjs     (from frontend/)
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

let gateView;
test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-gate-'));
  const out = path.join(dir, 'authGate.mjs');
  await build({ entryPoints: [path.join(SRC, 'lib', 'authGate.js')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
  ({ gateView } = await import(pathToFileURL(out).href));
});

test('A. backend reports authEnabled:false (the desktop default): the app renders directly in every state — no login screen', () => {
  for (const token of [null, undefined, '', 'some-token']) for (const unsavedCount of [0, 3]) {
    assert.equal(gateView({ authEnabled: false, token, unsavedCount }), 'app', `token=${JSON.stringify(token)} unsaved=${unsavedCount}`);
  }
});

test('B. backend not reached yet (authEnabled unknown/null): the app is rendered (the ready-gate owns the "starting" state), never a premature login', () => {
  for (const token of [null, 'tok']) assert.equal(gateView({ authEnabled: null, token, unsavedCount: 0 }), 'app');
  assert.equal(gateView({ authEnabled: undefined, token: null, unsavedCount: 0 }), 'app');
});

test('C. LAN/Manager use stays protected: authEnabled:true with no token → login only (or login overlay when edits are unsaved)', () => {
  assert.equal(gateView({ authEnabled: true, token: null, unsavedCount: 0 }), 'login');
  assert.equal(gateView({ authEnabled: true, token: '', unsavedCount: 0 }), 'login');
  assert.equal(gateView({ authEnabled: true, token: null, unsavedCount: 2 }), 'app+login');
});

test('D. authEnabled:true with a session token renders the app', () => {
  assert.equal(gateView({ authEnabled: true, token: 'tok', unsavedCount: 0 }), 'app');
});

test('E. only a literal boolean true can show the login: truthy look-alikes never do', () => {
  for (const authEnabled of ['true', 1, {}, 'yes']) assert.equal(gateView({ authEnabled, token: null, unsavedCount: 0 }), 'app', String(authEnabled));
});
