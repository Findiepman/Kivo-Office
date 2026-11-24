const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer, buildWorld, login, pw, lastLogs } = require('./helpers');

test('security round 3', async (t) => {
  const srv = await startServer({ env: { TRUST_PROXY: '1', TRUST_CF_CONNECTING_IP: '1', WRITE_LIMIT_PER_MINUTE: '40' } });
  t.after(() => srv.stop());
  const { c, ids } = await buildWorld(srv, { dina: false });

  await t.test("a manager's view of a member's log leaves out other managers' roadmaps", async () => {
    // Omar puts Marta's team member Lena on his own roadmap; she works there
    const omarRm = (await c.omar.post('/api/roadmaps', { title: 'Omar secret plan', memberIds: [ids.lena] })).body.roadmap.id;
    const task = (await c.omar.post(`/api/roadmaps/${omarRm}/tasks`, { title: 'Hidden launch date' })).body.task.id;
    assert.equal((await c.lena.post(`/api/tasks/${task}/comments`, { text: 'on it' })).status, 201);
    // and on Marta's roadmap
    const martaRm = (await c.marta.post('/api/roadmaps', { title: 'Marta plan', memberIds: [ids.lena] })).body.roadmap.id;
    const mTask = (await c.marta.post(`/api/roadmaps/${martaRm}/tasks`, { title: 'Visible work' })).body.task.id;
    await c.lena.post(`/api/tasks/${mTask}/comments`, { text: 'done soon' });

    const text = async (who, part) => (await c[who].get(`/api/users/${ids.lena}/log?part=${part}`)).body.entries.map((e) => e.text).join('\n');
    const martaBy = await text('marta', 'by');
    assert.match(martaBy, /Visible work/, 'her own roadmap is shown');
    assert.doesNotMatch(martaBy, /Hidden launch date|Omar secret plan/, "Omar's roadmap is not");
    assert.doesNotMatch(await text('marta', 'about'), /Hidden launch date|Omar secret plan/);
    // IT and Lena herself still see everything
    assert.match(await text('ingrid', 'by'), /Hidden launch date/);
    assert.match(await text('lena', 'by'), /Hidden launch date/);
    // account-level entries (no roadmap) stay visible to her manager
    assert.match(await text('marta', 'by'), /set their own password/);
  });

  await t.test('profile cards only show account details to the people who run the account', async () => {
    const rid = (await c.marta.post('/api/roadmaps', { title: 'Shared', memberIds: [ids.lena, ids.tom] })).body.roadmap.id;
    assert.ok(rid);
    const asTom = (await c.tom.get(`/api/users/${ids.lena}`)).body.user;
    assert.equal(asTom.accountDetails, false);
    assert.equal(asTom.lastLogin, null);
    assert.equal(asTom.createdBy, null);
    assert.equal(asTom.email, undefined);
    assert.equal(asTom.pendingInvite, null);
    assert.equal(asTom.deactivatedByIt, false);
    const asMarta = (await c.marta.get(`/api/users/${ids.lena}`)).body.user;
    assert.equal(asMarta.accountDetails, true);
    assert.ok(asMarta.lastLogin, 'her manager sees the last sign-in');
    assert.equal(asMarta.createdBy.id, ids.marta);
  });

  await t.test('a reset link used by someone else names who issued it', async () => {
    const r = await c.marta.post(`/api/users/${ids.sofia}/link`);
    assert.equal(r.status, 200);
    const s = srv.client();
    assert.equal((await s.post('/api/links/use', { token: r.body.token, password: pw('sofia2') })).status, 200);
    assert.ok(lastLogs(srv, 5).some((l) => /^used a reset link issued by Marta Jansen and set a new password/.test(l.text) && l.actor_id === ids.sofia));
  });

  await t.test('CF-Connecting-IP is the address, whatever X-Forwarded-For says', async () => {
    // the Client helper has no CF header option, so send it with fetch directly
    const attempt = (xff, cf, password) => fetch(srv.base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kivo': '1', 'X-Forwarded-For': xff, 'CF-Connecting-IP': cf },
      body: JSON.stringify({ username: 'noor', password }),
    }).then((r) => r.status);
    for (let i = 0; i < 8; i++) await attempt('10.200.0.' + i, '203.0.113.50', 'wrong-' + i);
    assert.equal(await attempt('10.200.1.1', '203.0.113.50', pw('noor')), 429, 'rotating X-Forwarded-For does not escape the lock');
    assert.equal(await attempt('10.200.1.1', '203.0.113.51', pw('noor')), 200, 'another visitor is unaffected');
    assert.equal(await attempt('10.200.1.2', 'not-an-ip', pw('noor')), 200, 'a garbage header falls back to req.ip');
  });

  await t.test('a sign-in during a flood waits its turn instead of being refused', async () => {
    const flood = Promise.all(Array.from({ length: 30 }, (_, i) => {
      const cl = srv.client();
      cl.ip = '10.201.0.' + i;
      return cl.post('/api/auth/login', { username: 'ravi', password: 'burst-' + i });
    }));
    await new Promise((r) => setTimeout(r, 100));
    const { r } = await login(srv, 'ravi');
    assert.equal(r.status, 200, 'the real sign-in got through the queue');
    const tries = await flood;
    assert.ok(tries.every((x) => x.status === 401), tries.map((x) => x.status).join(','));
  });

  await t.test('past the queue the answer is "busy", and busy answers are not failures', async () => {
    const failedNoor = () => {
      const d = srv.db();
      try { return d.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE text = 'failed sign-in attempt for \"noor\"'").get().c; } finally { d.close(); }
    };
    const before = failedNoor();
    const tries = await Promise.all(Array.from({ length: 80 }, (_, i) => {
      const cl = srv.client();
      cl.ip = '10.202.' + Math.floor(i / 200) + '.' + (i % 200);
      return cl.post('/api/auth/login', { username: 'noor', password: 'burst-' + i });
    }));
    const busy = tries.filter((x) => x.status === 503).length;
    assert.ok(busy > 0, 'some got 503: ' + tries.map((x) => x.status).join(','));
    assert.ok(tries.every((x) => x.status === 503 || x.status === 401));
    assert.equal(failedNoor() - before, 80 - busy, 'only checked attempts are logged as failures');
    assert.equal((await login(srv, 'noor')).r.status, 200, 'not locked by the busy ones');
  });

  await t.test('changes per account are limited per minute; reads and other accounts are not', async () => {
    const { c: tom } = await login(srv, 'tom');
    let last;
    for (let i = 0; i < 41; i++) last = await tom.put('/api/me/profile', { statusText: 'step ' + i });
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) > 0);
    assert.equal((await tom.get('/api/auth/me')).status, 200, 'reads still work');
    // the limit is per account, so a fresh session of Tom's is still over it
    // ('/api//auth/logout' isn't a route at all: Express answers 404, not 429)
    assert.equal((await tom.post('/api//auth/logout')).status, 404);
    for (const p of ['/api/auth/logout', '/api/AUTH/logout', '/api/auth/logout/']) {
      const { c: s } = await login(srv, 'tom');
      assert.equal((await s.put('/api/me/profile', { statusText: 'x' })).status, 429, 'still over the limit');
      assert.equal((await s.post(p)).status, 200, p + ' signs out');
      assert.equal((await s.get('/api/auth/me')).status, 401, p + ' really ended the session');
    }
    assert.equal((await c.lena.put('/api/me/profile', { statusText: 'fine' })).status, 200, 'other accounts unaffected');
  });

  await t.test('transfer without a body is a clean 400, never a 500', async () => {
    const r = await c.ingrid.req('POST', `/api/users/${ids.omar}/transfer`, undefined);
    assert.equal(r.status, 400);
    assert.doesNotMatch(srv.output(), /Request failed/);
  });
});

