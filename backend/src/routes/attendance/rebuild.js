const router = require('express').Router();
const moment = require('moment');
const { authorize } = require('../../middleware/auth');
const historicalRebuildService = require('../../services/historicalRebuildService');

// ─── Historical Attendance/Payroll Rebuild ──────────────────────────────────
// Recomputes attendance_daily + payrolls for a date range from existing
// AttendanceLog rows (e.g. after a historical backfill sync). Reuses
// processDate/calculatePayroll via historicalRebuildService — see that file
// for locking, batching, resumability and the [HIST-REBUILD]/[REBUILD-*] logs.

// Current/last rebuild job status, active job cursor, queued range.
router.get('/rebuild-status', authorize('admin', 'hr'), async (req, res) => {
  try {
    const status = await historicalRebuildService.getStatus();
    res.json(status);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Read-only: which date ranges have AttendanceLog rows not yet reflected in
// attendance_daily.
router.get('/rebuild-discover', authorize('admin', 'hr'), async (req, res) => {
  try {
    const ranges = await historicalRebuildService.discoverRanges();
    res.json({ ranges });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Start a rebuild. If from/to are omitted, uses the union of discoverRanges().
router.post('/rebuild', authorize('admin'), async (req, res) => {
  try {
    let { from, to, employeeId } = req.body || {};

    if (!from || !to) {
      const ranges = await historicalRebuildService.discoverRanges();
      if (!ranges.length) return res.json({ started: false, message: 'لا توجد فترات تحتاج إعادة احتساب' });
      from = ranges[0].from;
      to = ranges[ranges.length - 1].to;
    }

    const f = moment(from), t = moment(to);
    if (!f.isValid() || !t.isValid() || t.isBefore(f)) {
      return res.status(400).json({ error: 'نطاق تاريخ غير صالح' });
    }

    const result = await historicalRebuildService.startRebuild({
      from: f.toDate(),
      to: t.toDate(),
      employeeId: employeeId ? parseInt(employeeId) : undefined,
      reason: `manual rebuild ${f.format('YYYY-MM-DD')} → ${t.format('YYYY-MM-DD')}`,
      triggeredBy: 'manual',
      io: req.io,
    });

    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
