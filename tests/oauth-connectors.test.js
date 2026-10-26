'use strict';

// OAuth registration and token tests for ChatGPT and Grok connectors, with an in-memory D1 stand-in.
//   node --test tests/oauth-connectors.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const oauthUrl = pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'oauth.js')).href;

function fakeDb() {
  const clients = new Map();
  const codes = new Map();
  const tokens = new Map();
  const stmt = (sql) => {
    let args = [];
    const api = {
      bind(...a) { args = a; return api; },
      async run() {
        if (/INSERT INTO board_oauth_clients/.test(sql)) clients.set(args[0], args[1]);
        else if (/INSERT INTO board_oauth_codes/.test(sql)) codes.set(args[0], { data: args[1], expires: args[2], used: 0 });
        else if (/INSERT INTO board_oauth_tokens/.test(sql)) tokens.set(args[0], { data: args[2] });
        return {};
      },
      async first() {
        if (/FROM board_oauth_clients/.test(sql)) return clients.has(args[0]) ? { data: clients.get(args[0]) } : null;
        return null;
      },
      async all() {
        const c = codes.get(args[0]);
        if (c && !c.used && c.expires > args[1]) { c.used = 1; return { results: [{ data: c.data }] }; }
        return { results: [] };
      },
    };
    return api;
  };
  return { prepare: stmt, batch: async (list) => { for (const s of list) await s.run(); return []; } };
}

const sha = (v) => crypto.createHash('sha256').update(v).digest('base64url');

async function setup() {
  const { createOAuth } = await import(oauthUrl);
  return createOAuth({
    DB: fakeDb(),
    MCP_ISSUER: 'https://board-mcp.example',
    OAUTH_TOKEN_SIGNING_KEY: 'k'.repeat(32),
    OAUTH_BOOTSTRAP_CODE_HASH: crypto.createHash('sha256').update('boot').digest('hex'),
  });
}

const CHATGPT = 'https://chatgpt.com/connector_platform_oauth_redirect';

test('metadata advertises confidential methods and keeps PKCE', async () => {
  const o = await setup();
  const m = o.metadata();
  assert.deepEqual(m.token_endpoint_auth_methods_supported, ['none', 'client_secret_post', 'client_secret_basic']);
  assert.deepEqual(m.code_challenge_methods_supported, ['S256']);
});

test('ChatGPT and Grok redirects register; unknown redirect is refused', async () => {
  const o = await setup();
  for (const uri of [CHATGPT, 'https://platform.openai.com/apps-manage/oauth/callback', 'https://chatgpt.com/connector/oauth/abc_123', 'https://grok.com/connectors-oauth-exchange-code/', 'https://claude.ai/api/mcp/auth_callback']) {
    const r = await o.register({ client_name: 'x', redirect_uris: [uri] });
    assert.equal(r.status, 201, uri);
    assert.equal(r.body.token_endpoint_auth_method, 'none');
    assert.equal(r.body.client_secret, undefined);
  }
  for (const uri of ['https://evil.example/cb', 'https://chatgpt.com.evil.example/connector/oauth/a', 'https://chatgpt.com/connector/oauth/a/b']) {
    assert.equal((await o.register({ redirect_uris: [uri] })).status, 400, uri);
  }
  assert.equal((await o.register({ redirect_uris: [CHATGPT], token_endpoint_auth_method: 'private_key_jwt' })).status, 400);
});

async function authorizedCode(o, client, verifier) {
  const r = await o.authorize({
    response_type: 'code', client_id: client.client_id, redirect_uri: CHATGPT,
    code_challenge: sha(verifier), code_challenge_method: 'S256', bootstrap_code: 'boot', principal: 'agent',
  });
  assert.equal(r.status, 302);
  return new URL(r.redirect).searchParams.get('code');
}

test('confidential client: secret issued once, wrong secret refused, right secret exchanges', async () => {
  const o = await setup();
  const reg = await o.register({ redirect_uris: [CHATGPT], token_endpoint_auth_method: 'client_secret_post' });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.token_endpoint_auth_method, 'client_secret_post');
  assert.match(reg.body.client_secret, /^secret_/);
  const verifier = 'v'.repeat(50);
  const base = { grant_type: 'authorization_code', client_id: reg.body.client_id, redirect_uri: CHATGPT, code_verifier: verifier };

  const bad = await o.token({ ...base, code: await authorizedCode(o, reg.body, verifier), client_secret: 'secret_wrong' });
  assert.equal(bad.status, 401);
  const none = await o.token({ ...base, code: await authorizedCode(o, reg.body, verifier) });
  assert.equal(none.status, 401);
  const badPkce = await o.token({ ...base, code_verifier: 'w'.repeat(50), code: await authorizedCode(o, reg.body, verifier), client_secret: reg.body.client_secret });
  assert.equal(badPkce.status, 400);
  const ok = await o.token({ ...base, code: await authorizedCode(o, reg.body, verifier), client_secret: reg.body.client_secret });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.principal, 'agent');
});

test('public client still exchanges without a secret', async () => {
  const o = await setup();
  const reg = await o.register({ redirect_uris: [CHATGPT] });
  const verifier = 'p'.repeat(50);
  const ok = await o.token({ grant_type: 'authorization_code', client_id: reg.body.client_id, redirect_uri: CHATGPT, code_verifier: verifier, code: await authorizedCode(o, reg.body, verifier) });
  assert.equal(ok.status, 200);
});

test('built in desktop client id (Codex) is accepted on a loopback callback only', async () => {
  const o = await setup();
  const verifier = 'd'.repeat(50);
  const loop = 'http://localhost:51234/callback';
  const base = { response_type: 'code', client_id: 'codex-desktop-client', code_challenge: sha(verifier), code_challenge_method: 'S256', bootstrap_code: 'boot', principal: 'agent' };
  const bad = await o.authorize({ ...base, redirect_uri: CHATGPT });
  assert.equal(bad.status, 400);
  const good = await o.authorize({ ...base, redirect_uri: loop });
  assert.equal(good.status, 302);
  const code = new URL(good.redirect).searchParams.get('code');
  const ok = await o.token({ grant_type: 'authorization_code', client_id: 'codex-desktop-client', redirect_uri: loop, code_verifier: verifier, code });
  assert.equal(ok.status, 200);
});
