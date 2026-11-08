const express = require('express');
const db = require('../db');
const P = require('../permissions');
const { log } = require('../audit');
const { getUser, getRoadmap, tasksOf, touchRoadmap, touchTask } = require('../store');
const { requireUser } = require('../middleware/auth');
const { now, clean, cleanLong, toId } = require('../util');
const { deny, fail, peopleMap, auditPage } = require('./helpers');
const { strip } = require('./views');

const router = express.Router();
router.use(requireUser);

const STALE = 'Someone else changed this. Reload and try again.';

const idList = (v, max) => (Array.isArray(v) ? v.slice(0, max).map(toId).filter(Boolean) : []);

// Port of Core.normRoadmapInput. The owner can put any active member or
// other manager on a roadmap; people already on it stay allowed even if they
// were deactivated since (so saving the settings doesn't silently drop them).
function normRoadmapInput(actor, d, existing) {
  const title = clean(d.title, 80);
  if (!title) return { error: 'Give the roadmap a name.' };
  const wanted = Array.from(new Set(idList(d.memberIds, 1000)));
  const memberIds = wanted.filter((id) => {
    if (id === actor.id) return false;
    const x = getUser(id);
    if (!x || (x.role !== 'member' && x.role !== 'manager')) return false;
    return x.active || (existing && existing.memberIds.includes(id));
  });
  const creatorMode = ['everyone', 'chosen'].includes(d.creatorMode) ? d.creatorMode : 'manager';
  const creators = creatorMode === 'chosen'
    ? Array.from(new Set(idList(d.creators, 1000).filter((id) => memberIds.includes(id))))
    : [];
  return { title, description: cleanLong(d.description, 400), memberIds, creatorMode, creators };
}

function writePeople(rid, n) {
  db.prepare('DELETE FROM roadmap_members WHERE roadmap_id = ?').run(rid);
  db.prepare('DELETE FROM roadmap_creators WHERE roadmap_id = ?').run(rid);
  const addM = db.prepare('INSERT INTO roadmap_members (roadmap_id, user_id) VALUES (?, ?)');
  const addC = db.prepare('INSERT INTO roadmap_creators (roadmap_id, user_id) VALUES (?, ?)');
  n.memberIds.forEach((id) => addM.run(rid, id));
  n.creators.forEach((id) => addC.run(rid, id));
}

// GET /api/roadmaps — every roadmap the user can see (IT: all of them).
router.get('/', (req, res) => {
  const u = req.user;
  const ids = u.role === 'it'
    ? db.prepare('SELECT id FROM roadmaps WHERE deleted_at IS NULL ORDER BY id').all()
    : db.prepare(
      `SELECT r.id FROM roadmaps r WHERE r.deleted_at IS NULL
         AND (r.manager_id = @id OR EXISTS (SELECT 1 FROM roadmap_members m WHERE m.roadmap_id = r.id AND m.user_id = @id))
       ORDER BY r.id`
    ).all({ id: u.id });
  res.json({ roadmaps: ids.map((r) => strip(u, getRoadmap(r.id))) });
});

// POST /api/roadmaps — managers only; the creator is the owner.
router.post('/', (req, res) => {
  const actor = req.user;
  if (actor.role !== 'manager') return deny(req, res, 403, 'creating a roadmap', 'Only managers can create roadmaps.');
  const n = normRoadmapInput(actor, req.body || {});
  if (n.error) return fail(res, 400, n.error);
  let id;
  db.transaction(() => {
    id = db.prepare(
      'INSERT INTO roadmaps (manager_id, title, description, creator_mode, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(actor.id, n.title, n.description, n.creatorMode, now()).lastInsertRowid;
    writePeople(id, n);
    log(actor, 'roadmap', 'created the roadmap "' + n.title + '"', { roadmapId: id });
  })();
  res.status(201).json({ roadmap: strip(actor, getRoadmap(id)) });
});

function loadRoadmap(req, res) {
  const id = toId(req.params.id);
  const r = id && getRoadmap(id);
  if (!r || !P.canViewRoadmap(req.user, r)) {
    fail(res, 404, "That roadmap doesn't exist, or you don't have access to it.");
    return null;
  }
  return r;
}

// GET /api/roadmaps/:id — the board: roadmap, tasks, people, permissions.
router.get('/:id', (req, res) => {
  const r = loadRoadmap(req, res);
  if (!r) return;
  const u = req.user;
  const tasks = tasksOf(r.id);
  const ccount = {};
  db.prepare(
    'SELECT c.task_id, COUNT(*) AS n FROM comments c JOIN tasks t ON t.id = c.task_id WHERE t.roadmap_id = ? GROUP BY c.task_id'
  ).all(r.id).forEach((row) => { ccount[row.task_id] = row.n; });
  const ids = [r.managerId].concat(r.memberIds, r.creators);
  tasks.forEach((t) => { ids.push(...t.assignees, ...t.flags.map((f) => f.userId)); });
  res.json({
    roadmap: {
      id: r.id,
      title: r.title,
      description: r.description,
      managerId: r.managerId,
      memberIds: r.memberIds,
      creatorMode: r.creatorMode,
      creators: r.creators,
      archivedAt: r.archivedAt,
      updatedAt: r.updatedAt,
      can: P.roadmapCan(u, r),
    },
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      tags: t.tags,
      assignees: t.assignees,
      createdBy: t.createdBy,
      flags: t.flags,
      updatedAt: t.updatedAt,
      commentCount: ccount[t.id] || 0,
      can: P.taskCan(u, t, r),
    })),
    assignable: P.assignable(r),
    people: peopleMap(u, ids),
  });
});

