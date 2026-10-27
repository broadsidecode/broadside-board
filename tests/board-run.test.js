'use strict';

// Nudge starts the board's cloud run (run.js): fire the routine with the card key, record the run link, set pokedAt.
//   node --test tests/board-run.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const src = (f) => pathToFileURL(path.join(__dirname, '..', 'worker', 'src', f)).href;

function fakeDb(seed, boards = {}) {
  const rows = new Map(seed.map((r) => [r.id, { ...r }]));
  const stmt = (sql) => {
    let args = [];
    const api = {
      bind(...a) { args = a; return api; },
      async all() { return { results: [] }; },
      async first() {
        if (/FROM board_tasks WHERE id = \?/.test(sql)) return rows.get(args[0]) || null;
        if (/FROM board_tasks WHERE key = \?/.test(sql)) return [...rows.values()].find((r) => JSON.parse(r.data).key === args[0]) || null;
        if (/FROM board_boards WHERE id = \?/.test(sql)) return boards[args[0]] ? { id: args[0], version: 1, updated_at: '', data: JSON.stringify(boards[args[0]]) } : null;
        return null;
      },
      async run() {
        if (/^UPDATE board_tasks SET board/.test(sql)) {
          const id = args[args.length - 1]; const r = rows.get(id);
          if (r.version !== args[6]) throw new Error('NOT NULL constraint failed: board_tasks.version');
          rows.set(id, { ...r, data: args[5], version: r.version + 1 });
        }
        return { meta: { changes: 1 } };
      },
    };
    return api;
  };
  const db = { rows, prepare: stmt, batches: 0, failBatchAt: 0 };
  db.batch = async (list) => {
    db.batches++;
    if (db.batches === db.failBatchAt) throw new Error('D1_ERROR: interrupted after provider ack');
    for (const s of list) await s.run();
    return list.map(() => ({ meta: { changes: 1 } }));
  };
  return db;
}

const card = (extra) => ({ id: 'c1', version: 2, updated_at: '2026-10-24T05:00:00Z', data: JSON.stringify({
  board: 'acme-plumbing', key: 'TDN-1', title: 'Pie case image', status: 'todo', kind: 'agent', lane: 'lane1',
  nudgedAt: '2026-10-24T05:00:00Z', pokedAt: '', history: [], ...extra }) });
const ENV = { BOARD_RUNS: JSON.stringify({ 'acme-plumbing': 'trig_abc' }), RUN_TOKEN_ACME_PLUMBING: 'tok' };

test('runTarget needs both the routine id and the board token', async () => {
  const { runTarget } = await import(src('run.js'));
  assert.deepEqual(runTarget(ENV, 'acme-plumbing'), { id: 'trig_abc', token: 'tok' });
  assert.equal(runTarget({ BOARD_RUNS: ENV.BOARD_RUNS }, 'acme-plumbing'), null);
  assert.equal(runTarget(ENV, 'riverside-bakery-test'), null);
  assert.equal(runTarget({ BOARD_RUNS: 'not json', RUN_TOKEN_ACME_PLUMBING: 'tok' }, 'acme-plumbing'), null);
});

test('startRun fires with the card key, records the run link and sets pokedAt', async () => {
  const { startRun } = await import(src('run.js'));
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ claude_code_session_url: 'https://claude.ai/code/session_1' }) }; };
  const db = fakeDb([card({})]);
  const r = await startRun({ ...ENV, fetchImpl }, db, 'owner', 'c1');
  assert.deepEqual(r, { run: 'https://claude.ai/code/session_1' });
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/claude_code/routines/trig_abc/fire');
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'card: TDN-1' });
  const after = JSON.parse(db.rows.get('c1').data);
  assert.ok(after.pokedAt);
  assert.equal(after.evidence.relay, 'https://claude.ai/code/session_1');
  assert.equal(after.evidence.run, '');
  assert.equal(after.evidence.result, null);
  assert.match(after.history.at(-1).what, /^run started by /);
});

