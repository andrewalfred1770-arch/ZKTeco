// Bundles frontend/electron.js (ESM main process, requires Electron 28+) into
// a single CommonJS file for the Mojave/Electron 26 build, which cannot
// require() an ES module. Modern build (electron.js, "type":"module") is
// untouched — this only produces an additional, separate artifact.
import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(__dirname, '..');

await build({
  entryPoints: [resolve(frontendRoot, 'electron.js')],
  outfile: resolve(frontendRoot, 'electron.mojave.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['electron', 'electron-updater', 'socket.io-client'],
  inject: [resolve(__dirname, 'import-meta-url-shim.mjs')],
  define: { 'import.meta.url': 'import_meta_url' },
  logLevel: 'info',
});

console.log('[build-mojave-main] wrote electron.mojave.cjs');
