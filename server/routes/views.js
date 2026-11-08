const db = require('../db');
const links = require('../links');
const { getUser, person } = require('../store');
const { personFor } = require('./helpers');
const P = require('../permissions');

// Payload builders shared by several routes. Each one carries the results of
// the permission rules for the viewer, so the UI never has to guess.

function meView(u) {
  return Object.assign(person(u), { email: u.email });
}

function lastLogin(id) {
  const row = db
    .prepare("SELECT at FROM audit_log WHERE actor_id = ? AND action = 'login' AND text LIKE 'signed in%' ORDER BY id DESC LIMIT 1")
    .get(id);
  return row ? row.at : null;
}

// A person as shown in IT / team / profile lists, with what the viewer may do.
function personRow(viewer, x) {
  const p = personFor(viewer, x);
  p.pending = !x.hasPassword;
  p.pendingInvite = x.hasPassword ? null : links.pendingFor(x.id);
  p.deactivatedByIt = !x.active && !!x.deactivatedBy && (getUser(x.deactivatedBy) || {}).role === 'it';
  p.can = {
    reset: P.canResetPassword(viewer, x),
    deactivate: P.canDeactivate(viewer, x) && x.active,
    reactivate: P.canReactivate(viewer, x),
    toggle: P.canDeactivate(viewer, x),
    seeLog: P.canSeeAccountLog(viewer, x),
  };
  p.blockers = P.canDeactivate(viewer, x) && x.active ? P.deactivationBlockers(x.id) : [];
  return p;
}

function counts(roadmapId) {
  const rows = db.prepare('SELECT status, COUNT(*) AS c FROM tasks WHERE roadmap_id = ? GROUP BY status').all(roadmapId);
  const c = { planned: 0, in_progress: 0, finished: 0 };
  for (const r of rows) c[r.status] = r.c;
  c.total = c.planned + c.in_progress + c.finished;
  return c;
}

// A roadmap "flight strip" for the dashboards.
function strip(viewer, r) {
  const mine = db
    .prepare(
      `SELECT COUNT(*) AS c FROM tasks t JOIN task_assignees a ON a.task_id = t.id
       WHERE t.roadmap_id = ? AND a.user_id = ? AND t.status != 'finished'`
    )
    .get(r.id, viewer.id).c;
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    archivedAt: r.archivedAt,
    deletedAt: r.deletedAt,
    createdAt: r.createdAt,
    counts: counts(r.id),
    mine,
    manager: personFor(viewer, getUser(r.managerId)),
    people: r.memberIds.map((id) => personFor(viewer, getUser(id))).filter(Boolean),
    can: P.roadmapCan(viewer, r),
  };
}

module.exports = { meView, lastLogin, personRow, strip, counts };
