/**
 * Regression guard (static, no rendering): calendar dates must not be turned into a Date and then read through LOCAL getters.
 * A "calendar date" reaches the renderer either as 'YYYY-MM-DD' (new Date(...) = UTC midnight) or as a UTC-midnight ISO timestamp from a
 * @db.Date column. Reading either through toLocaleDateString / getDate / getDay / getMonth / getFullYear shows the PREVIOUS day on a client
 * west of UTC. Likewise toISOString().slice(0,10) is the UTC date, which is not the local calendar day.
 *
 * Two tests:
 *   1. NO NEW offenders  - the set of flagged call sites must equal the recorded baseline (a new offender, or a baseline site that was
 *      changed without updating this list, fails). Hard assertion.
 *   2. no offenders at all - the flagged set must be empty.
 * Safe patterns that are NOT flagged: new Date(v + 'T00:00'), new Date(y, m-1, d), Date.UTC(...), parsing the string prefix, and
 * instants (timestamps) that are formatted with a time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const PATTERNS = [
  /new Date\(\s*[A-Za-z_$][\w$.\[\]?]*\s*\)\s*\.(?:toLocaleDateString|getDate|getDay|getMonth|getFullYear)\(/g,
  /toISOString\(\)\s*\.\s*(?:slice|substring|split)\(/g,
];

function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'fonts') files(p, out); } else if (/\.(jsx?|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
function offenders() {
  const found = [];
  for (const f of files(SRC)) {
    const rel = path.relative(SRC, f).replace(/\\/g, '/');
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      if (/^\s*(\/\/|\*)/.test(line)) continue;                      // comments
      for (const re of PATTERNS) for (const m of line.matchAll(re)) found.push(`${rel} :: ${m[0].replace(/\s+/g, '')}`);
    }
  }
  return found.sort();
}

// Known offenders still present (see renderer-timezone.test.mjs). Empty since the six sites in HolidaysPage, AttendanceDailyPage,
// DataCleanupPage and printUtils were fixed; an entry may only be added deliberately, with a justification.
const BASELINE = [];

test('no NEW date-only / UTC-midnight value is read through local getters (baseline = the known defects)', () => {
  const now = offenders();
  const added = now.filter((x) => !BASELINE.includes(x));
  const gone = BASELINE.filter((x) => !now.includes(x));
  assert.deepEqual(added, [], `new offender(s): ${added.join('; ')}`);
  assert.deepEqual(gone, [], `baseline site(s) no longer flagged - remove them from BASELINE: ${gone.join('; ')}`);
});

test('baseline offenders are all fixed', () => {
  assert.deepEqual(offenders(), []);
});
