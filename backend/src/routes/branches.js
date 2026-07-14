const router = require('express').Router();
const { getPrisma } = require('../utils/prisma');
const { authenticate, authorize } = require('../middleware/auth');
const prisma = getPrisma();
router.use(authenticate);

// List active branches only (archived branches are excluded from dropdowns / filters)
router.get('/', async (_req, res) => {
  try {
    const branches = await prisma.branch.findMany({
      where: { status: true },
      include: { company: true },
      orderBy: { name: 'asc' },
    });
    res.json(branches);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Dependency counts — called by the delete-confirmation modal BEFORE the user commits.
router.get('/:id/deps', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [activeDepts, allDepts, employees, devices, rules] = await Promise.all([
      prisma.department.count({ where: { branchId: id, status: true } }),
      prisma.department.count({ where: { branchId: id } }),
      prisma.employee.count({ where: { branchId: id, status: true } }),
      prisma.device.count({ where: { branchId: id, isArchived: false } }),
      prisma.attendanceRule.count({ where: { branchId: id } }),
    ]);
    res.json({ activeDepts, allDepts, employees, devices, rules });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', authorize('admin'), async (req, res) => {
  try {
    const { name, address, phone, companyId } = req.body;
    if (!name?.trim())  return res.status(400).json({ error: 'اسم الفرع مطلوب' });
    if (!companyId)     return res.status(400).json({ error: 'الشركة مطلوبة' });
    const branch = await prisma.branch.create({
      data: { name: name.trim(), address: address || null, phone: phone || null, companyId: parseInt(companyId) },
      include: { company: true },
    });
    res.status(201).json(branch);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Rename / update metadata — always allowed, even if branch has employees or devices.
router.put('/:id', authorize('admin'), async (req, res) => {
  try {
    const { name, address, phone, status } = req.body;
    const data = {};
    if (name    !== undefined) data.name    = name.trim();
    if (address !== undefined) data.address = address || null;
    if (phone   !== undefined) data.phone   = phone   || null;
    if (status  !== undefined) data.status  = !!status;
    if (!Object.keys(data).length) return res.status(400).json({ error: 'لا توجد بيانات للتحديث' });
    const branch = await prisma.branch.update({
      where: { id: parseInt(req.params.id) },
      data,
      include: { company: true },
    });
    res.json(branch);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Soft-delete (archive) — ALWAYS allowed.
// Employees, departments, and devices keep their FK references to this branch.
// Historical payroll/attendance data is unaffected.
router.delete('/:id', authorize('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const branch = await prisma.branch.findUnique({ where: { id } });
    if (!branch) return res.status(404).json({ error: 'الفرع غير موجود' });
    if (!branch.status) return res.json({ message: 'الفرع مؤرشف مسبقاً' });
    await prisma.branch.update({ where: { id }, data: { status: false } });
    res.json({ message: `تم أرشفة الفرع "${branch.name}" بنجاح` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Restore an archived branch
router.patch('/:id/restore', authorize('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const branch = await prisma.branch.update({
      where: { id },
      data: { status: true },
      include: { company: true },
    });
    res.json(branch);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
