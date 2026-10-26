'use strict';

// Owner password and token sign in (worker/src/kitauth.js) through the real handleApi, on a real SQLite
// database behind a D1 stand-in.
//   node --import ./tests/setup.mjs --test tests/kit-auth.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const src = (f) => pathToFileURL(path.join(__dirname, '..', 'worker', 'src', f)).href;
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'worker', 'schema.sql'), 'utf8');
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const hmac = (k, t) => crypto.createHmac('sha256', k).update(t).digest('hex');

function d1() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const exec = (sql, args) => {
    const st = db.prepare(sql);
    const reads = /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
    return reads ? { results: st.all(...args) } : { results: [], meta: { changes: Number(st.run(...args).changes) } };
  };
  const stmt = (sql) => {
    let args = [];
    const s = {
      sql,
      get args() { return args; },
      bind(...a) { args = a.map((v) => (v === undefined ? null : v)); return s; },
      async first() { return exec(sql, args).results[0] || null; },
      async all() { return exec(sql, args); },
      async run() { return exec(sql, args); },
    };
    return s;
  };
  return {
    raw: db,
    prepare: stmt,
    async batch(list) {
      db.exec('BEGIN');
      try { const out = list.map((s) => exec(s.sql, s.args)); db.exec('COMMIT'); return out; } catch (err) { db.exec('ROLLBACK'); throw err; }
    },
  };
}

const PASSWORD = 'correct-horse-battery-staple';
const SIGNING = 'test-signing-key';
const BASE = 'https://board.example.com/api/v1';

