const router = require('express').Router();
const { sendError, numericIdParam } = require('../utils/apiError');
router.param('id', numericIdParam);
const { getPrisma } = require('../utils/prisma');
const { resolveActor } = require('../utils/auditActor');
const { writeAudit } = require('../utils/manualEditAudit');
const actorOf = (req) => resolveActor(req, {}, { name: 'مدير النظام', role: 'admin' });
const bcrypt = require('bcryptjs');
const { authenticate, authorize } = require('../middleware/auth');
const { relinkAttendanceLogs } = require('../services/relinkService');
const { syncStoredPayroll } = require('../engines/payrollEngine');
const { deleteDeviceUser } = require('../services/zktecoService');
const { actorFromReq } = require('../utils/deviceAudit');
const logger = require('../utils/logger');
const { parseMoney } = require('../utils/numeric');

const prisma = getPrisma();
const inc = { department: true, branch: true, shift: true };
// List route only reads department/branch — never shift. Kept separate from
// `inc` so the other three routes (single-employee/create/update) keep their
// existing full include unchanged.
const incList = { department: true, branch: true };

// EF-007.4: `parseFloat(salary) || 0` let a negative value (truthy) through
// unchanged — Employee.salary feeds dailyRate/hourlyRate for every payroll
// run for that employee. null/undefined/omitted salary is still valid (0).
//
// Strictness: parseFloat() is a prefix parser — "12abc" became 12 and "0x10"
// became 0 (silently zeroing the salary). Salary must be a finite number >= 0 or
// a string holding exactly one decimal number (utils/numeric.js parseMoney).
const SALARY_ERROR = 'الراتب يجب أن يكون رقمًا موجبًا';
function validateSalary(salary) {
  if (salary === undefined || salary === null || salary === '') return null;
  return parseMoney(salary) === null ? SALARY_ERROR : null;
}

