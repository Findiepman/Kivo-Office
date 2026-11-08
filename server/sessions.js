const db = require('./db');
const { isProduction } = require('./config');
const { now, sha256, randomToken } = require('./util');

const SESSION_TTL = 12 * 3600 * 1000;
// However active, a session ends a week after sign-in: a stolen cookie can't
// be kept alive forever by using it.
const SESSION_MAX_AGE = 7 * 24 * 3600 * 1000;
// Sliding expiry is written at most once a minute per session, not on every request.
const REFRESH_EVERY = 60 * 1000;
// __Host- makes the browser refuse the cookie unless it is Secure, host-only
// and Path=/, so a sibling subdomain can't plant or overwrite it.
const COOKIE = isProduction ? '__Host-kivo_session' : 'kivo_session';

function cookieHeader(value, maxAgeSec) {
  return [
    `${COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
    isProduction ? 'Secure' : null,
  ].filter(Boolean).join('; ');
}

function readToken(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE) {
      const v = part.slice(i + 1).trim();
      // our tokens are 43 base64url chars; anything else is not ours
      return /^[A-Za-z0-9_-]{20,100}$/.test(v) ? v : null;
    }
  }
  return null;
}

function create(res, userId) {
  const token = randomToken();
  const t = now();
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, refreshed_at) VALUES (?, ?, ?, ?, ?)'
  ).run(sha256(token), userId, t, t + SESSION_TTL, t);
  res.append('Set-Cookie', cookieHeader(token, SESSION_TTL / 1000));
}

// Returns { userId, tokenHash } for a live session, sliding its expiry.
function lookup(req, res) {
  const token = readToken(req);
  if (!token) return null;
  const hash = sha256(token);
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hash);
  const t = now();
  if (!s || s.expires_at <= t || s.created_at + SESSION_MAX_AGE <= t) {
    if (s) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    clearCookie(res);
    return null;
  }
  if (t - s.refreshed_at > REFRESH_EVERY) {
    const exp = Math.min(t + SESSION_TTL, s.created_at + SESSION_MAX_AGE);
    db.prepare('UPDATE sessions SET expires_at = ?, refreshed_at = ? WHERE token_hash = ?').run(exp, t, hash);
    res.append('Set-Cookie', cookieHeader(token, Math.max(1, Math.floor((exp - t) / 1000))));
  }
  return { userId: s.user_id, tokenHash: hash };
}

function clearCookie(res) {
  res.append('Set-Cookie', cookieHeader('', 0));
}

function destroy(tokenHash) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

function destroyAllFor(userId) {
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

function purgeExpired() {
  const t = now();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR created_at <= ?').run(t, t - SESSION_MAX_AGE);
}

module.exports = { create, lookup, destroy, destroyAllFor, clearCookie, purgeExpired, SESSION_TTL, SESSION_MAX_AGE, COOKIE };
