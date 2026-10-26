'use strict';

// TASK-38 (one write guard on every route, a go that keeps its first time, merges that name the presser),
// TASK-39 (board-bound tokens) and TASK-42 (nested patches keep the rest). Fake D1, no network.
//   node --test tests/board-guard.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const src = (f) => pathToFileURL(path.join(__dirname, '..', 'worker', 'src', f)).href;
const PR = 'https://github.com/example-org/test-diner/pull/21';

function fakeDb() {
  const rows = new Map();
  const stmt = (sql) => {
    let args = [];
    const api = {
      bind(...a) { args = a; return api; },
      async first() {
        if (/FROM board_tasks WHERE id = \?/.test(sql)) return rows.get(args[0]) || null;
        if (/FROM board_tasks WHERE key = \?/.test(sql)) return [...rows.values()].find((r) => JSON.parse(r.data).key === args[0]) || null;
        return null;
      },
      async all() { return { results: [...rows.values()] }; },
      async run() {
        if (/^INSERT INTO board_tasks/.test(sql)) rows.set(args[0], { id: args[0], data: args[6], version: args[7], updated_at: args[8] });
        else if (/^UPDATE board_tasks SET board/.test(sql)) {
          const id = args[args.length - 1]; const r = rows.get(id);
          rows.set(id, { ...r, data: args[5], version: r.version + 1, updated_at: args[args.length - 2] });
        } else if (/^DELETE FROM board_tasks WHERE id = \?/.test(sql)) rows.delete(args[0]);
        return {};
      },
    };
    return api;
  };
  return { rows, prepare: stmt, batch: async (list) => { for (const s of list) await s.run(); return []; } };
}
const read = (db, id) => JSON.parse(db.rows.get(id).data);
const ver = (db, id) => db.rows.get(id).version;
const deny = (status, re) => (e) => e.status === status && re.test(e.message);

async function setup() {
  const store = await import(src('store.js'));
  const db = fakeDb();
  await store.writeTask(db, 'owner', { op: 'put', id: 'p', data: { board: 'test-diner', key: 'TDN-30', title: 'Deploy', status: 'todo', kind: 'production', gates: { ownerGo: '' }, history: [] } });
  // evidence.rollback is on the card because the test below raises a merge ask on it.
  await store.writeTask(db, 'owner', { op: 'put', id: 'a', data: { board: 'test-diner', key: 'TDN-31', title: 'Build', status: 'doing', kind: 'agent', history: [], evidence: { reviewedHead: 'a'.repeat(40), checks: `pass (1 runs on ${'a'.repeat(40)}, synced from GitHub)`, rollback: { to: 'before TDN-31', how: 'revert', cannot: 'nothing' } }, gates: { reviewer: { verdict: 'PASS', sha: 'a'.repeat(40) } }, roles: { builder: { name: 'builder', state: 'working', startedAt: 'T1', notes: 'n' } } } });
  await store.writeTask(db, 'owner', { op: 'put', id: 'm', data: { board: 'main', key: 'TASK-90', title: 'Main card', status: 'todo', kind: 'agent', history: [] } });
  return { store, db };
}

