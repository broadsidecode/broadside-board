'use strict';

// Board Pulse: the call log, the four read panels, the stuck rules, the claims checker and the endpoint scope
// checks, against a real SQLite database (node:sqlite behind a small D1 stand-in) and the real schema. No network:
// the claims checker gets a mocked fetch.
//   node --test tests/board-pulse.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { /* older Node: the tests below skip */ }
const src = (f) => pathToFileURL(path.join(__dirname, '..', 'worker', 'src', f)).href;
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'worker', 'schema.sql'), 'utf8');
// The line tables Pulse reads when the start webhook shares the database (the standalone kit has none of them).
const LINE_DDL = `
CREATE TABLE line_messages (id TEXT PRIMARY KEY, project TEXT NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, fired_at TEXT, fire_error TEXT, relay TEXT, claimed_at TEXT, run TEXT, answered_at TEXT, reply TEXT);
CREATE TABLE line_deliveries (message_id TEXT PRIMARY KEY, channel TEXT NOT NULL, session TEXT NOT NULL, event_id TEXT, delivered_at TEXT NOT NULL, stamped TEXT NOT NULL);
CREATE TABLE line_projects (id TEXT PRIMARY KEY, channel TEXT NOT NULL DEFAULT '');
CREATE TABLE line_oauth_tokens (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
`;

function d1({ line = true } = {}) {
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(SCHEMA);
  if (line) db.exec(LINE_DDL);
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
  return { raw: db, prepare: stmt, async batch(list) { return list.map((s) => exec(s.sql, s.args)); } };
}

const ENV = {
  SERVICE_PRINCIPALS: JSON.stringify({ 'jarv.access': 'worker', 'scar.access': 'agent', 'cloudtd.access': 'cloud-worker@acme-plumbing', 'idle.access': 'agent3' }),
  EMAIL_PRINCIPALS: JSON.stringify({ 'owner@example.com': 'owner' }),
  GITHUB_MERGE_TOKEN: 'test-token',
  API_HOST: 'board.example.test',
};
const as = (cn) => ({ common_name: cn });
const OWNER = { email: 'owner@example.com' };
const MIN = 60000;
const HOUR = 3600000;
const iso = (ms) => new Date(ms).toISOString();

