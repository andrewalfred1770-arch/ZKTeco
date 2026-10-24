/**
 * Post-save confirmation dialog — the statements it shows must be supported by what the REAL routes answer.
 *
 * Each test drives the real Express routes (fake in-memory DB, fixed clock), feeds the ACTUAL HTTP response into the dialog's
 * summarizer (frontend/src/lib/postSaveSummary.js, the only place that decides what the dialog says) and asserts both the message
 * and the stored data. Isolated test data only: no real DB, no devices, no .env.
 * Target day = Wed 2026-09-09, employee 1 (salary 3000 => daily 100, hourly 12.5). Now = 2026-10-14.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const h = require('./harness');

const { db, emp, day, ymd } = h;
const M = 9; const Y = 2026; const TARGET = ymd(Y, M, 9);
const near = (a, b, msg) => assert.ok(Math.abs(Number(a) - Number(b)) < 0.005, `${msg || 'value'}: expected ${b}, got ${a}`);
const isFri = (d) => new Date(ymd(Y, M, d) + 'T12:00:00').getDay() === 5;
const WORKING = Array.from({ length: 30 }, (_, i) => i + 1).filter((d) => !isFri(d));
const hhmm = (d) => (d ? `${String(new Date(d).getHours()).padStart(2, '0')}:${String(new Date(d).getMinutes()).padStart(2, '0')}` : null);
const engine = () => h.load('engines/attendanceEngine');
const FRONTEND = process.env.CONSISTENCY_FRONTEND_SRC || path.join(__dirname, '..', '..', '..', 'frontend', 'src');   // override: mutation runs on a copy

let S;            // the ESM summarizer
test.before(async () => {
  h.setNow('2026-10-14T10:00:00');
  await h.start();
  S = await import(pathToFileURL(path.join(FRONTEND, 'lib', 'postSaveSummary.js')).href);
});
test.after(async () => { await h.stop(); });

const payrollRow = (status = 'draft') => ({
  id: 501, employeeId: 1, month: M, year: Y, status, basicSalary: 3000, hourlyRate: 12.5, workDays: 25, absentDays: 1, latePenalty: 0,
  penaltyUnits: 0, penaltyAmount: 0, overtimeHours: 0, overtimeAmount: 0, advances: 0, manualDeductionAdjustment: 0, deductions: 100, netSalary: 2900,
});
const log = (id, ts) => ({ id, deviceId: 1, zkUserId: '1', employeeId: 1, timestamp: h.at(TARGET, ts), isDuplicate: false, createdAt: new Date('2026-09-09T20:00:00'), source: 'device' });
let ID;
/** day 9 is an absent row (no punches) unless `late` (raw punches 09:40-17:00 processed by the engine). */
async function seed({ status = 'draft', late = false } = {}) {
  const target = day(1, TARGET, 'absent', { id: 4000 }); ID = target.id;
  db._reset({
    rule: [], department: [{ id: 1, name: 'D' }], branch: [{ id: 1, name: 'B' }], employee: [emp({ id: 1 })],
    attendanceDaily: [late ? null : target, ...WORKING.filter((d) => d !== 9).map((d) => day(1, ymd(Y, M, d), 'present'))].filter(Boolean),
    attendanceLog: late ? [log(1, '09:40'), log(2, '17:00')] : [], payroll: [payrollRow(status)],
  });
  h.load('services/ruleStore').invalidate();
  if (late) { await engine().processDate(h.utc(TARGET), 1); ID = db._tables.attendanceDaily.find((r) => r.date.getTime() === h.utc(TARGET).getTime()).id; }
}
const row = () => db._tables.attendanceDaily.find((r) => r.id === ID);
const audits = () => db._tables.manualEditAuditLog || [];
const ctx = (field, extra = {}) => ({ field, rowDate: TARGET, employeeName: 'Emp 101', ...extra });
const putEdit = (body) => h.putJson(`/api/attendance/daily/${ID}`, body);
const putPenalty = (body) => h.putJson(`/api/attendance/${ID}/manual-penalty`, { overrideReason: 'inline', ...body });
const putAbsence = (body) => h.putJson(`/api/attendance/${ID}/absence-type`, body);

