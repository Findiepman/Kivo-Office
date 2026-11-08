const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, buildWorld, login, pw, invite, useLink, lastLogs } = require('./helpers');

test('accounts: create, deactivate, transfer, reactivate', async (t) => {
  const srv = await startServer({ env: { TRUST_PROXY: 'true' } });
  t.after(() => srv.stop());
  const { c, ids } = await buildWorld(srv, { dina: false });

  await t.test('IT invites managers and IT admins; managers invite members', async () => {
    const st = (who, role, u) => c[who].post('/api/users', { role, name: 'X ' + u, username: u }).then((r) => r.status);
    assert.equal(await st('lena', 'member', 'm1'), 403);
    assert.equal(await st('marta', 'manager', 'm2'), 403);
    assert.equal(await st('marta', 'it', 'm3'), 403);
    assert.equal(await st('ingrid', 'member', 'm4'), 403);
    assert.equal(await st('ingrid', 'boss', 'm5'), 400);
    assert.equal(await st('marta', 'member', 'Bad Name'), 400);
    assert.equal(await st('marta', 'member', 'lena'), 409, 'taken');
    const bad = await c.marta.post('/api/users', { role: 'member', name: 'E', username: 'emailbad', email: 'not an email' });
    assert.equal(bad.status, 400);
    assert.ok(lastLogs(srv, 10).some((l) => /blocked from creating an account/.test(l.text)));
  });

  // Tasks for the deactivation test: Tom on two open tasks and one finished.
  const rid = (await c.marta.post('/api/roadmaps', { title: 'Website', memberIds: [ids.lena, ids.tom] })).body.roadmap.id;
  const open1 = (await c.marta.post(`/api/roadmaps/${rid}/tasks`, { title: 'Redirects', assignees: [ids.tom] })).body.task.id;
  const open2 = (await c.marta.post(`/api/roadmaps/${rid}/tasks`, { title: 'Sitemap', assignees: [ids.tom, ids.lena] })).body.task.id;
  const done = (await c.marta.post(`/api/roadmaps/${rid}/tasks`, { title: 'Old', assignees: [ids.tom] })).body.task.id;
  await c.tom.patch(`/api/tasks/${done}`, { status: 'finished' });

  await t.test("deactivating ends the person's sessions at once and blocks sign-in", async () => {
    const other = (await login(srv, 'tom')).c;
    assert.equal((await c.omar.post(`/api/users/${ids.tom}/deactivate`)).status, 404, "not Omar's member, and hidden from him");
    assert.equal((await c.lena.post(`/api/users/${ids.tom}/deactivate`)).status, 403);
    assert.equal((await c.marta.post(`/api/users/${ids.tom}/deactivate`)).status, 200);
    assert.equal((await c.tom.get('/api/auth/me')).status, 401);
    assert.equal((await other.get('/api/roadmaps')).status, 401);
    const { r } = await login(srv, 'tom');
    assert.equal(r.status, 403);
    assert.match(r.body.error, /deactivated/);
    assert.equal((await c.marta.post(`/api/users/${ids.tom}/deactivate`)).status, 400, 'already deactivated');
    const d = srv.db();
    assert.equal(d.prepare('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?').get(ids.tom).c, 0);
    d.close();
  });

  await t.test('their open tasks are unassigned and flagged for the owner; finished tasks keep them', async () => {
    const b = (await c.marta.get(`/api/roadmaps/${rid}`)).body;
    const get = (id) => b.tasks.find((x) => x.id === id);
    assert.deepEqual(get(open1).assignees, []);
    assert.deepEqual(get(open1).flags.map((f) => [f.userId, f.reason]), [[ids.tom, 'account deactivated']]);
    assert.deepEqual(get(open2).assignees, [ids.lena], 'others stay');
    assert.deepEqual(get(done).assignees, [ids.tom], 'finished work keeps its history');
    assert.equal(b.people[ids.tom].active, false, 'shown as deactivated');
    assert.ok(!b.assignable.includes(ids.tom), 'cannot be assigned any more');
    assert.ok(lastLogs(srv, 10).some((l) => /unassigned Tom Bakker from "Redirects" \(account deactivated\)/.test(l.text)));
    // the owner saves the finished task as the form sends it: Tom stays as history
    const save = await c.marta.patch(`/api/tasks/${done}`, { title: 'Old', assignees: [ids.tom, ids.lena] });
    assert.equal(save.status, 200);
    const after = (await c.marta.get(`/api/roadmaps/${rid}`)).body.tasks.find((x) => x.id === done);
    assert.deepEqual(after.assignees.slice().sort(), [ids.tom, ids.lena].sort());
    assert.ok(!lastLogs(srv, 3).some((l) => /unassigned Tom/.test(l.text)));
    // but a deactivated person can't be newly assigned
    await c.marta.patch(`/api/tasks/${open1}`, { assignees: [ids.tom] });
    assert.ok(!(await c.marta.get(`/api/roadmaps/${rid}`)).body.tasks.find((x) => x.id === open1).assignees.includes(ids.tom));
  });

  await t.test('a manager who still owns roadmaps or members must be transferred first', async () => {
    const r = await c.ingrid.post(`/api/users/${ids.marta}/deactivate`);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /Transfer them to another manager first/);
    const o = (await c.ingrid.get('/api/admin/overview')).body;
    assert.deepEqual(o.managers.find((m) => m.id === ids.marta).blockers, ['transfer']);
    assert.equal((await c.marta.post(`/api/users/${ids.marta}/transfer`, { toId: ids.omar })).status, 403, 'IT only');
    assert.equal((await c.ingrid.post(`/api/users/${ids.marta}/transfer`, { toId: ids.lena })).status, 400, 'to a manager only');
    assert.equal((await c.ingrid.post(`/api/users/${ids.marta}/transfer`, { toId: ids.marta })).status, 400);
    // Marta is assigned on her own roadmap: that open task gets flagged by the transfer
    const mt = (await c.marta.post(`/api/roadmaps/${rid}/tasks`, { title: 'Marta own', assignees: [ids.marta] })).body.task.id;
    const tr = await c.ingrid.post(`/api/users/${ids.marta}/transfer`, { toId: ids.omar, deactivate: true });
    assert.equal(tr.status, 200, tr.text);
    assert.deepEqual(tr.body, { roadmaps: 1, members: 3, deactivated: true });
    assert.equal((await c.marta.get('/api/auth/me')).status, 401);
    const b = (await c.omar.get(`/api/roadmaps/${rid}`)).body;
    assert.equal(b.roadmap.managerId, ids.omar);
    assert.equal(b.roadmap.can.owner, true);
    assert.deepEqual(b.tasks.find((x) => x.id === mt).flags.map((f) => f.reason), ['roadmap transferred']);
    const team = (await c.omar.get('/api/team')).body.members.map((m) => m.username).sort();
    assert.deepEqual(team, ['lena', 'noor', 'ravi', 'sofia', 'tom']);
    // the new manager now manages Tom's account (and may reactivate him, Marta did the deactivation)
    assert.equal((await c.omar.post(`/api/users/${ids.tom}/reactivate`)).status, 200);
  });

  await t.test('if IT deactivated someone, only IT can reactivate them', async () => {
    assert.equal((await c.ingrid.post(`/api/users/${ids.sofia}/deactivate`)).status, 200);
    const row = (await c.omar.get('/api/team')).body.members.find((m) => m.id === ids.sofia);
    assert.equal(row.can.reactivate, false);
    assert.equal(row.deactivatedByIt, true);
    const r = await c.omar.post(`/api/users/${ids.sofia}/reactivate`);
    assert.equal(r.status, 403);
    assert.match(r.body.error, /only IT can reactivate/);
    assert.equal((await c.ingrid.post(`/api/users/${ids.sofia}/reactivate`)).status, 200);
    assert.equal((await login(srv, 'sofia')).r.status, 200);
    assert.equal((await c.ingrid.post(`/api/users/${ids.sofia}/reactivate`)).status, 400, 'already active');
  });

  await t.test('the last IT admin with a password cannot be deactivated', async () => {
    let r = await c.ingrid.post(`/api/users/${ids.ingrid}/deactivate`);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /last active IT admin/);
    // a pending IT invite does not count as a second admin
    const dina = await invite(c.ingrid, 'it', 'Dina Alvarez', 'dina');
    r = await c.ingrid.post(`/api/users/${ids.ingrid}/deactivate`);
    assert.equal(r.status, 409);
    const dc = await useLink(srv, dina.token, pw('dina'));
    // with two, either may go, but then the remaining one is the last
    assert.equal((await dc.post(`/api/users/${dina.user.id}/deactivate`)).status, 200, 'IT may deactivate itself when not last');
    assert.equal((await dc.get('/api/auth/me')).status, 401);
    assert.equal((await c.ingrid.post(`/api/users/${ids.ingrid}/deactivate`)).status, 409);
  });

  await t.test('deactivated people keep their name in lists, marked', async () => {
    const o = (await c.ingrid.get('/api/admin/overview')).body;
    const m = o.managers.find((x) => x.id === ids.marta);
    assert.equal(m.active, false);
    assert.equal(m.can.reactivate, true);
    assert.equal(m.can.reset, false, 'no links for deactivated accounts');
  });
});

