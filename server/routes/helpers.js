const db = require('../db');
const { log } = require('../audit');
const P = require('../permissions');
const { getUser, person } = require('../store');

// A refused write by a signed-in user is a security event worth keeping:
// the UI never offers these buttons, so someone is poking at the API.
function deny(req, res, status, what, msg, ctx) {
  if (req.user) log(req.user, 'security', 'was blocked from ' + what + ': ' + msg, ctx);
  return res.status(status).json({ error: msg });
}

const fail = (res, status, msg) => res.status(status).json({ error: msg });

// A person as `viewer` may see them: the picture URL is only handed out when
// the avatar route would serve it (canSeeProfile), so pages never ask for a
// picture they would get a 404 for.
function personFor(viewer, u) {
  const p = person(u);
  if (p && p.avatar && !P.canSeeProfile(viewer, u)) p.avatar = '';
  return p;
}

// { id: person } for every id given, so the client can render names and
// avatars without one request per person.
function peopleMap(viewer, ids) {
  const out = {};
  for (const id of new Set(ids.filter((x) => x != null))) {
    const p = personFor(viewer, getUser(id));
    if (p) out[id] = p;
  }
  return out;
}

const PAGE_SIZE = 50;

// ?page=1&q=text for every log view. Filtering happens in SQL so a long log
// never has to reach the browser in one piece.
function pageArgs(req) {
  const page = Math.max(1, Math.min(100000, parseInt(req.query.page, 10) || 1));
  const raw = typeof req.query.q === 'string' ? req.query.q : '';
  const q = raw.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 100);
  return { page, q, offset: (page - 1) * PAGE_SIZE };
}

// LIKE pattern with % and _ taken literally.
const likeArg = (q) => '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';

// Runs a filtered, paginated audit query. `where` must only contain fixed SQL
// with @named parameters; the text filter is added here.
function auditPage(req, where, params) {
  const { page, q, offset } = pageArgs(req);
  const filter = q
    ? " AND (lower(a.text) LIKE @q ESCAPE '\\' OR a.action LIKE @q ESCAPE '\\' OR lower(coalesce(u.name, '')) LIKE @q ESCAPE '\\')"
    : '';
  const args = Object.assign({}, params, q ? { q: likeArg(q) } : {});
  const base = `FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE ${where}${filter}`;
  const total = db.prepare(`SELECT COUNT(*) AS c ${base}`).get(args).c;
  const rows = db
    .prepare(`SELECT a.id, a.at, a.actor_id, a.action, a.text ${base} ORDER BY a.id DESC LIMIT ${PAGE_SIZE} OFFSET @offset`)
    .all(Object.assign({ offset }, args));
  return {
    entries: rows.map((r) => ({ id: r.id, at: r.at, actorId: r.actor_id, action: r.action, text: r.text })),
    people: peopleMap(req.user, rows.map((r) => r.actor_id)),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    q,
  };
}

module.exports = { deny, fail, personFor, peopleMap, pageArgs, likeArg, auditPage, PAGE_SIZE };
