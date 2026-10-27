'use strict';

// The sync cron: the Sync button's rules on a timer as principal cron, with a rotation so every card is read over a few
// runs. Real SQLite behind a small D1 stand-in and the real schema; GitHub is a mocked fetch. Also ships in the public kit.
//   node --test tests/board-sync-cron.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { /* older Node: the tests below skip */ }
const src = (f) => pathToFileURL(path.join(__dirname, '..', 'worker', 'src', f)).href;
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'worker', 'schema.sql'), 'utf8');

function d1() {
  const db = new sqlite.DatabaseSync(':memory:');
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
  return { raw: db, prepare: stmt, async batch(list) { return list.map((s) => exec(s.sql, s.args)); } };
}

const PR = (n) => `https://github.com/example-org/sample-site/pull/${n}`;
const iso = (ms) => new Date(ms).toISOString();
const T = { skip: !sqlite && 'node:sqlite missing' };

async function setup() {
  const db = d1();
  const env = { DB: db, GITHUB_MERGE_TOKEN: 'test-token', BOARD_MODULES: JSON.stringify({ github: true, pulse: true }) };
  db.raw.prepare('INSERT INTO board_boards (id, data, version, updated_at) VALUES (?, ?, 1, ?)').run('main', JSON.stringify({ name: 'main', prefix: 'KIT', order: 1 }), 'x');
  const card = (id, data) => db.raw.prepare('INSERT INTO board_tasks (id, board, key, status, kind, lane, data, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)')
    .run(id, data.board || 'main', data.key || id, data.status || 'todo', data.kind || 'agent', data.lane || '', JSON.stringify({ board: 'main', kind: 'agent', status: 'todo', title: `Card ${data.key}`, history: [], ...data }), 'x');
  const get = (id) => JSON.parse(db.raw.prepare('SELECT data FROM board_tasks WHERE id = ?').get(id).data);
  return { db, env, card, get };
}

// GitHub stand-in: every pull request is open with no runs unless the table says otherwise.
function ghFetch({ merged = [], fail = [] } = {}) {
  const seen = [];
  const fn = async (url) => {
    seen.push(String(url));
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    const m = String(url).match(/\/pulls\/(\d+)$/);
    if (m) {
      const n = Number(m[1]);
      if (fail.includes(n)) return { ok: false, status: 404, json: async () => ({}) };
      return merged.includes(n)
        ? ok({ state: 'closed', merged: true, head: { sha: 'a'.repeat(40) }, merge_commit_sha: `${'b'.repeat(39)}${n % 10}` })
        : ok({ state: 'open', merged: false, head: { sha: 'c'.repeat(40) } });
    }
    if (/actions\/runs/.test(url)) return ok({ workflow_runs: [] });
    return ok(url.includes('/comments') || url.includes('/files') ? [] : {});
  };
  fn.seen = seen;
  return fn;
}

const rollback = { to: 'the page before', how: 'revert the merge', cannot: 'nothing' };

const stampOf = (db, id) => { const r = db.raw.prepare('SELECT value FROM board_cron_state WHERE name = ?').get(`synced:${id}`); return r ? r.value : ''; };
const logRows = (db) => db.raw.prepare('SELECT COUNT(*) AS n FROM board_history_log').get().n;
const verOf = (db, id) => db.raw.prepare('SELECT version FROM board_tasks WHERE id = ?').get(id).version;

test('cronOrder: open cards before done, least recently synced first, never synced first', T, async () => {
  const { cronOrder } = await import(src('sync.js'));
  const d = (id, status) => ({ id, data: { status, evidence: { pr: PR(1) } } });
  const stamps = new Map([['done-old', '2026-10-01T00:00:00Z'], ['new', '2026-10-26T10:00:00Z'], ['old', '2026-10-26T08:00:00Z']]);
  const order = cronOrder([d('done-old', 'done'), d('new', 'doing'), d('old', 'review'), d('never', 'todo'), { id: 'nopr', data: { status: 'todo' } }], stamps);
  assert.deepEqual(order.map((x) => x.id), ['never', 'old', 'new', 'done-old']);
});

