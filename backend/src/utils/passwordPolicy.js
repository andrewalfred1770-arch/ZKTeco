/**
 * passwordPolicy.js — the ONE password policy and bcrypt cost for every account the application creates
 * (employee login accounts in routes/employees.js; the same limits as scripts/create-admin-user.js).
 *
 *   - 12..72 BYTES (UTF-8). bcrypt only looks at the first 72 bytes, so a longer password would be silently truncated
 *     (two different long passwords would collide) — it is refused instead.
 *   - must not equal the username, must not start/end with whitespace, must not be a single repeated character.
 *   - the policy applies when a password is SET. Existing hashes keep working at whatever cost they were made with.
 *
 * Nothing here logs, returns or stores a password or a hash.
 */
const crypto = require('crypto');

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_BYTES = 72;
const BCRYPT_COST = 12;   // same as scripts/create-admin-user.js (employee accounts used 10 before)

/** Returns null when acceptable, otherwise a short message that never echoes the password. */
function validatePassword(password, username) {
  if (typeof password !== 'string') return 'كلمة المرور غير صالحة';
  if ([...password].length < MIN_PASSWORD_LENGTH) return `كلمة المرور يجب ألا تقل عن ${MIN_PASSWORD_LENGTH} حرفاً`;
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return `كلمة المرور طويلة جداً (الحد الأقصى ${MAX_PASSWORD_BYTES} بايت)`;
  if (/^\s|\s$/.test(password)) return 'كلمة المرور يجب ألا تبدأ أو تنتهي بمسافة';
  if (username && password.toLowerCase() === String(username).toLowerCase()) return 'كلمة المرور يجب ألا تطابق اسم المستخدم';
  if (/^(.)\1+$/u.test(password)) return 'كلمة المرور ضعيفة جداً';
  return null;
}

/** Cost factor encoded in a bcrypt hash ("$2a$12$..." -> 12), or null when it is not a bcrypt hash. */
function bcryptCostOf(hash) {
  const m = /^\$2[abxy]\$(\d{2})\$/.exec(String(hash || ''));
  return m ? Number(m[1]) : null;
}

// A real bcrypt hash at the policy cost for a throw-away random secret, used so that "no such user" costs the same bcrypt
// work as "wrong password". Generated once per process (asynchronously, off the event loop); never a fixed literal in source.
let dummyHashPromise = null;
function getDummyHash(bcrypt) {
  if (!dummyHashPromise) dummyHashPromise = bcrypt.hash(crypto.randomBytes(24).toString('hex'), BCRYPT_COST);
  return dummyHashPromise;
}

module.exports = { validatePassword, bcryptCostOf, getDummyHash, MIN_PASSWORD_LENGTH, MAX_PASSWORD_BYTES, BCRYPT_COST };