test('TASK-38: no write sets the go; production, nudge and poke fields are guarded on every write path', async () => {
  const { store, db } = await setup();
  // Owner's own form creates cards with gates.ownerGo '' and that still works (it is no change).
  assert.equal(read(db, 'p').gates.ownerGo, '');
  // Not even Owner patches the go; everyone else is refused sooner, because the board is read only for them.
  await assert.rejects(store.writeTask(db, 'owner', { op: 'patch', id: 'p', ifVersion: ver(db, 'p'), data: { gates: { ownerGo: true } } }), deny(403, /gates\.ownerGo is set only by an approved go/));
  for (const who of ['cloud-worker', 'github-actions', 'runner', 'agent']) {
    await assert.rejects(store.writeTask(db, who, { op: 'patch', id: 'p', ifVersion: ver(db, 'p'), data: { gates: { ownerGo: true } } }), deny(403, /read only/));
  }
  for (const data of [{ kind: 'production' }, { nudgedAt: '2026-10-23T10:00:00Z' }, { pokedAt: '2026-10-23T10:00:00Z' }]) {
    await assert.rejects(store.writeTask(db, 'cloud-worker', { op: 'patch', id: 'a', ifVersion: ver(db, 'a'), data }), deny(403, /read only for cloud-worker/));
  }
  await assert.rejects(store.writeTask(db, 'github-actions', { op: 'patch', id: 'p', ifVersion: ver(db, 'p'), data: { kind: 'agent' } }), deny(403, /read only/));
  await assert.rejects(store.writeTask(db, 'cloud-worker', { op: 'put', id: 'n', data: { board: 'test-diner', key: 'TDN-32', title: 'x', status: 'todo', kind: 'production', history: [] } }), deny(403, /read only/));
  // The batch route goes through the same guard.
  await assert.rejects(store.writeBatch(db, 'cloud-worker', [{ op: 'patch', id: 'p', ifVersion: ver(db, 'p'), data: { gates: { ownerGoAt: 'now' } } }], false), deny(403, /read only/));
  await assert.rejects(store.writeBatch(db, 'owner', [{ op: 'patch', id: 'p', ifVersion: ver(db, 'p'), data: { gates: { ownerGoAt: 'now' } } }], true), deny(403, /ownerGoAt/));
  // Owner nudges and makes a card production; the desktop runner and the connectors no longer write those.
  await store.writeTask(db, 'owner', { op: 'patch', id: 'a', ifVersion: ver(db, 'a'), data: { nudgedAt: '2026-10-23T10:00:00Z' } });
  await assert.rejects(store.writeTask(db, 'runner', { op: 'patch', id: 'a', ifVersion: ver(db, 'a'), data: { pokedAt: '2026-10-23T10:01:00Z' } }), deny(403, /read only for runner/));
  await assert.rejects(store.writeTask(db, 'agent', { op: 'patch', id: 'm', ifVersion: ver(db, 'm'), data: { kind: 'production' } }), deny(403, /read only for agent/));
  await store.writeTask(db, 'owner', { op: 'patch', id: 'm', ifVersion: ver(db, 'm'), data: { kind: 'production' } });
  assert.equal(read(db, 'm').kind, 'production');
  // The repository workflow still records the deploy a go is spent by, and nothing else of its own.
  await store.writeTask(db, 'github-actions', { op: 'patch', id: 'p', ifVersion: ver(db, 'p'), data: { evidence: { deployRun: 'r1' } } });
  assert.equal(read(db, 'p').evidence.deployRun, 'r1');
  await assert.rejects(store.writeTask(db, 'github-actions', { op: 'patch', id: 'p', ifVersion: ver(db, 'p'), data: { note: 'deployed' } }), deny(403, /read only for github-actions/));
  await assert.rejects(store.writeTask(db, 'cloud-worker', { op: 'patch', id: 'p', ifVersion: ver(db, 'p'), data: { evidence: { deployedSha: 'b'.repeat(40) } } }), deny(403, /read only for cloud-worker/));
});

test('TASK-38: the go is given once; a second press keeps the first time; the merge commit names the presser', async () => {
  const { db } = await setup();
  const { approveCard } = await import(src('approve.js'));
  await approveCard({}, db, 'agent2', 'p', { decision: 'approve', as: 'go' });
  const first = read(db, 'p').gates;
  assert.equal(first.ownerGo, true);
  assert.equal(first.ownerGoBy, 'agent2');
  await new Promise((r) => setTimeout(r, 5));
  await approveCard({}, db, 'agent', 'p', { decision: 'approve', as: 'go' });
  const after = read(db, 'p');
  assert.equal(after.gates.ownerGoAt, first.ownerGoAt, 'the first go time stands');
  assert.equal(after.gates.ownerGoBy, 'agent2');
  assert.match(after.history.at(-1).what, /^agent for Owner pressed go again; the go stands from .+ by agent2$/);

  const store = await import(src('store.js'));
  await store.writeTask(db, 'cloud-worker', { op: 'patch', id: 'a', ifVersion: ver(db, 'a'), data: { ask: { kind: 'merge', text: 'Merge pull request 21', pr: PR } } });
  const calls = [];
  const f = async (url, init) => {
    if (url.includes('/actions/runs?')) return { ok: true, status: 200, json: async () => ({ workflow_runs: [{ name: 'PR checks', workflow_id: 1, head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'success' }] }) };
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ merged: true, sha: 'abc1234def'.padEnd(40, '0') }) };
  };
  await approveCard({ GITHUB_MERGE_TOKEN: 'x' }, db, 'agent3', 'a', { decision: 'approve' }, f);
  assert.equal(calls[0].body.merge_method, 'squash');
  assert.equal(calls[0].body.sha, 'a'.repeat(40));
  assert.match(calls[0].body.commit_message, /^Merged from the Board by agent3 for Owner \(card TDN-31\)/);
});