test('startRun skips cards that are not nudged, already picked up, on hold, or on a board with no routine', async () => {
  const { startRun } = await import(src('run.js'));
  const fetchImpl = async () => { throw new Error('should not fire'); };
  for (const extra of [{ nudgedAt: '' }, { pokedAt: 'x' }, { hold: true }, { kind: 'human' }, { status: 'doing' }, { board: 'harbor-cafe' }]) {
    assert.equal(await startRun({ ...ENV, fetchImpl }, fakeDb([card(extra)]), 'owner', 'c1'), null);
  }
});

test('a failed fire keeps the nudge and says why', async () => {
  const { startRun } = await import(src('run.js'));
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const db = fakeDb([card({})]);
  assert.deepEqual(await startRun({ ...ENV, fetchImpl }, db, 'owner', 'c1'), { error: 'HTTP 401' });
  const after = JSON.parse(db.rows.get('c1').data);
  assert.equal(after.pokedAt, '');
  assert.match(after.history.at(-1).what, /run did not start \(HTTP 401\)/);
});

test('two concurrent Starts claim once before the routine fires', async () => {
  const { startRun } = await import(src('run.js'));
  const db = fakeDb([card({})]);
  let fires = 0;
  const env = { ...ENV, fetchImpl: async () => { fires++; return { ok: true, status: 200, json: async () => ({ claude_code_session_url: 'https://claude.ai/code/session_once' }) }; } };
  await Promise.allSettled([startRun(env, db, 'owner', 'c1'), startRun(env, db, 'owner', 'c1')]);
  assert.equal(fires, 1);
  assert.match(JSON.parse(db.rows.get('c1').data).evidence.start.id, /^[0-9a-f-]{36}$/);
});

test('a repeated nudge cannot erase the active Start claim', async () => {
  const { startRun } = await import(src('run.js'));
  const { writeTask } = await import(src('store.js'));
  const db = fakeDb([card({})]);
  let fires = 0;
  const env = { ...ENV, fetchImpl: async () => { fires++; return { ok: true, status: 200, json: async () => ({ claude_code_session_url: 'https://claude.ai/code/session_once' }) }; } };
  await startRun(env, db, 'owner', 'c1');
  const before = JSON.parse(db.rows.get('c1').data);
  // A connector's nudge is refused outright now; Owner's still meets the Start claim rule.
  await assert.rejects(writeTask(db, 'agent', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data: { nudgedAt: new Date().toISOString(), pokedAt: '' } }), (e) => e.status === 403 && /read only for agent/.test(e.message));
  await assert.rejects(writeTask(db, 'owner', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data: { nudgedAt: new Date().toISOString(), pokedAt: '' } }), (e) => e.status === 403 && /Start claim/.test(e.message));
  assert.equal(JSON.parse(db.rows.get('c1').data).pokedAt, before.pokedAt);
  const repeat = await startRun(env, db, 'owner', 'c1');
  assert.equal(repeat.operationId, before.evidence.start.id);
  assert.equal(repeat.resumed, true);
  assert.equal(fires, 1);
});

test('lost card write after provider acknowledgment leaves the claim and a retry does not refire', async () => {
  const { startRun } = await import(src('run.js'));
  const db = fakeDb([card({})]);
  db.failBatchAt = 2;
  let fires = 0;
  const env = { ...ENV, fetchImpl: async () => { fires++; return { ok: true, status: 200, json: async () => ({ claude_code_session_url: 'https://claude.ai/code/session_once' }) }; } };
  await assert.rejects(startRun(env, db, 'owner', 'c1'), /interrupted after provider ack/);
  const claimed = JSON.parse(db.rows.get('c1').data);
  assert.ok(claimed.pokedAt && claimed.evidence.start.id);
  const repeat = await startRun(env, db, 'owner', 'c1');
  assert.deepEqual({ pending: repeat.pending, operationId: repeat.operationId, state: repeat.state }, { pending: true, operationId: claimed.evidence.start.id, state: 'firing' });
  assert.equal(fires, 1);
});

test('ambiguous network failure holds the claim and does not refire', async () => {
  const { startRun } = await import(src('run.js'));
  const db = fakeDb([card({})]);
  let fires = 0;
  const env = { ...ENV, fetchImpl: async () => { fires++; throw new Error('socket hang up'); } };
  assert.deepEqual(await startRun(env, db, 'owner', 'c1'), { error: 'socket hang up' });
  assert.ok(JSON.parse(db.rows.get('c1').data).pokedAt);
  const repeat = await startRun(env, db, 'owner', 'c1');
  assert.deepEqual({ pending: repeat.pending, state: repeat.state }, { pending: true, state: 'uncertain' });
  assert.equal(repeat.operationId, JSON.parse(db.rows.get('c1').data).evidence.start.id);
  assert.equal(fires, 1);
});

