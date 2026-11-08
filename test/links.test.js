const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startServer, buildWorld, login, pw, invite, useLink } = require('./helpers');

test('invite and reset links', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const { c, ids } = await buildWorld(srv);
  const info = (token) => srv.client().post('/api/links/info', { token }).then((r) => r.body);

  await t.test('a valid invite shows who it is for, signs the person in and works once', async () => {
    const r = await invite(c.marta, 'member', 'Priya Nair', 'priya', 'priya@example.com');
    assert.equal(r.kind, 'invite');
    assert.equal(r.emailed, null, 'no SMTP configured, nothing emailed');
    assert.equal(r.user.pending, true);
    assert.ok(r.expiresAt - Date.now() > 47.9 * 3600 * 1000 && r.expiresAt - Date.now() <= 48 * 3600 * 1000);
    const i = await info(r.token);
    assert.deepEqual([i.valid, i.kind, i.name, i.username], [true, 'invite', 'Priya Nair', 'priya']);
    // pending accounts can't sign in before the link is used
    assert.equal((await login(srv, 'priya', pw('priya'))).r.status, 401);
    const p = await useLink(srv, r.token, pw('priya'));
    assert.equal((await p.get('/api/auth/me')).body.user.username, 'priya');
    assert.deepEqual(await info(r.token), { valid: false, reason: 'used' });
    const again = await srv.client().post('/api/links/use', { token: r.token, password: pw('evil') });
    assert.equal(again.status, 400);
    assert.equal((await login(srv, 'priya', pw('priya'))).r.status, 200);
    assert.equal((await login(srv, 'priya', pw('evil'))).r.status, 401);
  });

  await t.test('an expired invite is refused', async () => {
    const r = await invite(c.omar, 'member', 'Dev Kapoor', 'dev');
    const d = srv.db();
    d.prepare('UPDATE links SET expires_at = ? WHERE token_hash = ?').run(Date.now() - 1, crypto.createHash('sha256').update(r.token).digest('hex'));
    d.close();
    assert.deepEqual(await info(r.token), { valid: false, reason: 'expired' });
    assert.equal((await srv.client().post('/api/links/use', { token: r.token, password: pw('dev') })).status, 400);
  });

  await t.test('a newer link replaces an older one', async () => {
    const first = await invite(c.omar, 'member', 'Ann Lee', 'ann');
    const second = await c.omar.post(`/api/users/${first.user.id}/link`);
    assert.equal(second.body.kind, 'invite', 'no password yet, so still an invite');
    assert.deepEqual(await info(first.token), { valid: false, reason: 'replaced' });
    assert.equal((await info(second.body.token)).valid, true);
    assert.equal((await srv.client().post('/api/links/use', { token: first.token, password: pw('ann') })).status, 400);
    await useLink(srv, second.body.token, pw('ann'));
  });

  await t.test('garbage and unknown tokens', async () => {
    assert.deepEqual(await info('x'), { valid: false, reason: 'unknown' });
    assert.deepEqual(await info(crypto.randomBytes(32).toString('base64url')), { valid: false, reason: 'unknown' });
    assert.deepEqual(await info({ $ne: 1 }), { valid: false, reason: 'unknown' });
  });

  await t.test('a reset link keeps the old password until used, then ends every session', async () => {
    const tomOld = c.tom; // signed in since the world was built
    const second = (await login(srv, 'tom')).c;
    const r = await c.marta.post(`/api/users/${ids.tom}/link`);
    assert.equal(r.status, 200);
    assert.equal(r.body.kind, 'reset');
    // nothing changes until the link is used
    assert.equal((await tomOld.get('/api/auth/me')).status, 200);
    assert.equal((await login(srv, 'tom')).r.status, 200);
    const i = await info(r.body.token);
    assert.equal(i.kind, 'reset');
    const fresh = await useLink(srv, r.body.token, 'brand-new-password-tom');
    assert.equal((await tomOld.get('/api/auth/me')).status, 401, 'old session ended');
    assert.equal((await second.get('/api/auth/me')).status, 401, 'other session ended');
    assert.equal((await fresh.get('/api/auth/me')).status, 200, 'the browser that used the link is signed in');
    assert.equal((await login(srv, 'tom')).r.status, 401, 'old password gone');
    assert.equal((await login(srv, 'tom', 'brand-new-password-tom')).r.status, 200);
    const pwlog = await c.ingrid.get('/api/admin/passwords');
    const kinds = pwlog.body.entries.filter((e) => e.userId === ids.tom).map((e) => e.kind);
    assert.deepEqual(kinds.slice(0, 2), ['reset_used', 'reset_issued']);
    const by = pwlog.body.entries.find((e) => e.userId === ids.tom && e.kind === 'reset_issued').byId;
    assert.equal(by, ids.marta);
  });

  await t.test('who may issue links', async () => {
    const r = (who, id) => c[who].post(`/api/users/${id}/link`).then((x) => x.status);
    assert.equal(await r('lena', ids.tom), 404, 'members cannot (and Tom is hidden from Lena here)');
    assert.equal(await r('lena', ids.lena), 403, 'not even for themselves');
    assert.equal(await r('omar', ids.tom), 404, "another manager's member is invisible to Omar, so it answers like a missing account");
    assert.equal(await r('omar', 99999), 404);
    assert.equal(await r('marta', ids.omar), 404, 'Omar is hidden from Marta until they share a roadmap');
    await c.marta.post('/api/roadmaps', { title: 'With Omar', memberIds: [ids.omar] });
    assert.equal(await r('marta', ids.omar), 403, 'a manager cannot for a manager');
    assert.equal(await r('marta', ids.marta), 403, 'nobody for themselves');
    assert.equal(await r('ingrid', ids.ingrid), 403);
    assert.equal(await r('marta', ids.lena), 200);
    assert.equal(await r('ingrid', ids.omar), 200, 'IT for anyone else');
    assert.equal(await r('ingrid', ids.dina), 200);
  });

  await t.test('a deactivated account cannot use its link', async () => {
    const r = await c.marta.post(`/api/users/${ids.sofia}/link`);
    assert.equal((await c.marta.post(`/api/users/${ids.sofia}/deactivate`)).status, 200);
    assert.deepEqual(await info(r.body.token), { valid: false, reason: 'deactivated' });
    assert.equal((await srv.client().post('/api/links/use', { token: r.body.token, password: pw('new-sofia') })).status, 400);
    assert.equal((await c.marta.post(`/api/users/${ids.sofia}/link`)).status, 403, 'no new link for a deactivated account');
  });

  await t.test('only a hash of each token is stored', async () => {
    const r = await invite(c.ingrid, 'manager', 'Kim Park', 'kim');
    const d = srv.db();
    const row = d.prepare('SELECT * FROM links WHERE user_id = ?').get(r.user.id);
    d.close();
    assert.equal(row.token_hash, crypto.createHash('sha256').update(r.token).digest('hex'));
    for (const f of fs.readdirSync(srv.dataDir).filter((x) => x.startsWith('kivo-office.db'))) {
      assert.equal(fs.readFileSync(path.join(srv.dataDir, f)).indexOf(r.token), -1, 'token found in ' + f);
    }
    assert.ok(!srv.output().includes(r.token), 'token not printed');
  });
});