test('production behind a proxy redirects http to https', async (t) => {
  const srv = await startServer({ env: { NODE_ENV: 'production', TRUST_PROXY: '1', APP_URL: 'https://kivo.example.com' } });
  t.after(() => srv.stop());
  // fetch always sends the URL's own Host, so use http.request for a chosen one
  const get = (headers) => new Promise((resolve, reject) => {
    const q = http.request({ host: '127.0.0.1', port: srv.port, path: '/index.html?x=1', headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, location: res.headers.location });
    });
    q.on('error', reject);
    q.end();
  });
  let r = await get({ 'X-Forwarded-Proto': 'http', Host: 'kivo.example.com' });
  assert.equal(r.status, 308);
  assert.equal(r.location, 'https://kivo.example.com/index.html?x=1');
  r = await get({ 'X-Forwarded-Proto': 'https', Host: 'kivo.example.com' });
  assert.equal(r.status, 200);
  r = await get({ Host: 'kivo.example.com' });
  assert.equal(r.status, 200, 'no X-Forwarded-Proto (opened directly): no redirect');
  r = await get({ 'X-Forwarded-Proto': 'http', Host: 'evil.example/x' });
  assert.ok(r.status !== 308 || !String(r.location).includes('evil.example/x'), 'odd Host never reflected');
});

for (const trust of ['', '0', '10.9.9.9']) {
  test(`production with TRUST_PROXY="${trust}" (proxy not trusted) never redirects`, async (t) => {
    const srv = await startServer({ env: { NODE_ENV: 'production', TRUST_PROXY: trust } });
    t.after(() => srv.stop());
    for (const proto of ['https', 'http']) {
      const r = await fetch(srv.base + '/', { redirect: 'manual', headers: { 'X-Forwarded-Proto': proto } });
      assert.equal(r.status, 200, 'X-Forwarded-Proto: ' + proto);
    }
  });
}
