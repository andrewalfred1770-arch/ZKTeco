const router = require('express').Router();
const { getPrisma } = require('../utils/prisma');
const { authenticate, authorize } = require('../middleware/auth');
const prisma = getPrisma();
router.use(authenticate);

// List active departments; optionally filtered by branch
router.get('/', async (req, res) => {
  try {
    const { branchId } = req.query;
    const where = { status: true };
    if (branchId) where.branchId = parseInt(branchId);
    const depts = await prisma.department.findMany({
      where,
      include: { branch: true },
      orderBy: { name: 'asc' },
    });
    res.json(depts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Dependency counts — called by the delete-confirmation modal BEFORE the user commits.
router.get('/:id/deps', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [employees, rules] = await Promise.all([
      prisma.employee.count({ where: { departmentId: id, status: true } }),
      prisma.attendanceRule.count({ where: { departmentId: id } }),
    ]);
    res.json({ employees, rules });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', authorize('admin'), async (req, res) => {
  try {
    const { name, branchId } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'اسم القسم مطلوب' });
    if (!branchId)     return res.status(400).json({ error: 'الفرع مطلوب' });
    const dept = await prisma.department.create({
      data: { name: name.trim(), branchId: parseInt(branchId) },
      include: { branch: true },
    });
    res.status(201).json(dept);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Rename / move to another branch — always allowed, even if employees are assigned.
router.put('/:id', authorize('admin'), async (req, res) => {
  try {
    const { name, branchId, status } = req.body;
    const data = {};
    if (name     !== undefined) data.name     = name.trim();
    if (branchId !== undefined) data.branchId = parseInt(branchId);
    if (status   !== undefined) data.status   = !!status;
    if (!Object.keys(data).length) return res.status(400).json({ error: 'لا توجد بيانات للتحديث' });
    const dept = await prisma.department.update({
      where: { id: parseInt(req.params.id) },
      data,
      include: { branch: true },
    });
    res.json(dept);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Soft-delete (archive) — ALWAYS allowed.
// Employees keep their departmentId FK; historical records are unaffected.
router.delete('/:id', authorize('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const dept = await prisma.department.findUnique({ where: { id } });
    if (!dept) return res.status(404).json({ error: 'القسم غير موجود' });
    if (!dept.status) return res.json({ message: 'القسم مؤرشف مسبقاً' });
    await prisma.department.update({ where: { id }, data: { status: false } });
    res.json({ message: `تم أرشفة القسم "${dept.name}" بنجاح` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Restore an archived department
router.patch('/:id/restore', authorize('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const dept = await prisma.department.update({
      where: { id },
      data: { status: true },
      include: { branch: true },
    });
    res.json(dept);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
