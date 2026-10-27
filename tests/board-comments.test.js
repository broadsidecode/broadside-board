'use strict';

// Card comments (): a thread on every card. The server stamps each new comment with the
// writer and the time, keeps the thread append only, and add_comment writes one through the connector.
// add_card and release_card take a lane, so a Worker card can be made from the connector.
//   node --test tests/board-comments.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const src = (f) => pathToFileURL(path.join(__dirname, '..', 'worker', 'src', f)).href;

// One card table in memory: enough for getTaskByKey, getTask, the patch UPDATE and the counter.
function fakeDb(seed) {
  const rows = new Map(seed.map((r) => [r.id, { ...r }]));
  let counter = 54;
  const stmt = (sql) => {
    let args = [];
    const api = {
      sql,
      bind(...a) { args = a; return api; },
      async all() { return { results: /FROM board_tasks/.test(sql) ? [...rows.values()] : [] }; },
      async first() {
        if (/FROM board_tasks WHERE id = \?/.test(sql)) return rows.get(args[0]) || null;
        if (/FROM board_tasks WHERE key = \?/.test(sql)) return [...rows.values()].find((r) => JSON.parse(r.data).key === args[0]) || null;
        if (/FROM board_boards WHERE id = \?/.test(sql)) return args[0] === 'main' ? { id: 'main', data: JSON.stringify({ name: 'Main', prefix: 'KIT' }), version: 1, updated_at: '' } : null;
        if (/board_counters/.test(sql)) return { prefix: 'KIT', next: ++counter, number: counter, version: 1 };
        return null;
      },
      async run() {
        if (/^UPDATE board_tasks SET board/.test(sql)) {
          const id = args[args.length - 1]; const r = rows.get(id);
          if (r.version !== args[6]) throw new Error('NOT NULL constraint failed: board_tasks.version');
          rows.set(id, { ...r, data: args[5], version: r.version + 1 });
        }
        if (/^INSERT INTO board_tasks/.test(sql)) rows.set(args[0], { id: args[0], data: args[6], version: args[7], updated_at: args[8] });
        return { meta: { changes: 1 } };
      },
    };
    return api;
  };
  const db = { rows, prepare: stmt, batches: 0, failBatchAt: 0 };
  db.batch = async (list) => {
    db.batches++;
    if (db.batches === db.failBatchAt) throw new Error('D1_ERROR: interrupted after mention ack');
    for (const s of list) await s.run();
    return list.map((s) => (/RETURNING next/.test(s.sql) ? { results: [{ number: ++counter, version: 1 }] } : { meta: { changes: 1 } }));
  };
  return db;
}

const card = (extra) => ({ id: 'c1', version: 3, updated_at: '2026-10-25T05:00:00Z', data: JSON.stringify({
  board: 'main', key: 'TASK-9', title: 'Hours on the footer', status: 'todo', kind: 'agent', lane: 'lane1', history: [], ...extra }) });

test('lib: a new comment is stamped with the writer, never the name it claims', async () => {
  const lib = await import(src('lib.js'));
  const before = { comments: [{ at: '2026-10-25T01:00:00Z', by: 'owner', text: 'Use the winter hours' }] };
  const out = lib.stampCard(before, { comments: [...before.comments, { by: 'owner', at: '1999-01-01', text: '  Done, see the preview  ' }] }, 'agent');
  assert.equal(out.comments.length, 2);
  assert.deepEqual(out.comments[0], before.comments[0]);
  assert.equal(out.comments[1].by, 'agent');
  assert.equal(out.comments[1].text, 'Done, see the preview');
  assert.notEqual(out.comments[1].at, '1999-01-01');
  const empty = lib.stampCard(before, { comments: [...before.comments, { text: '   ' }] }, 'agent');
  assert.equal(empty.comments.length, 1, 'a blank comment is dropped');
});

