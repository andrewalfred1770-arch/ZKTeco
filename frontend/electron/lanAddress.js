// Read-only discovery of the address a LAN client would use to reach this server PC (connection page, "Server" edition, local mode).
//
// Nothing here changes any setting: no adapter/IP/firewall/proxy/allow-list/certificate is touched, nothing is persisted (every call
// recomputes from the live interface list, so a changed address shows up on the next refresh and an old one is never remembered), and
// no secret is read — only two non-secret keys (CORS_ORIGINS, TRUST_PROXY) are extracted from the .env text.
//
// What this module can and cannot know (and the UI must say so):
//   - Node reports only addresses that are currently assigned; it cannot report link state, gateway or metric. "Active" therefore means
//     "assigned right now on a non-virtual private-range adapter". When more than one such adapter exists the answer is AMBIGUOUS and
//     every candidate is listed — no address is invented or guessed.
//   - The LAN proxy (Caddy) is not part of this app. Its scheme and port are taken from the origins in CORS_ORIGINS (the backend only accepts
//     browser origins listed there): https origins, and http origins ONLY when the host is a private-LAN IPv4 literal (never localhost, a
//     name or a public address). No usable origin => the port is unknown and no URL is produced (443 is never assumed). An http URL is
//     plain text on the wire; the UI says so.
//   - `listening` (see probePort) only proves that something accepts TCP connections on this PC at that address. It does NOT prove that
//     other devices can reach it (firewall/router/Wi-Fi isolation/allow-list/certificate trust are all unchecked).
import net from 'net';

const VIRTUAL_NAME = /vethernet|virtualbox|vbox|vmware|vmnet|hyper-?v|\bwsl\b|docker|podman|veth|virbr|\bbr-|tailscale|zerotier|hamachi|wireguard|nordlynx|proton|openvpn|\bvpn\b|\btap\b|\btun\b|tap-|tun\d|utun|bluetooth|isatap|teredo|npcap|pseudo|loopback|\bppp\d?\b/i;
const VIRTUAL_MAC_PREFIXES = ['00:50:56', '00:0c:29', '00:05:69', '00:1c:14', '08:00:27', '00:15:5d', '52:54:00', '00:03:ff'];

const ipv4Parts = (a) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(a || ''));
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n >= 0 && n <= 255) ? p : null;
};
const isPrivate = ([a, b]) => a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
const prefixLen = (mask) => {
  const p = ipv4Parts(mask);
  if (!p) return null;
  return p.map((n) => n.toString(2).padStart(8, '0')).join('').split('').filter((c) => c === '1').length;
};
const isV4 = (iface) => iface && (iface.family === 'IPv4' || iface.family === 4);

/**
 * @param {Record<string, Array<{address:string,netmask?:string,family:string|number,mac?:string,internal?:boolean}>>} nets  os.networkInterfaces()
 * @returns {{candidates:Array<{name:string,address:string}>, excluded:Array<{name:string,address:string,reason:string}>}}
 */
export function classifyInterfaces(nets) {
  const candidates = [];
  const excluded = [];
  const seen = new Set();
  for (const name of Object.keys(nets || {}).sort()) {
    for (const iface of nets[name] || []) {
      if (!isV4(iface)) continue;
      const address = String(iface.address || '');
      const why = (reason) => excluded.push({ name, address, reason });
      const p = ipv4Parts(address);
      if (!p) { why('invalid'); continue; }
      if (iface.internal || p[0] === 127 || p[0] === 0) { why('loopback'); continue; }
      if (p[0] === 169 && p[1] === 254) { why('link-local'); continue; }
      if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) { why('vpn-or-cgnat'); continue; }
      if (!isPrivate(p)) { why('not-private-lan'); continue; }
      if (VIRTUAL_NAME.test(name)) { why('virtual-or-vpn'); continue; }
      const mac = String(iface.mac || '').toLowerCase();
      if (!mac || /^(00:){5}00$/.test(mac)) { why('no-hardware-address'); continue; }
      if (VIRTUAL_MAC_PREFIXES.some((pre) => mac.startsWith(pre))) { why('virtual-adapter'); continue; }
      if (prefixLen(iface.netmask) === 32) { why('host-route'); continue; }
      if (seen.has(address)) continue;
      seen.add(address);
      candidates.push({ name, address });
    }
  }
  return { candidates, excluded };
}