test('a worker cannot delete an uncertain Start claim and a proxy cannot reset it through nudge', async () => {
  const { startRun } = await import(src('run.js'));
  const { writeTask } = await import(src('store.js'));
  const { handleApi } = await import(src('api.js'));
  const db = fakeDb([card({})]);
  let fires = 0;
  const env = { ...ENV, DB: db, SERVICE_PRINCIPALS: JSON.stringify({ 'cloudtd.access': 'cloud-worker@acme-plumbing' }), fetchImpl: async () => { fires++; throw new Error('lost relay acknowledgment'); } };
  await startRun(env, db, 'owner', 'c1');
  const claimed = JSON.parse(db.rows.get('c1').data);
  const req = new Request('https://board.example.com/api/v1/tasks/c1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ifVersion: db.rows.get('c1').version, data: { evidence: { start: { __delete__: true } } } }) });
  // The board is read only for workers: the refusal comes before the Start claim rule.
  await assert.rejects(handleApi(req, env, new URL(req.url), { common_name: 'cloudtd.access' }), (e) => e.status === 403 && /read only for cloud-worker/.test(e.message));
  await assert.rejects(writeTask(db, 'owner', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data: { evidence: { start: { __delete__: true } } } }), (e) => e.status === 403 && /Start claim/.test(e.message));
  assert.equal(JSON.parse(db.rows.get('c1').data).evidence.start.id, claimed.evidence.start.id);
  await assert.rejects(writeTask(db, 'owner', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data: { nudgedAt: new Date().toISOString(), pokedAt: '' } }), (e) => e.status === 403 && /Start claim/.test(e.message));
  const again = await startRun(env, db, 'owner', 'c1');
  assert.equal(again.operationId, claimed.evidence.start.id);
  assert.equal(fires, 1);
});

test('a truthy uncorrelated result or claimed rejected state cannot clear an uncertain Start', async () => {
  const { startRun } = await import(src('run.js'));
  const { writeTask } = await import(src('store.js'));
  const db = fakeDb([card({})]);
  let fires = 0;
  const env = { ...ENV, fetchImpl: async () => { fires++; throw new Error('lost relay acknowledgment'); } };
  await startRun(env, db, 'owner', 'c1');
  const v = () => db.rows.get('c1').version;
  await assert.rejects(writeTask(db, 'owner', { op: 'patch', id: 'c1', ifVersion: v(), data: { evidence: { start: { state: 'rejected' } } } }), (e) => e.status === 403 && /Start claim/.test(e.message));
  await writeTask(db, 'owner', { op: 'patch', id: 'c1', ifVersion: v(), data: { evidence: { result: { label: 'some later work' } } } });
  await assert.rejects(writeTask(db, 'owner', { op: 'patch', id: 'c1', ifVersion: v(), data: { pokedAt: '' } }), (e) => e.status === 403 && /Start claim/.test(e.message));
  await startRun(env, db, 'owner', 'c1');
  assert.equal(fires, 1);
});

// The board is read only for workers since , so Owner writes the completion record in these tests.
test('Owner API Start again fires after a worker records completion of the acknowledged operation', async () => {
  const { startRun } = await import(src('run.js'));
  const { writeTask } = await import(src('store.js'));
  const { handleApi } = await import(src('api.js'));
  const db = fakeDb([card({})]);
  let fires = 0;
  const env = { ...ENV, DB: db, SERVICE_PRINCIPALS: JSON.stringify({ 'owner.access': 'owner' }), fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ claude_code_session_url: `https://claude.ai/code/session_${++fires}` }) }) };
  await startRun(env, db, 'owner', 'c1');
  const first = JSON.parse(db.rows.get('c1').data).evidence.start;
  await writeTask(db, 'owner', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data: { status: 'doing', evidence: { run: 'https://claude.ai/code/session_1' } } });
  await writeTask(db, 'owner', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data: { status: 'todo', evidence: { result: { label: 'Completed prior run', url: 'https://example.test/result', startId: first.id, completedAt: new Date().toISOString() } } } });
  const req = new Request('https://board.example.com/api/v1/tasks/c1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ifVersion: db.rows.get('c1').version, data: { nudgedAt: new Date().toISOString(), pokedAt: '' } }) });
  const out = await handleApi(req, env, new URL(req.url), { common_name: 'owner.access' });
  assert.equal(out.status, 200);
  assert.equal((await out.json()).run, 'https://claude.ai/code/session_2');
  const after = JSON.parse(db.rows.get('c1').data);
  assert.notEqual(after.evidence.start.id, first.id);
  assert.equal(after.evidence.start.state, 'acknowledged');
  assert.equal(after.evidence.result, null);
  assert.equal(fires, 2);
});

