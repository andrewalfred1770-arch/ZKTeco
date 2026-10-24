/**
 * "CheckIn Mac" build identity and version consistency. Pure file reads: no Electron, no network, no database, no device.
 * Run:  node --test tests/connection/mac-identity.test.mjs     (from frontend/)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(here, '..', '..');
const ROOT = path.resolve(FRONTEND, '..');
const text = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const json = (...p) => JSON.parse(text(...p));

const EXPECTED_VERSION = '1.1.5';

test('one version everywhere: package.json (both), lockfile roots and the version shown in the UI are all the server version', () => {
  assert.equal(json(FRONTEND, 'package.json').version, EXPECTED_VERSION);
  assert.equal(json(ROOT, 'backend', 'package.json').version, EXPECTED_VERSION);
  for (const dir of [FRONTEND, path.join(ROOT, 'backend')]) {
    const lock = json(dir, 'package-lock.json');
    assert.equal(lock.version, EXPECTED_VERSION, `${dir} lockfile root`);
    assert.equal(lock.packages[''].version, EXPECTED_VERSION, `${dir} lockfile packages[""]`);
  }
  const m = text(FRONTEND, 'src', 'lib', 'branding.js').match(/^\s*version:\s*'([^']+)'/m);
  assert.ok(m, 'branding.js declares a version');
  assert.equal(m[1], EXPECTED_VERSION, 'the version shown in the UI');
});

test('CheckIn Mac: final product name, Intel only, Catalina minimum, pinned Electron, no backend bundled', () => {
  const c = json(FRONTEND, 'electron-builder.mac-intel.json');
  assert.equal(c.productName, 'CheckIn Mac');
  assert.equal(c.electronVersion, '32.3.3');
  assert.equal(c.mac.minimumSystemVersion, '10.15.0');
  assert.deepEqual(c.mac.target.map((t) => `${t.target}:${t.arch.join(',')}`).sort(), ['dmg:x64', 'zip:x64']);
  assert.match(c.mac.artifactName, /^CheckIn-Mac-\$\{version\}-\$\{arch\}\.\$\{ext\}$/);
  assert.match(c.dmg.artifactName, /^CheckIn-Mac-\$\{version\}-\$\{arch\}\.\$\{ext\}$/);
  assert.equal(c.directories.output, '../dist-electron-mac-intel');
  assert.ok(!JSON.stringify(c).includes('../backend'), 'a client must not bundle the backend');
});

test('identity kept on purpose: same appId and packaged name as the Manager build, and edition.js recognises that name (otherwise it would start as Server)', () => {
  const mac = json(FRONTEND, 'electron-builder.mac-intel.json');
  const manager = json(FRONTEND, 'electron-builder.manager.json');
  assert.equal(mac.appId, manager.appId, 'appId (bundle identifier / Keychain / permissions) is unchanged');
  assert.equal(mac.extraMetadata.name, manager.extraMetadata.name, 'packaged name = user-data folder + update cache + edition detection');
  const m = text(FRONTEND, 'electron', 'edition.js').match(/const PACKAGED_MANAGER_NAME\s*=\s*'([^']+)'/);
  assert.ok(m, 'edition.js declares PACKAGED_MANAGER_NAME');
  assert.equal(mac.extraMetadata.name, m[1], 'the packaged name is the one edition.js maps to the Manager edition');
});

test('update source of the Mac build is the Manager feed (no GitHub provider), and the updater still refuses downgrades', () => {
  const c = json(FRONTEND, 'electron-builder.mac-intel.json');
  assert.deepEqual(c.publish.map((p) => p.provider), ['generic']);
  assert.equal(c.publish[0].url, json(FRONTEND, 'electron-builder.manager.json').publish[0].url);
  assert.match(text(FRONTEND, 'electron', 'updater.js'), /autoUpdater\.allowDowngrade = false;/);
});

test('npm script and CI workflow point at the same config; the workflow checks the final name, the bundle id and the version', () => {
  const pj = json(FRONTEND, 'package.json');
  assert.match(pj.scripts['electron:build:manager:mac:intel'], /--config electron-builder\.mac-intel\.json/);
  assert.match(pj.scripts['electron:build:manager:mac:intel'], /build:manager/, 'the renderer is built with --mode manager (VITE_EDITION=manager)');
  const wf = text(ROOT, '.github', 'workflows', 'build-mac-intel.yml');
  assert.ok(wf.includes('CheckIn Mac.app'));
  assert.ok(wf.includes('com.petshrow.erp.manager'));
  assert.ok(wf.includes('"1.1.5"'));
  assert.match(wf, /^on:\s*\n\s+workflow_dispatch:/m, 'manual trigger only');
});

test('brand text: the old product name is gone from the connection screens a Manager user sees, the CheckIn wording is there', () => {
  const wizard = text(FRONTEND, 'src', 'components', 'ConnectionWizard.jsx');
  const settings = text(FRONTEND, 'src', 'pages', 'ConnectionSettingsPage.jsx');
  // rendered strings (JSX text), not comments: the three headings + the sentence under them
  for (const old of ['>الاتصال بخادم PETSHROW ERP<', '>PETSHROW ERP Manager — Connect to Server<', 'أدخل عنوان خادم PETSHROW ERP']) {
    assert.ok(!wizard.includes(old), `ConnectionWizard still shows: ${old}`);
  }
  assert.ok(wizard.includes('>الاتصال بخادم CheckIn<'));
  assert.ok(wizard.includes('>CheckIn — Connect to Server<'));
  assert.ok(wizard.includes('أدخل عنوان خادم CheckIn المشغّل على الشبكة.'));
  assert.ok(!/^\s*خادم PETSHROW\s*$/m.test(settings), 'the "خادم PETSHROW" heading is replaced');
  assert.ok(/^\s*خادم CheckIn\s*$/m.test(settings));
});

test('brand text: internal names that must NOT change stay (printed documents, export file names, data-folder identity, edition detection)', () => {
  const branding = text(FRONTEND, 'src', 'lib', 'branding.js');
  assert.match(branding, /company:\s+'PETSHROW'/, 'company name printed on reports');
  assert.match(branding, /product:\s+'PETSHROW ERP'/);
  assert.match(branding, /export const FILE_PREFIX = 'PETSHROW'/, 'export file-name prefix');
  assert.match(branding, /appName:\s+'CheckIn'/, 'on-screen product name');
  assert.match(text(FRONTEND, 'electron', 'constants.js'), /export const APP_NAME\s+= 'PETSHROW ERP'/, 'data-folder identity');
  assert.match(text(FRONTEND, 'electron', 'constants.js'), /export const DISPLAY_NAME = 'CheckIn'/, 'window title / tray');
  assert.match(text(FRONTEND, 'electron', 'edition.js'), /PACKAGED_MANAGER_NAME\s*=\s*'petshrow-erp-manager'/);
});

test('connection: Manager talks to the saved server (no local backend), Socket.IO is not websocket-only, settings are saved atomically and restored', () => {
  const sock = text(FRONTEND, 'src', 'lib', 'socket.js');
  const opts = sock.slice(sock.indexOf('socketIO(backendBase, {'), sock.indexOf('socketIO(backendBase, {') + 500);
  assert.ok(opts.includes('socketIO(backendBase, {'), 'the socket is created from the resolved backend base URL');
  assert.ok(!/transports\s*:/.test(opts), 'no transports option: polling first, then upgrade; a refused upgrade keeps working on polling');
  assert.match(opts, /reconnection:\s*true/);
  assert.match(opts, /reconnectionAttempts:\s*Infinity/);
  assert.match(text(FRONTEND, 'src', 'lib', 'api.js'), /baseURL:\s*`\$\{backendBase\}\/api`/, 'REST uses the same resolved base URL');
  const life = text(FRONTEND, 'electron', 'lifecycle.js');
  assert.match(life, /if \(isManager\) \{\s*\n\s*resolvedSettings\.mode = 'server';/, 'a Manager is always in server mode');
  assert.match(life, /skipping local backend spawn, connecting to/, 'no backend is spawned in server mode');
  const cs = text(FRONTEND, 'electron', 'connectionSettings.js');
  assert.match(cs, /renameSync\(tmp, file\)/, 'atomic save: temp file + rename');
  assert.match(cs, /return \{ \.\.\.DEFAULTS, \.\.\.raw \};/, 'a saved value overrides the default');
  assert.match(text(FRONTEND, 'electron', 'constants.js'), /DEFAULT_SERVER_URL = 'http:\/\/192\.168\.1\.145:8080'/);
});
