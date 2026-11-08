const express = require('express');
const db = require('../db');
const P = require('../permissions');
const { log } = require('../audit');
const { getUser, getRoadmap, getTask, dn, touchTask } = require('../store');
const { requireUser } = require('../middleware/auth');
const { now, clean, cleanLong, toId } = require('../util');
const { deny, fail, personFor } = require('./helpers');

// Mounted at /api: /roadmaps/:id/tasks, /tasks/:id, /tasks/:id/comments, /comments/:id.
// requireUser is per route, not router.use: a router on bare /api would
// otherwise answer every unknown /api path with 401 instead of 404.
const router = express.Router();

// Up to 6 unique tags of at most 24 chars; accepts an array or "a, b, c".
function parseTags(v) {
  const arr = Array.isArray(v) ? v.slice(0, 50) : typeof v === 'string' ? v.slice(0, 2000).split(',') : [];
  return Array.from(new Set(arr.map((x) => clean(x, 24)).filter(Boolean))).slice(0, 6);
}

// Only people on the roadmap who are active can be assigned. Someone already
// on the task who has since been deactivated (finished and archived tasks
// keep them as history) may stay when the list still names them; the task
// form can't show them, so a plain Save must not quietly drop them.
function pickAssignees(v, r, existing) {
  const ok = P.assignable(r);
  const keep = existing || [];
  const ids = Array.isArray(v) ? v.slice(0, 1000).map(toId).filter(Boolean) : [];
  return Array.from(new Set(ids.filter((id) => ok.includes(id) || keep.includes(id))));
}

const names = (ids) => ids.map((id) => dn(getUser(id))).join(', ');

function setAssignees(taskId, ids) {
  db.prepare('DELETE FROM task_assignees WHERE task_id = ?').run(taskId);
  const add = db.prepare('INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)');
  ids.forEach((id) => add.run(taskId, id));
}

// Loads task + roadmap and refuses (404) anything the user can't see.
function loadTask(req, res) {
  const id = toId(req.params.id);
  const t = id && getTask(id);
  const r = t && getRoadmap(t.roadmapId);
  if (!t || !r || !P.canViewRoadmap(req.user, r)) {
    fail(res, 404, 'You cannot see this task.');
    return [null, null];
  }
  return [t, r];
}

// POST /api/roadmaps/:id/tasks
router.post('/roadmaps/:id/tasks', requireUser, (req, res) => {
  const actor = req.user;
  const rid = toId(req.params.id);
  const r = rid && getRoadmap(rid);
  if (!r || !P.canViewRoadmap(actor, r)) return fail(res, 404, "That roadmap doesn't exist, or you don't have access to it.");
  if (!P.isCreator(actor, r)) {
    return deny(req, res, P.isArchived(r) ? 409 : 403, 'creating a task on "' + r.title + '"',
      P.isArchived(r) ? P.ARCHIVED_MSG : 'You are not allowed to create tasks on this roadmap.', { roadmapId: r.id });
  }
  const d = req.body || {};
  const title = clean(d.title, 120);
  if (!title) return fail(res, 400, 'Give the task a name.');
  const assignees = pickAssignees(d.assignees, r);
  let id;
  db.transaction(() => {
    id = db.prepare(
      "INSERT INTO tasks (roadmap_id, title, description, status, tags, created_by, created_at, updated_at) VALUES (?, ?, ?, 'planned', ?, ?, ?, ?)"
    ).run(r.id, title, cleanLong(d.description, 2000), JSON.stringify(parseTags(d.tags)), actor.id, now(), now()).lastInsertRowid;
    setAssignees(id, assignees);
    log(actor, 'task', 'created the task "' + title + '"', { roadmapId: r.id, taskId: id });
    if (assignees.length) log(actor, 'task', 'assigned "' + title + '" to ' + names(assignees), { roadmapId: r.id, taskId: id });
  })();
  res.status(201).json({ task: { id } });
});