// Reference ids (branch/department/shift) and flag fields arrive from the client
// as-is; parseInt('abc') is NaN and Boolean('zzz') is true, which used to be
// written to the database silently (NaN → NULL department). Absent / null /
// '' keep their existing meaning (omitted, or "none"); anything else must be a
// positive integer / a real boolean. Checked BEFORE any write.
function validateRefFields(body) {
  for (const [key, label] of [['branchId', 'الفرع'], ['departmentId', 'القسم'], ['shiftId', 'الوردية']]) {
    const v = body[key];
    if (v === undefined || v === null || v === '') continue;
    if (!/^\d{1,10}$/.test(String(v).trim())) return `معرّف ${label} غير صالح`;
  }
  for (const [key, label] of [['status', 'الحالة'], ['isMonitored', 'المراقبة']]) {
    const v = body[key];
    if (v === undefined || typeof v === 'boolean') continue;
    return `قيمة ${label} غير صالحة`;
  }
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
    sendError(res, err);
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

// NOTE: static GET routes must be registered BEFORE router.get('/:id') — Express matches
// in registration order, so a later '/import-template' was captured by '/:id'
// (id = NaN) and answered 500.
// GET /api/employees/import-template — returns CSV column headers for download
router.get('/import-template', async (_req, res) => {
  const header = 'name,zkUserId,code,phone,position,salary,branchId,departmentId,shiftId\n';
  const example = 'أحمد محمد,1001,EMP001,0501234567,محاسب,5000,1,,\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="employees_template.csv"');
  res.send('﻿' + header + example); // BOM for Excel Arabic compatibility
});

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
    sendError(res, err);
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
// The number is what the device reports as the user id (ASCII), so it is stored in
// that form: Arabic-Indic / Persian digits typed on an Arabic keyboard ("١٠٠٠")
// are converted to ASCII ("1000") — stored verbatim they would never match a punch —
// and embedded whitespace (never part of a device PIN) is rejected. `unchanged` is
// the employee's current code/zkUserId on edit: a number already stored is not
// re-judged for whitespace, so legacy rows stay editable.
const NON_ASCII_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;
const toAsciiDigit = (d) => String(d.charCodeAt(0) >= 0x06F0 ? d.charCodeAt(0) - 0x06F0 : d.charCodeAt(0) - 0x0660);
const HAS_WHITESPACE = /[\s\u200B-\u200F\u202A-\u202E\uFEFF]/;
function resolveUnifiedNumber(code, zkUserId, { unchanged = [] } = {}) {
  const clean = (v) => (v !== undefined && v !== null && String(v).trim() !== '')
    ? String(v).trim().replace(NON_ASCII_DIGITS, toAsciiDigit) : null;
  const c = clean(code);
  const z = clean(zkUserId);
  if (c && z && c !== z) {
    return { error: 'رقم الموظف يجب أن يطابق رقم المستخدم في جهاز البصمة.' };
  }
  const value = c || z;
  if (!value) return { error: 'رقم الموظف / كود البصمة مطلوب' };
  if (value.length > MAX_EMPLOYEE_NUMBER_LENGTH) {
    return { error: `رقم الموظف يجب ألا يتجاوز ${MAX_EMPLOYEE_NUMBER_LENGTH} خانات (حد جهاز البصمة)` };
  }
  if (HAS_WHITESPACE.test(value) && !unchanged.some((u) => u != null && String(u) === value)) {
    return { error: 'رقم الموظف / كود البصمة يجب ألا يحتوي على مسافات' };
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
async function assertActiveNumberAvailable(tx, value, excludeId = null, { numberIsNew = true, willBeActive = true } = {}) {
  if (!value) return;
  const rows = await tx.$queryRaw`SELECT id, name, status FROM employees WHERE code = ${value} OR zkUserId = ${value} FOR UPDATE`;
  const others = rows.filter(r => r.id !== excludeId);

  // Another ACTIVE employee holding this number blocks when this row will be
  // active, or when the number is being newly assigned.
  const activeConflict = others.find(r => Number(r.status) === 1);
  if (activeConflict && (willBeActive || numberIsNew)) {
    const err = new Error(`كود البصمة "${value}" مستخدم بالفعل لموظف آخر: "${activeConflict.name}"`);
    err.statusCode = 409;
    throw err;
  }

  // Task 2: a number belonging to a STOPPED employee is no longer silently
  // reusable — device history keyed on it must keep pointing at that
  // employee. Only blocks NEWLY assigning the number (create, or an edit that
  // changes it); an employee keeping their own number, or legacy stopped rows
  // that already share one, are never affected.
  const stoppedConflict = others.find(r => Number(r.status) !== 1);
  if (stoppedConflict && numberIsNew) {
    const err = new Error(`كود البصمة "${value}" مستخدم لموظف موقوف بالفعل: "${stoppedConflict.name}". يرجى مراجعة بيانات الموظف الموقوف قبل استخدام هذا الكود.`);
    err.statusCode = 409;
    throw err;
  }
}

// F-12: two requests racing for the same number serialize on the FOR UPDATE gap
// locks above; InnoDB resolves that by aborting one of them with a deadlock /
// lock-wait error, which used to surface as HTTP 500. The loser is simply retried
// — by then the winner has committed, so assertActiveNumberAvailable answers with
// the normal 409. A unique-index violation (P2002) is the same conflict.
const NUMBER_CONFLICT_MSG = 'كود الموظف مستخدم بالفعل، أو تعذّر حفظه بسبب تعارض متزامن على نفس الكود. يرجى مراجعة الكود والمحاولة مرة أخرى';
const isTxConflict = (e) => !!e && (e.code === 'P2034' || /deadlock|lock wait timeout|1213|1205/i.test(String(e.message || '')));
async function withNumberRetry(fn) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (e) {
      if (e && e.code === 'P2002') { const err = new Error(NUMBER_CONFLICT_MSG); err.statusCode = 409; throw err; }
      if (!isTxConflict(e)) throw e;
      if (attempt >= 5) { const err = new Error(NUMBER_CONFLICT_MSG); err.statusCode = 409; throw err; }
      await new Promise(r => setTimeout(r, 20 * attempt + Math.floor(Math.random() * 30)));
    }
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
    const refErr = validateRefFields(req.body);
    if (refErr) return res.status(400).json({ error: refErr });

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
      emp = await withNumberRetry(() => prisma.$transaction(async (tx) => {
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
      }));
    } catch (err) {
      // The login account created above must not outlive a failed employee insert
      // (it would block the retry with a "username taken" error).
      if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {});
      if (err.statusCode === 409) return res.status(409).json({ error: err.message, code: 'EMPLOYEE_NUMBER_CONFLICT' });
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
    sendError(res, err);
  }
});

