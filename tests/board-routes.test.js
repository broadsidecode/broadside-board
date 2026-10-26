'use strict';

// Every API route with a board-bound token, an unknown token and the write guard, against a real SQLite
// database (Node's built-in node:sqlite behind a small D1 stand-in) and the real schema. TASK-38, TASK-39.
//   node --test tests/board-routes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { /* older Node: the tests below skip */ }
const src = (f) => pathToFileURL(path.join(__dirname, '..', 'worker', 'src', f)).href;
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'worker', 'schema.sql'), 'utf8');

// D1 stand-in: prepare/bind/first/all/run and an all-or-nothing batch, on a real SQLite file in memory.
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

const ENV = {
  SERVICE_PRINCIPALS: JSON.stringify({ 'cloudtd.access': 'cloud-worker@test-diner', 'ghtd.access': 'github-actions@test-diner', 'jarv.access': 'worker', 'bare.access': 'cloud-worker' }),
  EMAIL_PRINCIPALS: JSON.stringify({ 'owner@example.com': 'owner' }),
};
const as = (cn) => ({ common_name: cn });
const OWNER = { email: 'owner@example.com' };

async function setup() {
  const api = await import(src('api.js'));
  const store = await import(src('store.js'));
  const db = d1();
  const env = { ...ENV, DB: db };
  for (const [id, prefix] of [['main', 'KIT'], ['test-diner', 'TDN'], ['harbor', 'HBR']]) {
    db.raw.prepare('INSERT INTO board_boards (id, data, version, updated_at) VALUES (?, ?, 1, ?)').run(id, JSON.stringify({ name: id, prefix, order: 1 }), 'x');
    db.raw.prepare('INSERT INTO board_counters (id, next, version) VALUES (?, 10, 1)').run(prefix);
  }
  await store.writeTask(db, 'owner', { op: 'put', id: 'm1', data: { board: 'main', key: 'TASK-1', title: 'Main card', status: 'todo', kind: 'agent', history: [] } });
  await store.writeTask(db, 'owner', { op: 'put', id: 'f1', data: { board: 'harbor', key: 'HBR-1', title: 'Harbor card', status: 'todo', kind: 'agent', history: [] } });
  await store.writeTask(db, 'owner', { op: 'put', id: 't1', data: { board: 'test-diner', key: 'TDN-1', title: 'Diner card', status: 'doing', kind: 'production', history: [] } });
  const call = async (claims, method, p, body) => {
    const req = new Request(`https://board.example.com/api/v1${p}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });
    let res;
    try { res = await api.handleApi(req, env, new URL(req.url), claims); }
    catch (err) { return { status: err.status || 500, body: { error: err.message } }; }
    const text = await res.text();
    let j; try { j = JSON.parse(text); } catch { j = { text }; }
    return { status: res.status, body: j };
  };
  const ver = (id) => db.raw.prepare('SELECT version FROM board_tasks WHERE id = ?').get(id).version;
  const card = (id) => JSON.parse(db.raw.prepare('SELECT data FROM board_tasks WHERE id = ?').get(id).data);
  return { db, env, call, ver, card };
}

test('TASK-39: a bound token sees and writes its own board only, on every route', { skip: !sqlite && 'node:sqlite missing' }, async () => {
  const { call, ver } = await setup();
  const C = as('cloudtd.access');
  const who = await call(C, 'GET', '/whoami');
  assert.deepEqual([who.body.principal, who.body.scope], ['cloud-worker', 'test-diner']);
  assert.deepEqual((await call(C, 'GET', '/boards')).body.boards.map((b) => b.id), ['test-diner']);
  assert.deepEqual((await call(C, 'GET', '/tasks')).body.tasks.map((t) => t.data.key), ['TDN-1']);
  assert.equal((await call(C, 'GET', '/tasks?board=main')).status, 403);
  assert.equal((await call(C, 'GET', '/tasks/m1')).status, 403);
  assert.equal((await call(C, 'GET', '/tasks/m1/history')).status, 403);
  assert.equal((await call(C, 'GET', '/tasks/gone-card/history')).status, 404, 'a missing card is a 404, not another board\'s history');
  const ASK = { ask: { kind: 'decide', text: 'Which hours?' } };
  const other = await call(C, 'PATCH', '/tasks/m1', { ifVersion: ver('m1'), data: ASK });
  assert.equal(other.status, 403);
  assert.match(other.body.error, /bound to board test-diner/);
  assert.equal((await call(C, 'POST', '/tasks/batch', { writes: [{ op: 'patch', id: 'f1', ifVersion: ver('f1'), data: ASK }] })).status, 403);
  assert.equal((await call(C, 'PUT', '/tasks/new1', { data: { board: 'main', key: 'TASK-99', title: 'x', status: 'todo', kind: 'agent', history: [] } })).status, 403);
  assert.equal((await call(C, 'PATCH', '/tasks/t1', { ifVersion: ver('t1'), data: { board: 'harbor' } })).status, 403);
  // Read only: on its own board the token raises an ask and nothing else.
  const note = await call(C, 'PATCH', '/tasks/t1', { ifVersion: ver('t1'), data: { note: 'own board' } });
  assert.equal(note.status, 403);
  assert.match(note.body.error, /read only for cloud-worker/);
  assert.equal((await call(C, 'PATCH', '/tasks/t1', { ifVersion: ver('t1'), data: ASK })).status, 200);
  assert.deepEqual((await call(C, 'GET', '/counters')).body.counters.map((c) => c.id), ['TDN']);
  assert.equal((await call(C, 'POST', '/counters/KIT/next')).status, 403);
  assert.equal((await call(C, 'POST', '/counters/TDN/next')).status, 403, 'read only: no new ticket numbers for a token');
  assert.equal((await call(OWNER, 'POST', '/counters/TDN/next')).status, 200);
  assert.equal((await call(C, 'GET', '/activity?board=main')).status, 403);
  assert.ok((await call(C, 'GET', '/activity')).body.entries.every((e) => e.board === 'test-diner'));
  assert.equal((await call(C, 'POST', '/sync', { board: 'main' })).status, 403);
  assert.equal((await call(C, 'PUT', '/boards/x', { data: { name: 'x', prefix: 'XX' } })).status, 403);
  assert.equal((await call(C, 'POST', '/generate', { board: 'main', text: 'x' })).status, 403);
  assert.equal((await call(C, 'GET', '/principals')).status, 403);
  const snap = await call(C, 'GET', '/snapshot?github=0');
  assert.match(snap.body.text, /^scope: board test-diner$/m);
  assert.match(snap.body.text, /^counters next: TDN 11$/m);
  assert.doesNotMatch(snap.body.text, /TASK-1|HBR-1|Main card|Harbor card/);
});

test('TASK-39: an unbound customer worker and an unknown service token are refused outright', { skip: !sqlite && 'node:sqlite missing' }, async () => {
  const { call } = await setup();
  for (const cn of ['bare.access', 'nobody.access']) {
    const r = await call(as(cn), 'GET', '/tasks');
    assert.equal(r.status, 403, cn);
  }
});

test('TASK-39: a binding in the principals table works without a redeploy; only admins write it', { skip: !sqlite && 'node:sqlite missing' }, async () => {
  const { call } = await setup();
  const cid = `${'a'.repeat(32)}.access`;
  assert.equal((await call(as(cid), 'GET', '/tasks')).status, 403, 'unknown before binding');
  assert.equal((await call(as('cloudtd.access'), 'PUT', `/principals/${cid}`, { principal: 'cloud-worker', board: 'harbor' })).status, 403);
  assert.equal((await call(as('jarv.access'), 'PUT', `/principals/${cid}`, { principal: 'cloud-worker', board: 'harbor' })).status, 200);
  const r = await call(as(cid), 'GET', '/tasks');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.tasks.map((t) => t.data.key), ['HBR-1']);
  assert.equal((await call(OWNER, 'GET', '/principals')).body.principals.length, 1);
});

test('TASK-38: the go, production, nudge and deploy fields are guarded on the API, including imports', { skip: !sqlite && 'node:sqlite missing' }, async () => {
  const { call, ver, card } = await setup();
  const C = as('cloudtd.access'); const G = as('ghtd.access'); const J = as('jarv.access');
  for (const who of [C, J, OWNER]) {
    assert.equal((await call(who, 'PATCH', '/tasks/t1', { ifVersion: ver('t1'), data: { gates: { ownerGo: true } } })).status, 403);
  }
  assert.equal((await call(J, 'PUT', '/tasks/t9', { data: { board: 'test-diner', key: 'TDN-9', title: 'x', status: 'todo', kind: 'production', gates: { ownerGo: true }, history: [] } })).status, 403, 'a create cannot carry a go');
  assert.equal((await call(J, 'PUT', '/tasks/t8', { seedVersion: 3, data: { board: 'test-diner', key: 'TDN-8', title: 'x', status: 'todo', kind: 'production', history: [] } })).status, 403, 'read only: worker no longer imports');
  assert.equal((await call(OWNER, 'PUT', '/tasks/t1', { seedVersion: 1, ifVersion: ver('t1'), data: { ...card('t1'), gates: { ownerGo: true, ownerGoAt: 'forged' } } })).status, 409, 'an import never overwrites a card');
  assert.equal((await call(OWNER, 'PUT', '/tasks/t8', { seedVersion: 3, data: { board: 'test-diner', key: 'TDN-8', title: 'x', status: 'todo', kind: 'production', gates: { ownerGo: true }, history: [] } })).status, 403, 'an import passes the guard');
  assert.equal((await call(C, 'PATCH', '/tasks/t1', { ifVersion: ver('t1'), data: { kind: 'agent' } })).status, 403);
  // The go through the approve path, then the deploy claim by the repo workflow only, set once.
  assert.equal((await call(J, 'POST', '/tasks/t1/approve', { decision: 'approve', as: 'go' })).status, 200);
  assert.equal(card('t1').gates.ownerGo, true);
  assert.equal((await call(C, 'PATCH', '/tasks/t1', { ifVersion: ver('t1'), data: { evidence: { deployRun: 'run1' } } })).status, 403, 'only the deploy workflow claims');
  assert.equal((await call(G, 'PATCH', '/tasks/t1', { ifVersion: ver('t1'), data: { evidence: { deployRun: 'run1' } } })).status, 200);
  assert.equal((await call(G, 'PATCH', '/tasks/t1', { ifVersion: ver('t1'), data: { evidence: { deployRun: { __delete__: true } }, status: 'doing' } })).status, 403, 'a used go cannot be reset');
  assert.equal((await call(G, 'PATCH', '/tasks/t1', { ifVersion: ver('t1'), data: { evidence: { deployRun: 'run2' } } })).status, 403);
  assert.equal((await call(OWNER, 'PATCH', '/tasks/t1', { ifVersion: ver('t1'), data: { evidence: { deployRun: null } } })).status, 403, 'not even Owner clears it');
  assert.equal((await call(G, 'PATCH', '/tasks/t1', { ifVersion: ver('t1'), data: { evidence: { deployedSha: 'abc', deployedAt: 'now' } } })).status, 200);
  assert.deepEqual(card('t1').evidence, { deployRun: 'run1', deployedSha: 'abc', deployedAt: 'now' });
});

test('read only (): on the API an agent write is refused, an agent ask is allowed, Owner writes anything', { skip: !sqlite && 'node:sqlite missing' }, async () => {
  const { call, ver, card } = await setup();
  const C = as('cloudtd.access'); const G = as('ghtd.access'); const J = as('jarv.access');
  for (const [who, method, p, body] of [
    [J, 'PATCH', '/tasks/m1', { ifVersion: ver('m1'), data: { status: 'doing', note: 'working' } }],
    [J, 'PUT', '/tasks/m2', { data: { board: 'main', key: 'TASK-2', title: 'New', status: 'todo', kind: 'agent', history: [] } }],
    [J, 'DELETE', `/tasks/m1?ifVersion=${ver('m1')}`],
    [J, 'POST', '/tasks/batch', { writes: [{ op: 'patch', id: 'm1', ifVersion: ver('m1'), data: { note: 'x' } }] }],
    [J, 'POST', '/counters/KIT/next'],
    [J, 'PUT', '/boards/new-tab', { data: { name: 'New', prefix: 'NEW' } }],
    [C, 'PATCH', '/tasks/t1', { ifVersion: ver('t1'), data: { comments: [{ text: 'done' }] } }],
    [G, 'PATCH', '/tasks/t1', { ifVersion: ver('t1'), data: { note: 'from the workflow' } }],
  ]) {
    const r = await call(who, method, p, body);
    assert.equal(r.status, 403, `${method} ${p}`);
    assert.match(r.body.error, /the board is read only for (worker|cloud-worker|github-actions): raise or clear an ask/, `${method} ${p}`);
  }
  assert.equal(card('m1').note, undefined, 'nothing written');
  // Allowed: the approval request, raised and cleared, from any name.
  assert.equal((await call(J, 'PATCH', '/tasks/m1', { ifVersion: ver('m1'), data: { ask: { kind: 'decide', text: 'Ship it?', by: 'worker' } } })).status, 200);
  assert.equal(card('m1').ask.kind, 'decide');
  assert.equal((await call(J, 'PATCH', '/tasks/m1', { ifVersion: ver('m1'), data: { ask: null } })).status, 200);
  assert.equal(card('m1').ask, undefined);
  // The repository workflow keeps recording what GitHub says happened to the pull request.
  assert.equal((await call(G, 'PATCH', '/tasks/t1', { ifVersion: ver('t1'), data: { status: 'review', evidence: { pr: 'https://github.com/example-org/test-diner/pull/3', checks: 'PR checks: success' } } })).status, 200);
  // Owner writes anything.
  assert.equal((await call(OWNER, 'PATCH', '/tasks/m1', { ifVersion: ver('m1'), data: { status: 'doing', note: 'Owner is on it' } })).status, 200);
  assert.equal(card('m1').note, 'Owner is on it');
  assert.equal((await call(OWNER, 'PUT', '/tasks/m2', { data: { board: 'main', key: 'TASK-2', title: 'New', status: 'todo', kind: 'agent', history: [] } })).status, 200);
  // The record stays honest on the allowed write: history only grows and updatedBy is the real writer.
  const line = { at: 'T1', by: 'owner', what: 'started' };
  assert.equal((await call(OWNER, 'PATCH', '/tasks/m1', { ifVersion: ver('m1'), data: { history: [line] } })).status, 200);
  const wipe = await call(J, 'PATCH', '/tasks/m1', { ifVersion: ver('m1'), data: { ask: { kind: 'decide', text: 'x' }, history: [] } });
  assert.equal(wipe.status, 403);
  assert.match(wipe.body.error, /history is append only for worker/);
  const forged = await call(J, 'PATCH', '/tasks/m1', { ifVersion: ver('m1'), data: { ask: { kind: 'decide', text: 'x' }, updatedBy: 'owner' } });
  assert.equal(forged.status, 403);
  assert.match(forged.body.error, /updatedBy is the writer's own name/);
  assert.equal((await call(J, 'PATCH', '/tasks/m1', { ifVersion: ver('m1'), data: { ask: { kind: 'decide', text: 'x' }, updatedBy: 'worker', history: [line, { at: 'T2', by: 'worker', what: 'asked' }] } })).status, 200);
  assert.deepEqual(card('m1').history.map((h) => h.what), ['started', 'asked']);
});

test('review finding 6: a stored "true" is not the same value as true', async () => {
  const lib = await import(src('lib.js'));
  assert.match(lib.writeProblem({ board: 'b', gates: { ownerGo: 'true' } }, { board: 'b', gates: { ownerGo: true } }, 'github-actions') || '', /ownerGo/);
  assert.equal(lib.writeProblem({ board: 'b', gates: { ownerGo: '' } }, { board: 'b', gates: {} }, 'cloud-worker'), null, 'empty and missing are the same');
});

// the pause switch, end to end on the real schema: who may press it, what reads show, that a board
// write cannot flip it, and that a paused tab fires nothing while its Start and question stay queued.
test('TASK-66: pause_board is for Owner and his connectors; reads show it; a board write keeps it', { skip: !sqlite && 'node:sqlite missing' }, async () => {
  const { db, env, call } = await setup();
  const { handleRpc } = await import(src('mcp.js'));
  const tool = async (who, name, args) => {
    const out = await handleRpc(env, who, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const r = out.json.result;
    return { error: r.isError === true, text: r.content[0].text };
  };
  for (const who of ['lane1', 'cloud-worker', 'github-actions', 'runner', 'reader']) {
    const r = await tool(who, 'pause_board', { board: 'test-diner', paused: true });
    assert.ok(r.error && /^403: pause_board is for Owner/.test(r.text), who);
  }
  const proxy = await tool('agent', 'pause_board', { board: 'test-diner', paused: true });
  assert.ok(proxy.error && /^403: the board is read only for agent/.test(proxy.text));
  assert.equal(JSON.parse(db.raw.prepare('SELECT data FROM board_boards WHERE id = ?').get('test-diner').data).paused, undefined, 'refused presses wrote nothing');
  assert.ok((await tool('owner', 'pause_board', { board: 'nope', paused: true })).text.startsWith('404'));
  assert.ok((await tool('owner', 'pause_board', { board: 'test-diner', paused: 'yes' })).text.startsWith('400'));
  const p = JSON.parse((await tool('owner', 'pause_board', { board: 'test-diner', paused: true, reason: 'one lane test' })).text);
  assert.deepEqual([p.board, p.paused, p.pauseSetBy, p.pauseReason], ['test-diner', true, 'owner', 'one lane test']);
  assert.ok(p.pauseSetAt);
  assert.match(p.note, /not disabled/);
  const boards = JSON.parse((await tool('lane1', 'list_boards', {})).text);
  assert.deepEqual(boards.map((b) => [b.id, b.paused]).sort(), [['harbor', false], ['main', false], ['test-diner', true]]);
  assert.equal(boards.find((b) => b.id === 'test-diner').pauseSetBy, 'owner');
  assert.equal(JSON.parse((await tool('lane1', 'get_card', { key: 'TDN-1' })).text).boardPaused, true);
  assert.equal(JSON.parse((await tool('lane1', 'get_card', { key: 'HBR-1' })).text).boardPaused, undefined);
  const log = db.raw.prepare('SELECT who, what FROM board_history_log WHERE task_id = ?').all('board:test-diner');
  assert.deepEqual(log.map((l) => [l.who, l.what]), [['owner', 'board paused by Owner: one lane test']]);
  // A board edit cannot clear the pause, and cannot set one on another tab. Only Owner edits a board now.
  const J = as('jarv.access');
  assert.equal((await call(J, 'PUT', '/boards/test-diner', { ifVersion: 2, data: { name: 'Test Diner', prefix: 'TDN', order: 1, paused: false } })).status, 403, 'read only for worker');
  assert.equal((await call(OWNER, 'PUT', '/boards/test-diner', { ifVersion: 2, data: { name: 'Test Diner', prefix: 'TDN', order: 1, paused: false } })).status, 200);
  assert.equal(JSON.parse(db.raw.prepare('SELECT data FROM board_boards WHERE id = ?').get('test-diner').data).paused, true);
  assert.equal((await call(OWNER, 'PUT', '/boards/harbor', { ifVersion: 1, data: { name: 'harbor', prefix: 'HBR', order: 1, paused: true } })).status, 200);
  assert.equal(JSON.parse(db.raw.prepare('SELECT data FROM board_boards WHERE id = ?').get('harbor').data).paused, undefined);
  const r = JSON.parse((await tool('owner', 'pause_board', { board: 'test-diner', paused: false })).text);
  assert.deepEqual([r.paused, r.pauseSetBy], [false, 'owner']);
  assert.match(r.note, /nothing was fired/);
});

test('TASK-66: a paused tab fires no Start and no wake; resume fires nothing until the next Start or comment', { skip: !sqlite && 'node:sqlite missing' }, async () => {
  const { db, env } = await setup();
  const { handleRpc } = await import(src('mcp.js'));
  const fires = [];
  const runEnv = { ...env, BOARD_RUNS: JSON.stringify({ harbor: 'trig_f' }), RUN_TOKEN_HARBOR: 'tokf',
    fetchImpl: async (url, init) => { fires.push(JSON.parse(init.body).text); return { ok: true, status: 200, json: async () => ({ claude_code_session_url: `https://claude.ai/code/session_${fires.length}` }) }; } };
  const tool = async (who, name, args) => {
    const out = await handleRpc(runEnv, who, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const res = out.json.result;
    if (res.isError) throw new Error(res.content[0].text);
    return JSON.parse(res.content[0].text);
  };
  const card = (id) => JSON.parse(db.raw.prepare('SELECT data FROM board_tasks WHERE id = ?').get(id).data);
  await tool('owner', 'pause_board', { board: 'harbor', paused: true });
  const n = await tool('owner', 'nudge_card', { key: 'HBR-1' });
  assert.deepEqual([n.heldPaused, n.board], [true, 'harbor']);
  await tool('owner', 'add_comment', { key: 'HBR-1', text: '@lane1 please look at this' });
  assert.deepEqual(fires, [], 'nothing fired while paused');
  let c = card('f1');
  assert.ok(c.nudgedAt);
  assert.equal(c.pokedAt, '');
  assert.equal(c.mention.to, 'lane1');
  assert.ok(!c.mention.triedAt && !c.mention.answeredAt, 'the question is open and untried');
  const resumed = await tool('owner', 'pause_board', { board: 'harbor', paused: false });
  assert.deepEqual(resumed.queued, ['HBR-1 Start queued', 'HBR-1 @lane1 question waiting']);
  assert.deepEqual(fires, [], 'resume replays nothing by itself');
  await tool('owner', 'add_comment', { key: 'HBR-1', text: 'back on' });
  assert.deepEqual(fires, ['mention: HBR-1'], 'the next comment wakes the queued question once');
  await tool('owner', 'nudge_card', { key: 'HBR-1' });
  assert.deepEqual(fires, ['mention: HBR-1', 'card: HBR-1'], 'the next Start fires once');
  c = card('f1');
  assert.equal(c.evidence.start.state, 'acknowledged');
});

test('TASK-66 review finding 1: work fired just before a pause is not stranded and resume names it', { skip: !sqlite && 'node:sqlite missing' }, async () => {
  const { db, env } = await setup();
  const { handleRpc } = await import(src('mcp.js'));
  const fires = [];
  const runEnv = { ...env, BOARD_RUNS: JSON.stringify({ harbor: 'trig_f' }), RUN_TOKEN_HARBOR: 'tokf',
    fetchImpl: async (url, init) => { fires.push(JSON.parse(init.body).text); return { ok: true, status: 200, json: async () => ({ claude_code_session_url: `https://claude.ai/code/session_${fires.length}` }) }; } };
  const tool = async (who, name, args) => {
    const out = await handleRpc(runEnv, who, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const res = out.json.result;
    if (res.isError) throw new Error(res.content[0].text);
    return JSON.parse(res.content[0].text);
  };
  await tool('owner', 'nudge_card', { key: 'HBR-1' });
  await tool('owner', 'add_comment', { key: 'HBR-1', text: '@lane1 one question' });
  assert.deepEqual(fires, ['card: HBR-1', 'mention: HBR-1'], 'both fired before the pause');
  const paused = await tool('owner', 'pause_board', { board: 'harbor', paused: true });
  assert.deepEqual(paused.queued, ['HBR-1 Start fired before the pause, run not yet claimed', 'HBR-1 @lane1 woken before the pause, not yet answered']);
  const card = JSON.parse(db.raw.prepare('SELECT data FROM board_tasks WHERE id = ?').get('f1').data);
  assert.equal(card.evidence.start.state, 'acknowledged', 'a paused Board run may still take this card');
  assert.equal(card.mention.state, 'acknowledged', 'and this question');
  const resumed = await tool('owner', 'pause_board', { board: 'harbor', paused: false });
  assert.deepEqual(resumed.queued, paused.queued);
  assert.deepEqual(fires, ['card: HBR-1', 'mention: HBR-1'], 'nothing refired');
});

