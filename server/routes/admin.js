const express = require('express');
const db = require('../db');
const { getUser, getRoadmap } = require('../store');
const { requireUser } = require('../middleware/auth');
const { fail, auditPage, pageArgs, likeArg, peopleMap, personFor, PAGE_SIZE } = require('./helpers');
const { personRow, strip } = require('./views');

// IT-only views, mounted at /api/admin.
const router = express.Router();
router.use(requireUser);
router.use((req, res, next) => {
  if (req.user.role !== 'it') return fail(res, 403, 'Only IT admins can see this.');
  next();
});

// GET /api/admin/overview — the IT dashboard in one request.
router.get('/overview', (req, res) => {
  const u = req.user;
  const all = db.prepare('SELECT id FROM roadmaps ORDER BY id').all().map((r) => getRoadmap(r.id));
  const users = db.prepare('SELECT id FROM users ORDER BY id').all().map((r) => getUser(r.id));
  const managers = users.filter((x) => x.role === 'manager');
  res.json({
    roadmaps: all.filter((r) => !r.deletedAt && !r.archivedAt).map((r) => strip(u, r)),
    archived: all.filter((r) => !r.deletedAt && r.archivedAt).map((r) => strip(u, r)),
    deleted: all.filter((r) => r.deletedAt).map((r) => ({
      id: r.id, title: r.title, deletedAt: r.deletedAt, manager: personFor(u, getUser(r.managerId)),
    })),
    managers: managers.map((m) => Object.assign(personRow(u, m), {
      members: users.filter((x) => x.role === 'member' && x.createdBy === m.id).map((x) => personRow(u, x)),
      ownedRoadmaps: all.filter((r) => r.managerId === m.id && !r.deletedAt).length,
    })),
    admins: users.filter((x) => x.role === 'it').map((x) => personRow(u, x)),
  });
});

// GET /api/admin/log?q=&page= — everything, newest first.
router.get('/log', (req, res) => {
  res.json(auditPage(req, '1 = 1', {}));
});

// The labels the password log page shows, so filtering on what you see works.
const KIND_LABEL = `CASE p.kind
  WHEN 'invite_issued' THEN 'invite link issued' WHEN 'invite_used' THEN 'invite used, password set'
  WHEN 'reset_issued' THEN 'reset link issued' WHEN 'reset_used' THEN 'reset used, password set'
  WHEN 'setup_issued' THEN 'setup link printed' WHEN 'setup_used' THEN 'setup link used' ELSE p.kind END`;

// GET /api/admin/passwords?q=&page= — who issued which link, and when it was used.
router.get('/passwords', (req, res) => {
  const { page, q, offset } = pageArgs(req);
  const filter = q
    ? ` AND (lower(coalesce(t.name, '')) LIKE @q ESCAPE '\\' OR lower(coalesce(t.username, '')) LIKE @q ESCAPE '\\'
          OR lower(coalesce(b.name, '')) LIKE @q ESCAPE '\\' OR replace(p.kind, '_', ' ') LIKE @q ESCAPE '\\'
          OR ${KIND_LABEL} LIKE @q ESCAPE '\\')`
    : '';
  const args = q ? { q: likeArg(q) } : {};
  const base = `FROM password_log p LEFT JOIN users t ON t.id = p.user_id LEFT JOIN users b ON b.id = p.by_id WHERE 1 = 1${filter}`;
  const total = db.prepare(`SELECT COUNT(*) AS c ${base}`).get(args).c;
  const rows = db.prepare(`SELECT p.* ${base} ORDER BY p.id DESC LIMIT ${PAGE_SIZE} OFFSET @offset`).all(Object.assign({ offset }, args));
  res.json({
    entries: rows.map((p) => ({ id: p.id, at: p.at, userId: p.user_id, byId: p.by_id, kind: p.kind })),
    people: peopleMap(req.user, rows.flatMap((p) => [p.user_id, p.by_id])),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    q,
  });
});

module.exports = router;
