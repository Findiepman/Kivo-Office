const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, buildWorld, allLogText } = require('./helpers');

test('comments: who may delete which', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const { c, ids } = await buildWorld(srv);

  // Marta's roadmap; Omar (another manager) is a member on it.
  const rid = (await c.marta.post('/api/roadmaps', { title: 'Website', memberIds: [ids.lena, ids.tom, ids.omar] })).body.roadmap.id;
  const task = (await c.marta.post(`/api/roadmaps/${rid}/tasks`, { title: 'Homepage copy', assignees: [ids.lena] })).body.task.id;
  const say = async (who, text) => {
    const r = await c[who].post(`/api/tasks/${task}/comments`, { text });
    assert.equal(r.status, 201, r.text);
    return r.body.comment.id;
  };

  await t.test('anyone on the roadmap (and IT) can comment; others cannot', async () => {
    await say('tom', 'Tom is not assigned but can comment');
    await say('ingrid', 'IT can comment too');
    assert.equal((await c.ravi.post(`/api/tasks/${task}/comments`, { text: 'not on it' })).status, 404);
    assert.equal((await c.tom.post(`/api/tasks/${task}/comments`, { text: '   ' })).status, 400);
    const long = await say('tom', 'x'.repeat(3000));
    const list = (await c.tom.get(`/api/tasks/${task}/comments`)).body.comments;
    assert.equal(list.find((x) => x.id === long).text.length, 1000);
  });

  const matrix = [
    // [author, deleter, allowed, why]
    ['lena', 'lena', true, 'own comment'],
    ['lena', 'tom', false, "a member, someone else's comment"],
    ['lena', 'marta', true, 'the roadmap owner, any comment'],
    ['lena', 'omar', false, 'a manager who is only a member here'],
    ['lena', 'ingrid', true, 'IT, any comment'],
    ['marta', 'lena', false, "a member, the owner's comment"],
    ['ingrid', 'marta', true, "the owner, IT's comment"],
    ['omar', 'omar', true, 'own comment as a non-owner manager'],
    ['tom', 'ravi', false, 'not on the roadmap'],
  ];
  for (const [author, deleter, allowed, why] of matrix) {
    await t.test(`${deleter} deletes ${author}'s comment: ${allowed ? 'allowed' : 'refused'} (${why})`, async () => {
      const text = `secret note ${author}-${deleter}-${Math.random()}`;
      const id = await say(author, text);
      const seen = (await c[author].get(`/api/tasks/${task}/comments`)).body.comments.find((x) => x.id === id);
      assert.equal(seen.canDelete, true, 'the author sees a delete button');
      if (deleter !== 'ravi') {
        const flag = (await c[deleter].get(`/api/tasks/${task}/comments`)).body.comments.find((x) => x.id === id).canDelete;
        assert.equal(flag, allowed, 'canDelete flag matches the rule');
      }
      const r = await c[deleter].del(`/api/comments/${id}`);
      assert.equal(r.status, allowed ? 200 : deleter === 'ravi' ? 404 : 403);
      const still = (await c[author].get(`/api/tasks/${task}/comments`)).body.comments.some((x) => x.id === id);
      assert.equal(still, !allowed);
      const logs = allLogText(srv);
      assert.ok(!logs.includes(text), 'comment text never goes into the log');
      if (allowed) assert.ok(logs.includes(`comment on "Homepage copy"`));
    });
  }

  await t.test('the deletion log names the author, not the text', async () => {
    const d = srv.db();
    const rows = d.prepare("SELECT * FROM audit_log WHERE action = 'comment' AND text LIKE 'deleted %'").all();
    d.close();
    assert.ok(rows.some((r) => r.text === `deleted Lena Marsh's comment on "Homepage copy"` && r.actor_id === ids.marta && r.subject_id === ids.lena));
  });

  await t.test('deleting a task takes its comments with it, the log stays', async () => {
    await c.marta.del(`/api/tasks/${task}`);
    const d = srv.db();
    assert.equal(d.prepare('SELECT COUNT(*) AS c FROM comments WHERE task_id = ?').get(task).c, 0);
    assert.ok(d.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'comment'").get().c > 5);
    d.close();
  });
});
