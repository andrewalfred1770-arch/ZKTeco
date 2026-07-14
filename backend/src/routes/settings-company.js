/**
 * settings-company.js — "بيانات الشركة": runtime-editable company identity,
 * branding images, and print assets (CompanySetting key/value table).
 *
 * Every write upserts the affected key(s), records a `CompanySettingAudit`
 * row (what changed / old → new / who / when — same `actor()` convention as
 * rules.js, since this is a no-auth desktop app), refreshes the in-memory
 * store + on-disk snapshot, and emits `company-settings:changed` over
 * Socket.IO so every connected screen re-fetches and re-renders live.
 */
const router  = require('express').Router();
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const multer  = require('multer');
const { getPrisma } = require('../utils/prisma');
const prisma = getPrisma();
const store = require('../services/companySettingsStore');
const { authenticate, authorize } = require('../middleware/auth');

// Production/LAN endpoint — company branding/print-asset config, same gating
// tier as companies.js/branches.js (admin-only writes). No-op when
// AUTH_ENABLED=false, so the desktop no-auth flow is unaffected.
router.use(authenticate);

const actor = (req) => (req.body && req.body.changedByName) || 'النظام';

const TEXT_KEYS = [
  'company_name_ar', 'company_name_en', 'company_description', 'company_address',
  'company_phone', 'company_email', 'print_header_text', 'print_footer_text', 'print_contact_text',
];
const IMAGE_FIELDS = {
  logo:            'logo_url',
  loginBackground: 'login_background_url',
  stamp:           'stamp_url',
  printHeader:     'print_header_url',
};

async function audit(settingKey, action, oldValue, newValue, changedByName) {
  await prisma.companySettingAudit.create({
    data: {
      settingKey, action,
      oldValue: oldValue == null ? null : String(oldValue),
      newValue: newValue == null ? null : String(newValue),
      changedByName,
    },
  });
}

async function upsertSetting(key, value, type, changedByName) {
  const existing = await prisma.companySetting.findUnique({ where: { key } });
  await prisma.companySetting.upsert({
    where:  { key },
    update: { value, updatedBy: changedByName },
    create: { key, value, type, updatedBy: changedByName },
  });
  return existing ? existing.value : null;
}

// ─── Uploads (multer → disk) ──────────────────────────────────────────────────
fs.mkdirSync(store.UPLOAD_DIR, { recursive: true });

// Ensure cache.json exists from boot (e.g. fresh seed, no edits yet) so the
// Electron splash screen always has a snapshot to read at startup.
store.refreshSnapshot().catch(() => {});

// EF-007.2: client-declared MIME and originalname are both untrusted — the
// filename/extension actually written to disk must never derive from either.
// fileFilter below is a cheap early reject only; sniffImageType() after the
// write completes is the real authority (see the /upload/:field handler).
const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, store.UPLOAD_DIR),
    // Written under a random temp name — never derived from client input —
    // so no attacker-controlled string ever reaches the filesystem path.
    filename: (_req, _file, cb) => cb(null, `tmp-${crypto.randomBytes(16).toString('hex')}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ALLOWED_MIME.includes(file.mimetype)),
});

// Real file-type authority: reads the magic bytes of the already-written file
// — never trusts client-declared MIME or filename extension. Returns the
// correct extension for the sniffed type, or null if it's not one of the
// three formats this app actually needs to serve as images.
function sniffImageType(filePath) {
  const buf = Buffer.alloc(12);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, buf, 0, 12, 0);
  fs.closeSync(fd);
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return null;
}

function deleteOldFile(publicPath) {
  if (!publicPath) return;
  const filename = path.basename(publicPath);
  const filePath = path.join(store.UPLOAD_DIR, filename);
  fs.unlink(filePath, () => {});
}

// ─── Get all settings ─────────────────────────────────────────────────────────
router.get('/', async (_req, res) => {
  try {
    res.json(await store.getSettingsMap());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Recent audit trail ───────────────────────────────────────────────────────
router.get('/audit', async (_req, res) => {
  try {
    const rows = await prisma.companySettingAudit.findMany({
      orderBy: { changedAt: 'desc' },
      take: 50,
    });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Update text fields (partial) ─────────────────────────────────────────────
router.put('/', authorize('admin'), async (req, res) => {
  try {
    const changedByName = actor(req);
    const changes = [];
    for (const key of TEXT_KEYS) {
      if (!(key in req.body)) continue;
      const next = req.body[key] == null ? '' : String(req.body[key]);
      const type = key === 'company_description' || key.startsWith('print_') ? 'longtext' : 'text';
      const prev = await upsertSetting(key, next, type, changedByName);
      if (String(prev ?? '') !== next) changes.push([key, prev, next]);
    }
    for (const [key, oldValue, newValue] of changes) {
      await audit(key, 'updated', oldValue, newValue, changedByName);
    }
    const map = await store.refreshSnapshot();
    if (changes.length) req.io.emit('company-settings:changed', { keys: changes.map(c => c[0]), changedByName, at: new Date() });
    res.json(map);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Upload / replace an image asset ──────────────────────────────────────────
router.post('/upload/:field', authorize('admin'), (req, res) => {
  const settingKey = IMAGE_FIELDS[req.params.field];
  if (!settingKey) return res.status(400).json({ error: 'حقل صورة غير معروف' });

  upload.single('file')(req, res, async (err) => {
    const rejectUpload = (status, message) => {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(status).json({ error: message });
    };
    try {
      if (err) return res.status(400).json({ error: err.message || 'فشل رفع الملف' });
      if (!req.file) return res.status(400).json({ error: 'نوع الملف غير مدعوم (png/jpg/webp فقط، حتى 5MB)' });

      // EF-007.2: the file on disk still has a random temp name at this point
      // (see multer config above) — sniff its real content type from magic
      // bytes and only now assign the extension actually served to the world.
      // Client-declared MIME/originalname were never trusted for this.
      const realExt = sniffImageType(req.file.path);
      if (!realExt) return rejectUpload(400, 'نوع الملف غير مدعوم (png/jpg/webp فقط، حتى 5MB)');

      const finalName = `${req.params.field}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${realExt}`;
      const finalPath = path.join(store.UPLOAD_DIR, finalName);
      fs.renameSync(req.file.path, finalPath);
      req.file.filename = finalName;

      const changedByName = actor(req);
      const publicPath = `/uploads/company/${req.file.filename}`;
      const prev = await upsertSetting(settingKey, publicPath, 'image', changedByName);
      if (prev) deleteOldFile(prev);
      await audit(settingKey, 'image_uploaded', prev, publicPath, changedByName);

      const map = await store.refreshSnapshot();
      req.io.emit('company-settings:changed', { keys: [settingKey], changedByName, at: new Date() });
      res.status(201).json({ key: settingKey, value: publicPath, settings: map });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

// ─── Remove an image asset ────────────────────────────────────────────────────
router.delete('/upload/:field', authorize('admin'), async (req, res) => {
  try {
    const settingKey = IMAGE_FIELDS[req.params.field];
    if (!settingKey) return res.status(400).json({ error: 'حقل صورة غير معروف' });

    const changedByName = actor(req);
    const prev = await upsertSetting(settingKey, '', 'image', changedByName);
    if (prev) deleteOldFile(prev);
    await audit(settingKey, 'image_removed', prev, null, changedByName);

    const map = await store.refreshSnapshot();
    req.io.emit('company-settings:changed', { keys: [settingKey], changedByName, at: new Date() });
    res.json({ key: settingKey, value: '', settings: map });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
