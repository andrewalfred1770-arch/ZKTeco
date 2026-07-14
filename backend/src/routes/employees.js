const router = require('express').Router();
const { getPrisma } = require('../utils/prisma');
const bcrypt = require('bcryptjs');
const { authenticate, authorize } = require('../middleware/auth');
const { relinkAttendanceLogs } = require('../services/relinkService');
const { deleteDeviceUser } = require('../services/zktecoService');
const logger = require('../utils/logger');

const prisma = getPrisma();
const inc = { department: true, branch: true, shift: true };
// List route only reads department/branch — never shift. Kept separate from
// `inc` so the other three routes (single-employee/create/update) keep their
// existing full include unchanged.
const incList = { department: true, branch: true };

// EF-007.4: `parseFloat(salary) || 0` let a negative value (truthy) through
// unchanged — Employee.salary feeds dailyRate/hourlyRate for every payroll
// run for that employee. null/undefined/omitted salary is still valid (0).
function validateSalary(salary) {
  if (salary === undefined || salary === null || salary === '') return null;
  const n = parseFloat(salary);
  if (!Number.isFinite(n) || n < 0) return 'الراتب يجب أن يكون رقمًا موجبًا';
  return null;
}

router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const { branchId, departmentId, status } = req.query;
    const where = {};
    if (branchId) where.branchId = parseInt(branchId);
    if (departmentId) where.departmentId = parseInt(departmentId);
    if (status !== undefined) where.status = status === 'true';
    const employees = await prisma.employee.findMany({
      where,
      include: incList,
      orderBy: { name: 'asc' },
    });
    res.json(employees);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const emp = await prisma.employee.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { ...inc, user: { select: { id: true, username: true, role: true, active: true } } },
    });
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    res.json(emp);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// zkUserId is the join key between biometric punches and employees. The DB
// column is not unique (legacy data may contain duplicates), so enforce it at
// write time: two employees sharing a zkUserId means punches get attributed to
// whichever row findFirst returns — silent misattribution.
async function findZkUserIdConflict(zkUserId, excludeId = null) {
  if (!zkUserId) return null;
  return prisma.employee.findFirst({
    where: {
      zkUserId: String(zkUserId),
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, name: true, code: true },
  });
}