router.put('/:id', authorize('admin', 'hr'), async (req, res) => {
  try {
    const { name, zkUserId, code, phone, email, nationalId, position, hireDate,
      salary, departmentId, branchId, shiftId, status, effectiveStopDate,
      isMonitored, monitorColor } = req.body;

    const salaryErr = validateSalary(salary);
    if (salaryErr) return res.status(400).json({ error: salaryErr });
    const refErr = validateRefFields(req.body);
    if (refErr) return res.status(400).json({ error: refErr });

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
      const identity = resolveUnifiedNumber(code, zkUserId, { unchanged: [before?.code, before?.zkUserId] });
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
    let salaryChanged = false;
    try {
      emp = await withNumberRetry(() => prisma.$transaction(async (tx) => {
        const numberIsNew = unifiedValue !== undefined
          && unifiedValue !== before?.zkUserId && unifiedValue !== before?.code;
        if (effectiveValue && (effectiveStatus === true || numberIsNew)) {
          await assertActiveNumberAvailable(tx, effectiveValue, parseInt(req.params.id),
            { numberIsNew, willBeActive: effectiveStatus === true });
        }
        // F-05: audit a salary change from the value actually committed. The employee
        // row is locked (FOR UPDATE) BEFORE it is read, so two concurrent salary edits
        // (from here, or from the Payroll grid) are applied one after the other and each
        // audit row is old = the previous committed value -> new. Only a real change is
        // audited. No salary history / effective dates: just this audit trail.
        let salaryChange = null;
        salaryChanged = false;
        if (salary !== undefined) {
          const newSalary = parseFloat(salary) || 0;
          const rows = await tx.$queryRaw`SELECT salary FROM employees WHERE id = ${parseInt(req.params.id)} FOR UPDATE`;
          if (rows.length && Number(rows[0].salary) !== newSalary) salaryChange = { oldValue: rows[0].salary, newValue: newSalary };
        }
        const updatedEmployee = await tx.employee.update({
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
        if (salaryChange) {
          salaryChanged = true;
          const actor = actorOf(req);
          await writeAudit({
            employeeId: updatedEmployee.id, fieldName: 'basicSalary',
            oldValue: salaryChange.oldValue, newValue: salaryChange.newValue,
            reason: 'تعديل الراتب من صفحة الموظفين',
            userId: actor.id, userName: actor.name, userRole: actor.role,
            source: 'employees-page', tx,
          });
        }
        return updatedEmployee;
      }));
    } catch (err) {
      if (err.statusCode === 409) return res.status(409).json({ error: err.message, code: 'EMPLOYEE_NUMBER_CONFLICT' });
      throw err;
    }

    // Finding #1: Employee.salary feeds every payroll computation, but this route used to leave the
    // employee's stored DRAFT payroll rows holding the old salary until some later read repaired them
    // (Final Salary / list were always right because they compute fresh). Bring the stored draft rows in
    // line with the canonical figures before answering. This is the existing write-through
    // (syncStoredPayroll: one computation under the employee-month payroll lock, writes only if something
    // differs, never touches status). Finalized/paid rows are NOT touched here (they keep the existing
    // policy: repaired on read). Best-effort: a failure never fails the salary edit that already committed.
    if (salaryChanged) {
      try {
        const drafts = await prisma.payroll.findMany({ where: { employeeId: emp.id, status: 'draft' }, select: { month: true, year: true } });
        for (const d of drafts) await syncStoredPayroll(emp.id, d.month, d.year);
      } catch (err) {
        logger.error(`[PAYROLL-SYNC] salary edit emp=${emp.id}: stored draft payroll sync failed (${err.message}) — the next read repairs it`);
      }
    }
    res.json(emp);

    // ── Auto-Relink: re-link orphaned logs if zkUserId was set/changed ──────────
    if (emp.zkUserId && emp.zkUserId !== before?.zkUserId) {
      relinkAttendanceLogs({ employeeId: emp.id, io: req.io, reason: `employee-updated:${emp.id}` })
        .catch(err => logger.error(`[Relink] auto-relink on update failed for emp ${emp.id}: ${err.message}`));
    }
  } catch (err) {
    sendError(res, err);
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
    sendError(res, err);
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
    sendError(res, err);
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
        devices.map(d => deleteDeviceUser(d.id, emp.zkUserId, actorFromReq(req)))
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
          // F-10: the real authenticated user when auth is on; the desktop build's fixed label otherwise.
          modifiedBy:     actorOf(req).id,
          modifiedByName: actorOf(req).name,
          modifiedByRole: actorOf(req).role,
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
    sendError(res, err);
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
    const allEmps = await prisma.employee.findMany({ select: { code: true, zkUserId: true, status: true } });
    const numsOf = e => [e.code, e.zkUserId].filter(Boolean);
    // Keys are lower-cased: the code/zkUserId columns are case-INSENSITIVE
    // (utf8mb4_unicode_ci) and the single-create path compares through SQL, so
    // "EMP1" and "emp1" are the same number there — the import must agree.
    const numKey = (v) => String(v).toLowerCase();
    const existingActive  = new Set(allEmps.filter(e => e.status).flatMap(numsOf).map(numKey));
    const existingStopped = new Set(allEmps.filter(e => !e.status).flatMap(numsOf).map(numKey));
    const seenNumbers = new Set();

    const errors   = [];
    const toCreate = [];

    rows.forEach((r, i) => {
      const rowNum = i + 1;
      if (!r.name?.trim())        return errors.push({ row: rowNum, field: 'name',     message: 'الاسم مطلوب' });
      if (!r.branchId)            return errors.push({ row: rowNum, field: 'branchId', message: 'الفرع مطلوب' });
      const refErr = validateRefFields(r);                       // non-numeric ids would fail the WHOLE batch in Prisma
      if (refErr)                 return errors.push({ row: rowNum, field: 'branchId', message: refErr });
      const salaryErr = validateSalary(r.salary);               // same rule as create/update (no negatives, no "12abc")
      if (salaryErr)              return errors.push({ row: rowNum, field: 'salary', message: salaryErr });

      const identity = resolveUnifiedNumber(r.code, r.zkUserId);
      if (identity.error) return errors.push({ row: rowNum, field: 'zkUserId', message: identity.error });
      const num = identity.value;

      const nk = numKey(num);
      if (existingActive.has(nk) || seenNumbers.has(nk))
        return errors.push({ row: rowNum, field: 'zkUserId', message: `رقم الموظف "${num}" مستخدم حاليًا لموظف نشط أو مكرر في نفس الملف` });

      if (existingStopped.has(nk))
        return errors.push({ row: rowNum, field: 'zkUserId', message: `كود البصمة "${num}" مستخدم لموظف موقوف بالفعل. يرجى مراجعة بيانات الموظف الموقوف قبل استخدام هذا الكود.` });

      seenNumbers.add(nk);

      toCreate.push({
        name:         r.name.trim(),
        zkUserId:     num,
        code:         num,
        phone:        r.phone        ? String(r.phone).trim()        : null,
        position:     r.position     ? String(r.position).trim()     : null,
        salary:       r.salary       ? Number(r.salary) : 0,
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
    sendError(res, err);
  }
});

module.exports = router;
