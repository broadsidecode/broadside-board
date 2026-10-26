'use strict';

// The Worker entry (worker/src/index.js) routing on one host and on two hosts, with owner password sign in.
//   node --import ./tests/setup.mjs --test tests/kit-index.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const src = (f) => pathToFileURL(path.join(__dirname, '..', 'worker', 'src', f)).href;
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'worker', 'schema.sql'), 'utf8');
const HANDBOOK = fs.readFileSync(path.join(__dirname, '..', 'handbook', 'HANDBOOK.md'), 'utf8');
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const PASSWORD = 'index-test-password';

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

async function setup(extra = {}) {
  const worker = (await import(src('index.js'))).default;
  const env = {
    API_HOST: 'board.example.com',
    MCP_HOST: 'board.example.com',
    MCP_ISSUER: 'https://board.example.com',
    DB: d1(),
    AUTH_MODE: 'owner-password',
    OWNER_SECRET_HASH: sha(PASSWORD),
    OAUTH_TOKEN_SIGNING_KEY: 'index-test-signing-key',
    ASSETS: { fetch: async () => new Response('<html>board page</html>', { status: 200, headers: { 'content-type': 'text/html' } }) },
    ...extra,
  };
  const go = async (url, init = {}) => {
    const res = await worker.fetch(new Request(url, init), env);
    return { status: res.status, headers: res.headers, text: await res.text() };
  };
  return { env, go };
}
const OWNER = { authorization: `Bearer ${PASSWORD}` };

test('mcp without a token is 401 with a challenge header', async () => {
  const { go } = await setup();
  const r = await go('https://board.example.com/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
  assert.equal(r.status, 401);
  const challenge = r.headers.get('www-authenticate');
  assert.match(challenge, /^Bearer /);
  assert.ok(challenge.includes('https://board.example.com/.well-known/oauth-protected-resource/mcp'));
});

test('oauth metadata and the api health answer on the single host', async () => {
  const { go } = await setup();
  const meta = await go('https://board.example.com/.well-known/oauth-authorization-server');
  assert.equal(meta.status, 200);
  assert.ok(JSON.parse(meta.text).issuer);
  const health = await go('https://board.example.com/api/v1/health');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.text).ok, true);
});

test('handbook needs credentials and returns markdown for the owner', async () => {
  const { go } = await setup();
  const denied = await go('https://board.example.com/handbook');
  assert.equal(denied.status, 401);
  const ok = await go('https://board.example.com/handbook', { headers: OWNER });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /text\/markdown/);
  assert.equal(ok.text, HANDBOOK);
});

test('llms.txt is gated and carries the handbook then the live snapshot', async () => {
  const { go } = await setup();
  assert.equal((await go('https://board.example.com/llms.txt')).status, 401);
  const ok = await go('https://board.example.com/llms.txt', { headers: OWNER });
  assert.equal(ok.status, 200);
  assert.ok(ok.text.startsWith(HANDBOOK.trimEnd()));
  assert.ok(ok.text.includes('LIVE SNAPSHOT'));
  assert.ok(ok.text.indexOf('LIVE SNAPSHOT') > HANDBOOK.trimEnd().length);
});

test('the root path is served from the assets binding', async () => {
  const { go } = await setup();
  const root = await go('https://board.example.com/');
  assert.equal(root.status, 200);
  assert.equal(root.text, '<html>board page</html>');
  const index = await go('https://board.example.com/index.html');
  assert.equal(index.text, '<html>board page</html>');
});

test('without an assets binding the root answers a small service document', async () => {
  const { go } = await setup({ ASSETS: undefined });
  const root = await go('https://board.example.com/');
  assert.equal(root.status, 200);
  assert.equal(JSON.parse(root.text).service, 'board-kit');
});

test('unknown paths are 404 on the single host', async () => {
  const { go } = await setup();
  assert.equal((await go('https://board.example.com/nothing-here')).status, 404);
});

test('with a separate mcp host the api host does not serve mcp and the mcp host does not serve the api', async () => {
  const { go } = await setup({ MCP_HOST: 'board-mcp.example.com', MCP_ISSUER: 'https://board-mcp.example.com' });
  const apiMcp = await go('https://board.example.com/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(apiMcp.status, 404);
  const apiMeta = await go('https://board.example.com/.well-known/oauth-authorization-server');
  assert.equal(apiMeta.status, 404);
  const mcpHost = await go('https://board-mcp.example.com/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(mcpHost.status, 401);
  const mcpMeta = await go('https://board-mcp.example.com/.well-known/oauth-authorization-server');
  assert.equal(mcpMeta.status, 200);
  const mcpApi = await go('https://board-mcp.example.com/api/v1/whoami', { headers: OWNER });
  assert.equal(mcpApi.status, 404);
  const apiHealth = await go('https://board.example.com/api/v1/health');
  assert.equal(apiHealth.status, 200);
});