async function setup(opts = {}) {
  const db = d1(opts);
  const env = { ...ENV, DB: db, ...(opts.env || {}) };
  const pulse = await import(src('pulse.js'));
  const mcp = await import(src('mcp.js'));
  const api = await import(src('api.js'));
  const store = await import(src('store.js'));
  db.raw.prepare('INSERT INTO board_boards (id, data, version, updated_at) VALUES (?, ?, 1, ?)').run('main', JSON.stringify({ name: 'main', prefix: 'KIT', order: 1 }), 'x');
  db.raw.prepare('INSERT INTO board_counters (id, next, version) VALUES (?, 10, 1)').run('KIT');
  const rpc = (principal, name, args) => mcp.handleRpc(env, principal, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const call = async (claims, p) => {
    const req = new Request(`https://board.example.test/api/v1${p}`, { method: 'GET' });
    try {
      const res = await api.handleApi(req, env, new URL(req.url), claims);
      return { status: res.status, body: await res.json() };
    } catch (err) { return { status: err.status || 500, body: { error: err.message } }; }
  };
  const putCard = (id, data, status = data.status) => db.raw.prepare('INSERT INTO board_tasks (id, board, key, status, kind, lane, data, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)')
    .run(id, data.board || 'main', data.key || id, status, data.kind || 'agent', data.lane || '', JSON.stringify(data), 'x');
  const callRow = (r) => db.raw.prepare('INSERT INTO board_mcp_calls (worker, principal, tool, target, started_at, duration_ms, outcome, error, claim_status, claim_detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(r.worker || 'board', r.principal, r.tool || 'get_card', r.target || '', r.at, r.ms || 5, r.outcome || 'ok', r.error || '', r.claim || null, r.detail || '');
  const rows = () => db.raw.prepare('SELECT * FROM board_mcp_calls ORDER BY id').all();
  return { db, env, pulse, mcp, store, rpc, call, putCard, callRow, rows };
}

// A fetch stand-in: the table maps a URL to [status, body]; anything else is a 599.
function fetchFor(table, seen = []) {
  return async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method || 'GET', auth: init.headers && init.headers.authorization });
    const hit = table[String(url)];
    if (hit === 'throw') throw new Error('network down');
    const [status, body] = hit || [599, {}];
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

const T = { skip: !sqlite && 'node:sqlite missing' };

test('every tools/call logs one row with who, tool, target, outcome and the error', T, async () => {
  const { rpc, rows } = await setup();
  await rpc('agent', 'list_boards', {});
  await rpc('agent', 'get_card', { key: 'NOPE-1' });
  await rpc('agent', 'not_a_tool', {});
  const r = rows();
  assert.equal(r.length, 3);
  assert.deepEqual(r.map((x) => [x.worker, x.principal, x.tool, x.outcome]), [
    ['board', 'agent', 'list_boards', 'ok'], ['board', 'agent', 'get_card', 'error'], ['board', 'agent', 'not_a_tool', 'error'],
  ]);
  assert.equal(r[1].target, 'NOPE-1');
  assert.ok(r[1].error.length > 0);
  assert.equal(r[2].error, 'unknown tool');
  assert.ok(Number.isInteger(r[0].duration_ms) && r[0].duration_ms >= 0);
  assert.ok(!Number.isNaN(Date.parse(r[0].started_at)));
  assert.equal(r[0].claim_status, null);
  assert.equal(r[0].claim_detail, '', 'a tool that carries no words keeps no words');
});

test('a comment keeps its words in the row until the claims checker reads them', T, async () => {
  const { rpc, rows, putCard } = await setup();
  putCard('t1', { key: 'TASK-1', board: 'main', title: 'Card', status: 'doing', kind: 'agent', history: [], comments: [] });
  await rpc('agent', 'add_comment', { key: 'TASK-1', text: 'Merged https://github.com/acme/site/pull/1' });
  await rpc('agent', 'add_comment', { key: 'TASK-9', text: 'No such card https://github.com/acme/site/pull/9' });
  const r = rows();
  assert.deepEqual([r[0].tool, r[0].outcome, r[0].claim_detail], ['add_comment', 'ok', 'Merged https://github.com/acme/site/pull/1']);
  assert.deepEqual([r[1].outcome, r[1].claim_detail], ['error', ''], 'a refused comment carries no claim');
});

test('a broken or missing log never breaks the call it describes', T, async () => {
  const { pulse, mcp, env } = await setup();
  await pulse.logCall({}, { principal: 'x', tool: 'y', outcome: 'ok' });
  await pulse.logCall({ DB: { prepare() { throw new Error('boom'); } } }, { principal: 'x', tool: 'y', outcome: 'ok' });
  const out = await mcp.handleRpc({ ...env, DB: { prepare() { throw new Error('boom'); } } }, 'agent', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'how_it_works', arguments: {} } }).catch((e) => e);
  assert.ok(out instanceof Error || out.status === 200, 'the call itself is not the log');
  assert.equal(pulse.callTarget({ key: 'A-1', id: 'x' }), 'A-1');
  assert.equal(pulse.callTarget({ project: 'p1' }), 'p1');
  assert.equal(pulse.callTarget({ n: 1 }), '');
  assert.equal(pulse.callTarget(null), '');
});

test('retention: the scheduled run deletes calls older than thirty days and keeps the rest', T, async () => {
  const { pulse, env, callRow, rows } = await setup();
  const now = Date.now();
  callRow({ principal: 'old', at: iso(now - 31 * 24 * HOUR) });
  callRow({ principal: 'edge', at: iso(now - 29 * 24 * HOUR) });
  callRow({ principal: 'new', at: iso(now - MIN) });
  const out = await pulse.runPulseCron(env, { nowMs: now, fetchImpl: fetchFor({}) });
  assert.equal(out.deleted, 1);
  assert.deepEqual(rows().map((r) => r.principal), ['edge', 'new']);
});

