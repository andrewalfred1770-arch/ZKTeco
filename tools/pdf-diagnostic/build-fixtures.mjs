// Usage: node build-fixtures.mjs <outDir>
// Bundles fixtures-entry.jsx (real app modules, via the frontend's own esbuild/react) and writes one .html per document + manifest.json.
// Needs `npm ci` in frontend/ first. Writes ONLY under <outDir>; never touches the app sources, a database or a device.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, '..', '..', 'frontend');
const outDir = path.resolve(process.argv[2] || path.join(here, 'out', 'fixtures'));
const require = createRequire(path.join(frontend, 'package.json'));
const { buildSync } = require('esbuild');

fs.mkdirSync(outDir, { recursive: true });
const bundle = path.join(outDir, '_fixtures.bundle.cjs');
buildSync({
  entryPoints: [path.join(here, 'fixtures-entry.jsx')],
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error',
  jsx: 'automatic', loader: { '.js': 'jsx' }, nodePaths: [path.join(frontend, 'node_modules')],
  alias: { 'react-hot-toast': path.join(here, 'toast-stub.cjs') },
  inject: [path.join(here, 'shims.cjs')],
});
process.env.PDFDIAG_FRONTEND = frontend;
const { buildAll } = require(bundle);
const docs = buildAll();
const manifest = docs.map((d) => {
  const file = `${d.name}.html`;
  fs.writeFileSync(path.join(outDir, file), d.html, 'utf8');
  return { name: d.name, file, landscape: d.landscape, expect: d.expect, htmlBytes: Buffer.byteLength(d.html) };
});
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
fs.rmSync(bundle);
console.log(`fixtures: ${manifest.length} documents -> ${outDir}`);
for (const m of manifest) console.log(`  ${m.name}  ${m.landscape ? 'landscape' : 'portrait'}  ${m.htmlBytes} bytes`);
