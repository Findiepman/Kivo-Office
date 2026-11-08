const net = require('net');
const db = require('./db');
const { now } = require('./util');

// Failed sign-ins, counted under several keys, each with its own limit. A
// key that reaches its limit inside 15 minutes is locked for 15 minutes.
//   (username, address)  8   the normal lock: one person guessing one account
//   username            100  a brake across all addresses, high enough that a
//                            stranger can't keep someone locked out for fun
//   address              8   one address trying many usernames
// The attempt is counted BEFORE the slow bcrypt check, so firing 100 requests
// in parallel can't all slip under the limit.
const LIMITS = { pair: 8, user: 100, ip: 8 };
const WINDOW = 15 * 60 * 1000;
const LOCK = 15 * 60 * 1000;

const get = db.prepare('SELECT * FROM login_throttle WHERE key = ?');
const put = db.prepare(
  `INSERT INTO login_throttle (key, failures, window_start, locked_until) VALUES (@key, @failures, @windowStart, @lockedUntil)
   ON CONFLICT(key) DO UPDATE SET failures = @failures, window_start = @windowStart, locked_until = @lockedUntil`
);

// IPv6 visitors usually own a whole /64, so counting single addresses there
// would let one person rotate through billions of them.
function addressKey(ip) {
  const s = String(ip || 'unknown');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapped) return mapped[1];
  if (net.isIPv6(s)) {
    const [head, tail] = s.split('::');
    const a = head ? head.split(':') : [];
    const b = tail !== undefined && tail !== '' ? tail.split(':') : [];
    const full = tail === undefined ? a : a.concat(Array(8 - a.length - b.length).fill('0'), b);
    return full.slice(0, 4).map((x) => x.toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
  }
  return s;
}

function lockedUntil(key) {
  const row = get.get(key);
  return row && row.locked_until > now() ? row.locked_until : 0;
}

// Returns true when this attempt is the one that started a lock.
function count(key, max) {
  const t = now();
  const row = get.get(key);
  let failures = 1;
  let windowStart = t;
  if (row && row.window_start > t - WINDOW) {
    failures = row.failures + 1;
    windowStart = row.window_start;
  }
  if (failures >= max) {
    put.run({ key, failures: 0, windowStart: t, lockedUntil: t + LOCK });
    return true;
  }
  put.run({ key, failures, windowStart, lockedUntil: row ? row.locked_until : 0 });
  return false;
}

// The counted attempt turned out to be a correct sign-in: take it back.
function forgive(key, startedLock, max) {
  const row = get.get(key);
  if (!row) return;
  if (startedLock) {
    put.run({ key, failures: max - 1, windowStart: row.window_start, lockedUntil: 0 });
  } else {
    put.run({ key, failures: Math.max(0, row.failures - 1), windowStart: row.window_start, lockedUntil: row.locked_until });
  }
}

function clear(key) {
  db.prepare('DELETE FROM login_throttle WHERE key = ?').run(key);
}

function purgeExpired() {
  const t = now();
  db.prepare('DELETE FROM login_throttle WHERE locked_until <= ? AND window_start <= ?').run(t, t - WINDOW);
}

module.exports = { lockedUntil, count, forgive, clear, purgeExpired, addressKey, LIMITS, LOCK };
