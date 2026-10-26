'use strict';

// The ask field and the approve route. In-memory D1 stand-in and a fake GitHub fetch, no network.
//   node --test tests/board-ask.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const src = (f) => pathToFileURL(path.join(__dirname, '..', 'worker', 'src', f)).href;
const PR = 'https://github.com/example-org/franks-bbq/pull/11';
const REVIEWED_HEAD = 'a'.repeat(40);
const MERGE_REVIEW = { reviewer: { verdict: 'PASS', sha: REVIEWED_HEAD } };

function fakeDb() {
  const rows = new Map();
  const stmt = (sql) => {
    let args = [];
    const api = {
      bind(...a) { args = a; return api; },
      async first() {
        if (/FROM board_tasks WHERE id = \?/.test(sql)) return rows.get(args[0]) || null;
        return null;
      },
      async run() {
        if (/^INSERT INTO board_tasks/.test(sql)) rows.set(args[0], { id: args[0], data: args[6], version: args[7], updated_at: args[8] });
        else if (/^UPDATE board_tasks SET board/.test(sql)) {
          const id = args[args.length - 1];
          const r = rows.get(id);
          if (r.version !== args[6]) throw new Error('NOT NULL constraint failed: board_tasks.version');
          rows.set(id, { ...r, data: args[5], version: r.version + 1, updated_at: args[args.length - 2] });
        }
        return {};
      },
    };
    return api;
  };
  const db = { rows, prepare: stmt, batches: 0, failBatchAt: 0 };
  db.batch = async (list) => {
    db.batches++;
    if (db.batches === db.failBatchAt) throw new Error('D1_ERROR: interrupted after merge ack');
    for (const s of list) await s.run();
    return [];
  };
  return db;
}

// Every card says how it is undone: a merge ask is refused without evidence.rollback.
const ROLLBACK = { to: 'the site before this change', how: 'revert the merge commit and redeploy', cannot: 'nothing' };
const card = (extra = {}) => ({ title: 'T', status: 'review', kind: 'agent', board: 'franks', key: 'FRK-3', history: [], evidence: { rollback: ROLLBACK }, ...extra });
const read = (db, id) => JSON.parse(db.rows.get(id).data);

async function seed(extra) {
  const store = await import(src('store.js'));
  const db = fakeDb();
  // The normal merge fixtures represent a successful GitHub sync on the reviewed head.
  if (extra?.evidence?.reviewedHead && !Object.hasOwn(extra.evidence, 'checks')) {
    extra = { ...extra, evidence: { ...extra.evidence, checks: `pass (1 runs on ${extra.evidence.reviewedHead}, synced from GitHub)` } };
  }
  // Owner makes the card; the cloud thread raises its ask,
  // the one write it keeps. Production asks stay Owner's own, as before.
  const { ask, ...rest } = card(extra);
  await store.writeTask(db, 'owner', { op: 'put', id: 'c1', data: rest });
  if (ask !== undefined) await store.writeTask(db, extra && extra.kind === 'production' ? 'owner' : 'cloud-worker', { op: 'patch', id: 'c1', ifVersion: 1, data: { ask } });
  db.batches = 1; // the seed counts as one write for the failBatchAt tests
  return { db, store };
}

function fakeFetch(res) {
  const calls = [];
  const fn = async (url, init) => {
    if (url.includes('/actions/runs?')) { fn.checkReads++; return greenChecks(url); }
    calls.push({ url, init });
    return { ok: res.ok, status: res.status || (res.ok ? 200 : 405), json: async () => res.body };
  };
  fn.calls = calls;
  fn.checkReads = 0;
  return fn;
}

function greenChecks(url) {
  const sha = new URL(url).searchParams.get('head_sha');
  return { ok: true, status: 200, json: async () => ({ workflow_runs: [{ name: 'PR checks', workflow_id: 1, head_sha: sha, status: 'completed', conclusion: 'success', created_at: '2026-10-25T12:00:00Z' }] }) };
}

test('applyAskRule: setting an ask fills defaults; a merge ask goes to Agent, not Owner', async () => {
  const lib = await import(src('lib.js'));
  const r = lib.applyAskRule(null, card({ ask: { kind: 'merge', pr: PR } }), 'lane1', 'NOW');
  assert.equal(r.problem, null);
  assert.equal(r.card.needsOwner, false);
  assert.equal(r.card.waitingOn, 'agent');
  assert.deepEqual(r.card.ask, { kind: 'merge', text: 'Merge pull request 11', pr: PR, by: 'lane1', via: 'lane1', at: 'NOW', to: 'agent' });
  const signed = lib.applyAskRule(null, card({ ask: { kind: 'decide', text: 'Hours clock?', by: 'reviewer' } }), 'cloud-worker', 'N').card.ask;
  assert.equal(signed.by, 'reviewer'); assert.equal(signed.via, 'cloud-worker');
  assert.equal(lib.applyAskRule(null, card({ ask: { kind: 'decide', text: 'x', by: 'nobody' } }), 'cloud-worker', 'N').card.ask.by, 'cloud-worker');
  assert.equal(lib.applyAskRule(null, card({ ask: { kind: 'go' } }), 'x', 'N').card.ask.text, 'Go for production');
  assert.equal(lib.applyAskRule(null, card({ ask: { kind: 'decide', text: 'Pick a hero' } }), 'x', 'N').card.ask.text, 'Pick a hero');
});

test('applyAskRule: bad kind, missing or foreign pull request are refused', async () => {
  const lib = await import(src('lib.js'));
  assert.match(lib.applyAskRule(null, card({ ask: { kind: 'nuke' } }), 'x', 'N').problem, /ask\.kind/);
  assert.match(lib.applyAskRule(null, card({ ask: { kind: 'merge' } }), 'x', 'N').problem, /pull request/);
  assert.match(lib.applyAskRule(null, card({ ask: { kind: 'merge', pr: 'https://github.com/evil/repo/pull/1' } }), 'x', 'N').problem, /configured GitHub organization/);
});

test('applyAskRule: the same ask keeps its by and at; clearing clears needsOwner unless approval', async () => {
  const lib = await import(src('lib.js'));
  const first = lib.applyAskRule(null, card({ ask: { kind: 'go' } }), 'lane1', 'T1').card;
  const again = lib.applyAskRule(first, { ...first, ask: { kind: 'go', text: 'Go for production' } }, 'worker', 'T2').card;
  assert.equal(again.ask.by, 'lane1');
  assert.equal(again.ask.at, 'T1');
  const cleared = lib.applyAskRule(first, { ...first, ask: null }, 'worker', 'T3').card;
  assert.equal(cleared.needsOwner, false);
  assert.equal('ask' in cleared, false);
  const inApproval = lib.applyAskRule({ ...first, status: 'approval' }, { ...first, status: 'approval', ask: null }, 'worker', 'T3').card;
  assert.equal(inApproval.needsOwner, true);
  const done = lib.applyAskRule(first, { ...first, status: 'done' }, 'github-actions', 'T4').card;
  assert.equal('ask' in done, false);
  assert.equal(done.needsOwner, false);
});

