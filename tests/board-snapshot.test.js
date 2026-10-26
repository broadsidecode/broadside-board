'use strict';

// The plain text snapshot and its GitHub cross check. Fake D1 and a fake GitHub fetch, no network.
//   node --test tests/board-snapshot.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const src = (f) => pathToFileURL(path.join(__dirname, '..', 'worker', 'src', f)).href;
const NOW = '2026-10-23T12:00:00.000Z';
const PR11 = 'https://github.com/example-org/test-diner/pull/11';
const PR12 = 'https://github.com/example-org/test-diner/pull/12';
const PR13 = 'https://github.com/example-org/test-diner/pull/13';

const row = (id, data, version = 1) => ({ id, version, updated_at: NOW, data: JSON.stringify(data) });

function fakeDb(boards, tasks, counters) {
  return {
    prepare(sql) {
      const api = {
        bind() { return api; },
        async all() {
          if (/FROM board_boards/.test(sql)) return { results: boards };
          if (/FROM board_tasks/.test(sql)) return { results: tasks };
          if (/FROM board_counters/.test(sql)) return { results: counters };
          return { results: [] };
        },
      };
      return api;
    },
  };
}

const boards = [row('main', { name: 'Main', prefix: 'KIT', order: 0 }), row('test-diner', { name: 'Test Diner', prefix: 'TDN', order: 1 })];
const counters = [{ id: 'KIT', next: 30, version: 3 }, { id: 'TDN', next: 15, version: 2 }];

const tdn14 = {
  board: 'test-diner', key: 'TDN-14', num: 14, title: 'Apply Jiro Template', status: 'review', kind: 'agent', lane: 'lane1',
  owner: 'reviewer', priority: 100, note: 'Awaiting merge', needsOwner: true, createdBy: 'agent', touchedBy: ['agent', 'worker'],
  workType: 'newPage', skillsRequired: ['noslop'], skillsUsed: ['noslop', 'frontend-design'],
  doneCriteria: [{ text: 'Template applied', done: true }, { text: 'Adapted to the diner', done: false }],
  evidence: { pr: PR11, preview: 'https://pr-11.test-diner.pages.dev', checks: 'pass' },
  gates: { reviewer: { verdict: 'PASS', at: '2026-10-23T04:33:39.000Z' } },
  ask: { kind: 'merge', text: 'Merge pull request 11', pr: PR11, by: 'reviewer', at: '2026-10-23T05:00:00Z' },
  questions: [{ q: 'Hours clock?', by: 'builder' }],
  history: [1, 2, 3, 4, 5].map((n) => ({ at: `2026-10-23T0${n}:00:00Z`, by: 'builder', what: `step ${n} ${String.fromCharCode(8212)} done` })),
};
const bsc23 = {
  board: 'main', key: 'TASK-23', num: 23, title: 'Merge board sync', status: 'done', kind: 'agent', lane: 'worker',
  evidence: { pr: PR12, merged: '6a5d28f00cf4fb77fe885822e0cbf9492e5be2bb' }, history: [],
};
const bsc24 = { board: 'main', key: 'TASK-24', num: 24, title: 'Doing thing', status: 'doing', kind: 'agent', lane: 'lane2',
  evidence: { pr: PR13, checks: 'pass' }, updated: '2026-10-23T06:00:00Z', history: [] };
const bsc25 = { board: 'main', key: 'TASK-25', num: 25, title: 'In review no pr', status: 'review', kind: 'agent', history: [] };
const tasks = [row('a', tdn14), row('b', bsc23), row('c', bsc24), row('d', bsc25)];