test('MCP nudge_card Start again fires only after operation-correlated completion', async () => {
  const { startRun } = await import(src('run.js'));
  const { handleRpc } = await import(src('mcp.js'));
  const db = fakeDb([card({})]);
  let fires = 0;
  const env = { ...ENV, DB: db, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ claude_code_session_url: `https://claude.ai/code/session_${++fires}` }) }) };
  await startRun(env, db, 'owner', 'c1');
  const first = JSON.parse(db.rows.get('c1').data).evidence.start;
  for (const patch of [
    { status: 'doing', evidence: { run: 'https://claude.ai/code/session_1' } },
    { status: 'todo', evidence: { result: { label: 'Completed prior run', url: 'https://example.test/result', startId: first.id, completedAt: new Date().toISOString() } } },
  ]) {
    const update = await handleRpc(env, 'owner', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_card', arguments: { key: 'TDN-1', ifVersion: db.rows.get('c1').version, patch } } });
    assert.equal(update.json.result.isError, undefined, JSON.stringify(update.json));
  }
  const out = await handleRpc(env, 'owner', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nudge_card', arguments: { key: 'TDN-1', action: 'start' } } });
  assert.equal(out.json.result.isError, undefined, JSON.stringify(out.json));
  assert.equal(JSON.parse(out.json.result.content[0].text).run, 'https://claude.ai/code/session_2');
  assert.notEqual(JSON.parse(db.rows.get('c1').data).evidence.start.id, first.id);
  assert.equal(fires, 2);
});

