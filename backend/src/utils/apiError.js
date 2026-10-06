/**
 * apiError.js — the ONE place a caught error becomes an HTTP response.
 *
 * Routes used to answer every caught error with `res.status(500).json({ error:
 * err.message })`, which (a) reported client mistakes (a non-numeric id, a bad
 * date, a missing field, a duplicate value) as server failures and (b) sent the
 * raw Prisma message — query text, schema and field names — to the client.
 *
 * toHttpError() classifies an error into { status, error, code }:
 *   - Prisma validation (bad/missing/NaN/invalid-date argument) → 400
 *   - Prisma unique constraint                                   → 409
 *   - Prisma record not found / invalid relation                 → 404 / 409
 *   - Prisma value too long / invalid value / null violation     → 400
 *   - errors that already carry a 4xx status (body-parser, app)  → that status
 *   - everything else                                            → 500, with the
 *     original message kept ONLY when it is app-authored; Prisma/stack-shaped
 *     text is replaced by a generic message.
 * The full original error is always logged server-side.
 */
const logger = require('./logger');

const GENERIC_500 = 'خطأ في الخادم';

// Message text that must never reach a client.
const INTERNAL_TEXT = /\bprisma\b|invocation|\bat\s+\S+\s+\(.*:\d+:\d+\)|\bSELECT\b|\bINSERT\b|\bUPDATE\b\s+`|\bFROM\s+`|ECONNREFUSED.*\d+\.\d+\.\d+\.\d+:\d+\/\w+|node_modules/i;

const PRISMA_CODES = {
  P2000: [400, 'قيمة طويلة جداً لأحد الحقول'],
  P2002: [409, 'القيمة موجودة مسبقاً (تكرار)'],
  P2003: [409, 'مرجع غير صالح أو السجل مرتبط ببيانات أخرى'],
  P2004: [400, 'القيمة تخالف قيداً في قاعدة البيانات'],
  P2005: [400, 'قيمة غير صالحة لأحد الحقول'],
  P2006: [400, 'قيمة غير صالحة لأحد الحقول'],
  P2007: [400, 'بيانات غير صالحة'],
  P2011: [400, 'حقل مطلوب فارغ'],
  P2012: [400, 'حقل مطلوب مفقود'],
  P2013: [400, 'حقل مطلوب مفقود'],
  P2014: [409, 'العملية تخالف علاقة بين سجلات'],
  P2015: [404, 'السجل غير موجود'],
  P2016: [400, 'الاستعلام غير صالح'],
  P2025: [404, 'السجل غير موجود'],
};

function toHttpError(err) {
  const name = err && err.name;

  if (name === 'PrismaClientValidationError') {
    return { status: 400, error: 'بيانات الطلب غير صالحة أو ناقصة', code: 'INVALID_INPUT' };
  }
  if (name === 'PrismaClientKnownRequestError') {
    const hit = PRISMA_CODES[err.code];
    if (hit) return { status: hit[0], error: hit[1], code: `DB_${err.code}` };
    return { status: 500, error: GENERIC_500, code: 'DB_ERROR' };
  }
  if (name === 'PrismaClientInitializationError' || name === 'PrismaClientRustPanicError' || name === 'PrismaClientUnknownRequestError') {
    return { status: 500, error: GENERIC_500, code: 'DB_ERROR' };
  }

  // Errors that already carry a client status (body-parser, app-thrown).
  const carried = Number(err && (err.status || err.statusCode));
  if (carried >= 400 && carried < 500) {
    if (err.type === 'entity.parse.failed') return { status: 400, error: 'جسم الطلب (JSON) غير صالح', code: 'MALFORMED_BODY' };
    if (err.type === 'entity.too.large') return { status: 413, error: 'حجم الطلب كبير جداً', code: 'BODY_TOO_LARGE' };
    return { status: carried, error: INTERNAL_TEXT.test(String(err.message)) ? 'طلب غير صالح' : String(err.message || 'طلب غير صالح') };
  }

  const msg = String((err && err.message) || '');
  return { status: 500, error: msg && !INTERNAL_TEXT.test(msg) ? msg : GENERIC_500 };
}

/** Log the real error server-side, answer the client with the safe classification. */
function sendError(res, err) {
  const out = toHttpError(err);
  const line = `[API-ERROR] ${res.req ? `${res.req.method} ${res.req.originalUrl}` : ''} → ${out.status} ${err && err.name || 'Error'}: ${String(err && err.message || err).split('\n').filter(Boolean).slice(-2).join(' | ')}`;
  if (out.status >= 500) logger.error(line); else logger.warn(line);
  if (res.headersSent) return;
  const body = { error: out.error };
  if (out.code) body.code = out.code;
  res.status(out.status).json(body);
}

/**
 * router.param('id', numericIdParam) — a path id must be a positive integer.
 * Without it `parseInt('abc')` (NaN) reached the query layer, where it was
 * either a Prisma error (reported as 500) or, worse, silently matched nothing /
 * wrote NULL. Anything else is a client error: 400, before any handler runs.
 */
function numericIdParam(req, res, next, value) {
  if (/^\d{1,10}$/.test(String(value))) return next();
  res.status(400).json({ error: 'معرّف غير صالح', code: 'INVALID_ID' });
}

// Query-string reference ids used as filters across the API. A present,
// non-empty value must be a positive integer; otherwise `parseInt` yields NaN,
// which some query paths reject (500) and others silently treat as "no match".
const QUERY_ID_KEYS = ['employeeId', 'branchId', 'departmentId', 'shiftId', 'deviceId', 'actorId'];
function validateQueryIds(req, res, next) {
  for (const key of QUERY_ID_KEYS) {
    const v = req.query[key];
    if (v === undefined || v === '') continue;
    if (typeof v !== 'string' || !/^\d{1,10}$/.test(v)) {
      return res.status(400).json({ error: 'قيمة المعرّف غير صالحة: ' + key, code: 'INVALID_ID' });
    }
  }
  next();
}

module.exports = { sendError, toHttpError, numericIdParam, validateQueryIds };
