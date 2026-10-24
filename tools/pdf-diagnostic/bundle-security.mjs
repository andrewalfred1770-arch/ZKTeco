// Usage: node bundle-security.mjs <outFile.cjs>
// Bundles the app's REAL electron/security.js (+ its small imports) into one CommonJS file, so electron-runner.cjs can install the app's actual
// guards on any Electron version (ESM in the main process only exists from Electron 28; this is the same trick build-mojave-main.mjs uses).
// Same esbuild options as frontend/scripts/build-mojave-main.mjs. Reads app sources, writes only <outFile.cjs>.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, '..', '..', 'frontend');
const outFile = path.resolve(process.argv[2] || path.join(here, 'out', '_security.bundle.cjs'));
const { buildSync } = createRequire(path.join(frontend, 'package.json'))('esbuild');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
buildSync({
  entryPoints: [path.join(frontend, 'electron', 'security.js')],
  outfile: outFile, bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'error',
  external: ['electron', 'electron-updater', 'socket.io-client'],
  inject: [path.join(frontend, 'scripts', 'import-meta-url-shim.mjs')],
  define: { 'import.meta.url': 'import_meta_url' },
});
console.log('security bundle ->', outFile);
