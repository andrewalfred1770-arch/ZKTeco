const router = require('express').Router();
const { sendError, numericIdParam } = require('../utils/apiError');
router.param('id', numericIdParam);
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
  } catch (err) { sendError(res, err); }
});

// F-09: a "logical holiday" is one calendar date within one scope (a branch, or
// 0 = all branches). The same date+scope twice would be a duplicate row that
// every holiday lookup then has to tolerate. Check first (clear 409), serialise
// concurrent creates for the same key inside this process, and let the DB unique
// index (date, scopeKey) be the last line of defence where it could be created.
const createLocks = new Map();
async function withKeyLock(key, fn) {
  const prev = createLocks.get(key) || Promise.resolve();
  let release; const mine = new Promise((resolve) => { release = resolve; });
  const tail = prev.then(() => mine, () => mine);
  createLocks.set(key, tail);
  await prev.catch(() => {});
  try { return await fn(); } finally { release(); if (createLocks.get(key) === tail) createLocks.delete(key); }
}
const DUPLICATE_HOLIDAY = { error: 'يوجد إجازة مسجلة بالفعل في نفس التاريخ لنفس الفرع', code: 'HOLIDAY_DUPLICATE' };

router.post('/', authorize('admin', 'hr'), async (req, res) => {
  try {
    const { name, date, branchId, type } = req.body || {};
    const cleanName = typeof name === 'string' ? name.trim() : '';
    if (!cleanName) return res.status(400).json({ error: 'اسم الإجازة مطلوب', code: 'INVALID_INPUT' });
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || ''));
    const day = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
    if (!day || Number.isNaN(day.getTime()) || day.getUTCMonth() !== +m[2] - 1) {
      return res.status(400).json({ error: 'تاريخ الإجازة غير صالح', code: 'INVALID_INPUT' });
    }
    let branch = null;
    if (branchId !== undefined && branchId !== null && branchId !== '') {
      if (!/^\d{1,10}$/.test(String(branchId)) || parseInt(branchId) < 1) {
        return res.status(400).json({ error: 'معرّف الفرع غير صالح', code: 'INVALID_ID' });
      }
      branch = parseInt(branchId);
    }
    const scopeKey = branch || 0;

    const holiday = await withKeyLock(`${day.toISOString().slice(0, 10)}|${scopeKey}`, async () => {
      const dup = await prisma.holiday.findFirst({ where: { date: day, scopeKey } });
      if (dup) return null;
      try {
        return await prisma.holiday.create({
          data: { name: cleanName, date: day, branchId: branch, scopeKey, type: type || 'public' },
        });
      } catch (e) {
        if (e && e.code === 'P2002') return null;   // lost a race against another process
        throw e;
      }
    });
    if (!holiday) return res.status(409).json(DUPLICATE_HOLIDAY);
    recalcHolidayMonth(holiday, req.io, `إضافة عطلة "${holiday.name}"`);
    res.status(201).json(holiday);
  } catch (err) { sendError(res, err); }
});

router.delete('/:id', authorize('admin', 'hr'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.holiday.findUnique({ where: { id } });
    await prisma.holiday.delete({ where: { id } });
    if (existing) recalcHolidayMonth(existing, req.io, `حذف عطلة "${existing.name}"`);
    res.json({ message: 'Holiday deleted' });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