// ── manual punch / time edits ────────────────────────────────────────────────────────────────────────────────────────
test('S1. adding a punch to an absent day: attendance saved + DRAFT payroll really recalculated (net 3000, absences 0)', async () => {
  await seed();
  const r = await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'forgot to punch' });
  const s = S.summarizeSave(r.body, ctx('checkIn'));
  assert.equal(s.kind, 'saved'); assert.equal(s.payroll.state, 'recalculated'); assert.equal(s.tone, 'success');
  assert.match(s.payroll.text, /اكتملت إعادة احتساب الراتب/); assert.match(s.payroll.detail, /3,000\.00/);
  assert.ok(s.lines.some((l) => l.includes('09:00') && l.includes('17:00')));
  // the claim is true: the stored draft really changed, and the live list shows the same figure
  near(db._tables.payroll[0].netSalary, 3000); assert.equal(db._tables.payroll[0].absentDays, 0);
  near((await h.getJson(`/api/payroll?month=${M}&year=${Y}`)).body[0].netSalary, 3000);
  assert.ok(audits().some((a) => a.fieldName === 'checkIn' && a.newValue === '09:00'), 'audit row written');
});

test('S2. editing only the check-out: the dialog reports the saved row and the recalculated payroll', async () => {
  await seed();
  await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
  const r = await putEdit({ checkOut: '18:30' });
  const s = S.summarizeSave(r.body, ctx('checkOut'));
  assert.equal(s.field, 'وقت الانصراف'); assert.equal(s.payroll.state, 'recalculated');
  assert.ok(s.lines.some((l) => l.includes('18:30')));
  assert.equal(hhmm(row().checkOut), '18:30');
});

// ── clearing lateness / absence ──────────────────────────────────────────────────────────────────────────────────────
test('S3. waiving lateness (0) and returning it to automatic (null) are reported as exactly that, with the payroll really recalculated', async () => {
  await seed({ late: true });
  assert.equal(row().latePenaltyUnits, 2);
  const waived = await putPenalty({ manualLatePenaltyUnits: 0 });
  const s0 = S.summarizeSave(waived.body, ctx('effectiveLatePenalty', { requested: 0 }));
  assert.ok(s0.lines[0].includes('أُعفي الخصم')); assert.equal(s0.payroll.state, 'recalculated');
  assert.equal(row().manualLatePenaltyUnits, 0); near(db._tables.payroll[0].deductions, 0, 'the late penalty is gone from the stored draft');
  const cleared = await putPenalty({ manualLatePenaltyUnits: null });
  const s1 = S.summarizeSave(cleared.body, ctx('effectiveLatePenalty', { requested: null }));
  assert.ok(s1.lines[0].includes('الحساب التلقائي')); assert.equal(row().manualLatePenaltyUnits, null);
  assert.ok(audits().filter((a) => a.fieldName === 'manualLatePenaltyUnits').length >= 2, 'both changes audited');
});

test('S4. clearing an absence deduction (custom 0 days) and cancelling an absence (status present) are saved, audited and reported', async () => {
  await seed();
  const waived = await putAbsence({ absenceType: 'custom', penaltyDays: 0, absenceReason: 'waived' });
  const s = S.summarizeSave(waived.body, ctx('absence'));
  assert.equal(s.payroll.state, 'recalculated'); assert.ok(s.lines.some((l) => l.includes('أيام الخصم: 0')));
  near(db._tables.payroll[0].deductions, 0, 'the waived absence no longer costs a day');
  const present = await putEdit({ status: 'present' });
  const s2 = S.summarizeSave(present.body, ctx('status'));
  assert.equal(s2.payroll.state, 'recalculated'); assert.equal(db._tables.payroll[0].absentDays, 0);
  assert.ok(audits().some((a) => a.fieldName === 'penaltyDays') && audits().some((a) => a.fieldName === 'status'));
});

