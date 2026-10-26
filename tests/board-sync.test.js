'use strict';

// The Sync button: planSync rules and syncBoard end to end with a fake D1 and a fake GitHub.
//   node --test tests/board-sync.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const src = (f) => pathToFileURL(path.join(__dirname, '..', 'worker', 'src', f)).href;
const PR = (n) => `https://github.com/example-org/test-diner/pull/${n}`;

function fakeDb(seed) {
  const rows = new Map(seed.map((r) => [r.id, { ...r }]));
  const stmt = (sql) => {
    let args = [];
    const api = {
      bind(...a) { args = a; return api; },
      async all() {
        if (/FROM board_tasks/.test(sql)) return { results: [...rows.values()] };
        return { results: [] };
      },
      async first() {
        if (/FROM board_tasks WHERE id = \?/.test(sql)) return rows.get(args[0]) || null;
        if (/FROM board_tasks WHERE key = \?/.test(sql)) return [...rows.values()].find((r) => JSON.parse(r.data).key === args[0]) || null;
        return null;
      },
      async run() {
        if (/^UPDATE board_tasks SET board/.test(sql)) {
          const id = args[args.length - 1]; const r = rows.get(id);
          rows.set(id, { ...r, data: args[5], version: r.version + 1, updated_at: args[args.length - 2] });
        }
        return {};
      },
    };
    return api;
  };
  return { rows, prepare: stmt, batch: async (list) => { for (const s of list) await s.run(); return []; } };
}

const row = (id, data) => ({ id, version: 3, updated_at: '2026-10-23T05:00:00Z', data: JSON.stringify(data) });
const seed = [
  // A merge ask and the move to done both need evidence.rollback on the card.
  row('a', { board: 'test-diner', key: 'TDN-20', title: 'Merged but open on the board', status: 'review', kind: 'agent', evidence: { pr: PR(20), checks: 'pass', rollback: { to: 'the page before PR 20', how: 'revert the merge commit', cannot: 'nothing' } }, ask: { kind: 'merge', text: 'Merge pull request 20', pr: PR(20) }, needsOwner: true, history: [] }),
  row('b', { board: 'test-diner', key: 'TDN-21', title: 'Thread forgot to move it', status: 'doing', kind: 'agent', evidence: { pr: PR(21) }, history: [] }),
  row('c', { board: 'test-diner', key: 'TDN-22', title: 'Already right', status: 'review', kind: 'agent', evidence: { pr: PR(22), checks: `pass (1 runs on ${'e'.repeat(40)}, synced from GitHub)`, reviewerComment: 'PR comment claims Reviewer PASS at 2026-10-23T04:00:00Z; reviewer identity unverified' }, gates: { reviewer: { verdict: 'PASS' } }, history: [] }),
  row('d', { board: 'main', key: 'TASK-40', title: 'No pull request', status: 'doing', kind: 'agent', history: [] }),
];

