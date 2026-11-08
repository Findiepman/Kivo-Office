const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, buildWorld, login } = require('./helpers');

test('audit log', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const { c, ids } = await buildWorld(srv, { dina: false });

  await t.test('the database itself rejects UPDATE and DELETE on both logs', async () => {
    const d = srv.db();
    try {
      const before = d.prepare('SELECT COUNT(*) AS c FROM audit_log').get().c;
      assert.ok(before > 10);
      for (const sql of [
        "UPDATE audit_log SET text = 'nothing happened'",
        "UPDATE audit_log SET actor_id = NULL WHERE id = 1",
        'DELETE FROM audit_log',
        'DELETE FROM audit_log WHERE id = 1',
        "UPDATE password_log SET kind = 'x'",
        'DELETE FROM password_log',
      ]) {
        assert.throws(() => d.prepare(sql).run(), /append-only/, sql);
      }
      assert.throws(() => d.exec("INSERT OR REPLACE INTO audit_log (id, at, action, text) VALUES (1, 0, 'login', 'rewritten')"), /append-only/,
        'REPLACE would silently delete the old row');
      assert.throws(() => d.exec("REPLACE INTO password_log (id, at, kind) VALUES (1, 0, 'x')"), /append-only/);
      assert.equal(d.prepare('SELECT COUNT(*) AS c FROM audit_log').get().c, before);
      // appending is still fine
      d.prepare("INSERT INTO audit_log (at, action, text) VALUES (?, 'security', 'test append')").run(Date.now());
    } finally {
      d.close();
    }
  });

  await t.test('every kind of action gets logged', async () => {
    const rid = (await c.marta.post('/api/roadmaps', { title: 'Logged', memberIds: [ids.lena] })).body.roadmap.id;
    const tid = (await c.marta.post(`/api/roadmaps/${rid}/tasks`, { title: 'T', assignees: [ids.lena] })).body.task.id;
    await c.lena.patch(`/api/tasks/${tid}`, { status: 'finished' });
    await c.marta.patch(`/api/tasks/${tid}`, { status: 'planned' });
    await c.lena.post(`/api/tasks/${tid}/comments`, { text: 'hello' });
    await c.lena.put('/api/me/profile', { presence: 'away' });
    await c.tom.patch(`/api/tasks/${tid}`, { title: 'nope' });
    await c.lena.post('/api/auth/logout');
    assert.equal((await c.lena.get('/api/auth/me')).status, 401);
    c.lena = (await login(srv, 'lena')).c;
    const d = srv.db();
    const actions = new Set(d.prepare('SELECT DISTINCT action FROM audit_log').all().map((r) => r.action));
    d.close();
    for (const a of ['login', 'account', 'password', 'roadmap', 'task', 'comment', 'profile', 'security', 'override']) {
      assert.ok(actions.has(a), 'missing ' + a);
    }
  });

  await t.test('who can read which log', async () => {
    const rid = (await c.marta.get('/api/roadmaps')).body.roadmaps[0].id;
    assert.equal((await c.marta.get('/api/admin/log')).status, 403);
    assert.equal((await c.marta.get('/api/admin/passwords')).status, 403);
    assert.equal((await c.ingrid.get('/api/admin/log')).status, 200);
    assert.equal((await c.ingrid.get('/api/admin/passwords')).status, 200);
    assert.equal((await c.marta.get(`/api/roadmaps/${rid}/log`)).status, 200, 'owner');
    assert.equal((await c.lena.get(`/api/roadmaps/${rid}/log`)).status, 404, 'member');
    assert.equal((await c.omar.get(`/api/roadmaps/${rid}/log`)).status, 404, 'another manager');
    assert.equal((await c.ingrid.get(`/api/roadmaps/${rid}/log`)).status, 200, 'IT');
  });

  await t.test('filter and pagination', async () => {
    const rid = (await c.marta.post('/api/roadmaps', { title: 'Busy', memberIds: [] })).body.roadmap.id;
    for (let i = 0; i < 60; i++) await c.marta.post(`/api/roadmaps/${rid}/tasks`, { title: 'Task number ' + i });
    const p1 = (await c.marta.get(`/api/roadmaps/${rid}/log`)).body;
    assert.equal(p1.entries.length, 50);
    assert.equal(p1.total, 61);
    assert.equal(p1.pages, 2);
    assert.equal(p1.entries[0].text, 'created the task "Task number 59"', 'newest first');
    const p2 = (await c.marta.get(`/api/roadmaps/${rid}/log?page=2`)).body;
    assert.equal(p2.entries.length, 11);
    assert.equal(p2.entries[10].text, 'created the roadmap "Busy"');
    const f = (await c.marta.get(`/api/roadmaps/${rid}/log?q=${encodeURIComponent('number 5')}`)).body;
    assert.equal(f.total, 11, '5 and 50..59');
    const byActor = (await c.ingrid.get(`/api/admin/log?q=${encodeURIComponent('marta jansen')}`)).body;
    assert.ok(byActor.total >= 61, 'filters on the actor name too');
    // % and _ are literal, not wildcards
    assert.equal((await c.marta.get(`/api/roadmaps/${rid}/log?q=${encodeURIComponent('%')}`)).body.total, 0);
    assert.equal((await c.marta.get(`/api/roadmaps/${rid}/log?q=${encodeURIComponent("' OR 1=1 --")}`)).body.total, 0);
    const pw = (await c.ingrid.get('/api/admin/passwords?q=invite%20used')).body;
    assert.ok(pw.total >= 5);
    assert.ok(pw.entries.every((e) => e.kind === 'invite_used'));
    const label = (await c.ingrid.get('/api/admin/passwords?q=' + encodeURIComponent('password set'))).body;
    assert.ok(label.total >= 5, 'filters on the label the page shows');
  });

  await t.test('account log: what they did, and what was done to them', async () => {
    const by = (await c.lena.get(`/api/users/${ids.lena}/log`)).body;
    assert.ok(by.entries.every((e) => e.actorId === ids.lena));
    assert.ok(by.entries.some((e) => e.text === 'changed their status to away'));
    const about = (await c.marta.get(`/api/users/${ids.lena}/log?part=about`)).body;
    assert.ok(about.entries.some((e) => /created the team member account "Lena Marsh"/.test(e.text)));
    assert.ok(about.entries.every((e) => e.actorId !== ids.lena));
  });
});