test('runSyncCron: reads least recently synced first within the budget; the stamp lives in board_cron_state, never on the card', T, async () => {
  const { runSyncCron } = await import(src('sync.js'));
  const { env, db, card, get } = await setup();
  // Three open cards on PRs 1..3; max 2 per run. PR 3 was synced longest ago, PR 1 never: 1 and 3 go first.
  card('a', { key: 'TASK-1', status: 'review', evidence: { pr: PR(1), rollback } });
  card('b', { key: 'TASK-2', status: 'review', evidence: { pr: PR(2), rollback } });
  card('c', { key: 'TASK-3', status: 'review', evidence: { pr: PR(3), rollback } });
  db.raw.prepare('INSERT INTO board_cron_state (name, value) VALUES (?, ?)').run('synced:b', '2026-10-26T09:00:00.000Z');
  db.raw.prepare('INSERT INTO board_cron_state (name, value) VALUES (?, ?)').run('synced:c', '2026-10-26T07:00:00.000Z');
  const f = ghFetch();
  const r1 = await runSyncCron(env, { fetchImpl: f, max: 2 });
  assert.equal(r1.checked, 2);
  assert.equal(r1.skipped, 1);
  assert.ok(f.seen.some((u) => u.endsWith('/pulls/1')) && f.seen.some((u) => u.endsWith('/pulls/3')) && !f.seen.some((u) => u.endsWith('/pulls/2')));
  assert.ok(stampOf(db, 'a') > '2026-10-26T10:00:00.000Z', 'stamp written for a');
  assert.ok(stampOf(db, 'c') > '2026-10-26T10:00:00.000Z', 'stamp written for c');
  assert.equal(stampOf(db, 'b'), '2026-10-26T09:00:00.000Z', 'a card not read keeps its stamp');
  assert.equal(get('a').evidence.syncedAt, undefined, 'nothing is stamped on the card');
  assert.equal(get('a').history.length, 0);
  // Second run reads the one left over first.
  const f2 = ghFetch();
  await runSyncCron(env, { fetchImpl: f2, max: 1 });
  assert.ok(f2.seen.some((u) => u.endsWith('/pulls/2')), 'the card read longest ago is next');
});

test('runSyncCron: a read that changes nothing writes nothing to the card (version, history log unchanged)', T, async () => {
  const { runSyncCron } = await import(src('sync.js'));
  const { env, db, card } = await setup();
  card('a', { key: 'TASK-8', status: 'review', evidence: { pr: PR(8), rollback } });
  const v = verOf(db, 'a');
  const n = logRows(db);
  const r = await runSyncCron(env, { fetchImpl: ghFetch() });
  assert.equal(r.unchanged, 1);
  assert.equal(verOf(db, 'a'), v);
  assert.equal(logRows(db), n);
  assert.ok(stampOf(db, 'a'));
});

test('runSyncCron: a merged pull request is done by cron with the merge sha, with a history line naming cron', T, async () => {
  const { runSyncCron } = await import(src('sync.js'));
  const { env, db, card, get } = await setup();
  card('a', { key: 'TASK-5', status: 'review', evidence: { pr: PR(5), rollback } });
  const r = await runSyncCron(env, { fetchImpl: ghFetch({ merged: [5] }) });
  assert.equal(r.changed.length, 1);
  const a = get('a');
  assert.equal(a.status, 'done');
  assert.ok(a.evidence.merged.endsWith('5'));
  assert.equal(a.history.length, 1);
  assert.equal(a.history[0].by, 'cron');
  assert.match(a.history[0].what, /synced from GitHub by cron/);
  assert.ok(a.touchedBy.includes('cron'));
  assert.ok(stampOf(db, 'a'));
});

test('runSyncCron: a pull request GitHub cannot answer for is stamped too, so it cannot hold the front of the line', T, async () => {
  const { runSyncCron } = await import(src('sync.js'));
  const { env, db, card, get } = await setup();
  card('a', { key: 'TASK-7', status: 'review', evidence: { pr: PR(7), rollback } });
  const r = await runSyncCron(env, { fetchImpl: ghFetch({ fail: [7] }) });
  assert.equal(r.unreadable.length, 1);
  assert.ok(stampOf(db, 'a'));
  assert.equal(get('a').history.length, 0);
});

test('runSyncCron: a refused card write is stamped too; a change past the write budget waits unstamped', T, async () => {
  const { runSyncCron } = await import(src('sync.js'));
  const { env, db, card } = await setup();
  card('bad', { key: 'TASK-70', status: 'review', title: '', evidence: { pr: PR(70), rollback } });
  card('m1', { key: 'TASK-71', status: 'review', evidence: { pr: PR(71), rollback } });
  card('m2', { key: 'TASK-72', status: 'review', evidence: { pr: PR(72), rollback } });
  const r = await runSyncCron(env, { fetchImpl: ghFetch({ merged: [70, 71, 72] }), maxWrites: 2 });
  assert.equal(r.writes, 2);
  assert.ok(stampOf(db, 'bad'), 'refused write stamped');
  assert.ok(stampOf(db, 'm1'));
  assert.equal(stampOf(db, 'm2'), '', 'deferred change stays at the front');
  assert.ok(r.unreadable.some((u) => /write budget/.test(u.why)));
});

