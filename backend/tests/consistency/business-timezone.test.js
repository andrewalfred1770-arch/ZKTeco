/**
 * businessTimezone guard — unit tests (no database, no network, no files). Each case runs in a child process because the guard
 * changes process.env.TZ and Node re-reads it immediately.
 *
 * What is pinned here:
 *   - host zone WEST of UTC (any time of the year)  -> process is moved to Africa/Cairo
 *   - host zone at/east of UTC (UTC, Riyadh, London, Cairo, Kolkata, Berlin, Auckland) -> left exactly as it is
 *   - BUSINESS_TZ valid -> always applied; invalid -> ignored (falls back to the host rule)
 *   - the observable effect: a UTC-midnight DATE reads as the SAME calendar day after the guard
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const GUARD = path.resolve(__dirname, '..', '..', 'src', 'utils', 'businessTimezone.js');

function run(tz, extraEnv = {}) {
  const code = `
    const g = require(${JSON.stringify(GUARD)});
    const before = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const west = g.hostIsWestOfUtc();            // must be read BEFORE the guard moves the process
    const res = g.applyBusinessTimezone();
    const d = new Date('2026-10-14T00:00:00.000Z');
    const pad = (n) => String(n).padStart(2, '0');
    const local = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    console.log('@@' + JSON.stringify({ before, after: Intl.DateTimeFormat().resolvedOptions().timeZone, pinned: res.pinned, local, west }));
  `;
  const env = { ...process.env, TZ: tz, ...extraEnv };
  if (!extraEnv.BUSINESS_TZ) delete env.BUSINESS_TZ;
  const r = spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8' });
  const m = /@@(\{.*\})/.exec(r.stdout || '');
  assert.ok(m, `no result for TZ=${tz}: ${(r.stderr || r.stdout || '').slice(-300)}`);
  return JSON.parse(m[1]);
}

const WEST = ['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Sao_Paulo', 'EST5EDT', 'Etc/GMT+5', 'Pacific/Honolulu'];
const EAST = ['UTC', 'Africa/Cairo', 'Asia/Riyadh', 'Europe/London', 'Asia/Kolkata', 'Europe/Berlin', 'Pacific/Auckland'];

for (const tz of WEST) {
  test(`west of UTC (${tz}): the process is pinned to Africa/Cairo and a UTC-midnight date keeps its calendar day`, () => {
    const r = run(tz);
    assert.equal(r.west, true, 'precondition: this host zone is west of UTC');
    assert.equal(r.pinned, true);
    assert.equal(r.after, 'Africa/Cairo');
    assert.equal(r.local, '2026-10-14');
  });
}

for (const tz of EAST) {
  test(`at/east of UTC (${tz}): untouched, and a UTC-midnight date keeps its calendar day`, () => {
    const r = run(tz);
    assert.equal(r.west, false);
    assert.equal(r.pinned, false);
    assert.equal(r.after, r.before, 'zone unchanged');
    assert.equal(r.local, '2026-10-14');
  });
}

test('without the guard a west-of-UTC host reads the stored date as the PREVIOUS day (the failure the guard exists for)', () => {
  const code = `const d = new Date('2026-10-14T00:00:00.000Z'); console.log('@@' + d.getDate() + '/' + d.getMonth());`;
  const r = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
  assert.match(r.stdout, /@@13\/9/, 'local day is the 13th, not the 14th');
});

test('BUSINESS_TZ (valid) is always applied, even on an east-of-UTC host', () => {
  const r = run('Europe/Berlin', { BUSINESS_TZ: 'Asia/Riyadh' });
  assert.equal(r.pinned, true);
  assert.equal(r.after, 'Asia/Riyadh');
  assert.equal(r.local, '2026-10-14');
});

test('BUSINESS_TZ (invalid) is ignored: east host stays, west host is still pinned to Africa/Cairo', () => {
  const east = run('Asia/Riyadh', { BUSINESS_TZ: 'Not/AZone' });
  assert.equal(east.pinned, false); assert.equal(east.after, 'Asia/Riyadh');
  const west = run('America/New_York', { BUSINESS_TZ: 'Not/AZone' });
  assert.equal(west.pinned, true); assert.equal(west.after, 'Africa/Cairo');
});