test('an unrelated result or uncertain claim cannot permit Start again through API or MCP', async () => {
  const { startRun } = await import(src('run.js'));
  const { writeTask } = await import(src('store.js'));
  const { handleApi } = await import(src('api.js'));
  const { handleRpc } = await import(src('mcp.js'));
  for (const mode of ['bare', 'wrong-id', 'no-completion', 'no-run', 'still-doing', 'early-completion', 'uncertain']) {
    const db = fakeDb([card({})]);
    let fires = 0;
    const env = { ...ENV, DB: db, SERVICE_PRINCIPALS: JSON.stringify({ 'owner.access': 'owner' }), fetchImpl: async () => { fires++; return mode === 'uncertain' ? Promise.reject(new Error('lost ACK')) : { ok: true, status: 200, json: async () => ({ claude_code_session_url: 'https://claude.ai/code/session_1' }) }; } };
    await startRun(env, db, 'owner', 'c1');
    const first = JSON.parse(db.rows.get('c1').data).evidence.start;
    const result = { label: 'Completed prior run', url: 'https://example.test/result', ...(mode === 'bare' ? {} : { startId: mode === 'wrong-id' ? 'other-operation' : first.id }), ...(mode === 'no-completion' || mode === 'bare' ? {} : { completedAt: mode === 'early-completion' ? '2020-01-01T00:00:00.000Z' : new Date().toISOString() }) };
    await writeTask(db, 'owner', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data: { status: mode === 'still-doing' ? 'doing' : 'todo', evidence: { ...(mode === 'no-run' ? {} : { run: 'https://claude.ai/code/session_1' }), result } } });
    const req = new Request('https://board.example.com/api/v1/tasks/c1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ifVersion: db.rows.get('c1').version, data: { nudgedAt: new Date().toISOString(), pokedAt: '' } }) });
    await assert.rejects(handleApi(req, env, new URL(req.url), { common_name: 'owner.access' }), (e) => e.status === 403 && /Start claim/.test(e.message), mode);
    const out = await handleRpc(env, 'owner', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nudge_card', arguments: { key: 'TDN-1', action: 'start' } } });
    assert.equal(out.json.result.isError, true, mode);
    assert.equal(fires, 1, mode);
    assert.equal(JSON.parse(db.rows.get('c1').data).evidence.start.id, first.id, mode);
  }
});

test('legacy picked-up card without Start operation ID cannot refire through Owner API or MCP', async () => {
  const { handleApi } = await import(src('api.js'));
  const { handleRpc } = await import(src('mcp.js'));
  for (const route of ['api', 'mcp']) {
    const priorPoke = '2026-10-24T05:00:01Z';
    const db = fakeDb([card({ pokedAt: priorPoke, evidence: { result: { label: 'Old result', url: 'https://example.test/old' } } })]);
    let fires = 0;
    const env = { ...ENV, DB: db, SERVICE_PRINCIPALS: JSON.stringify({ 'owner.access': 'owner' }),
      fetchImpl: async () => { fires++; return { ok: true, status: 200, json: async () => ({ claude_code_session_url: 'https://claude.ai/code/unwanted' }) }; } };
    if (route === 'api') {
      const req = new Request('https://board.example.com/api/v1/tasks/c1', { method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ifVersion: db.rows.get('c1').version, data: { nudgedAt: new Date().toISOString(), pokedAt: '' } }) });
      await assert.rejects(handleApi(req, env, new URL(req.url), { common_name: 'owner.access' }), (e) => e.status === 403 && /Start claim/.test(e.message));
    } else {
      const out = await handleRpc(env, 'owner', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nudge_card', arguments: { key: 'TDN-1', action: 'start' } } });
      assert.equal(out.json.result.isError, true);
      assert.match(out.json.result.content[0].text, /Start claim/);
    }
    assert.equal(fires, 0, route);
    const stored = JSON.parse(db.rows.get('c1').data);
    assert.equal(stored.pokedAt, priorPoke, route);
    assert.equal(stored.evidence.start, undefined, route);
  }
});

test('a legacy pickup cannot acquire a fabricated Start ID and completion in a prior API write', async () => {
  const { handleApi } = await import(src('api.js'));
  const { handleRpc } = await import(src('mcp.js'));
  const priorPoke = '2026-10-24T05:00:01Z';
  const db = fakeDb([card({ pokedAt: priorPoke, evidence: {} })]);
  let fires = 0;
  const env = { ...ENV, DB: db, SERVICE_PRINCIPALS: JSON.stringify({ 'owner.access': 'owner' }),
    fetchImpl: async () => { fires++; return { ok: true, status: 200, json: async () => ({ claude_code_session_url: 'https://claude.ai/code/refired' }) }; } };
  const forged = { start: { id: 'forged-op', state: 'acknowledged', claimedAt: priorPoke },
    run: 'https://claude.ai/code/old', result: { startId: 'forged-op', completedAt: '2026-10-24T05:00:02Z' } };
  const req = new Request('https://board.example.com/api/v1/tasks/c1', { method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ifVersion: db.rows.get('c1').version, data: { evidence: forged } }) });
  await assert.rejects(handleApi(req, env, new URL(req.url), { common_name: 'owner.access' }), (e) => e.status === 403 && /Start claim/.test(e.message));
  const { writeTask } = await import(src('store.js'));
  await writeTask(db, 'owner', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version,
    data: { evidence: { run: forged.run, result: forged.result } } });
  await assert.rejects(writeTask(db, 'owner', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version,
    data: { evidence: { start: forged.start } } }), (e) => e.status === 403 && /Start claim/.test(e.message));
  const out = await handleRpc(env, 'owner', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nudge_card', arguments: { key: 'TDN-1', action: 'start' } } });
  assert.equal(out.json.result.isError, true);
  assert.equal(fires, 0);
  assert.equal(JSON.parse(db.rows.get('c1').data).pokedAt, priorPoke);
  assert.equal(JSON.parse(db.rows.get('c1').data).evidence.start, undefined);
});

