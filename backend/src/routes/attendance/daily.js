const router = require('express').Router();
const { getPrisma } = require('../../utils/prisma');
const moment = require('moment');
const { mergeEffectivePenalty } = require('../../engines/attendanceEngine');
const { applyApprovedAdjustment } = require('../../engines/payrollEngine');
const { resolveVerifiedManualEditIds } = require('../../utils/manualEditAudit');
const { buildAttendanceRow } = require('../../utils/attendanceRow');

const prisma = getPrisma();

// Get daily attendance (for AG Grid)
router.get('/daily', async (req, res) => {
  try {
    const { date, branchId, departmentId, employeeId } = req.query;
    const targetDate = date ? new Date(date) : new Date();
    const d = new Date(moment(targetDate).format('YYYY-MM-DD'));

    let empWhere = { status: true };
    if (branchId) empWhere.branchId = parseInt(branchId);
    if (departmentId) empWhere.departmentId = parseInt(departmentId);
    // EP-014: optional narrowing for realtime single-row refresh — omitted by
    // every existing caller (initial load, filters), who see identical results.
    if (employeeId) empWhere.id = parseInt(employeeId);

    const employees = await prisma.employee.findMany({
      where: empWhere,
      include: { department: true, branch: true, shift: true },
    });

    const empIds = employees.map(e => e.id);
    const records = await prisma.attendanceDaily.findMany({
      where: { date: d, employeeId: { in: empIds } },
    });

    const recordIds = records.map(r => r.id);
    const adjustments = await prisma.attendanceAdjustment.findMany({
      where: { attendanceDailyId: { in: recordIds }, approvalStatus: 'approved' },
    });
    const adjByDailyId = new Map(adjustments.map(a => [a.attendanceDailyId, a]));

    const map = new Map(records.map(r => [r.employeeId, mergeEffectivePenalty(applyApprovedAdjustment(r, adjByDailyId.get(r.id)))]));

    // EF-014: resolve manualEdit against real evidence — see resolveVerifiedManualEditIds.
    const verifiedManualIds = await resolveVerifiedManualEditIds(records.filter(r => r.manualEdit).map(r => r.id));

    const dateStr = moment(d).format('YYYY-MM-DD');
    const result = employees.map(emp => {
      const merged = map.get(emp.id) || null;
      return buildAttendanceRow({
        employee: emp,
        merged,
        dateStr,
        verifiedManualIds,
        adj: merged ? adjByDailyId.get(merged.id) : null,
      });
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