test('TASK-39: a board-bound token reads and writes its own board only', async () => {
  const { store, db } = await setup();
  const lib = await import(src('lib.js'));
  assert.deepEqual(lib.splitPrincipal('cloud-worker@test-diner'), { principal: 'cloud-worker', scope: 'test-diner' });
  assert.deepEqual(lib.splitPrincipal('github-actions@test-diner'), { principal: 'github-actions', scope: 'test-diner' });
  assert.deepEqual(lib.splitPrincipal('someone@example.com'), { principal: 'someone@example.com', scope: '' }, 'an email is never read as a board');
  assert.deepEqual(lib.splitPrincipal('worker'), { principal: 'worker', scope: '' });
  assert.deepEqual(lib.SCOPED_WORKERS, ['cloud-worker', 'github-actions']);
  const scope = { scope: 'test-diner' };
  // The one write a bound token keeps, an ask, still stays on its own board.
  const ask = { ask: { kind: 'decide', text: 'Which photo?' } };
  await assert.rejects(store.writeTask(db, 'cloud-worker', { op: 'patch', id: 'm', ifVersion: ver(db, 'm'), data: ask }, scope), deny(403, /bound to board test-diner and cannot change a card on main/));
  await assert.rejects(store.writeTask(db, 'cloud-worker', { op: 'patch', id: 'a', ifVersion: ver(db, 'a'), data: { board: 'main' } }, scope), deny(403, /read only/));
  await assert.rejects(store.writeTask(db, 'cloud-worker', { op: 'put', id: 'z', data: { board: 'main', key: 'TASK-91', title: 'x', status: 'todo', kind: 'agent', history: [] } }, scope), deny(403, /read only/));
  await assert.rejects(store.writeBatch(db, 'github-actions', [{ op: 'patch', id: 'm', ifVersion: ver(db, 'm'), data: ask }], false, scope), deny(403, /bound to board test-diner/));
  await store.writeTask(db, 'cloud-worker', { op: 'patch', id: 'a', ifVersion: ver(db, 'a'), data: ask }, scope);
  assert.equal(read(db, 'a').ask.text, 'Which photo?');
  // Sync runs with the caller's scope too.
  const { syncBoard } = await import(src('sync.js'));
  assert.equal(typeof syncBoard, 'function');
});

test('TASK-42: patching one field of a role or gate keeps the other fields; __delete__ and null still work', async () => {
  const { store, db } = await setup();
  await store.writeTask(db, 'owner', { op: 'patch', id: 'a', ifVersion: ver(db, 'a'), data: { roles: { builder: { state: 'done', finishedAt: 'T2' } } } });
  assert.deepEqual(read(db, 'a').roles.builder, { name: 'builder', state: 'done', startedAt: 'T1', notes: 'n', finishedAt: 'T2' });
  await store.writeTask(db, 'owner', { op: 'patch', id: 'a', ifVersion: ver(db, 'a'), data: { roles: { builder: { notes: { __delete__: true } }, reviewer: { name: 'reviewer', state: 'working' } } } });
  const r = read(db, 'a').roles;
  assert.equal('notes' in r.builder, false);
  assert.equal(r.builder.name, 'builder');
  assert.deepEqual(r.reviewer, { name: 'reviewer', state: 'working' });
  await store.writeTask(db, 'cloud-worker', { op: 'patch', id: 'a', ifVersion: ver(db, 'a'), data: { gates: { reviewer: { verdict: 'PASS' } } } });
  await store.writeTask(db, 'cloud-worker', { op: 'patch', id: 'a', ifVersion: ver(db, 'a'), data: { gates: { reviewer: { at: 'T3' } } } });
  assert.deepEqual(read(db, 'a').gates.reviewer, { verdict: 'PASS', sha: 'a'.repeat(40), at: 'T3' });
  const lib = await import(src('lib.js'));
  assert.deepEqual(lib.mergeCard({ a: { b: 1 }, l: [1, 2] }, { a: null, l: [3] }), { a: null, l: [3] }, 'null clears, arrays replace');
});

test('MCP: update_card cannot set the nudge fields; nudge_card is the way', async () => {
  const lib = await import(src('lib.js'));
  assert.match(lib.mcpPatchProblem({}, { nudgedAt: 'x' }, 'owner'), /nudge_card/);
  assert.match(lib.mcpPatchProblem({}, { pokedAt: 'x' }, 'agent2'), /nudge_card/);
});