function ghFetch() {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    const n = Number((url.match(/pulls\/(\d+)$/) || url.match(/(?:issues|pulls)\/(\d+)\//) || [])[1]);
    if (/\/pulls\/\d+$/.test(url)) {
      if (n === 20) return ok({ state: 'closed', merged: true, head: { sha: 'aaaa111bbbb' }, merge_commit_sha: 'deadbeefcafe1234' });
      if (n === 21) return ok({ state: 'open', merged: false, head: { sha: 'c'.repeat(40) } });
      if (n === 22) return ok({ state: 'open', merged: false, head: { sha: 'e'.repeat(40) } });
      return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    }
    if (/actions\/runs\?head_sha=/.test(url)) return ok({ workflow_runs: [{ name: 'checks', workflow_id: 1, status: 'completed', conclusion: url.includes(`head_sha=${'c'.repeat(40)}`) ? 'failure' : 'success', created_at: '2026-10-23T04:00:00Z' }] });
    if (/issues\/22\/comments/.test(url)) return ok([{ body: 'Reviewer: PASS', created_at: '2026-10-23T04:00:00Z' }]);
    if (/issues\/21\/comments/.test(url)) return ok([{ body: 'Reviewer: FAIL two findings', created_at: '2026-10-23T04:30:00Z' }]);
    if (/comments/.test(url)) return ok([]);
    if (/files/.test(url)) return ok([]);
    return ok({});
  };
  fn.calls = calls;
  return fn;
}

test('planSync: merged to done with sha, open pull request moves doing to review, checks and Reviewer recorded, nothing when it matches', async () => {
  const { planSync } = await import(src('sync.js'));
  const merged = planSync({ status: 'review', evidence: { pr: PR(1), checks: 'pass' } }, { merged: true, state: 'closed', mergedShaFull: 'deadbeef1234', checks: 'success', checkCount: 2, head: 'abc' });
  assert.equal(merged.patch.status, 'done');
  assert.equal(merged.patch.ask, null);
  assert.equal(merged.patch.evidence.merged, 'deadbeef1234');
  const open = planSync({ status: 'doing', evidence: { pr: PR(1) } }, { merged: false, state: 'open', checks: 'failure', checkCount: 1, head: 'abc', reviewer: { verdict: 'FAIL', at: 'x' } });
  assert.equal(open.patch.status, 'review');
  assert.match(open.patch.evidence.checks, /^fail \(1 runs on abc/);
  assert.equal(open.patch.gates, undefined);
  assert.match(open.patch.evidence.reviewerComment, /FAIL/);
  assert.equal(planSync({ status: 'review', evidence: { pr: PR(1), checks: 'pass (2 runs on abc, synced from GitHub)', reviewerComment: 'PR comment claims Reviewer PASS at unknown time; reviewer identity unverified' }, gates: { reviewer: { verdict: 'PASS' } } }, { merged: false, state: 'open', checks: 'success', checkCount: 2, head: 'abc', reviewer: { verdict: 'PASS' } }), null);
  assert.equal(planSync({ status: 'done', evidence: { pr: PR(1), merged: 'deadbeef1234' } }, { merged: true, state: 'closed', mergedShaFull: 'deadbeef1234', checks: 'unknown', checkCount: 0 }), null);
});

test('planSync: green checks record the full current head and refresh a stale green head', async () => {
  const { planSync } = await import(src('sync.js'));
  const oldHead = 'a'.repeat(40);
  const newHead = 'b'.repeat(40);
  const plan = planSync({ status: 'review', evidence: { pr: PR(22), checks: `pass (1 runs on ${oldHead}, synced from GitHub)` } },
    { merged: false, state: 'open', head: newHead.slice(0, 7), headFull: newHead, checks: 'success', checkCount: 2 });
  assert.equal(plan.patch.evidence.checks, `pass (2 runs on ${newHead}, synced from GitHub)`);
});

test('planSync: a PR comment cannot promote Reviewer FAIL to an exact-head PASS gate', async () => {
  const { planSync } = await import(src('sync.js'));
  const head = 'a'.repeat(40);
  const card = { status: 'review', evidence: { pr: PR(22), checks: `pass (1 runs on ${head}, synced from GitHub)` }, gates: { reviewer: { verdict: 'FAIL', sha: head } } };
  const gh = { merged: false, state: 'open', headFull: head, checks: 'success', checkCount: 1, reviewer: { verdict: 'PASS', at: 'T1' } };
  const plan = planSync(card, gh);
  assert.equal(plan.patch.gates, undefined, 'text on GitHub is not an independent review attestation');
  assert.match(plan.patch.evidence.reviewerComment, /PASS/);
  assert.equal(card.gates.reviewer.verdict, 'FAIL');
});

test('syncBoard: writes the changes with a history line naming the presser; dry run writes nothing; MCP tool and route exist', async () => {
  const { syncBoard, syncText } = await import(src('sync.js'));
  const env = { GITHUB_MERGE_TOKEN: 'x' };
  const dryDb = fakeDb(seed);
  const dry = await syncBoard(env, dryDb, 'owner', { dry: true, fetchImpl: ghFetch() });
  assert.equal(dry.checked, 3);
  assert.deepEqual(dry.changed.map((c) => c.key).sort(), ['TDN-20', 'TDN-21']);
  assert.equal(dry.unchanged, 1);
  assert.equal(JSON.parse(dryDb.rows.get('a').data).status, 'review', 'dry run wrote nothing');

  const db = fakeDb(seed);
  const r = await syncBoard(env, db, 'agent', { fetchImpl: ghFetch() });
  const a = JSON.parse(db.rows.get('a').data);
  assert.equal(a.status, 'done');
  assert.equal(a.needsOwner, false);
  assert.equal(a.evidence.merged, 'deadbeefcafe1234');
  assert.match(a.history.at(-1).what, /^synced from GitHub by agent: pull request merged on GitHub, status to done; merge sha recorded deadbee/);
  assert.equal(a.history.at(-1).by, 'agent');
  const b = JSON.parse(db.rows.get('b').data);
  assert.equal(b.status, 'review');
  assert.match(b.evidence.checks, /^fail/);
  assert.match(b.evidence.checks, new RegExp(`on ${'c'.repeat(40)}, synced from GitHub`));
  assert.equal(b.gates, undefined);
  assert.match(b.evidence.reviewerComment, /FAIL/);
  assert.equal(JSON.parse(db.rows.get('c').data).history.length, 0, 'the matching card is untouched');
  assert.match(syncText(r), /^Synced: 3 cards with a pull request checked, 2 changed, 1 already matched GitHub\./);

  const mcp = await import(src('mcp.js'));
  assert.ok(mcp.TOOLS.some((t) => t.name === 'sync_github'));
  assert.match(mcp.BOARD_INSTRUCTIONS, /call sync_github/);
  const out = await mcp.handleRpc({ DB: fakeDb(seed), GITHUB_MERGE_TOKEN: 'x', HANDBOOK: 'x', fetchImpl: ghFetch() }, 'agent2', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sync_github', arguments: { dry: true } } });
  assert.match(out.json.result.content[0].text, /^Sync preview: 3 cards/);
  const refused = await mcp.handleRpc({ DB: fakeDb(seed), GITHUB_MERGE_TOKEN: 'x', HANDBOOK: 'x', fetchImpl: ghFetch() }, 'reader', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sync_github', arguments: {} } });
  assert.equal(out.json.result.isError, undefined);
  assert.equal(refused.json.result.isError, true);
});

// the key sync refreshes one card's exact head evidence and nothing else, and a whole board sync
// never closes a production card whose deploy is still open.
const HEAD = 'f'.repeat(40);
const keySeed = () => [
  // TASK-74 shape: open PR, stale hand written checks line, a merge ask and Reviewer PASS on the head.
  row('k1', { board: 'main', key: 'TASK-74', title: 'Open PR with a stale checks line', status: 'review', kind: 'agent', needsOwner: false,
    ask: { kind: 'merge', text: 'Merge pull request 65', pr: PR(65), to: 'agent', by: 'reviewer', via: 'agent2', at: 'T0' }, gates: { reviewer: { verdict: 'PASS', sha: HEAD } },
    evidence: { pr: PR(65), reviewedHead: HEAD, checks: `pass (rerun job 1 on ${HEAD.slice(0, 7)})`, rollback: { to: 'before 65', how: 'revert', cannot: 'nothing' } }, history: [] }),
  // Merged PR on an agent card still in review: the key sync must not close it.
  row('k2', { board: 'main', key: 'TASK-80', title: 'Merged, still in review', status: 'review', kind: 'agent', needsOwner: true,
    ask: { kind: 'go', text: 'Go for the follow up', to: 'owner', by: 'agent2', via: 'agent2', at: 'T0' }, evidence: { pr: PR(20), rollback: { to: 'x', how: 'revert', cannot: 'nothing' } }, history: [] }),
  // Production card whose source merged but whose deploy is not recorded.
  row('k3', { board: 'main', key: 'TASK-75', title: 'Production, deploy open', status: 'blocked', kind: 'production', needsOwner: false,
    gates: { ownerGo: true }, evidence: { pr: PR(20), rollback: { to: 'x', how: 'revert and redeploy', cannot: 'nothing' } }, history: [] }),
  // Production card whose deploy the workflow recorded: an ordinary merged card again.
  row('k4', { board: 'main', key: 'TASK-81', title: 'Production, deployed', status: 'review', kind: 'production', needsOwner: false,
    gates: { ownerGo: true }, evidence: { pr: PR(20), deployedSha: 'deadbeefcafe1234', deployRun: 'r', deployedAt: 't', rollback: { to: 'x', how: 'revert', cannot: 'nothing' } }, history: [] }),
  row('k5', { board: 'main', key: 'TASK-82', title: 'Unrelated open card', status: 'doing', kind: 'agent', evidence: { pr: PR(21) }, history: [] }),
  row('k6', { board: 'main', key: 'TASK-83', title: 'No pull request', status: 'doing', kind: 'agent', history: [] }),
];
function keyFetch(onFirst) {
  const base = ghFetch();
  let first = true;
  const fn = async (url) => {
    if (first && onFirst) { first = false; onFirst(); }
    if (/\/pulls\/65$/.test(url)) return { ok: true, status: 200, json: async () => ({ state: 'open', merged: false, head: { sha: HEAD } }) };
    if (/issues\/65\/comments/.test(url)) return { ok: true, status: 200, json: async () => [{ body: 'Reviewer: PASS', created_at: '2026-10-26T01:00:00Z' }] };
    return base(url);
  };
  fn.calls = base.calls;
  return fn;
}
const data = (db, id) => JSON.parse(db.rows.get(id).data);

test('key sync: an open PR gets the exact full head checks line and reviewer claim; status, ask, needsOwner and gates stay; no other card is read or touched', async () => {
  const { syncBoard, syncText } = await import(src('sync.js'));
  const db = fakeDb(keySeed());
  const before = Object.fromEntries([...db.rows.keys()].map((id) => [id, db.rows.get(id).data]));
  const fetchImpl = keyFetch();
  const r = await syncBoard({ GITHUB_MERGE_TOKEN: 'x' }, db, 'agent', { key: 'TASK-74', fetchImpl });
  const c = data(db, 'k1');
  assert.equal(c.evidence.checks, `pass (1 runs on ${HEAD}, synced from GitHub)`);
  assert.match(c.evidence.reviewerComment, /PASS.*reviewer identity unverified/);
  assert.equal(c.status, 'review');
  assert.equal(c.needsOwner, false);
  assert.deepEqual(c.ask, { kind: 'merge', text: 'Merge pull request 65', pr: PR(65), to: 'agent', by: 'reviewer', via: 'agent2', at: 'T0' });
  assert.deepEqual(c.gates.reviewer, { verdict: 'PASS', sha: HEAD });
  assert.equal(c.evidence.reviewedHead, HEAD);
  assert.match(c.history.at(-1).what, /^synced from GitHub by agent: checks pass on GitHub/);
  for (const id of ['k2', 'k3', 'k4', 'k5', 'k6']) assert.equal(db.rows.get(id).data, before[id], `${id} untouched`);
  assert.ok(fetchImpl.calls.every((u) => /\/(pulls|issues)\/65\b|head_sha=/.test(u)), 'only PR 65 was read');
  assert.equal(r.key, 'TASK-74');
  assert.match(syncText(r), /^Key sync of TASK-74: checks and reviewer comment only/);
  // Second press: already matches, nothing written.
  const again = await syncBoard({ GITHUB_MERGE_TOKEN: 'x' }, db, 'agent', { key: 'TASK-74', fetchImpl: keyFetch() });
  assert.equal(again.changed.length, 0);
  assert.equal(again.unchanged, 1);
});

test('planSync evidenceOnly: the patch holds evidence.checks and evidence.reviewerComment only, even for a merged PR', async () => {
  const { planSync } = await import(src('sync.js'));
  const gh = { merged: true, state: 'closed', mergedShaFull: 'deadbeef1234', headFull: HEAD, checks: 'success', checkCount: 2, reviewer: { verdict: 'PASS', at: 'T1' } };
  const plan = planSync({ status: 'doing', kind: 'agent', ask: { kind: 'go' }, needsOwner: true, evidence: { pr: PR(1) } }, gh, { evidenceOnly: true });
  assert.deepEqual(Object.keys(plan.patch), ['evidence']);
  assert.deepEqual(Object.keys(plan.patch.evidence).sort(), ['checks', 'reviewerComment']);
  const openPlan = planSync({ status: 'todo', evidence: { pr: PR(1) } }, { merged: false, state: 'open', headFull: HEAD, checks: 'pending', checkCount: 1 }, { evidenceOnly: true });
  assert.deepEqual(Object.keys(openPlan.patch), ['evidence']);
  assert.equal(openPlan.patch.evidence.checks, `pending (1 runs on ${HEAD}, synced from GitHub)`);
});

test('key sync: a merged PR does not move the card to done or record the merge sha; dry writes nothing', async () => {
  const { syncBoard } = await import(src('sync.js'));
  const db = fakeDb(keySeed());
  const dry = await syncBoard({ GITHUB_MERGE_TOKEN: 'x' }, db, 'agent2', { key: 'TASK-80', dry: true, fetchImpl: keyFetch() });
  assert.equal(dry.changed.length, 1);
  assert.equal(data(db, 'k2').history.length, 0, 'dry wrote nothing');
  await syncBoard({ GITHUB_MERGE_TOKEN: 'x' }, db, 'agent2', { key: 'TASK-80', fetchImpl: keyFetch() });
  const c = data(db, 'k2');
  assert.equal(c.status, 'review');
  assert.equal(c.needsOwner, true);
  assert.equal(c.ask.kind, 'go');
  assert.equal(c.evidence.merged, undefined);
  assert.match(c.evidence.checks, /^pass \(1 runs on aaaa111bbbb, synced from GitHub\)$/);
  await syncBoard({ GITHUB_MERGE_TOKEN: 'x' }, db, 'agent2', { key: 'TASK-75', fetchImpl: keyFetch() });
  assert.equal(data(db, 'k3').status, 'blocked');
});

test('key sync: unknown key, a card with no pull request and a board mismatch are refused; a version conflict is reported and nothing is overwritten', async () => {
  const { syncBoard } = await import(src('sync.js'));
  const env = { GITHUB_MERGE_TOKEN: 'x' };
  await assert.rejects(syncBoard(env, fakeDb(keySeed()), 'agent2', { key: 'TASK-999', fetchImpl: keyFetch() }), /no card TASK-999/);
  await assert.rejects(syncBoard(env, fakeDb(keySeed()), 'agent2', { key: 'TASK-83', fetchImpl: keyFetch() }), /names no pull request/);
  await assert.rejects(syncBoard(env, fakeDb(keySeed()), 'agent2', { key: 'TASK-74', board: 'test-diner', fetchImpl: keyFetch() }), /is on board main/);
  await assert.rejects(syncBoard(env, fakeDb(keySeed()), 'agent2', { key: 'TASK-74', scope: 'test-diner', fetchImpl: keyFetch() }), /outside this token's board/);
  const db = fakeDb(keySeed());
  // Someone else writes the card while GitHub is being read.
  const bump = () => { const r = db.rows.get('k1'); db.rows.set('k1', { ...r, version: r.version + 1 }); };
  const r = await syncBoard(env, db, 'agent2', { key: 'TASK-74', fetchImpl: keyFetch(bump) });
  assert.equal(r.changed.length, 0);
  assert.equal(r.unreadable.length, 1);
  assert.match(r.unreadable[0].why, /write failed: version mismatch/);
  assert.equal(data(db, 'k1').evidence.checks, `pass (rerun job 1 on ${HEAD.slice(0, 7)})`, 'the other write stands');
});

test('whole board sync: a production card with its deploy still open keeps its status; a deployed one and an ordinary merged card still close', async () => {
  const { syncBoard, planSync, deployOpen } = await import(src('sync.js'));
  assert.equal(deployOpen({ kind: 'production', evidence: {} }), true);
  assert.equal(deployOpen({ kind: 'production', evidence: { deployedSha: 'abc' } }), false);
  assert.equal(deployOpen({ kind: 'agent', evidence: {} }), false);
  const plan = planSync({ kind: 'production', status: 'review', ask: { kind: 'go', text: 'Go' }, needsOwner: true, evidence: { pr: PR(1) } }, { merged: true, state: 'closed', mergedShaFull: 'deadbeef1234', checks: 'unknown', checkCount: 0 });
  assert.equal(plan.patch.status, undefined);
  assert.equal(plan.patch.ask, undefined);
  assert.equal(plan.patch.needsOwner, undefined);
  assert.equal(plan.patch.evidence.merged, 'deadbeef1234');
  assert.match(plan.lines[0], /production deploy still open, status kept/);
  const db = fakeDb(keySeed());
  await syncBoard({ GITHUB_MERGE_TOKEN: 'x' }, db, 'owner', { board: 'main', fetchImpl: keyFetch() });
  const open = data(db, 'k3');
  assert.equal(open.status, 'blocked');
  assert.equal(open.evidence.merged, 'deadbeefcafe1234');
  assert.equal(data(db, 'k4').status, 'done', 'a recorded deploy lets the merge close it');
  assert.equal(data(db, 'k2').status, 'done', 'an ordinary merged card still closes');
  assert.ok(!data(db, 'k2').ask, 'its ask is cleared');
  assert.equal(data(db, 'k1').status, 'review');
  // A second whole board press finds the open production card already matching: no history churn.
  const n = data(db, 'k3').history.length;
  await syncBoard({ GITHUB_MERGE_TOKEN: 'x' }, db, 'owner', { board: 'main', fetchImpl: keyFetch() });
  assert.equal(data(db, 'k3').history.length, n);
});

test('sync_github MCP tool takes key and passes it through', async () => {
  const mcp = await import(src('mcp.js'));
  const tool = mcp.TOOLS.find((t) => t.name === 'sync_github');
  assert.ok(tool.inputSchema.properties.key);
  const db = fakeDb(keySeed());
  const out = await mcp.handleRpc({ DB: db, GITHUB_MERGE_TOKEN: 'x', HANDBOOK: 'x', fetchImpl: keyFetch() }, 'agent', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sync_github', arguments: { key: 'TASK-74' } } });
  assert.match(out.json.result.content[0].text, /^Key sync of TASK-74/);
  assert.equal(data(db, 'k1').evidence.checks, `pass (1 runs on ${HEAD}, synced from GitHub)`);
  assert.equal(data(db, 'k5').history.length, 0);
});
