'use strict';

// MCP tools ask_owner and approve_card. In-memory D1 stand-in and a fake GitHub fetch, no network.
//   node --test tests/board-mcp-ask.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const src = (f) => pathToFileURL(path.join(__dirname, '..', 'worker', 'src', f)).href;
const PR = 'https://github.com/example-org/franks-bbq/pull/11';

function fakeDb() {
  const rows = new Map();
  const stmt = (sql) => {
    let args = [];
    const api = {
      bind(...a) { args = a; return api; },
      async first() {
        if (/FROM board_tasks WHERE id = \?/.test(sql)) return rows.get(args[0]) || null;
        if (/FROM board_boards WHERE id = \?/.test(sql)) return args[0] === 'franks' ? { id: 'franks', data: JSON.stringify({ name: 'Franks', prefix: 'FRK' }), version: 1 } : null;
        if (/FROM board_tasks WHERE key = \?/.test(sql)) {
          return [...rows.values()].find((r) => JSON.parse(r.data).key === args[0]) || null;
        }
        return null;
      },
      async run() {
        if (/^INSERT INTO board_tasks/.test(sql)) rows.set(args[0], { id: args[0], data: args[6], version: args[7], updated_at: args[8] });
        else if (/^DELETE FROM board_tasks WHERE id = \?/.test(sql)) rows.delete(args[0]);
        else if (/^UPDATE board_tasks SET board/.test(sql)) {
          const id = args[args.length - 1];
          const r = rows.get(id);
          rows.set(id, { ...r, data: args[5], version: r.version + 1, updated_at: args[args.length - 2] });
        }
        return {};
      },
    };
    return api;
  };
  return { rows, prepare: stmt, batch: async (list) => { for (const s of list) await s.run(); return []; } };
}

function fakeFetch(res) {
  const calls = [];
  const fn = async (url, init) => {
    if (url.includes('/actions/runs?')) {
      const sha = new URL(url).searchParams.get('head_sha');
      return { ok: true, status: 200, json: async () => ({ workflow_runs: [{ name: 'PR checks', workflow_id: 1, head_sha: sha, status: 'completed', conclusion: 'success' }] }) };
    }
    calls.push({ url, init });
    return { ok: res.ok, status: res.ok ? 200 : 405, json: async () => res.body };
  };
  fn.calls = calls;
  return fn;
}

