const db = require('./db');
const { log, pwlog } = require('./audit');
const { getUser } = require('./store');
const { APP_URL, PORT } = require('./config');
const { now, sha256, randomToken } = require('./util');

const LINK_TTL = 48 * 3600 * 1000;

// The token travels in the URL fragment (#/invite/...), which browsers never
// send to a server, so it can't land in a proxy or tunnel access log.
function buildLink(token, base) {
  return (base || APP_URL || `http://localhost:${PORT}`) + '/#/invite/' + token;
}

// The address for links printed on the console: APP_URL, or this machine.
// In Docker the app always listens on 3000 inside the container; HOST_PORT is
// the port on the host that reaches it, which is what a browser needs.
function localBase(port) {
  if (APP_URL) return APP_URL;
  const host = Number(process.env.HOST_PORT) > 0 ? Number(process.env.HOST_PORT) : port;
  return `http://localhost:${host}`;
}

// Single use, 48 h, only the hash stored, and a new link for the same account
// (or a new setup link) revokes every older unused one.
function issue(actor, target, kind) {
  const token = randomToken();
  const t = now();
  const tx = db.transaction(() => {
    if (kind === 'setup') {
      db.prepare("UPDATE links SET revoked_at = ? WHERE kind = 'setup' AND used_at IS NULL AND revoked_at IS NULL").run(t);
    } else {
      db.prepare('UPDATE links SET revoked_at = ? WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL').run(t, target.id);
    }
    db.prepare(
      'INSERT INTO links (user_id, kind, token_hash, created_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(target ? target.id : null, kind, sha256(token), t, t + LINK_TTL, actor ? actor.id : null);
    pwlog(target ? target.id : null, actor ? actor.id : null, kind + '_issued');
    if (kind === 'setup') {
      log(null, 'password', 'a setup link for a new IT admin account was printed on the server console');
    } else {
      log(actor, 'password', (kind === 'invite' ? 'issued an invite link for ' : 'issued a reset link for ') + target.name, { subjectId: target.id });
    }
  });
  tx();
  return { token, expiresAt: t + LINK_TTL };
}

function find(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  return db.prepare('SELECT * FROM links WHERE token_hash = ?').get(sha256(token)) || null;
}

function state(row) {
  if (!row) return 'unknown';
  if (row.used_at) return 'used';
  // checked before "replaced": deactivating also revokes, and this says why
  if (row.kind !== 'setup') {
    const u = getUser(row.user_id);
    if (!u || !u.active) return 'deactivated';
  }
  if (row.revoked_at) return 'replaced';
  if (now() > row.expires_at) return 'expired';
  return 'valid';
}

function pendingFor(userId) {
  const row = db
    .prepare('SELECT * FROM links WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL ORDER BY id DESC LIMIT 1')
    .get(userId);
  return row && state(row) === 'valid' ? { kind: row.kind, expiresAt: row.expires_at } : null;
}

function revokeAllFor(userId) {
  db.prepare('UPDATE links SET revoked_at = ? WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL').run(now(), userId);
}

// Setup links are only handed out while nobody can run the install: no
// active IT admin with a password. --force in the script overrides that.
function needsSetup() {
  return !db.prepare("SELECT 1 FROM users WHERE role = 'it' AND active = 1 AND password_hash IS NOT NULL LIMIT 1").get();
}

module.exports = { issue, find, state, pendingFor, revokeAllFor, buildLink, localBase, needsSetup, LINK_TTL };
