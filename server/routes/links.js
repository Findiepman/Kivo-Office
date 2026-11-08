const express = require('express');
const db = require('../db');
const links = require('../links');
const sessions = require('../sessions');
const { log, pwlog } = require('../audit');
const { getUser, getUserByUsername } = require('../store');
const { now, clean, USERNAME_RE, PW_MIN, validPassword, hashPassword } = require('../util');
const { meView } = require('./views');

const router = express.Router();

// Tokens arrive in the body (POST), never in a URL path or query, so they
// don't show up in any access log between the browser and us.

// POST /api/links/info { token }
router.post('/info', (req, res) => {
  const row = links.find((req.body || {}).token);
  const st = links.state(row);
  if (st !== 'valid') return res.json({ valid: false, reason: st });
  if (row.kind === 'setup') return res.json({ valid: true, kind: 'setup', expiresAt: row.expires_at });
  const u = getUser(row.user_id);
  res.json({ valid: true, kind: row.kind, name: u.name, username: u.username, expiresAt: row.expires_at });
});

// POST /api/links/use { token, password, name?, username? }
// Sets the password, ends every session the account had and signs this browser in.
router.post('/use', async (req, res) => {
  const body = req.body || {};
  const { token, password } = body;
  if (!validPassword(password)) {
    return res.status(400).json({ error: `Password must be ${PW_MIN} to 200 characters.` });
  }
  const first = links.find(token);
  if (links.state(first) !== 'valid') return res.status(400).json({ error: 'This link is not valid any more.' });

  let setup = null;
  if (first.kind === 'setup') {
    const name = clean(body.name, 40);
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    if (!name) return res.status(400).json({ error: 'Enter your name.' });
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username: 3 to 24 letters, numbers, dots, dashes or underscores.' });
    if (getUserByUsername(username)) return res.status(409).json({ error: 'That username is already taken.' });
    setup = { name, username };
  }

  const hash = await hashPassword(password);

  // Re-check after the await: a second tab may have used the link meanwhile.
  // Everything below is synchronous, so no other request can interleave.
  const row = links.find(token);
  if (links.state(row) !== 'valid' || row.id !== first.id) {
    return res.status(400).json({ error: 'This link is not valid any more.' });
  }
  if (setup && getUserByUsername(setup.username)) return res.status(409).json({ error: 'That username is already taken.' });

  let userId;
  db.transaction(() => {
    const t = now();
    if (setup) {
      const firstEver = db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0;
      userId = db.prepare(
        "INSERT INTO users (username, name, role, password_hash, created_at, created_by) VALUES (?, ?, 'it', ?, ?, NULL)"
      ).run(setup.username, setup.name, hash, t).lastInsertRowid;
      db.prepare('UPDATE links SET used_at = ?, user_id = ? WHERE id = ?').run(t, userId, row.id);
      const u = getUser(userId);
      pwlog(userId, userId, 'setup_used');
      log(u, 'account', firstEver
        ? 'set up Kivo Office and the first IT admin account (@' + u.username + ')'
        : 'used a setup link to create the IT admin account "' + u.name + '" (@' + u.username + ')', { subjectId: u.id });
    } else {
      userId = row.user_id;
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
      db.prepare('UPDATE links SET used_at = ? WHERE id = ?').run(t, row.id);
      // any other unused link for this account is now pointless
      links.revokeAllFor(userId);
      const ended = sessions.destroyAllFor(userId);
      const u = getUser(userId);
      pwlog(userId, userId, row.kind === 'invite' ? 'invite_used' : 'reset_used');
      log(u, 'password', row.kind === 'invite'
        ? 'used the invite link and set their own password'
        : 'used a reset link and set a new password' + (ended ? ' (' + ended + ' open session' + (ended === 1 ? '' : 's') + ' ended)' : ''), { subjectId: u.id });
    }
    if (req.session) sessions.destroy(req.session.tokenHash);
    sessions.create(res, userId);
    log(getUser(userId), 'login', 'signed in after setting their password');
  })();

  res.json({ user: meView(getUser(userId)) });
});

module.exports = router;