// PUT /api/roadmaps/:id — settings, owner only, not while archived.
router.put('/:id', (req, res) => {
  const r = loadRoadmap(req, res);
  if (!r) return;
  const actor = req.user;
  const what = 'changing the roadmap "' + r.title + '"';
  if (!P.canManageRoadmap(actor, r)) return deny(req, res, 403, what, "Only the roadmap's owner can change its settings.", { roadmapId: r.id });
  if (P.isArchived(r)) return deny(req, res, 409, what, P.ARCHIVED_MSG, { roadmapId: r.id });
  // The settings form replaces everything; if the roadmap changed since the
  // form was loaded, saving would silently undo someone else's change.
  if (req.body && 'updatedAt' in req.body && req.body.updatedAt !== r.updatedAt) return fail(res, 409, STALE);
  const n = normRoadmapInput(actor, req.body || {}, r);
  if (n.error) return fail(res, 400, n.error);
  const changes = [];
  if (n.title !== r.title) changes.push('name');
  if (n.description !== r.description) changes.push('description');
  const sortJoin = (a) => a.slice().sort((x, y) => x - y).join();
  if (n.creatorMode !== r.creatorMode || sortJoin(n.creators) !== sortJoin(r.creators)) changes.push('who can create tasks');
  if (sortJoin(n.memberIds) !== sortJoin(r.memberIds)) changes.push('people');
  if (changes.length) {
    db.transaction(() => {
      db.prepare('UPDATE roadmaps SET title = ?, description = ?, creator_mode = ? WHERE id = ?').run(n.title, n.description, n.creatorMode, r.id);
      touchRoadmap(r.id);
      writePeople(r.id, n);
      // Someone removed from the roadmap loses their assignments on it; open tasks get flagged.
      const onIt = new Set([r.managerId].concat(n.memberIds));
      for (const t of tasksOf(r.id)) {
        const gone = t.assignees.filter((id) => !onIt.has(id));
        for (const g of gone) {
          db.prepare('DELETE FROM task_assignees WHERE task_id = ? AND user_id = ?').run(t.id, g);
          touchTask(t.id);
          if (t.status !== 'finished') {
            db.prepare('INSERT INTO task_flags (task_id, user_id, reason, at) VALUES (?, ?, ?, ?)').run(t.id, g, 'removed from the roadmap', now());
          }
        }
      }
      log(actor, 'roadmap', 'changed the roadmap "' + n.title + '": ' + changes.join(', '), { roadmapId: r.id });
    })();
  }
  res.json({ roadmap: strip(actor, getRoadmap(r.id)), changed: changes.length > 0 });
});

// DELETE /api/roadmaps/:id — soft delete. Tasks and log are kept; IT sees it under Deleted.
router.delete('/:id', (req, res) => {
  const r = loadRoadmap(req, res);
  if (!r) return;
  const actor = req.user;
  const what = 'deleting the roadmap "' + r.title + '"';
  if (!P.canManageRoadmap(actor, r)) return deny(req, res, 403, what, "Only the roadmap's owner can delete it.", { roadmapId: r.id });
  if (P.isArchived(r)) return deny(req, res, 409, what, P.ARCHIVED_MSG, { roadmapId: r.id });
  db.transaction(() => {
    db.prepare('UPDATE roadmaps SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(now(), actor.id, r.id);
    touchRoadmap(r.id);
    log(actor, 'roadmap', 'deleted the roadmap "' + r.title + '"', { roadmapId: r.id });
  })();
  res.json({ ok: true });
});

// POST /api/roadmaps/:id/archive and /unarchive — owner or IT.
function setArchived(on) {
  return (req, res) => {
    const r = loadRoadmap(req, res);
    if (!r) return;
    const actor = req.user;
    const what = (on ? 'archiving' : 'unarchiving') + ' the roadmap "' + r.title + '"';
    if (!P.canArchive(actor, r)) {
      return deny(req, res, 403, what, "Only the roadmap's owner or an IT admin can " + (on ? 'archive' : 'unarchive') + ' it.', { roadmapId: r.id });
    }
    if (on === P.isArchived(r)) return fail(res, 400, on ? 'This roadmap is already archived.' : 'This roadmap is not archived.');
    db.transaction(() => {
      db.prepare('UPDATE roadmaps SET archived_at = ?, archived_by = ? WHERE id = ?').run(on ? now() : null, on ? actor.id : null, r.id);
      touchRoadmap(r.id);
      log(actor, 'roadmap', (on ? 'archived' : 'unarchived') + ' the roadmap "' + r.title + '"', { roadmapId: r.id });
    })();
    res.json({ roadmap: strip(actor, getRoadmap(r.id)) });
  };
}
router.post('/:id/archive', setArchived(true));
router.post('/:id/unarchive', setArchived(false));

// GET /api/roadmaps/:id/log — IT (deleted roadmaps too) and the owner.
router.get('/:id/log', (req, res) => {
  const id = toId(req.params.id);
  const r = id && getRoadmap(id);
  if (!r || !P.canSeeRoadmapLog(req.user, r)) return fail(res, 404, "That log doesn't exist, or you can't view it.");
  const out = auditPage(req, 'a.roadmap_id = @rid', { rid: r.id });
  out.roadmap = { id: r.id, title: r.title, deletedAt: r.deletedAt, archivedAt: r.archivedAt };
  res.json(out);
});

module.exports = router;
