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

// Phase 31 (F1 fix — Phase 25 audit, Critical): these two GETs previously had
// no role/ownership check beyond "is this a valid logged-in user" — any
// employee-role account (a real, app-creatable account type) could list
// every employee's salary or fetch any colleague's record by ID. The full
// roster has no legitimate "self" reading, so it's admin/hr only. The
// single-employee lookup keeps working for an employee-role caller ONLY
// when the id resolves to their own linked Employee row (self-service
// viewing); anyone else's id — or no linked employee at all — gets 403,
// never a silent empty/redacted response, so an authorization gap here is
// never mistaken for "no such employee".
router.get('/', authorize('admin', 'hr'), async (req, res) => {
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

async function assertEmployeeReadAllowed(req, res, employeeId) {
  if (!require('../middleware/auth').AUTH_ENABLED) return true;
  if (['admin', 'hr'].includes(req.user.role)) return true;
  const own = await prisma.employee.findUnique({ where: { userId: req.user.id }, select: { id: true } });
  if (own?.id === employeeId) return true;
  res.status(403).json({ error: 'غير مخول لهذا الإجراء' });
  return false;
}

router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!(await assertEmployeeReadAllowed(req, res, id))) return;
    const emp = await prisma.employee.findUnique({
      where: { id },
      include: { ...inc, user: { select: { id: true, username: true, role: true, active: true } } },
    });
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    res.json(emp);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Phase 23.1: the device's fingerprint user PIN is a fixed 9-byte ASCII
// field (confirmed against node-zklib's decodeUserData72/decodeRecordData40
// — see Phase 23 ZKTeco-pipeline audit), so a unified employee number can
// never exceed that width regardless of which of code/zkUserId it arrived as.
const MAX_EMPLOYEE_NUMBER_LENGTH = 9;

// Phase 23.1: `Employee.code` (business-facing employee number) and
// `Employee.zkUserId` (ZKTeco device PIN) are now required to be the exact
// same value — the single "رقم الموظف / كود البصمة" number the UI asks for.
// Accepts either or both from the caller: if both are given they must match
// (an explicit mismatch is rejected, not silently resolved); if only one is
// given, the other is derived from it, so every existing caller/import path
// that still sends just one field keeps working unchanged.
function resolveUnifiedNumber(code, zkUserId) {
  const c = (code !== undefined && code !== null && String(code).trim() !== '') ? String(code).trim() : null;
  const z = (zkUserId !== undefined && zkUserId !== null && String(zkUserId).trim() !== '') ? String(zkUserId).trim() : null;
  if (c && z && c !== z) {
    return { error: 'رقم الموظف يجب أن يطابق رقم المستخدم في جهاز البصمة.' };
  }
  const value = c || z;
  if (!value) return { error: 'رقم الموظف / كود البصمة مطلوب' };
  if (value.length > MAX_EMPLOYEE_NUMBER_LENGTH) {
    return { error: `رقم الموظف يجب ألا يتجاوز ${MAX_EMPLOYEE_NUMBER_LENGTH} خانات (حد جهاز البصمة)` };
  }
  return { value };
}

// Phase 22.4 (extended in 23.1): the unified employee number is a reusable
// business-facing identifier, not a relational identity — Employee.id
// remains that everywhere (Payroll, AttendanceDaily, Advance, audit logs all
// key on employeeId, never code/zkUserId). Multiple STOPPED employees may
// share a number (history), but only ONE ACTIVE employee may hold it at a
// time. MySQL has no partial/filtered unique index to express "unique only
// when status=true", so this is enforced here, inside the caller's
// transaction, via `SELECT ... FOR UPDATE` on every existing row sharing
// this number in EITHER column (covers legacy rows where code/zkUserId
// might still differ) — InnoDB takes record + gap locks on the indexed
// `code`/`zkUserId` columns, blocking a concurrent transaction from
// inserting/activating the same number until this one commits or rolls
// back, so two admins racing to reuse a freed number can never both
// succeed (Phase 22.4 TEST 9 / Phase 23.1 TEST 4).
async function assertActiveNumberAvailable(tx, value, excludeId = null) {
  if (!value) return;
  const rows = await tx.$queryRaw`SELECT id, name, status FROM employees WHERE code = ${value} OR zkUserId = ${value} FOR UPDATE`;
  const conflict = rows.find(r => Number(r.status) === 1 && r.id !== excludeId);
  if (conflict) {
    const err = new Error(`رقم الموظف "${value}" مستخدم حاليًا لموظف نشط: "${conflict.name}"`);
    err.statusCode = 409;
    throw err;
  }
}

router.post('/', authorize('admin', 'hr'), async (req, res) => {
  try {
    const { name, zkUserId, code, phone, email, nationalId, position, hireDate,
      salary, departmentId, branchId, shiftId,
      isMonitored, monitorColor,
      createUser, username, password } = req.body;

    const salaryErr = validateSalary(salary);
    if (salaryErr) return res.status(400).json({ error: salaryErr });

    const identity = resolveUnifiedNumber(code, zkUserId);
    if (identity.error) return res.status(400).json({ error: identity.error });

    let userId = null;
    if (createUser && username && password) {
      const hashed = await bcrypt.hash(password, 10);
      const user = await prisma.user.create({
        data: { username, password: hashed, name, role: 'employee' },
      });
      userId = user.id;
    }

    let emp;
    try {
      emp = await prisma.$transaction(async (tx) => {
        await assertActiveNumberAvailable(tx, identity.value);
        return tx.employee.create({
          data: {
            name, zkUserId: identity.value, code: identity.value, phone, email, nationalId, position,
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
      });
    } catch (err) {
      if (err.statusCode === 409) return res.status(409).json({ error: err.message });
      throw err;
    }
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
      salary, departmentId, branchId, shiftId, status, effectiveStopDate,
      isMonitored, monitorColor } = req.body;

    const salaryErr = validateSalary(salary);
    if (salaryErr) return res.status(400).json({ error: salaryErr });

    const before = await prisma.employee.findUnique({ where: { id: parseInt(req.params.id) }, select: { zkUserId: true, status: true, code: true } });

    // Phase 23.1: only resolve/validate the unified number when the caller
    // actually touches either field — every other PUT caller (e.g. the
    // status-toggle button, which sends only {status}) leaves it untouched,
    // same "omitted = don't change" contract as every other field below.
    // Note: only the fields actually PRESENT in this request are compared —
    // if the caller sends just one of code/zkUserId, that's "set the unified
    // number to this value", not a conflict against the OTHER field's old
    // (pre-edit) value. A real mismatch is only when BOTH are sent together
    // and disagree.
    let unifiedValue;
    if (code !== undefined || zkUserId !== undefined) {
      const identity = resolveUnifiedNumber(code, zkUserId);
      if (identity.error) return res.status(400).json({ error: identity.error });
      unifiedValue = identity.value;
    }

    // Phase 22.1: an ACTIVE→STOPPED transition must carry an explicit
    // effectiveStopDate — this is the sole authoritative source payroll
    // eligibility now reasons from (see routes/payroll.js), so a stop with
    // no date would leave that employee unfilterable. Already-stopped
    // employees being re-saved without a status change, and reactivations
    // (status:true), are unaffected — effectiveStopDate stays untouched
    // (preserved) when omitted from the request body, same as every other
    // optional field on this route.
    if (status === false && before?.status === true && !effectiveStopDate) {
      return res.status(400).json({ error: 'يجب تحديد تاريخ الإيقاف عند إيقاف الموظف' });
    }

    // P1 fix: every field below is now guarded the same way status/
    // isMonitored/monitorColor already were — a field OMITTED from the
    // request body is left untouched (Prisma treats `undefined` as "don't
    // update this field"), instead of being unconditionally recomputed from
    // `undefined` (which previously wrote zkUserId="undefined" the string,
    // reset salary to 0, and reset departmentId to null on any partial PUT).
    // This lets a caller send only the field it actually means to change
    // (e.g. EmployeesPage.jsx's status-toggle button) without risking a
    // lost-update race against another window's concurrent edit to the
    // OTHER fields — no existing caller is affected, since every current
    // caller of this route (EmployeeModal's save()) already sends the full
    // form object.
    // Phase 22.4 (extended 23.1): check whenever the row WILL end up active
    // with a number — covers both "the number is being changed on an
    // active/reactivated employee" and the easy-to-miss case of reactivating
    // someone (status→true) without touching the number at all, whose own
    // existing number may have been claimed by someone else while stopped.
    const effectiveStatus = status !== undefined ? Boolean(status) : before?.status;
    const effectiveValue = unifiedValue !== undefined ? unifiedValue : before?.code;

    let emp;
    try {
      emp = await prisma.$transaction(async (tx) => {
        if (effectiveStatus === true && effectiveValue) {
          await assertActiveNumberAvailable(tx, effectiveValue, parseInt(req.params.id));
        }
        return tx.employee.update({
          where: { id: parseInt(req.params.id) },
          data: {
            name:       name       !== undefined ? name : undefined,
            zkUserId:   unifiedValue !== undefined ? unifiedValue : undefined,
            code:       unifiedValue !== undefined ? unifiedValue : undefined,
            phone:      phone      !== undefined ? phone : undefined,
            email:      email      !== undefined ? email : undefined,
            nationalId: nationalId !== undefined ? nationalId : undefined,
            position:   position   !== undefined ? position : undefined,
            hireDate:   hireDate   !== undefined ? (hireDate ? new Date(hireDate) : null) : undefined,
            salary:     salary     !== undefined ? (parseFloat(salary) || 0) : undefined,
            departmentId: departmentId !== undefined ? (departmentId ? parseInt(departmentId) : null) : undefined,
            branchId:   branchId   !== undefined ? parseInt(branchId) : undefined,
            shiftId:    shiftId    !== undefined ? (shiftId ? parseInt(shiftId) : null) : undefined,
            status:       status       !== undefined ? Boolean(status) : undefined,
            effectiveStopDate: effectiveStopDate !== undefined ? (effectiveStopDate ? new Date(effectiveStopDate) : null) : undefined,
            isMonitored:  isMonitored  !== undefined ? Boolean(isMonitored) : undefined,
            monitorColor: monitorColor !== undefined ? (monitorColor || null) : undefined,
          },
          include: inc,
        });
      });
    } catch (err) {
      if (err.statusCode === 409) return res.status(409).json({ error: err.message });
      throw err;
    }
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
    // Phase 22.1: this route has no dedicated stop-date UI (it's the
    // quick-archive path, distinct from the EmployeesPage stop-date prompt on
    // PUT /:id) — default to today, same "default to today" convention used
    // elsewhere when no explicit date is supplied by the caller.
    const effectiveStopDate = req.body?.effectiveStopDate ? new Date(req.body.effectiveStopDate) : new Date();
    await prisma.employee.update({
      where: { id: parseInt(req.params.id) },
      data: { status: false, effectiveStopDate },
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

    // Phase 23.1: code and zkUserId are the same unified employee number now
    // — one existing-numbers Set, scoped to ACTIVE employees only (a number
    // held only by a stopped employee is legitimately reusable, same as
    // single-create/update above).
    const existingActive = new Set(
      (await prisma.employee.findMany({ where: { status: true }, select: { code: true, zkUserId: true } }))
        .flatMap(e => [e.code, e.zkUserId].filter(Boolean))
    );
    const seenNumbers = new Set();

    const errors   = [];
    const toCreate = [];

    rows.forEach((r, i) => {
      const rowNum = i + 1;
      if (!r.name?.trim())        return errors.push({ row: rowNum, field: 'name',     message: 'الاسم مطلوب' });
      if (!r.branchId)            return errors.push({ row: rowNum, field: 'branchId', message: 'الفرع مطلوب' });

      const identity = resolveUnifiedNumber(r.code, r.zkUserId);
      if (identity.error) return errors.push({ row: rowNum, field: 'zkUserId', message: identity.error });
      const num = identity.value;

      if (existingActive.has(num) || seenNumbers.has(num))
        return errors.push({ row: rowNum, field: 'zkUserId', message: `رقم الموظف "${num}" مستخدم حاليًا لموظف نشط أو مكرر في نفس الملف` });

      seenNumbers.add(num);

      toCreate.push({
        name:         r.name.trim(),
        zkUserId:     num,
        code:         num,
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