test('a first-ever Start still fires once through Owner API and MCP', async () => {
  const { handleApi } = await import(src('api.js'));
  const { handleRpc } = await import(src('mcp.js'));
  for (const route of ['api', 'mcp']) {
    const db = fakeDb([card({ nudgedAt: '', pokedAt: '', evidence: {} })]);
    let fires = 0;
    const env = { ...ENV, DB: db, SERVICE_PRINCIPALS: JSON.stringify({ 'owner.access': 'owner' }),
      fetchImpl: async () => { fires++; return { ok: true, status: 200, json: async () => ({ claude_code_session_url: 'https://claude.ai/code/first' }) }; } };
    if (route === 'api') {
      const req = new Request('https://board.example.com/api/v1/tasks/c1', { method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ifVersion: db.rows.get('c1').version, data: { nudgedAt: new Date().toISOString(), pokedAt: '' } }) });
      const out = await handleApi(req, env, new URL(req.url), { common_name: 'owner.access' });
      assert.equal(out.status, 200);
    } else {
      const out = await handleRpc(env, 'owner', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nudge_card', arguments: { key: 'TDN-1', action: 'start' } } });
      assert.equal(out.json.result.isError, undefined, JSON.stringify(out.json));
    }
    assert.equal(fires, 1, route);
    assert.equal(JSON.parse(db.rows.get('c1').data).evidence.start.state, 'acknowledged', route);
  }
});

test('runTarget can wire one lane of a board: main:worker fires, other main lanes do not', async () => {
  const { runTarget } = await import(src('run.js'));
  const env = { BOARD_RUNS: JSON.stringify({ 'main:worker': 'trig_main' }), RUN_TOKEN_MAIN: 'tok' };
  assert.deepEqual(runTarget(env, 'main', 'worker'), { id: 'trig_main', token: 'tok' });
  assert.equal(runTarget(env, 'main', 'lane2'), null);
  assert.equal(runTarget(env, 'main'), null);
});

test('TASK-66: a paused tab fires no Start and no mention wake, and leaves both queued', async () => {
  const { startRun, mentionRun } = await import(src('run.js'));
  const fetchImpl = async () => { throw new Error('should not fire while paused'); };
  const paused = { 'acme-plumbing': { name: 'Acme Plumbing', prefix: 'TDN', paused: true } };
  const db = fakeDb([card({})], paused);
  assert.deepEqual(await startRun({ ...ENV, fetchImpl }, db, 'owner', 'c1'), { heldPaused: true, board: 'acme-plumbing' });
  let after = JSON.parse(db.rows.get('c1').data);
  assert.equal(after.pokedAt, '', 'the Start is not claimed');
  assert.ok(after.nudgedAt, 'the nudge stays');
  assert.equal(after.evidence, undefined);
  assert.match(after.history.at(-1).what, /board acme-plumbing is paused; the Start stays queued/);
  const mention = { to: 'lane1', by: 'agent', at: '2026-10-25T05:00:00Z', questionId: 'q1', text: '@lane1 look' };
  const db2 = fakeDb([card({ status: 'doing', mention })], paused);
  assert.deepEqual(await mentionRun({ ...ENV, fetchImpl }, db2, 'owner', 'c1'), { heldPaused: true, board: 'acme-plumbing' });
  after = JSON.parse(db2.rows.get('c1').data);
  assert.deepEqual(after.mention, mention, 'the question is untouched, not tried and not answered');
  assert.match(after.history.at(-1).what, /not woken: board acme-plumbing is paused/);
});

test('TASK-66: a pause on another tab, or paused false, changes nothing', async () => {
  const { startRun } = await import(src('run.js'));
  for (const boards of [{ harbor: { name: 'Harbor', paused: true } }, { 'acme-plumbing': { name: 'Acme Plumbing', paused: false } }]) {
    let fired = 0;
    const fetchImpl = async () => { fired++; return { ok: true, status: 200, json: async () => ({ claude_code_session_url: 'https://claude.ai/code/session_2' }) }; };
    const db = fakeDb([card({})], boards);
    assert.deepEqual(await startRun({ ...ENV, fetchImpl }, db, 'owner', 'c1'), { run: 'https://claude.ai/code/session_2' });
    assert.equal(fired, 1);
  }
});

