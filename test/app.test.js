'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { Store, weekStart } = require('../lib/store');
const { createApp } = require('../server');

async function setup() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-')), 'db.json');
  const store = new Store(file);
  store.seed({ admins: ['boss@x.com'], departments: { finance: ['fin@x.com'], retail: ['ret@x.com'] } });
  const server = createApp({ store, baseUrl: 'http://t' });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, data, sid) => {
    const r = await fetch(base + url, { method, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(sid ? { Cookie: `sid=${sid}` } : {}) }, body: data ? JSON.stringify(data) : undefined });
    return { status: r.status, body: await r.json(), cookie: r.headers.get('set-cookie') };
  };
  const login = async (email) => {
    const { body } = await call('POST', '/api/login', { email });
    const token = new URL(body.devLink).searchParams.get('token');
    const v = await call('POST', '/api/verify', { token });
    return { sid: /sid=([^;]+)/.exec(v.cookie)[1], token };
  };
  return { call, login, close: () => server.close() };
}

test('only listed emails get a link; links are single-use', async () => {
  const t = await setup();
  const stranger = await t.call('POST', '/api/login', { email: 'nobody@x.com' });
  assert.equal(stranger.status, 200);
  assert.equal(stranger.body.devLink, undefined);
  const { token } = await t.login('fin@x.com');
  assert.equal((await t.call('POST', '/api/verify', { token })).status, 401);
  assert.equal((await t.call('GET', '/api/me')).status, 401);
  t.close();
});

test('members are confined to their own department', async () => {
  const t = await setup();
  const fin = await t.login('fin@x.com'), ret = await t.login('ret@x.com');
  const week = weekStart();
  // member asking for another dept is silently pinned to own
  const add = await t.call('POST', '/api/items', { dept: 'retail', week, category: 'pending', text: 'Close books' }, fin.sid);
  assert.equal(add.body.dept, 'finance');
  assert.equal((await t.call('GET', `/api/report?dept=finance&week=${week}`, null, ret.sid)).body.items.length, 0);
  assert.equal((await t.call('PATCH', `/api/items/${add.body.id}`, { done: true }, ret.sid)).status, 404);
  assert.equal((await t.call('GET', '/api/overview', null, fin.sid)).status, 403);
  assert.equal((await t.call('GET', '/api/users', null, fin.sid)).status, 403);
  t.close();
});

test('admin sees overview and rollover moves done work to completed', async () => {
  const t = await setup();
  const fin = await t.login('fin@x.com'), boss = await t.login('boss@x.com');
  const week = weekStart();
  const a = await t.call('POST', '/api/items', { week, category: 'pending', text: 'Done thing' }, fin.sid);
  await t.call('POST', '/api/items', { week, category: 'pending', text: 'Open thing' }, fin.sid);
  await t.call('POST', '/api/items', { week, category: 'bottleneck', text: 'Blocked' }, fin.sid);
  await t.call('PATCH', `/api/items/${a.body.id}`, { done: true }, fin.sid);
  const o = await t.call('GET', `/api/overview?week=${week}`, null, boss.sid);
  const f = o.body.departments.find((d) => d.id === 'finance');
  assert.deepEqual([f.pending, f.pendingDone, f.openBottlenecks], [2, 1, 1]);
  const r = await t.call('POST', '/api/rollover', { week }, fin.sid);
  assert.equal(r.body.added, 3);
  assert.equal((await t.call('POST', '/api/rollover', { week }, fin.sid)).body.added, 0); // idempotent
  const next = (await t.call('GET', `/api/report?week=${r.body.week}`, null, fin.sid)).body.items;
  assert.deepEqual(next.map((i) => `${i.category}:${i.text}`).sort(), ['bottleneck:Blocked', 'completed:Done thing', 'pending:Open thing']);
  t.close();
});

test('mutations require JSON content type (CSRF guard)', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-')), 'db.json');
  const store = new Store(file);
  store.seed({ admins: ['boss@x.com'] });
  const server = createApp({ store, baseUrl: 'http://t' });
  await new Promise((r) => server.listen(0, r));
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/login`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"email":"boss@x.com"}' });
  assert.equal(r.status, 415);
  server.close();
});