test('store: every write path applies the rule, and the server stamps by', async () => {
  const { db, store } = await seed();
  const v = (await store.getTask(db, 'c1')).version;
  await store.writeTask(db, 'worker', { op: 'patch', id: 'c1', ifVersion: v, data: { ask: { kind: 'decide', text: 'Proof ask', by: 'someone-else' } } });
  let c = read(db, 'c1');
  assert.equal(c.needsOwner, true);
  assert.equal(c.ask.by, 'worker');
  assert.equal(c.ask.kind, 'decide');
  await store.writeTask(db, 'worker', { op: 'patch', id: 'c1', ifVersion: v + 1, data: { ask: null } });
  c = read(db, 'c1');
  assert.equal(c.needsOwner, false);
  assert.equal('ask' in c, false);
  await assert.rejects(store.writeTask(db, 'worker', { op: 'patch', id: 'c1', ifVersion: v + 2, data: { ask: { kind: 'merge' } } }), (e) => e.status === 400);
  const batch = await store.writeBatch(db, 'worker', [{ op: 'patch', id: 'c1', ifVersion: v + 2, data: { ask: { kind: 'go' } } }], true);
  assert.equal(batch.length, 1);
  assert.equal(read(db, 'c1').needsOwner, true);
});

test('approve: merge ask pins the reviewed head, squash merges through GitHub, clears the ask, records evidence', async () => {
  const { db } = await seed({ evidence: { rollback: ROLLBACK, reviewedHead: REVIEWED_HEAD }, gates: MERGE_REVIEW, ask: { kind: 'merge', pr: PR, text: 'Merge pull request 11' } });
  assert.equal(read(db, 'c1').ask.sha, REVIEWED_HEAD);
  const { approveCard } = await import(src('approve.js'));
  const f = fakeFetch({ ok: true, body: { merged: true, sha: 'abcdef1234567890'.padEnd(40, '0') } });
  const out = await approveCard({ GITHUB_MERGE_TOKEN: 'tok' }, db, 'owner', 'c1', { decision: 'approve' }, f);
  assert.equal(out.ok, true);
  assert.equal(out.merged, 'abcdef1234567890'.padEnd(40, '0'));
  assert.equal(f.calls.length, 1);
  assert.equal(f.checkReads, 1);
  assert.equal(f.calls[0].url, 'https://api.github.com/repos/example-org/franks-bbq/pulls/11/merge');
  assert.equal(f.calls[0].init.method, 'PUT');
  assert.equal(JSON.parse(f.calls[0].init.body).merge_method, 'squash');
  assert.equal(JSON.parse(f.calls[0].init.body).sha, REVIEWED_HEAD);
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer tok');
  const c = read(db, 'c1');
  assert.equal(c.needsOwner, false);
  assert.equal('ask' in c, false);
  assert.equal(c.evidence.merged, 'abcdef1234567890'.padEnd(40, '0'));
  assert.equal(c.status, 'review');
  assert.match(c.history.at(-1).what, /^Owner approved: Merge pull request 11; pull request merged abcdef1/);
  assert.equal(c.history.at(-1).by, 'owner');
});

test('merge producer: synced checks and a comment do not replace an exact-head independent gate', async () => {
  const { db, store } = await seed({ evidence: { rollback: ROLLBACK, pr: PR } });
  const { planSync } = await import(src('sync.js'));
  const { approveCard } = await import(src('approve.js'));
  const patch = async (data) => store.writeTask(db, 'cloud-worker', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data });
  const synced = planSync(read(db, 'c1'), { state: 'open', headFull: REVIEWED_HEAD, checks: 'success', checkCount: 1, reviewer: { verdict: 'PASS', at: '2026-10-25T12:00:00Z' } });
  // The Sync write, as sync.js makes it: the GitHub mirror, not the thread's own write.
  await store.writeTask(db, 'cloud-worker', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data: synced.patch }, { sync: true });
  assert.match(read(db, 'c1').evidence.reviewerComment, /identity unverified/);
  await patch({ ask: { kind: 'merge', pr: PR } });
  assert.equal(read(db, 'c1').ask.sha, undefined);
  const noReview = fakeFetch({ ok: true, body: { merged: true, sha: 'c'.repeat(40) } });
  await assert.rejects(approveCard({ GITHUB_MERGE_TOKEN: 'tok' }, db, 'owner', 'c1', { decision: 'approve' }, noReview), (e) => e.status === 409);
  assert.equal(noReview.calls.length, 0);

  await patch({ ask: null });
  await patch({ evidence: { reviewedHead: REVIEWED_HEAD }, gates: { reviewer: { verdict: 'PASS', sha: 'b'.repeat(40), notes: 'different head' } } });
  await patch({ ask: { kind: 'merge', pr: PR } });
  assert.equal(read(db, 'c1').ask.sha, undefined);
  const wrongHead = fakeFetch({ ok: true, body: { merged: true, sha: 'c'.repeat(40) } });
  await assert.rejects(approveCard({ GITHUB_MERGE_TOKEN: 'tok' }, db, 'owner', 'c1', { decision: 'approve' }, wrongHead), (e) => e.status === 409);
  assert.equal(wrongHead.calls.length, 0);

  await patch({ ask: null });
  // This simulates the separate reviewer writing the gate after an actual review;
  // the comment and Sync above were deliberately insufficient.
  await patch({ gates: { reviewer: { verdict: 'PASS', sha: REVIEWED_HEAD, notes: 'reviewed exact head' } } });
  await patch({ ask: { kind: 'merge', pr: PR } });
  assert.equal(read(db, 'c1').ask.sha, REVIEWED_HEAD);
  const approved = fakeFetch({ ok: true, body: { merged: true, sha: 'c'.repeat(40) } });
  await approveCard({ GITHUB_MERGE_TOKEN: 'tok' }, db, 'owner', 'c1', { decision: 'approve' }, approved);
  assert.equal(approved.checkReads, 1);
  assert.equal(approved.calls.length, 1);
  assert.equal(JSON.parse(approved.calls[0].init.body).sha, REVIEWED_HEAD);
});