router.post('/', authorize('admin', 'hr'), async (req, res) => {
  try {
    const { name, zkUserId, code, phone, email, nationalId, position, hireDate,
      salary, departmentId, branchId, shiftId,
      isMonitored, monitorColor,
      createUser, username, password } = req.body;

    const salaryErr = validateSalary(salary);
    if (salaryErr) return res.status(400).json({ error: salaryErr });

    const conflict = await findZkUserIdConflict(zkUserId);
    if (conflict) {
      return res.status(409).json({
        error: `رقم البصمة ${zkUserId} مستخدم بالفعل للموظف "${conflict.name}" (#${conflict.id}) — لا يمكن ربط بصمة واحدة بأكثر من موظف`,
      });
    }

    let userId = null;
    if (createUser && username && password) {
      const hashed = await bcrypt.hash(password, 10);
      const user = await prisma.user.create({
        data: { username, password: hashed, name, role: 'employee' },
      });
      userId = user.id;
    }

    const emp = await prisma.employee.create({
      data: {
        name, zkUserId: String(zkUserId), code, phone, email, nationalId, position,
        hireDate: hireDate ? new Date(hireDate) : null,
        salary: parseFloat(salary) || 0,
        departmentId: departmentId ? parseInt(departmentId) : null,
        branchId: parseInt(branchId),
        shiftId: shiftId ? parseInt(shiftId) : null,
        isMonitored: Boolean(isMonitored),
        monitorColor: monitorColor || null,
        userId,
      },
      include: inc,
    });
    res.status(201).json(emp);

    // ── Auto-Relink: a new employee may match orphaned attendance_logs ──────────
    // (employeeId IS NULL but zkUserId matches). Run after responding so the
    // request isn't slowed down by recalculating daily/payroll for old logs.
    if (emp.zkUserId) {
      relinkAttendanceLogs({ employeeId: emp.id, io: req.io, reason: `employee-created:${emp.id}` })
        .catch(err => logger.error(`[Relink] auto-relink on create failed for emp ${emp.id}: ${err.message}`));
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', authorize('admin', 'hr'), async (req, res) => {
  try {
    const { name, zkUserId, code, phone, email, nationalId, position, hireDate,
      salary, departmentId, branchId, shiftId, status,
      isMonitored, monitorColor } = req.body;

    const salaryErr = validateSalary(salary);
    if (salaryErr) return res.status(400).json({ error: salaryErr });

    const conflict = await findZkUserIdConflict(zkUserId, parseInt(req.params.id));
    if (conflict) {
      return res.status(409).json({
        error: `رقم البصمة ${zkUserId} مستخدم بالفعل للموظف "${conflict.name}" (#${conflict.id}) — لا يمكن ربط بصمة واحدة بأكثر من موظف`,
      });
    }

    const before = await prisma.employee.findUnique({ where: { id: parseInt(req.params.id) }, select: { zkUserId: true } });

    const emp = await prisma.employee.update({
      where: { id: parseInt(req.params.id) },
      data: {
        name, zkUserId: String(zkUserId), code, phone, email, nationalId, position,
        hireDate: hireDate ? new Date(hireDate) : null,
        salary: parseFloat(salary) || 0,
        departmentId: departmentId ? parseInt(departmentId) : null,
        branchId: parseInt(branchId),
        shiftId: shiftId ? parseInt(shiftId) : null,
        status: status !== undefined ? Boolean(status) : undefined,
        isMonitored: isMonitored !== undefined ? Boolean(isMonitored) : undefined,
        monitorColor: monitorColor !== undefined ? (monitorColor || null) : undefined,
      },
      include: inc,
    });
    res.json(emp);

    // ── Auto-Relink: re-link orphaned logs if zkUserId was set/changed ──────────
    if (emp.zkUserId && emp.zkUserId !== before?.zkUserId) {
      relinkAttendanceLogs({ employeeId: emp.id, io: req.io, reason: `employee-updated:${emp.id}` })
        .catch(err => logger.error(`[Relink] auto-relink on update failed for emp ${emp.id}: ${err.message}`));
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', authorize('admin'), async (req, res) => {
  try {
    await prisma.employee.update({
      where: { id: parseInt(req.params.id) },
      data: { status: false },
    });
    res.json({ message: 'Employee deactivated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Pre-deletion check ────────────────────────────────────────────────────────
// Returns payroll/attendance counts, connected devices, and canHardDelete flag.
// Must be registered BEFORE /:id to avoid route shadowing — but /:id/delete-info
// pattern never clashes with numeric IDs so ordering doesn't matter in practice.
router.get('/:id/delete-info', authorize('admin', 'hr'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'معرف غير صالح' });

    const [emp, payrollCount, attendanceCount, advanceCount, devices] = await Promise.all([
      prisma.employee.findUnique({
        where: { id },
        select: {
          id: true, name: true, code: true, zkUserId: true,
          branch:      { select: { id: true, name: true } },
          department:  { select: { name: true } },
        },
      }),
      prisma.payroll.count({ where: { employeeId: id } }),
      prisma.attendanceDaily.count({ where: { employeeId: id } }),
      prisma.advance.count({ where: { employeeId: id } }),
      prisma.device.findMany({
        where: { enabled: true, isArchived: false },
        select: { id: true, name: true, ipAddress: true, port: true, branch: { select: { name: true } } },
        orderBy: { name: 'asc' },
      }),
    ]);

    if (!emp) return res.status(404).json({ error: 'الموظف غير موجود' });

    const hasHistory = payrollCount > 0 || attendanceCount > 0 || advanceCount > 0;
    const blockReason = payrollCount > 0
      ? `يوجد ${payrollCount} سجل راتب`
      : attendanceCount > 0
        ? `يوجد ${attendanceCount} سجل حضور`
        : advanceCount > 0
          ? `يوجد ${advanceCount} سلفة`
          : null;

    res.json({ employee: emp, payrollCount, attendanceCount, advanceCount,
               canHardDelete: !hasHistory, blockReason, devices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Execute deletion ──────────────────────────────────────────────────────────
// mode (body):
//   includeDevice: bool — also delete biometric user from all enabled devices
//
// Hard delete: only when employee has no payroll, attendance, or advance records.
//   Nullifies attendance_log links, removes audit logs + advances, deletes row.
// Archive:  sets status=false + writes audit trail; all history is preserved.
router.post('/:id/delete-confirm', authorize('admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'معرف غير صالح' });

  const { includeDevice = false } = req.body;

  try {
    const emp = await prisma.employee.findUnique({
      where: { id },
      include: { branch: true },
    });
    if (!emp) return res.status(404).json({ error: 'الموظف غير موجود' });

    // Re-check safety at execution time (race condition guard)
    const [payrollCount, attendanceCount, advanceCount] = await Promise.all([
      prisma.payroll.count({ where: { employeeId: id } }),
      prisma.attendanceDaily.count({ where: { employeeId: id } }),
      prisma.advance.count({ where: { employeeId: id } }),
    ]);
    const canHardDelete = payrollCount === 0 && attendanceCount === 0 && advanceCount === 0;

    // ── Device fingerprint deletion ──────────────────────────────────────────
    let deviceResults = [];
    if (includeDevice && emp.zkUserId) {
      const devices = await prisma.device.findMany({
        where: { enabled: true, isArchived: false },
        select: { id: true },
      });
      deviceResults = await Promise.all(
        devices.map(d => deleteDeviceUser(d.id, emp.zkUserId))
      );
    }

    // ── System deletion ──────────────────────────────────────────────────────
    let mode;
    if (canHardDelete) {
      await prisma.$transaction([
        // Nullify raw-log links so biometric history is orphaned but not lost
        prisma.attendanceLog.updateMany({ where: { employeeId: id }, data: { employeeId: null } }),
        // Remove audit logs first (FK to employee, no cascade)
        prisma.manualEditAuditLog.deleteMany({ where: { employeeId: id } }),
        // Remove advances (FK to employee, no cascade)
        prisma.advance.deleteMany({ where: { employeeId: id } }),
        // Hard-delete the employee row
        prisma.employee.delete({ where: { id } }),
      ]);
      mode = 'hard_delete';
    } else {
      await prisma.employee.update({ where: { id }, data: { status: false } });
      // Audit log — employee still exists so FK is valid
      await prisma.manualEditAuditLog.create({
        data: {
          employeeId:     id,
          fieldName:      'EMPLOYEE_ARCHIVED',
          oldValue:       'active',
          newValue:       'archived',
          reason:         `حذف الموظف "${emp.name}" (${emp.code || ''}) من صفحة الموظفين`,
          modifiedByName: 'مدير النظام',
          modifiedByRole: 'admin',
          source:         'employees-page',
        },
      });
      mode = 'archived';
    }

    logger.info(
      `[EMPLOYEE-DELETE] id=${id} name="${emp.name}" code=${emp.code || ''} ` +
      `mode=${mode} includeDevice=${includeDevice} ` +
      `devices=${deviceResults.filter(r => r.success).length}/${deviceResults.length}`
    );

    res.json({ success: true, mode, employeeName: emp.name, deviceResults });
  } catch (err) {
    logger.error(`[EMPLOYEE-DELETE] Failed id=${id}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── Bulk Import ──────────────────────────────────────────────────────────────
// POST /api/employees/bulk-import
// Body: { rows: [{ name, zkUserId, code?, phone?, position?, salary?, branchId, departmentId?, shiftId? }] }
// Returns: { imported, skipped, errors: [{ row, field, message }] }
router.post('/bulk-import', authorize('admin', 'hr'), async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ error: 'rows مطلوب ويجب أن يكون مصفوفة' });
    if (rows.length > 500)
      return res.status(400).json({ error: 'الحد الأقصى ٥٠٠ موظف لكل استيراد' });

    // Pre-fetch existing zkUserIds and codes for uniqueness check
    const existingZk  = new Set((await prisma.employee.findMany({ select: { zkUserId: true } })).map(e => e.zkUserId));
    const existingCodes = new Set((await prisma.employee.findMany({ where: { code: { not: null } }, select: { code: true } })).map(e => e.code));
    const seenZk    = new Set();
    const seenCodes = new Set();

    const errors   = [];
    const toCreate = [];

    rows.forEach((r, i) => {
      const rowNum = i + 1;
      if (!r.name?.trim())        return errors.push({ row: rowNum, field: 'name',     message: 'الاسم مطلوب' });
      if (!r.zkUserId?.toString().trim()) return errors.push({ row: rowNum, field: 'zkUserId', message: 'zkUserId مطلوب' });
      if (!r.branchId)            return errors.push({ row: rowNum, field: 'branchId', message: 'الفرع مطلوب' });

      const zk   = String(r.zkUserId).trim();
      const code = r.code ? String(r.code).trim() : null;

      if (existingZk.has(zk) || seenZk.has(zk))
        return errors.push({ row: rowNum, field: 'zkUserId', message: `zkUserId "${zk}" مكرر` });
      if (code && (existingCodes.has(code) || seenCodes.has(code)))
        return errors.push({ row: rowNum, field: 'code', message: `الكود "${code}" مكرر` });

      seenZk.add(zk);
      if (code) seenCodes.add(code);

      toCreate.push({
        name:         r.name.trim(),
        zkUserId:     zk,
        code:         code || null,
        phone:        r.phone        ? String(r.phone).trim()        : null,
        position:     r.position     ? String(r.position).trim()     : null,
        salary:       r.salary       ? parseFloat(r.salary) || 0     : 0,
        branchId:     parseInt(r.branchId),
        departmentId: r.departmentId ? parseInt(r.departmentId)       : null,
        shiftId:      r.shiftId      ? parseInt(r.shiftId)            : null,
        status:       true,
      });
    });

    if (toCreate.length > 0) {
      await prisma.employee.createMany({ data: toCreate, skipDuplicates: true });
    }

    res.json({ imported: toCreate.length, skipped: errors.length, errors });
  } catch (err) {
    logger.error(`[BULK-IMPORT] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/employees/import-template — returns CSV column headers for download
router.get('/import-template', async (_req, res) => {
  const header = 'name,zkUserId,code,phone,position,salary,branchId,departmentId,shiftId\n';
  const example = 'أحمد محمد,1001,EMP001,0501234567,محاسب,5000,1,,\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="employees_template.csv"');
  res.send('﻿' + header + example); // BOM for Excel Arabic compatibility
});

module.exports = router;
