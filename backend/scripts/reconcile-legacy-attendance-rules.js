#!/usr/bin/env node
/**
 * reconcile-legacy-attendance-rules.js — READ-ONLY reconciliation report (P2-05 decision R4).
 *
 * The legacy `attendance_rules` table (branch / department / employee overrides) is no longer applied by the
 * engines — rules are GLOBAL (decision D1) and live in the `rules` table. Before that table can ever be
 * cleaned up, every legacy row has to be reconciled against the current global rules. This script produces
 * that report from a SQL DUMP FILE. It deliberately has NO database connection mode: it can never read or
 * touch a live/Production database, and it never writes anything (except printing).
 *
 *   node scripts/reconcile-legacy-attendance-rules.js --dump <mysqldump.sql> [--json]
 *
 * For each legacy row it reports one verdict:
 *   EQUIVALENT      global row whose value equals the current global rule  -> nothing to do
 *   DIFFERS         global row whose value differs from the current global rule. Legacy GLOBAL rows were
 *                   never applied by getRules(); the global Rule always won, so nothing changes at run time.
 *   NO_GLOBAL_RULE  global row whose key has no row in `rules`                -> legacy-only, document/retire
 *   SCOPED          row scoped to a branch / department / employee         -> NOT applied any more; needs a
 *                   deliberate, case-by-case decision (there is no global equivalent of a scope)
 *
 * It also pre-checks the global `rules` rows in the dump against the final P2-05 rules (so a dump can be
 * vetted before a controlled migration): early_rules still carrying the old 15:50 boundary, late_rules that do
 * not cover work_start -> 23:59, overtime multipliers <= 0, invalid weekend_days, and the removed
 * absence_deduct_days row.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const dumpPath = val('--dump');
if (!dumpPath || flag('--help')) {
  console.error('usage: node scripts/reconcile-legacy-attendance-rules.js --dump <mysqldump.sql> [--json]');
  console.error('(read-only; there is intentionally no option to connect to a database)');
  process.exit(dumpPath ? 0 : 2);
}
const sql = fs.readFileSync(path.resolve(dumpPath), 'utf8');

// ── tiny mysqldump INSERT reader ────────────────────────────────────────────
const Q = "'((?:[^'\\\\]|\\\\.|'')*)'";              // quoted string, mysqldump escapes (\' \\ '')
const unq = (s) => s.replace(/\\(.)/g, '$1').replace(/''/g, "'");
function insertLines(table) {
  return sql.split('\n').filter(l => l.startsWith('INSERT INTO `' + table + '`'));
}
function legacyRows() {
  const re = new RegExp('\\((\\d+),' + Q + ',' + Q + ',(NULL|\\d+),(NULL|\\d+),(NULL|\\d+),(?:NULL|' + Q + '),', 'g');
  const out = [];
  for (const line of insertLines('attendance_rules')) for (const m of line.matchAll(re)) {
    out.push({ id: +m[1], key: unq(m[2]), value: unq(m[3]), branchId: m[4] === 'NULL' ? null : +m[4], departmentId: m[5] === 'NULL' ? null : +m[5], employeeId: m[6] === 'NULL' ? null : +m[6] });
  }
  return out;
}
function globalRules() {
  const re = new RegExp('\\((\\d+),' + Q + ',' + Q + ',' + Q + ',' + Q + ',' + Q + ',(?:NULL|' + Q + '),(-?\\d+),(\\d),' + Q, 'g');
  const out = [];
  for (const line of insertLines('rules')) for (const m of line.matchAll(re)) {
    out.push({ id: +m[1], key: unq(m[3]), category: unq(m[4]), type: unq(m[5]), value: unq(m[6]), isActive: m[9] === '1', appliesTo: unq(m[10]) });
  }
  return out;
}

const legacy = legacyRows();
const rules = globalRules();
const ruleByKey = new Map(rules.map(r => [r.key, r]));
const norm = (v) => String(v ?? '').trim().toLowerCase();

const report = legacy.map(r => {
  const scoped = r.branchId != null || r.departmentId != null || r.employeeId != null;
  const g = ruleByKey.get(r.key);
  let verdict;
  if (scoped) verdict = 'SCOPED';
  else if (!g) verdict = 'NO_GLOBAL_RULE';
  else verdict = norm(g.value) === norm(r.value) ? 'EQUIVALENT' : 'DIFFERS';
  return { id: r.id, key: r.key, legacyValue: r.value, scope: scoped ? { branchId: r.branchId, departmentId: r.departmentId, employeeId: r.employeeId } : 'global', globalValue: g ? g.value : null, globalActive: g ? g.isActive : null, verdict };
});

// ── pre-checks of the global rules against the final P2-05 rules ──────────────
const { validateRuleValue } = require('../src/utils/ruleValidation');
const findings = [];
const byKey = (k) => ruleByKey.get(k);
const asAll = rules.map(r => ({ key: r.key, value: r.value, isActive: r.isActive }));
for (const k of ['overtime_multiplier', 'friday_ot_multiplier', 'holiday_ot_multiplier', 'weekend_work_multiplier']) {
  const r = byKey(k); if (!r) continue;
  const v = validateRuleValue({ key: k, type: 'number', name: k }, r.value, asAll);
  if (v.length) findings.push({ key: k, value: r.value, problem: v[0] });
}
if (byKey('weekend_days')) {
  const r = byKey('weekend_days'); const v = validateRuleValue({ key: 'weekend_days', type: 'text', name: 'weekend_days' }, r.value, asAll);
  if (v.length) findings.push({ key: 'weekend_days', value: r.value, problem: v[0] });
}
for (const k of ['late_rules', 'early_rules']) {
  const r = byKey(k); if (!r || !r.value) continue;
  const v = validateRuleValue({ key: k, type: 'text', name: k }, r.value, asAll);
  if (v.length) findings.push({ key: k, value: r.value.slice(0, 120), problem: v.join(' | ') });
}
const early = byKey('early_rules');
if (early && early.value) {
  try {
    const t = JSON.parse(early.value);
    if (t.some(x => x.toTime === '15:50' || x.fromTime === '15:51')) findings.push({ key: 'early_rules', value: '(tier boundary 15:50/15:51)', problem: 'saved table still has the old 15:50 boundary (15:50 = 2 units); decision D4 requires 15:50 = 1 unit — correct it through the Settings page / a controlled data fix' });
  } catch { /* reported by validateRuleValue above */ }
}
if (byKey('absence_deduct_days')) findings.push({ key: 'absence_deduct_days', value: byKey('absence_deduct_days').value, problem: 'obsolete rule (decision R3) — removed by migration 20261007120000_remove_absence_deduct_days_rule' });