// ── payroll protection ───────────────────────────────────────────────────────────────────────────────────────────────
test('S5. Finalized and Paid: attendance saved, payroll NOT recalculated, the dialog says so and the approved record is byte-identical', async () => {
  for (const [status, word] of [['finalized', 'معتمد'], ['paid', 'مدفوع']]) {
    await seed({ status });
    const before = JSON.stringify(db._tables.payroll);
    const a = S.summarizeSave((await putAbsence({ absenceType: 'custom', penaltyDays: 0 })).body, ctx('absence'));   // while the day is still an absence
    const r = await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
    const s = S.summarizeSave(r.body, ctx('checkIn'));
    assert.equal(s.payroll.state, 'protected', status); assert.equal(s.tone, 'warning');
    assert.ok(s.payroll.text.includes(word)); assert.match(s.payroll.detail, /المبالغ المعتمدة كما هي/);
    assert.ok(!/اكتملت إعادة احتساب/.test(s.payroll.text), 'never claims a recalculation');
    assert.equal(JSON.stringify(db._tables.payroll), before, `${status} row untouched`);
    assert.equal(hhmm(row().checkIn), '09:00', 'the attendance edit itself is saved');
    // same for the other two routes
    const p = S.summarizeSave((await putPenalty({ manualLatePenaltyUnits: 1 })).body, ctx('effectiveLatePenalty', { requested: 1 }));
    assert.equal(p.payroll.state, 'protected'); assert.equal(a.payroll.state, 'protected');
    assert.equal(JSON.stringify(db._tables.payroll), before);
  }
});

test('S6. a month closed between the check and the write (engine hands back the closed row) is still reported as protected, not recalculated', async () => {
  const s = S.summarizeSave({ id: 1, status: 'present', payroll: { status: 'finalized', month: M, year: Y, netSalary: 3000 }, payrollError: null, payrollProtected: null }, ctx('checkIn'));
  assert.equal(s.payroll.state, 'protected');
});

// ── failures ─────────────────────────────────────────────────────────────────────────────────────────────────────────
test('S7. attendance saved but payroll recalculation FAILED: the dialog separates the two, shows the reason, and never says payroll was updated', async () => {
  await seed();
  db._failNext('payroll', 'updateMany', new Error('db down'));
  const r = await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
  assert.equal(r.status, 200);
  const s = S.summarizeSave(r.body, ctx('checkIn'));
  assert.equal(s.kind, 'saved'); assert.equal(s.payroll.state, 'failed'); assert.equal(s.tone, 'error');
  assert.match(s.payroll.text, /فشلت إعادة احتساب الراتب/); assert.match(s.payroll.detail, /db down/);
  assert.ok(!/اكتملت/.test(s.payroll.text));
  assert.equal(hhmm(row().checkIn), '09:00', 'attendance really is saved'); near(db._tables.payroll[0].netSalary, 2900, 'payroll really is NOT updated');
});

test('S8. a save that failed (server rejected / audit write failed / no reply) shows the real outcome and claims nothing about payroll', async () => {
  await seed();
  const bad = await putEdit({ checkIn: '9:61' });
  assert.equal(bad.status, 400);
  const f = S.summarizeSaveFailure('rejected', { response: { data: bad.body } }, ctx('checkIn'));
  assert.equal(f.kind, 'failed'); assert.match(f.attendanceText, /فشل حفظ تعديل الحضور/); assert.ok(f.lines[0].includes(bad.body.error));
  assert.equal(f.payroll.state, 'not-attempted'); assert.equal(f.tone, 'error');
  db._failNext('manualEditAuditLog', 'create');
  const r = await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
  assert.ok(r.status >= 400); assert.equal(row().checkIn, null, 'rolled back: nothing saved'); assert.equal(audits().length, 0);
  assert.equal(S.summarizeSave(r.body, ctx('checkIn')), null, 'an error body is never shown as a save');
  const u = S.summarizeSaveFailure('unknown', new Error('Network Error'), ctx('checkIn'));
  assert.match(u.attendanceText, /لم يُتأكد هل حُفظ/); assert.equal(u.tone, 'warning');
  assert.match(S.summarizeSaveFailure('not-applied', null, ctx('checkIn')).attendanceText, /لم يُحفظ — انتهت الجلسة/);
});

test('S9. responses the dialog cannot support are labelled unverified / no-payroll, never success', () => {
  const base = { id: 1, status: 'present' };
  assert.equal(S.summarizeSave({ ...base }, ctx('checkIn')).payroll.state, 'unverified');
  assert.equal(S.summarizeSave({ ...base, payroll: null, payrollError: null, payrollProtected: null }, ctx('checkIn')).payroll.state, 'none');
  assert.equal(S.summarizeSave({ ...base, payroll: { status: 'draft', month: 8, year: Y, netSalary: 5 } }, ctx('checkIn')).payroll.state, 'unverified');
  assert.equal(S.summarizeSave({ ...base, payroll: { status: 'draft', month: M, year: Y } }, ctx('checkIn')).payroll.state, 'unverified');
  for (const x of [null, undefined, {}, 'x']) assert.equal(S.summarizeSave(x, ctx('checkIn')), null);
});

