const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startServer, buildWorld, login, pw, lastLogs, allLogText, ROOT, baseEnv, useLink, invite } = require('./helpers');

test('first start, sessions, CSRF', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  await t.test('an empty install prints a one-time setup link and has no default account', async () => {
    assert.match(srv.output(), /No accounts yet/);
    assert.ok(srv.setupToken, 'setup token printed');
    const d = srv.db();
    assert.equal(d.prepare('SELECT COUNT(*) AS c FROM users').get().c, 0);
    d.close();
    for (const [u, p] of [['admin', 'admin'], ['admin', 'change-me-now'], ['it', 'password123']]) {
      const { r } = await login(srv, u, p);
      assert.equal(r.status, 401);
    }
  });

  await t.test('the setup link creates the first IT admin, once', async () => {
    const c = srv.client();
    const info = await c.post('/api/links/info', { token: srv.setupToken });
    assert.deepEqual([info.body.valid, info.body.kind], [true, 'setup']);
    const short = await c.post('/api/links/use', { token: srv.setupToken, password: 'short', name: 'Ingrid', username: 'ingrid' });
    assert.equal(short.status, 400);
    const long = await c.post('/api/links/use', { token: srv.setupToken, password: 'x'.repeat(201), name: 'Ingrid', username: 'ingrid' });
    assert.equal(long.status, 400);
    const ok = await c.post('/api/links/use', { token: srv.setupToken, password: pw('ingrid'), name: 'Ingrid Vos', username: 'ingrid' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.role, 'it');
    const cookie = ok.setCookies.find((s) => s.startsWith('kivo_session='));
    assert.ok(cookie, 'session cookie set');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Max-Age=43200/);
    assert.doesNotMatch(cookie, /Secure/, 'Secure only with NODE_ENV=production');
    const me = await c.get('/api/auth/me');
    assert.equal(me.body.user.username, 'ingrid');
    const again = await srv.client().post('/api/links/use', { token: srv.setupToken, password: pw('x'), name: 'Mallory', username: 'mallory' });
    assert.equal(again.status, 400);
    const used = await srv.client().post('/api/links/info', { token: srv.setupToken });
    assert.deepEqual(used.body, { valid: false, reason: 'used' });
  });

  await t.test('sessions: 12 h sliding expiry stored as a hash, real logout', async () => {
    const { c, r } = await login(srv, 'ingrid');
    assert.equal(r.status, 200);
    const token = c.cookie.split('=')[1];
    const d = srv.db();
    const rows = d.prepare('SELECT * FROM sessions').all();
    d.close();
    assert.ok(rows.every((s) => s.token_hash !== token), 'token itself is never stored');
    const mine = rows.find((s) => s.token_hash === require('node:crypto').createHash('sha256').update(token).digest('hex'));
    assert.ok(mine, 'hash of the token is stored');
    assert.ok(Math.abs(mine.expires_at - mine.created_at - 12 * 3600 * 1000) < 1000);
    const saved = c.cookie;
    assert.equal((await c.post('/api/auth/logout')).status, 200);
    c.cookie = saved; // a stolen copy of the cookie must not work after logout
    assert.equal((await c.get('/api/auth/me')).status, 401);
  });

  await t.test('CSRF: state-changing requests need X-Kivo and a matching Origin', async () => {
    const { c } = await login(srv, 'ingrid');
    const noHeader = await c.post('/api/roadmaps', { title: 'x' }, { csrf: false });
    assert.equal(noHeader.status, 403);
    const noHeaderLogin = await srv.client().post('/api/auth/login', { username: 'ingrid', password: pw('ingrid') }, { csrf: false });
    assert.equal(noHeaderLogin.status, 403);
    const evil = await c.post('/api/users', { role: 'manager', name: 'Evil', username: 'evil' }, { origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    const nullOrigin = await c.post('/api/users', { role: 'manager', name: 'Evil', username: 'evil' }, { origin: 'null' });
    assert.equal(nullOrigin.status, 403);
    const same = await c.post('/api/users', { role: 'manager', name: 'Fine', username: 'fine' }, { origin: srv.base });
    assert.equal(same.status, 201);
    for (const m of ['put', 'patch', 'del']) {
      const r = m === 'del' ? await c.del('/api/tasks/1', { csrf: false }) : await c[m]('/api/me/profile', {}, { csrf: false });
      assert.equal(r.status, 403, m);
    }
    // reads need no header
    assert.equal((await c.get('/api/auth/me', { csrf: false })).status, 200);
  });

  await t.test('security headers', async () => {
    const r = await srv.client().get('/');
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(r.headers.get('x-powered-by'), null);
    const html = r.text;
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline scripts');
    assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline handlers');
  });

  await t.test('unknown API routes and bad JSON give JSON errors', async () => {
    const c = srv.client();
    assert.equal((await c.get('/api/nope')).status, 404);
    const bad = await c.req('POST', '/api/auth/login', '{"username":"ingrid","password":"' + pw('ingrid') + '"', {});
    assert.equal(bad.status, 400);
    assert.ok(!srv.output().includes(pw('ingrid')), 'a broken body is never echoed to the console');
  });
});

test('login lockout per (username, address), per username and per address', async (t) => {
  const srv = await startServer({ env: { TRUST_PROXY: 'true' } });
  t.after(() => srv.stop());
  await buildWorld(srv, { dina: false });

  const sha = (x) => require('node:crypto').createHash('sha256').update(x).digest('hex');
  const from = (ip) => { const c = srv.client(); c.ip = ip; return c; };

  await t.test('8 failures for one username from one address lock only that pair', async () => {
    let last;
    for (let i = 1; i <= 8; i++) {
      last = await from('10.0.0.1').post('/api/auth/login', { username: 'marta', password: 'wrong-password-' + i });
      if (i < 8) assert.equal(last.status, 401, 'attempt ' + i);
    }
    assert.equal(last.status, 429);
    const right = await from('10.0.0.1').post('/api/auth/login', { username: 'marta', password: pw('marta') });
    assert.equal(right.status, 429, 'locked from that address, even with the right password');
    assert.match(right.body.error, /Try again in \d+ min/);
    assert.ok(lastLogs(srv, 30).some((l) => /sign-in for "marta" from address 10\.0\.0\.1 was locked for 15 minutes/.test(l.text)), 'lockout logged');
    // the real Marta at her own desk is not locked out by someone else's guessing
    assert.equal((await from('10.0.0.2').post('/api/auth/login', { username: 'marta', password: pw('marta') })).status, 200);
    // the lock really is 15 minutes: move it into the past and that address
    // gets in again (8 failures from one address also trip that address's own
    // limit, so both locks are lifted)
    const d = srv.db();
    for (const key of ['pair:' + sha('marta|10.0.0.1'), 'ip:10.0.0.1']) {
      const row = d.prepare('SELECT locked_until FROM login_throttle WHERE key = ?').get(key);
      assert.ok(row.locked_until - Date.now() > 14 * 60 * 1000, key);
      d.prepare('UPDATE login_throttle SET locked_until = 1 WHERE key = ?').run(key);
    }
    d.close();
    assert.equal((await from('10.0.0.1').post('/api/auth/login', { username: 'marta', password: pw('marta') })).status, 200);
  });

  await t.test('100 failures for one username from anywhere lock it everywhere', async () => {
    // 99 earlier failures from many addresses, put straight into the counter
    // (100 real bcrypt checks would take half a minute)
    const d = srv.db();
    d.prepare('INSERT INTO login_throttle (key, failures, window_start, locked_until) VALUES (?, 99, ?, 0)').run('user:' + sha('omar'), Date.now());
    d.close();
    const r = await from('10.1.0.1').post('/api/auth/login', { username: 'omar', password: 'wrong-again' });
    assert.equal(r.status, 429);
    assert.equal((await from('10.1.0.2').post('/api/auth/login', { username: 'omar', password: pw('omar') })).status, 429, 'every address');
    assert.ok(lastLogs(srv, 5).some((l) => /sign-in for "omar" was locked for 15 minutes from every address after 100 failed attempts/.test(l.text)));
    assert.equal((await from('10.1.0.3').post('/api/auth/login', { username: 'lena', password: pw('lena') })).status, 200, 'other accounts are fine');
  });

  await t.test('8 failures from one address lock that address for every username', async () => {
    for (let i = 1; i <= 8; i++) {
      await from('192.0.2.50').post('/api/auth/login', { username: 'nobody' + i, password: 'whatever-' + i });
    }
    assert.equal((await from('192.0.2.50').post('/api/auth/login', { username: 'tom', password: pw('tom') })).status, 429);
    assert.equal((await from('192.0.2.51').post('/api/auth/login', { username: 'tom', password: pw('tom') })).status, 200);
    const logs = lastLogs(srv, 30).map((l) => l.text);
    assert.ok(logs.some((x) => /from address 192\.0\.2\.50 was locked/.test(x)));
    assert.ok(!logs.some((x) => /nobody/.test(x)), 'made-up usernames are not logged');
  });

  await t.test('IPv6 addresses are counted per /64', async () => {
    for (let i = 1; i <= 8; i++) {
      await from('2001:db8:aa:1::' + i.toString(16)).post('/api/auth/login', { username: 'ghost' + i, password: 'whatever-' + i });
    }
    assert.equal((await from('2001:0db8:00aa:0001:ffff::9').post('/api/auth/login', { username: 'tom', password: pw('tom') })).status, 429, 'same /64, written differently');
    assert.equal((await from('2001:db8:aa:2::1').post('/api/auth/login', { username: 'tom', password: pw('tom') })).status, 200, 'next /64');
    assert.ok(lastLogs(srv, 10).some((l) => l.text.includes('from address 2001:db8:aa:1::/64 was locked')));
  });

  await t.test('parallel attempts cannot slip past the limit', async () => {
    const tries = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      from('198.51.100.7').post('/api/auth/login', { username: 'ravi', password: 'nope-' + i })));
    const wrong = tries.filter((r) => r.status === 401).length;
    assert.ok(wrong <= 7, 'at most 7 plain failures before the lock, got ' + wrong);
    const d = srv.db();
    const n = d.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE text = 'failed sign-in attempt for \"ravi\"'").get().c;
    d.close();
    assert.ok(n <= 8, 'bcrypt ran at most 8 times, logged ' + n);
  });

  await t.test('successful sign-ins from a shared address do not count towards its lock', async () => {
    for (let i = 0; i < 10; i++) {
      const c = srv.client();
      c.ip = '203.0.113.9';
      assert.equal((await c.post('/api/auth/login', { username: 'lena', password: pw('lena') })).status, 200, 'login ' + i);
    }
  });
});

