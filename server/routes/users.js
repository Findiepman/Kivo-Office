const express = require('express');
const db = require('../db');
const links = require('../links');
const sessions = require('../sessions');
const mail = require('../mail');
const { APP_URL } = require('../config');
const P = require('../permissions');
const { log } = require('../audit');
const { getUser, getUserByUsername, getRoadmap, touchRoadmap, touchTask } = require('../store');
const { requireUser } = require('../middleware/auth');
const { now, clean, USERNAME_RE, EMAIL_RE, toId, plural } = require('../util');
const { deny, fail, auditPage, personFor } = require('./helpers');
const { personRow, lastLogin } = require('./views');

const router = express.Router();
router.use(requireUser);

function cleanEmail(v) {
  const e = typeof v === 'string' ? v.trim() : '';
  if (!e) return '';
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

async function linkResponse(target, issued, kind) {
  const emailed = await mail.sendLink({
    to: target.email, name: target.name, kind, link: links.buildLink(issued.token), expiresAt: issued.expiresAt,
  });
  return {
    token: issued.token,
    // only set when APP_URL is configured; otherwise the page builds it from its own address
    link: APP_URL ? links.buildLink(issued.token) : null,
    expiresAt: issued.expiresAt,
    kind,
    emailed,
  };
}

// POST /api/users { role, name, username, email? }
// IT invites managers and IT admins; managers invite team members.
router.post('/', async (req, res) => {
  const actor = req.user;
  const { role } = req.body || {};
  if (!['manager', 'member', 'it'].includes(role)) return fail(res, 400, 'Unknown account type.');
  if (role === 'member' ? actor.role !== 'manager' : actor.role !== 'it') {
    return deny(req, res, 403, 'creating an account',
      role === 'member' ? 'Only managers can create team member accounts.' : 'Only IT admins can create manager and IT admin accounts.');
  }
  const name = clean(req.body.name, 40);
  const username = typeof req.body.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const email = cleanEmail(req.body.email);
  if (!name) return fail(res, 400, 'Enter a name.');
  if (!USERNAME_RE.test(username)) return fail(res, 400, 'Username: 3 to 24 letters, numbers, dots, dashes or underscores.');
  if (email === null) return fail(res, 400, 'That email address does not look right.');
  if (getUserByUsername(username)) return fail(res, 409, 'That username is already taken.');

  let u;
  let issued;
  db.transaction(() => {
    const id = db.prepare(
      'INSERT INTO users (username, name, role, email, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(username, name, role, email, now(), actor.id).lastInsertRowid;
    u = getUser(id);
    log(actor, 'account', 'created the ' + P.ROLE_LABEL[role].toLowerCase() + ' account "' + u.name + '" (@' + u.username + ')', { subjectId: u.id });
    issued = links.issue(actor, u, 'invite');
  })();
  const out = await linkResponse(u, issued, 'invite');
  if (out.emailed === 'sent') log(actor, 'password', 'emailed the invite link to ' + u.name, { subjectId: u.id });
  res.status(201).json(Object.assign({ user: personRow(actor, getUser(u.id)) }, out));
});

// An account the viewer may not see answers exactly like one that doesn't
// exist, so ids can't be probed through any of the routes below.
const HIDDEN = "That account doesn't exist, or you can't view it.";
function loadTarget(req, res) {
  const id = toId(req.params.id);
  const t = id && getUser(id);
  if (!t || !P.canSeeProfile(req.user, t)) {
    fail(res, 404, HIDDEN);
    return null;
  }
  return t;
}

// POST /api/users/:id/link — a fresh invite (no password yet) or reset link.
// The old password keeps working until the link is used.
router.post('/:id/link', async (req, res) => {
  const t = loadTarget(req, res);
  if (!t) return;
  if (!P.canResetPassword(req.user, t)) return deny(req, res, 403, 'sending a link to ' + t.name, 'You cannot send a link to this account.', { subjectId: t.id });
  const kind = t.hasPassword ? 'reset' : 'invite';
  const issued = links.issue(req.user, t, kind);
  const out = await linkResponse(t, issued, kind);
  if (out.emailed === 'sent') log(req.user, 'password', 'emailed the ' + kind + ' link to ' + t.name, { subjectId: t.id });
  res.json(out);
});

// Unassign someone from their open tasks. Archived and deleted roadmaps are
// left alone: they are read-only records, the assignee stays as history.
function unassignOpenTasks(actor, who, why) {
  const rows = db.prepare(
    `SELECT t.id, t.title, t.roadmap_id FROM tasks t
     JOIN task_assignees a ON a.task_id = t.id
     JOIN roadmaps r ON r.id = t.roadmap_id
     WHERE a.user_id = ? AND t.status != 'finished' AND r.archived_at IS NULL AND r.deleted_at IS NULL
     ORDER BY t.id`
  ).all(who.id);
  for (const t of rows) {
    db.prepare('DELETE FROM task_assignees WHERE task_id = ? AND user_id = ?').run(t.id, who.id);
    db.prepare('INSERT INTO task_flags (task_id, user_id, reason, at) VALUES (?, ?, ?, ?)').run(t.id, who.id, why, now());
    touchTask(t.id);
    log(actor, 'task', 'unassigned ' + who.name + ' from "' + t.title + '" (' + why + '); the roadmap owner needs to pick someone new',
      { roadmapId: t.roadmap_id, taskId: t.id, subjectId: who.id });
  }
  return rows.length;
}

function doDeactivate(actor, t) {
  db.prepare('UPDATE users SET active = 0, deactivated_at = ?, deactivated_by = ? WHERE id = ?').run(now(), actor.id, t.id);
  links.revokeAllFor(t.id);
  log(actor, 'account', 'deactivated the account of ' + t.name, { subjectId: t.id });
  unassignOpenTasks(actor, t, 'account deactivated');
  // their sessions end at once, whatever device they are on
  sessions.destroyAllFor(t.id);
}

function deactivateRefusal(actor, t) {
  if (!P.canDeactivate(actor, t)) return [403, 'You cannot deactivate this account.'];
  if (!t.active) return [400, 'This account is already deactivated.'];
  const b = P.deactivationBlockers(t.id);
  if (b.includes('last-it')) return [409, 'This is the last active IT admin. Create or reactivate another IT admin first.'];
  if (b.includes('transfer')) return [409, 'This manager still owns roadmaps or team members. Transfer them to another manager first.'];
  return null;
}

// POST /api/users/:id/deactivate — accounts are never deleted.
router.post('/:id/deactivate', (req, res) => {
  const t = loadTarget(req, res);
  if (!t) return;
  const no = deactivateRefusal(req.user, t);
  if (no) return deny(req, res, no[0], 'deactivating ' + t.name, no[1], { subjectId: t.id });
  db.transaction(() => doDeactivate(req.user, t))();
  res.json({ ok: true, user: personRow(req.user, getUser(t.id)) });
});

// POST /api/users/:id/reactivate
router.post('/:id/reactivate', (req, res) => {
  const t = loadTarget(req, res);
  if (!t) return;
  const actor = req.user;
  if (!P.canDeactivate(actor, t)) return deny(req, res, 403, 'reactivating ' + t.name, 'You cannot reactivate this account.', { subjectId: t.id });
  if (t.active) return fail(res, 400, 'This account is already active.');
  if (!P.canReactivate(actor, t)) return deny(req, res, 403, 'reactivating ' + t.name, 'IT deactivated this account, so only IT can reactivate it.', { subjectId: t.id });
  db.transaction(() => {
    db.prepare('UPDATE users SET active = 1, deactivated_at = NULL, deactivated_by = NULL WHERE id = ?').run(t.id);
    log(actor, 'account', 'reactivated the account of ' + t.name, { subjectId: t.id });
  })();
  res.json({ ok: true, user: personRow(actor, getUser(t.id)) });
});

// POST /api/users/:id/transfer { toId, deactivate? }
// IT moves a manager's roadmaps (archived ones included, their tasks stay
// frozen) and team to another manager. With deactivate: true it also
// deactivates the old manager, in the same transaction.
router.post('/:id/transfer', (req, res) => {
  const from = loadTarget(req, res);
  if (!from) return;
  const actor = req.user;
  if (actor.role !== 'it') return deny(req, res, 403, 'transferring a team', "Only IT admins can transfer a manager's roadmaps and team.", { subjectId: from.id });
  if (from.role !== 'manager') return fail(res, 400, 'Pick the manager to transfer from.');
  const to = getUser(toId(req.body && req.body.toId));
  if (!to || to.role !== 'manager' || !to.active || to.id === from.id) return fail(res, 400, 'Pick an active manager to transfer to.');

  let result;
  try {
    db.transaction(() => {
      const rs = P.ownedRoadmapIds(from.id).map(getRoadmap);
      const ms = db.prepare("SELECT id FROM users WHERE role = 'member' AND created_by = ?").all(from.id);
      for (const r of rs) {
        db.prepare('UPDATE roadmaps SET manager_id = ? WHERE id = ?').run(to.id, r.id);
        touchRoadmap(r.id);
        db.prepare('DELETE FROM roadmap_members WHERE roadmap_id = ? AND user_id = ?').run(r.id, to.id);
        db.prepare('DELETE FROM roadmap_creators WHERE roadmap_id = ? AND user_id = ?').run(r.id, to.id);
        // archived roadmaps change owner (a deactivated manager can't keep them) but their tasks stay frozen
        if (!r.archivedAt) {
          const open = db.prepare(
            `SELECT t.id FROM tasks t JOIN task_assignees a ON a.task_id = t.id
             WHERE t.roadmap_id = ? AND a.user_id = ? AND t.status != 'finished'`
          ).all(r.id, from.id);
          for (const t of open) {
            db.prepare('DELETE FROM task_assignees WHERE task_id = ? AND user_id = ?').run(t.id, from.id);
            db.prepare('INSERT INTO task_flags (task_id, user_id, reason, at) VALUES (?, ?, ?, ?)').run(t.id, from.id, 'roadmap transferred', now());
            touchTask(t.id);
          }
        }
        log(actor, 'transfer', 'moved the roadmap "' + r.title + '" from ' + from.name + ' to ' + to.name, { roadmapId: r.id, subjectId: to.id });
      }
      db.prepare("UPDATE users SET created_by = ? WHERE role = 'member' AND created_by = ?").run(to.id, from.id);
      log(actor, 'transfer', 'transferred ' + plural(rs.length, 'roadmap', 'roadmaps') + ' and ' + plural(ms.length, 'team member', 'team members') +
        ' from ' + from.name + ' to ' + to.name, { subjectId: from.id });
      result = { roadmaps: rs.length, members: ms.length };
      if (req.body.deactivate === true) {
        const fresh = getUser(from.id);
        const no = deactivateRefusal(actor, fresh);
        if (no) throw Object.assign(new Error(no[1]), { status: no[0] });
        doDeactivate(actor, fresh);
        result.deactivated = true;
      }
    })();
  } catch (e) {
    if (e.status) return fail(res, e.status, e.message);
    throw e;
  }
  res.json(result);
});

// GET /api/users/:id — profile card plus what the viewer may do to it.
router.get('/:id', (req, res) => {
  const t = loadTarget(req, res);
  if (!t) return;
  const u = req.user;
  const row = personRow(u, t);
  row.createdAt = t.createdAt;
  row.createdBy = t.createdBy ? personFor(u, getUser(t.createdBy)) : null;
  row.lastLogin = lastLogin(t.id);
  // the very first account, made with the very first setup link
  row.original = !t.createdBy && t.id === db.prepare('SELECT MIN(id) AS id FROM users').get().id;
  row.isMe = u.id === t.id;
  if (P.canSeeAccountLog(u, t)) row.email = t.email;
  res.json({ user: row });
});

// GET /api/users/:id/log?part=by|about&q=&page=
router.get('/:id/log', (req, res) => {
  const t = loadTarget(req, res);
  if (!t) return;
  if (!P.canSeeAccountLog(req.user, t)) return fail(res, 403, "You cannot see this account's log.");
  const about = req.query.part === 'about';
  res.json(about
    ? auditPage(req, 'a.subject_id = @id AND (a.actor_id IS NULL OR a.actor_id != @id)', { id: t.id })
    : auditPage(req, 'a.actor_id = @id', { id: t.id }));
});

// GET /api/users/:id/avatar — the stored data URL served as a real image, so
// lists don't have to carry every picture inline.
// Same visibility as the profile itself.
router.get('/:id/avatar', (req, res) => {
  const id = toId(req.params.id);
  const t = id && getUser(id);
  if (!t || !P.canSeeProfile(req.user, t)) return res.status(404).end();
  const row = db.prepare('SELECT avatar FROM users WHERE id = ?').get(id);
  const m = row && /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(row.avatar);
  if (!m) return res.status(404).end();
  res.setHeader('Content-Type', m[1]);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(Buffer.from(m[2], 'base64'));
});

module.exports = router;
