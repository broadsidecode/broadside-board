'use strict';

// Board CLI and Worker helper tests. No network: requests are shaped and inspected, never sent.
//   node --test tests/board-cli.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { parseArgs, listQuery, planWrite, main } = require('../cli/board');
const { authHeaders, buildRequest, call } = require('../cli/client');

test('parseArgs reads command, positionals and flags', () => {
  const a = parseArgs(['list', '--board', 'test-diner', '--status', 'review', '--json']);
  assert.equal(a.cmd, 'list');
  assert.deepEqual(a.flags, { board: 'test-diner', status: 'review', json: true });
  const p = parseArgs(['patch', 'TDN-5', '--file', 'p.json', '--if-version', '4']);
  assert.deepEqual(p.positional, ['TDN-5']);
  assert.equal(p.flags['if-version'], 4);
});

test('parseArgs rejects unknown flags, missing values and bad versions', () => {
  assert.throws(() => parseArgs(['list', '--nope']), /unknown flag/);
  assert.throws(() => parseArgs(['list', '--board']), /needs a value/);
  assert.throws(() => parseArgs(['list', '--board', '--status', 'x']), /needs a value/);
  assert.throws(() => parseArgs(['patch', 'TDN-5', '--if-version', 'two']), /positive integer/);
  assert.throws(() => parseArgs(['patch', 'TDN-5', '--if-version', '0']), /positive integer/);
});

test('listQuery builds the filter query string', () => {
  assert.equal(listQuery({}), '/tasks');
  assert.equal(listQuery({ board: 'main', status: 'doing', json: true }), '/tasks?board=main&status=doing');
});

test('planWrite: patch needs an existing card and --if-version', () => {
  const existing = { id: 't-20261022-tdn-5-about-page', version: 5 };
  assert.deepEqual(planWrite('patch', 'TDN-5', { 'if-version': 5 }, { note: 'x' }, existing), {
    method: 'PATCH', path: '/tasks/t-20261022-tdn-5-about-page', body: { data: { note: 'x' }, ifVersion: 5 },
  });
  assert.throws(() => planWrite('patch', 'TDN-5', {}, { note: 'x' }, existing), /--if-version/);
  assert.throws(() => planWrite('patch', 'TDN-5', { 'if-version': 1 }, {}, null), /no card/);
  assert.throws(() => planWrite('patch', 'tdn5', { 'if-version': 1 }, {}, existing), /ticket key/);
});

test('planWrite: set on a new key derives an id and stamps the key', () => {
  const plan = planWrite('set', 'TDN-12', {}, { title: 'Hours page tweak', board: 'test-diner' }, null, new Date('2026-10-23T10:00:00Z'));
  assert.equal(plan.method, 'PUT');
  assert.equal(plan.path, '/tasks/t-20261023-hours-page-tweak');
  assert.equal(plan.body.data.key, 'TDN-12');
  assert.equal(plan.body.ifVersion, undefined);
  const withId = planWrite('set', 'TDN-12', { id: 't-custom' }, { title: 'x' }, null);
  assert.equal(withId.path, '/tasks/t-custom');
});

test('planWrite: set on an existing card requires its version', () => {
  const existing = { id: 't-a', version: 3 };
  assert.throws(() => planWrite('set', 'TDN-1', {}, { title: 'x' }, existing), /exists at version 3/);
  const plan = planWrite('set', 'TDN-1', { 'if-version': 3 }, { title: 'x' }, existing);
  assert.deepEqual(plan.body, { data: { title: 'x', key: 'TDN-1' }, ifVersion: 3 });
});