test('failed sign-ins never log a password, and nothing is stored in plain text', async (t) => {
  const srv = await startServer({ env: { TRUST_PROXY: 'true' } });
  t.after(() => srv.stop());
  const { c } = await buildWorld(srv);

  await t.test('only username-shaped input is logged, tested on the full input', async () => {
    await login(srv, 'ingrid', 'not-my-password-1');
    const typedPassword = 'Sup3r$ecret Passw0rd!';
    await login(srv, typedPassword, 'x');
    // 28 valid username characters: the first 24 would look fine, the whole thing is not a username
    const longName = 'ingridsecretpassword12345678';
    await login(srv, longName, pw('ingrid'));
    // a username with trailing password-ish text
    await login(srv, 'marta hunter2hunter2', 'x');
    // a password that happens to be username-shaped once lowercased
    await login(srv, 'MyPassword12', 'x');
    const logs = lastLogs(srv, 10).map((l) => l.text);
    assert.ok(logs.includes('failed sign-in attempt for "ingrid"'));
    // attempts on names that are not real accounts are counted, never logged
    assert.equal(logs.filter((x) => /failed sign-in attempt/.test(x)).length, 1);
    const all = allLogText(srv);
    for (const s of [typedPassword, longName, 'hunter2', 'not-my-password-1', 'mypassword12']) assert.ok(!all.toLowerCase().includes(s.toLowerCase()), s + ' must not be logged');
    const d = srv.db();
    const keys = d.prepare('SELECT key FROM login_throttle').all().map((r) => r.key).join(' ');
    d.close();
    assert.ok(!keys.includes('mypassword12'), 'typed names are never stored readable in the throttle table');
    // a long name must not sign in as "ingrid" by being cut to 24 chars
    const { r } = await login(srv, 'ingrid' + ' '.repeat(3) + 'x', pw('ingrid'));
    assert.equal(r.status, 401);
  });

  await t.test('unknown user, wrong password and pending account give the same answer', async () => {
    const pending = await invite(c.marta, 'member', 'Priya Nair', 'priya');
    void pending;
    const a = (await login(srv, 'nobody-here', 'some-password')).r;
    const b = (await login(srv, 'marta', 'some-password')).r;
    const p = (await login(srv, 'priya', 'some-password')).r;
    assert.deepEqual([a.status, b.status, p.status], [401, 401, 401]);
    assert.equal(a.body.error, b.body.error);
    assert.equal(a.body.error, p.body.error);
  });

  await t.test('no password appears in the database files or the server output', async () => {
    const names = ['ingrid', 'dina', 'marta', 'omar', 'lena', 'tom', 'sofia', 'ravi', 'noor'];
    // checkpoint so the main file has everything, then read every db file there is
    const d = srv.db();
    const hashes = d.prepare('SELECT password_hash FROM users WHERE password_hash IS NOT NULL').all();
    assert.ok(hashes.length >= names.length);
    assert.ok(hashes.every((h) => /^\$2[aby]\$12\$/.test(h.password_hash)), 'bcrypt cost 12');
    d.close();
    const files = fs.readdirSync(srv.dataDir).filter((f) => f.startsWith('kivo-office.db')).map((f) => path.join(srv.dataDir, f));
    const blobs = files.map((f) => fs.readFileSync(f));
    for (const n of names) {
      const secret = pw(n);
      for (const b of blobs) {
        assert.equal(b.indexOf(Buffer.from(secret, 'utf8')), -1, n + "'s password found in a db file");
        assert.equal(b.indexOf(Buffer.from(secret, 'utf16le')), -1);
      }
      assert.ok(!srv.output().includes(secret), n + "'s password found in server output");
    }
  });
});

