'use strict';

// The board redesign contract (): the design column and ask, priority words, rollback on
// every card, questions to Agent, and the rollback action. Real SQLite behind the D1 stand-in (node:sqlite),
// no network.
//   node --test tests/board-redesign.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { /* older Node: the store tests below skip */ }
const src = (f) => pathToFileURL(path.join(__dirname, '..', 'worker', 'src', f)).href;
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'worker', 'schema.sql'), 'utf8');
const PR = 'https://github.com/example-org/test-diner/pull/40';
const ROLLBACK = { to: 'the menu page as it was on 2026-10-20', how: 'revert the merge commit and redeploy', cannot: 'nothing' };
const deny = (status, re) => (e) => e.status === status && re.test(e.message);
const needsSqlite = { skip: !sqlite && 'node:sqlite missing' };

function d1() {
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const exec = (sql, args) => {
    const st = db.prepare(sql);
    const reads = /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
    return reads ? { results: st.all(...args) } : (st.run(...args), { results: [] });
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
  const store = await import(src('store.js'));
  const db = d1();
  db.raw.prepare('INSERT INTO board_boards (id, data, version, updated_at) VALUES (?, ?, 1, ?)').run('test-diner', JSON.stringify({ name: 'Test Diner', prefix: 'TDN', order: 1 }), 'x');
  db.raw.prepare('INSERT INTO board_counters (id, next, version) VALUES (?, 41, 1)').run('TDN');
  const put = (id, who, data) => store.writeTask(db, who, { op: 'put', id, data: { board: 'test-diner', history: [], ...data } });
  await put('a', 'owner', { key: 'TDN-40', title: 'Menu page', status: 'doing', kind: 'agent', lane: 'lane1' });
  await put('p', 'owner', { key: 'TDN-39', title: 'Deploy menu', status: 'todo', kind: 'production', lane: 'lane1', evidence: { rollback: ROLLBACK } });
  const card = (id) => JSON.parse(db.raw.prepare('SELECT data FROM board_tasks WHERE id = ?').get(id).data);
  const ver = (id) => db.raw.prepare('SELECT version FROM board_tasks WHERE id = ?').get(id).version;
  const patch = (id, who, data, opts) => store.writeTask(db, who, { op: 'patch', id, ifVersion: ver(id), data }, opts);
  return { store, db, card, ver, patch, put };
}

// ---------------------------------------------------------------- 1. design column and ask
test('design: a status between todo and doing, a design ask with a default text, human and agent cards only', async () => {
  const lib = await import(src('lib.js'));
  assert.deepEqual(lib.STATUSES, ['todo', 'design', 'doing', 'review', 'approval', 'waiting', 'blocked', 'done']);
  assert.ok(lib.ASK_KINDS.includes('design'));
  assert.equal(lib.validateCard({ title: 'x', status: 'design' }), null);
  const r = lib.applyAskRule(null, { title: 'x', status: 'design', kind: 'agent', evidence: { design: 'https://canvas.example/1' }, ask: { kind: 'design' } }, 'cloud-worker', 'N');
  assert.equal(r.problem, null);
  assert.equal(r.card.ask.text, 'Approve design');
  assert.equal(r.card.ask.to, 'owner');
  assert.equal(r.card.needsOwner, true);
  assert.equal(r.card.status, 'design', 'a design ask is for Owner and does not move the card');
  assert.match(lib.applyAskRule(null, { title: 'x', status: 'design', kind: 'production', ask: { kind: 'design' } }, 'owner', 'N').problem, /human or agent card/);
  const mcp = await import(src('mcp.js'));
  assert.ok(mcp.TOOLS.find((t) => t.name === 'list_cards').inputSchema.properties.status.enum.includes('design'));
  assert.ok(mcp.TOOLS.find((t) => t.name === 'ask_owner').inputSchema.properties.kind.enum.includes('design'));
});

test('design: approving sets gates.design and moves to doing; declining clears the ask and stays in design', needsSqlite, async () => {
  const s = await setup();
  const { approveCard } = await import(src('approve.js'));
  // Owner moves the card; the thread raises the design ask, the one write it keeps.
  await s.patch('a', 'owner', { status: 'design', evidence: { design: 'https://canvas.example/menu' } });
  await s.patch('a', 'cloud-worker', { ask: { kind: 'design', by: 'designer' } });
  assert.equal(s.card('a').status, 'design');
  assert.equal(s.card('a').ask.by, 'designer');
  await approveCard({}, s.db, 'agent', 'a', { decision: 'decline', note: 'too dark' });
  let c = s.card('a');
  assert.equal(c.status, 'design');
  assert.equal('ask' in c, false);
  assert.equal(c.gates, undefined);
  assert.equal(c.history.at(-1).what, 'agent for Owner declined: Approve design (too dark)');
  await s.patch('a', 'cloud-worker', { ask: { kind: 'design' } });
  await approveCard({}, s.db, 'owner', 'a', { decision: 'approve' });
  c = s.card('a');
  assert.equal(c.status, 'doing');
  assert.equal(c.gates.design.approvedBy, 'owner');
  assert.match(c.gates.design.approvedAt, /^\d{4}-/);
  assert.equal(c.evidence.design, 'https://canvas.example/menu');
  assert.equal(c.history.at(-1).what, 'Owner approved the design: Approve design');
  assert.equal('ask' in c, false);
});

// ---------------------------------------------------------------- 2. priority words
test('priority: words in, numbers stored, words out', async () => {
  const lib = await import(src('lib.js'));
  assert.equal(lib.priorityWord(50), 'urgent');
  assert.equal(lib.priorityWord(75), 'urgent');
  assert.equal(lib.priorityWord(76), 'normal');
  assert.equal(lib.priorityWord(100), 'normal');
  assert.equal(lib.priorityWord(124), 'normal');
  assert.equal(lib.priorityWord(125), 'low');
  assert.equal(lib.priorityWord(150), 'low');
  assert.equal(lib.priorityWord(undefined), 'normal');
  assert.equal(lib.priorityWord(null), 'normal');
  assert.equal(lib.priorityNumber('urgent'), 50);
  assert.equal(lib.priorityNumber('Normal'), 100);
  assert.equal(lib.priorityNumber('LOW'), 150);
  assert.equal(lib.priorityNumber(80), 80);
  assert.equal(lib.priorityNumber('80'), 80);
  for (const bad of [0, -5, '0', '-3', -0.5, 'junk', NaN, null]) assert.equal(lib.priorityNumber(bad), 100, String(bad) + ' is not a priority');
  assert.equal(lib.priorityNumber('whenever'), 100);
  assert.equal(lib.priorityNumber(undefined), 100);
  const gen = await import(src('generate.js'));
  assert.match(gen.buildPrompt('x', 'agent', 'B', 'KIT'), /priority: one of the words urgent, normal or low/);
  assert.equal(gen.validateCard({ title: 't', doneCriteria: ['a'], priority: 'urgent' }).priority, 50);
  assert.equal(gen.validateCard({ title: 't', doneCriteria: ['a'], priority: 'low' }).priority, 150);
  assert.equal(gen.validateCard({ title: 't', doneCriteria: ['a'] }).priority, 100);
});

test('priority: the store, add_card and update_card accept the words; the snapshot prints the word', needsSqlite, async () => {
  const { db, card, patch, store } = await setup();
  await assert.rejects(patch('a', 'cloud-worker', { priority: 'urgent' }), deny(403, /read only for cloud-worker/));
  await patch('a', 'owner', { priority: 'urgent' });
  assert.equal(card('a').priority, 50);
  await patch('a', 'owner', { priority: 'low' });
  assert.equal(card('a').priority, 150);
  await patch('a', 'owner', { priority: 90 });
  assert.equal(card('a').priority, 90);
  const mcp = await import(src('mcp.js'));
  const env = { DB: db, HANDBOOK: 'x' };
  const call = async (principal, name, args) => {
    const r = await mcp.handleRpc(env, principal, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    return { isError: !!r.json.result.isError, text: r.json.result.content[0].text };
  };
  const refused = await call('agent2', 'add_card', { board: 'test-diner', title: 'Urgent thing', kind: 'agent', priority: 'urgent' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /403: the board is read only for agent2/);
  const added = await call('owner', 'add_card', { board: 'test-diner', title: 'Urgent thing', kind: 'agent', priority: 'urgent' });
  assert.equal(added.isError, false, added.text);
  const key = JSON.parse(added.text).key;
  const doc = await store.getTaskByKey(db, key);
  assert.equal(doc.data.priority, 50);
  assert.deepEqual(mcp.TOOLS.find((t) => t.name === 'add_card').inputSchema.properties.priority.type, ['string', 'number']);
  const up = await call('owner', 'update_card', { key, patch: { priority: 'low' }, ifVersion: doc.version });
  assert.equal(up.isError, false, up.text);
  assert.equal((await store.getTaskByKey(db, key)).data.priority, 150);
  const { buildSnapshot } = await import(src('snapshot.js'));
  const text = await buildSnapshot(env, 'worker', { github: false });
  assert.match(text, /CARD TDN-41\n[\s\S]*?  priority: low\n/);
  assert.match(text, /CARD TDN-40\n[\s\S]*?  priority: normal\n/);
  assert.doesNotMatch(text, /priority: \d/);
});

// ---------------------------------------------------------------- 3. rollback on every card
test('rollback rule: a merge ask and the move to done need evidence.rollback; done cards are not re-checked; seeds pass', async () => {
  const lib = await import(src('lib.js'));
  const MSG = /needs evidence\.rollback \(to, how, cannot\) written first; every card says how it is undone/;
  const base = { board: 'b', title: 't', kind: 'agent', status: 'review' };
  const merge = { kind: 'merge', text: 'Merge pull request 40', pr: PR };
  assert.match(lib.writeProblem(base, { ...base, ask: merge }, 'cloud-worker'), /^a merge ask needs evidence\.rollback/);
  assert.match(lib.writeProblem({ ...base, ask: merge }, { ...base, ask: merge, note: 'kept' }, 'owner'), MSG, 'keeping a merge ask is checked too');
  assert.equal(lib.writeProblem(base, { ...base, ask: merge, evidence: { rollback: ROLLBACK } }, 'cloud-worker'), null);
  assert.match(lib.writeProblem(base, { ...base, ask: merge, evidence: { rollback: { to: 'x', how: '   ' } } }, 'owner'), MSG, 'blank how is missing');
  assert.equal(lib.writeProblem(base, { ...base, ask: merge, evidence: { rollback: { to: 'x', how: 'y' } } }, 'owner'), null, 'cannot may be left out');
  for (const kind of ['human', 'agent', 'production']) {
    for (const who of ['cloud-worker', 'github-actions', 'owner', 'worker', 'agent']) {
      assert.match(lib.writeProblem({ ...base, kind }, { ...base, kind, status: 'done' }, who), /^a move to done needs evidence\.rollback/, `${kind} by ${who}`);
    }
    assert.equal(lib.writeProblem({ ...base, kind }, { ...base, kind, status: 'done', evidence: { rollback: ROLLBACK } }, 'cloud-worker'), null);
  }
  assert.match(lib.writeProblem(null, { ...base, status: 'done' }, 'owner'), MSG, 'a card created done is a move to done');
  assert.equal(lib.writeProblem({ ...base, status: 'done' }, { ...base, status: 'done', note: 'later note' }, 'cloud-worker'), null, 'an already done card is left alone');
  assert.equal(lib.writeProblem({ ...base, status: 'done' }, { ...base, status: 'doing' }, 'cloud-worker'), null, 'reopening is not a move to done');
  // The one exception: worker or owner seeding old cards with importHistory.
  assert.equal(lib.writeProblem(null, { ...base, status: 'done' }, 'worker', { importHistory: true }), null);
  assert.equal(lib.writeProblem(null, { ...base, status: 'done' }, 'owner', { importHistory: true }), null);
  assert.match(lib.writeProblem(null, { ...base, status: 'done' }, 'agent', { importHistory: true }), MSG, 'a proxy is not a seeder');
  assert.match(lib.writeProblem(null, { ...base, status: 'done' }, 'worker', {}), MSG, 'worker without importHistory is refused too');
  assert.match(lib.writeProblem(null, { ...base, status: 'done', ask: merge }, 'worker', { importHistory: true }), /merge ask/, 'a seed never carries a merge ask without rollback');
});

test('rollback rule: the store refuses with 422 (not 403, which is a read only token) on every write path; a worker seed with importHistory passes', needsSqlite, async () => {
  const { store, db, card, patch, ver } = await setup();
  await assert.rejects(patch('a', 'owner', { status: 'done' }), deny(422, /move to done needs evidence\.rollback/));
  await assert.rejects(patch('a', 'cloud-worker', { status: 'done' }), deny(403, /read only for cloud-worker/));
  await assert.rejects(patch('a', 'cloud-worker', { ask: { kind: 'merge', pr: PR } }), deny(422, /merge ask needs evidence\.rollback/));
  await assert.rejects(store.writeBatch(db, 'owner', [{ op: 'patch', id: 'a', ifVersion: ver('a'), data: { status: 'done' } }], true), deny(422, /rollback/));
  assert.equal(card('a').status, 'doing', 'nothing was written');
  await patch('a', 'cloud-worker', { evidence: { rollback: ROLLBACK } });
  await patch('a', 'cloud-worker', { ask: { kind: 'merge', pr: PR } });
  assert.equal(card('a').ask.kind, 'merge');
  await patch('a', 'owner', { status: 'done', ask: null });
  assert.equal(card('a').status, 'done');
  // A seed (PUT with seedVersion and importHistory) carries an old done card as it was. Owner only now; worker is read only.
  await assert.rejects(store.writeTask(db, 'worker', { op: 'put', id: 'old', data: { board: 'test-diner', key: 'TDN-2', title: 'Old', status: 'done', kind: 'agent', history: [] } }, { seedVersion: 4, importHistory: true }), deny(403, /read only for worker/));
  await store.writeTask(db, 'owner', { op: 'put', id: 'old', data: { board: 'test-diner', key: 'TDN-2', title: 'Old', status: 'done', kind: 'agent', history: [{ at: 'T', by: 'x', what: 'done long ago' }] } }, { seedVersion: 4, importHistory: true });
  assert.equal(card('old').status, 'done');
  await assert.rejects(store.writeTask(db, 'owner', { op: 'put', id: 'old2', data: { board: 'test-diner', key: 'TDN-3', title: 'Old', status: 'done', kind: 'agent', history: [] } }, { seedVersion: 4 }), deny(422, /rollback/), 'seedVersion alone is not the exception');
});

// ---------------------------------------------------------------- 4. questions go to Agent
test('questions: a bot\'s answer or decide ask goes to Agent and parks the card; a proxy\'s is a recommendation for Owner', async () => {
  const lib = await import(src('lib.js'));
  const base = { board: 'b', title: 't', kind: 'agent', status: 'doing' };
  for (const who of ['cloud-worker', 'github-actions', 'lane1', 'runner']) {
    for (const kind of ['answer', 'decide']) {
      const r = lib.applyAskRule(null, { ...base, ask: { kind, text: 'Which photo?' } }, who, 'N').card;
      assert.equal(r.ask.to, 'agent', `${kind} by ${who}`);
      assert.equal(r.needsOwner, false);
      assert.equal(r.status, 'waiting');
      assert.equal(r.waitingOn, 'agent');
      assert.equal(lib.isWaiting(r), false, 'not in the red strip');
    }
  }
  for (const who of lib.OWNER_PROXIES) {
    const r = lib.applyAskRule(null, { ...base, ask: { kind: 'decide', text: 'Use the smokehouse photo' } }, who, 'N').card;
    assert.equal(r.ask.to, 'owner', who);
    assert.equal(r.needsOwner, true);
    assert.equal(r.status, 'doing', 'a recommendation does not move the card');
  }
  // Go and design asks are Owner's whoever raises them.
  for (const ask of [{ kind: 'go' }, { kind: 'design' }]) {
    const r = lib.applyAskRule(null, { ...base, ask }, 'cloud-worker', 'N').card;
    assert.equal(r.ask.to, 'owner');
    assert.equal(r.needsOwner, true);
    assert.equal(r.status, 'doing');
  }
  // A merge ask is Agent's whoever raises it (): off Owner's strip, the column kept, waiting on her.
  for (const who of ['cloud-worker', 'agent', 'owner']) {
    const r = lib.applyAskRule(null, { ...base, status: 'review', ask: { kind: 'merge', pr: PR } }, who, 'N').card;
    assert.equal(r.ask.to, 'agent', who);
    assert.equal(r.needsOwner, false, who);
    assert.equal(r.waitingOn, 'agent', who);
    assert.equal(r.status, 'review', who);
    assert.equal(lib.isWaiting(r), false, 'not on Owner\'s red strip');
    assert.match(lib.waitingLine(r), /\(needs Agent\)/);
    const cleared = lib.applyAskRule(r, { ...r, ask: null }, 'agent', 'N2').card;
    assert.equal(cleared.waitingOn, '', 'clearing the merge ask stops the wait');
    assert.equal(cleared.status, 'review', 'and leaves the column alone');
  }
  // A merge ask already stored as Owner's stays his when the card is touched.
  const legacy = { ...base, status: 'review', ask: { kind: 'merge', text: 'Merge pull request 11', pr: PR, to: 'owner' }, needsOwner: true };
  const kept = lib.applyAskRule(legacy, { ...legacy, note: 'x' }, 'cloud-worker', 'N').card;
  assert.equal(kept.ask.to, 'owner'); assert.equal(kept.needsOwner, true);
  // The same ask keeps its destination when a proxy touches the card; a done card drops the ask.
  const parked = lib.applyAskRule(null, { ...base, ask: { kind: 'answer', text: 'Which photo?' } }, 'cloud-worker', 'N').card;
  const touched = lib.applyAskRule(parked, { ...parked, note: 'still waiting' }, 'agent', 'N2').card;
  assert.equal(touched.ask.to, 'agent');
  assert.equal(touched.needsOwner, false);
  assert.equal(touched.status, 'waiting');
  const finished = lib.applyAskRule(parked, { ...parked, status: 'done', ask: { kind: 'answer', text: 'Which photo?' } }, 'cloud-worker', 'N3').card;
  assert.equal('ask' in finished, false);
  assert.equal(finished.status, 'done');
  // Agent answers: the ask is cleared and the card goes back to doing.
  const answered = lib.applyAskRule(parked, { ...parked, questions: [{ q: 'Which photo?', answer: 'The smokehouse' }], ask: null }, 'agent', 'N4').card;
  assert.equal('ask' in answered, false);
  assert.equal(answered.status, 'doing');
  assert.equal(answered.waitingOn, '');
  assert.equal(answered.needsOwner, false);
  // Clearing a to-Agent ask while moving the card elsewhere keeps that move.
  const blocked = lib.applyAskRule(parked, { ...parked, status: 'blocked', ask: null }, 'cloud-worker', 'N5').card;
  assert.equal(blocked.status, 'blocked');
  // Clearing a to-Owner ask on a waiting card does not move it.
  const rec = lib.applyAskRule(null, { ...base, status: 'waiting', waitingOn: 'customer', ask: { kind: 'decide', text: 'x' } }, 'agent', 'N').card;
  const recCleared = lib.applyAskRule(rec, { ...rec, ask: null }, 'agent', 'N6').card;
  assert.equal(recCleared.status, 'waiting');
  assert.equal(recCleared.waitingOn, 'customer');
});

test('questions: Owner approves a recommendation without a note, or decides with one; Agent\'s open question still needs words', needsSqlite, async () => {
  const { db, card, patch } = await setup();
  const { approveCard } = await import(src('approve.js'));
  // A worker asks; the card parks on Agent; Owner pressing approve without words is refused.
  await patch('a', 'owner', { questions: [{ q: 'Which hero photo?', by: 'builder', at: 'T0' }] });
  await patch('a', 'cloud-worker', { ask: { kind: 'answer', text: 'Which hero photo?', by: 'builder' } });
  assert.equal(card('a').status, 'waiting');
  assert.equal(card('a').waitingOn, 'agent');
  await assert.rejects(approveCard({}, db, 'owner', 'a', { decision: 'approve' }), deny(400, /note is required/));
  // Agent answers the question herself with the press; another connector writing the answer by hand is read only.
  const qs = card('a').questions.map((q) => ({ ...q, answer: 'The smokehouse one', answeredBy: 'agent3' }));
  await assert.rejects(patch('a', 'agent3', { questions: qs, ask: null }), deny(403, /read only for agent3/));
  await approveCard({}, db, 'agent', 'a', { decision: 'approve', note: 'The smokehouse one' });
  let c = card('a');
  assert.equal(c.status, 'doing');
  assert.equal(c.waitingOn, '');
  assert.equal('ask' in c, false);
  assert.equal(c.questions[0].answer, 'The smokehouse one');
  // Agent brings a recommendation instead: Owner takes it with one tap.
  await patch('a', 'cloud-worker', { ask: { kind: 'decide', text: 'Keep the old menu?' } });
  assert.equal(card('a').status, 'waiting');
  await patch('a', 'agent', { ask: { kind: 'decide', text: 'Keep the old menu until the photos land' } });
  c = card('a');
  assert.equal(c.ask.to, 'owner');
  assert.equal(c.needsOwner, true);
  assert.equal(c.status, 'waiting', 'the recommendation does not move the card by itself');
  await approveCard({}, db, 'agent3', 'a', { decision: 'approve' });
  c = card('a');
  assert.equal(c.status, 'doing');
  assert.equal(c.waitingOn, '');
  assert.equal(c.needsOwner, false);
  assert.equal('ask' in c, false);
  assert.equal(c.history.at(-1).what, "agent3 for Owner approved Agent's recommendation: Keep the old menu until the photos land");
  // With a note, Owner decides in his own words.
  await patch('a', 'agent', { ask: { kind: 'decide', text: 'Drop the old menu' } });
  await approveCard({}, db, 'owner', 'a', { decision: 'approve', note: 'Keep it one more week' });
  assert.equal(card('a').history.at(-1).what, 'Owner decided: Keep it one more week');
  // A recommendation that matches an open question records the recommendation as the answer.
  await patch('a', 'owner', { questions: [...card('a').questions, { q: 'Hours clock?', by: 'builder' }] });
  await patch('a', 'cloud-worker', { ask: { kind: 'answer', text: 'Hours clock?' } });
  await patch('a', 'worker', { ask: { kind: 'answer', text: 'Hours clock?' } });
  assert.equal(card('a').ask.to, 'agent', 'the same ask keeps where it was sent');
  await patch('a', 'worker', { ask: { kind: 'decide', text: 'Hours clock?' } });
  assert.equal(card('a').ask.to, 'owner', 'a changed ask from a proxy is a recommendation');
  await approveCard({}, db, 'owner', 'a', { decision: 'approve' });
  assert.equal(card('a').questions.at(-1).answer, 'Hours clock?');
});

// ---------------------------------------------------------------- review fixes, 
test('rollback rule: only the rollback rule is a 422; a genuine permission refusal stays 403', needsSqlite, async () => {
  const lib = await import(src('lib.js'));
  const { patch } = await setup();
  assert.equal(lib.isRollbackProblem('a move to done needs evidence.rollback (to, how, cannot) written first; every card says how it is undone'), true);
  assert.equal(lib.isRollbackProblem('nudgedAt is set only by the Nudge button (Owner or nudge_card)'), false);
  await assert.rejects(patch('a', 'cloud-worker', { nudgedAt: '2026-10-24T10:00:00Z' }), deny(403, /read only for cloud-worker/));
  await assert.rejects(patch('a', 'cloud-worker', { gates: { ownerGo: true } }), deny(403, /read only for cloud-worker/));
  await assert.rejects(patch('a', 'owner', { gates: { ownerGo: true } }), deny(403, /ownerGo/));
});

test('page: a 422 shows the server message, Start refusal preserves write access, and approve sends no canned note', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'page', 'index.html'), 'utf8');
  assert.match(html, /patch\.nudgedAt && patch\.pokedAt === '' && \/Start claim\//);
  assert.match(html, /else if \(e\.status === 403\) markReadOnly\(\);\r?\n\s+else if \(e\.status === 422 && e\.message\)/);
  assert.doesNotMatch(html, /Approved as recommended/);
  assert.match(html, /approveCall\(t, 'approve', n \|\| '', a\.as\)/);
  assert.doesNotMatch(html, /CST-006/);
});

test('approve: an empty note on a recommendation records the recommendation text itself', needsSqlite, async () => {
  const { db, card, patch } = await setup();
  const { approveCard } = await import(src('approve.js'));
  await patch('a', 'owner', { questions: [{ q: 'Keep the old menu?', by: 'builder' }] });
  await patch('a', 'agent', { ask: { kind: 'decide', text: 'Keep the old menu?' } });
  assert.equal(card('a').ask.to, 'owner');
  await approveCard({}, db, 'owner', 'a', { decision: 'approve', note: '' });
  const c = card('a');
  assert.equal(c.questions[0].answer, 'Keep the old menu?', 'the recommendation text is the answer, not a canned phrase');
  assert.equal(c.history.at(-1).what, 'Owner answered: Keep the old menu? (Keep the old menu?)');
  await patch('a', 'agent', { ask: { kind: 'decide', text: 'Drop the photos?' } });
  await approveCard({}, db, 'owner', 'a', { decision: 'approve', note: '   ' });
  assert.equal(card('a').history.at(-1).what, "Owner approved Agent's recommendation: Drop the photos?");
});

test('approve: an ask with no to (from before the redesign) is a plain ask that needs a note and copies nothing', needsSqlite, async () => {
  const { db, card, ver } = await setup();
  const { approveCard } = await import(src('approve.js'));
  // Write the legacy shape straight into the row: no ask.to.
  const row = card('a');
  row.questions = [{ q: 'Hours clock?', by: 'builder' }];
  row.ask = { kind: 'answer', text: 'Hours clock?', by: 'builder', via: 'cloud-worker', at: 'T0' };
  row.needsOwner = true;
  db.raw.prepare('UPDATE board_tasks SET data = ?, version = ? WHERE id = ?').run(JSON.stringify(row), ver('a') + 1, 'a');
  await assert.rejects(approveCard({}, db, 'owner', 'a', { decision: 'approve' }), deny(400, /note is required/));
  await assert.rejects(approveCard({}, db, 'agent', 'a', { decision: 'approve', note: '  ' }), deny(400, /note is required/));
  assert.equal(card('a').questions[0].answer, undefined, 'the question text was not copied in as its own answer');
  await approveCard({}, db, 'owner', 'a', { decision: 'approve', note: 'Use the 24 hour clock' });
  assert.equal(card('a').questions[0].answer, 'Use the 24 hour clock');
});

test('gates.design cannot be written by a patch, a put or the MCP; approve needs the design column and a canvas', needsSqlite, async () => {
  const lib = await import(src('lib.js'));
  const { db, card, patch, put } = await setup();
  const { approveCard } = await import(src('approve.js'));
  const forged = { design: { approvedAt: '2026-10-24T10:00:00Z', approvedBy: 'owner' } };
  assert.match(lib.writeProblem({ board: 'b' }, { board: 'b', gates: forged }, 'cloud-worker') || '', /gates\.design is set only by an approved design/);
  assert.match(lib.writeProblem({ board: 'b' }, { board: 'b', gates: forged }, 'owner') || '', /gates\.design/, 'Owner cannot write it either');
  assert.equal(lib.writeProblem({ board: 'b', gates: forged }, { board: 'b', gates: forged, note: 'x' }, 'cloud-worker'), null, 'an unchanged gate is left alone');
  assert.equal(lib.writeProblem({ board: 'b' }, { board: 'b', gates: forged }, 'owner', { allowGo: true }), null, 'approve passes allowGo');
  assert.match(lib.mcpPatchProblem({}, { gates: { design: { approvedBy: 'x' } } }, 'owner') || '', /gates\.design/);
  assert.match(lib.mcpPatchProblem({}, { gates: { ownerGo: true } }, 'owner') || '', /ownerGo/);
  assert.equal(lib.mcpPatchProblem({}, { gates: { other: 1 } }, 'owner'), null);
  await assert.rejects(patch('a', 'cloud-worker', { gates: forged }), deny(403, /read only for cloud-worker/));
  await assert.rejects(patch('a', 'owner', { gates: forged }), deny(403, /gates\.design/));
  await assert.rejects(put('forged', 'cloud-worker', { key: 'TDN-60', title: 'x', status: 'doing', kind: 'agent', gates: forged }), deny(403, /read only for cloud-worker/));
  await assert.rejects(put('forged', 'owner', { key: 'TDN-60', title: 'x', status: 'doing', kind: 'agent', gates: forged }), deny(403, /gates\.design/));
  assert.equal(card('a').gates, undefined);
  // Approve refuses a design ask unless the card is in the design column with a canvas.
  await patch('a', 'cloud-worker', { ask: { kind: 'design' } });
  await assert.rejects(approveCard({}, db, 'owner', 'a', { decision: 'approve' }), deny(409, /design column that carries evidence\.design/));
  await patch('a', 'owner', { status: 'design' });
  await assert.rejects(approveCard({}, db, 'owner', 'a', { decision: 'approve' }), deny(409, /evidence\.design/), 'in design but no canvas');
  await patch('a', 'owner', { evidence: { design: '   ' } });
  await assert.rejects(approveCard({}, db, 'owner', 'a', { decision: 'approve' }), deny(409, /evidence\.design/), 'a blank canvas is no canvas');
  assert.equal(card('a').gates, undefined);
  assert.equal(card('a').status, 'design');
  await patch('a', 'owner', { evidence: { design: 'https://canvas.example/menu' }, status: 'doing' });
  await assert.rejects(approveCard({}, db, 'owner', 'a', { decision: 'approve' }), deny(409, /design column/), 'a canvas on a card that is not in design');
  await patch('a', 'owner', { status: 'design' });
  await approveCard({}, db, 'owner', 'a', { decision: 'approve' });
  assert.equal(card('a').gates.design.approvedBy, 'owner');
  assert.equal(card('a').status, 'doing');
});

test('rollback action: a human source card with no lane gets a card with no lane and no nudge', needsSqlite, async () => {
  const { db, put, store } = await setup();
  const { rollbackCard } = await import(src('rollback.js'));
  await put('h', 'owner', { key: 'TDN-50', title: 'Hand written', status: 'doing', kind: 'human', evidence: { rollback: ROLLBACK } });
  const r = await rollbackCard(db, 'owner', 'h');
  const n = (await store.getTaskByKey(db, r.key)).data;
  assert.equal(n.lane, '');
  assert.equal('nudgedAt' in n, false, 'nothing to nudge without a lane');
  assert.equal(n.priority, 50);
  assert.equal(r.note, undefined);
});

test('rollback action: concurrent requests and retries return one rollback card', needsSqlite, async () => {
  const { db, patch, store } = await setup();
  const { rollbackCard } = await import(src('rollback.js'));
  await patch('a', 'cloud-worker', { evidence: { rollback: ROLLBACK } });
  const [first, second] = await Promise.all([rollbackCard(db, 'owner', 'a'), rollbackCard(db, 'owner', 'a')]);
  assert.equal(first.id, second.id);
  assert.equal(first.key, second.key);
  const retry = await rollbackCard(db, 'owner', 'a');
  assert.equal(retry.key, first.key);
  const rollbacks = (await store.listTasks(db, { board: 'test-diner' })).filter((t) => t.data.evidence?.rollbackOf === 'TDN-40');
  assert.equal(rollbacks.length, 1);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM board_tasks WHERE id = ?').get(first.id).n, 1);
});

test('rollback action: if the source card cannot take its history line the new card still counts as a success, with a note', needsSqlite, async () => {
  const { db, card, patch } = await setup();
  const { rollbackCard } = await import(src('rollback.js'));
  await patch('a', 'cloud-worker', { evidence: { rollback: ROLLBACK } });
  const real = db.batch;
  // The new card is an INSERT, the source patch an UPDATE of board_tasks: fail that one.
  db.batch = async (list) => {
    if (list.some((x) => /UPDATE board_tasks/.test(x.sql))) throw Object.assign(new Error('version mismatch'), { status: 409 });
    return real(list);
  };
  const r = await rollbackCard(db, 'owner', 'a');
  db.batch = real;
  assert.match(r.key, /^TDN-/);
  assert.equal(r.note, `${r.key} was created, but TDN-40 did not get its history line (version mismatch)`);
  assert.ok(db.raw.prepare('SELECT 1 FROM board_tasks WHERE key = ?').get(r.key), 'the new card exists');
  assert.equal(card('a').history.some((h) => /rollback requested/.test(h.what || '')), false, 'the source card is unchanged');
});

// ---------------------------------------------------------------- 5. the rollback action
test('rollback action: a new urgent card from evidence.rollback, linked both ways; production stays production and asks for a go', needsSqlite, async () => {
  const { db, card, patch, store } = await setup();
  const { rollbackCard } = await import(src('rollback.js'));
  for (const who of ['cloud-worker', 'github-actions', 'runner', 'lane1']) {
    await assert.rejects(rollbackCard(db, who, 'p'), deny(403, /rollback is for Owner/));
  }
  await assert.rejects(rollbackCard(db, 'owner', 'a'), deny(409, /no evidence\.rollback/));
  await assert.rejects(rollbackCard(db, 'owner', 'missing'), deny(404, /no task/));
  await patch('a', 'cloud-worker', { evidence: { rollback: ROLLBACK } });
  // A connector no longer writes the rollback card; the refusal takes no ticket number.
  await assert.rejects(rollbackCard(db, 'agent', 'a'), deny(403, /read only for agent/));
  const r = await rollbackCard(db, 'owner', 'a');
  assert.equal(r.key, 'TDN-41');
  assert.match(r.id, /^t-rb-[a-f0-9]{64}$/);
  const n = (await store.getTaskByKey(db, 'TDN-41')).data;
  assert.equal(n.title, 'Roll back TDN-40: Menu page');
  assert.equal(n.kind, 'agent');
  assert.equal(n.lane, 'lane1');
  assert.equal(n.status, 'todo');
  assert.match(n.nudgedAt, /^\d{4}-/);
  assert.equal(n.priority, 50);
  assert.deepEqual(n.dependsOn, ['TDN-40']);
  assert.deepEqual(n.brief, { objective: `Undo TDN-40. Goes back to: ${ROLLBACK.to}`, spec: ROLLBACK.how, outOfScope: ROLLBACK.cannot });
  assert.deepEqual(n.evidence, { rollbackOf: 'TDN-40' });
  assert.equal(n.needsOwner, false);
  assert.equal('ask' in n, false);
  assert.equal(n.createdBy, 'owner');
  assert.equal(n.history[0].what, 'rollback requested by Owner for TDN-40');
  assert.equal(card('a').history.at(-1).what, 'rollback requested: TDN-41');
  assert.equal(db.raw.prepare('SELECT next FROM board_counters WHERE id = ?').get('TDN').next, 42);
  // A production source makes a production rollback card that waits for Owner's go.
  const pr = await rollbackCard(db, 'owner', 'p');
  assert.equal(pr.key, 'TDN-42');
  const pn = (await store.getTaskByKey(db, 'TDN-42')).data;
  assert.equal(pn.kind, 'production');
  assert.deepEqual([pn.ask.kind, pn.ask.text, pn.ask.to], ['go', 'Go to roll back production', 'owner']);
  assert.equal(pn.needsOwner, true);
  assert.equal(pn.history[0].what, 'rollback requested by Owner for TDN-39');
});

test('rollback action: the API route and the MCP tool, Owner proxies only', needsSqlite, async () => {
  const { db, patch } = await setup();
  await patch('a', 'cloud-worker', { evidence: { rollback: ROLLBACK } });
  const api = await import(src('api.js'));
  const env = { DB: db, HANDBOOK: 'x', SERVICE_PRINCIPALS: JSON.stringify({ 'cloudtd.access': 'cloud-worker@test-diner', 'jarv.access': 'worker' }), EMAIL_PRINCIPALS: JSON.stringify({ 'owner@example.com': 'owner' }) };
  const call = async (claims, method, p, body) => {
    const req = new Request(`https://board.example.com/api/v1${p}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });
    let res;
    try { res = await api.handleApi(req, env, new URL(req.url), claims); } catch (err) { return { status: err.status || 500, body: { error: err.message } }; }
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  assert.equal((await call({ common_name: 'cloudtd.access' }, 'POST', '/tasks/a/rollback')).status, 403);
  const ok = await call({ email: 'owner@example.com' }, 'POST', '/tasks/a/rollback');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.key, 'TDN-41');
  assert.ok(ok.body.id);
  const worker = await call({ common_name: 'jarv.access' }, 'POST', '/tasks/p/rollback');
  assert.equal(worker.status, 403);
  assert.match(worker.body.error, /read only for worker/);
  const mcp = await import(src('mcp.js'));
  assert.ok(mcp.TOOLS.some((t) => t.name === 'rollback_card'));
  const tool = async (principal, args) => {
    const r = await mcp.handleRpc(env, principal, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'rollback_card', arguments: args } });
    return { isError: !!r.json.result.isError, text: r.json.result.content[0].text };
  };
  const refused = await tool('cloud-worker', { key: 'TDN-40' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /403: rollback_card is for Owner/);
  const again = await tool('agent2', { key: 'TDN-40' });
  assert.equal(again.isError, false, again.text);
  assert.deepEqual(JSON.parse(again.text).rollbackOf, 'TDN-40');
  assert.equal(JSON.parse(again.text).key, 'TDN-41', 'retry returns the original rollback card');
  const none = await tool('agent2', { key: 'TDN-41' });
  assert.equal(none.isError, true);
  assert.match(none.text, /409: TDN-41 has no evidence\.rollback/);
});

// ---------------------------------------------------------------- 6. the handbook and the bot instructions
test('the handbook has the redesign section and the MCP door instructions say the new rules', async () => {
  const mcp = await import(src('mcp.js'));
  assert.match(mcp.BOARD_INSTRUCTIONS, /todo, design \(/);
  assert.match(mcp.BOARD_INSTRUCTIONS, /evidence\.rollback \{to, how, cannot\}/);
  assert.match(mcp.BOARD_INSTRUCTIONS, /go to the agent, not the owner/);
  assert.match(mcp.TOOLS.find((t) => t.name === 'update_card').description, /urgent, normal or low/);
  assert.match(mcp.TOOLS.find((t) => t.name === 'update_card').description, /objects merge at every depth; arrays replace/);
});
