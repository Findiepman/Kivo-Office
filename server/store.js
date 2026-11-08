const db = require('./db');

// Row loaders that turn the tables into the same shapes the prototype's Core
// worked with (camelCase, arrays of ids), so the ported rules read the same.

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    email: row.email,
    hasPassword: !!row.password_hash,
    passwordHash: row.password_hash,
    hasAvatar: row.has_avatar === 1,
    avatarAt: row.avatar_at,
    presence: row.presence,
    statusText: row.status_text,
    createdAt: row.created_at,
    createdBy: row.created_by,
    active: row.active === 1,
    deactivatedAt: row.deactivated_at,
    deactivatedBy: row.deactivated_by,
  };
}

// Every column except the picture itself (up to ~140 KB of base64): users are
// loaded on every request, the picture is only read by the avatar route.
const USER_COLS = `id, username, name, role, email, password_hash, avatar_at, presence, status_text,
  created_at, created_by, active, deactivated_at, deactivated_by, (avatar != '') AS has_avatar`;

const stmt = {
  user: db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`),
  userByName: db.prepare(`SELECT ${USER_COLS} FROM users WHERE username = ?`),
  roadmap: db.prepare('SELECT * FROM roadmaps WHERE id = ?'),
  members: db.prepare('SELECT user_id FROM roadmap_members WHERE roadmap_id = ? ORDER BY rowid'),
  creators: db.prepare('SELECT user_id FROM roadmap_creators WHERE roadmap_id = ? ORDER BY rowid'),
  task: db.prepare('SELECT * FROM tasks WHERE id = ?'),
  assignees: db.prepare('SELECT user_id FROM task_assignees WHERE task_id = ? ORDER BY rowid'),
  flags: db.prepare('SELECT user_id, reason, at FROM task_flags WHERE task_id = ? ORDER BY id'),
};

const getUser = (id) => (id == null ? null : mapUser(stmt.user.get(id)));
const getUserByUsername = (username) => mapUser(stmt.userByName.get(username));

function getRoadmap(id) {
  const row = id == null ? null : stmt.roadmap.get(id);
  if (!row) return null;
  return {
    id: row.id,
    managerId: row.manager_id,
    title: row.title,
    description: row.description,
    creatorMode: row.creator_mode,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    archivedBy: row.archived_by,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
    updatedAt: row.updated_at,
    memberIds: stmt.members.all(row.id).map((r) => r.user_id),
    creators: stmt.creators.all(row.id).map((r) => r.user_id),
  };
}

function parseTags(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch (e) {
    return [];
  }
}

function mapTask(row) {
  return {
    id: row.id,
    roadmapId: row.roadmap_id,
    title: row.title,
    description: row.description,
    status: row.status,
    tags: parseTags(row.tags),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    assignees: stmt.assignees.all(row.id).map((r) => r.user_id),
    flags: stmt.flags.all(row.id).map((f) => ({ userId: f.user_id, reason: f.reason, at: f.at })),
  };
}

function getTask(id) {
  const row = id == null ? null : stmt.task.get(id);
  return row ? mapTask(row) : null;
}

function tasksOf(roadmapId) {
  return db.prepare('SELECT * FROM tasks WHERE roadmap_id = ? ORDER BY id').all(roadmapId).map(mapTask);
}

// Display name, as Core.dn: deactivated people stay visible but marked.
const dn = (u) => (u ? (u.active ? u.name : u.name + ' (deactivated)') : 'Unknown');

// The public face of an account: what any signed-in colleague may see.
function person(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    active: u.active,
    presence: u.presence,
    statusText: u.statusText,
    avatar: u.hasAvatar ? `/api/users/${u.id}/avatar?v=${u.avatarAt}` : '',
  };
}

// Every change to a roadmap or task moves its stamp strictly forward (even two
// changes in the same millisecond), so a save based on an older copy can tell.
const touchRoadmap = (id) => db.prepare('UPDATE roadmaps SET updated_at = max(?, updated_at + 1) WHERE id = ?').run(Date.now(), id);
const touchTask = (id) => db.prepare('UPDATE tasks SET updated_at = max(?, updated_at + 1) WHERE id = ?').run(Date.now(), id);

module.exports = { touchRoadmap, touchTask, mapUser, getUser, getUserByUsername, getRoadmap, getTask, tasksOf, mapTask, dn, person };
