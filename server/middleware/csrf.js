const { APP_URL } = require('../config');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const appOrigin = APP_URL ? new URL(APP_URL).origin : null;

// Belt and braces on top of SameSite=Strict: a cross-site form can't set a
// custom header, and a cross-site fetch that tries gets a CORS preflight we
// never answer. Origin, when the browser sends one, must be us.
function csrf(req, res, next) {
  if (SAFE.has(req.method)) return next();
  if (req.get('X-Kivo') !== '1') {
    return res.status(403).json({ error: 'Missing request header. Reload the page and try again.' });
  }
  const origin = req.get('Origin');
  if (origin) {
    let ok = false;
    try {
      const o = new URL(origin);
      ok = (appOrigin && o.origin === appOrigin) || o.host === req.get('Host');
    } catch (e) {
      ok = false; // "null" or garbage
    }
    if (!ok) return res.status(403).json({ error: 'This request came from another site and was refused.' });
  }
  next();
}

module.exports = csrf;