test('runSyncCron: no GitHub token is an error the handler can catch', T, async () => {
  const { runSyncCron } = await import(src('sync.js'));
  const { db } = await setup();
  await assert.rejects(() => runSyncCron({ DB: db }), /merge token/);
});

test('scheduled handler: the pulse job throwing does not stop the sync, and the sync is sized for the worst case', T, async () => {
  const { runScheduled } = await import(src('scheduled.js'));
  const { env, db, card } = await setup();
  for (let i = 1; i <= 4; i++) card(`c${i}`, { key: `TASK-8${i}`, status: 'review', evidence: { pr: PR(80 + i), rollback } });
  db.raw.prepare("INSERT INTO board_mcp_calls (worker, principal, tool, target, started_at, outcome, claim_detail) VALUES ('board', 'agent', 'add_comment', 't', ?, 'ok', 'no links here')").run(new Date().toISOString());
  // The claims checker throws when it writes its verdict (the select inside it is tolerant, the update is not).
  const broken = new Proxy(env.DB, { get: (t, k) => (k === 'prepare' ? (sql) => { if (/^UPDATE board_mcp_calls SET claim_status/.test(sql)) throw new Error('pulse down'); return t.prepare(sql); } : t[k]) });
  const f = ghFetch();
  const out = await runScheduled({ ...env, DB: broken }, { fetchImpl: f, log: () => {} });
  assert.ok(out.sync, 'sync ran');
  assert.equal(out.sync.checked, 1, 'unknown pulse count means one pull request');
  assert.equal(f.seen.filter((u) => /\/pulls\/\d+$/.test(u)).length, 1);
  assert.equal(out.sync.stamped, 1);
  assert.ok(db.raw.prepare("SELECT 1 FROM board_cron_state WHERE name LIKE 'synced:%'").get());
});

test('budgetFor: pulse calls, D1 queries and fetches share the 50 call limit at every Pulse count; the sync is hard capped at 8 pull requests', T, async () => {
  const { budgetFor, syncBudgetFor } = await import(src('scheduled.js'));
  assert.deepEqual(budgetFor(undefined), { pr: 1, syncWrites: 0, lineWrites: 0, line: true });
  assert.equal(syncBudgetFor(null), 1);
  assert.equal(syncBudgetFor(NaN), 1);
  assert.ok(syncBudgetFor(0) <= 8 && syncBudgetFor(0) >= 5);
  assert.ok(syncBudgetFor(0) > syncBudgetFor(20));
  for (let p = 0; p <= 60; p++) {
    const b = budgetFor(p);
    assert.ok(b.pr >= 0 && b.pr <= 8, 'pull request cap at ' + p);
    // The run's own calls (a refused write costs 3), without the log row and the two spare calls.
    const spend = (b.pr > 0 ? 4 + 4 * b.pr : 0) + (b.line ? 5 : 0) + 3 * b.lineWrites + 3 * b.syncWrites;
    assert.ok(spend <= Math.max(0, 50 - p - 1), 'spend ' + spend + ' leaves room at pulse ' + p);
    if (b.pr === 0) assert.deepEqual([b.line, b.syncWrites, b.lineWrites], [false, 0, 0], 'nothing runs when the sync cannot');
  }
  assert.equal(budgetFor(40).pr, 0, 'fewer than 4 calls left means zero, not one');
});

test('scheduled handler: when no room is left the sync is skipped entirely, never run uncapped', T, async () => {
  const { runScheduled } = await import(src('scheduled.js'));
  const { env, db, card } = await setup();
  card('a', { key: 'TASK-99', status: 'review', evidence: { pr: PR(99), rollback } });
  // Forty claim rows, each citing a pull request: Pulse spends its whole budget.
  const ins = db.raw.prepare("INSERT INTO board_mcp_calls (worker, principal, tool, target, started_at, outcome, claim_detail) VALUES ('board', 'agent', 'add_comment', 't', ?, 'ok', ?)");
  for (let i = 1; i <= 40; i++) ins.run(new Date().toISOString(), 'https://github.com/example-org/sample-site/pull/' + i);
  const f = ghFetch();
  const out = await runScheduled(env, { fetchImpl: f, log: () => {} });
  assert.deepEqual(out.sync, { skipped: true });
  assert.equal(f.seen.filter((u) => /\/pulls\/99$/.test(u)).length, 0, 'the card sync read nothing');
});