test('approve: a GitHub 405 with no verified merge holds the ask and does not record a merge', async () => {
  const { db } = await seed({ evidence: { rollback: ROLLBACK, reviewedHead: REVIEWED_HEAD }, gates: MERGE_REVIEW, ask: { kind: 'merge', pr: PR } });
  const { approveCard } = await import(src('approve.js'));
  const f = fakeFetch({ ok: false, status: 405, body: { message: 'Pull Request is not mergeable' } });
  await assert.rejects(approveCard({ GITHUB_MERGE_TOKEN: 'tok' }, db, 'owner', 'c1', { decision: 'approve' }, f),
    (e) => e.status === 409 && /unconfirmed/.test(e.message));
  assert.ok(read(db, 'c1').evidence.mergeAttempt.id);
  assert.equal(read(db, 'c1').evidence.merged, undefined);
  assert.equal(read(db, 'c1').ask.kind, 'merge');
});

test('approve: a changed pull request head is refused and records a definite rejection', async () => {
  const { db } = await seed({ evidence: { rollback: ROLLBACK, reviewedHead: REVIEWED_HEAD }, gates: MERGE_REVIEW, ask: { kind: 'merge', pr: PR } });
  let calls = 0;
  const f = async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(init.body).sha, REVIEWED_HEAD);
    return { ok: false, status: 409, json: async () => ({ message: 'Head branch was modified' }) };
  };
  await assert.rejects(approveCardForTest(db, f), (e) => e.status === 409 && /modified/.test(e.message));
  assert.equal(calls, 1);
  assert.equal(read(db, 'c1').evidence.mergeAttempt.state, 'rejected');
  assert.equal(read(db, 'c1').evidence.merged, undefined);
  assert.equal(read(db, 'c1').ask.kind, 'merge');
});

test('approve: definite 409 or 401 rejection can be cleared and reissued after fresh review', async () => {
  const { writeTask } = await import(src('store.js'));
  const nextHead = 'b'.repeat(40);
  for (const githubStatus of [409, 401]) {
    const { db } = await seed({ evidence: { rollback: ROLLBACK, reviewedHead: REVIEWED_HEAD }, gates: MERGE_REVIEW, ask: { kind: 'merge', pr: PR } });
    const calls = [];
    const refusal = async (_url, init) => {
      calls.push({ method: init.method || 'GET', sha: JSON.parse(init.body).sha });
      return { ok: false, status: githubStatus, json: async () => ({ message: 'merge refused' }) };
    };
    await assert.rejects(approveCardForTest(db, refusal), (e) => e.extra.githubStatus === githubStatus);
    assert.deepEqual(calls, [{ method: 'PUT', sha: REVIEWED_HEAD }]);
    assert.equal(read(db, 'c1').evidence.mergeAttempt.state, 'rejected');
    assert.equal(read(db, 'c1').evidence.mergeAttempt.githubStatus, githubStatus);
    assert.equal(read(db, 'c1').evidence.merged, undefined);
    await writeTask(db, 'owner', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data: { ask: null, evidence: { mergeAttempt: { __delete__: true } } } });
    await writeTask(db, 'cloud-worker', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data: { evidence: { checks: `pass (1 runs on ${nextHead}, synced from GitHub)` } } }, { sync: true });
    await writeTask(db, 'cloud-worker', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data: { evidence: { reviewedHead: nextHead }, gates: { reviewer: { verdict: 'PASS', sha: nextHead } } } });
    await writeTask(db, 'cloud-worker', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data: { ask: { kind: 'merge', pr: PR } } });
    assert.equal(read(db, 'c1').ask.sha, nextHead);
    const success = async (_url, init) => {
      calls.push({ method: init.method || 'GET', sha: JSON.parse(init.body).sha });
      return { ok: true, status: 200, json: async () => ({ merged: true, sha: 'c'.repeat(40) }) };
    };
    const out = await approveCardForTest(db, success);
    assert.equal(out.merged, 'c'.repeat(40));
    assert.deepEqual(calls, [{ method: 'PUT', sha: REVIEWED_HEAD }, { method: 'PUT', sha: nextHead }]);
  }
});

test('approve: a failed or ambiguous GitHub response keeps its active claim', async () => {
  const { db } = await seed({ evidence: { rollback: ROLLBACK, reviewedHead: REVIEWED_HEAD }, gates: MERGE_REVIEW, ask: { kind: 'merge', pr: PR } });
  const f = fakeFetch({ ok: false, status: 503, body: { message: 'temporarily unavailable' } });
  await assert.rejects(approveCardForTest(db, f), (e) => e.extra.githubStatus === 503);
  assert.equal(read(db, 'c1').evidence.mergeAttempt.state, undefined);
  assert.equal(read(db, 'c1').ask.kind, 'merge');
  assert.equal(f.calls.length, 1);
});

test('approve: a lost definite-rejection record keeps the claim until its outcome is checked', async () => {
  const { db } = await seed({ evidence: { rollback: ROLLBACK, reviewedHead: REVIEWED_HEAD }, gates: MERGE_REVIEW, ask: { kind: 'merge', pr: PR } });
  db.failBatchAt = 3; // seed, claim, then interrupted rejection record
  const f = fakeFetch({ ok: false, status: 409, body: { message: 'Head branch was modified' } });
  await assert.rejects(approveCardForTest(db, f), /interrupted after merge ack/);
  assert.equal(f.calls.length, 1);
  assert.equal(read(db, 'c1').evidence.mergeAttempt.state, undefined);
  assert.equal(read(db, 'c1').ask.kind, 'merge');
});

test('approve: an acknowledged merge with a lost card write is reconciled by one GET and no second PUT', async () => {
  const { db } = await seed({ evidence: { rollback: ROLLBACK, reviewedHead: REVIEWED_HEAD }, gates: MERGE_REVIEW, ask: { kind: 'merge', pr: PR } });
  db.failBatchAt = 3; // seed, durable merge attempt, then the interrupted final card write
  const mergedSha = 'c'.repeat(40);
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, method: init.method || 'GET' });
    if (init.method === 'PUT') return { ok: true, status: 200, json: async () => ({ merged: true, sha: mergedSha }) };
    return { ok: true, status: 200, json: async () => ({ state: 'closed', merged: true, head: { sha: REVIEWED_HEAD }, merge_commit_sha: mergedSha }) };
  };
  await assert.rejects(approveCardForTest(db, f), /interrupted after merge ack/);
  assert.equal(read(db, 'c1').ask.kind, 'merge');
  assert.match(read(db, 'c1').evidence.mergeAttempt.id, /^[0-9a-f-]{36}$/);
  const out = await approveCardForTest(db, f);
  assert.equal(out.merged, mergedSha);
  assert.deepEqual(calls.map((c) => c.method), ['PUT', 'GET']);
  assert.equal(read(db, 'c1').evidence.merged, mergedSha);
  assert.equal(read(db, 'c1').ask, undefined);
});

