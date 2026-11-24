const express = require('express');
const sessions = require('../sessions');
const throttle = require('../throttle');
const { log } = require('../audit');
const { getUser, getUserByUsername } = require('../store');
const { requireUser } = require('../middleware/auth');
const { USERNAME_RE, PW_MAX, checkPassword, DUMMY_HASH, sha256 } = require('../util');
const { meView } = require('./views');

const router = express.Router();

const WRONG = 'Wrong username or password.';

// bcrypt is slow on purpose. However many addresses a sign-in flood comes
// from, at most this many checks run at once, so the server keeps answering
// everyone else. Further attempts wait in a short queue (so a real sign-in
// during a flood is slower, not refused); only when the queue is full or the
// wait runs out is the answer "busy", and that attempt is not counted.
const MAX_CONCURRENT_CHECKS = 4;
const MAX_WAITING = 64;
const MAX_WAIT_MS = 8000;
let runningChecks = 0;
const waiting = [];

// Resolves true with a check slot, or false when the server is too busy.
function acquireCheck() {
  if (runningChecks < MAX_CONCURRENT_CHECKS) {
    runningChecks++;
    return Promise.resolve(true);
  }
  if (waiting.length >= MAX_WAITING) return Promise.resolve(false);
  return new Promise((resolve) => {
    const w = {
      resolve,
      timer: setTimeout(() => {
        const i = waiting.indexOf(w);
        if (i >= 0) waiting.splice(i, 1);
        resolve(false);
      }, MAX_WAIT_MS),
    };
    waiting.push(w);
  });
}

// Hands the slot straight to the next waiter, so runningChecks stays put.
function releaseCheck() {
  const w = waiting.shift();
  if (w) {
    clearTimeout(w.timer);
    w.resolve(true);
  } else {
    runningChecks--;
  }
}

function minutesLeft(until) {
  return Math.max(1, Math.ceil((until - Date.now()) / 60000));
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  // Tested on the full input, never a truncated copy: something typed into
  // the username box that isn't username-shaped must not match an account by
  // its first 24 chars. Username-shaped is not enough to log it, though: a
  // password typed into that box often is (once lowercased). So a name is
  // only written down when it is a real account, and throttle keys are
  // hashes, never the typed text.
  const typed = typeof username === 'string' ? username.trim().toLowerCase() : '';
  const validName = USERNAME_RE.test(typed);
  const addr = throttle.addressKey(throttle.clientIp(req));
  const L = throttle.LIMITS;
  const keys = [['ip', 'ip:' + addr]];
  if (validName) {
    keys.push(['user', 'user:' + sha256(typed)]);
    keys.push(['pair', 'pair:' + sha256(typed + '|' + addr)]);
  }

  const until = Math.max(...keys.map(([, k]) => throttle.lockedUntil(k)));
  if (until) {
    return res.status(429).json({ error: `Too many failed sign-ins. Try again in ${minutesLeft(until)} min.` });
  }

  // Counted before any waiting (see throttle.js): parallel requests from one
  // address still can't get more than the limit into the queue.
  const started = {};
  for (const [kind, k] of keys) started[kind] = throttle.count(k, L[kind]);

  if (!(await acquireCheck())) {
    // never checked, so it was no failed attempt: take the count back
    for (const [kind, k] of keys) throttle.forgive(k, started[kind], L[kind]);
    res.setHeader('Retry-After', '2');
    return res.status(503).json({ error: 'The server is busy. Try again in a moment.' });
  }

  let x = null;
  let ok = false;
  // everything after taking the slot is inside the try, so an error (a locked
  // database, say) can never keep the slot forever
  try {
    x = validName ? getUserByUsername(typed) : null;
    const pwOk = typeof password === 'string' && password.length > 0 && password.length <= PW_MAX;
    if (x && x.passwordHash && pwOk) ok = await checkPassword(password, x.passwordHash);
    else await checkPassword(pwOk ? password : 'x', DUMMY_HASH);
  } finally {
    releaseCheck();
  }

  if (!ok) {
    // Only failures against real accounts go into the append-only log; a
    // stream of made-up usernames would otherwise grow it without end.
    if (x) {
      const shown = '"' + x.username + '"';
      log(null, 'security', 'failed sign-in attempt for ' + shown, { subjectId: x.id });
      if (started.pair) log(null, 'security', 'sign-in for ' + shown + ' from address ' + addr + ' was locked for 15 minutes after ' + L.pair + ' failed attempts', { subjectId: x.id });
      if (started.user) log(null, 'security', 'sign-in for ' + shown + ' was locked for 15 minutes from every address after ' + L.user + ' failed attempts', { subjectId: x.id });
    }
    if (started.ip) log(null, 'security', 'sign-in from address ' + addr + ' was locked for 15 minutes after ' + L.ip + ' failed attempts');
    if (started.ip || started.user || started.pair) {
      return res.status(429).json({ error: 'Too many failed sign-ins. Try again in 15 min.' });
    }
    // Same answer for an unknown name, a wrong password and a not yet
    // activated account, so the form can't be used to find usernames.
    return res.status(401).json({ error: WRONG });
  }

  for (const [kind, k] of keys) {
    if (kind === 'pair') throttle.clear(k);
    else throttle.forgive(k, started[kind], L[kind]);
  }

  // re-read after the await: the account may have changed meanwhile
  const fresh = getUser(x.id);
  if (!fresh || !fresh.active) {
    log(fresh || x, 'security', 'was blocked from signing in: the account is deactivated', { subjectId: x.id });
    return res.status(403).json({ error: 'This account is deactivated. Ask your IT admin or manager.' });
  }
  if (fresh.passwordHash !== x.passwordHash) return res.status(401).json({ error: WRONG });

  // a sign-in replaces whatever session this browser had
  if (req.session) sessions.destroy(req.session.tokenHash);
  sessions.create(res, fresh.id);
  log(fresh, 'login', 'signed in');
  res.json({ user: meView(fresh) });
});

// POST /api/auth/logout — the session row is deleted, not just the cookie.
router.post('/logout', (req, res) => {
  if (req.session) {
    if (req.user) log(req.user, 'login', 'signed out');
    sessions.destroy(req.session.tokenHash);
  }
  sessions.clearCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', requireUser, (req, res) => {
  res.json({ user: meView(req.user) });
});

// GET /api/auth/session — like /me, but "not signed in" is a normal answer
// (user: null) instead of a 401, so opening the sign-in page doesn't put a
// failed request in every visitor's browser console.
router.get('/session', (req, res) => {
  res.json({ user: req.user ? meView(req.user) : null });
});

module.exports = router;
