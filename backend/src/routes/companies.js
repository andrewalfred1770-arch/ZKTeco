const router = require('express').Router();
const { getPrisma } = require('../utils/prisma');
const { authenticate, authorize } = require('../middleware/auth');
const prisma = getPrisma();

// Production/LAN endpoint — company create/rename/archive, same gating as
// the sibling branches.js/departments.js routers. No-op when AUTH_ENABLED=false.
router.use(authenticate);

// List all companies (active + archived — SettingsPage shows all and filters client-side)
router.get('/', async (_req, res) => {
  try {
    const companies = await prisma.company.findMany({ orderBy: { name: 'asc' } });
    res.json(companies);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Dependency counts — called by the delete-confirmation modal BEFORE the user commits.
// Returns structured counts so the frontend can display an informed summary.
router.get('/:id/deps', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [activeBranches, allBranches, employees, devices, departments] = await Promise.all([
      prisma.branch.count({ where: { companyId: id, status: true } }),
      prisma.branch.count({ where: { companyId: id } }),
      prisma.employee.count({ where: { branch: { companyId: id }, status: true } }),
      prisma.device.count({ where: { branch: { companyId: id }, isArchived: false } }),
      prisma.department.count({ where: { branch: { companyId: id }, status: true } }),
    ]);
    res.json({ activeBranches, allBranches, employees, devices, departments });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', authorize('admin'), async (req, res) => {
  try {
    const { name, address, phone, email } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'اسم الشركة مطلوب' });
    const company = await prisma.company.create({
      data: { name: name.trim(), address: address || null, phone: phone || null, email: email || null },
    });
    res.status(201).json(company);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Rename / update metadata — always allowed, even if company has branches or employees.
router.put('/:id', authorize('admin'), async (req, res) => {
  try {
    const { name, address, phone, email, status } = req.body;
    const data = {};
    if (name      !== undefined) data.name    = name.trim();
    if (address   !== undefined) data.address = address || null;
    if (phone     !== undefined) data.phone   = phone   || null;
    if (email     !== undefined) data.email   = email   || null;
    if (status    !== undefined) data.status  = !!status;
    if (!Object.keys(data).length) return res.status(400).json({ error: 'لا توجد بيانات للتحديث' });
    const company = await prisma.company.update({ where: { id: parseInt(req.params.id) }, data });
    res.json(company);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Soft-delete (archive) — ALWAYS allowed.
// Linked branches/employees are preserved with their existing FK references.
// The company is just hidden from active lists (status=false).
router.delete('/:id', authorize('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const company = await prisma.company.findUnique({ where: { id } });
    if (!company) return res.status(404).json({ error: 'الشركة غير موجودة' });
    if (!company.status) return res.json({ message: 'الشركة مؤرشفة مسبقاً' });
    await prisma.company.update({ where: { id }, data: { status: false } });
    res.json({ message: `تم أرشفة الشركة "${company.name}" بنجاح` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Restore an archived company
router.patch('/:id/restore', authorize('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await prisma.company.update({ where: { id }, data: { status: true } });
    res.json({ message: 'تم استعادة الشركة بنجاح' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
