const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, buildWorld } = require('./helpers');

test('archived roadmaps are read-only in every server path', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const { c, ids } = await buildWorld(srv);

  const rid = (await c.marta.post('/api/roadmaps', {
    title: 'Newsletter relaunch', memberIds: [ids.lena, ids.sofia], creatorMode: 'everyone',
  })).body.roadmap.id;
  const task = (await c.marta.post(`/api/roadmaps/${rid}/tasks`, { title: 'Pick the email tool', assignees: [ids.lena, ids.marta] })).body.task.id;
  const lenaTask = (await c.lena.post(`/api/roadmaps/${rid}/tasks`, { title: 'Lena own', assignees: [ids.lena] })).body.task.id;
  const comment = (await c.lena.post(`/api/tasks/${task}/comments`, { text: 'Went with the cheaper one.' })).body.comment.id;
  await c.lena.patch(`/api/tasks/${task}`, { status: 'in_progress' });

  await t.test('only the owner or IT can archive', async () => {
    assert.equal((await c.lena.post(`/api/roadmaps/${rid}/archive`)).status, 403);
    assert.equal((await c.omar.post(`/api/roadmaps/${rid}/archive`)).status, 404, 'not on it at all');
    assert.equal((await c.marta.post(`/api/roadmaps/${rid}/archive`)).status, 200);
    assert.equal((await c.marta.post(`/api/roadmaps/${rid}/archive`)).status, 400, 'already archived');
  });

  await t.test('every write is refused while archived', async () => {
    const tries = {
      'create task (owner)': c.marta.post(`/api/roadmaps/${rid}/tasks`, { title: 'New' }),
      'create task (member)': c.lena.post(`/api/roadmaps/${rid}/tasks`, { title: 'New' }),
      'edit task': c.lena.patch(`/api/tasks/${task}`, { title: 'Edited' }),
      'move forward': c.lena.patch(`/api/tasks/${task}`, { status: 'finished' }),
      'owner move back': c.marta.patch(`/api/tasks/${task}`, { status: 'planned' }),
      assign: c.marta.patch(`/api/tasks/${task}`, { assignees: [ids.sofia] }),
      'delete task (owner)': c.marta.del(`/api/tasks/${task}`),
      'delete task (creator)': c.lena.del(`/api/tasks/${lenaTask}`),
      comment: c.lena.post(`/api/tasks/${task}/comments`, { text: 'hi' }),
      'comment as IT': c.ingrid.post(`/api/tasks/${task}/comments`, { text: 'hi' }),
      'delete own comment': c.lena.del(`/api/comments/${comment}`),
      'delete comment as IT': c.ingrid.del(`/api/comments/${comment}`),
      settings: c.marta.put(`/api/roadmaps/${rid}`, { title: 'Renamed', memberIds: [] }),
      'delete roadmap': c.marta.del(`/api/roadmaps/${rid}`),
    };
    for (const [name, p] of Object.entries(tries)) {
      const r = await p;
      assert.ok(r.status === 409 || r.status === 403, `${name}: ${r.status} ${r.text}`);
    }
    const b = (await c.marta.get(`/api/roadmaps/${rid}`)).body;
    assert.equal(b.roadmap.title, 'Newsletter relaunch');
    assert.deepEqual(b.tasks.map((x) => [x.title, x.status]), [['Pick the email tool', 'in_progress'], ['Lena own', 'planned']]);
    assert.equal(b.tasks[0].commentCount, 1);
    assert.deepEqual(b.roadmap.can, { view: true, owner: true, manage: false, archive: true, seeLog: true, create: false });
    assert.ok(b.tasks.every((x) => !x.can.edit && !x.can.assign && !x.can.delete && Object.values(x.can.moves).every((m) => !m.ok)));
    // reads still work
    assert.equal((await c.lena.get(`/api/tasks/${task}/comments`)).body.comments[0].canDelete, false);
  });

  await t.test('deactivation and transfer leave archived tasks alone, ownership still moves', async () => {
    assert.equal((await c.marta.post(`/api/users/${ids.lena}/deactivate`)).status, 200);
    let b = (await c.marta.get(`/api/roadmaps/${rid}`)).body;
    assert.ok(b.tasks.find((x) => x.id === task).assignees.includes(ids.lena), 'archived task keeps its assignee');
    assert.deepEqual(b.tasks.find((x) => x.id === task).flags, []);
    const tr = await c.ingrid.post(`/api/users/${ids.marta}/transfer`, { toId: ids.omar });
    assert.equal(tr.status, 200);
    b = (await c.omar.get(`/api/roadmaps/${rid}`)).body;
    assert.equal(b.roadmap.managerId, ids.omar, 'archived roadmap changed owner');
    assert.ok(b.tasks.find((x) => x.id === task).assignees.includes(ids.marta), 'but its tasks stay frozen');
  });

  await t.test('IT can unarchive, then writes work again', async () => {
    assert.equal((await c.ingrid.post(`/api/roadmaps/${rid}/unarchive`)).status, 200);
    assert.equal((await c.omar.post(`/api/roadmaps/${rid}/tasks`, { title: 'After unarchive' })).status, 201);
    const logs = (await c.ingrid.get(`/api/roadmaps/${rid}/log`)).body.entries.map((e) => e.text);
    assert.ok(logs.includes('archived the roadmap "Newsletter relaunch"'));
    assert.ok(logs.includes('unarchived the roadmap "Newsletter relaunch"'));
  });
});
