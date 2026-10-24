/**
 * Renderer time-zone tests — isolated: synthetic data, mocked API, fixed clock, NO database, NO backend, NO devices, NO Electron/EXE.
 * Each case runs in a child process whose TZ is set to the zone under test (render-harness.mjs bundles the REAL page source).
 *
 * History: 13 of these cases were written first as `todo` (confirmed, reproduced defects: the renderer read UTC-midnight calendar days
 * through local getters). They asserted the correct behaviour from the start; the `todo` flags were removed once the four renderer files
 * were fixed, so every assertion now runs as a normal test.
 *
 * Run:  node --test tests/tz/renderer-timezone.test.mjs      (from frontend/)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(here, '..', '..');
const HARNESS = path.join(here, 'render-harness.mjs');
const ZONES = ['Asia/Riyadh', 'America/New_York', 'Pacific/Honolulu'];

function child(args, { tz, now, fixtures = {}, extraEnv = {} }) {
  const r = spawnSync(process.execPath, args, {
    cwd: FRONTEND, encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TZ: tz, FAKE_NOW: now || '2026-10-14T10:00:00Z', FIXTURES: JSON.stringify(fixtures), ...extraEnv },
  });
  const m = /@@RESULT@@(\{.*\})/s.exec(r.stdout || '');
  assert.ok(m, `no result for ${args.join(' ')} TZ=${tz}: ${(r.stderr || r.stdout || '').slice(-600)}`);
  return JSON.parse(m[1]);
}
const render = (scenario, opts) => child([HARNESS, scenario], opts);

// Expected labels computed WITHOUT depending on the process zone: a calendar day is formatted from noon UTC with timeZone:'UTC'.
const calendarLabel = (y, m, d, opts) => new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('ar-EG', { timeZone: 'UTC', ...opts });

// ───────────────────────────── 1. date helpers (src/lib/businessDate.js, formatters.js) ─────────────────────────────
// (the real modules are bundled by the harness: formatters.js uses Vite-style extension-less imports that plain Node cannot load)
for (const tz of ZONES) {
  test(`helpers [${tz}]: date-only arithmetic, string prefixes, local-midnight headers and weekdays are zone-independent`, () => {
    const r = render('helpers', { tz });
    assert.equal(r.addDays_month_end, '2026-11-01');
    assert.equal(r.addDays_back, '2026-02-28');
    assert.equal(r.addDays_year, '2027-01-01');
    assert.deepEqual(r.monthBounds_feb, { from: '2026-02-01', to: '2026-02-28' });
    assert.deepEqual(r.monthBounds_oct, { from: '2026-10-01', to: '2026-10-31' });
    assert.equal(r.fmtDate_isoUtcMidnight, '2026-10-14', 'a business date string keeps its date prefix');
    assert.equal(r.fmtDate_plain, '2026-10-14');
    assert.equal(r.instant_local_day, '2026-10-14');
    assert.equal(r.weekday_header_2026_10_14, '14-3', 'Wednesday the 14th');
    assert.equal(r.weekday_header_2026_11_01, '1-0', 'Sunday the 1st');
  });
}

// ───────────────────────────── 2. HolidaysPage.jsx — month card and day label ─────────────────────────────
const HOLIDAYS = [
  { id: 1, name: 'H-NOV1', date: '2026-11-01T00:00:00.000Z' },     // the 1st of a month: the worst case for a one-day shift
  { id: 2, name: 'H-OCT14', date: '2026-10-14T00:00:00.000Z' },
];
function holidayCards(html) {
  return html.split('<div class="card p-4">').slice(1).map((c) => ({
    month: (/gap-2">([^<]+)/.exec(c) || [])[1],
    items: [...c.matchAll(/text-gray-200">([^<]+)<\/p><p class="text-xs text-gray-500">([^<]+)</g)].map((m) => ({ name: m[1], label: m[2] })),
  }));
}
for (const tz of ZONES) {
  test(`HolidaysPage [${tz}]: a holiday on 1 Nov is in the November card and labelled with its own day`,async () => {
    const cards = holidayCards(render('holidays', { tz, fixtures: { '/holidays': HOLIDAYS } }).html);
    const where = (name) => cards.find((c) => c.items.some((i) => i.name === name));
    assert.equal(where('H-NOV1')?.month, 'نوفمبر', 'H-NOV1 belongs to the November card');
    assert.equal(where('H-OCT14')?.month, 'أكتوبر');
    assert.equal(where('H-NOV1').items.find((i) => i.name === 'H-NOV1').label, calendarLabel(2026, 11, 1, { weekday: 'short', day: 'numeric' }));
    assert.equal(where('H-OCT14').items.find((i) => i.name === 'H-OCT14').label, calendarLabel(2026, 10, 14, { weekday: 'short', day: 'numeric' }));
  });
}

// ───────────────────────────── 3. AttendanceDailyPage.jsx — day title ─────────────────────────────
for (const tz of ZONES) {
  test(`AttendanceDailyPage [${tz}]: the title names the same day as the date picker (2026-10-14)`,() => {
    const html = render('daily', { tz, now: '2026-10-14T10:00:00Z' }).html;
    assert.match(html, /value="2026-10-14"/, 'precondition: the picker holds 2026-10-14');
    const title = (/[^<>"]{0,40}أكتوبر[^<>"]{0,12}/.exec(html) || [''])[0];
    assert.ok(title.includes(calendarLabel(2026, 10, 14, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })), `title was "${title}"`);
  });
}

// ───────────────────────────── 4. DataCleanupPage.jsx — history range ─────────────────────────────
const CLEANUP = [{ id: 1, fromDate: '2026-10-14T00:00:00.000Z', toDate: '2026-10-20T00:00:00.000Z', createdAt: '2026-10-21T08:00:00.000Z',
  executedByName: 'QA', rawLogsDeleted: 1, dailyDeleted: 2, payrollDeleted: 0, employeesAffected: 3 }];
for (const tz of ZONES) {
  test(`DataCleanupPage [${tz}]: the history shows the stored from/to calendar days (14 Oct → 20 Oct)`,() => {
    const html = render('cleanup', { tz, fixtures: { '/cleanup/logs': CLEANUP } }).html;
    const line = (/class="text-gray-300">([^<]*)</.exec(html) || [])[1];
    assert.equal(line, `${calendarLabel(2026, 10, 14, {})} → ${calendarLabel(2026, 10, 20, {})}`);
  });
}

// ───────────────────────────── 5. printUtils.js — export file name date ─────────────────────────────
// expected = the LOCAL calendar day of the instant in the process zone (what the user sees on the clock/calendar).
const localDay = (instantIso, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(instantIso));
const fileDate = (r) => (/_(\d{4}-\d{2}-\d{2})\.xlsx$/.exec(r.files[0]) || [])[1];
const CASES = [
  { tz: 'Africa/Cairo', at: '2026-10-13T21:00:00Z', note: '00:00 local (Cairo, UTC+3 on this date)' },
  { tz: 'Africa/Cairo', at: '2026-10-13T21:30:00Z', note: '00:30 local' },
  { tz: 'Africa/Cairo', at: '2026-10-13T23:59:00Z', note: '02:59 local' },
  { tz: 'Africa/Cairo', at: '2026-10-14T00:01:00Z', note: '03:01 local (control: UTC date equals local date)' },
  { tz: 'Asia/Riyadh', at: '2026-10-13T22:15:00Z', note: '01:15 local' },
  { tz: 'America/New_York', at: '2026-10-14T01:00:00Z', note: '21:00 local on the 13th' },
  { tz: 'Pacific/Honolulu', at: '2026-10-14T05:00:00Z', note: '19:00 local on the 13th' },
];
for (const c of CASES) {
  const expected = localDay(c.at, c.tz);
  test(`printUtils export file name [${c.tz} @ ${c.note}]: dated with the local day ${expected}`, async () => {
    const r = child([HARNESS, 'filename'], { tz: c.tz, now: c.at });
    assert.equal(fileDate(r), expected);
  });
}

test('Cairo really is UTC+3 on 2026-10-14 (so the 00:00-03:00 window in the cases above is the right one)', () => {
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', timeZoneName: 'shortOffset' }).format(new Date('2026-10-14T12:00:00Z'));
  assert.match(off, /GMT\+3/);
});
