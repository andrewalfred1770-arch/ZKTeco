/**
 * Server LAN address discovery (electron/lanAddress.js). Isolated: pure functions with injected interface lists / .env text and a fake
 * socket factory — no listener, no real socket, no database, no device, no Electron, no file access.
 * Run:  node --test tests/connection/lan-address.test.mjs     (from frontend/)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(here, '..', '..');
const L = await import(pathToFileURL(path.join(FRONTEND, 'electron', 'lanAddress.js')).href);
const read = (...p) => fs.readFileSync(path.join(FRONTEND, ...p), 'utf8');

const nic = (address, over = {}) => ({ address, netmask: '255.255.255.0', family: 'IPv4', mac: 'a4:bb:6d:11:22:33', internal: false, ...over });
const ENV = 'CORS_ORIGINS="https://192.168.1.20,http://localhost:5000"\nTRUST_PROXY=loopback\nDATABASE_URL="mysql://u:secret@h/db"\n';

test('loopback, link-local, public, VPN/CGNAT and virtual adapters are never candidates', () => {
  const nets = {
    Loopback: [nic('127.0.0.1', { internal: true, mac: '00:00:00:00:00:00' })],
    Ethernet: [nic('192.168.1.20')],
    'Ethernet 3': [nic('169.254.7.9')],
    'vEthernet (WSL)': [nic('172.20.0.1', { mac: '00:15:5d:aa:bb:cc' })],
    'VMware Network Adapter VMnet8': [nic('192.168.88.1')],
    Tailscale: [nic('100.101.102.103')],
    'Public NIC': [nic('8.8.4.4')],
    'OpenVPN TAP': [nic('10.8.0.2')],
    'Odd tunnel': [nic('10.9.0.2', { mac: '00:00:00:00:00:00' })],
    'Same MAC vendor VM': [nic('10.5.0.2', { mac: '00:50:56:01:02:03' })],
    'Ethernet 9': [nic('10.7.0.2', { netmask: '255.255.255.255' })],
    V6only: [{ address: 'fe80::1', family: 'IPv6', mac: 'a4:bb:6d:11:22:33', internal: false, netmask: 'ffff:ffff:ffff:ffff::' }],
  };
  const { candidates, excluded } = L.classifyInterfaces(nets);
  assert.deepEqual(candidates, [{ name: 'Ethernet', address: '192.168.1.20' }]);
  const why = Object.fromEntries(excluded.map((e) => [e.address, e.reason]));
  assert.equal(why['127.0.0.1'], 'loopback');
  assert.equal(why['169.254.7.9'], 'link-local');
  assert.equal(why['172.20.0.1'], 'virtual-or-vpn');
  assert.equal(why['100.101.102.103'], 'vpn-or-cgnat');
  assert.equal(why['8.8.4.4'], 'not-private-lan');
  assert.equal(why['10.9.0.2'], 'no-hardware-address');
  assert.equal(why['10.5.0.2'], 'virtual-adapter');
  assert.equal(why['10.7.0.2'], 'host-route');
  assert.ok(!('fe80::1' in why), 'IPv6 is ignored, not listed');
});

test('exactly one LAN adapter => its live address and the https URL from the configured proxy port', () => {
  const info = L.describeLanAddress({ nets: { 'Wi-Fi': [nic('192.168.1.20')] }, envText: ENV });
  assert.equal(info.status, 'ok');
  assert.equal(info.activeAddress, '192.168.1.20');
  assert.equal(info.shareUrl, 'https://192.168.1.20');
  assert.equal(info.originMismatch, false);
  assert.equal(info.reachabilityVerifiedFromOtherDevices, false);
});

test('a non-default proxy port appears in the URL', () => {
  const env = 'CORS_ORIGINS=https://192.168.1.20:8443\n';
  assert.equal(L.describeLanAddress({ nets: { Ethernet: [nic('192.168.1.20')] }, envText: env }).shareUrl, 'https://192.168.1.20:8443');
});

test('CHANGED ADDRESS: the next call shows the new address, flags the stale configured origin, and nothing is remembered', () => {
  const before = L.describeLanAddress({ nets: { Ethernet: [nic('192.168.1.20')] }, envText: ENV });
  const after = L.describeLanAddress({ nets: { Ethernet: [nic('10.0.0.57')] }, envText: ENV });
  assert.equal(before.shareUrl, 'https://192.168.1.20');
  assert.equal(after.activeAddress, '10.0.0.57');
  assert.equal(after.shareUrl, 'https://10.0.0.57');
  assert.equal(after.originMismatch, true, 'the allowed-origin list still names the old address: the owner must be told, nothing is edited');
  assert.ok(!JSON.stringify(after).includes('192.168.1.20') || after.proxy.origins.includes('https://192.168.1.20'), 'the old address only appears as a configured origin');
});

test('AMBIGUOUS: two LAN adapters => no address is chosen, both are listed', () => {
  const info = L.describeLanAddress({ nets: { Ethernet: [nic('192.168.1.20')], 'Wi-Fi': [nic('192.168.1.31', { mac: 'a4:bb:6d:44:55:66' })] }, envText: ENV });
  assert.equal(info.status, 'ambiguous');
  assert.equal(info.activeAddress, null);
  assert.equal(info.shareUrl, null);
  assert.deepEqual(info.candidates.map((c) => c.url), ['https://192.168.1.20', 'https://192.168.1.31']);
});

test('no usable adapter => no-lan, nothing invented', () => {
  const info = L.describeLanAddress({ nets: { Loopback: [nic('127.0.0.1', { internal: true })], Ethernet: [nic('169.254.1.1')] }, envText: ENV });
  assert.equal(info.status, 'no-lan');
  assert.equal(info.activeAddress, null);
  assert.equal(info.shareUrl, null);
  assert.deepEqual(info.candidates, []);
});

test('no https origin configured => address shown, but no URL and no assumed port 443', () => {
  for (const env of [null, '', 'CORS_ORIGINS=http://localhost:5000\n', 'CORS_ORIGINS=https://*.example.com,https://x.example.com/path\n']) {
    const info = L.describeLanAddress({ nets: { Ethernet: [nic('192.168.1.20')] }, envText: env });
    assert.equal(info.status, 'ok');
    assert.equal(info.proxy.state, 'not-configured');
    assert.equal(info.shareUrl, null);
  }
});

test('different https ports in CORS_ORIGINS => conflicting, no URL', () => {
  const info = L.describeLanAddress({ nets: { Ethernet: [nic('192.168.1.20')] }, envText: 'CORS_ORIGINS=https://192.168.1.20,https://192.168.1.20:8443\n' });
  assert.equal(info.proxy.state, 'conflicting');
  assert.equal(info.shareUrl, null);
});

test('the .env parser takes the last assignment, ignores quotes/comments, and nothing else from the file reaches the result', () => {
  const env = 'CORS_ORIGINS=https://old.invalid\nCORS_ORIGINS="https://192.168.1.20"  # note\nJWT_SECRET=topsecretvalue\nPROXY_SHARED_SECRET=anothersecretvalue\n';
  const info = L.describeLanAddress({ nets: { Ethernet: [nic('192.168.1.20')] }, envText: env });
  assert.deepEqual(info.proxy.origins, ['https://192.168.1.20']);
  const blob = JSON.stringify(info);
  assert.ok(!blob.includes('topsecretvalue') && !blob.includes('anothersecretvalue'));
});

test('the backend loopback endpoint is reported as local-only and is never part of any shareable URL', () => {
  const info = L.describeLanAddress({ nets: { Ethernet: [nic('192.168.1.20')] }, envText: ENV, backendPort: 5000 });
  assert.deepEqual(info.localOnly, { backendUrl: 'http://127.0.0.1:5000', shareable: false });
  for (const u of [info.shareUrl, ...info.candidates.map((c) => c.url)]) assert.ok(!/5000|localhost|127\.0\.0\.1/.test(u));
});

test('getLanInfo: the listening check runs only for a single address with a configured port, and its answer is passed through', async () => {
  const calls = [];
  const probe = async (a, p) => { calls.push([a, p]); return false; };
  const one = await L.getLanInfo({ nets: { Ethernet: [nic('192.168.1.20')] }, envText: 'CORS_ORIGINS=https://192.168.1.20:8443', probe });
  assert.deepEqual(calls, [['192.168.1.20', 8443]]);
  assert.equal(one.listening, false);
  assert.equal(one.reachabilityVerifiedFromOtherDevices, false);
  const amb = await L.getLanInfo({ nets: { A: [nic('192.168.1.20')], B: [nic('192.168.1.21', { mac: 'a4:bb:6d:00:00:01' })] }, envText: ENV, probe });
  const none = await L.getLanInfo({ nets: { Ethernet: [nic('192.168.1.20')] }, envText: '', probe });
  assert.equal(calls.length, 1, 'no probe for ambiguous / unconfigured');
  assert.equal(amb.listening, null); assert.equal(none.listening, null);
  assert.equal(typeof one.checkedAt, 'number');
});

test('probePort: connect => true; error / timeout / throw => false; the socket is always destroyed (fake socket, no real network)', async () => {
  const make = (event) => {
    const s = new EventEmitter(); s.destroyed = false; s.destroy = () => { s.destroyed = true; };
    setImmediate(() => s.emit(event, new Error('x')));
    return s;
  };
  for (const [event, want] of [['connect', true], ['error', false], ['timeout', false]]) {
    let sock;
    assert.equal(await L.probePort('192.168.1.20', 443, 50, () => (sock = make(event))), want, event);
    assert.equal(sock.destroyed, true);
  }
  assert.equal(await L.probePort('192.168.1.20', 443, 50, () => { throw new Error('boom'); }), false);
});

test('wiring: IPC is trusted-sender only, read-only, edition-gated; the UI shows the notices; no old hardcoded address; TLS untouched', () => {
  const ipc = read('electron', 'ipc.js');
  assert.match(ipc, /secureHandle\('connection:get-lan-info'/);
  assert.match(ipc, /isStandalone \|\| isManager \|\| readConnectionSettings\(\)\.mode !== 'local'\) return \{ applicable: false \}/);
  assert.match(read('preload.cjs'), /getLanInfo:\s+\(\) => ipcRenderer\.invoke\('connection:get-lan-info'\)/);
  const mod = read('electron', 'lanAddress.js');
  assert.doesNotMatch(mod, /writeFile|appendFile|child_process|execSync|execFile|spawn|netsh|rejectUnauthorized|ignore-certificate|NODE_TLS_REJECT/);
  const page = read('src', 'pages', 'ConnectionSettingsPage.jsx');
  for (const must of ['نفس الشبكة المحلية', 'لم يتم التحقق من الوصول من أجهزة أخرى', 'لا يثبّت شهادات ولا يعطّل التحقق', 'بدون تسجيل دخول', 'navigator.clipboard.writeText']) assert.ok(page.includes(must), must);
  for (const f of [mod, page, read('src', 'components', 'ConnectionWizard.jsx')]) assert.doesNotMatch(f, /192\.168\.1\.(145|10|120)\b/);
});

// ─── plain-HTTP LAN proxy support (http://<private-LAN-IPv4>:<port>) ───────────────────────────────────────────────────────────────────
test('http: a private-LAN http origin with a port gives an http share URL and is flagged as plain http', () => {
  const info = L.describeLanAddress({ nets: { Ethernet: [nic('192.168.1.20')] }, envText: 'CORS_ORIGINS=http://192.168.1.20:8080\n' });
  assert.equal(info.status, 'ok');
  assert.deepEqual([info.proxy.state, info.proxy.scheme, info.proxy.port], ['configured', 'http', 8080]);
  assert.equal(info.shareUrl, 'http://192.168.1.20:8080');
  assert.equal(info.plainHttp, true);
  assert.equal(info.originMismatch, false);
});

test('http: default port 80 is omitted from the URL; https:443 still is too', () => {
  assert.equal(L.describeLanAddress({ nets: { Ethernet: [nic('192.168.1.20')] }, envText: 'CORS_ORIGINS=http://192.168.1.20\n' }).shareUrl, 'http://192.168.1.20');
  const https = L.describeLanAddress({ nets: { Ethernet: [nic('192.168.1.20')] }, envText: 'CORS_ORIGINS=https://192.168.1.20\n' });
  assert.equal(https.shareUrl, 'https://192.168.1.20');
  assert.equal(https.plainHttp, false);
});

test('http: loopback, names, public hosts, wildcards, credentials, paths and other schemes are never used', () => {
  const bad = [
    'http://localhost:5000', 'http://127.0.0.1:5100', 'http://server-pc:8080', 'http://printer.local:8080', 'http://8.8.8.8:8080',
    'http://192.168.1.20.evil.com:8080', 'http://192.168.1.*:8080', 'http://u:p@192.168.1.20:8080', 'http://192.168.1.20:8080/path',
    'http://192.168.1.20:8080/', 'http://192.168.1.20:8080?x=1', 'ftp://192.168.1.20:8080', 'http://[::1]:8080', 'http://169.254.1.1:8080',
  ];
  for (const o of bad) {
    const info = L.describeLanAddress({ nets: { Ethernet: [nic('192.168.1.20')] }, envText: `CORS_ORIGINS=${o}\n` });
    assert.equal(info.proxy.state, 'not-configured', o);
    assert.equal(info.shareUrl, null, o);
  }
});

test('http: two different scheme/port pairs are ambiguous - no URL is guessed (e.g. https:443 plus http:8080)', () => {
  for (const env of ['https://192.168.1.20,http://192.168.1.20:8080', 'http://192.168.1.20:8080,http://192.168.1.20:8081', 'http://192.168.1.20:8443,https://192.168.1.20:8443']) {
    const info = L.describeLanAddress({ nets: { Ethernet: [nic('192.168.1.20')] }, envText: `CORS_ORIGINS=${env}\n` });
    assert.equal(info.proxy.state, 'conflicting', env);
    assert.equal(info.shareUrl, null, env);
  }
});

test('http: the live address is recomputed; an address missing from CORS_ORIGINS is reported as a mismatch, never edited', () => {
  const info = L.describeLanAddress({ nets: { Ethernet: [nic('10.0.0.57')] }, envText: 'CORS_ORIGINS=http://192.168.1.20:8080\n' });
  assert.equal(info.shareUrl, 'http://10.0.0.57:8080');
  assert.equal(info.originMismatch, true);
  assert.deepEqual(info.proxy.origins, ['http://192.168.1.20:8080']);
});

test('http: parseHttpsOrigins keeps returning https origins only, in the old shape', () => {
  assert.deepEqual(L.parseHttpsOrigins('CORS_ORIGINS=http://192.168.1.20:8080,https://192.168.1.20:8443\n'), [{ origin: 'https://192.168.1.20:8443', host: '192.168.1.20', port: 8443 }]);
  assert.deepEqual(L.parseProxyOrigins('CORS_ORIGINS=http://192.168.1.20:8080,https://192.168.1.20:8443\n').map((o) => o.scheme), ['http', 'https']);
});

test('http: getLanInfo probes the configured http port (TCP connect only)', async () => {
  const calls = [];
  const probe = async (a, p) => { calls.push([a, p]); return true; };
  const info = await L.getLanInfo({ nets: { Ethernet: [nic('192.168.1.20')] }, envText: 'CORS_ORIGINS=http://192.168.1.20:8080', probe });
  assert.deepEqual(calls, [['192.168.1.20', 8080]]);
  assert.equal(info.listening, true);
});

test('default server address: only a Manager client is pre-filled; it stays a plain value the user can overwrite; no UI file hardcodes it', () => {
  const consts = read('electron', 'constants.js');
  const m = consts.match(/export const DEFAULT_SERVER_URL = '(http:\/\/[0-9.]+:\d+)';/);
  assert.ok(m, 'DEFAULT_SERVER_URL is a plain http://<ip>:<port> constant');
  const cs = read('electron', 'connectionSettings.js');
  assert.match(cs, /serverUrl: \(isManager && !isStandalone\) \? DEFAULT_SERVER_URL : ''/);
  assert.match(cs, /return \{ \.\.\.DEFAULTS, \.\.\.raw \};/, 'a saved value (even an empty one) overrides the default');
  assert.match(read('electron', 'ipc.js'), /isManager && patch\.serverUrl && isSelfPointingServerUrl\(patch\.serverUrl\)/, 'the self-pointing guard is untouched');
});