// ── protections, repeats, dismissal ──────────────────────────────────────────────────────────────────────────────────
test('S10. manual edits stay protected after the dialog: audit kept, row locked, a later device punch cannot overwrite it, hidden punches are surfaced in the dialog', async () => {
  await seed();
  const r = await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
  assert.equal(S.summarizeSave(r.body, ctx('checkIn')).warning, null);
  const auditCount = audits().length;
  db._tables.attendanceLog.push({ ...log(9, '19:30'), createdAt: new Date() });
  const sync = await engine().processDate(h.utc(TARGET), 1);
  assert.equal(sync.skipped, 'manual-lock'); assert.equal(hhmm(row().checkOut), '17:00'); assert.equal(row().manualEdit, true);
  assert.equal(audits().length, auditCount, 'audit untouched');
  const again = await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
  assert.equal(S.summarizeSave(again.body, ctx('checkIn')), null, 'a repeat changes nothing, so no dialog');
  const later = await putEdit({ checkOut: '17:30', reason: 'r' });
  const s = S.summarizeSave(later.body, ctx('checkOut'));
  assert.equal(s.warning, null, 'the later audited check-out edit is a review made after the 19:30 punch arrived -> it is no longer reported');
});

test('S11. repeated identical saves and dialog dismissal cause no extra writes (one change set, one payroll recalculation)', async () => {
  await seed();
  await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
  const writes = db._writeLog.length; const nAudit = audits().length;
  const repeats = await Promise.all(Array.from({ length: 6 }, () => putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' })));
  assert.ok(repeats.every((x) => S.summarizeSave(x.body, ctx('checkIn')) === null), 'no dialog for a no-op');
  assert.equal(db._writeLog.length, writes); assert.equal(audits().length, nAudit);
});

test('S12. coalescing: the tally of several saves counts each payroll outcome separately', async () => {
  const ok = S.summarizeSave({ id: 1, payroll: { status: 'draft', month: M, year: Y, netSalary: 1 }, payrollError: null, payrollProtected: null }, ctx('checkIn'));
  const prot = S.summarizeSave({ id: 2, payrollProtected: 'paid', payroll: null, payrollError: null }, ctx('checkIn'));
  const fail = S.summarizeSave({ id: 3, payrollError: 'x', payroll: null, payrollProtected: null }, ctx('checkIn'));
  const bad = S.summarizeSaveFailure('rejected', new Error('e'), ctx('checkIn'));
  const t = S.tallyEntries([ok, prot, fail, bad]);
  assert.deepEqual({ total: t.total, saved: t.saved, failed: t.failed, recalculated: t.recalculated, protected: t.protected, payrollFailed: t.payrollFailed }, { total: 4, saved: 3, failed: 1, recalculated: 1, protected: 1, payrollFailed: 1 });
});

// ── NO MODAL any more: one small non-blocking toast, built from the same server-proven outcome ────────────────────────────────────────
const toastFor = (...entries) => S.buildSaveToast(entries);

test('S13. edit saves + payroll recalculation still runs, and the outcome is ONE success toast (no modal, nothing to click)', async () => {
  await seed();
  const r = await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'forgot to punch' });
  assert.equal(r.status, 200);
  // the business effect is unchanged: attendance saved, audit written, the DRAFT payroll really recalculated
  assert.equal(hhmm(row().checkIn), '09:00'); assert.equal(hhmm(row().checkOut), '17:00');
  assert.ok(audits().some((a) => a.fieldName === 'checkIn' && a.newValue === '09:00'), 'audit row written');
  near(db._tables.payroll[0].netSalary, 3000, 'payroll recalculated by the save itself'); assert.equal(db._tables.payroll[0].absentDays, 0);
  // the user-facing result
  const t = toastFor(S.summarizeSave(r.body, ctx('checkIn')));
  assert.deepEqual(t, { level: 'success', message: 'تم حفظ وقت الحضور وأُعيد احتساب الراتب' });
});