/** Last assignment wins, quotes / inline comment ignored — same shape as the backend's dotenv read for these two keys. */
function envValue(text, key) {
  let found = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=(.*)$`));
    if (m) found = m[1];
  }
  if (found === null) return null;
  let v = found.trim();
  const q = v[0];
  if (q === '"' || q === "'") { const end = v.indexOf(q, 1); v = end > 0 ? v.slice(1, end) : v.slice(1); } else { v = v.replace(/\s+#.*$/, ''); }
  return v.trim();
}

/**
 * Mirrors backend/src/config/corsPolicy.js#parseCorsOrigins for the origins a LAN client can be given.
 * https: any bare https origin. http: only a bare http origin whose host is a private-LAN IPv4 literal (so http://localhost:5000, http://name
 * and any public host are ignored, exactly as before). Each entry: { origin, scheme, host, port } (default ports: https 443, http 80).
 */
export function parseProxyOrigins(envText) {
  const raw = envValue(envText, 'CORS_ORIGINS') || '';
  const out = [];
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    let u;
    try { u = new URL(entry); } catch { continue; }
    const scheme = u.protocol === 'https:' ? 'https' : (u.protocol === 'http:' ? 'http' : null);
    const bare = scheme && !entry.includes('*') && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash && !/\/$/.test(entry);
    if (!bare) continue;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (scheme === 'http') {
      const p = ipv4Parts(host);
      if (!p || !isPrivate(p)) continue;
    }
    const port = u.port ? Number(u.port) : (scheme === 'https' ? 443 : 80);
    if (!out.some((o) => o.origin === u.origin)) out.push({ origin: u.origin, scheme, host, port });
  }
  return out;
}

/** https origins only (kept for callers/tests written before http support). */
export function parseHttpsOrigins(envText) {
  return parseProxyOrigins(envText).filter((o) => o.scheme === 'https').map(({ origin, host, port }) => ({ origin, host, port }));
}

const urlFor = (address, port, scheme = 'https') => {
  const isDefault = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80);
  return isDefault ? `${scheme}://${address}` : `${scheme}://${address}:${port}`;
};

/**
 * @param {{nets:object, envText?:string|null, backendPort?:number}} input
 * @returns a plain, secret-free object for the renderer
 */
export function describeLanAddress({ nets, envText = null, backendPort = 5000 } = {}) {
  const { candidates, excluded } = classifyInterfaces(nets);
  const origins = parseProxyOrigins(envText);
  // One (scheme, port) pair is required: two different pairs (e.g. https:443 and http:8080) are ambiguous and no URL is guessed.
  const pairs = [...new Set(origins.map((o) => `${o.scheme}:${o.port}`))];

  let proxy;
  if (!origins.length) proxy = { state: 'not-configured', scheme: null, port: null, origins: [] };
  else if (pairs.length > 1) proxy = { state: 'conflicting', scheme: null, port: null, origins: origins.map((o) => o.origin) };
  else proxy = { state: 'configured', scheme: origins[0].scheme, port: origins[0].port, origins: origins.map((o) => o.origin) };

  const status = candidates.length === 0 ? 'no-lan' : candidates.length === 1 ? 'ok' : 'ambiguous';
  const activeAddress = status === 'ok' ? candidates[0].address : null;
  const shareUrl = status === 'ok' && proxy.state === 'configured' ? urlFor(activeAddress, proxy.port, proxy.scheme) : null;

  // The backend accepts a browser origin only if it is listed exactly in CORS_ORIGINS. If the live address is not, a browser opening
  // the shown URL would be refused — report it; the owner changes the list (never done automatically).
  const originListed = (addr) => proxy.origins.some((o) => o === urlFor(addr, proxy.port, proxy.scheme));
  const originMismatch = status === 'ok' && proxy.state === 'configured' && !originListed(activeAddress);

  return {
    applicable: true,
    status,
    activeAddress,
    candidates: candidates.map((c) => ({
      ...c,
      url: proxy.state === 'configured' ? urlFor(c.address, proxy.port, proxy.scheme) : null,
    })),
    excludedCount: excluded.length,
    excluded: excluded.map(({ name, address, reason }) => ({ name, address, reason })),
    proxy,
    shareUrl,
    // true => the shown URL is plain http: nothing on the wire is encrypted (the UI must say so).
    plainHttp: proxy.state === 'configured' && proxy.scheme === 'http',
    originMismatch,
    // Shown so the owner can tell "this PC's own backend" apart from the shareable address. Never shareable.
    localOnly: { backendUrl: `http://127.0.0.1:${backendPort}`, shareable: false },
    reachabilityVerifiedFromOtherDevices: false,
    listening: null,
  };
}

/** TCP connect only (no TLS, no bytes sent). true = something accepts connections at address:port on this PC; says nothing about other devices. */
export function probePort(address, port, timeoutMs = 1000, connect = net.connect) {
  return new Promise((resolve) => {
    let done = false;
    let sock;
    const finish = (v) => { if (done) return; done = true; try { sock && sock.destroy(); } catch { /* already closed */ } resolve(v); };
    try {
      sock = connect({ host: address, port, timeout: timeoutMs });
      sock.once('connect', () => finish(true));
      sock.once('timeout', () => finish(false));
      sock.once('error', () => finish(false));
    } catch { finish(false); }
  });
}

/** describeLanAddress + the local listening check (only when there is exactly one address and a configured port). */
export async function getLanInfo({ nets, envText, backendPort, probe = probePort } = {}) {
  const info = describeLanAddress({ nets, envText, backendPort });
  if (info.status === 'ok' && info.proxy.state === 'configured') info.listening = await probe(info.activeAddress, info.proxy.port);
  info.checkedAt = Date.now();
  return info;
}