// PATCH /api/tasks/:id — any of: title, description, tags (need: assigned),
// status (forward: assigned, back: owner), assignees (need: canAssign).
// fromStatus, when sent, must still be the task's status: the confirm dialog
// was opened on that state and must not move a task someone else just moved.
router.patch('/tasks/:id', requireUser, (req, res) => {
  const [t, r] = loadTask(req, res);
  if (!t) return;
  const actor = req.user;
  const patch = req.body || {};
  const ctx = { roadmapId: r.id, taskId: t.id };
  const what = 'changing "' + t.title + '"';
  if (P.isArchived(r)) return deny(req, res, 409, what, P.ARCHIVED_MSG, ctx);
  if ('fromStatus' in patch && patch.fromStatus !== t.status) {
    return fail(res, 409, 'This task changed while the dialog was open. Nothing was moved.');
  }
  // the task form sends everything it shows; a stamp from an older copy means
  // saving it would undo someone else's change
  if ('updatedAt' in patch && patch.updatedAt !== t.updatedAt) {
    return fail(res, 409, 'Someone else changed this. Reload and try again.');
  }

  const next = {};
  if ('title' in patch) {
    next.title = clean(patch.title, 120);
    if (!next.title) return fail(res, 400, 'Give the task a name.');
  }
  if ('description' in patch) next.description = cleanLong(patch.description, 2000);
  if ('tags' in patch) next.tags = parseTags(patch.tags);
  if ('status' in patch) {
    if (!P.STATUSES.includes(patch.status)) return fail(res, 400, 'Unknown status.');
    next.status = patch.status;
  }
  if ('assignees' in patch) next.assignees = pickAssignees(patch.assignees, r, t.assignees);

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const sorted = (a) => a.slice().sort((x, y) => x - y);
  const contentKeys = ['title', 'description', 'tags'].filter((k) => k in next && !same(next[k], t[k]));
  const statusChanged = 'status' in next && next.status !== t.status;
  const assignChanged = 'assignees' in next && !same(sorted(next.assignees), sorted(t.assignees));

  if (contentKeys.length && !P.canEditTask(actor, t, r)) return deny(req, res, 403, what, 'Only the people assigned to this task can edit it.', ctx);
  let move = null;
  if (statusChanged) {
    move = P.canMove(actor, t, r, next.status);
    if (!move.ok) return deny(req, res, 403, what, move.reason, ctx);
  }
  if (assignChanged && !P.canAssign(actor, r, t)) return deny(req, res, 403, what, 'You cannot change who this task is assigned to.', ctx);

  db.transaction(() => {
    if (contentKeys.length || statusChanged || assignChanged) touchTask(t.id);
    const oldTitle = t.title;
    if (statusChanged) {
      const from = P.STATUS_LABEL[t.status];
      const to = P.STATUS_LABEL[next.status];
      db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(next.status, t.id);
      if (move.override) log(actor, 'override', 'moved "' + oldTitle + '" back from ' + from + ' to ' + to + ' (owner override)', ctx);
      else if (next.status === 'finished') log(actor, 'task', 'completed "' + oldTitle + '"', ctx);
      else log(actor, 'task', 'moved "' + oldTitle + '" from ' + from + ' to ' + to, ctx);
    }
    if (contentKeys.length) {
      const v = Object.assign({ title: t.title, description: t.description, tags: t.tags }, next);
      db.prepare('UPDATE tasks SET title = ?, description = ?, tags = ? WHERE id = ?').run(v.title, v.description, JSON.stringify(v.tags), t.id);
      log(actor, 'task', 'edited "' + oldTitle + '" (' + contentKeys.join(', ') + ')', ctx);
    }
    if (assignChanged) {
      const title = contentKeys.includes('title') ? next.title : t.title;
      const added = next.assignees.filter((id) => !t.assignees.includes(id));
      const removed = t.assignees.filter((id) => !next.assignees.includes(id));
      setAssignees(t.id, next.assignees);
      // a task with people on it again no longer needs a new assignee
      if (next.assignees.length) db.prepare('DELETE FROM task_flags WHERE task_id = ?').run(t.id);
      if (added.length) log(actor, 'task', 'assigned "' + title + '" to ' + names(added), ctx);
      if (removed.length) log(actor, 'task', 'unassigned ' + names(removed) + ' from "' + title + '"', ctx);
    }
  })();
  res.json({ ok: true, changed: contentKeys.length > 0 || statusChanged || assignChanged });
});

