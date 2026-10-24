// Fails (exit 1) unless electron.mojave.cjs exists, contains the setup-auth main-process code, and is not older than the sources it is
// bundled from. Run automatically by `build:mojave-main` and again right before electron-builder in `electron:build:mac:legacy`.
// Read-only: it never writes or regenerates the bundle.
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { checkBundleText } from './mojave-bundle-check.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = resolve(root, 'electron.mojave.cjs');
const fail = (msg) => { console.error(`[verify-mojave-main] FAILED: ${msg}\n  Run "npm run build:mojave-main" and do not package a stale electron.mojave.cjs.`); process.exit(1); };

if (!existsSync(bundle)) fail('electron.mojave.cjs does not exist');
const r = checkBundleText(readFileSync(bundle, 'utf8'));
if (!r.ok) fail(`bundle is missing setup-auth code (${r.missing.join(', ')})`);

const sources = [resolve(root, 'electron.js'), ...readdirSync(resolve(root, 'electron')).filter((f) => /\.(m?js|cjs)$/.test(f)).map((f) => join(root, 'electron', f))];
const builtAt = statSync(bundle).mtimeMs;
const newer = sources.filter((f) => statSync(f).mtimeMs > builtAt + 1000);
if (newer.length) fail(`bundle is older than: ${newer.map((f) => f.slice(root.length + 1)).join(', ')}`);

console.log('[verify-mojave-main] ok — electron.mojave.cjs contains the setup-auth handler and is newer than its sources');