test('profile: picture validation and status', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const { c, ids } = await buildWorld(srv, { dina: false });
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 7)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(50)]);
  const url = (mime, buf) => `data:image/${mime};base64,${buf.toString('base64')}`;
  const put = (body) => c.lena.put('/api/me/profile', body);

  await t.test('real JPEG, PNG and WebP pictures are accepted and served back', async () => {
    for (const [m, b] of [['png', png], ['webp', webp], ['jpeg', jpeg]]) {
      const r = await put({ avatar: url(m, b) });
      assert.equal(r.status, 200, m + ' ' + r.text);
      assert.ok(r.body.user.avatar.startsWith(`/api/users/${ids.lena}/avatar?v=`));
    }
    const img = await c.marta.get(`/api/users/${ids.lena}/avatar`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await srv.client().get(`/api/users/${ids.lena}/avatar`)).status, 401, 'signed-in users only');
  });

  await t.test('the roadmap people picker only offers pictures the manager may see', async () => {
    // lena still has the JPEG from the test above; omar shares no roadmap with her
    const r = await c.omar.get('/api/people/addable');
    assert.equal(r.status, 200);
    const lena = r.body.people.find((p) => p.id === ids.lena);
    assert.ok(lena, 'lena can be added to a roadmap');
    assert.ok(!lena.avatar, 'but her picture is not handed out');
    for (const p of r.body.people.filter((x) => x.avatar)) {
      assert.equal((await c.omar.get(p.avatar.split('?')[0])).status, 200, 'every offered picture loads');
    }
  });

  await t.test('anything else is refused', async () => {
    const bad = {
      'wrong magic bytes': url('jpeg', png),
      'png claiming webp': url('webp', png),
      'svg': 'data:image/svg+xml;base64,' + Buffer.from('<svg onload="alert(1)"/>').toString('base64'),
      'gif': 'data:image/gif;base64,' + Buffer.from('GIF89a....').toString('base64'),
      'too big': url('jpeg', Buffer.concat([jpeg, Buffer.alloc(101 * 1024)])),
      'not base64': 'data:image/jpeg;base64,/9j/4AAQ$$$$',
      'bad padding': 'data:image/jpeg;base64,/9j/4A=',
      'trailing junk': url('jpeg', jpeg) + '"); background: red',
      'not a string': { toString: 1 },
      'javascript url': 'javascript:alert(1)',
    };
    for (const [name, avatar] of Object.entries(bad)) {
      const r = await put({ avatar });
      assert.equal(r.status, 400, name + ': ' + r.status);
    }
    // far over the body limit is cut off before it is even parsed
    const huge = await put({ avatar: url('jpeg', Buffer.concat([jpeg, Buffer.alloc(300 * 1024)])) });
    assert.equal(huge.status, 413);
    assert.equal((await put({ avatar: '' })).status, 200, 'removing works');
    assert.equal((await put({ avatar: '' })).body.changed, false);
  });

  await t.test('name, presence and status text are validated and logged', async () => {
    assert.equal((await put({ name: '   ' })).status, 400);
    assert.equal((await put({ presence: 'invisible' })).status, 400);
    assert.equal((await put({ email: 'nope' })).status, 400);
    const r = await put({ name: '  Lena   M.  ', presence: 'busy', statusText: 'S'.repeat(200), email: 'lena@example.com' });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.name, 'Lena M.');
    assert.equal(r.body.user.statusText.length, 80);
    assert.equal(r.body.user.email, 'lena@example.com');
    assert.ok(lastLogs(srv, 3).some((l) => l.text === 'changed their name, status to busy, status message, email address'));
    await c.marta.post('/api/roadmaps', { title: 'Team', memberIds: [ids.lena, ids.tom] });
    const seen = (await c.tom.get(`/api/users/${ids.lena}`)).body.user;
    assert.equal(seen.email, undefined, 'colleagues do not see the email address');
    assert.equal((await c.marta.get(`/api/users/${ids.lena}`)).body.user.email, 'lena@example.com', 'her manager does');
  });

  await t.test('profiles are visible to people who share a roadmap, the creator and IT', async () => {
    assert.equal((await c.ravi.get(`/api/users/${ids.lena}`)).status, 404);
    await c.marta.post('/api/roadmaps', { title: 'Shared', memberIds: [ids.lena, ids.ravi] });
    assert.equal((await c.ravi.get(`/api/users/${ids.lena}`)).status, 200);
    assert.equal((await c.ravi.get(`/api/users/${ids.lena}/log`)).status, 403, 'but not their log');
    assert.equal((await c.lena.get(`/api/users/${ids.lena}/log`)).status, 200);
    assert.equal((await c.marta.get(`/api/users/${ids.lena}/log`)).status, 200);
    assert.equal((await c.omar.get(`/api/users/${ids.lena}/log`)).status, 404, 'hidden from Omar: same answer as a missing account');
    assert.equal((await c.ingrid.get(`/api/users/${ids.lena}/log?part=about`)).status, 200);
  });
});