async function setup() {
  const api = await import(src('api.js'));
  const store = await import(src('store.js'));
  const db = d1();
  const env = { DB: db, AUTH_MODE: 'owner-password', OWNER_SECRET_HASH: sha(PASSWORD), OAUTH_TOKEN_SIGNING_KEY: SIGNING };
  const call = async (method, p, { headers = {}, body } = {}) => {
    const req = new Request(`${BASE}${p}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let res;
    try { res = await api.handleApi(req, env, new URL(req.url)); } catch (err) { return { status: err.status || 500, body: { error: err.message }, headers: new Headers() }; }
    const text = await res.text();
    let j; try { j = JSON.parse(text); } catch { j = { text }; }
    return { status: res.status, body: j, headers: res.headers };
  };
  const owner = { authorization: `Bearer ${PASSWORD}` };
  const login = async (ip) => call('POST', '/login', { body: { password: PASSWORD }, headers: ip ? { 'cf-connecting-ip': ip } : {} });
  const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];
  return { db, env, store, call, owner, login, cookieOf };
}

test('health is open and config is public without email or secrets', async () => {
  const { call } = await setup();
  const h = await call('GET', '/health');
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);
  const c = await call('GET', '/config');
  assert.equal(c.status, 200);
  const text = JSON.stringify(c.body);
  assert.ok(!/@/.test(text), 'no email address in the public config');
  assert.ok(!text.includes(sha(PASSWORD)) && !text.includes(SIGNING));
  assert.ok(c.body.owner && c.body.agent && Array.isArray(c.body.lanes));
});

test('no credentials gives 401', async () => {
  const { call } = await setup();
  assert.equal((await call('GET', '/whoami')).status, 401);
  assert.equal((await call('GET', '/boards')).status, 401);
});

test('login refuses a wrong password and sets a hardened cookie for the right one', async () => {
  const { call, login } = await setup();
  const bad = await call('POST', '/login', { body: { password: 'nope' } });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);
  const ok = await login();
  assert.equal(ok.status, 200);
  assert.equal(ok.body.principal, 'owner');
  const sc = ok.headers.get('set-cookie');
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(sc.includes(part), `cookie carries ${part}`);
});

test('the login cookie authenticates whoami as owner', async () => {
  const { call, login, cookieOf } = await setup();
  const cookie = cookieOf(await login());
  const w = await call('GET', '/whoami', { headers: { cookie } });
  assert.equal(w.status, 200);
  assert.equal(w.body.principal, 'owner');
  assert.equal(w.body.isAdmin, true);
});

test('a forged or expired cookie is rejected', async () => {
  const { call, login, cookieOf } = await setup();
  const good = cookieOf(await login());
  const forged = good.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
  assert.equal((await call('GET', '/whoami', { headers: { cookie: forged } })).status, 401);
  const exp = Math.floor(Date.now() / 1000) - 100;
  const expired = `board_session=owner.${exp}.${hmac(SIGNING, `session|owner|${exp}`)}`;
  assert.equal((await call('GET', '/whoami', { headers: { cookie: expired } })).status, 401);
  const live = Math.floor(Date.now() / 1000) + 1000;
  const wrongKey = `board_session=owner.${live}.${hmac('other-key', `session|owner|${live}`)}`;
  assert.equal((await call('GET', '/whoami', { headers: { cookie: wrongKey } })).status, 401);
  const right = `board_session=owner.${live}.${hmac(SIGNING, `session|owner|${live}`)}`;
  assert.equal((await call('GET', '/whoami', { headers: { cookie: right } })).status, 200);
});

test('a cookie write from a cross site origin is refused, same origin passes', async () => {
  const { call, login, cookieOf } = await setup();
  const cookie = cookieOf(await login());
  const body = { principal: 'agent' };
  const cross = await call('POST', '/tokens', { headers: { cookie, origin: 'https://evil.example.org' }, body });
  assert.equal(cross.status, 403);
  const same = await call('POST', '/tokens', { headers: { cookie, origin: 'https://board.example.com' }, body });
  assert.equal(same.status, 200);
  const noOrigin = await call('POST', '/tokens', { headers: { cookie }, body });
  assert.equal(noOrigin.status, 200);
  const read = await call('GET', '/whoami', { headers: { cookie, origin: 'https://evil.example.org' } });
  assert.equal(read.status, 200);
});

test('the owner secret works as a bearer token', async () => {
  const { call, owner } = await setup();
  const w = await call('GET', '/whoami', { headers: owner });
  assert.equal(w.status, 200);
  assert.equal(w.body.principal, 'owner');
  assert.equal((await call('GET', '/whoami', { headers: { authorization: `bearer ${PASSWORD}` } })).status, 200);
});

test('the owner mints an agent token that authenticates as agent and is stored only as a hash', async () => {
  const { call, owner, db } = await setup();
  const minted = await call('POST', '/tokens', { headers: owner, body: { principal: 'agent', note: 'for tests' } });
  assert.equal(minted.status, 200);
  const token = minted.body.token;
  assert.match(token, /^bk_[0-9a-f]{64}$/);
  assert.equal(minted.body.principal, 'agent');
  assert.equal(minted.body.clientId, `tok_${sha(token)}`);
  const rows = db.raw.prepare('SELECT * FROM board_principals').all();
  assert.equal(rows.length, 1);
  assert.match(rows[0].client_id, /^tok_[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(rows).includes(token), 'the plain token is not stored');
  const w = await call('GET', '/whoami', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(w.status, 200);
  assert.equal(w.body.principal, 'agent');
  assert.equal(w.body.isAdmin, false);
});

test('minting refuses a bad principal and a scoped worker with no board', async () => {
  const { call, owner } = await setup();
  assert.equal((await call('POST', '/tokens', { headers: owner, body: { principal: 'stranger' } })).status, 400);
  assert.equal((await call('POST', '/tokens', { headers: owner, body: { principal: 'owner' } })).status, 400);
  assert.equal((await call('POST', '/tokens', { headers: owner, body: { principal: 'cloud-worker' } })).status, 400);
  const bound = await call('POST', '/tokens', { headers: owner, body: { principal: 'cloud-worker', board: 'main' } });
  assert.equal(bound.status, 200);
  const w = await call('GET', '/whoami', { headers: { authorization: `Bearer ${bound.body.token}` } });
  assert.equal(w.body.principal, 'cloud-worker');
  assert.equal(w.body.scope, 'main');
});

test('a scoped worker token with no board is refused at sign in', async () => {
  const { call, db, store } = await setup();
  const token = 'bk_unbound_token_for_test';
  await store.putPrincipal(db, 'owner', `tok_${sha(token)}`, { principal: 'cloud-worker', board: '' });
  const w = await call('GET', '/whoami', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(w.status, 403);
});

test('a non owner cannot mint tokens', async () => {
  const { call, owner } = await setup();
  const minted = await call('POST', '/tokens', { headers: owner, body: { principal: 'agent' } });
  const res = await call('POST', '/tokens', { headers: { authorization: `Bearer ${minted.body.token}` }, body: { principal: 'agent' } });
  assert.equal(res.status, 403);
});

test('an unknown bearer is 401', async () => {
  const { call } = await setup();
  const res = await call('GET', '/whoami', { headers: { authorization: 'Bearer not-a-real-token' } });
  assert.equal(res.status, 401);
});

test('ten wrong passwords from one address then 429, another address is unaffected', async () => {
  const { call, login } = await setup();
  const ip = '203.0.113.7';
  for (let i = 0; i < 10; i++) {
    const r = await call('POST', '/login', { body: { password: `wrong${i}` }, headers: { 'cf-connecting-ip': ip } });
    assert.equal(r.status, 401);
  }
  const blocked = await call('POST', '/login', { body: { password: 'wrong-again' }, headers: { 'cf-connecting-ip': ip } });
  assert.equal(blocked.status, 429);
  const stillBlocked = await login(ip);
  assert.equal(stillBlocked.status, 429, 'even the right password waits out the throttle');
  const other = await login('203.0.113.8');
  assert.equal(other.status, 200);
});
