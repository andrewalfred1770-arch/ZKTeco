/**
 * Early Leave Fractional Values — Full Trace Audit
 * Finds real records showing 0.1/0.2/0.3 and traces every field from DB to UI.
 */
const { getPrisma } = require('./src/utils/prisma');
const { calcEarlyCheckout, DEFAULT_EARLY_CHECKOUT_RULES, timeToMinutes } = require('./src/engines/policyEngine');
const { mergeEffectivePenalty } = require('./src/engines/attendanceEngine');
const prisma = getPrisma();

async function main() {
  console.log('\n══════ EARLY LEAVE FRACTIONAL VALUES — FULL TRACE AUDIT ══════\n');

  // ── 1. Find real records with early checkout (earlyLeaveMinutes > 0) ────────
  const records = await prisma.attendanceDaily.findMany({
    where: {
      earlyLeaveMinutes: { gt: 0 },
      checkOut: { not: null },
      status: { in: ['present','late','early_leave'] },
    },
    orderBy: { date: 'desc' },
    take: 20,
    include: { employee: { select: { name: true } } },
  });

  console.log(`Found ${records.length} records with earlyLeaveMinutes > 0\n`);
  console.log('══ DB FIELD ANALYSIS ══');
  console.log('Showing: earlyLeaveMinutes, earlyCheckoutUnits, effectiveEarlyPenalty, and what calcEarlyCheckout() returns\n');

  let examplesShown = 0;
  const findings = [];

  for (const r of records) {
    const co = r.checkOut;
    const checkOutMin = co.getHours() * 60 + co.getMinutes();
    const checkOutStr = `${String(co.getHours()).padStart(2,'0')}:${String(co.getMinutes()).padStart(2,'0')}`;

    // What calcEarlyCheckout() returns using DEFAULT rules (no custom rules in DB)
    const ruleResult = calcEarlyCheckout(checkOutMin, []);

    // What the DB stores
    const dbEarlyUnits = r.earlyCheckoutUnits || 0;
    const dbEarlyMin   = r.earlyLeaveMinutes  || 0;
    const dbEarlyHours = parseFloat((dbEarlyMin / 60).toFixed(2));

    // What mergeEffectivePenalty computes
    const merged = mergeEffectivePenalty(r);
    const effectiveEarly = merged.effectiveEarlyPenalty || 0;

    // Detect if fractional value exists (earlyLeaveMinutes / 60 ≠ integer)
    const isFractional = dbEarlyHours % 1 !== 0 && dbEarlyHours > 0;
    const mismatch = Math.abs(dbEarlyUnits - ruleResult) > 0.001;

    if (isFractional || mismatch || examplesShown < 5) {
      findings.push({
        name: r.employee.name,
        date: r.date.toISOString().split('T')[0],
        checkOutStr,
        checkOutMin,
        earlyLeaveMinutes: dbEarlyMin,
        earlyLeaveMinutes_div_60: dbEarlyHours,
        earlyCheckoutUnits_DB: dbEarlyUnits,
        calcEarlyCheckout_RULE: ruleResult,
        effectiveEarlyPenalty: effectiveEarly,
        mismatch_units_vs_rule: mismatch,
        fractional_minutes_div_60: isFractional,
      });
      examplesShown++;
      if (examplesShown >= 8) break;
    }
  }

  findings.forEach((f, i) => {
    console.log(`\n[${i+1}] ${f.name} — ${f.date}`);
    console.log(`  CheckOut:              ${f.checkOutStr} (${f.checkOutMin} min from midnight)`);
    console.log(`  earlyLeaveMinutes:     ${f.earlyLeaveMinutes} min`);
    console.log(`  earlyLeaveMin / 60:    ${f.earlyLeaveMinutes_div_60}  ← FRACTIONAL if shown here`);
    console.log(`  earlyCheckoutUnits DB: ${f.earlyCheckoutUnits_DB}  ← Stored tier result`);
    console.log(`  calcEarlyCheckout():   ${f.calcEarlyCheckout_RULE}  ← Rule should return this`);
    console.log(`  effectiveEarlyPenalty: ${f.effectiveEarlyPenalty}  ← After manual override`);
    if (f.mismatch_units_vs_rule) {
      console.log(`  ⚠ DB earlyCheckoutUnits (${f.earlyCheckoutUnits_DB}) ≠ rule result (${f.calcEarlyCheckout_RULE})`);
    }
    if (f.fractional_minutes_div_60) {
      console.log(`  ⚠ earlyLeaveMinutes/60 = ${f.earlyLeaveMinutes_div_60} — FRACTIONAL VALUE`);
    }
  });

  // ── 2. Trace the API fields ──────────────────────────────────────────────────
  console.log('\n\n══ API FIELD TRACE ══');
  console.log('Which field each API endpoint returns for "early leave":');
  console.log('');
  console.log('GET /attendance/daily:');
  console.log('  earlyLeaveMinutes:           r.earlyLeaveMinutes        ← RAW MINUTES');
  console.log('  earlyCheckoutUnits:          r.earlyCheckoutUnits       ← TIER RESULT (0,1,2,3,4)');
  console.log('  effectiveEarlyPenalty:       eff.effectiveEarlyPenalty  ← AFTER MANUAL OVERRIDE');
  console.log('');
  console.log('GET /attendance/monthly-detail:');
  console.log('  earlyLeaveMinutes:           r.earlyLeaveMinutes        ← RAW MINUTES');
  console.log('  effectiveEarlyPenalty:       eff.effectiveEarlyPenalty  ← AFTER MANUAL OVERRIDE');
  console.log('');
  console.log('GET /attendance/movement:');
  console.log('  earlyLeaveMin:               rec.earlyLeaveMinutes      ← RAW MINUTES');
  console.log('  earlyPenalty:                rec.earlyCheckoutUnits     ← TIER RESULT (RAW, before override)');
  console.log('  effectiveEarlyPenalty:       (from mergeEffectivePenalty)');
  console.log('');

  // ── 3. Check specific columns in movement page from routes ───────────────────
  console.log('══ COLUMN → FIELD MAPPING IN EVERY PAGE ══\n');

  const fs = require('fs');
  const path = require('path');
  const frontendDir = path.join(__dirname, '..', 'frontend', 'src');

  function checkFile(relPath, fieldPatterns) {
    const fp = path.join(frontendDir, relPath);
    if (!fs.existsSync(fp)) { console.log(`  [NOT FOUND] ${relPath}`); return; }
    const src = fs.readFileSync(fp, 'utf8');
    const lines = src.split('\n');
    fieldPatterns.forEach(({ pattern, label }) => {
      const re = new RegExp(pattern);
      lines.forEach((line, i) => {
        if (re.test(line)) {
          console.log(`  ${relPath}:${i+1}: ${label}`);
          console.log(`    → ${line.trim()}`);
        }
      });
    });
  }

  const EARLY_PATTERNS = [
    { pattern: 'earlyLeaveMinutes', label: '⚠ earlyLeaveMinutes (RAW MINUTES)' },
    { pattern: 'earlyCheckoutUnits', label: '✓ earlyCheckoutUnits (TIER RESULT)' },
    { pattern: 'effectiveEarlyPenalty', label: '✓ effectiveEarlyPenalty (EFFECTIVE)' },
    { pattern: 'earlyLeaveMin\\b', label: '⚠ earlyLeaveMin (RAW MINUTES alias)' },
    { pattern: 'earlyLeave.*60|60.*earlyLeave', label: '✗ DIVISION earlyLeave/60' },
  ];

  const FILES_TO_CHECK = [
    'pages/AttendanceDailyPage.jsx',
    'pages/AttendanceMonthlyPage.jsx',
    'pages/EmployeeMovementPage.jsx',
    'components/PrintPreviewModal.jsx',
    'components/SalaryCard.jsx',
    'pages/PayrollPage.jsx',
  ];

  FILES_TO_CHECK.forEach(f => {
    console.log(`\n${f}:`);
    checkFile(f, EARLY_PATTERNS);
  });

  // ── 4. Check movement page specifically for the column definition ────────────
  console.log('\n\n══ MOVEMENT COLUMN DEFINITIONS FOR EARLY LEAVE ══');
  const movPath = path.join(frontendDir, 'pages/EmployeeMovementPage.jsx');
  const movSrc = fs.readFileSync(movPath, 'utf8');
  const movLines = movSrc.split('\n');
  // Find the early leave column definition
  let inEarlyCol = false;
  movLines.forEach((line, i) => {
    if (line.includes('earlyLeave') || line.includes('انصراف') || line.includes('earlyPenalty') || line.includes('earlyCheckout')) {
      console.log(`  Line ${i+1}: ${line.trim()}`);
    }
  });

  await prisma.$disconnect();
  console.log('\n══════ TRACE COMPLETE ══════\n');
}
main().catch(e => { console.error(e.message); process.exit(1); });
