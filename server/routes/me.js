const express = require('express');
const db = require('../db');
const P = require('../permissions');
const { log } = require('../audit');
const { getUser } = require('../store');
const { requireUser } = require('../middleware/auth');
const { now, clean, EMAIL_RE } = require('../util');
const { fail, personFor } = require('./helpers');
const { meView, personRow } = require('./views');

// Mounted at /api: the signed-in user's own profile, a manager's team, and
// the people a manager can put on a roadmap. requireUser is per route (see tasks.js).
const router = express.Router();

// The client shrinks pictures to a 128 px JPEG, but the server trusts none of
// that: strict data URL, at most 100 KB decoded, and the first bytes must
// really be the image type the URL claims.
const IMG_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const MAX_AVATAR_BYTES = 100 * 1024;
function validAvatar(s) {
  if (typeof s !== 'string' || s.length > 140000) return false;
  const m = IMG_RE.exec(s);
  if (!m || m[2].length % 4 !== 0) return false;
  const buf = Buffer.from(m[2], 'base64');
  // round trip catches anything Buffer silently skipped
  if (buf.length === 0 || buf.length > MAX_AVATAR_BYTES || buf.toString('base64') !== m[2]) return false;
  if (m[1] === 'jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (m[1] === 'png') return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
}

// PUT /api/me/profile { name?, avatar?, presence?, statusText?, email? }
// avatar: omitted = unchanged, '' = remove, data URL = new picture.
router.put('/me/profile', requireUser, (req, res) => {
  const u = req.user;
  const p = req.body || {};
  const set = {};
  const changes = [];
  if ('name' in p) {
    const n = clean(p.name, 40);
    if (!n) return fail(res, 400, 'Name cannot be empty.');
    if (n !== u.name) { changes.push('name'); set.name = n; }
  }
  if ('avatar' in p) {
    if (p.avatar !== '' && !validAvatar(p.avatar)) return fail(res, 400, 'That picture could not be used.');
    const current = db.prepare('SELECT avatar FROM users WHERE id = ?').get(u.id).avatar;
    if (p.avatar !== current) {
      changes.push(p.avatar ? 'profile picture' : 'removed profile picture');
      set.avatar = p.avatar;
      set.avatar_at = now();
    }
  }
  if ('presence' in p) {
    if (!P.PRESENCE.includes(p.presence)) return fail(res, 400, 'Unknown status.');
    if (p.presence !== u.presence) { changes.push('status to ' + P.PRESENCE_LABEL[p.presence].toLowerCase()); set.presence = p.presence; }
  }
  if ('statusText' in p) {
    const s = clean(p.statusText, 80);
    if (s !== u.statusText) { changes.push('status message'); set.status_text = s; }
  }
  if ('email' in p) {
    const e = typeof p.email === 'string' ? p.email.trim() : '';
    if (e && (e.length > 254 || !EMAIL_RE.test(e))) return fail(res, 400, 'That email address does not look right.');
    if (e !== u.email) { changes.push('email address'); set.email = e; }
  }
  if (changes.length) {
    const cols = Object.keys(set);
    db.transaction(() => {
      db.prepare(`UPDATE users SET ${cols.map((c) => c + ' = @' + c).join(', ')} WHERE id = @id`).run(Object.assign({ id: u.id }, set));
      log(u, 'profile', 'changed their ' + changes.join(', '), { subjectId: u.id });
    })();
  }
  res.json({ changed: changes.length > 0, user: meView(getUser(u.id)) });
});

// GET /api/team — a manager's own team members.
router.get('/team', requireUser, (req, res) => {
  const u = req.user;
  if (u.role !== 'manager') return fail(res, 403, 'Only managers have a team page.');
  const ms = db.prepare("SELECT id FROM users WHERE role = 'member' AND created_by = ? ORDER BY id").all(u.id).map((r) => getUser(r.id));
  res.json({ members: ms.map((x) => personRow(u, x)) });
});

// GET /api/people/addable — for the roadmap create / settings modal.
router.get('/people/addable', requireUser, (req, res) => {
  const u = req.user;
  if (u.role !== 'manager') return fail(res, 403, 'Only managers put people on roadmaps.');
  const team = db.prepare("SELECT id FROM users WHERE role = 'member' AND created_by = ? AND active = 1").all(u.id).map((r) => r.id);
  res.json({ people: P.addablePeople(u).map((x) => personFor(u, x)), team });
});

module.exports = router;
module.exports.validAvatar = validAvatar;