function ghFetch(overrides = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const respond = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
    for (const [frag, body] of Object.entries(overrides)) if (url.includes(frag)) return body instanceof Error ? Promise.reject(body) : respond(body.body, body.ok !== false, body.status || 200);
    const n = Number((url.match(/pulls\/(\d+)$/) || url.match(/(?:issues|pulls)\/(\d+)\//) || [])[1]);
    if (/\/pulls\/\d+$/.test(url)) {
      if (n === 11) return respond({ state: 'open', merged: false, mergeable: true, head: { sha: 'b5ba892aaaa' }, created_at: '2026-10-23T03:00:00Z', updated_at: '2026-10-23T05:00:00Z' });
      if (n === 12) return respond({ state: 'closed', merged: true, mergeable: null, head: { sha: '6a5d28fbbbb' }, created_at: '2026-10-23T04:00:00Z', updated_at: '2026-10-23T05:00:00Z', merge_commit_sha: '6a5d28f00cf4' });
      return respond({ message: 'Not Found' }, false, 404);
    }
    if (/check-runs/.test(url)) {
      return respond({ check_runs: [{ status: 'completed', conclusion: n === 11 ? 'success' : 'success' }] });
    }
    if (/issues\/11\/comments/.test(url)) {
      return respond([
        { body: 'Reviewer: PASS on commit b5ba892', created_at: '2026-10-23T04:33:00Z' },
        { body: 'Reviewer: FAIL on commit c0ffee1, 3 findings', created_at: '2026-10-23T04:50:00Z' },
      ]);
    }
    if (/issues\/\d+\/comments/.test(url)) return respond([]);
    if (/pulls\/11\/files/.test(url)) return respond([{ filename: 'tasks/apply-jiro.json' }, { filename: 'site/index.html' }]);
    if (/pulls\/\d+\/files/.test(url)) return respond([{ filename: 'site/index.html' }]);
    return respond({});
  };
  fn.calls = calls;
  return fn;
}

const env = { DB: fakeDb(boards, tasks, counters), GITHUB_MERGE_TOKEN: 'x' };

test('GitHub facts retain the full PR head for merge checks while snapshot can show a short head', async () => {
  const { fetchPrFacts } = await import(src('snapshot.js'));
  const head = 'f'.repeat(40);
  const fetchImpl = async (url) => ({ ok: true, status: 200, json: async () => (
    /\/pulls\/11$/.test(url) ? { state: 'open', merged: false, head: { sha: head } } :
      /actions\/runs/.test(url) ? { workflow_runs: [{ name: 'PR checks', workflow_id: 1, head_sha: head, status: 'completed', conclusion: 'success' }] } : []
  ) });
  const facts = await fetchPrFacts(env, { owner: 'example-org', repo: 'test-diner', number: 11 }, fetchImpl);
  assert.equal(facts.headFull, head);
  assert.equal(facts.head, head.slice(0, 7));
});

test('snapshot has the sections, header counts and a known card block', async () => {
  const { buildSnapshot } = await import(src('snapshot.js'));
  const text = await buildSnapshot(env, 'worker', { now: NOW, fetchImpl: ghFetch() });
  for (const h of ['BOARD SNAPSHOT', '== ASKS FOR OWNER ==', '== CARDS ==', '== GITHUB CROSS CHECK ==', '== ENVIRONMENT ==']) {
    assert.ok(text.includes(h), h);
  }
  assert.match(text, /read by: worker/);
  assert.match(text, /open cards: 3/);
  assert.match(text, /asks for Owner: 1/);
  assert.match(text, /\nCARD TDN-14\n/);
  assert.match(text, /  done criteria: 1 of 2\n  unmet: Adapted to the diner/);
  assert.match(text, /  gate reviewer: PASS at 2026-10-23T04:33:39.000Z/);
  assert.match(text, /  evidence pr: https:\/\/github.com\/example-org\/test-diner\/pull\/11/);
  assert.match(text, /question: Hours clock\?/);
  assert.match(text, /counters next: KIT 30, TDN 15/);
  assert.match(text, /done TASK-23: Merge board sync merged 6a5d28f/);
  // only the last three history lines
  assert.ok(!text.includes('step 2'));
  assert.ok(text.includes('step 5'));
  assert.ok(!/[^\x00-\x7F]/.test(text), 'ASCII only');
  // the ASK block names the raiser
  assert.match(text, /ASK TDN-14\n[\s\S]*?  from: reviewer\n  to: owner\n  since: 2026-10-23T05:00:00Z\n  pr: /);
});

test('cross check: TDN-14 mismatches on Reviewer, TASK-23 matches, GitHub failure and no-PR cases', async () => {
  const { buildSnapshot } = await import(src('snapshot.js'));
  const text = await buildSnapshot(env, 'worker', { now: NOW, fetchImpl: ghFetch() });
  const x = text.slice(text.indexOf('== GITHUB CROSS CHECK =='));
  assert.match(x, /PR example-org\/test-diner#11/);
  assert.match(x, /github reviewer comment: FAIL at 2026-10-23T04:50:00Z/);
  assert.match(x, /MISMATCH TDN-14: card says Reviewer PASS but the last Reviewer comment on GitHub is FAIL/);
  assert.match(x, /github task file: tasks\/apply-jiro.json/);
  const bsc = x.slice(x.indexOf('#12')).split(/\n\n/)[0];
  assert.match(bsc, /github: state closed, merged yes/);
  assert.match(bsc, /no mismatch/);
  assert.ok(!bsc.includes('MISMATCH'));
  assert.match(x, /PR example-org\/test-diner#13[\s\S]*github: GitHub call failed \(http 404\)/);
  assert.match(x, /MISMATCH TASK-25: card is in review but has no pull request/);
});

test('crossCheck rules', async () => {
  const { crossCheck } = await import(src('snapshot.js'));
  const now = new Date(NOW);
  const gh = { state: 'closed', merged: true, checks: 'failure', createdAt: '2026-10-23T01:00:00Z', reviewer: { verdict: 'PASS' } };
  const out = crossCheck({ status: 'review', evidence: { checks: 'pass' } }, gh, now).join('|');
  assert.match(out, /checks pass but GitHub shows failing/);
  assert.match(out, /merged but the card is not done/);
  assert.match(out, /Reviewer PASS comment but the card has no gates.reviewer|Reviewer PASS comment/);
  const stale = crossCheck({ status: 'doing', updated: '2026-10-23T08:00:00Z' },
    { state: 'open', merged: false, checks: 'none', createdAt: '2026-10-23T08:00:00Z', reviewer: null }, now);
  assert.ok(stale.some((l) => /older than 2 hours/.test(l)));
  const fresh = crossCheck({ status: 'doing', updated: '2026-10-23T11:30:00Z' },
    { state: 'open', merged: false, checks: 'none', createdAt: '2026-10-23T08:00:00Z', reviewer: null }, now);
  assert.deepEqual(fresh, []);
  const rev = crossCheck({ status: 'review', gates: { reviewer: { verdict: 'PASS' } } },
    { state: 'open', merged: false, checks: 'success', reviewer: null }, now);
  assert.ok(rev.some((l) => /no "Reviewer: PASS" or "Reviewer: FAIL" comment/.test(l)));
});

test('checks come from the workflow runs, in four GitHub calls per pull request', async () => {
  const { fetchPrFacts } = await import(src('snapshot.js'));
  const f = ghFetch({
    'actions/runs?head_sha=': { body: { workflow_runs: [
      { name: 'preview', workflow_id: 2, status: 'completed', conclusion: 'success', created_at: '2026-10-24T00:00:00Z' },
      { name: 'checks', workflow_id: 1, status: 'completed', conclusion: 'failure', created_at: '2026-10-24T00:00:00Z' },
    ] } },
  });
  const facts = await fetchPrFacts(env, { owner: 'example-org', repo: 'test-diner', number: 11 }, f);
  assert.equal(facts.checks, 'failure');
  assert.equal(facts.checkCount, 2);
  assert.ok(f.calls.some((u) => /actions\/runs\?head_sha=b5ba892aaaa/.test(u)));
  // The free Workers plan allows 50 outbound calls per request: no check runs or status calls, which the token cannot read anyway.
  assert.equal(f.calls.length, 4);
  assert.ok(!f.calls.some((u) => /check-runs|\/status$/.test(u)));
});

test('the capped cross check reaches merge asks first, newest first', async () => {
  const { githubOrder } = await import(src('snapshot.js'));
  const card = (key, updated, ask) => ({ data: { key, updated, ...(ask ? { ask: { kind: ask } } : {}) } });
  const oldBlocked = card('TDN-3', '2026-10-20', 'decide');
  const mergeOld = card('TDN-22', '2026-10-23', 'merge');
  const mergeNew = card('TDN-29', '2026-10-24', 'merge');
  const plain = card('TDN-9', '2026-10-24');
  const done = card('TDN-1', '2026-10-19');
  const order = githubOrder([oldBlocked, mergeOld, mergeNew], [oldBlocked, mergeOld, mergeNew, plain], [done]).map((d) => d.data.key);
  assert.deepEqual(order, ['TDN-29', 'TDN-22', 'TDN-3', 'TDN-9', 'TDN-1']);
});

test('only the latest run of each workflow counts, so a passing re-run clears an earlier failure', async () => {
  const { workflowVerdict } = await import(src('snapshot.js'));
  const runs = (list) => ({ workflow_runs: list });
  assert.deepEqual(workflowVerdict(runs([
    { name: 'checks', workflow_id: 1, status: 'completed', conclusion: 'failure', created_at: '2026-10-24T00:00:00Z' },
    { name: 'checks', workflow_id: 1, status: 'completed', conclusion: 'success', created_at: '2026-10-24T00:05:00Z' },
    { name: 'preview', workflow_id: 2, status: 'completed', conclusion: 'success', created_at: '2026-10-24T00:00:00Z' },
    { name: 'board-sync', workflow_id: 3, status: 'completed', conclusion: 'failure', created_at: '2026-10-24T00:06:00Z' },
  ])), { checks: 'success', checkCount: 2 });
  assert.equal(workflowVerdict(runs([{ name: 'checks', workflow_id: 1, status: 'in_progress', conclusion: null, created_at: '2026-10-24T00:00:00Z' }])).checks, 'pending');
  assert.equal(workflowVerdict(runs([{ name: 'checks', workflow_id: 1, status: 'completed', conclusion: 'skipped', created_at: '2026-10-24T00:00:00Z' }])).checks, 'failure');
  assert.equal(workflowVerdict(runs([])).checks, 'none');
  assert.equal(workflowVerdict(null).checks, 'unknown');
});

test('a missing token or a GitHub outage still returns the rest', async () => {
  const { buildSnapshot } = await import(src('snapshot.js'));
  const noTok = await buildSnapshot({ DB: env.DB }, 'agent', { now: NOW });
  assert.match(noTok, /GitHub cross check skipped: the board has no GitHub token set/);
  assert.match(noTok, /CARD TDN-14/);
  const down = await buildSnapshot(env, 'agent', { now: NOW, fetchImpl: async () => { throw new Error('network down'); } });
  assert.match(down, /GitHub call failed \(network down\)/);
  assert.match(down, /== ENVIRONMENT ==/);
  const off = await buildSnapshot(env, 'agent', { now: NOW, github: false });
  assert.match(off, /skipped: not requested/);
});

test('board filter limits the cards', async () => {
  const { buildSnapshot } = await import(src('snapshot.js'));
  const e = { DB: fakeDb(boards, [row('a', tdn14)], counters) };
  const text = await buildSnapshot(e, 'owner', { now: NOW, board: 'test-diner', github: false });
  assert.match(text, /scope: board test-diner/);
  assert.ok(!text.includes('BOARD main'));
});

test('size cap trims history first, then done cards', async () => {
  const { buildSnapshot } = await import(src('snapshot.js'));
  const many = [];
  for (let i = 1; i <= 120; i++) {
    many.push(row(`k${i}`, {
      board: 'main', key: `TASK-${i}`, num: i, title: `Card ${i}`, status: 'doing', kind: 'agent', note: 'n'.repeat(400),
      history: [1, 2, 3].map((n) => ({ at: 't', by: 'builder', what: 'w'.repeat(200) + n })),
      doneCriteria: Array.from({ length: 8 }, (_, j) => ({ text: `unmet criterion number ${j} `.repeat(4), done: false })),
    }));
  }
  const text = await buildSnapshot({ DB: fakeDb(boards, many, counters) }, 'worker', { now: NOW, github: false });
  assert.ok(text.length <= 60 * 1024, `size ${text.length}`);
  assert.ok(!text.includes('history: t builder'), 'history trimmed first');
  assert.match(text, /CARD TASK-120/);
});

test('snapshot is an MCP tool and the instructions mention it', async () => {
  const mcp = await import(src('mcp.js'));
  assert.ok(mcp.TOOLS.some((t) => t.name === 'snapshot'));
  assert.match(mcp.BOARD_INSTRUCTIONS, /call snapshot; it includes a GitHub cross check with MISMATCH lines/);
  const r = await mcp.handleRpc({ ...env, HANDBOOK: 'x' }, 'agent2',
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'snapshot', arguments: { github: false } } });
  assert.match(r.json.result.content[0].text, /BOARD SNAPSHOT/);
  assert.match(r.json.result.content[0].text, /read by: agent2/);
});