test('runSyncCron: prunes rotation rows for deleted cards and skip rows older than 30 days, in the one batch', T, async () => {
  const { runSyncCron } = await import(src('sync.js'));
  const { env, db, card } = await setup();
  card('a', { key: 'TASK-9', status: 'review', evidence: { pr: PR(9), rollback } });
  const put = db.raw.prepare('INSERT INTO board_cron_state (name, value) VALUES (?, ?)');
  put.run('synced:gone', '2026-10-01T00:00:00.000Z');
  put.run('skip:old', '3@' + new Date(Date.now() - 40 * 86400000).toISOString());
  put.run('skip:new', '2@' + new Date(Date.now() - 86400000).toISOString());
  put.run('linefacts:main', '2026-10-26T00:00:00.000Z');
  const calls = [];
  const spy = new Proxy(env.DB, { get: (t, k) => (k === 'batch' ? (list) => { calls.push(list.length); return t.batch(list); } : t[k]) });
  await runSyncCron({ ...env, DB: spy }, { fetchImpl: ghFetch() });
  const names = db.raw.prepare('SELECT name FROM board_cron_state ORDER BY name').all().map((r) => r.name);
  assert.deepEqual(names, ['linefacts:main', 'skip:new', 'synced:a']);
  assert.equal(calls.length, 1, 'one batch carries stamps and prune');
});

test('checkClaims: fetches counts real calls, a page or url item may cost a HEAD and a GET, and the budget is in worst case calls', T, async () => {
  const { checkClaims } = await import(src('pulse.js'));
  const { env, db } = await setup();
  const at = new Date().toISOString();
  const ins = db.raw.prepare("INSERT INTO board_mcp_calls (worker, principal, tool, target, started_at, outcome, claim_detail) VALUES ('board', 'agent', 'add_comment', 't', ?, 'ok', ?)");
  ins.run(at, 'see https://one.pages.dev/ and https://two.pages.dev/');
  const seen = [];
  const fetchImpl = async (url, init = {}) => { seen.push(init.method || 'GET'); return { ok: true, status: init.method === 'HEAD' ? 405 : 200, json: async () => ({}) }; };
  const r = await checkClaims({ ...env, GITHUB_MERGE_TOKEN: 't' }, { fetchImpl });
  assert.equal(r.fetches, seen.length);
  assert.equal(seen.length, 4, 'two pages items, each a HEAD then a GET');
  assert.equal(r.calls, 1 + 4 + 1);
});

test('Pulse connections show cron with its last run time', T, async () => {
  const { runScheduled } = await import(src('scheduled.js'));
  const { pulseConnections } = await import(src('pulse.js'));
  const { env } = await setup();
  await runScheduled(env, { fetchImpl: ghFetch(), log: () => {} });
  const { connections } = await pulseConnections(env);
  const cron = connections.find((c) => c.principal === 'cron');
  assert.ok(cron, 'cron is a connection');
  assert.ok(cron.lastCall);
  assert.equal(cron.dot, 'green');
});

test('scheduled handler: a sync that ran with cards cut by the cap logs as a run, with the cut count', T, async () => {
  const { runScheduled } = await import(src('scheduled.js'));
  const { env, card } = await setup();
  for (let i = 1; i <= 12; i++) card('x' + i, { key: 'TASK-' + (200 + i), status: 'review', evidence: { pr: PR(200 + i), rollback } });
  const lines = [];
  const out = await runScheduled(env, { fetchImpl: ghFetch(), log: (l) => lines.push(l) });
  assert.ok(out.sync.skipped > 0, 'some cards were cut by the cap');
  assert.notEqual(out.sync.skipped, true);
  const line = lines.find((l) => l.startsWith('board cron sync'));
  assert.ok(!/skipped/.test(line), line);
  assert.ok(line.includes(out.sync.checked + ' read'));
  assert.ok(line.endsWith(out.sync.skipped + ' cut by the cap'), line);
});

test('scheduled handler: a skipped flag of true is the only thing logged as skipped', T, async () => {
  const { runScheduled } = await import(src('scheduled.js'));
  const { env } = await setup();
  const lines = [];
  // Pulse has used the whole budget: the sync does not run, and says so.
  const ins = env.DB.raw.prepare("INSERT INTO board_mcp_calls (worker, principal, tool, target, started_at, outcome, claim_detail) VALUES ('board', 'agent', 'add_comment', 't', ?, 'ok', ?)");
  for (let i = 1; i <= 40; i++) ins.run(new Date().toISOString(), 'https://github.com/example-org/sample-site/pull/' + i);
  await runScheduled(env, { fetchImpl: ghFetch(), log: (l) => lines.push(l) });
  assert.ok(lines.includes('board cron sync: skipped'));
});