test('connections: one row per principal, dot by last call, calls in the last hour, token expiry', T, async () => {
  const { pulse, env, callRow, db } = await setup();
  const now = Date.now();
  callRow({ principal: 'agent', at: iso(now - 2 * MIN) });
  callRow({ principal: 'agent', at: iso(now - 30 * MIN), outcome: 'error', error: 'x' });
  callRow({ principal: 'agent', at: iso(now - 3 * HOUR) });
  callRow({ principal: 'agent3', at: iso(now - 25 * MIN), worker: 'line' });
  callRow({ principal: 'owner', at: iso(now - 5 * HOUR) });
  db.raw.prepare('INSERT INTO board_oauth_tokens (hash, kind, data, expires_at, revoked) VALUES (?, ?, ?, ?, 0)').run('h1', 'refresh', JSON.stringify({ principal: 'agent' }), now + 20 * 24 * HOUR);
  db.raw.prepare('INSERT INTO board_oauth_tokens (hash, kind, data, expires_at, revoked) VALUES (?, ?, ?, ?, 0)').run('h2', 'access', JSON.stringify({ principal: 'agent' }), now + 40 * MIN);
  db.raw.prepare('INSERT INTO line_oauth_tokens (hash, kind, data, expires_at, revoked) VALUES (?, ?, ?, ?, 0)').run('h3', 'refresh', JSON.stringify({ principal: 'agent2' }), now + 10 * 24 * HOUR);
  db.raw.prepare('INSERT INTO board_oauth_tokens (hash, kind, data, expires_at, revoked) VALUES (?, ?, ?, ?, 1)').run('h4', 'refresh', JSON.stringify({ principal: 'revoked-one' }), now + 10 * 24 * HOUR);
  db.raw.prepare('INSERT INTO board_principals (client_id, principal, board, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)').run('a'.repeat(32) + '.access', 'cloud-worker', 'harbor', '', 'x', 'worker');
  const { connections } = await pulse.pulseConnections(env, now);
  const by = Object.fromEntries(connections.map((c) => [c.principal, c]));
  assert.equal(by.agent.dot, 'green');
  assert.equal(by.agent.callsLastHour, 2);
  assert.equal(by.agent.errorsLastHour, 1);
  assert.equal(by.agent.tokenExpires, iso(now + 20 * 24 * HOUR));
  assert.equal(by.agent.accessExpires, iso(now + 40 * MIN));
  assert.equal(by.agent3.dot, 'amber');
  assert.deepEqual(by.agent3.via, ['line']);
  assert.equal(by.owner.dot, 'grey');
  assert.equal(by.agent2.dot, 'grey');
  assert.equal(by.agent2.tokenExpires, iso(now + 10 * 24 * HOUR));
  assert.ok(by['cloud-worker@harbor'], 'a bound token shows with its board');
  assert.ok(by['cloud-worker@acme-plumbing'] && by.worker, 'mapped service principals show even before their first call');
  assert.equal(by['revoked-one'], undefined, 'a revoked sign in is not a connection');
  assert.deepEqual(connections.slice(0, 2).map((c) => c.dot), ['green', 'amber'], 'live first');
});

test('stream: newest first, since cursor, principal filter, 200 rows at most', T, async () => {
  const { pulse, env, callRow } = await setup();
  const now = Date.now();
  for (let i = 0; i < 230; i++) callRow({ principal: i % 2 ? 'a' : 'b', at: iso(now - (230 - i) * 1000), target: `K-${i}` });
  const first = await pulse.pulseStream(env, {});
  assert.equal(first.calls.length, 200);
  assert.equal(first.calls[0].id, 230);
  assert.equal(first.cursor, 230);
  assert.ok(first.calls[0].id > first.calls[1].id);
  const none = await pulse.pulseStream(env, { since: first.cursor });
  assert.deepEqual([none.calls.length, none.cursor], [0, 230]);
  callRow({ principal: 'a', at: iso(now), tool: 'add_comment' });
  const more = await pulse.pulseStream(env, { since: 230 });
  assert.deepEqual(more.calls.map((c) => c.tool), ['add_comment']);
  const onlyB = await pulse.pulseStream(env, { principal: 'b' });
  assert.ok(onlyB.calls.length > 0 && onlyB.calls.every((c) => c.principal === 'b'));
  assert.deepEqual(Object.keys(first.calls[0]).sort(), ['at', 'claim', 'error', 'id', 'ms', 'outcome', 'principal', 'target', 'tool', 'worker']);
});

