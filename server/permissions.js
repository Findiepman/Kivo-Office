const db = require('./db');
const { getUser, getRoadmap } = require('./store');

// Ported from the prototype's Core (prototype/kivo-office.html). Every route
// checks these before it writes; the UI only receives their results as
// "can" flags to hide buttons. Keep the two in step when a rule changes.

const STATUSES = ['planned', 'in_progress', 'finished'];
const STATUS_LABEL = { planned: 'Planned', in_progress: 'In progress', finished: 'Finished' };
const ROLE_LABEL = { it: 'IT admin', manager: 'Manager', member: 'Team member' };
const PRESENCE = ['available', 'busy', 'away'];
const PRESENCE_LABEL = { available: 'Available', busy: 'Busy', away: 'Away' };
const ARCHIVED_MSG = 'This roadmap is archived and read-only. Unarchive it first.';

const isActive = (u) => !!u && u.active === true;
const isArchived = (r) => !!r && !!r.archivedAt;

function canViewRoadmap(u, r) {
  if (!isActive(u) || !r || r.deletedAt) return false;
  if (u.role === 'it') return true;
  return r.managerId === u.id || r.memberIds.includes(u.id);
}

function isOwner(u, r) {
  return isActive(u) && !!r && !r.deletedAt && u.role === 'manager' && r.managerId === u.id;
}

// Who may create tasks: the owner always; everyone / chosen handlers according to the roadmap setting.
function isCreator(u, r) {
  if (!canViewRoadmap(u, r) || u.role === 'it' || isArchived(r)) return false;
  if (isOwner(u, r)) return true;
  if (r.creatorMode === 'everyone') return true;
  return r.creatorMode === 'chosen' && r.creators.includes(u.id);
}

// Changing who a task is assigned to: owner, chosen handlers, or the person who created that task.
function canAssign(u, r, t) {
  if (!canViewRoadmap(u, r) || u.role === 'it' || isArchived(r)) return false;
  if (isOwner(u, r)) return true;
  if (r.creatorMode === 'chosen' && r.creators.includes(u.id)) return true;
  return !!t && t.createdBy === u.id && isCreator(u, r);
}

function canEditTask(u, t, r) {
  return !!(u && t && r && canViewRoadmap(u, r) && !isArchived(r) && t.assignees.includes(u.id));
}

// Status only moves forward (order of STATUSES). Assignees move it forward; only the owner may go back.
function canMove(u, t, r, to) {
  if (!r || !canViewRoadmap(u, r)) return { ok: false, reason: 'You cannot see this task.' };
  if (isArchived(r)) return { ok: false, reason: ARCHIVED_MSG };
  const a = STATUSES.indexOf(t.status);
  const b = STATUSES.indexOf(to);
  if (b < 0) return { ok: false, reason: 'Unknown status.' };
  if (a === b) return { ok: false, reason: 'The task is already there.' };
  if (b > a) {
    return canEditTask(u, t, r)
      ? { ok: true }
      : { ok: false, reason: 'Only the people assigned to this task can change its status.' };
  }
  return isOwner(u, r)
    ? { ok: true, override: true }
    : { ok: false, reason: 'Tasks only move forward. Only the roadmap owner can move a task back.' };
}