test('buildRequest shapes URL, method, JSON body and manual redirects', () => {
  const r = buildRequest('POST', '/counters/TDN/next', undefined, { BOARD_URL: 'https://board.example/' });
  assert.equal(r.url, 'https://board.example/api/v1/counters/TDN/next');
  assert.equal(r.init.method, 'POST');
  assert.equal(r.init.body, undefined);
  assert.equal(r.init.redirect, 'manual');
  const p = buildRequest('PATCH', '/tasks/t-a', { data: { note: 'n' }, ifVersion: 2 }, {});
  assert.equal(p.url, 'http://127.0.0.1:8787/api/v1/tasks/t-a');
  assert.equal(p.init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(p.init.body), { data: { note: 'n' }, ifVersion: 2 });
});

test('authHeaders prefers environment, then assertion, then the Vault names', () => {
  assert.deepEqual(authHeaders({ BOARD_ACCESS_CLIENT_ID: 'id', BOARD_ACCESS_CLIENT_SECRET: 's' }),
    { 'CF-Access-Client-Id': 'id', 'CF-Access-Client-Secret': 's' });
  assert.deepEqual(authHeaders({ BOARD_ASSERTION: 'jwt' }), { 'Cf-Access-Jwt-Assertion': 'jwt' });
  assert.deepEqual(authHeaders({ BOARD_TOKEN: 'tok' }), { authorization: 'Bearer tok' });
  assert.throws(() => authHeaders({}), /BOARD_TOKEN/);
});

test('call sends auth headers on every call, health included, and reports an Access redirect', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return { status: url.endsWith('/health') ? 200 : 302, text: async () => '{"ok":true}' }; };
  const env = { BOARD_ACCESS_CLIENT_ID: 'id', BOARD_ACCESS_CLIENT_SECRET: 's' };
  const h = await call('GET', '/health', undefined, { env, fetchImpl });
  assert.equal(h.status, 200);
  assert.equal(seen[0].init.headers['CF-Access-Client-Id'], 'id');
  const r = await call('GET', '/tasks', undefined, { env, fetchImpl });
  assert.equal(seen[1].init.headers['CF-Access-Client-Id'], 'id');
  assert.match(r.data.error, /redirected/);
});

test('main prints usage for an unknown command', async () => {
  const code = await main(['bogus']);
  assert.equal(code, 2);
});

// Worker helpers (ES module) used by both the API and MCP.
test('lib: merge, validation and MCP guards', async () => {
  const lib = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'lib.js')).href);
  const merged = lib.mergeCard({ a: 1, brief: { x: 1, y: 2 }, tags: [1, 2], gone: 1 }, { brief: { y: 3 }, tags: [9], gone: { __delete__: true } });
  assert.deepEqual(merged, { a: 1, brief: { x: 1, y: 3 }, tags: [9] });
  assert.equal(lib.validateCard({ title: 't', status: 'doing', kind: 'agent' }), null);
  assert.match(lib.validateCard({ status: 'todo' }), /title/);
  assert.match(lib.validateCard({ title: 't', status: 'started' }), /status/);
  assert.match(lib.validateCard({ title: 't', kind: 'bot' }), /kind/);
  assert.match(lib.mcpPatchProblem({ kind: 'agent' }, { kind: 'production' }), /production/);
  assert.match(lib.mcpPatchProblem({ kind: 'production' }, { kind: 'agent' }), /keeps its kind/);
  assert.match(lib.mcpPatchProblem({}, { gates: { ownerGo: true } }), /ownerGo/);
  assert.equal(lib.mcpPatchProblem({}, { gates: { reviewer: 'PASS' }, note: 'n' }), null);
  assert.equal(lib.principalFromClaims({ email: 'owner@example.com' }, { 'owner@example.com': 'owner' }), 'owner');
  assert.equal(lib.principalFromClaims({ common_name: 'abc.access' }, {}, { 'abc.access': 'agent' }), 'agent');
  assert.equal(lib.principalFromClaims({ common_name: 'zzz.access' }, {}, {}), 'service:zzz.access');
  assert.equal(lib.isWaiting({ status: 'approval' }), true);
  assert.equal(lib.isWaiting({ status: 'done', needsOwner: true }), false);
});
