// Usage: node run-local.mjs --electron <path-to-electron-binary> --out <dir> [--variants asis,visible,...]
// Local/CI driver: build fixtures from the real app modules + bundle the real electron/security.js -> run electron-runner.cjs -> analyze.py.
// Writes only under --out. --logging adds Chromium's own stderr log (noisy; useful on macOS runs). Variants: see electron-runner.cjs.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const electron = arg('electron'); const out = path.resolve(arg('out', path.join(here, 'out'))); const variants = arg('variants', '');
if (!electron) { console.error('usage: node run-local.mjs --electron <electron binary> --out <dir> [--variants a,b] [--logging]'); process.exit(2); }
const run = (cmd, args, opt = {}) => { const r = spawnSync(cmd, args, { stdio: 'inherit', ...opt }); if (r.status !== 0 && !opt.soft) { console.error(`failed: ${cmd} ${args.join(' ')} (${r.status})`); process.exit(r.status || 1); } return r; };
const fixtures = path.join(out, 'fixtures');
run('node', [path.join(here, 'build-fixtures.mjs'), fixtures]);
const securityBundle = path.join(out, '_security.bundle.cjs');
run('node', [path.join(here, 'bundle-security.mjs'), securityBundle]);
run(electron, [...(process.argv.includes('--logging') ? ['--enable-logging=stderr'] : []), path.join(here, 'electron-runner.cjs'), fixtures, out, ...(variants ? [variants] : [])], { soft: true, timeout: 900000, env: { ...process.env, PDFDIAG_SECURITY: securityBundle } });
run(process.platform === 'win32' ? 'python' : 'python3', [path.join(here, 'analyze.py'), out, fixtures]);