test('approve: HTTP 405 alone and an open PR cannot finish or repeat a merge attempt', async () => {
  const { db } = await seed({ evidence: { rollback: ROLLBACK, reviewedHead: REVIEWED_HEAD }, gates: MERGE_REVIEW, ask: { kind: 'merge', pr: PR } });
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, method: init.method || 'GET' });
    return init.method === 'PUT'
      ? { ok: false, status: 405, json: async () => ({ message: 'Pull Request is not mergeable' }) }
      : { ok: true, status: 200, json: async () => ({ state: 'open', merged: false, head: { sha: REVIEWED_HEAD }, merge_commit_sha: null }) };
  };
  // The open read on the attempted head makes the 405 a definite refusal: recorded rejected, never PUT again.
  await assert.rejects(approveCardForTest(db, f), (e) => e.status === 409 && /GitHub refused the merge: .*recorded as rejected/.test(e.message));
  assert.equal(read(db, 'c1').evidence.mergeAttempt.state, 'rejected');
  assert.equal(read(db, 'c1').evidence.mergeAttempt.githubStatus, 405);
  await assert.rejects(approveCardForTest(db, f), (e) => e.status === 409 && /unconfirmed/.test(e.message));
  assert.deepEqual(calls.map((c) => c.method), ['PUT', 'GET', 'GET']);
  assert.equal(read(db, 'c1').ask.kind, 'merge');
  assert.equal(read(db, 'c1').evidence.merged, undefined);
});

test('approve: HTTP 405 finishes only after GET verifies the exact merged PR and head', async () => {
  const { db } = await seed({ evidence: { rollback: ROLLBACK, reviewedHead: REVIEWED_HEAD }, gates: MERGE_REVIEW, ask: { kind: 'merge', pr: PR } });
  const mergedSha = 'c'.repeat(40);
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, method: init.method || 'GET' });
    return init.method === 'PUT'
      ? { ok: false, status: 405, json: async () => ({ message: 'Pull Request is not mergeable' }) }
      : { ok: true, status: 200, json: async () => ({ state: 'closed', merged: true, head: { sha: REVIEWED_HEAD }, merge_commit_sha: mergedSha }) };
  };
  const out = await approveCardForTest(db, f);
  assert.equal(out.merged, mergedSha);
  assert.deepEqual(calls.map((c) => c.method), ['PUT', 'GET']);
  assert.equal(calls[1].url, 'https://api.github.com/repos/example-org/franks-bbq/pulls/11');
});

test('approve: reconciliation rejects a merged PR whose head differs from the attempted SHA', async () => {
  const { db } = await seed({ evidence: { rollback: ROLLBACK, reviewedHead: REVIEWED_HEAD }, gates: MERGE_REVIEW, ask: { kind: 'merge', pr: PR } });
  db.failBatchAt = 3;
  const methods = [];
  const f = async (_url, init) => {
    methods.push(init.method || 'GET');
    return init.method === 'PUT'
      ? { ok: true, status: 200, json: async () => ({ merged: true, sha: 'c'.repeat(40) }) }
      : { ok: true, status: 200, json: async () => ({ state: 'closed', merged: true, head: { sha: 'b'.repeat(40) }, merge_commit_sha: 'c'.repeat(40) }) };
  };
  await assert.rejects(approveCardForTest(db, f), /interrupted after merge ack/);
  await assert.rejects(approveCardForTest(db, f), (e) => e.status === 409 && /unconfirmed/.test(e.message));
  assert.deepEqual(methods, ['PUT', 'GET']);
  assert.equal(read(db, 'c1').evidence.merged, undefined);
});

test('approve: malformed HTTP 200 cannot clear the ask or record a merge', async () => {
  const { db } = await seed({ evidence: { rollback: ROLLBACK, reviewedHead: REVIEWED_HEAD }, gates: MERGE_REVIEW, ask: { kind: 'merge', pr: PR } });
  const f = fakeFetch({ ok: true, body: {} });
  await assert.rejects(approveCardForTest(db, f), (e) => e.status === 502);
  assert.equal(f.calls.length, 1);
  assert.ok(read(db, 'c1').evidence.mergeAttempt.id);
  assert.equal(read(db, 'c1').evidence.merged, undefined);
  assert.equal(read(db, 'c1').ask.kind, 'merge');
});

test('approve: decline and direct ask edits cannot clear a merge in flight', async () => {
  const { db } = await seed({ evidence: { rollback: ROLLBACK, reviewedHead: REVIEWED_HEAD }, gates: MERGE_REVIEW, ask: { kind: 'merge', pr: PR } });
  let entered;
  const putEntered = new Promise((resolve) => { entered = resolve; });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const f = async (_url, init) => {
    if (init.method !== 'PUT') throw new Error('unexpected GET');
    entered();
    await held;
    return { ok: true, status: 200, json: async () => ({ merged: true, sha: 'c'.repeat(40) }) };
  };
  const approving = approveCardForTest(db, f);
  await putEntered;
  const { approveCard } = await import(src('approve.js'));
  const { writeTask } = await import(src('store.js'));
  await assert.rejects(approveCard({}, db, 'owner', 'c1', { decision: 'decline' }), (e) => e.status === 403 && /active merge attempt/.test(e.message));
  await assert.rejects(writeTask(db, 'owner', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data: { ask: null } }), (e) => e.status === 403 && /active merge attempt/.test(e.message));
  await assert.rejects(writeTask(db, 'cloud-worker', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data: { gates: { reviewer: { verdict: 'FAIL' } } } }), (e) => e.status === 403 && /active merge attempt/.test(e.message));
  await assert.rejects(writeTask(db, 'cloud-worker', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data: { evidence: { reviewedHead: 'b'.repeat(40) } } }), (e) => e.status === 403 && /active merge attempt/.test(e.message));
  await assert.rejects(writeTask(db, 'owner', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data: { evidence: { mergeAttempt: { state: 'rejected' } } } }), (e) => e.status === 403 && /active merge attempt/.test(e.message));
  assert.equal(read(db, 'c1').ask.kind, 'merge');
  release();
  assert.equal((await approving).merged, 'c'.repeat(40));
  assert.equal(read(db, 'c1').evidence.merged, 'c'.repeat(40));
});

