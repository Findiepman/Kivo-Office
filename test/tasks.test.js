const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, buildWorld, lastLogs } = require('./helpers');

test('task rules', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const { c, ids } = await buildWorld(srv);

  const mkRoadmap = async (by, data) => {
    const r = await c[by].post('/api/roadmaps', data);
    assert.equal(r.status, 201, r.text);
    return r.body.roadmap.id;
  };
  const mkTask = (by, rid, data) => c[by].post(`/api/roadmaps/${rid}/tasks`, data);
  const board = (by, rid) => c[by].get(`/api/roadmaps/${rid}`).then((r) => r.body);
  const taskOf = async (by, rid, id) => (await board(by, rid)).tasks.find((x) => x.id === id);

  // Website relaunch: Marta's, chosen handlers = Lena. Noor (Omar's) is on it too.
  const web = await mkRoadmap('marta', {
    title: 'Website relaunch', description: 'New site', memberIds: [ids.lena, ids.tom, ids.sofia, ids.noor], creatorMode: 'chosen', creators: [ids.lena],
  });
  // Mobile app: Omar's, everyone may create. Marta is a member there.
  const app = await mkRoadmap('omar', { title: 'Mobile app v2', memberIds: [ids.ravi, ids.noor, ids.marta], creatorMode: 'everyone' });
  // Manager-only roadmap
  const solo = await mkRoadmap('marta', { title: 'Solo', memberIds: [ids.lena], creatorMode: 'manager' });

  await t.test('only managers create roadmaps; people outside it cannot see it', async () => {
    assert.equal((await c.lena.post('/api/roadmaps', { title: 'Mine' })).status, 403);
    assert.equal((await c.ingrid.post('/api/roadmaps', { title: 'IT one' })).status, 403);
    assert.equal((await c.ravi.get(`/api/roadmaps/${web}`)).status, 404);
    assert.equal((await c.ingrid.get(`/api/roadmaps/${web}`)).status, 200, 'IT reads everything');
    const list = (await c.ravi.get('/api/roadmaps')).body.roadmaps.map((r) => r.id);
    assert.deepEqual(list, [app]);
  });

  await t.test('who creates tasks: manager only / everyone / manager + chosen handlers', async () => {
    assert.equal((await mkTask('lena', solo, { title: 'x' })).status, 403, 'manager only');
    assert.equal((await mkTask('marta', solo, { title: 'Solo task' })).status, 201);
    assert.equal((await mkTask('ravi', app, { title: 'Ravi task' })).status, 201, 'everyone');
    assert.equal((await mkTask('marta', app, { title: 'Marta on Omar' })).status, 201, 'a manager who is a member counts as everyone');
    assert.equal((await mkTask('lena', web, { title: 'Lena task' })).status, 201, 'chosen handler');
    assert.equal((await mkTask('tom', web, { title: 'Tom task' })).status, 403, 'not chosen');
    assert.equal((await mkTask('ingrid', web, { title: 'IT task' })).status, 403, 'IT never creates tasks');
    assert.equal((await mkTask('ravi', web, { title: 'x' })).status, 404, 'not on the roadmap');
    assert.ok(lastLogs(srv, 10).some((l) => l.action === 'security' && /blocked from creating a task/.test(l.text)));
  });

  let w1;
  await t.test('assignees are limited to people on the roadmap', async () => {
    const r = await mkTask('marta', web, { title: 'Audit current sitemap', tags: 'Research, research, SEO', assignees: [ids.tom, ids.ravi, 99999, 'x'] });
    w1 = r.body.task.id;
    const task = await taskOf('marta', web, w1);
    assert.deepEqual(task.assignees, [ids.tom]);
    assert.deepEqual(task.tags, ['Research', 'research', 'SEO'].slice(0, 3));
    assert.equal(task.status, 'planned');
  });

  await t.test('only assignees edit a task', async () => {
    const edit = (who) => c[who].patch(`/api/tasks/${w1}`, { title: 'Audit by ' + who }).then((r) => r.status);
    assert.equal(await edit('lena'), 403, 'chosen handler but not assigned');
    assert.equal(await edit('marta'), 403, 'owner but not assigned');
    assert.equal(await edit('ingrid'), 403, 'IT');
    assert.equal(await edit('tom'), 200, 'assignee');
    assert.equal((await taskOf('tom', web, w1)).title, 'Audit by tom');
    assert.ok(lastLogs(srv, 10).some((l) => l.text.includes('was blocked from changing') && l.text.includes('Only the people assigned')));
    const can = (await taskOf('lena', web, w1)).can;
    assert.equal(can.edit, false);
    assert.equal((await taskOf('tom', web, w1)).can.edit, true);
  });

  await t.test('status moves forward only; skipping ahead is fine; only the owner moves back (override)', async () => {
    const move = (who, status, extra) => c[who].patch(`/api/tasks/${w1}`, Object.assign({ status }, extra)).then((r) => r.status);
    assert.equal(await move('lena', 'in_progress'), 403, 'not assigned');
    assert.equal(await move('tom', 'finished'), 200, 'planned -> finished skips ahead');
    assert.equal(await move('tom', 'in_progress'), 403, 'assignee cannot go back');
    assert.equal(await move('tom', 'planned'), 403);
    assert.equal(await move('ingrid', 'planned'), 403, 'IT cannot go back');
    assert.equal(await move('marta', 'in_progress'), 200, 'owner override');
    const l = lastLogs(srv, 5).find((x) => x.action === 'override');
    assert.match(l.text, /moved "Audit by tom" back from Finished to In progress \(owner override\)/);
    const same = await c.marta.patch(`/api/tasks/${w1}`, { status: 'in_progress' });
    assert.deepEqual([same.status, same.body.changed], [200, false], 'already there is a no-op, as in the prototype');
    assert.equal(await move('marta', 'done'), 400, 'unknown status');
    const moves = (await taskOf('marta', web, w1)).can.moves;
    assert.deepEqual(moves.planned, { ok: true, override: true });
    assert.equal(moves.finished.ok, false, 'owner is not assigned, so cannot move forward');
  });

  await t.test('a manager who is only a member elsewhere cannot override there', async () => {
    const r = await mkTask('omar', app, { title: 'Onboarding flow', assignees: [ids.marta] });
    const id = r.body.task.id;
    assert.equal((await c.marta.patch(`/api/tasks/${id}`, { status: 'finished' })).status, 200);
    assert.equal((await c.marta.patch(`/api/tasks/${id}`, { status: 'planned' })).status, 403);
    assert.equal((await c.omar.patch(`/api/tasks/${id}`, { status: 'planned' })).status, 200);
  });

  await t.test('a stale confirm dialog does not move a task someone else moved', async () => {
    const r = await mkTask('marta', web, { title: 'Redirects', assignees: [ids.tom] });
    const id = r.body.task.id;
    assert.equal((await c.tom.patch(`/api/tasks/${id}`, { status: 'in_progress', fromStatus: 'planned' })).status, 200);
    const stale = await c.tom.patch(`/api/tasks/${id}`, { status: 'in_progress', fromStatus: 'planned' });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /changed while the dialog was open/);
  });

  await t.test('who may assign people', async () => {
    const r = await mkTask('lena', web, { title: 'Design library', assignees: [ids.lena] });
    const id = r.body.task.id;
    const assign = (who, list) => c[who].patch(`/api/tasks/${id}`, { assignees: list }).then((x) => x.status);
    assert.equal(await assign('tom', [ids.tom]), 403, 'a plain member');
    assert.equal(await assign('ingrid', [ids.tom]), 403, 'IT');
    assert.equal(await assign('lena', [ids.lena, ids.sofia]), 200, 'a chosen handler');
    assert.equal(await assign('marta', [ids.tom]), 200, 'the owner');
    assert.deepEqual((await taskOf('marta', web, id)).assignees, [ids.tom]);
    // in "everyone" mode a member may assign people to their own tasks only
    const own = (await mkTask('ravi', app, { title: 'Push settings' })).body.task.id;
    const other = (await mkTask('noor', app, { title: 'Screenshots' })).body.task.id;
    assert.equal((await c.ravi.patch(`/api/tasks/${own}`, { assignees: [ids.ravi, ids.noor] })).status, 200);
    assert.equal((await c.ravi.patch(`/api/tasks/${other}`, { assignees: [ids.ravi] })).status, 403);
    // unchanged assignees are not a change, so no permission is needed
    assert.equal((await c.tom.patch(`/api/tasks/${id}`, { assignees: [ids.tom] })).status, 200);
  });

  await t.test('who may delete a task', async () => {
    const r = await mkTask('lena', web, { title: 'Lena temp' });
    const id = r.body.task.id;
    assert.equal((await c.tom.del(`/api/tasks/${id}`)).status, 403);
    assert.equal((await c.ingrid.del(`/api/tasks/${id}`)).status, 403);
    assert.equal((await c.lena.del(`/api/tasks/${id}`)).status, 200, 'the creator');
    const r2 = await mkTask('lena', web, { title: 'Lena temp 2' });
    assert.equal((await c.marta.del(`/api/tasks/${r2.body.task.id}`)).status, 200, 'the owner');
    assert.equal((await c.marta.del(`/api/tasks/${r2.body.task.id}`)).status, 404);
    assert.ok(lastLogs(srv, 3).some((l) => l.text === 'deleted the task "Lena temp 2"'));
  });

  await t.test('roadmap settings: owner only; removing someone unassigns and flags their open tasks', async () => {
    assert.equal((await c.lena.put(`/api/roadmaps/${web}`, { title: 'Hijack' })).status, 403);
    assert.equal((await c.ingrid.put(`/api/roadmaps/${web}`, { title: 'Hijack' })).status, 403);
    const r = await mkTask('marta', web, { title: 'Noor task', assignees: [ids.noor] });
    const res = await c.marta.put(`/api/roadmaps/${web}`, {
      title: 'Website relaunch', description: 'New site', memberIds: [ids.lena, ids.tom, ids.sofia], creatorMode: 'chosen', creators: [ids.lena, ids.ravi],
    });
    assert.equal(res.status, 200);
    const b = await board('marta', web);
    assert.deepEqual(b.roadmap.creators, [ids.lena], 'a creator must be on the roadmap');
    const task = b.tasks.find((x) => x.id === r.body.task.id);
    assert.deepEqual(task.assignees, []);
    assert.equal(task.flags[0].userId, ids.noor);
    assert.equal(task.flags[0].reason, 'removed from the roadmap');
    assert.equal((await c.noor.get(`/api/roadmaps/${web}`)).status, 404, 'Noor lost access');
    // assigning someone new clears the flag
    await c.marta.patch(`/api/tasks/${task.id}`, { assignees: [ids.sofia] });
    assert.deepEqual((await taskOf('marta', web, task.id)).flags, []);
  });

  await t.test('soft delete: the roadmap disappears but IT still sees it and its log', async () => {
    const tmp = await mkRoadmap('marta', { title: 'Temp roadmap', memberIds: [ids.lena] });
    await mkTask('marta', tmp, { title: 'Temp task' });
    assert.equal((await c.lena.del(`/api/roadmaps/${tmp}`)).status, 403);
    assert.equal((await c.marta.del(`/api/roadmaps/${tmp}`)).status, 200);
    assert.equal((await c.marta.get(`/api/roadmaps/${tmp}`)).status, 404);
    assert.equal((await c.ingrid.get(`/api/roadmaps/${tmp}`)).status, 404);
    const o = await c.ingrid.get('/api/admin/overview');
    assert.ok(o.body.deleted.some((r) => r.id === tmp));
    const log = await c.ingrid.get(`/api/roadmaps/${tmp}/log`);
    assert.equal(log.status, 200);
    assert.ok(log.body.entries.some((e) => e.text === 'deleted the roadmap "Temp roadmap"'));
    assert.equal((await c.marta.get(`/api/roadmaps/${tmp}/log`)).status, 404, 'the owner loses the log with the roadmap');
    const d = srv.db();
    assert.equal(d.prepare('SELECT COUNT(*) AS c FROM tasks WHERE roadmap_id = ?').get(tmp).c, 1, 'tasks are kept');
    d.close();
  });

  await t.test('input is validated and capped', async () => {
    const r = await mkTask('marta', solo, { title: 'T'.repeat(500), description: 'D'.repeat(5000), tags: Array.from({ length: 20 }, (_, i) => 'tag' + i + 'x'.repeat(40)) });
    const task = await taskOf('marta', solo, r.body.task.id);
    assert.equal(task.title.length, 120);
    assert.equal(task.description.length, 2000);
    assert.equal(task.tags.length, 6);
    assert.ok(task.tags.every((x) => x.length <= 24));
    assert.equal((await mkTask('marta', solo, { title: '   ' })).status, 400);
    assert.equal((await mkTask('marta', solo, { title: { $gt: '' } })).status, 400);
    assert.equal((await c.marta.get('/api/roadmaps/1abc')).status, 404);
    assert.equal((await c.marta.get("/api/roadmaps/1 OR 1=1")).status, 404);
  });
});