test('stuck: each of the five rules fires past its threshold and not before', T, async () => {
  const { pulse, env, db, putCard } = await setup();
  const now = Date.now();
  const msg = (id, project, state, created, extra = {}) => db.raw.prepare('INSERT INTO line_messages (id, project, sender, text, state, created_at, claimed_at, fire_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, project, 'agent', `text of ${id}`, state, created, extra.claimed || null, extra.fireError || null);
  db.raw.prepare('INSERT INTO line_projects (id, channel) VALUES (?, ?)').run('worker', 'chan_abc123');
  // Rule 1: claimed and no reply for 20 minutes.
  msg('m_claim_old', 'worker', 'working', iso(now - HOUR), { claimed: iso(now - 25 * MIN) });
  msg('m_claim_new', 'worker', 'working', iso(now - HOUR), { claimed: iso(now - 15 * MIN) });
  msg('m_answered', 'worker', 'answered', iso(now - HOUR), { claimed: iso(now - 50 * MIN) });
  // Rule 3: delivered to a coordinator with no session bound.
  msg('m_nosess', 'worker', 'delivered', iso(now - 10 * MIN));
  msg('m_sess', 'worker', 'delivered', iso(now - 10 * MIN));
  db.raw.prepare('INSERT INTO line_deliveries (message_id, channel, session, delivered_at, stamped) VALUES (?, ?, ?, ?, ?)').run('m_nosess', 'c', '', iso(now - 3 * MIN), '');
  db.raw.prepare('INSERT INTO line_deliveries (message_id, channel, session, delivered_at, stamped) VALUES (?, ?, ?, ?, ?)').run('m_sess', 'c', 'cse_1', iso(now - 3 * MIN), '');
  // Rule 4: fired and never picked up for 5 minutes.
  msg('m_unpicked', 'worker', 'sent', iso(now - 6 * MIN), { fireError: 'HTTP 401' });
  msg('m_fresh', 'worker', 'sent', iso(now - 2 * MIN));
  // Rule 2: a card in progress with no comment or change for two hours.
  putCard('c_silent', { key: 'TASK-1', board: 'main', title: 'Silent', status: 'doing', kind: 'agent', owner: 'lane1', updated: iso(now - 3 * HOUR), history: [{ at: iso(now - 3 * HOUR), by: 'x', what: 'y' }] });
  putCard('c_recent', { key: 'TASK-2', board: 'main', title: 'Recent change', status: 'doing', kind: 'agent', updated: iso(now - HOUR), history: [] });
  putCard('c_commented', { key: 'TASK-3', board: 'main', title: 'Commented', status: 'doing', kind: 'agent', updated: iso(now - 5 * HOUR), comments: [{ at: iso(now - 20 * MIN), by: 'x', text: 'on it' }], history: [] });
  putCard('c_human', { key: 'TASK-4', board: 'main', title: 'Owner own', status: 'doing', kind: 'human', updated: iso(now - 9 * HOUR), history: [] });
  putCard('c_todo', { key: 'TASK-5', board: 'main', title: 'Not started', status: 'todo', kind: 'agent', updated: iso(now - 9 * HOUR), history: [] });
  // Rule 5: an ask waiting on a person for a day.
  putCard('c_ask_old', { key: 'TASK-6', board: 'main', title: 'Old ask', status: 'review', kind: 'agent', updated: iso(now), ask: { kind: 'decide', text: 'Which hours?', to: 'owner', at: iso(now - 25 * HOUR) }, history: [] });
  putCard('c_ask_new', { key: 'TASK-7', board: 'main', title: 'New ask', status: 'review', kind: 'agent', updated: iso(now), ask: { kind: 'decide', text: 'Which hours?', to: 'owner', at: iso(now - 2 * HOUR) }, history: [] });
  putCard('c_ask_done', { key: 'TASK-8', board: 'main', title: 'Done card', status: 'done', kind: 'agent', updated: iso(now), ask: { kind: 'decide', text: 'x', to: 'owner', at: iso(now - 48 * HOUR) }, history: [] });

  const { stuck } = await pulse.pulseStuck(env, now);
  const hit = Object.fromEntries(stuck.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(hit).sort(), ['c_ask_old', 'c_silent', 'm_claim_old', 'm_nosess', 'm_unpicked']);
  assert.equal(hit.m_claim_old.rule, 'claimed_no_reply');
  assert.equal(hit.m_claim_old.owner, 'worker');
  assert.equal(hit.m_claim_old.minutes, 25);
  assert.equal(hit.m_claim_old.link, 'https://claude.ai/code/project/chan_abc123');
  assert.equal(hit.m_nosess.rule, 'no_session');
  assert.equal(hit.m_unpicked.rule, 'not_picked_up');
  assert.match(hit.m_unpicked.text, /HTTP 401/);
  assert.equal(hit.c_silent.rule, 'card_silent');
  assert.equal(hit.c_silent.key, 'TASK-1');
  assert.equal(hit.c_silent.owner, 'lane1');
  assert.equal(hit.c_silent.minutes, 180);
  assert.equal(hit.c_silent.age, '3 h 0 min');
  assert.equal(hit.c_ask_old.rule, 'ask_waiting');
  assert.equal(hit.c_ask_old.owner, 'owner');
  assert.equal(hit.c_ask_old.age, '25 h 0 min');
  assert.deepEqual(stuck.map((r) => r.minutes), [...stuck.map((r) => r.minutes)].sort((a, b) => b - a), 'oldest first');
});

test('stuck: no line tables (the standalone kit) still answers for cards', T, async () => {
  const { pulse, env, putCard } = await setup({ line: false });
  const now = Date.now();
  putCard('c1', { key: 'TASK-1', board: 'main', title: 'Silent', status: 'doing', kind: 'agent', updated: iso(now - 4 * HOUR), history: [] });
  const { stuck } = await pulse.pulseStuck(env, now);
  assert.deepEqual(stuck.map((r) => r.rule), ['card_silent']);
  const conns = await pulse.pulseConnections(env, now);
  assert.ok(conns.connections.length > 0);
});

test('evidence: pull requests, commits, runs, Pages and other links are found; other GitHub links and private hosts are not', T, async () => {
  const { pulse } = await setup();
  const text = [
    'Done. PR https://github.com/acme/site/pull/12, commit https://github.com/acme/site/commit/abcdef1234567.',
    'Checks: https://github.com/acme/site/actions/runs/998877/job/1. Live: https://abc.site.pages.dev/.',
    'Also https://example.com/status, https://github.com/acme/site/blob/main/README.md and http://insecure.test/x,',
    'https://board.example.test/#TASK-1, https://127.0.0.1/x, https://user:pw@example.com/y.',
  ].join(' ');
  const ev = pulse.extractEvidence(text, { skipHosts: ['board.example.test'] });
  assert.deepEqual(ev.map((e) => e.kind), ['pr', 'commit', 'run', 'pages', 'url']);
  assert.deepEqual([ev[0].owner, ev[0].repo, ev[0].number], ['acme', 'site', 12]);
  assert.equal(ev[3].url, 'https://abc.site.pages.dev/');
  for (const h of ['svc.internal', 'printer.local', 'app.localhost', 'metadata.google.internal', 'localhost', 'a.b.internal']) {
    assert.equal(pulse.extractEvidence(`see https://${h}/x`).length, 0, `${h} is never fetched`);
  }
  assert.equal(pulse.extractEvidence('see https://internal.example.com/x https://localnews.example.org/').length, 2, 'only the suffix is blocked');
  assert.equal(pulse.extractEvidence('nothing here').length, 0);
  const many = pulse.extractEvidence(Array.from({ length: 9 }, (_, i) => `https://e${i}.example.com`).join(' '));
  assert.equal(many.length, 5, 'at most five a text');
});

test('verdicts: merged, open, closed, missing, green, red, running, live, dead, no token', T, async () => {
  const { pulse, env } = await setup();
  const pr = (n) => ({ kind: 'pr', owner: 'acme', repo: 'site', number: n, url: `https://github.com/acme/site/pull/${n}` });
  const table = {
    'https://api.github.com/repos/acme/site/pulls/1': [200, { merged: true, state: 'closed' }],
    'https://api.github.com/repos/acme/site/pulls/2': [200, { merged: false, state: 'open' }],
    'https://api.github.com/repos/acme/site/pulls/3': [200, { merged: false, state: 'closed' }],
    'https://api.github.com/repos/acme/site/pulls/4': [404, {}],
    'https://api.github.com/repos/acme/site/pulls/5': [403, {}],
    'https://api.github.com/repos/acme/site/commits/abc1234': [200, {}],
    'https://api.github.com/repos/acme/site/actions/runs/7': [200, { status: 'completed', conclusion: 'success' }],
    'https://api.github.com/repos/acme/site/actions/runs/8': [200, { status: 'completed', conclusion: 'failure' }],
    'https://api.github.com/repos/acme/site/actions/runs/9': [200, { status: 'in_progress', conclusion: null }],
    'https://live.pages.dev/': [200, {}],
    'https://gone.pages.dev/': [404, {}],
    'https://broken.pages.dev/': [503, {}],
    'https://down.example.com/': 'throw',
    'https://gated.example.com/': [403, {}],
  };
  const seen = [];
  const f = fetchFor(table, seen);
  const v = async (ev, e = env) => pulse.checkEvidence(ev, e, f);
  assert.deepEqual((await v(pr(1))).verdict, true);
  assert.match((await v(pr(1))).detail, /pull request 1 merged/);
  const open = await v(pr(2));
  const redirects = [];
  const manual = await pulse.checkEvidence({ kind: 'pages', url: 'https://moved.pages.dev/' }, env, async (url, init) => { redirects.push(init.redirect); return { ok: false, status: 302, json: async () => ({}) }; });
  assert.deepEqual([manual.verdict, redirects], [true, ['manual']], 'a redirect answers and is not followed');
  assert.deepEqual([open.verdict, open.detail], [false, 'pull request 2 not merged (open)']);
  assert.equal((await v(pr(3))).detail, 'pull request 3 not merged (closed)');
  assert.equal((await v(pr(4))).verdict, false);
  assert.equal((await v(pr(5))).verdict, null, 'an unreadable pull request is not a lie');
  assert.equal((await v({ kind: 'commit', owner: 'acme', repo: 'site', sha: 'abc1234', url: 'x' })).verdict, true);
  const run = (n) => ({ kind: 'run', owner: 'acme', repo: 'site', run: String(n), url: 'x' });
  assert.equal((await v(run(7))).verdict, true);
  assert.deepEqual([(await v(run(8))).verdict, (await v(run(8))).detail], [false, 'run 8 ended failure']);
  const going = await v(run(9));
  assert.deepEqual([going.verdict, going.pending], [null, true]);
  assert.equal((await v({ kind: 'pages', url: 'https://live.pages.dev/' })).verdict, true);
  assert.equal((await v({ kind: 'pages', url: 'https://gone.pages.dev/' })).verdict, false);
  assert.equal((await v({ kind: 'pages', url: 'https://broken.pages.dev/' })).verdict, false);
  if (pulse.CLAIM_ANY_URL) {
    assert.equal((await v({ kind: 'url', url: 'https://down.example.com/' })).verdict, false);
    assert.equal((await v({ kind: 'url', url: 'https://gated.example.com/' })).verdict, true, 'an address that answers, even refusing, is up');
  } else {
    assert.equal((await v({ kind: 'url', url: 'https://gated.example.com/' })).verdict, null, 'the standalone kit checks GitHub and Pages only');
  }
  const noToken = await v(pr(1), { ...env, GITHUB_MERGE_TOKEN: '' });
  assert.deepEqual([noToken.verdict, noToken.detail], [null, 'no GitHub read token on the Worker']);
  assert.ok(seen.filter((s) => s.url.startsWith('https://api.github.com')).every((s) => s.auth === 'Bearer test-token'));
  assert.ok(seen.filter((s) => !s.url.startsWith('https://api.github.com')).every((s) => !s.auth), 'the token goes to GitHub only');
});

test('summary: one false cited thing makes the claim false; all true holds; nothing checkable is not checkable', T, async () => {
  const { pulse } = await setup();
  assert.equal(pulse.summarize([]).status, 'no_evidence');
  const t = { verdict: true, detail: 'pull request 1 merged' };
  const f = { verdict: false, detail: 'pull request 2 not merged (open)' };
  const n = { verdict: null, detail: 'no GitHub read token on the Worker' };
  assert.equal(pulse.summarize([t, t]).status, 'checked_true');
  const mixed = pulse.summarize([t, f]);
  assert.equal(mixed.status, 'checked_false');
  assert.match(mixed.detail, /pull request 2 not merged \(open\)/);
  assert.equal(pulse.summarize([t, n]).status, 'checked_true');
  assert.equal(pulse.summarize([n]).status, 'not_checkable');
  assert.ok(!/\n/.test(mixed.detail) && mixed.detail.length <= 240);
});

test('claims checker: a comment and a reply that cite an unmerged pull request are marked false; the rest hold or have nothing to check', T, async () => {
  const { pulse, env, db, rpc, putCard, callRow, rows } = await setup();
  putCard('t1', { key: 'TASK-1', board: 'main', title: 'Card', status: 'doing', kind: 'agent', history: [], comments: [] });
  const now = Date.now();
  // A real add_comment through the tool path, so the row and the stored comment line up the way production does.
  const w1 = await rpc('agent', 'add_comment', { key: 'TASK-1', text: 'Shipped, see https://github.com/acme/site/pull/2 and https://live.pages.dev/.' });
  assert.ok(!w1.json.result.isError, JSON.stringify(w1.json));
  const w2 = await rpc('agent', 'add_comment', { key: 'TASK-1', text: 'Merged https://github.com/acme/site/pull/1 and green https://github.com/acme/site/actions/runs/7' });
  assert.ok(!w2.json.result.isError, JSON.stringify(w2.json));
  const w3 = await rpc('agent', 'add_comment', { key: 'TASK-1', text: 'Working on it, no links.' });
  assert.ok(!w3.json.result.isError, JSON.stringify(w3.json));
  // A project reply over the line's project API: the Worker logs api.reply with the message id.
  callRow({ worker: 'line', principal: 'worker', tool: 'api.reply', target: 'm1', at: iso(now), detail: 'All done: https://gone.pages.dev/ is live' });
  callRow({ worker: 'line', principal: 'worker', tool: 'api.reply', target: 'm2', at: iso(now), detail: '' });
  callRow({ worker: 'board', principal: 'agent', tool: 'list_boards', at: iso(now) });

  const table = {
    'https://api.github.com/repos/acme/site/pulls/1': [200, { merged: true }],
    'https://api.github.com/repos/acme/site/pulls/2': [200, { merged: false, state: 'open' }],
    'https://api.github.com/repos/acme/site/actions/runs/7': [200, { status: 'completed', conclusion: 'success' }],
    'https://live.pages.dev/': [200, {}],
    'https://gone.pages.dev/': [404, {}],
  };
  const seen = [];
  const out = await pulse.checkClaims(env, { fetchImpl: fetchFor(table, seen), nowMs: now });
  assert.equal(out.written, 5);
  const by = (tool, n) => rows().filter((r) => r.tool === tool)[n];
  const c1 = by('add_comment', 0); const c2 = by('add_comment', 1); const c3 = by('add_comment', 2);
  assert.equal(c1.claim_status, 'checked_false');
  assert.match(c1.claim_detail, /pull request 2 not merged \(open\)/);
  assert.equal(c2.claim_status, 'checked_true');
  assert.equal(c3.claim_status, 'no_evidence');
  assert.equal(by('api.reply', 0).claim_status, 'checked_false');
  assert.match(by('api.reply', 0).claim_detail, /gone\.pages\.dev answered HTTP 404/);
  assert.equal(by('api.reply', 1).claim_status, 'no_evidence');
  assert.equal(by('list_boards', 0).claim_status, null, 'tools that carry no words are never checked');
  const fetched = seen.length;
  const again = await pulse.checkClaims(env, { fetchImpl: fetchFor(table, seen), nowMs: now });
  assert.deepEqual([again.looked, seen.length], [0, fetched], 'a verdict is written once');

  // No automatic comments: the card holds the three comments it was given and nothing from the checker.
  const card = JSON.parse(db.raw.prepare("SELECT data FROM board_tasks WHERE id = 't1'").get().data);
  assert.equal(card.comments.length, 3);

  const claims = await pulse.pulseClaims(env);
  assert.deepEqual(claims.claims.map((c) => c.verdict).sort(), ['checked_false', 'checked_false', 'checked_true']);
  assert.ok(claims.claims.every((c) => c.detail && c.principal && c.tool));
  const stream = await pulse.pulseStream(env, {});
  assert.ok(stream.calls.some((c) => c.claim === 'checked_false'));
});

test('claims checker: no GitHub token records not_checkable instead of failing; a running workflow is looked at again later', T, async () => {
  const { pulse, env, db, callRow, rows } = await setup({ env: { GITHUB_MERGE_TOKEN: '' } });
  const now = Date.now();
  callRow({ worker: 'line', principal: 'worker', tool: 'api.reply', target: 'm1', at: iso(now), detail: 'Merged https://github.com/acme/site/pull/1' });
  const out = await pulse.checkClaims(env, { fetchImpl: fetchFor({}), nowMs: now });
  assert.equal(out.written, 1);
  assert.deepEqual([rows()[0].claim_status, rows()[0].claim_detail], ['not_checkable', 'no GitHub read token on the Worker']);

  const second = await setup();
  second.callRow({ worker: 'line', principal: 'worker', tool: 'api.reply', target: 'm2', at: iso(now), detail: 'Checks https://github.com/acme/site/actions/runs/9' });
  const t = { 'https://api.github.com/repos/acme/site/actions/runs/9': [200, { status: 'in_progress' }] };
  const wait = await second.pulse.checkClaims(second.env, { fetchImpl: fetchFor(t), nowMs: now });
  assert.equal(wait.written, 0);
  assert.equal(second.rows()[0].claim_status, null, 'still running: tried again on the next pass');
  const later = await second.pulse.checkClaims(second.env, { fetchImpl: fetchFor(t), nowMs: now + 31 * MIN });
  assert.equal(later.written, 1);
  assert.equal(second.rows()[0].claim_status, 'not_checkable');
});

test('claims checker limits: at most 40 fetches a pass, the rest wait for the next pass', T, async () => {
  const { pulse, env, callRow, rows } = await setup();
  const now = Date.now();
  for (let i = 0; i < 12; i++) {
    callRow({ worker: 'line', principal: 'p', tool: 'api.reply', target: `m${i}`, at: iso(now), detail: Array.from({ length: 5 }, (_, k) => `https://h${i}x${k}.pages.dev/`).join(' ') });
  }
  const seen = [];
  const out = await pulse.checkClaims(env, { fetchImpl: fetchFor({}, seen), nowMs: now });
  assert.ok(seen.length <= 40, `fetched ${seen.length}`);
  assert.ok(out.written < 12 && rows().some((r) => r.claim_status === null), 'the rest wait for the next pass');
  assert.equal(typeof pulse.CLAIM_ANY_URL, 'boolean');
});

test('endpoints: admins read all four panels; connectors, bound tokens and unknown tokens are refused', T, async () => {
  const { call, putCard } = await setup();
  putCard('c1', { key: 'TASK-1', board: 'main', title: 'x', status: 'todo', kind: 'agent', history: [] });
  for (const p of ['connections', 'stream', 'stuck', 'claims']) {
    for (const claims of [as('jarv.access'), OWNER]) {
      const r = await call(claims, `/pulse/${p}`);
      assert.equal(r.status, 200, `${p} for an admin`);
    }
    assert.equal((await call(as('scar.access'), `/pulse/${p}`)).status, 403, `${p} is not for a connector`);
    assert.equal((await call(as('cloudtd.access'), `/pulse/${p}`)).status, 403, `${p} is not for a bound token`);
    assert.equal((await call(as('idle.access'), `/pulse/${p}`)).status, 403);
    assert.equal((await call(as('nobody.access'), `/pulse/${p}`)).status, 403);
  }
  assert.ok(Array.isArray((await call(OWNER, '/pulse/connections')).body.connections));
  assert.ok(Array.isArray((await call(OWNER, '/pulse/stream?since=0&principal=x')).body.calls));
  assert.ok(Array.isArray((await call(OWNER, '/pulse/stuck')).body.stuck));
  assert.ok(Array.isArray((await call(OWNER, '/pulse/claims')).body.claims));
  assert.equal((await call(OWNER, '/pulse/other')).status, 404);
});
