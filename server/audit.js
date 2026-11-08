const db = require('./db');
const { now } = require('./util');

// The only writers of the two logs. They only ever INSERT; the triggers in
// db.js make sure nothing else can change a row afterwards either.
const insertLog = db.prepare(
  `INSERT INTO audit_log (at, actor_id, action, text, roadmap_id, subject_id, task_id)
   VALUES (@at, @actorId, @action, @text, @roadmapId, @subjectId, @taskId)`
);
const insertPw = db.prepare(
  'INSERT INTO password_log (at, user_id, by_id, kind) VALUES (?, ?, ?, ?)'
);

const ACTIONS = ['login', 'account', 'password', 'roadmap', 'task', 'comment', 'profile', 'security', 'override', 'transfer'];

function log(actor, action, text, extra) {
  if (!ACTIONS.includes(action)) throw new Error('Unknown log action ' + action);
  const e = extra || {};
  insertLog.run({
    at: now(),
    actorId: actor ? actor.id : null,
    action,
    // Capped so a hostile client can't grow the log by megabytes per entry.
    text: String(text).slice(0, 1000),
    roadmapId: e.roadmapId ?? null,
    subjectId: e.subjectId ?? null,
    taskId: e.taskId ?? null,
  });
}

function pwlog(userId, byId, kind) {
  insertPw.run(now(), userId ?? null, byId ?? null, kind);
}

module.exports = { log, pwlog, ACTIONS };