// DELETE /api/tasks/:id — the owner, or the creator while they may still create tasks.
router.delete('/tasks/:id', requireUser, (req, res) => {
  const [t, r] = loadTask(req, res);
  if (!t) return;
  const actor = req.user;
  const what = 'deleting the task "' + t.title + '"';
  if (P.isArchived(r)) return deny(req, res, 409, what, P.ARCHIVED_MSG, { roadmapId: r.id, taskId: t.id });
  if (!P.canDeleteTask(actor, t, r)) {
    return deny(req, res, 403, what, 'Only the roadmap owner, or the person who created the task, can delete it.', { roadmapId: r.id, taskId: t.id });
  }
  db.transaction(() => {
    // comments, assignees and flags go with it (ON DELETE CASCADE); the log stays
    db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
    log(actor, 'task', 'deleted the task "' + t.title + '"', { roadmapId: r.id });
  })();
  res.json({ ok: true });
});

function commentView(u, c, r) {
  return { id: c.id, userId: c.user_id, text: c.text, at: c.at, canDelete: P.canDeleteComment(u, { userId: c.user_id }, r) };
}

// GET /api/tasks/:id/comments
router.get('/tasks/:id/comments', requireUser, (req, res) => {
  const [t, r] = loadTask(req, res);
  if (!t) return;
  const rows = db.prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY id').all(t.id);
  const people = {};
  rows.forEach((c) => { if (!people[c.user_id]) people[c.user_id] = personFor(req.user, getUser(c.user_id)); });
  res.json({ comments: rows.map((c) => commentView(req.user, c, r)), people });
});

// POST /api/tasks/:id/comments { text } — anyone who can see the roadmap.
router.post('/tasks/:id/comments', requireUser, (req, res) => {
  const [t, r] = loadTask(req, res);
  if (!t) return;
  const actor = req.user;
  if (P.isArchived(r)) return deny(req, res, 409, 'commenting on "' + t.title + '"', P.ARCHIVED_MSG, { roadmapId: r.id, taskId: t.id });
  const text = cleanLong((req.body || {}).text, 1000);
  if (!text) return fail(res, 400, 'Write something first.');
  let id;
  db.transaction(() => {
    id = db.prepare('INSERT INTO comments (task_id, user_id, text, at) VALUES (?, ?, ?, ?)').run(t.id, actor.id, text, now()).lastInsertRowid;
    log(actor, 'comment', 'commented on "' + t.title + '"', { roadmapId: r.id, taskId: t.id });
  })();
  res.status(201).json({ comment: { id } });
});

// DELETE /api/comments/:id — own comment, the roadmap owner, or IT.
router.delete('/comments/:id', requireUser, (req, res) => {
  const id = toId(req.params.id);
  const c = id && db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
  const t = c && getTask(c.task_id);
  const r = t && getRoadmap(t.roadmapId);
  if (!c || !r || !P.canViewRoadmap(req.user, r)) return fail(res, 404, 'That comment no longer exists.');
  const ctx = { roadmapId: r.id, taskId: t.id, subjectId: c.user_id };
  const what = 'deleting a comment on "' + t.title + '"';
  if (P.isArchived(r)) return deny(req, res, 409, what, P.ARCHIVED_MSG, ctx);
  if (!P.canDeleteComment(req.user, { userId: c.user_id }, r)) {
    return deny(req, res, 403, what, 'You can delete your own comments. Roadmap owners and IT can delete any.', ctx);
  }
  db.transaction(() => {
    db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
    // the comment leaves the thread; the log keeps the fact, never the text
    log(req.user, 'comment', 'deleted ' + dn(getUser(c.user_id)) + "'s comment on " + '"' + t.title + '"', ctx);
  })();
  res.json({ ok: true });
});

module.exports = router;