test('approve: a card version race after merge ACK reconciles by GET without another PUT', async () => {
  const { db } = await seed({ evidence: { rollback: ROLLBACK, reviewedHead: REVIEWED_HEAD }, gates: MERGE_REVIEW, ask: { kind: 'merge', pr: PR } });
  let entered;
  const putEntered = new Promise((resolve) => { entered = resolve; });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const methods = [];
  const f = async (_url, init) => {
    methods.push(init.method || 'GET');
    if (init.method === 'PUT') {
      entered();
      await held;
      return { ok: true, status: 200, json: async () => ({ merged: true, sha: 'c'.repeat(40) }) };
    }
    return { ok: true, status: 200, json: async () => ({ state: 'closed', merged: true, head: { sha: REVIEWED_HEAD }, merge_commit_sha: 'c'.repeat(40) }) };
  };
  const approving = approveCardForTest(db, f);
  await putEntered;
  const { writeTask } = await import(src('store.js'));
  await writeTask(db, 'owner', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data: { note: 'another writer' } });
  release();
  assert.equal((await approving).merged, 'c'.repeat(40));
  assert.deepEqual(methods, ['PUT', 'GET']);
  assert.equal(read(db, 'c1').note, 'another writer');
  assert.equal(read(db, 'c1').evidence.merged, 'c'.repeat(40));
});

test('approve: a merge ask without a reviewed full SHA does not call GitHub', async () => {
  const { db } = await seed({ ask: { kind: 'merge', pr: PR } });
  const { writeTask } = await import(src('store.js'));
  await writeTask(db, 'cloud-worker', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data: { evidence: { reviewedHead: REVIEWED_HEAD }, gates: MERGE_REVIEW } });
  assert.equal(read(db, 'c1').ask.sha, undefined, 'an old ask does not acquire a later review');
  const f = fakeFetch({ ok: true, body: { merged: true, sha: 'b'.repeat(40) } });
  await assert.rejects(approveCardForTest(db, f), (e) => e.status === 409 && /reviewed head/i.test(e.message));
  assert.equal(f.calls.length, 0);
  assert.equal(read(db, 'c1').ask.kind, 'merge', 'the refused merge ask stays on the card');
});

test('approve: a FAIL or a PASS for another SHA cannot qualify a merge ask', async () => {
  for (const reviewer of [{ verdict: 'FAIL', sha: REVIEWED_HEAD }, { verdict: 'PASS', sha: 'b'.repeat(40) }]) {
    const { db } = await seed({ evidence: { rollback: ROLLBACK, reviewedHead: REVIEWED_HEAD }, gates: { reviewer }, ask: { kind: 'merge', pr: PR } });
    const f = fakeFetch({ ok: true, body: { merged: true, sha: 'c'.repeat(40) } });
    await assert.rejects(approveCardForTest(db, f), (e) => e.status === 409 && /PASS/.test(e.message));
    assert.equal(f.calls.length, 0);
  }
});

test('approve: failed or unverified checks cannot send a merge PUT', async () => {
  for (const checks of ['fail (1 run on head)', 'pending (1 run on head)', 'unknown']) {
    const { db } = await seed({ evidence: { rollback: ROLLBACK, reviewedHead: REVIEWED_HEAD, checks }, gates: MERGE_REVIEW, ask: { kind: 'merge', pr: PR } });
    const f = fakeFetch({ ok: true, body: { merged: true, sha: 'c'.repeat(40) } });
    await assert.rejects(approveCardForTest(db, f), (e) => e.status === 409 && /checks/i.test(e.message));
    assert.equal(f.calls.length, 0, checks);
    assert.equal(read(db, 'c1').evidence.mergeAttempt, undefined);
  }
  const { db } = await seed({ evidence: { rollback: ROLLBACK, reviewedHead: REVIEWED_HEAD, checks: '' }, gates: MERGE_REVIEW, ask: { kind: 'merge', pr: PR } });
  const f = fakeFetch({ ok: true, body: { merged: true, sha: 'c'.repeat(40) } });
  await assert.rejects(approveCardForTest(db, f), (e) => e.status === 409 && /checks/i.test(e.message));
  assert.equal(f.calls.length, 0);
});

test('approve: stale card PASS cannot merge when current GitHub checks fail', async () => {
  const { db } = await seed({ evidence: { rollback: ROLLBACK, reviewedHead: REVIEWED_HEAD }, gates: MERGE_REVIEW, ask: { kind: 'merge', pr: PR } });
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, method: init.method || 'GET' });
    if (url.includes('/actions/runs?')) return { ok: true, status: 200, json: async () => ({ workflow_runs: [{ name: 'PR checks', workflow_id: 1, head_sha: REVIEWED_HEAD, status: 'completed', conclusion: 'failure' }] }) };
    return { ok: true, status: 200, json: async () => ({ merged: true, sha: 'c'.repeat(40) }) };
  };
  const { approveCard } = await import(src('approve.js'));
  await assert.rejects(approveCard({ GITHUB_MERGE_TOKEN: 'tok' }, db, 'owner', 'c1', { decision: 'approve' }, f), (e) => e.status === 409 && /current GitHub checks/i.test(e.message));
  assert.deepEqual(calls.map((x) => x.method), ['GET']);
  assert.equal(read(db, 'c1').evidence.mergeAttempt, undefined);
});

test('approve: a GitHub check response for another head or an unreadable response never sends a PUT', async () => {
  const { approveCard } = await import(src('approve.js'));
  for (const mode of ['wrong head', 'unreadable']) {
    const { db } = await seed({ evidence: { rollback: ROLLBACK, reviewedHead: REVIEWED_HEAD }, gates: MERGE_REVIEW, ask: { kind: 'merge', pr: PR } });
    const calls = [];
    const f = async (url, init) => {
      calls.push({ url, method: init.method || 'GET' });
      if (mode === 'unreadable') throw new Error('network unavailable');
      return { ok: true, status: 200, json: async () => ({ workflow_runs: [{ name: 'PR checks', workflow_id: 1, head_sha: 'b'.repeat(40), status: 'completed', conclusion: 'success' }] }) };
    };
    await assert.rejects(approveCard({ GITHUB_MERGE_TOKEN: 'tok' }, db, 'owner', 'c1', { decision: 'approve' }, f), (e) => e.status === (mode === 'unreadable' ? 502 : 409));
    assert.deepEqual(calls.map((x) => x.method), ['GET'], mode);
    assert.equal(read(db, 'c1').evidence.mergeAttempt, undefined);
  }
});

test('approve: changed review evidence after the ask cannot repin or merge it', async () => {
  const { db } = await seed({ evidence: { rollback: ROLLBACK, reviewedHead: REVIEWED_HEAD }, gates: MERGE_REVIEW, ask: { kind: 'merge', pr: PR } });
  const { writeTask } = await import(src('store.js'));
  await writeTask(db, 'cloud-worker', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data: { evidence: { reviewedHead: 'b'.repeat(40) }, gates: { reviewer: { verdict: 'PASS', sha: 'b'.repeat(40) } } } });
  assert.equal(read(db, 'c1').ask.sha, REVIEWED_HEAD);
  const f = fakeFetch({ ok: true, body: { merged: true, sha: 'c'.repeat(40) } });
  await assert.rejects(approveCardForTest(db, f), (e) => e.status === 409);
  assert.equal(f.calls.length, 0);
});

