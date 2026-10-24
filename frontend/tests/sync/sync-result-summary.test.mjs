/**
 * Truthful device-sync status (isolated: pure helper + source guards; no backend, no database, no device, no network).
 * A skipped (busy / disabled) or failed device must never be reported as a success, and the busy message must say who holds the device.
 * Run:  node --test tests/sync/sync-result-summary.test.mjs     (from frontend/)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..', '..', 'src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const S = await import(pathToFileURL(path.join(SRC, 'lib', 'syncResultSummary.js')).href);

const NOW = Date.parse('2026-10-22T07:12:30.000Z');
const since = (s) => new Date(NOW - s * 1000).toISOString();
const busy = (extra = {}) => ({ deviceId: 5, count: 0, skipped: true, skipReason: 'SYNC_ALREADY_RUNNING', reason: 'sync already running', ...extra });
const ok = (count = 3) => ({ deviceId: 5, success: true, count, total: count });

test('F1. classification: busy / disabled / failed / ok are told apart', () => {
  assert.equal(S.classifySyncResult(busy()), 'busy');
  assert.equal(S.classifySyncResult({ skipped: true, skipReason: 'DEVICE_DISABLED' }), 'disabled');
  assert.equal(S.classifySyncResult({ count: 0, error: 'x' }), 'failed');
  assert.equal(S.classifySyncResult({ success: false }), 'failed');
  assert.equal(S.classifySyncResult(ok()), 'ok');
  assert.equal(S.classifySyncResult(null), 'failed');
});

test('F2. busy message names the holder and how long ago it started', () => {
  const m = S.busyMessage([busy({ heldBy: 'auto', heldSince: since(45) })], NOW);
  assert.match(m, /الجهاز مشغول بمزامنة أخرى قيد التنفيذ حالياً/);
  assert.match(m, /مزامنة تلقائية منذ 45 ثانية/);
  assert.match(S.busyMessage([busy({ heldBy: 'users-discovery', heldSince: since(125) })], NOW), /قراءة مستخدمي الجهاز منذ دقيقتين/);
});

test('F3. busy message without holder info (older server) keeps the original wording, no invented detail', () => {
  const m = S.busyMessage([busy()], NOW);
  assert.equal(m, 'الجهاز مشغول بمزامنة أخرى قيد التنفيذ حالياً — حاول مرة أخرى بعد قليل');
  assert.equal(S.holderText(busy({ heldBy: 'auto', heldSince: 'garbage' }), NOW), 'مزامنة تلقائية');   // unusable time: holder only
});

test('F4. an unknown holder label is shown as reported, never dropped', () => {
  assert.match(S.busyMessage([busy({ heldBy: 'something-new', heldSince: since(5) })], NOW), /something-new منذ 5 ثوانٍ/);
});

test('F5. toast: every device synced => success', () => {
  const t = S.buildSyncToast([ok(4), { ...ok(2), deviceId: 6 }]);
  assert.equal(t.level, 'success');
  assert.match(t.message, /6 حركة جديدة من 2 جهاز/);
});

test('F6. toast: a busy device is NEVER a success (single device)', () => {
  const t = S.buildSyncToast([busy({ heldBy: 'auto', heldSince: since(30) })], { now: NOW });
  assert.equal(t.level, 'warning');
  assert.match(t.message, /مشغول/);
  assert.match(t.message, /مزامنة تلقائية منذ 30 ثانية/);
  assert.doesNotMatch(t.message, /تمت المزامنة|حركة جديدة/);
});

test('F7. toast: mixed result is a warning that names what was NOT synced', () => {
  const t = S.buildSyncToast([ok(5), { ...busy({ heldBy: 'auto', heldSince: since(10) }), deviceId: 6 }], { now: NOW });
  assert.equal(t.level, 'warning');
  assert.match(t.message, /تمت مزامنة 1 من 2/);
  assert.match(t.message, /1 مشغول بمزامنة أخرى/);
  assert.match(t.message, /لم تتم مزامنته/);
});

test('F8. toast: failures are an error (all failed) or a warning (some ok); disabled is not a success', () => {
  assert.equal(S.buildSyncToast([{ count: 0, error: 'x' }]).level, 'error');
  const mixed = S.buildSyncToast([ok(1), { deviceId: 9, count: 0, error: 'x' }]);
  assert.equal(mixed.level, 'warning');
  assert.match(mixed.message, /1 فشلت مزامنته/);
  const dis = S.buildSyncToast([{ skipped: true, skipReason: 'DEVICE_DISABLED' }]);
  assert.equal(dis.level, 'warning');
  assert.match(dis.message, /غير مفعّل/);
});

test('F9. toast: no devices => a warning, never a success', () => {
  assert.equal(S.buildSyncToast([]).level, 'warning');
  assert.equal(S.buildSyncToast(undefined).level, 'warning');
});

test('F10. fingerprint modal still maps all-skipped to its busy / disabled errors, now through the helper', () => {
  const src = read('hooks', 'useFingerprintSyncWorkflow.js');
  assert.match(src, /import \{ busyMessage, DISABLED_MSG \} from '\.\.\/lib\/syncResultSummary'/);
  assert.match(src, /list\.every\(\(r\) => r\?\.skipped\)/);
  assert.match(src, /allBusy \? busyMessage\(list\) : DISABLED_MSG/);
  assert.doesNotMatch(src, /الجهاز مشغول بمزامنة أخرى قيد التنفيذ حالياً — حاول/, 'the busy text lives in the helper only');
});

test('F11. Dashboard "sync" no longer swallows per-device answers and always toasts success', () => {
  const src = read('pages', 'DashboardPage.jsx');
  const fn = src.slice(src.indexOf('const syncAll = async'), src.indexOf('// Filter roster by department'));
  assert.match(fn, /buildSyncToast\(results\)/);
  assert.doesNotMatch(fn, /\.catch\(\(\) => \{\}\)/, 'an error is kept as a failed result, not swallowed');
  assert.doesNotMatch(fn, /toast\.success\('تمت مزامنة الأجهزة'\)/, 'success is only reported when every device synced');
});

test('F12. Devices page sync-all reports success only when every device synced', () => {
  const src = read('pages', 'DevicesPage.jsx').replace(/\r\n/g, '\n');
  const fn = src.slice(src.indexOf('const handleSyncAll = async'), src.indexOf('// ── Re-link orphaned'));
  assert.match(fn, /buildSyncToast\(results\)/);
  assert.match(fn, /if \(t\.level === 'success'\) toast\.success\(/);
  assert.ok(fn.indexOf("t.level === 'success'") < fn.indexOf('toast.success('), 'toast.success sits behind the success check');
});

test('F13. Arabic number agreement for seconds and minutes (singular / dual / few / many)', () => {
  const el = (sec) => S.elapsedSince(since(sec), NOW);
  assert.equal(el(0), 'منذ 0 ثانية');
  assert.equal(el(1), 'منذ ثانية');
  assert.equal(el(2), 'منذ ثانيتين');
  assert.equal(el(5), 'منذ 5 ثوانٍ');
  assert.equal(el(11), 'منذ 11 ثانية');
  assert.equal(el(45), 'منذ 45 ثانية');
  assert.equal(el(60), 'منذ دقيقة');
  assert.equal(el(120), 'منذ دقيقتين');
  assert.equal(el(180), 'منذ 3 دقائق');
  assert.equal(el(600), 'منذ 10 دقائق');
  assert.equal(el(11 * 60), 'منذ 11 دقيقة');
  assert.doesNotMatch(el(180), /3 دقيقة/);
});