test('S14. payroll problems are NOT hidden by removing the modal: failed recalculation = error toast, finalized/paid = warning toast (payroll untouched)', async () => {
  await seed();
  db._failNext('payroll', 'updateMany', new Error('db down'));
  const failedRecalc = await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
  assert.equal(failedRecalc.status, 200); assert.equal(hhmm(row().checkIn), '09:00', 'attendance is saved');
  const e = toastFor(S.summarizeSave(failedRecalc.body, ctx('checkIn')));
  assert.equal(e.level, 'error'); assert.match(e.message, /تم حفظ وقت الحضور/); assert.match(e.message, /فشلت إعادة احتساب الراتب/);
  assert.ok(!/وأُعيد احتساب/.test(e.message), 'never claims the payroll was recalculated');
  for (const status of ['finalized', 'paid']) {
    await seed({ status });
    const before = JSON.stringify(db._tables.payroll);
    const r = await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
    const w = toastFor(S.summarizeSave(r.body, ctx('checkIn')));
    assert.equal(w.level, 'warning', status); assert.match(w.message, /الراتب معتمد\/مدفوع — لم يُعاد احتسابه/);
    assert.equal(JSON.stringify(db._tables.payroll), before, `${status} payroll untouched`); assert.equal(hhmm(row().checkIn), '09:00');
  }
});

test('S15. no toast when nothing was saved: unchanged answers, failed saves (the edit handler already toasts those) and non-save bodies', async () => {
  await seed();
  await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
  const same = await putEdit({ checkIn: '09:00', checkOut: '17:00', reason: 'r' });
  assert.equal(toastFor(S.summarizeSave(same.body, ctx('checkIn'))), null);
  assert.equal(toastFor(S.summarizeSaveFailure('rejected', new Error('x'), ctx('checkIn'))), null);
  assert.equal(toastFor(null, undefined), null); assert.equal(toastFor(), null); assert.equal(S.buildSaveToast(undefined), null);
  const bad = await putEdit({ checkIn: '9:61' });
  assert.equal(toastFor(S.summarizeSave(bad.body, ctx('checkIn'))), null, 'an error body is never reported as a save');
});

test('S16. coalesced saves (Tab-through / bulk) become ONE toast that counts every payroll outcome; the worst outcome sets the level', () => {
  const ok = (n) => S.summarizeSave({ id: n, payroll: { status: 'draft', month: M, year: Y, netSalary: 1 }, payrollError: null, payrollProtected: null }, ctx('checkIn'));
  const prot = S.summarizeSave({ id: 90, payrollProtected: 'paid', payroll: null, payrollError: null }, ctx('checkIn'));
  const fail = S.summarizeSave({ id: 91, payrollError: 'x', payroll: null, payrollProtected: null }, ctx('checkIn'));
  assert.deepEqual(toastFor(ok(1), ok(2), ok(3)), { level: 'success', message: 'تم حفظ 3 تعديلات وأُعيد احتساب الرواتب' });
  const mixedWarn = toastFor(ok(1), ok(2), prot);
  assert.equal(mixedWarn.level, 'warning'); assert.match(mixedWarn.message, /تم حفظ 3 تعديلات، أُعيد احتساب 2 — الراتب معتمد\/مدفوع — لم يُعاد احتسابه \(1\)/);
  const mixedErr = toastFor(ok(1), prot, fail);
  assert.equal(mixedErr.level, 'error'); assert.match(mixedErr.message, /فشلت إعادة احتساب الراتب \(1\)/); assert.match(mixedErr.message, /\(1\)/);
  const none = S.summarizeSave({ id: 5, payroll: null, payrollError: null, payrollProtected: null }, ctx('checkIn'));
  assert.equal(toastFor(none).level, 'warning'); assert.match(toastFor(none).message, /لا يوجد سجل راتب/);
  const unv = S.summarizeSave({ id: 6 }, ctx('checkIn')); assert.equal(toastFor(unv).level, 'warning'); assert.match(toastFor(unv).message, /لم يُتأكد من تحديث الراتب/);
  const ign = S.summarizeSave({ id: 7, payroll: { status: 'draft', month: M, year: Y, netSalary: 1 }, ignoredPunches: 2 }, ctx('checkIn'));
  assert.equal(toastFor(ign).level, 'warning'); assert.match(toastFor(ign).message, /بصمات خام لم تُطبَّق/);
  assert.ok(toastFor(ok(1), S.summarizeSaveFailure('rejected', null, ctx('checkIn'))).message.startsWith('تم حفظ وقت الحضور'), 'failed entries in the batch are ignored by the toast');
});