test('npm run setup-link', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const run = (args) => spawnSync(process.execPath, [path.join(ROOT, 'server', 'setup-link.js'), ...args], {
    env: baseEnv(srv.dataDir), encoding: 'utf8',
  });

  await t.test('while nobody can sign in as IT it prints a fresh link that replaces the old one', async () => {
    const r = run([]);
    assert.equal(r.status, 0, r.stderr);
    const tok = /#\/invite\/([A-Za-z0-9_-]+)/.exec(r.stdout)[1];
    assert.notEqual(tok, srv.setupToken);
    const c = srv.client();
    assert.deepEqual((await c.post('/api/links/info', { token: srv.setupToken })).body, { valid: false, reason: 'replaced' });
    assert.equal((await c.post('/api/links/info', { token: tok })).body.valid, true);
    await useLink(srv, tok, pw('ingrid'), { name: 'Ingrid Vos', username: 'ingrid' });
  });

  await t.test('once an IT admin can sign in it refuses unless --force', async () => {
    const r = run([]);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout, /#\/invite\//);
    const f = run(['--force']);
    assert.equal(f.status, 0);
    const tok = /#\/invite\/([A-Za-z0-9_-]+)/.exec(f.stdout)[1];
    const c = await useLink(srv, tok, pw('backup-it'), { name: 'Backup IT', username: 'backupit' });
    assert.equal((await c.get('/api/auth/me')).body.user.role, 'it');
    // a used username can't be taken twice
    const g = run(['--force']);
    const tok2 = /#\/invite\/([A-Za-z0-9_-]+)/.exec(g.stdout)[1];
    const dup = await srv.client().post('/api/links/use', { token: tok2, password: pw('x'), name: 'Dup', username: 'ingrid' });
    assert.equal(dup.status, 409);
  });
});

test('npm run backup writes a consistent copy', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  await useLink(srv, srv.setupToken, pw('ingrid'), { name: 'Ingrid Vos', username: 'ingrid' });
  const r = spawnSync(process.execPath, [path.join(ROOT, 'server', 'backup.js')], { env: baseEnv(srv.dataDir), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const dir = path.join(srv.dataDir, 'backups');
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^kivo-office-\d{8}-\d{6}\.db$/);
  const Database = require('better-sqlite3');
  const b = new Database(path.join(dir, files[0]), { readonly: true });
  assert.equal(b.prepare("SELECT username FROM users WHERE role = 'it'").get().username, 'ingrid');
  // the copy keeps the append-only triggers
  assert.equal(b.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'trigger'").get().c, 6);
  b.close();
});
