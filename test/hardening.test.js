const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, buildWorld, login, pw, lastLogs } = require('./helpers');

test('hardening round 2', async (t) => {
  const srv = await startServer({ env: { TRUST_PROXY: 'true' } });
  t.after(() => srv.stop());
  const { c, ids } = await buildWorld(srv, { dina: false });
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
  await c.lena.put('/api/me/profile', { avatar: 'data:image/jpeg;base64,' + jpeg.toString('base64') });

  await t.test('sessions end 7 days after sign-in, however active', async () => {
    const { c: s } = await login(srv, 'tom');
    assert.equal((await s.get('/api/auth/me')).status, 200);
    const d = srv.db();
    // still inside its 12 h sliding window, but signed in over a week ago
    d.prepare('UPDATE sessions SET created_at = ?, expires_at = ?, refreshed_at = ? WHERE user_id = ?')
      .run(Date.now() - 7 * 24 * 3600 * 1000 - 1000, Date.now() + 3600 * 1000, Date.now(), ids.tom);
    d.close();
    assert.equal((await s.get('/api/auth/me')).status, 401);
    // and a refresh never stretches the cookie past the cap
    const { c: s2, r } = await login(srv, 'tom');
    assert.equal(r.status, 200);
    const d2 = srv.db();
    d2.prepare('UPDATE sessions SET created_at = ?, refreshed_at = 0 WHERE user_id = ?').run(Date.now() - 7 * 24 * 3600 * 1000 + 60 * 1000, ids.tom);
    d2.close();
    const me = await s2.get('/api/auth/me');
    assert.equal(me.status, 200);
    const maxAge = Number(/Max-Age=(\d+)/.exec(me.setCookies[0])[1]);
    assert.ok(maxAge <= 60, 'cookie lifetime capped to what is left of the week, got ' + maxAge);
    c.tom = (await login(srv, 'tom')).c;
  });

  await t.test('ids that are not numbers or strings are refused, never a 500', async () => {
    const evil = { toString: 'x' };
    const arr = [1];
    const r1 = await c.marta.post('/api/roadmaps', { title: 'Odd ids', memberIds: [evil, arr, { valueOf: 1 }, ids.lena] });
    assert.equal(r1.status, 201);
    const rid = r1.body.roadmap.id;
    assert.deepEqual((await c.marta.get(`/api/roadmaps/${rid}`)).body.roadmap.memberIds, [ids.lena]);
    const task = (await c.marta.post(`/api/roadmaps/${rid}/tasks`, { title: 'T', assignees: [evil, ids.lena] })).body.task.id;
    assert.equal((await c.marta.patch(`/api/tasks/${task}`, { assignees: [evil] })).status, 200);
    const tr = await c.ingrid.post(`/api/users/${ids.marta}/transfer`, { toId: evil });
    assert.equal(tr.status, 400);
    assert.equal((await c.ingrid.post(`/api/users/${ids.marta}/transfer`, { toId: [ids.omar] })).status, 400);
    assert.doesNotMatch(srv.output(), /Request failed/, 'no 500s logged');
  });

  await t.test('avatars follow profile visibility, and payloads only link pictures you may see', async () => {
    assert.equal((await c.ravi.get(`/api/users/${ids.lena}/avatar`)).status, 404, 'no shared roadmap');
    assert.equal((await c.tom.get(`/api/users/${ids.lena}/avatar`)).status, 404, 'same team but no shared roadmap');
    assert.equal((await c.marta.get(`/api/users/${ids.lena}/avatar`)).status, 200, 'her manager');
    assert.equal((await c.ingrid.get(`/api/users/${ids.lena}/avatar`)).status, 200, 'IT');
    // Lena comments on a roadmap Ravi is on, then is removed from it
    const rid = (await c.marta.post('/api/roadmaps', { title: 'Shared once', memberIds: [ids.lena, ids.ravi] })).body.roadmap.id;
    const task = (await c.marta.post(`/api/roadmaps/${rid}/tasks`, { title: 'Hello' })).body.task.id;
    await c.lena.post(`/api/tasks/${task}/comments`, { text: 'hi' });
    let seen = (await c.ravi.get(`/api/tasks/${task}/comments`)).body.people[ids.lena];
    assert.match(seen.avatar, /\/api\/users\/\d+\/avatar\?v=\d+/, 'shares a roadmap: picture linked');
    assert.equal((await c.ravi.get(seen.avatar)).status, 200);
    const b = (await c.marta.get(`/api/roadmaps/${rid}`)).body;
    await c.marta.put(`/api/roadmaps/${rid}`, { title: 'Shared once', memberIds: [ids.ravi], updatedAt: b.roadmap.updatedAt });
    seen = (await c.ravi.get(`/api/tasks/${task}/comments`)).body.people[ids.lena];
    assert.equal(seen.avatar, '', 'no longer visible: no picture link, so no 404 in the browser');
    assert.equal(seen.name, 'Lena Marsh', 'the name still shows');
    assert.equal((await c.ravi.get(`/api/users/${ids.lena}/avatar`)).status, 404);
  });

  await t.test('hidden accounts answer exactly like missing ones', async () => {
    const routes = [
      ['get', (id) => `/api/users/${id}`],
      ['get', (id) => `/api/users/${id}/log`],
      ['post', (id) => `/api/users/${id}/link`],
      ['post', (id) => `/api/users/${id}/deactivate`],
      ['post', (id) => `/api/users/${id}/reactivate`],
    ];
    for (const [m, path] of routes) {
      const hidden = await c.noor[m](path(ids.sofia));
      const missing = await c.noor[m](path(987654));
      assert.equal(hidden.status, 404, path(ids.sofia));
      assert.deepEqual(hidden.body, missing.body, path(ids.sofia));
    }
  });

  await t.test('a full save based on an old copy is refused with 409', async () => {
    const rid = (await c.marta.post('/api/roadmaps', { title: 'Versioned', memberIds: [ids.lena, ids.tom], creatorMode: 'everyone' })).body.roadmap.id;
    const task = (await c.marta.post(`/api/roadmaps/${rid}/tasks`, { title: 'V', assignees: [ids.lena, ids.tom] })).body.task.id;
    const before = (await c.marta.get(`/api/roadmaps/${rid}`)).body;
    const tBefore = before.tasks.find((x) => x.id === task);
    // Lena edits the task; Tom's form still has the old version
    assert.equal((await c.lena.patch(`/api/tasks/${task}`, { title: 'V by Lena', updatedAt: tBefore.updatedAt })).status, 200);
    const stale = await c.tom.patch(`/api/tasks/${task}`, { title: 'V by Tom', description: 'x', updatedAt: tBefore.updatedAt });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'Someone else changed this. Reload and try again.');
    const now = (await c.tom.get(`/api/roadmaps/${rid}`)).body.tasks.find((x) => x.id === task);
    assert.equal(now.title, 'V by Lena');
    assert.ok(now.updatedAt > tBefore.updatedAt);
    assert.equal((await c.tom.patch(`/api/tasks/${task}`, { title: 'V by Tom', updatedAt: now.updatedAt })).status, 200);
    // a status move changes the stamp too
    const v2 = (await c.tom.get(`/api/roadmaps/${rid}`)).body.tasks.find((x) => x.id === task).updatedAt;
    await c.lena.patch(`/api/tasks/${task}`, { status: 'in_progress', fromStatus: 'planned' });
    assert.equal((await c.tom.patch(`/api/tasks/${task}`, { assignees: [ids.tom], updatedAt: v2 })).status, 409);
    // roadmap settings
    const r0 = before.roadmap.updatedAt;
    assert.equal((await c.marta.put(`/api/roadmaps/${rid}`, { title: 'Versioned 2', memberIds: [ids.lena, ids.tom], creatorMode: 'everyone', updatedAt: r0 })).status, 200);
    const old = await c.marta.put(`/api/roadmaps/${rid}`, { title: 'Versioned (old tab)', memberIds: [ids.lena], updatedAt: r0 });
    assert.equal(old.status, 409);
    assert.equal(old.body.error, 'Someone else changed this. Reload and try again.');
    assert.equal((await c.marta.get(`/api/roadmaps/${rid}`)).body.roadmap.title, 'Versioned 2');
    // archiving bumps it as well
    const r1 = (await c.marta.get(`/api/roadmaps/${rid}`)).body.roadmap.updatedAt;
    await c.ingrid.post(`/api/roadmaps/${rid}/archive`);
    await c.ingrid.post(`/api/roadmaps/${rid}/unarchive`);
    assert.equal((await c.marta.put(`/api/roadmaps/${rid}`, { title: 'x', memberIds: [], updatedAt: r1 })).status, 409);
  });

  await t.test('only the very first account is the original admin; usernames clash with 409', async () => {
    const me = (await c.ingrid.get(`/api/users/${ids.ingrid}`)).body.user;
    assert.equal(me.original, true);
    assert.equal((await c.ingrid.get(`/api/users/${ids.marta}`)).body.user.original, false);
    const dup = await c.ingrid.post('/api/users', { role: 'manager', name: 'Marta Two', username: 'marta' });
    assert.equal(dup.status, 409);
  });

  await t.test('failed sign-ins for names that are not accounts leave no trace in the log', async () => {
    const before = lastLogs(srv, 1)[0].id;
    for (const name of ['nosuchuser', 'MyPassword12', 'x y z']) await login(srv, name, 'whatever-123');
    assert.equal(lastLogs(srv, 1)[0].id, before);
    await login(srv, 'omar', 'wrong-123');
    assert.equal(lastLogs(srv, 1)[0].text, 'failed sign-in attempt for "omar"');
    assert.ok((await login(srv, 'omar', pw('omar'))).r.status === 200);
  });
});

test('startup warnings for production settings', async (t) => {
  const none = await startServer({ env: { NODE_ENV: 'production' } });
  t.after(() => none.stop());
  assert.match(none.output(), /WARNING: NODE_ENV=production without APP_URL/);
  const http = await startServer({ env: { NODE_ENV: 'production', APP_URL: 'http://kivo.example.com' } });
  t.after(() => http.stop());
  assert.match(http.output(), /WARNING: NODE_ENV=production with a non-https APP_URL/);
  assert.match(http.output(), /http:\/\/kivo\.example\.com\/#\/invite\//, 'the setup link uses APP_URL');
  const ok = await startServer({ env: { NODE_ENV: 'production', APP_URL: 'https://kivo.example.com', TRUST_PROXY: '1' } });
  t.after(() => ok.stop());
  assert.doesNotMatch(ok.output(), /WARNING/);
  const docker = await startServer({ env: { HOST_PORT: '8123' } });
  t.after(() => docker.stop());
  assert.match(docker.output(), /http:\/\/localhost:8123\/#\/invite\//, 'without APP_URL the link uses the host port');
});
