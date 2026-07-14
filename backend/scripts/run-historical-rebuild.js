/**
 * One-off runner for historicalRebuildService — used for the 2026-04-01 to
 * 2026-06-13 attendance_daily/payrolls backfill (confirmed gap from the
 * 2026-06-13 investigation). Runs against the same DB as the running app via
 * Prisma; no ZK/device/Express dependency (io=null is safe — emit() no-ops).
 *
 * Usage: node scripts/run-historical-rebuild.js <from> <to>
 */
const svc = require('../src/services/historicalRebuildService');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const from = process.argv[2] || '2026-04-01';
  const to = process.argv[3] || '2026-06-13';

  const result = await svc.startRebuild({ from, to, triggeredBy: 'manual', reason: `backfill ${from}->${to}`, io: null });
  console.log('startRebuild result:', result);

  if (!result.started) {
    process.exit(result.queued ? 2 : 1);
  }

  // Poll until done.
  for (;;) {
    await sleep(3000);
    const status = await svc.getStatus();
    if (!status.active) {
      console.log('FINAL:', JSON.stringify(status.lastJob, null, 2));
      break;
    }
    const a = status.active;
    console.log(`progress: employees=${a.processedEmployees}/${a.totalEmployees} dates=${a.processedDates} errors=${a.errorCount} cursorEmployee=${a.cursorEmployeeId} cursorDate=${a.cursorDate}`);
  }

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