async function approveCardForTest(db, fetchImpl) {
  const { approveCard } = await import(src('approve.js'));
  const withChecks = (url, init) => url.includes('/actions/runs?') ? greenChecks(url) : fetchImpl(url, init);
  return approveCard({ GITHUB_MERGE_TOKEN: 'tok' }, db, 'owner', 'c1', { decision: 'approve' }, withChecks);
}

test('approve: a missing merge token returns 503 and never calls GitHub', async () => {
  const { db } = await seed({ evidence: { rollback: ROLLBACK, reviewedHead: REVIEWED_HEAD }, gates: MERGE_REVIEW, ask: { kind: 'merge', pr: PR } });
  const { approveCard } = await import(src('approve.js'));
  const f = fakeFetch({ ok: true, body: { merged: true, sha: 'x' } });
  await assert.rejects(approveCard({}, db, 'owner', 'c1', { decision: 'approve' }, f), (e) => e.status === 503 && /merge token not set/.test(e.message));
  assert.equal(f.calls.length, 0);
  assert.equal(read(db, 'c1').ask.kind, 'merge', 'the merge ask stays on the card');
});

test('approve: Owner and the names that speak for him, never a worker token, and only when the card is asking', async () => {
  const { db } = await seed({ ask: { kind: 'go' } });
  const { approveCard } = await import(src('approve.js'));
  for (const who of ['cloud-worker', 'github-actions', 'runner', 'lane1', 'reader']) {
    await assert.rejects(approveCard({}, db, who, 'c1', { decision: 'approve' }), (e) => e.status === 403);
  }
  const byAgent = await seed({ kind: 'production', status: 'approval', ask: { kind: 'go', text: 'Go for production' } });
  await approveCard({}, byAgent.db, 'agent', 'c1', { decision: 'approve' });
  const c = read(byAgent.db, 'c1');
  assert.equal(c.gates.ownerGo, true);
  assert.equal(c.updatedBy, 'agent');
  assert.equal(c.history.at(-1).by, 'agent');
  assert.equal(c.history.at(-1).what, 'agent for Owner gave the go: Go for production');
  await assert.rejects(approveCard({}, db, 'owner', 'c1', { decision: 'maybe' }), (e) => e.status === 400);
  const plain = await seed();
  await assert.rejects(approveCard({}, plain.db, 'owner', 'c1', { decision: 'approve' }), (e) => e.status === 409);
});

test('approve: go records ownerGo and clears the ask', async () => {
  const { db } = await seed({ kind: 'production', status: 'approval', ask: { kind: 'go', text: 'Go for production' } });
  const { approveCard } = await import(src('approve.js'));
  await approveCard({}, db, 'owner', 'c1', { decision: 'approve' });
  const c = read(db, 'c1');
  assert.equal(c.gates.ownerGo, true);
  assert.match(c.gates.ownerGoAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(c.needsOwner, false);
  assert.equal('ask' in c, false);
  assert.equal(c.status, 'doing');
  assert.equal(c.history.at(-1).what, 'Owner gave the go: Go for production');
});

// Owner's go satisfies the pull request's owner gates.
const GATED_PR = 'https://github.com/example-org/TASK-Workspace/pull/64';
const TESTED = 'b'.repeat(40);
const GATED_GO = { kind: 'go', text: 'Go for the live zzcloud test', gates: ['live-zzcloud'], pr: GATED_PR, sha: TESTED };

function gateFetch({ head = TESTED, state = 'open', existing = [], self = 'board-bot', comment = { ok: true, status: 201 }, runs = [{ id: 9, path: '.github/workflows/pr-checks.yml', head_sha: TESTED, status: 'completed', created_at: '2026-10-26T00:20:00Z' }], runsStatus = 200, rerun = 201 } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body });
    if (url === 'https://api.github.com/user') return self ? { ok: true, status: 200, json: async () => ({ login: self }) } : { ok: false, status: 403, json: async () => ({ message: 'Forbidden' }) };
    if (/\/pulls\/64$/.test(url)) return { ok: true, status: 200, json: async () => ({ state, head: { sha: head } }) };
    if (/\/issues\/64\/comments\?/.test(url)) return { ok: true, status: 200, json: async () => existing };
    if (/\/issues\/64\/comments$/.test(url)) return { ok: comment.ok, status: comment.status, json: async () => (comment.ok ? { html_url: `${GATED_PR}#issuecomment-1` } : { message: 'Forbidden' }) };
    if (/\/actions\/runs\?/.test(url)) return { ok: runsStatus < 300, status: runsStatus, json: async () => (runsStatus < 300 ? { workflow_runs: runs } : { message: 'Resource not accessible' }) };
    if (/\/actions\/runs\/\d+\/rerun$/.test(url)) return { ok: rerun < 300, status: rerun, json: async () => ({}) };
    throw new Error(`unexpected ${url}`);
  };
  fn.calls = calls;
  return fn;
}