const summary = report.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {});
if (flag('--json')) { console.log(JSON.stringify({ dump: path.basename(dumpPath), legacyRows: report.length, globalRules: rules.length, summary, report, findings }, null, 2)); process.exit(0); }

console.log(`Dump: ${path.basename(dumpPath)}   legacy attendance_rules rows: ${report.length}   global rules rows: ${rules.length}`);
console.log('This report is read-only. Nothing was connected to, read from, or written to any database.\n');
console.log('id  key'.padEnd(32) + 'legacy'.padEnd(10) + 'global rule'.padEnd(14) + 'active'.padEnd(8) + 'verdict');
for (const r of report) console.log(String(r.id).padEnd(4) + r.key.padEnd(28) + String(r.legacyValue).padEnd(10) + String(r.globalValue ?? '—').padEnd(14) + String(r.globalActive ?? '—').padEnd(8) + r.verdict + (r.scope === 'global' ? '' : '  scope=' + JSON.stringify(r.scope)));
console.log('\nSummary:', JSON.stringify(summary));
console.log(findings.length ? '\nGlobal-rule findings (pre-check against the final P2-05 rules):' : '\nGlobal-rule findings: none');
for (const f of findings) console.log(`  - ${f.key} = ${JSON.stringify(f.value)} :: ${f.problem}`);