test('lib: comments are append only and capped', async () => {
  const lib = await import(src('lib.js'));
  const c = [{ at: 'a', by: 'owner', text: 'one' }, { at: 'b', by: 'reviewer', text: 'two' }];
  assert.equal(lib.writeProblem({ comments: c }, { comments: [...c, { at: 'c', by: 'builder', text: 'three' }] }, 'builder'), null);
  assert.equal(lib.writeProblem({ comments: c }, { title: 'a put that drops the thread' }, 'builder'), 'comments are append only: add a comment, never change or remove one');
  assert.equal(lib.writeProblem({}, { title: 'no thread yet' }, 'builder'), null);
  assert.match(lib.writeProblem({ comments: c }, { comments: [c[0]] }, 'owner'), /append only/);
  assert.match(lib.writeProblem({ comments: c }, { comments: [{ ...c[0], text: 'edited' }, c[1]] }, 'owner'), /append only/);
  const many = Array.from({ length: lib.COMMENTS_MAX + 1 }, (_, i) => ({ at: String(i), by: 'x', text: 't' }));
  assert.match(lib.writeProblem({}, { comments: many }, 'owner'), /at most/);
  assert.match(lib.mcpPatchProblem({}, { comments: [] }, 'agent'), /add_comment/);
});

test('mcp: add_comment appends one stamped comment and leaves the rest of the card alone', async () => {
  const mcp = await import(src('mcp.js'));
  const db = fakeDb([card({ comments: [{ at: '2026-10-25T01:00:00Z', by: 'owner', text: 'Use the winter hours' }] })]);
  const env = { DB: db, HANDBOOK: 'x' };
  const call = async (name, args, who = 'owner') => (await mcp.handleRpc(env, who, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).json;
  // Read only for everyone but Owner and Agent, the board's clerk: another connector's comment is refused.
  for (const who of ['agent3', 'agent2']) {
    const refused = await call('add_comment', { key: 'TASK-9', text: 'Which page?' }, who);
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, new RegExp(`403: the board is read only for ${who}`));
  }
  assert.equal(JSON.parse(db.rows.get('c1').data).comments.length, 1);
  const clerk = await call('add_comment', { key: 'TASK-9', text: 'Cody opened the pull request' }, 'agent');
  assert.ok(!clerk.error && !clerk.result.isError, JSON.stringify(clerk));
  assert.equal(JSON.parse(db.rows.get('c1').data).comments[1].by, 'agent');
  const r = await call('add_comment', { key: 'TASK-9', text: 'Which page, home or contact?' });
  assert.ok(!r.error && !r.result.isError, JSON.stringify(r));
  const data = JSON.parse(db.rows.get('c1').data);
  assert.equal(data.comments.length, 3);
  assert.deepEqual([data.comments[2].by, data.comments[2].text], ['owner', 'Which page, home or contact?']);
  assert.equal(data.title, 'Hours on the footer');
  const blank = await call('add_comment', { key: 'TASK-9', text: '  ' });
  assert.ok(blank.error || blank.result.isError);
  assert.ok(mcp.TOOLS.some((t) => t.name === 'add_comment'));
  assert.match(mcp.BOARD_INSTRUCTIONS, /add_comment/);
});

test('mcp: add_card and release_card take a lane; lane1 stays the default and a bad lane is refused', async () => {
  const mcp = await import(src('mcp.js'));
  const db = fakeDb([card()]);
  const env = { DB: db, HANDBOOK: 'x' };
  const call = async (name, args, who = 'owner') => (await mcp.handleRpc(env, who, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).json;
  // Only Owner and Agent add cards; another connector is refused before a ticket number is taken. Release stays Owner's.
  const refused = await call('add_card', { board: 'main', title: 'Not allowed', kind: 'agent', lane: 'worker' }, 'agent3');
  assert.match(refused.result.content[0].text, /403: the board is read only for agent3/);
  assert.match((await call('release_card', { key: 'TASK-9', lane: 'lane2' }, 'agent')).result.content[0].text, /read only for agent on release/);
  const clerkCard = await call('add_card', { board: 'main', title: 'Track the footer fix', kind: 'agent', lane: 'worker' }, 'agent');
  assert.ok(!clerkCard.error && !clerkCard.result.isError, JSON.stringify(clerkCard));
  assert.match((await call('add_card', { board: 'main', title: 'Ship it', kind: 'production' }, 'agent')).result.content[0].text, /names its tier/);
  assert.match((await call('add_card', { board: 'main', title: 'Ship it', kind: 'production', risk: 3, riskWhy: 'customer first launch' }, 'agent')).result.content[0].text, /carries its go ask/);
  assert.equal((await call('add_card', { board: 'main', title: 'Ship it', kind: 'production', risk: 3, riskWhy: 'customer first launch', ask: { kind: 'go', text: 'Go for production' } }, 'agent')).result.isError, undefined);
  const made = await call('add_card', { board: 'main', title: 'Fix the vault names tool', kind: 'agent', lane: 'worker' });
  assert.ok(!made.error && !made.result.isError, JSON.stringify(made));
  const added = [...db.rows.values()].map((r) => JSON.parse(r.data)).find((c) => c.title === 'Fix the vault names tool');
  assert.equal(added.lane, 'worker');
  const bad = await call('add_card', { board: 'main', title: 'x', kind: 'agent', lane: 'nobody' });
  assert.ok(bad.error || bad.result.isError);
  const rel = await call('release_card', { key: 'TASK-9', lane: 'lane2' });
  assert.ok(!rel.error && !rel.result.isError, JSON.stringify(rel));
  assert.equal(JSON.parse(db.rows.get('c1').data).lane, 'lane2');
});

// ---- @mentions ()
const ENV_RUNS = { BOARD_RUNS: JSON.stringify({ 'main:worker': 'trig_j', 'acme-plumbing': 'trig_t' }), RUN_TOKEN_MAIN: 'tm', RUN_TOKEN_ACME_PLUMBING: 'tt' };
function firing(env, calls) {
  return { ...env, fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ claude_code_session_url: 'https://claude.ai/code/cse_x' }) }; } };
}