async function setup(fetchImpl) {
  const store = await import(src('store.js'));
  const mcp = await import(src('mcp.js'));
  const db = fakeDb();
  // The card carries evidence.rollback because the tests raise a merge ask on it.
  await store.writeTask(db, 'owner', { op: 'put', id: 'c1', data: { title: 'T', status: 'review', kind: 'agent', board: 'franks', key: 'FRK-3', history: [], evidence: { reviewedHead: 'a'.repeat(40), checks: `pass (1 runs on ${'a'.repeat(40)}, synced from GitHub)`, rollback: { to: 'before FRK-3', how: 'revert the merge', cannot: 'nothing' } }, gates: { reviewer: { verdict: 'PASS', sha: 'a'.repeat(40) } } } });
  const env = { DB: db, GITHUB_MERGE_TOKEN: 'x', HANDBOOK: 'x', fetchImpl };
  const call = async (principal, name, args) => {
    const r = await mcp.handleRpc(env, principal, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const res = r.json.result;
    return { isError: !!res.isError, text: res.content[0].text };
  };
  return { db, call, mcp, store };
}

test('ask_owner sets the ask through the update path and returns it', async () => {
  const { db, call, mcp } = await setup(fakeFetch({ ok: true, body: {} }));
  assert.ok(mcp.TOOLS.some((t) => t.name === 'ask_owner') && mcp.TOOLS.some((t) => t.name === 'approve_card'));
  const r = await call('agent2', 'ask_owner', { key: 'FRK-3', kind: 'merge', text: 'Merge pull request 11', pr: PR, by: 'reviewer' });
  assert.equal(r.isError, false);
  const out = JSON.parse(r.text);
  assert.equal(out.key, 'FRK-3');
  assert.equal(out.needsOwner, false, 'a merge ask is Agent\'s, not Owner\'s ()');
  assert.equal(out.ask.kind, 'merge');
  assert.equal(out.ask.to, 'agent');
  assert.equal(out.ask.by, 'reviewer');
  assert.equal(out.ask.via, 'agent2');
  assert.equal(JSON.parse(db.rows.get('c1').data).waitingOn, 'agent');
  const bad = await call('agent2', 'ask_owner', { key: 'FRK-3', kind: 'merge', text: 'x' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /merge ask needs ask.pr/);
});

test('approve_card refuses worker tokens and lets a connector press for Owner under its own name', async () => {
  const f = fakeFetch({ ok: true, body: { merged: true, sha: 'abcdef1234567'.padEnd(40, '0') } });
  const { db, call } = await setup(f);
  await call('agent2', 'ask_owner', { key: 'FRK-3', kind: 'merge', text: 'Merge pull request 11', pr: PR });
  for (const who of ['cloud-worker', 'github-actions', 'runner', 'lane1']) {
    const r = await call(who, 'approve_card', { key: 'FRK-3', decision: 'approve' });
    assert.equal(r.isError, true);
    assert.match(r.text, /403: approve_card is for Owner and the connectors that speak for him/);
  }
  assert.equal(f.calls.length, 0, 'GitHub never called');
  const r = await call('agent', 'approve_card', { key: 'FRK-3', decision: 'approve' });
  assert.equal(r.isError, false, r.text);
  const out = JSON.parse(r.text);
  assert.equal(out.merged, 'abcdef1234567'.padEnd(40, '0'));
  assert.match(out.history, /^agent for Owner approved: Merge pull request 11; pull request merged abcdef1/);
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(f.calls[0].init.body).sha, 'a'.repeat(40));
  const card = JSON.parse(db.rows.get('c1').data);
  assert.equal(card.updatedBy, 'agent');
  assert.equal(card.history.at(-1).by, 'agent');
  assert.equal(card.needsOwner, false);
});

test('read only: Owner sets production, nudges, withdraws and deletes; a connector still presses the go; no one else writes', async () => {
  const { db, call } = await setup(fakeFetch({ ok: true, body: {} }));
  const version = async () => JSON.parse((await call('agent2', 'get_card', { key: 'FRK-3' })).text).version;
  const w = await call('cloud-worker', 'update_card', { key: 'FRK-3', patch: { kind: 'production' }, ifVersion: await version() });
  assert.equal(w.isError, true);
  assert.match(w.text, /kind production/);
  const proxyProd = await call('agent3', 'update_card', { key: 'FRK-3', patch: { kind: 'production' }, ifVersion: await version() });
  assert.match(proxyProd.text, /403: the board is read only for agent3/);
  const ok = await call('owner', 'update_card', { key: 'FRK-3', patch: { kind: 'production', status: 'todo', needsOwner: true }, ifVersion: await version() });
  assert.equal(ok.isError, false, ok.text);
  const g = await call('owner', 'update_card', { key: 'FRK-3', patch: { gates: { ownerGo: true } }, ifVersion: await version() });
  assert.equal(g.isError, true);
  assert.match(g.text, /gates.ownerGo/);
  // The press is the approval itself, so a connector Owner speaks through still gives the go on his word.
  const go = await call('agent2', 'approve_card', { key: 'FRK-3', decision: 'approve', as: 'go' });
  assert.equal(go.isError, false, go.text);
  assert.match(JSON.parse(go.text).history, /^agent2 for Owner gave the go: Go for production/);
  assert.equal(JSON.parse(db.rows.get('c1').data).gates.ownerGo, true);
  const noNudge = await call('owner', 'nudge_card', { key: 'FRK-3' });
  assert.equal(noNudge.isError, true);
  assert.match(noNudge.text, /only agent cards are nudged/);
  await call('owner', 'update_card', { key: 'FRK-3', patch: { kind: 'agent', status: 'todo' }, ifVersion: await version() });
  const worker = await call('lane1', 'nudge_card', { key: 'FRK-3' });
  assert.equal(worker.isError, true);
  assert.match(worker.text, /403/);
  const proxy = await call('agent', 'nudge_card', { key: 'FRK-3' });
  assert.equal(proxy.isError, true);
  assert.match(proxy.text, /403: the board is read only for agent/);
  const n = await call('owner', 'nudge_card', { key: 'FRK-3' });
  assert.equal(n.isError, false, n.text);
  let c = JSON.parse(db.rows.get('c1').data);
  assert.match(c.nudgedAt, /^\d{4}-/);
  assert.equal(c.history.at(-1).what, 'nudged by Owner: start now');
  const u = await call('owner', 'nudge_card', { key: 'FRK-3', action: 'withdraw' });
  assert.equal(u.isError, false, u.text);
  c = JSON.parse(db.rows.get('c1').data);
  assert.equal(c.nudgedAt, '');
  for (const who of ['cloud-worker', 'agent3']) {
    const nd = await call(who, 'delete_card', { key: 'FRK-3', reason: 'Owner said drop it' });
    assert.equal(nd.isError, true);
  }
  const d = await call('owner', 'delete_card', { key: 'FRK-3', reason: 'drop it' });
  assert.equal(d.isError, false, d.text);
  assert.equal(JSON.parse(d.text).deleted, true);
  const gone = await call('agent2', 'get_card', { key: 'FRK-3' });
  assert.equal(gone.isError, true);
});

test('read only (): an agent write is refused, an agent approval ask is allowed, Owner writes anything', async () => {
  const { db, call, store } = await setup(fakeFetch({ ok: true, body: {} }));
  const version = async () => JSON.parse((await call('agent2', 'get_card', { key: 'FRK-3' })).text).version;
  const card = () => JSON.parse(db.rows.get('c1').data);
  const before = await version();
  // Refused: every ordinary write, from every name but Owner, on every tool.
  const refused = [
    ['agent2', 'update_card', { key: 'FRK-3', patch: { note: 'working on it' }, ifVersion: before }],
    ['agent3', 'update_card', { key: 'FRK-3', patch: { status: 'done' }, ifVersion: before }],
    ['worker', 'update_card', { key: 'FRK-3', patch: { ask: { kind: 'decide', text: 'x' }, note: 'nothing rides along with an ask' }, ifVersion: before }],
    ['agent3', 'add_card', { board: 'franks', title: 'New work' }],
    ['agent2', 'add_comment', { key: 'FRK-3', text: 'Done.' }],
    ['worker', 'pause_board', { board: 'franks', paused: true }],
    ['agent3', 'rollback_card', { key: 'FRK-3' }],
  ];
  for (const [who, name, args] of refused) {
    const r = await call(who, name, args);
    assert.equal(r.isError, true, `${who} ${name}`);
    assert.match(r.text, new RegExp(`403: the board is read only for ${who}: raise or clear an ask`), `${who} ${name}`);
  }
  assert.equal(await version(), before, 'no refused write touched the card');
  await assert.rejects(store.nextNumber(db, 'worker', 'FRK'), (e) => e.status === 403 && /read only for worker/.test(e.message));
  // Allowed: the approval request. Raise it and clear it, and write the record a merge ask needs.
  const asked = await call('cloud-worker', 'ask_owner', { key: 'FRK-3', kind: 'decide', text: 'Keep the old menu?', by: 'lane1' });
  assert.equal(asked.isError, false, asked.text);
  assert.equal(card().ask.to, 'agent');
  const cleared = await call('agent2', 'update_card', { key: 'FRK-3', patch: { ask: null }, ifVersion: await version() });
  assert.equal(cleared.isError, false, cleared.text);
  assert.equal(card().ask, undefined);
  const record = await call('agent2', 'update_card', { key: 'FRK-3', ifVersion: await version(), patch: {
    evidence: { pr: PR, reviewedHead: 'a'.repeat(40), rollback: { to: 'before FRK-3', how: 'revert', cannot: 'nothing' } },
    gates: { reviewer: { verdict: 'PASS', sha: 'a'.repeat(40), notes: 'reviewed', at: 'T' } },
  } });
  assert.equal(record.isError, false, record.text);
  const merge = await call('cloud-worker', 'ask_owner', { key: 'FRK-3', kind: 'merge', text: 'Merge pull request 11', pr: PR, by: 'reviewer' });
  assert.equal(merge.isError, false, merge.text);
  assert.equal(card().ask.sha, 'a'.repeat(40), 'the merge ask pins the reviewed head as before');
  // Owner writes anything.
  const k = await call('owner', 'update_card', { key: 'FRK-3', patch: { note: 'Owner can still write', status: 'review' }, ifVersion: await version() });
  assert.equal(k.isError, false, k.text);
  assert.equal(card().note, 'Owner can still write');
});

// The counter lives outside the fake: one number per take, starting at 7.
function withCounter(db, start = 7) {
  let next = start;
  const prepare = (sql) => {
    if (/FROM board_counters WHERE id = \?/.test(sql)) return { bind: () => ({ first: async () => ({ id: 'FRK' }) }) };
    if (/^UPDATE board_counters/.test(sql)) return { bind: () => ({ counter: true, run: async () => ({}) }) };
    return db.prepare(sql);
  };
  const batch = async (list) => {
    const out = [];
    for (const s of list) {
      if (s.counter) out.push({ results: [{ number: next++, version: 1 }] });
      else { await s.run(); out.push({}); }
    }
    return out;
  };
  return { rows: db.rows, prepare, batch };
}

test('read only: an agent opens a card only to carry an ask, with nothing but the merge record on it', async () => {
  const { db, mcp } = await setup(fakeFetch({ ok: true, body: {} }));
  const env = { DB: withCounter(db), GITHUB_MERGE_TOKEN: 'x', HANDBOOK: 'x', fetchImpl: fakeFetch({ ok: true, body: {} }) };
  const call = async (principal, name, args) => {
    const res = (await mcp.handleRpc(env, principal, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).json.result;
    return { isError: !!res.isError, text: res.content[0].text };
  };
  const sha = 'b'.repeat(40);
  const record = {
    evidence: { pr: PR, reviewedHead: sha, rollback: { to: 'before the change', how: 'revert the merge', cannot: 'nothing' } },
    gates: { reviewer: { verdict: 'PASS', sha, notes: 'reviewed', at: 'T' } },
  };
  const ask = { kind: 'merge', text: 'Merge pull request 11', pr: PR, by: 'reviewer' };
  const made = await call('agent2', 'add_card', { board: 'franks', title: 'Line fix', kind: 'agent', lane: 'worker', ask, ...record });
  assert.equal(made.isError, false, made.text);
  const { key, id } = JSON.parse(made.text);
  assert.equal(key, 'FRK-7');
  const card = JSON.parse(db.rows.get(id).data);
  assert.equal(card.ask.to, 'agent');
  assert.equal(card.ask.sha, sha, 'the merge ask pins the reviewed head');
  assert.equal(card.waitingOn, 'agent');
  assert.equal(card.evidence.rollback.how, 'revert the merge');
  // Refused: no ask, a production card, or anything beyond the ask and the merge record.
  const refused = [
    ['worker', { board: 'franks', title: 'No ask' }, /read only for worker: raise or clear an ask/],
    ['worker', { board: 'franks', title: 'Deploy', kind: 'production', ask: { kind: 'go', text: 'Go' } }, /names its tier/],
    ['worker', { board: 'franks', title: 'Deploy', kind: 'production', risk: 2, riskWhy: 'existing DNS', ask: { kind: 'decide', text: 'Deploy?' } }, /carries its go ask/],
    ['worker', { board: 'franks', title: 'Deploy', kind: 'production', risk: 1, riskWhy: 'board tab', ask: { kind: 'go', text: 'Go' } }, /tier 1 production card carries no ask/],
    ['worker', { board: 'franks', title: 'Deploy', kind: 'production', risk: 4, riskWhy: 'x' }, /names its tier/],
    ['cloud-worker', { board: 'franks', title: 'Deploy', kind: 'production', risk: 3, riskWhy: 'money', ask: { kind: 'go', text: 'Go' } }, /production is created only by Owner/],
    ['worker', { board: 'franks', title: 'Brief', ask, ...record, brief: { goal: 'x' } }, /brief are Owner's to write/],
    ['worker', { board: 'franks', title: 'Checks', ask, evidence: { ...record.evidence, checks: 'pass' } }, /read only for worker/],
    ['worker', { board: 'franks', title: 'Gate', ask, ...record, gates: { ownerGo: { at: 'T' } } }, /read only for worker/],
  ];
  for (const [who, args, re] of refused) {
    const r = await call(who, 'add_card', args);
    assert.equal(r.isError, true, args.title);
    assert.match(r.text, re, args.title);
  }
  assert.equal([...db.rows.keys()].length, 2, 'only the approval card was made');
  // A production card that carries its own
  // go ask is an approval request: it waits on Owner's Go and spends nothing until he presses it.
  const handed = await call('agent2', 'add_card', { board: 'franks', title: 'Deploy board Sync repair', kind: 'production', lane: 'worker', risk: 3, riskWhy: 'production host change', ask: { kind: 'go', text: 'Go for production: board Worker from main' } });
  assert.equal(handed.isError, false, handed.text);
  const prod = JSON.parse(db.rows.get(JSON.parse(handed.text).id).data);
  assert.deepEqual([prod.kind, prod.ask.kind, prod.needsOwner, prod.gates && prod.gates.ownerGo, prod.risk, prod.riskWhy], ['production', 'go', true, undefined, 3, 'production host change']);
  const go = await call('owner', 'approve_card', { key: prod.key, decision: 'approve' });
  assert.equal(go.isError, false, go.text);
  assert.equal(JSON.parse(db.rows.get(JSON.parse(handed.text).id).data).gates.ownerGo, true);
});

test('approve_card as owner merges through GitHub and returns the history line; decline works', async () => {
  const f = fakeFetch({ ok: true, body: { merged: true, sha: 'abcdef1234567'.padEnd(40, '0') } });
  const { db, call } = await setup(f);
  await call('agent2', 'ask_owner', { key: 'FRK-3', kind: 'merge', text: 'Merge pull request 11', pr: PR });
  const r = await call('owner', 'approve_card', { key: 'FRK-3', decision: 'approve' });
  assert.equal(r.isError, false, r.text);
  const out = JSON.parse(r.text);
  assert.equal(out.merged, 'abcdef1234567'.padEnd(40, '0'));
  assert.match(out.history, /Owner approved: Merge pull request 11; pull request merged abcdef1/);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /repos\/example-org\/franks-bbq\/pulls\/11\/merge$/);
  const card = JSON.parse(db.rows.get('c1').data);
  assert.equal(card.needsOwner, false);
  assert.equal(card.ask, undefined);

  await call('agent2', 'ask_owner', { key: 'FRK-3', kind: 'decide', text: 'Pick one' });
  const d = await call('owner', 'approve_card', { key: 'FRK-3', decision: 'decline', note: 'later' });
  assert.match(JSON.parse(d.text).history, /Owner declined: Pick one \(later\)/);
  // a question raised by a worker goes to Agent and still needs words from Owner; a question
  // raised by one of Owner's connectors is Agent's recommendation and stands as the decision without a note.
  await call('cloud-worker', 'ask_owner', { key: 'FRK-3', kind: 'answer', text: 'Which colour?' });
  assert.equal(JSON.parse(db.rows.get('c1').data).ask.to, 'agent');
  const noNote = await call('owner', 'approve_card', { key: 'FRK-3', decision: 'approve' });
  assert.equal(noNote.isError, true);
  assert.match(noNote.text, /note is required/);
  await call('agent2', 'ask_owner', { key: 'FRK-3', kind: 'answer', text: 'Use the blue one' });
  const rec = await call('owner', 'approve_card', { key: 'FRK-3', decision: 'approve' });
  assert.equal(rec.isError, false, rec.text);
  assert.match(JSON.parse(rec.text).history, /Owner approved Agent's recommendation: Use the blue one/);
});

test('clerk (): Agent keeps the cards true; starting, holding, releasing, deleting and gating stay Owner\'s', async () => {
  const { db, mcp } = await setup(fakeFetch({ ok: true, body: {} }));
  const env = { DB: withCounter(db), GITHUB_MERGE_TOKEN: 'x', HANDBOOK: 'x', fetchImpl: fakeFetch({ ok: true, body: {} }) };
  const call = async (principal, name, args) => {
    const res = (await mcp.handleRpc(env, principal, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).json.result;
    return { isError: !!res.isError, text: res.content[0].text };
  };
  const card = () => JSON.parse(db.rows.get('c1').data);
  const version = async () => JSON.parse((await call('agent', 'get_card', { key: 'FRK-3' })).text).version;
  // Allowed: the record of the work, after the fact.
  const upd = await call('agent', 'update_card', { key: 'FRK-3', ifVersion: await version(), patch: { status: 'doing', note: 'Cody is building the menu page', link: PR, evidence: { pr: PR, checks: 'pass' } } });
  assert.equal(upd.isError, false, upd.text);
  assert.deepEqual([card().status, card().note, card().updatedBy], ['doing', 'Cody is building the menu page', 'agent']);
  assert.equal((await call('agent', 'add_comment', { key: 'FRK-3', text: 'Pull request 11 is open' })).isError, false);
  const made = await call('agent', 'add_card', { board: 'franks', title: 'Untracked footer fix', kind: 'agent', lane: 'worker', brief: { objective: 'Fix the footer hours' }, priority: 'normal' });
  assert.equal(made.isError, false, made.text);
  assert.equal(JSON.parse(made.text).key, 'FRK-7');
  // Back in todo, so the Start refusal below is about who presses it, not the column.
  assert.equal((await call('agent', 'update_card', { key: 'FRK-3', ifVersion: await version(), patch: { status: 'todo' } })).isError, false);
  // Refused: what starts or stops work or spends a gate, on every tool.
  const v = await version();
  for (const [name, args] of [
    ['update_card', { key: 'FRK-3', ifVersion: v, patch: { hold: true } }],
    ['update_card', { key: 'FRK-3', ifVersion: v, patch: { kind: 'human' } }],
    ['update_card', { key: 'FRK-3', ifVersion: v, patch: { kind: 'production' } }],
    ['update_card', { key: 'FRK-3', ifVersion: v, patch: { gates: { reviewer: { verdict: 'PASS', sha: 'c'.repeat(40) } } } }],
    ['update_card', { key: 'FRK-3', ifVersion: v, patch: { evidence: { reviewedHead: 'c'.repeat(40) } } }],
    ['update_card', { key: 'FRK-3', ifVersion: v, patch: { evidence: { start: { state: 'acknowledged' } } } }],
    ['add_card', { board: 'franks', title: 'Deploy', kind: 'production', risk: 3, riskWhy: 'money' }],
    ['add_comment', { key: 'FRK-3', text: '@worker can you look at this' }],
    ['release_card', { key: 'FRK-3', lane: 'lane2' }],
    ['nudge_card', { key: 'FRK-3' }],
    ['pause_board', { board: 'franks', paused: true }],
    ['delete_card', { key: 'FRK-3' }],
    ['rollback_card', { key: 'FRK-3' }],
  ]) {
    const r = await call('agent', name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(r.text, /403: (the board is read only for agent on|a tier 2 or 3 production card from anyone but Owner carries its go ask)/, `${name} ${r.text}`);
  }
  assert.equal(await version(), v, 'no refused write touched the card');
  const done = await call('agent', 'update_card', { key: 'FRK-3', ifVersion: v, patch: { status: 'done', note: 'Merged as pull request 11' } });
  assert.equal(done.isError, false, done.text);
  assert.equal(card().status, 'done');
  // Every other connector stays read only.
  const agent3 = await call('agent3', 'update_card', { key: 'FRK-3', ifVersion: await version(), patch: { note: 'x' } });
  assert.match(agent3.text, /403: the board is read only for agent3: raise or clear an ask/);
  // Her press counts as Owner's ("her typing is my typing now"): the production go on a card Owner made.
  const prod = await call('owner', 'add_card', { board: 'franks', title: 'Deploy the menu page', kind: 'production' });
  assert.equal(prod.isError, false, prod.text);
  const goKey = JSON.parse(prod.text).key;
  const go = await call('agent', 'approve_card', { key: goKey, decision: 'approve', as: 'go' });
  assert.equal(go.isError, false, go.text);
  const goCard = JSON.parse((await call('agent', 'get_card', { key: goKey })).text).card;
  assert.deepEqual([goCard.gates.ownerGo, goCard.gates.ownerGoBy], [true, 'agent']);
  assert.match(goCard.history.at(-1).what, /^agent for Owner/);
});

test('risk tiers (): tier 1 flows with no go, lowering a tier is Owner\'s, no tier means tier 3', async () => {
  const { db, mcp } = await setup(fakeFetch({ ok: true, body: {} }));
  const env = { DB: withCounter(db), GITHUB_MERGE_TOKEN: 'x', HANDBOOK: 'x', fetchImpl: fakeFetch({ ok: true, body: {} }) };
  const call = async (principal, name, args) => {
    const res = (await mcp.handleRpc(env, principal, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).json.result;
    return { isError: !!res.isError, text: res.content[0].text };
  };
  const read = async (key) => JSON.parse((await call('owner', 'get_card', { key })).text);
  // Web Worker opens a tier 1 production card for a new board tab: no ask, nothing for Owner to press.
  const made = await call('agent2', 'add_card', { board: 'franks', title: 'Deploy board: new tab tool', kind: 'production', lane: 'worker', risk: 1, riskWhy: 'a new board tab (internal tool)', evidence: { rollback: { to: 'version 6c7f2b34', how: 'redeploy it', cannot: 'nothing' } } });
  assert.equal(made.isError, false, made.text);
  const key = JSON.parse(made.text).key;
  let c = await read(key);
  assert.deepEqual([c.card.risk, c.card.riskWhy, c.card.needsOwner, c.card.ask], [1, 'a new board tab (internal tool)', false, undefined]);
  // A go ask on it is refused: tier 1 needs no go.
  const goAsk = await call('worker', 'ask_owner', { key, kind: 'go', text: 'Go', by: 'worker' });
  assert.match(goAsk.text, /tier 1 production card needs no go/);
  // Agent may raise the tier, not lower it; Owner may lower it.
  assert.equal((await call('agent', 'update_card', { key, ifVersion: (await read(key)).version, patch: { risk: 2, riskWhy: 'touches a customer DNS record after all' } })).isError, false);
  const lower = await call('agent', 'update_card', { key, ifVersion: (await read(key)).version, patch: { risk: 1, riskWhy: 'tab only' } });
  assert.match(lower.text, /risk only goes up after the card is made, except by Owner \(was 2\)/);
  assert.equal((await call('owner', 'update_card', { key, ifVersion: (await read(key)).version, patch: { risk: 1, riskWhy: 'tab only' } })).isError, false);
  assert.equal((await read(key)).card.risk, 1);
  // A bad tier or a missing reason is refused for everyone, Owner included.
  assert.match((await call('owner', 'update_card', { key, ifVersion: (await read(key)).version, patch: { risk: 5 } })).text, /risk is the tier 1, 2 or 3/);
  assert.match((await call('owner', 'update_card', { key, ifVersion: (await read(key)).version, patch: { risk: 2, riskWhy: '' } })).text, /riskWhy names the item/);
  // A production card Owner makes on his page with no tier is tier 3: it still needs his go and shows in the strip.
  const own = await call('owner', 'add_card', { board: 'franks', title: 'Deploy the menu', kind: 'production' });
  c = await read(JSON.parse(own.text).key);
  assert.deepEqual([c.card.risk, c.card.needsOwner], [undefined, true]);
  // A worker token still cannot open a production card, tier or not.
  assert.match((await call('cloud-worker', 'add_card', { board: 'franks', title: 'x', kind: 'production', risk: 1, riskWhy: 'tab' })).text, /production is created only by Owner/);
});