test('applyAskRule: a go keeps its gates, pull request and head; a bad one is refused', async () => {
  const lib = await import(src('lib.js'));
  const r = lib.applyAskRule(null, card({ ask: { ...GATED_GO, sha: TESTED.toUpperCase() } }), 'cloud-worker', 'N');
  assert.equal(r.problem, null);
  assert.deepEqual(r.card.ask.gates, ['live-zzcloud']);
  // Finding 1: the button text names what the press attests, and a deploy go never carries gates.
  assert.equal(r.card.ask.text, 'Go for the live zzcloud test (ticks gate live-zzcloud on PR #64 at bbbbbbb)');
  assert.equal(lib.applyAskRule(r.card, { ...r.card, ask: { ...GATED_GO } }, 'x', 'N2').card.ask.at, 'N', 'the same gated ask is kept, not re-raised');
  assert.match(lib.applyAskRule(null, card({ ask: { ...GATED_GO, text: '' } }), 'x', 'N').card.ask.text, /^Go for the live run \(ticks gate/);
  assert.match(lib.applyAskRule(null, card({ kind: 'production', ask: GATED_GO }), 'owner', 'N').problem, /production go never carries gates/);
  assert.equal(r.card.ask.sha, TESTED);
  assert.equal(r.card.ask.pr, GATED_PR);
  assert.match(lib.applyAskRule(null, card({ ask: { ...GATED_GO, sha: 'abc' } }), 'x', 'N').problem, /full head SHA/);
  assert.match(lib.applyAskRule(null, card({ ask: { ...GATED_GO, pr: '' } }), 'x', 'N').problem, /pull request/);
  assert.match(lib.applyAskRule(null, card({ ask: { ...GATED_GO, gates: ['bad id'] } }), 'x', 'N').problem, /gate ids/);
  const plain = lib.applyAskRule(null, card({ ask: { kind: 'go', gates: [], sha: '' } }), 'x', 'N').card.ask;
  assert.equal('gates' in plain, false);
  assert.equal('sha' in plain, false);
});

test('approve: a go with gates posts one PASS pinned to the tested head, records it and re-runs checks', async () => {
  const { db } = await seed({ status: 'approval', ask: GATED_GO });
  const { approveCard } = await import(src('approve.js'));
  const f = gateFetch();
  await approveCard({ GITHUB_MERGE_TOKEN: 't' }, db, 'agent2', 'c1', { decision: 'approve' }, f);
  const posts = f.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 2);
  const body = JSON.parse(posts[0].body).body;
  assert.match(body, /^Gate live-zzcloud: PASS\nHead: b{40}\n/);
  assert.match(body, /agent2 for Owner gave the go on FRK-3/);
  assert.match(posts[1].url, /\/actions\/runs\/9\/rerun$/);
  const c = read(db, 'c1');
  assert.equal(c.gates.ownerGo, true);
  assert.deepEqual(c.gates.owner['live-zzcloud'], { pr: GATED_PR, sha: TESTED, by: 'agent2', at: c.gates.ownerGoAt, comment: `${GATED_PR}#issuecomment-1` });
  assert.match(c.history.at(-1).what, /gave the go: Go for the live zzcloud test \(ticks gate live-zzcloud on PR #64 at bbbbbbb\); gates live-zzcloud ticked on bbbbbbb; PR checks re-run$/);
});

test('approve: a moved head, a closed pull request or a refused comment records no go and no gate', async () => {
  const { approveCard } = await import(src('approve.js'));
  for (const [opts, re] of [[{ head: 'c'.repeat(40) }, /head moved/], [{ state: 'closed' }, /not open/], [{ comment: { ok: false, status: 403 } }, /refused the gate comment/]]) {
    const { db } = await seed({ status: 'approval', ask: GATED_GO });
    await assert.rejects(approveCard({ GITHUB_MERGE_TOKEN: 't' }, db, 'owner', 'c1', { decision: 'approve' }, gateFetch(opts)), (e) => re.test(e.message));
    const c = read(db, 'c1');
    assert.equal(c.gates, undefined);
    assert.equal(c.ask.kind, 'go');
  }
  const { db } = await seed({ status: 'approval', ask: GATED_GO });
  await assert.rejects(approveCard({}, db, 'owner', 'c1', { decision: 'approve' }, gateFetch()), (e) => e.status === 503);
});

test('approve: worker never ticks a gate, and nobody writes gates.owner by hand', async () => {
  const { db, store } = await seed({ status: 'approval', ask: GATED_GO });
  const { approveCard } = await import(src('approve.js'));
  const f = gateFetch();
  await assert.rejects(approveCard({ GITHUB_MERGE_TOKEN: 't' }, db, 'worker', 'c1', { decision: 'approve' }, f), (e) => e.status === 403 && /never by worker/.test(e.message));
  assert.equal(f.calls.length, 0);
  for (const [who, why] of [['owner', /gates\.owner/], ['cloud-worker', /read only for cloud-worker/]]) {
    await assert.rejects(store.writeTask(db, who, { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data: { gates: { owner: { 'live-zzcloud': { sha: TESTED } } } } }), (e) => e.status === 403 && why.test(e.message));
  }
});

test('approve: a second go on the same head does not post again; checks still running are left alone', async () => {
  const { db } = await seed({ status: 'approval', ask: GATED_GO });
  const { approveCard } = await import(src('approve.js'));
  const running = gateFetch({ runs: [{ id: 9, path: '.github/workflows/pr-checks.yml', head_sha: TESTED, status: 'in_progress', created_at: 'T' }] });
  await approveCard({ GITHUB_MERGE_TOKEN: 't' }, db, 'owner', 'c1', { decision: 'approve' }, running);
  assert.equal(running.calls.filter((c) => c.method === 'POST').length, 1);
  assert.match(read(db, 'c1').history.at(-1).what, /PR checks still running, re-run them by hand when they end$/);
  const { writeTask } = await import(src('store.js'));
  await writeTask(db, 'cloud-worker', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data: { ask: GATED_GO } });
  const again = gateFetch();
  await approveCard({ GITHUB_MERGE_TOKEN: 't' }, db, 'owner', 'c1', { decision: 'approve' }, again);
  assert.equal(again.calls.length, 0);
  assert.match(read(db, 'c1').history.at(-1).what, /pressed go again.*; gates live-zzcloud already ticked on bbbbbbb$/);
});

test('approve: a PASS already on the pull request for this head is reused after a lost card write, never posted twice', async () => {
  const { db } = await seed({ status: 'approval', ask: GATED_GO });
  const { approveCard } = await import(src('approve.js'));
  const prior = [{ html_url: `${GATED_PR}#issuecomment-7`, user: { login: 'Board-Bot' }, body: `Gate live-zzcloud: PASS\nHead: ${TESTED}\n\nRecorded by the Board: owner gave the go.` }];
  const f = gateFetch({ existing: prior });
  await approveCard({ GITHUB_MERGE_TOKEN: 't' }, db, 'owner', 'c1', { decision: 'approve' }, f);
  assert.equal(f.calls.filter((c) => c.method === 'POST' && /comments$/.test(c.url)).length, 0);
  const c = read(db, 'c1');
  assert.equal(c.gates.owner['live-zzcloud'].comment, `${GATED_PR}#issuecomment-7`);
  // Finding 5: the reuse path still re-runs (or reports) the PR checks.
  assert.match(c.history.at(-1).what, /gates live-zzcloud found already posted on bbbbbbb; PR checks re-run$/);
  // Finding 5: the same body from another author, without the board line, or with no readable account is never reused.
  for (const opts of [{ existing: [{ ...prior[0], user: { login: 'someone-else' } }] }, { existing: [{ ...prior[0], body: `Gate live-zzcloud: PASS\nHead: ${TESTED}` }] }, { existing: prior, self: '' }]) {
    const s = await seed({ status: 'approval', ask: GATED_GO });
    const h = gateFetch(opts);
    await approveCard({ GITHUB_MERGE_TOKEN: 't' }, s.db, 'owner', 'c1', { decision: 'approve' }, h);
    assert.equal(h.calls.filter((x) => x.method === 'POST' && /comments$/.test(x.url)).length, 1);
    assert.match(read(s.db, 'c1').gates.owner['live-zzcloud'].comment, /issuecomment-1$/);
  }
  // A PASS pinned to another head is not reused.
  const other = await seed({ status: 'approval', ask: GATED_GO });
  const g = gateFetch({ existing: [{ html_url: 'x', body: `Gate live-zzcloud: PASS\nHead: ${'c'.repeat(40)}` }] });
  await approveCard({ GITHUB_MERGE_TOKEN: 't' }, other.db, 'owner', 'c1', { decision: 'approve' }, g);
  assert.equal(g.calls.filter((c) => c.method === 'POST' && /comments$/.test(c.url)).length, 1);
});

test('approve: a tick from a raced attempt is dropped when the re-read ask names another head', async () => {
  const { db } = await seed({ status: 'approval', ask: GATED_GO });
  const { approveCard } = await import(src('approve.js'));
  const store = await import(src('store.js'));
  const NEW = 'd'.repeat(40);
  let raced = false;
  const inner = gateFetch();
  const f = async (url, init = {}) => {
    // After the first post, a writer replaces the ask with a go on a new head, so the card write races.
    if (!raced && init.method === 'POST' && /comments$/.test(url)) {
      raced = true;
      const out = await inner(url, init);
      await store.writeTask(db, 'cloud-worker', { op: 'patch', id: 'c1', ifVersion: db.rows.get('c1').version, data: { ask: { ...GATED_GO, sha: NEW } } });
      return out;
    }
    if (/\/pulls\/64$/.test(url) && raced) return { ok: true, status: 200, json: async () => ({ state: 'open', head: { sha: NEW } }) };
    return inner(url, init);
  };
  await approveCard({ GITHUB_MERGE_TOKEN: 't' }, db, 'owner', 'c1', { decision: 'approve' }, f);
  const c = read(db, 'c1');
  assert.equal(c.gates.owner['live-zzcloud'].sha, NEW, 'the record names the head of the ask that was cleared');
  const bodies = inner.calls.filter((x) => x.method === 'POST' && /comments$/.test(x.url)).map((x) => JSON.parse(x.body).body);
  assert.equal(bodies.length, 2);
  assert.match(bodies[1], new RegExp(`Head: ${NEW}`));
});

test('approve: unreadable runs are named and an imported bad gate id is refused before GitHub', async () => {
  const { db } = await seed({ status: 'approval', ask: GATED_GO });
  const { approveCard } = await import(src('approve.js'));
  await approveCard({ GITHUB_MERGE_TOKEN: 't' }, db, 'owner', 'c1', { decision: 'approve' }, gateFetch({ runsStatus: 403 }));
  assert.match(read(db, 'c1').history.at(-1).what, /PR checks runs could not be read \(HTTP 403\), re-run them by hand$/);
  const refused = gateFetch({ rerun: 403 });
  const again = await seed({ status: 'approval', ask: GATED_GO });
  await approveCard({ GITHUB_MERGE_TOKEN: 't' }, again.db, 'owner', 'c1', { decision: 'approve' }, refused);
  assert.match(read(again.db, 'c1').history.at(-1).what, /re-run refused \(HTTP 403\), re-run them by hand$/);
  // Finding 4: a card imported with seedVersion skips the ask rule; the press still refuses the id.
  const store = await import(src('store.js'));
  const seeded = fakeDb();
  await store.writeTask(seeded, 'owner', { op: 'put', id: 'c9', data: card({ status: 'approval', ask: { ...GATED_GO, gates: ['x\nGate other: PASS'], to: 'owner' } }) }, { seedVersion: 3 });
  const f = gateFetch();
  await assert.rejects(approveCard({ GITHUB_MERGE_TOKEN: 't' }, seeded, 'owner', 'c9', { decision: 'approve' }, f), (e) => e.status === 409 && /cannot read/.test(e.message));
  assert.equal(f.calls.length, 0);
});

test('approve: a production card with no ask can still take the go through as: go', async () => {
  const { db } = await seed({ kind: 'production', needsOwner: true });
  const { approveCard } = await import(src('approve.js'));
  await approveCard({}, db, 'owner', 'c1', { decision: 'approve', as: 'go' });
  assert.equal(read(db, 'c1').gates.ownerGo, true);
});

test('approve: decide and answer record the note; a matching open question gets the answer', async () => {
  const q = { q: 'Which hero photo?', by: 'lane1', at: 'T0' };
  const { db } = await seed({ questions: [q], ask: { kind: 'answer', text: 'Which hero photo?' } });
  const { approveCard } = await import(src('approve.js'));
  await assert.rejects(approveCard({}, db, 'owner', 'c1', { decision: 'approve' }), (e) => e.status === 400);
  await approveCard({}, db, 'owner', 'c1', { decision: 'approve', note: 'The smokehouse one' });
  let c = read(db, 'c1');
  assert.equal(c.questions[0].answer, 'The smokehouse one');
  assert.equal(c.questions[0].answeredBy, 'owner');
  assert.equal(c.needsOwner, false);
  const d = await seed({ ask: { kind: 'decide', text: 'Use the old menu?' } });
  await approveCard({}, d.db, 'owner', 'c1', { decision: 'approve', note: 'Yes, keep it' });
  c = read(d.db, 'c1');
  assert.equal(c.history.at(-1).what, 'Owner decided: Yes, keep it');
  assert.equal('ask' in c, false);
});

test('approve: decline records the line, clears the ask, and approval cards go to waiting', async () => {
  const { db } = await seed({ status: 'approval', ask: { kind: 'merge', pr: PR, text: 'Merge pull request 11' } });
  const { approveCard } = await import(src('approve.js'));
  const f = fakeFetch({ ok: true, body: { merged: true, sha: 'x' } });
  await approveCard({ GITHUB_MERGE_TOKEN: 't' }, db, 'owner', 'c1', { decision: 'decline', note: 'wrong colors' }, f);
  const c = read(db, 'c1');
  assert.equal(f.calls.length, 0);
  assert.equal(c.status, 'waiting');
  assert.equal(c.needsOwner, false);
  assert.equal('ask' in c, false);
  assert.equal(c.history.at(-1).what, 'Owner declined: Merge pull request 11 (wrong colors)');
});

test('compactCard carries ask and the MCP tells bots to set it', async () => {
  const lib = await import(src('lib.js'));
  assert.deepEqual(lib.compactCard({ key: 'K-1', ask: { kind: 'go' } }).ask, { kind: 'go' });
  const mcp = await import(src('mcp.js'));
  assert.match(mcp.BOARD_INSTRUCTIONS, /set ask \{kind, text, pr, by\}/);
  assert.match(mcp.TOOLS.find((t) => t.name === 'update_card').description, /set ask \{kind, text, pr\}/);
});

test('the page script parses and calls the approve route', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'page', 'index.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  assert.doesNotThrow(() => new Function(m[1]));
  assert.match(html, /\/approve'/);
  assert.match(html, /class="confirm" id="confirmAsk"/);
});