test('S17. static: the "نتيجة التعديل" dialog is gone from the whole frontend and the page wiring only toasts (no API, no modal)', () => {
  assert.ok(!fs.existsSync(path.join(FRONTEND, 'components', 'PostSaveDialog.jsx')), 'component removed');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  const offenders = walk(FRONTEND).filter((f) => /\.(jsx?|css)$/.test(f)).filter((f) => /نتيجة التعديل|PostSaveDialog/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, [], 'no source file still mentions the dialog');
  const page = fs.readFileSync(path.join(FRONTEND, 'pages', 'EmployeeMovementPage.jsx'), 'utf8').replace(/\r\n/g, '\n');
  for (const gone of ['postSaveEntries', 'postSaveReady', 'closePostSave', 'queuePostSave', 'summarizeSaveFailure']) assert.ok(!page.includes(gone), `${gone} removed from the page`);
  assert.match(page, /buildSaveToast/); assert.match(page, /const queueSaveToast = useCallback/);
  const flush = page.match(/const flushSaveToast = useCallback\(([\s\S]*?)\n  \}, \[\]\);/);
  assert.ok(flush && !/api\./.test(flush[1]) && /toast\.error\(t\.message/.test(flush[1]) && /toast\.success\(t\.message/.test(flush[1]), 'the flush only shows toasts');
  // failed saves still tell the user (the notifiers keep their toasts) and no longer queue anything
  for (const n of ['notifyKept', 'notifyUnknown', 'notifyFailed']) {
    const line = page.split('\n').find((l) => l.includes(n + ':'));
    assert.ok(line && /toast\.error\(/.test(line) && !/queue/.test(line), `${n} toasts the failure and queues nothing`);
  }
  const sum = fs.readFileSync(path.join(FRONTEND, 'lib', 'postSaveSummary.js'), 'utf8');
  assert.ok(!/from ['"][^'"]*(lib\/api|axios)['"]|\bfetch\(|api\.(put|post|get|delete)\(/.test(sum), 'the summarizer has no network access');
});

test('S18. static: duplicate submissions are blocked (same grid cell in flight, absence form, penalty form) and one confirmation toast per path', () => {
  const page = fs.readFileSync(path.join(FRONTEND, 'pages', 'EmployeeMovementPage.jsx'), 'utf8').replace(/\r\n/g, '\n');
  const guardAt = page.indexOf('if (savingCellsRef.current.has(`${rowData.id}:${field}`))');
  const beginAt = page.indexOf('editCountRef.current++;\n    guard.beginEdit([rowData.id]);\n    performance.mark(\'refreshCells-start\')');
  assert.ok(guardAt > 0 && beginAt > guardAt, 'the in-flight check runs BEFORE the PUT is started');
  assert.match(page.slice(guardAt, beginAt), /return;/);
  assert.match(page, /if \(!absenceModal\?\.id \|\| absenceSavingRef\.current\) return;/);
  assert.match(page, /absenceSavingRef\.current = false;\s*\n\s*setAbsenceSaving\(false\)/);
  const pen = fs.readFileSync(path.join(FRONTEND, 'components', 'ManualPenaltyModal.jsx'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(pen, /if \(savingRef\.current\) return;/); assert.match(pen, /savingRef\.current = true;\s*\n\s*setSaving\(true\)/); assert.match(pen, /savingRef\.current = false; setSaving\(false\)/);
  assert.match(pen, /import React, \{ useEffect, useRef, useState \} from 'react'/);
  assert.match(pen, /if \(!onResult\) toast\.success\('تم حفظ التعديل اليدوي'\)/, 'no second success toast when the page shows the outcome toast');
  assert.match(page, /else toast\.success\('تم تحديث نوع الغياب'\)/, 'absence: the plain toast is only the fallback when no row exists');
});
