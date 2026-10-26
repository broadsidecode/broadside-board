'use strict';

// MCP add_board: a new tab and its counter, Owner and Agent only.
// Real SQLite behind a small D1 stand-in and the real schema, no network.
//   node --test tests/board-add-board.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { /* older Node: the tests below skip */ }
const src = (f) => pathToFileURL(path.join(__dirname, '..', 'worker', 'src', f)).href;
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'worker', 'schema.sql'), 'utf8');
const PROJECT = { name: 'Acme Plumbing', url: 'https://claude.ai/code/project/chan_0123abcDEF' };

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
  return {
    raw: db,
    prepare: stmt,
    async batch(list) {
      db.exec('BEGIN');
      try { const out = list.map((s) => exec(s.sql, s.args)); db.exec('COMMIT'); return out; }
      catch (err) { db.exec('ROLLBACK'); throw err; }
    },
  };
}

async function setup() {
  const mcp = await import(src('mcp.js'));
  const db = d1();
  for (const [id, prefix, order] of [['main', 'KIT', 0], ['cloud-plan', 'KIT', 1], ['franks', 'FRK', 3]]) {
    db.raw.prepare('INSERT INTO board_boards (id, data, version, updated_at) VALUES (?, ?, 1, ?)').run(id, JSON.stringify({ name: id, prefix, order }), 'x');
  }
  db.raw.prepare('INSERT INTO board_counters (id, next, version) VALUES (?, 10, 1)').run('KIT');
  db.raw.prepare('INSERT INTO board_counters (id, next, version) VALUES (?, 4, 1)').run('FRK');
  db.raw.prepare('INSERT INTO board_counters (id, next, version) VALUES (?, 2, 1)').run('OLD');
  const env = { DB: db, HANDBOOK: 'x' };
  const call = async (principal, name, args) => {
    const r = await mcp.handleRpc(env, principal, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const res = r.json.result;
    return { isError: !!res.isError, text: res.content[0].text };
  };
  const counts = () => ({
    boards: db.raw.prepare('SELECT COUNT(*) AS n FROM board_boards').get().n,
    counters: db.raw.prepare('SELECT COUNT(*) AS n FROM board_counters').get().n,
    history: db.raw.prepare('SELECT COUNT(*) AS n FROM board_history_log').get().n,
  });
  return { db, call, counts, mcp };
}

const ACME = { id: 'acme-plumbing', name: 'Acme Plumbing', prefix: 'ACM', project: PROJECT };

test('add_board is listed with a strict input schema', { skip: !sqlite }, async () => {
  const { mcp } = await setup();
  const t = mcp.TOOLS.find((x) => x.name === 'add_board');
  assert.ok(t);
  assert.deepEqual(t.inputSchema.required, ['id', 'name', 'prefix', 'project']);
  assert.equal(t.inputSchema.additionalProperties, false);
});

for (const who of ['owner', 'agent']) {
  test(`${who} makes a tab with its counter; the first card there is number 1`, { skip: !sqlite }, async () => {
    const { db, call } = await setup();
    const r = await call(who, 'add_board', ACME);
    assert.equal(r.isError, false, r.text);
    const out = JSON.parse(r.text);
    assert.equal(out.created, true);
    assert.equal(out.prefix, 'ACM');
    assert.equal(out.by, who);
    const row = db.raw.prepare('SELECT data, version FROM board_boards WHERE id = ?').get('acme-plumbing');
    assert.equal(row.version, 1);
    assert.deepEqual(JSON.parse(row.data), { name: 'Acme Plumbing', prefix: 'ACM', order: 4, projects: { '*': PROJECT } });
    assert.equal(db.raw.prepare('SELECT next FROM board_counters WHERE id = ?').get('ACM').next, 1);
    const hist = db.raw.prepare("SELECT who, task_id, what FROM board_history_log WHERE task_id IN ('board:acme-plumbing', 'counter:ACM')").all();
    assert.equal(hist.length, 2);
    assert.ok(hist.every((h) => h.who === who));
    const list = JSON.parse((await call(who, 'list_boards', {})).text);
    const tab = list.find((b) => b.id === 'acme-plumbing');
    assert.equal(tab.prefix, 'ACM');
    assert.deepEqual(tab.projects, { '*': PROJECT });
    // The new tab hands out its own numbers from 1. Agent may add a non production card (the clerk rule).
    const c = await call(who, 'add_card', { board: 'acme-plumbing', title: 'First job' });
    assert.equal(c.isError, false, c.text);
    assert.equal(JSON.parse(c.text).key, 'ACM-1');
  });
}

test('a lane names which lane the project works', { skip: !sqlite }, async () => {
  const { db, call } = await setup();
  const r = await call('agent', 'add_board', { ...ACME, lane: 'lane1' });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(JSON.parse(db.raw.prepare('SELECT data FROM board_boards WHERE id = ?').get('acme-plumbing').data).projects, { lane1: PROJECT });
  const bad = await call('agent', 'add_board', { ...ACME, id: 'acme-two', prefix: 'ACT', lane: 'nobody' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /lane must be/);
});

test('every other name is refused and nothing is written', { skip: !sqlite }, async () => {
  const { call, counts } = await setup();
  const before = counts();
  for (const who of ['agent3', 'agent2', 'worker', 'lane1', 'cloud-worker', 'runner', 'github-actions', 'someone@example.com']) {
    const r = await call(who, 'add_board', ACME);
    assert.equal(r.isError, true, who);
    assert.match(r.text, /Owner and agent only/, who);
  }
  assert.deepEqual(counts(), before);
});

test('an id or prefix already in use is refused and nothing is written', { skip: !sqlite }, async () => {
  const { db, call, counts } = await setup();
  const before = counts();
  const cases = [
    [{ ...ACME, id: 'franks' }, /board franks already exists/],
    [{ ...ACME, prefix: 'FRK' }, /prefix FRK already has a counter/],
    [{ ...ACME, prefix: 'OLD' }, /prefix OLD already has a counter/],
  ];
  for (const [args, re] of cases) {
    const r = await call('owner', 'add_board', args);
    assert.equal(r.isError, true);
    assert.match(r.text, re);
  }
  // A prefix a tab carries without a counter row is still taken.
  db.raw.prepare('INSERT INTO board_boards (id, data, version, updated_at) VALUES (?, ?, 1, ?)').run('ghost', JSON.stringify({ name: 'Ghost', prefix: 'GHO' }), 'x');
  const g = await call('owner', 'add_board', { ...ACME, prefix: 'GHO' });
  assert.equal(g.isError, true);
  assert.match(g.text, /prefix GHO is already used by board ghost/);
  assert.deepEqual({ ...counts(), boards: counts().boards - 1 }, before);
  // The existing tab and counters are untouched.
  assert.equal(db.raw.prepare('SELECT next FROM board_counters WHERE id = ?').get('FRK').next, 4);
  assert.equal(db.raw.prepare('SELECT version FROM board_boards WHERE id = ?').get('franks').version, 1);
});

test('invalid fields are refused and nothing is written', { skip: !sqlite }, async () => {
  const { call, counts } = await setup();
  const before = counts();
  const cases = [
    [{ ...ACME, id: 'Acme' }, /id must be/],
    [{ ...ACME, id: 'a' }, /id must be/],
    [{ ...ACME, name: '  ' }, /name must be/],
    [{ ...ACME, name: 'x'.repeat(61) }, /name must be/],
    [{ ...ACME, prefix: 'acm' }, /prefix must be/],
    [{ ...ACME, prefix: '1AB' }, /prefix must be/],
    [{ ...ACME, prefix: 'A' }, /prefix must be/],
    [{ ...ACME, project: { name: 'Acme', url: 'https://example.com/project/x' } }, /claude\.ai\/code\/project/],
    [{ ...ACME, project: { name: '', url: PROJECT.url } }, /claude\.ai\/code\/project/],
  ];
  for (const [args, re] of cases) {
    const r = await call('agent', 'add_board', args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.text, re, JSON.stringify(args));
  }
  assert.deepEqual(counts(), before);
});

test('Agent still cannot change an existing tab or set a counter through the store', { skip: !sqlite }, async () => {
  const { db } = await setup();
  const store = await import(src('store.js'));
  await assert.rejects(store.putBoard(db, 'agent', 'franks', { data: { name: 'Renamed', prefix: 'FRK' }, ifVersion: 1 }, false), /read only for agent/);
  await assert.rejects(store.putCounter(db, 'agent', 'FRK', { next: 1, ifVersion: 1 }), /read only for agent/);
  await assert.rejects(store.setBoardPaused(db, 'agent', 'franks', true), /read only for agent/);
  await assert.rejects(store.createBoard(db, 'agent2', 'x-tab', { name: 'X', prefix: 'XTB' }), /read only for agent2/);
});
