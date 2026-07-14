const router = require('express').Router();
const moment = require('moment');
const { getPrisma } = require('../utils/prisma');
const { authenticate, authorize } = require('../middleware/auth');
const recalcEngine = require('../engines/recalcEngine');
const { monthRangeForDate } = require('../utils/monthRange');
const logger = require('../utils/logger');
const prisma = getPrisma();
router.use(authenticate);

// A holiday changes attendance math for ITS OWN month. The generic debounced
// scheduleRecalc only covers the CURRENT month — a retroactive (or future)
// holiday would silently never be reflected. Target the holiday's month directly.
function recalcHolidayMonth(holiday, io, reason) {
  const { start, end } = monthRangeForDate(holiday.date);
  recalcEngine.recalcScope({
    from: start.toDate(),
    to: end.toDate(),
    branchId: holiday.branchId || undefined,
    io,
    reason,
  }).catch((err) => logger.error(`[Holidays] recalc failed for "${holiday.name}": ${err.message}`));
}

router.get('/', async (req, res) => {
  try {
    const { year, branchId } = req.query;
    const y = parseInt(year) || new Date().getFullYear();
    const where = {
      date: { gte: new Date(`${y}-01-01`), lte: new Date(`${y}-12-31`) },
    };
    if (branchId) where.branchId = parseInt(branchId);
    const holidays = await prisma.holiday.findMany({ where, orderBy: { date: 'asc' } });
    res.json(holidays);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', authorize('admin', 'hr'), async (req, res) => {
  try {
    const { name, date, branchId, type } = req.body;
    const holiday = await prisma.holiday.create({
      data: { name, date: new Date(date), branchId: branchId ? parseInt(branchId) : null, type: type || 'public' },
    });
    recalcHolidayMonth(holiday, req.io, `إضافة عطلة "${holiday.name}"`);
    res.status(201).json(holiday);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', authorize('admin', 'hr'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.holiday.findUnique({ where: { id } });
    await prisma.holiday.delete({ where: { id } });
    if (existing) recalcHolidayMonth(existing, req.io, `حذف عطلة "${existing.name}"`);
    res.json({ message: 'Holiday deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