test('lib: an @name from Owner or his connectors opens a mention; an answer closes it; nobody can patch one', async () => {
  const lib = await import(src('lib.js'));
  assert.equal(lib.mentionIn('@worker which section?'), 'worker');
  assert.equal(lib.mentionIn('see owner@worker.com'), '');
  assert.equal(lib.mentionIn('@workerx'), '');
  const asked = lib.stampCard({ comments: [] }, { comments: [{ text: 'Not sure about this, @Worker which section?' }] }, 'owner');
  assert.deepEqual([asked.mention.to, asked.mention.by, asked.mention.answeredAt], ['worker', 'owner', '']);
  const fromWorker = lib.stampCard({ comments: [] }, { comments: [{ text: '@worker help' }] }, 'cloud-worker');
  assert.equal(fromWorker.mention, undefined, 'a worker cannot wake another agent');
  const forged = lib.stampCard(asked, { ...asked, mention: { to: 'lane1', answeredAt: 'x' } }, 'agent');
  assert.deepEqual(forged.mention, asked.mention, 'a client mention field is ignored');
  const answered = lib.stampCard(asked, { comments: [...asked.comments, { text: 'The Setup section.', answers: true, answerId: asked.mention.questionId }] }, 'agent2');
  assert.ok(answered.mention.answeredAt);
  assert.equal(answered.comments[1].answers, true);
  assert.equal(answered.comments[1].answering, 'worker', 'the answer says who was asked');
  assert.equal(lib.openMention(answered), null);
  const reply = lib.stampCard(asked, { comments: [...asked.comments, { text: 'Asked @lane1 too', answers: true, answerId: asked.mention.questionId }] }, 'agent2');
  assert.equal(reply.mention.to, 'worker', 'an answer never opens a new mention');
  assert.match(lib.mcpPatchProblem({}, { mention: null }, 'owner'), /never patched/);
  assert.match(lib.waitingLine({ key: 'TASK-9', status: 'review', title: 't', mention: asked.mention }), /\[asked @worker: Not sure/);
});

test('api: a page comment with @worker on a main card in review wakes the Worker project without touching the card state', async () => {
  const { handleApi } = await import(src('api.js'));
  const db = fakeDb([card({ status: 'review', lane: 'worker', evidence: { run: 'https://claude.ai/code/old' } })]);
  const calls = [];
  const env = firing({ DB: db, ...ENV_RUNS, EMAIL_PRINCIPALS: '{}', SERVICE_PRINCIPALS: '{}' }, calls);
  const req = new Request('https://board.example.com/api/v1/tasks/c1', { method: 'PATCH', body: JSON.stringify({ ifVersion: 3, data: { comments: [{ text: '@worker which README section?' }] } }) });
  const res = await handleApi(req, env, new URL(req.url), { email: 'owner', sub: 'owner' });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(body.mention, { run: 'https://claude.ai/code/cse_x' });
  assert.match(calls[0].url, /routines\/trig_j\/fire$/);
  const data = JSON.parse(db.rows.get('c1').data);
  assert.equal(data.status, 'review');
  assert.equal(data.evidence.run, 'https://claude.ai/code/old');
  assert.ok(data.mention.firedAt && data.mention.triedAt);
  assert.match(data.history.at(-1).what, /@worker woken by/);
});

test('mcp: @lane1 on main is not wired (history says so, one try); @agent never fires; open_mentions and answers', async () => {
  const mcp = await import(src('mcp.js'));
  const db = fakeDb([card()]);
  const calls = [];
  const env = firing({ DB: db, HANDBOOK: 'x', ...ENV_RUNS }, calls);
  const call = async (name, args, who = 'owner') => {
    const r = (await mcp.handleRpc(env, who, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).json;
    assert.ok(!r.error && !r.result.isError, JSON.stringify(r));
    return r.result.content[0].text;
  };
  await call('add_comment', { key: 'TASK-9', text: '@lane1 is this the winter hours?' });
  let data = JSON.parse(db.rows.get('c1').data);
  assert.equal(calls.length, 0);
  assert.equal(data.mention.unwired, true);
  assert.match(data.history.at(-1).what, /no cloud run is wired for main and lane1/);
  const lines = data.history.length;
  await call('add_comment', { key: 'TASK-9', text: 'also the footer' });
  assert.equal(JSON.parse(db.rows.get('c1').data).history.length, lines, 'one try per mention');
  assert.match(await call('open_mentions', { board: 'main' }), /TASK-9 \[todo\] Hours on the footer: @lane1 asked by owner/);
  assert.match(await call('open_mentions', { board: 'main', lane: 'worker' }), /No open mentions on main for worker/);
  await call('add_comment', { key: 'TASK-9', text: 'Yes, winter hours.', answers: true, answerId: data.mention.questionId }, 'owner');
  assert.match(await call('open_mentions', { board: 'main' }), /No open mentions/);
  await call('add_comment', { key: 'TASK-9', text: '@agent can you check with the customer?' }, 'owner');
  assert.equal(calls.length, 0, '@agent never fires a run');
  assert.match(await call('whats_waiting', {}), /TASK-9 .*\[asked @agent: @agent can you check/);
  assert.match(await call('open_mentions', { board: 'main', lane: 'agent' }), /@agent asked by owner/);
  assert.match(await call('open_mentions', { board: 'main' }), /No open mentions/, 'project runs never take a mention for Agent');
});

test('mcp: @worker on a customer tab wakes the Worker project; the customer run never takes it; a second question waits its turn', async () => {
  const mcp = await import(src('mcp.js'));
  const db = fakeDb([card({ board: 'acme-plumbing', key: 'TDN-3', status: 'review' })]);
  const calls = [];
  const env = firing({ DB: db, HANDBOOK: 'x', ...ENV_RUNS }, calls);
  const call = async (name, args, who = 'owner') => {
    const r = (await mcp.handleRpc(env, who, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).json;
    assert.ok(!r.error && !r.result.isError, JSON.stringify(r));
    return r.result.content[0].text;
  };
  await call('add_comment', { key: 'TDN-3', text: '@worker why is this in review?' }, 'owner');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /routines\/trig_j\/fire$/, 'the Worker project, not the Acme Plumbing one');
  assert.match(await call('open_mentions', { board: 'acme-plumbing' }), /No open mentions on acme-plumbing/, 'the customer run leaves @worker alone');
  assert.match(await call('open_mentions', { lane: 'worker' }), /^acme-plumbing TDN-3 \[review\] .*@worker asked by owner/);
  await call('add_comment', { key: 'TDN-3', text: '@worker and who approved it?' }, 'owner');
  assert.equal(calls.length, 1, 'the second question does not fire a second run while the first is open');
  assert.match(await call('open_mentions', { lane: 'worker' }), /why is this in review\? \(1 more waiting after this one\)/);
  const firstId = JSON.parse(db.rows.get('c1').data).mention.questionId;
  await call('add_comment', { key: 'TDN-3', text: 'Reviewer passed it.', answers: true, answerId: firstId }, 'owner');
  let m = JSON.parse(db.rows.get('c1').data).mention;
  assert.equal(m.text, '@worker and who approved it?', 'the answer moves the queued question up');
  assert.equal(calls.length, 2, 'and wakes Worker for it');
  assert.equal(m.next, undefined);
  await call('add_comment', { key: 'TDN-3', text: 'Owner approved it.', answers: true, answerId: m.questionId }, 'owner');
  assert.ok(JSON.parse(db.rows.get('c1').data).mention.answeredAt);
  assert.match(await call('open_mentions', { lane: 'worker' }), /No open mentions for worker/);
});

test('mcp: a late answer to A cannot close B, and missing IDs cannot guess a later question', async () => {
  const mcp = await import(src('mcp.js'));
  const db = fakeDb([card({ board: 'acme-plumbing', key: 'TDN-3', status: 'review' })]);
  const calls = [];
  const env = firing({ DB: db, HANDBOOK: 'x', ...ENV_RUNS }, calls);
  const call = async (name, args, who = 'owner') => (await mcp.handleRpc(env, who, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).json;
  const data = () => JSON.parse(db.rows.get('c1').data);
  const good = async (name, args, who) => {
    const r = await call(name, args, who);
    assert.ok(!r.error && !r.result.isError, JSON.stringify(r));
    return r.result.content[0].text;
  };
  await good('add_comment', { key: 'TDN-3', text: '@worker question A?' });
  const a = data().mention.questionId;
  assert.match(a, /^[0-9a-f-]{36}$/);
  assert.match(await good('open_mentions', { lane: 'worker' }), new RegExp(a));
  await good('add_comment', { key: 'TDN-3', text: '@worker question B?' });
  const b = data().mention.next[0].questionId;
  assert.notEqual(a, b, 'two questions in the same clock tick still have distinct IDs');
  await good('add_comment', { key: 'TDN-3', text: 'A answer', answers: true, answerId: a }, 'owner');
  assert.equal(data().mention.questionId, b);
  assert.equal(calls.length, 2);
  const before = db.rows.get('c1').version;
  for (const args of [
    { key: 'TDN-3', text: 'Late A answer', answers: true, answerId: a },
    { key: 'TDN-3', text: 'Old client answer', answers: true },
  ]) {
    const result = await call('add_comment', args, 'owner');
    assert.equal(result.result.isError, true, JSON.stringify(result));
    assert.match(result.result.content[0].text, /409:.*question/i);
    assert.equal(db.rows.get('c1').version, before, 'rejected answer made no card write');
    assert.equal(data().mention.questionId, b);
    assert.equal(data().mention.answeredAt, '');
  }
  assert.equal(calls.length, 2, 'late answers make zero extra provider calls');
  await good('add_comment', { key: 'TDN-3', text: 'B answer', answers: true, answerId: b }, 'owner');
  assert.ok(data().mention.answeredAt);
  assert.equal(data().comments.at(-1).answerId, b);
  assert.equal(calls.length, 2);
});

test('lib: legacy question time is an answer ID, and an ID-free first answer remains supported', async () => {
  const lib = await import(src('lib.js'));
  const legacy = { comments: [{ at: 'old-time', by: 'owner', text: '@worker old?' }], mention: { to: 'worker', at: 'old-time', text: '@worker old?', firedAt: 'old-run', answeredAt: '' } };
  assert.equal(lib.mentionQuestionId(legacy.mention), 'old-time');
  const first = lib.stampCard(legacy, { comments: [...legacy.comments, { text: 'Legacy answer', answers: true }] }, 'agent2');
  assert.ok(first.mention.answeredAt);
  assert.equal(first.comments.at(-1).answerId, 'old-time');
  const explicitly = lib.stampCard(legacy, { comments: [...legacy.comments, { text: 'Explicit legacy answer', answers: true, answerId: 'old-time' }] }, 'agent2');
  assert.ok(explicitly.mention.answeredAt);
});

test('lib: an ID-free late answer cannot close a new question that replaced an unwoken one', async () => {
  const lib = await import(src('lib.js'));
  const a = lib.stampCard({ comments: [] }, { comments: [{ text: '@worker A' }] }, 'owner');
  const b = lib.stampCard(a, { comments: [...a.comments, { text: '@worker B' }] }, 'owner');
  assert.notEqual(a.mention.questionId, b.mention.questionId);
  assert.equal(lib.canAnswerMention(b), false);
  const late = lib.stampCard(b, { comments: [...b.comments, { text: 'A answer arrived late', answers: true }] }, 'agent2');
  assert.equal(late.mention.questionId, b.mention.questionId);
  assert.equal(late.mention.answeredAt, '');
  assert.match(lib.writeProblem(b, late, 'agent2'), /current open question/);
});

test('lib: a queued legacy question gets a distinct ID even when two question times match', async () => {
  const lib = await import(src('lib.js'));
  const sameTime = '2026-10-25T05:00:00.000Z';
  const a = { to: 'worker', by: 'owner', at: sameTime, text: '@worker A', firedAt: 'earlier', answeredAt: '', next: [{ to: 'worker', by: 'owner', at: sameTime, text: '@worker B' }] };
  const old = { comments: [{ at: sameTime, by: 'owner', text: '@worker A' }, { at: sameTime, by: 'owner', text: '@worker B' }], mention: a };
  assert.equal(lib.canAnswerMention(old, sameTime), false, 'a reused legacy time is ambiguous');
  // A preexisting active A can be resolved after reasking; on promotion B must still get a new identity.
  const unambiguous = { ...old, comments: [{ at: sameTime, by: 'owner', text: '@worker A' }, { at: 'other-time', by: 'owner', text: '@worker B' }], mention: { ...a, next: [{ ...a.next[0], at: 'other-time' }] } };
  const promoted = lib.stampCard(unambiguous, { comments: [...unambiguous.comments, { text: 'A answer', answers: true, answerId: sameTime }] }, 'agent2');
  assert.match(promoted.mention.questionId, /^[0-9a-f-]{36}$/);
  assert.notEqual(promoted.mention.questionId, sameTime);
  assert.equal(lib.canAnswerMention(promoted, sameTime), false);
});

test('api: a stale answer ID cannot close the active mention through a direct patch', async () => {
  const { handleApi } = await import(src('api.js'));
  const db = fakeDb([card({ comments: [
    { at: 'old', by: 'owner', text: '@worker A' },
    { at: 'later', by: 'agent2', text: 'A answered', answers: true, answerId: 'a-id', answering: 'worker' },
    { at: 'new', by: 'owner', text: '@worker B' },
  ], mention: { to: 'worker', at: 'new', questionId: 'b-id', text: '@worker B', answeredAt: '' } })]);
  const calls = [];
  const env = firing({ DB: db, ...ENV_RUNS, EMAIL_PRINCIPALS: '{}', SERVICE_PRINCIPALS: '{}' }, calls);
  const before = JSON.parse(db.rows.get('c1').data);
  const request = (answer) => new Request('https://board.example.com/api/v1/tasks/c1', { method: 'PATCH', body: JSON.stringify({ ifVersion: 3, data: { comments: [...before.comments, answer] } }) });
  for (const answer of [
    { text: 'late A', answers: true, answerId: 'a-id' },
    { text: 'missing ID', answers: true },
  ]) {
    await assert.rejects(handleApi(request(answer), env, new URL('https://board.example.com/api/v1/tasks/c1'), { email: 'owner', sub: 'owner' }), (error) => error.status === 403 && /current open question/.test(error.message));
    assert.equal(db.rows.get('c1').version, 3);
    assert.equal(JSON.parse(db.rows.get('c1').data).mention.questionId, 'b-id');
  }
  assert.equal(calls.length, 0);
  const valid = await handleApi(request({ text: 'B answer', answers: true, answerId: 'b-id' }), env, new URL('https://board.example.com/api/v1/tasks/c1'), { email: 'owner', sub: 'owner' });
  assert.equal(valid.status, 200);
  assert.ok(JSON.parse(db.rows.get('c1').data).mention.answeredAt);
  assert.equal(calls.length, 0);
});

test('run: a card that already woke an agent six times this hour pauses the mention instead of firing', async () => {
  const mcp = await import(src('mcp.js'));
  const recent = new Date(Date.now() - 600e3).toISOString();
  const history = Array.from({ length: 6 }, () => ({ at: recent, by: 'owner', what: '@worker woken by owner: https://claude.ai/code/cse_y' }));
  const db = fakeDb([card({ lane: 'worker', history })]);
  const calls = [];
  const env = firing({ DB: db, HANDBOOK: 'x', ...ENV_RUNS }, calls);
  const r = (await mcp.handleRpc(env, 'owner', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add_comment', arguments: { key: 'TASK-9', text: '@worker again?' } } })).json;
  assert.ok(!r.error && !r.result.isError, JSON.stringify(r));
  assert.equal(calls.length, 0);
  const data = JSON.parse(db.rows.get('c1').data);
  assert.equal(data.mention.paused, true);
  assert.ok(data.mention.triedAt && !data.mention.answeredAt, 'still open for the next run');
  assert.match(data.history.at(-1).what, /not woken: this card already woke an agent 6 times/);
});

test('lib: asking again replaces a mention that never woke anyone, so a retry is possible', async () => {
  const lib = await import(src('lib.js'));
  const failed = { comments: [{ at: 'a', by: 'owner', text: '@worker one' }], mention: { to: 'worker', by: 'owner', at: 'a', text: '@worker one', triedAt: 'b', firedAt: '', relay: '', answeredAt: '' } };
  const again = lib.stampCard(failed, { comments: [...failed.comments, { text: '@worker one, again' }] }, 'owner');
  assert.equal(again.mention.text, '@worker one, again');
  assert.equal(again.mention.triedAt, undefined, 'untried, so the board fires it');
  assert.equal(again.mention.next, undefined);
});

test('run: two concurrent attempts to wake one mention fire only once', async () => {
  const { mentionRun } = await import(src('run.js'));
  const db = fakeDb([card({ mention: { to: 'worker', by: 'owner', at: 'question-a', text: '@worker A', answeredAt: '' } })]);
  const calls = [];
  const env = firing(ENV_RUNS, calls);
  await Promise.allSettled([mentionRun(env, db, 'owner', 'c1'), mentionRun(env, db, 'agent', 'c1')]);
  assert.equal(calls.length, 1);
  assert.match(JSON.parse(db.rows.get('c1').data).mention.operationId, /^[0-9a-f-]{36}$/);
});

test('run: a second question queues while the first wake is in flight', async () => {
  const { mentionRun } = await import(src('run.js'));
  const { writeTask } = await import(src('store.js'));
  const first = { to: 'worker', by: 'owner', at: 'question-a', text: '@worker A', answeredAt: '' };
  const db = fakeDb([card({ mention: first, comments: [{ at: 'question-a', by: 'owner', text: '@worker A' }] })]);
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let fires = 0;
  const env = { ...ENV_RUNS, fetchImpl: async () => { fires++; entered(); await held; return { ok: true, status: 200, json: async () => ({ claude_code_session_url: 'https://claude.ai/code/once' }) }; } };
  const waking = mentionRun(env, db, 'owner', 'c1');
  await started;
  const before = JSON.parse(db.rows.get('c1').data);
  await writeTask(db, 'owner', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data: { comments: [...before.comments, { text: '@worker B' }] } });
  release();
  await waking;
  const after = JSON.parse(db.rows.get('c1').data);
  assert.equal(after.mention.text, '@worker A');
  assert.equal(after.mention.next[0].text, '@worker B');
  assert.equal(fires, 1);
});

test('run: lost mention result keeps the claim and retry does not wake again', async () => {
  const { mentionRun } = await import(src('run.js'));
  const db = fakeDb([card({ mention: { to: 'worker', by: 'owner', at: 'question-a', text: '@worker A', answeredAt: '' } })]);
  db.failBatchAt = 2;
  const calls = [];
  const env = firing(ENV_RUNS, calls);
  await assert.rejects(mentionRun(env, db, 'owner', 'c1'), /interrupted after mention ack/);
  const prior = JSON.parse(db.rows.get('c1').data).mention;
  const retry = await mentionRun(env, db, 'owner', 'c1');
  assert.equal(calls.length, 1);
  assert.equal(retry.operationId, prior.operationId);
  assert.equal(retry.pending, true);
});

test('run: an uncertain mention outcome holds its question when a new one arrives', async () => {
  const { mentionRun } = await import(src('run.js'));
  const { writeTask } = await import(src('store.js'));
  const db = fakeDb([card({ mention: { to: 'worker', by: 'owner', at: 'question-a', text: '@worker A', answeredAt: '' }, comments: [{ at: 'question-a', by: 'owner', text: '@worker A' }] })]);
  let fires = 0;
  const env = { ...ENV_RUNS, fetchImpl: async () => { fires++; throw new Error('socket hang up'); } };
  assert.deepEqual(await mentionRun(env, db, 'owner', 'c1'), { error: 'socket hang up' });
  const before = JSON.parse(db.rows.get('c1').data);
  assert.equal(before.mention.state, 'uncertain');
  await writeTask(db, 'owner', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data: { comments: [...before.comments, { text: '@worker B' }] } });
  const after = JSON.parse(db.rows.get('c1').data);
  assert.equal(after.mention.text, '@worker A');
  assert.equal(after.mention.next[0].text, '@worker B');
  const retry = await mentionRun(env, db, 'owner', 'c1');
  assert.equal(retry.pending, true);
  assert.equal(fires, 1);
});
