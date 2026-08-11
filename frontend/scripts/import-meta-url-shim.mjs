// esbuild --inject shim: the source (electron/constants.js) uses
// `import.meta.url` to derive its own directory. After bundling to a single
// CommonJS file, only one runtime location exists (the bundle itself), so we
// point the shim one level "deeper" than that (an ./electron/_shim.js that
// does not need to exist on disk) — constants.js's own `resolve(dir, '..')`
// then lands back on the bundle's real directory, exactly reproducing the
// unbundled path math.
import { pathToFileURL } from 'url';
import { join } from 'path';

export const import_meta_url = pathToFileURL(join(__dirname, 'electron', '_shim.js')).href;
