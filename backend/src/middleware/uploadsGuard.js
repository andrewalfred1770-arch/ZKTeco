/**
 * uploadsGuard.js — what /uploads may serve (F8).
 *
 * The uploads directory also holds internal files that are NOT for distribution: uploads/company/cache.json (a snapshot of every
 * company setting, read from disk by the Electron splash — never over HTTP), multer's in-flight `tmp-*` files, and anything else
 * an operator drops there. Only the branding IMAGES the frontend renders (logo, login background, stamp, print header — written by
 * routes/settings-company.js as <field>-<ts>-<hex>.png|jpg|webp) are public: login screen and print previews load them without a
 * token, so they stay open. Everything else answers 404 (not 403: do not confirm that an internal file exists).
 *
 * Allowed: GET/HEAD, a path made only of [A-Za-z0-9_-] segments (no dot-segments, no dotfiles, no encoded separators, no
 * backslashes) ending in .png / .jpg / .jpeg / .webp, whose final name is not an in-flight `tmp-` upload.
 */
const IMAGE_PATH = /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:png|jpe?g|webp)$/i;

function isPublicUploadPath(p) {
  if (typeof p !== 'string' || p.length > 300) return false;
  if (!IMAGE_PATH.test(p)) return false;
  if (p.includes('..')) return false;
  const name = p.slice(p.lastIndexOf('/') + 1);
  return !name.startsWith('tmp-');
}

function uploadsGuard() {
  return (req, res, next) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && isPublicUploadPath(req.path)) return next();
    return res.status(404).json({ error: 'Not found' });
  };
}

module.exports = { uploadsGuard, isPublicUploadPath };
