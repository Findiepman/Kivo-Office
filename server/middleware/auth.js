const sessions = require('../sessions');
const { getUser } = require('../store');

// Loads the signed-in user fresh from the db on every request, so a
// deactivation or a password change takes effect on the very next click.
// (Current Kivo's 30-day JWT never re-checks the user; this is the fix.)
function loadUser(req, res, next) {
  req.user = null;
  req.session = null;
  const s = sessions.lookup(req, res);
  if (s) {
    const u = getUser(s.userId);
    if (u && u.active) {
      req.user = u;
      req.session = s;
    } else {
      // deactivation already deletes sessions; this catches anything left over
      sessions.destroyAllFor(s.userId);
      sessions.clearCookie(res);
    }
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  next();
}

module.exports = { loadUser, requireUser };