test('TASK-66: @worker on any tab follows the main tab pause, not the card tab', async () => {
  const { mentionRun } = await import(src('run.js'));
  const env = { BOARD_RUNS: JSON.stringify({ 'main:worker': 'trig_j' }), RUN_TOKEN_MAIN: 'tokm' };
  const mention = { to: 'worker', by: 'agent', at: '2026-10-25T05:00:00Z', questionId: 'q2', text: '@worker look' };
  const fetchImpl = async () => { throw new Error('should not fire while main is paused'); };
  const db = fakeDb([card({ mention })], { main: { name: 'Main', paused: true } });
  assert.deepEqual(await mentionRun({ ...env, fetchImpl }, db, 'owner', 'c1'), { heldPaused: true, board: 'main' });
  let fired = 0;
  const ok = async () => { fired++; return { ok: true, status: 200, json: async () => ({ claude_code_session_url: 'https://claude.ai/code/session_3' }) }; };
  const db2 = fakeDb([card({ mention })], { 'acme-plumbing': { name: 'Acme Plumbing', paused: true } });
  assert.deepEqual(await mentionRun({ ...env, fetchImpl: ok }, db2, 'owner', 'c1'), { run: 'https://claude.ai/code/session_3' });
  assert.equal(fired, 1);
});

// Start over the line (): the card goes to the project's coordinator through the start webhook
// first; a tab the line has no project for falls back to the relay routine; a tab with neither is a definite no.
const LINE = { START_WEBHOOK_URL: 'https://hooks.example.com', START_WEBHOOK_KEY: 'start-key-for-tests', BOARD_URL: 'https://board.example.com' };

test('startRun sends the card over the line first and records the coordinator link', async () => {
  const { startRun, webhookStartWired } = await import(src('run.js'));
  assert.equal(webhookStartWired(LINE), true);
  assert.equal(webhookStartWired({ START_WEBHOOK_URL: LINE.START_WEBHOOK_URL }), false);
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ id: 'msg_1', state: 'delivered', relay: 'https://claude.ai/code/cse_coord' }) }; };
  const db = fakeDb([card({})]);
  const r = await startRun({ ...ENV, ...LINE, fetchImpl }, db, 'owner', 'c1');
  assert.deepEqual(r, { run: 'https://claude.ai/code/cse_coord' });
  assert.equal(calls.length, 1, 'no relay fire when the line took it');
  assert.equal(calls[0].url, 'https://hooks.example.com/start');
  assert.equal(calls[0].init.headers.authorization, 'Bearer start-key-for-tests');
  assert.deepEqual(JSON.parse(calls[0].init.body), { board: 'acme-plumbing', lane: 'lane1', key: 'TDN-1', title: 'Pie case image', by: 'owner', link: 'https://board.example.com/#TDN-1' });
  const after = JSON.parse(db.rows.get('c1').data);
  assert.equal(after.evidence.relay, 'https://claude.ai/code/cse_coord');
  assert.match(after.history.at(-1).what, /run started by .* over the start webhook, coordinator: /);
});

test('a tab the line does not know falls back to the relay routine, and one with neither is a definite no', async () => {
  const { startRun } = await import(src('run.js'));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.endsWith('/start')) return { ok: false, status: 404, json: async () => ({ error: 'no line project' }) };
    return { ok: true, status: 200, json: async () => ({ claude_code_session_url: 'https://claude.ai/code/session_relay' }) };
  };
  const db = fakeDb([card({})]);
  assert.deepEqual(await startRun({ ...ENV, ...LINE, fetchImpl }, db, 'owner', 'c1'), { run: 'https://claude.ai/code/session_relay' });
  assert.deepEqual(calls, ['https://hooks.example.com/start', 'https://api.anthropic.com/v1/claude_code/routines/trig_abc/fire']);

  const db2 = fakeDb([card({ board: 'no-relay' })]);
  const r = await startRun({ ...ENV, ...LINE, fetchImpl }, db2, 'owner', 'c1');
  assert.equal(r.error, 'no line project and no routine for this tab');
  assert.equal(JSON.parse(db2.rows.get('c1').data).pokedAt, '', 'the nudge stays for a tab with neither');
});