const activeIds = (ids) => {
  if (!ids.length) return [];
  const rows = db
    .prepare(`SELECT id FROM users WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids);
  const ok = new Set(rows.map((x) => x.id));
  return ids.filter((id) => ok.has(id));
};

// The people a task on this roadmap can be assigned to.
function assignable(r) {
  return activeIds(Array.from(new Set([r.managerId].concat(r.memberIds))));
}

const canManageRoadmap = (u, r) => isOwner(u, r);
const canSeeRoadmapLog = (u, r) => !!(isActive(u) && r && (u.role === 'it' || isOwner(u, r)));

function sharesRoadmap(a, b) {
  return !!db.prepare(
    `SELECT 1 FROM roadmaps r
     WHERE r.deleted_at IS NULL
       AND (r.manager_id = @a OR EXISTS (SELECT 1 FROM roadmap_members m WHERE m.roadmap_id = r.id AND m.user_id = @a))
       AND (r.manager_id = @b OR EXISTS (SELECT 1 FROM roadmap_members m WHERE m.roadmap_id = r.id AND m.user_id = @b))
     LIMIT 1`
  ).get({ a: a.id, b: b.id });
}

function canSeeProfile(u, t) {
  if (!isActive(u) || !t) return false;
  if (u.id === t.id || u.role === 'it') return true;
  if (u.role === 'manager' && t.createdBy === u.id) return true;
  return sharesRoadmap(u, t);
}

function canSeeAccountLog(u, t) {
  if (!isActive(u) || !t) return false;
  return u.id === t.id || u.role === 'it' || (u.role === 'manager' && t.createdBy === u.id);
}

// Issue an invite / reset link for another account.
function canResetPassword(u, t) {
  if (!isActive(u) || !isActive(t) || u.id === t.id) return false;
  if (u.role === 'it') return true;
  return u.role === 'manager' && t.role === 'member' && t.createdBy === u.id;
}

function canDeactivate(u, t) {
  if (!isActive(u) || !t) return false;
  if (u.role === 'it') return true;
  return u.role === 'manager' && t.role === 'member' && t.createdBy === u.id;
}

// If IT deactivated someone, only IT can bring them back.
function canReactivate(u, t) {
  if (!u || !t || isActive(t) || !canDeactivate(u, t)) return false;
  const by = getUser(t.deactivatedBy);
  return u.role === 'it' || !by || by.role !== 'it';
}

function ownedRoadmapIds(id) {
  return db.prepare('SELECT id FROM roadmaps WHERE manager_id = ? AND deleted_at IS NULL ORDER BY id').all(id).map((r) => r.id);
}

function deactivationBlockers(id) {
  const t = getUser(id);
  const out = [];
  if (!t) return out;
  if (t.role === 'manager') {
    const rs = ownedRoadmapIds(id).length;
    const ms = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'member' AND created_by = ? AND active = 1").get(id).c;
    if (rs || ms) out.push('transfer');
  }
  // only IT accounts that can actually sign in count (a pending invite has no password)
  if (t.role === 'it' && isActive(t) && t.hasPassword) {
    const n = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'it' AND active = 1 AND password_hash IS NOT NULL").get().c;
    if (n <= 1) out.push('last-it');
  }
  return out;
}

function canDeleteTask(u, t, r) {
  return !!(t && r && canViewRoadmap(u, r) && !isArchived(r) && (isOwner(u, r) || (t.createdBy === u.id && isCreator(u, r))));
}

// Own comment, the roadmap's owner, or IT. Never on an archived roadmap.
function canDeleteComment(u, c, r) {
  if (!isActive(u) || !c || !r || !canViewRoadmap(u, r) || isArchived(r)) return false;
  return u.role === 'it' || isOwner(u, r) || c.userId === u.id;
}

const canArchive = (u, r) => !!(isActive(u) && r && !r.deletedAt && (u.role === 'it' || isOwner(u, r)));

// People a manager may put on a roadmap: any active member or other manager.
function addablePeople(u) {
  return db
    .prepare("SELECT id FROM users WHERE role IN ('member', 'manager') AND id != ? AND active = 1 ORDER BY name COLLATE NOCASE, id")
    .all(u.id)
    .map((r) => getUser(r.id));
}

// Task-level flags sent to the UI so it shows only what the server will allow.
function taskCan(u, t, r) {
  const moves = {};
  for (const s of STATUSES) {
    if (s !== t.status) moves[s] = canMove(u, t, r, s);
  }
  return {
    edit: canEditTask(u, t, r),
    assign: canAssign(u, r, t),
    delete: canDeleteTask(u, t, r),
    moves,
  };
}

function roadmapCan(u, r) {
  return {
    view: canViewRoadmap(u, r),
    owner: isOwner(u, r),
    manage: canManageRoadmap(u, r) && !isArchived(r),
    archive: canArchive(u, r),
    seeLog: canSeeRoadmapLog(u, r),
    create: isCreator(u, r),
  };
}

module.exports = {
  STATUSES, STATUS_LABEL, ROLE_LABEL, PRESENCE, PRESENCE_LABEL, ARCHIVED_MSG,
  isActive, isArchived, canViewRoadmap, isOwner, isCreator, canAssign, canEditTask, canMove,
  assignable, activeIds, canManageRoadmap, canSeeRoadmapLog, sharesRoadmap, canSeeProfile, canSeeAccountLog,
  canResetPassword, canDeactivate, canReactivate, ownedRoadmapIds, deactivationBlockers,
  canDeleteTask, canDeleteComment, canArchive, addablePeople, taskCan, roadmapCan, getRoadmap,
};
