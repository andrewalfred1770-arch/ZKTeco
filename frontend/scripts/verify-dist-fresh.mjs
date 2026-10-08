/**
 * verify-dist-fresh.mjs — guards `frontend/dist` against being packaged stale.
 *
 * `frontend/dist` is generated Vite output (git-ignored, `emptyOutDir: true`). It is
 * a packaging INPUT only: electron-builder copies it to resources/frontend/dist, and
 * the app never reads it from the source tree (in dev the renderer is served by
 * Vite). Every `electron:build*` npm script and CI job rebuilds it first, but a
 * direct `electron-builder` run — or a leftover folder from an earlier session —
 * would silently package an OLD renderer that looks current.
 *
 * Fails (exit 1) when:
 *   - dist/index.html is missing,
 *   - index.html references a script / stylesheet that is not in dist, or
 *   - any renderer source (src/**, index.html, vite.config.js, public/**) is newer
 *     than the build output, i.e. the output does not reflect the current source.
 *
 * Read-only: it never deletes or rebuilds anything.
 * Usage: node scripts/verify-dist-fresh.mjs [frontendDir]   (default: this frontend/ folder)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

// An explicit directory argument is for tests only; the default is this frontend folder.
const FRONTEND = process.argv[2] ? resolve(process.argv[2]) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(FRONTEND, 'dist');
const TOLERANCE_MS = 2000;

let failures = 0;
const fail = (m) => { console.error(`[dist:verify] FAIL: ${m}`); failures++; };
const ok = (m) => console.log(`[dist:verify] OK: ${m}`);

function newestMtime(path, skip = new Set(['node_modules'])) {
  const st = statSync(path);
  if (!st.isDirectory()) return { ms: st.mtimeMs, file: path };
  let best = { ms: 0, file: path };
  for (const name of readdirSync(path)) {
    if (skip.has(name)) continue;
    const r = newestMtime(join(path, name), skip);
    if (r.ms > best.ms) best = r;
  }
  return best;
}

const indexPath = join(DIST, 'index.html');
if (!existsSync(indexPath)) {
  fail(`dist/index.html is missing — run the frontend build first`);
} else {
  const html = readFileSync(indexPath, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  const missing = refs.filter((r) => !/^https?:/.test(r) && !existsSync(join(DIST, r.replace(/^\.?\//, ''))));
  if (!refs.length) fail('dist/index.html references no script — not a Vite build output');
  else if (missing.length) fail(`dist/index.html references files that are not in dist: ${missing.join(', ')}`);
  else ok(`dist/index.html and its ${refs.length} referenced files are consistent`);

  const builtAt = statSync(indexPath).mtimeMs;
  let newest = { ms: 0, file: '' };
  for (const p of ['src', 'public', 'index.html', 'vite.config.js']) {
    const full = join(FRONTEND, p);
    if (!existsSync(full)) continue;
    const r = newestMtime(full);
    if (r.ms > newest.ms) newest = r;
  }
  if (newest.ms > builtAt + TOLERANCE_MS) {
    fail(`dist is STALE: built ${new Date(builtAt).toISOString()}, but ${newest.file.replace(FRONTEND, 'frontend')} changed ${new Date(newest.ms).toISOString()} — rebuild with "npm run build" before packaging`);
  } else {
    ok('dist is not older than the renderer source');
  }
}

if (failures) process.exit(1);
console.log('[dist:verify] dist matches the current source');
