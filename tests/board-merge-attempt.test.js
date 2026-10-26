'use strict';

// Sequential pull requests on one card: a finished merge attempt for another pull
// request or head is kept in evidence.mergeAttempts and the next merge goes ahead; an attempt with no
// outcome still locks the card. In-memory D1 stand-in and a fake GitHub fetch, no network.
//   node --test tests/board-merge-attempt.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const src = (f) => pathToFileURL(path.join(__dirname, '..', 'worker', 'src', f)).href;
const PR_A = 'https://github.com/example-org/TASK-Workspace/pull/68';
const PR_B = 'https://github.com/example-org/TASK-Workspace/pull/70';
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const MERGE_A = '7'.repeat(40);
const MERGE_B = '9'.repeat(40);
const ROLLBACK = { to: 'main before the merge', how: 'revert the merge commit', cannot: 'nothing' };

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
  const db = { rows, prepare: stmt };
  db.batch = async (list) => { for (const s of list) await s.run(); return []; };
  return db;
}

const read = (db) => JSON.parse(db.rows.get('c1').data);
const ver = (db) => db.rows.get('c1').version;

// GitHub: green checks on any head, a merge PUT that succeeds, and a pull request read for reconcile.
function github({ mergeSha = MERGE_B, pulls = {} } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    if (url.includes('/actions/runs?')) {
      const sha = new URL(url).searchParams.get('head_sha');
      return { ok: true, status: 200, json: async () => ({ workflow_runs: [{ name: 'PR checks', workflow_id: 1, head_sha: sha, status: 'completed', conclusion: 'success', created_at: '2026-10-26T06:00:00Z' }] }) };
    }
    calls.push({ url, method: init.method || 'GET', sha: init.body ? JSON.parse(init.body).sha : undefined });
    if (/\/merge$/.test(url)) return { ok: true, status: 200, json: async () => ({ merged: true, sha: mergeSha }) };
    const n = url.match(/\/pulls\/(\d+)$/)[1];
    return { ok: true, status: 200, json: async () => pulls[n] };
  };
  fn.calls = calls;
  return fn;
}

// The card as TASK-63 stood: PR A merged through the board, then a new reviewed PR B with its merge ask.
async function seed(attempt, { pr = PR_B, head = HEAD_B } = {}) {
  const store = await import(src('store.js'));
  const db = fakeDb();
  await store.writeTask(db, 'owner', { op: 'put', id: 'c1', data: {
    title: 'Master', status: 'review', kind: 'human', board: 'main', key: 'TASK-63', history: [],
    evidence: { rollback: ROLLBACK, pr: PR_A, reviewedHead: HEAD_A, merged: attempt.state === 'merged' ? MERGE_A : undefined, mergeAttempt: attempt },
    gates: { reviewer: { verdict: 'PASS', sha: HEAD_A } },
  } });
  // The thread writes the merge record for PR B (the one write agents keep), then raises the ask.
  await store.writeTask(db, 'agent2', { op: 'patch', id: 'c1', ifVersion: ver(db), data: { evidence: { pr, reviewedHead: head }, gates: { reviewer: { verdict: 'PASS', sha: head } } } });
  await store.writeTask(db, 'agent2', { op: 'patch', id: 'c1', ifVersion: ver(db), data: { ask: { kind: 'merge', pr, sha: head } } });
  return { db, store };
}

const SYNC_B = { evidence: { checks: `pass (1 runs on ${HEAD_B}, synced from GitHub)` } };
const merged = (pr, sha) => ({ id: 'att-a', pr, sha, at: '2026-10-26T05:52:04Z', by: 'agent', state: 'merged', mergeSha: MERGE_A });

test('a merged attempt for another pull request no longer locks the card; Sync records the new checks', async () => {
  const { db, store } = await seed(merged(PR_A, HEAD_A));
  await store.writeTask(db, 'agent', { op: 'patch', id: 'c1', ifVersion: ver(db), data: SYNC_B }, { sync: true });
  assert.equal(read(db).evidence.checks, SYNC_B.evidence.checks);
  assert.equal(read(db).evidence.mergeAttempt.pr, PR_A, 'Sync never touches the attempt');
});

test('the next press keeps the earlier attempt in evidence.mergeAttempts and merges the new pull request', async () => {
  const { db, store } = await seed(merged(PR_A, HEAD_A));
  await store.writeTask(db, 'agent', { op: 'patch', id: 'c1', ifVersion: ver(db), data: SYNC_B }, { sync: true });
  const { approveCard } = await import(src('approve.js'));
  const gh = github();
  const out = await approveCard({ GITHUB_MERGE_TOKEN: 'tok' }, db, 'agent', 'c1', { decision: 'approve' }, gh);
  assert.equal(out.merged, MERGE_B);
  assert.deepEqual(gh.calls, [{ url: 'https://api.github.com/repos/example-org/TASK-Workspace/pulls/70/merge', method: 'PUT', sha: HEAD_B }]);
  const c = read(db);
  assert.deepEqual(c.evidence.mergeAttempts, [merged(PR_A, HEAD_A)], 'the earlier attempt is kept exactly');
  assert.equal(c.evidence.mergeAttempt.pr, PR_B);
  assert.equal(c.evidence.mergeAttempt.sha, HEAD_B);
  assert.equal(c.evidence.mergeAttempt.state, 'merged');
  assert.equal(c.evidence.mergeAttempt.mergeSha, MERGE_B);
  assert.notEqual(c.evidence.mergeAttempt.id, 'att-a');
  assert.equal(c.evidence.merged, MERGE_B);
  assert.equal(c.ask, undefined);
  const lines = c.history.map((h) => h.what);
  assert.ok(lines.some((l) => /earlier merge attempt for .*pull\/68 \(merged 7777777\) kept in evidence.mergeAttempts/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /approved: .*pull request merged 9999999/.test(l)));
});

test('the moved attempt does not skip the gates: stale checks still refuse the new merge', async () => {
  const { db } = await seed(merged(PR_A, HEAD_A));
  const { approveCard } = await import(src('approve.js'));
  const gh = github();
  await assert.rejects(approveCard({ GITHUB_MERGE_TOKEN: 'tok' }, db, 'agent', 'c1', { decision: 'approve' }, gh),
    (e) => e.status === 409 && /passing checks on its stored reviewed head/.test(e.message));
  assert.equal(gh.calls.length, 0, 'no merge was sent');
  assert.deepEqual(read(db).evidence.mergeAttempts, [merged(PR_A, HEAD_A)]);
  assert.equal(read(db).evidence.mergeAttempt, undefined);
  assert.equal(read(db).ask.pr, PR_B, 'the ask stays for a fresh press');
});

test('a rejected attempt for an earlier head of the same pull request is moved aside too', async () => {
  const rejected = { id: 'att-r', pr: PR_B, sha: HEAD_A, at: '2026-10-26T05:00:00Z', by: 'agent', state: 'rejected', githubStatus: 409, rejectedAt: '2026-10-26T05:00:01Z' };
  const { db, store } = await seed(rejected);
  await store.writeTask(db, 'agent', { op: 'patch', id: 'c1', ifVersion: ver(db), data: SYNC_B }, { sync: true });
  const { approveCard } = await import(src('approve.js'));
  const out = await approveCard({ GITHUB_MERGE_TOKEN: 'tok' }, db, 'agent', 'c1', { decision: 'approve' }, github());
  assert.equal(out.merged, MERGE_B);
  assert.deepEqual(read(db).evidence.mergeAttempts, [rejected]);
});

test('a claimed attempt with no outcome still locks the card and is never moved', async () => {
  const store = await import(src('store.js'));
  const db = fakeDb();
  await store.writeTask(db, 'owner', { op: 'put', id: 'c1', data: {
    title: 'Master', status: 'review', kind: 'human', board: 'main', key: 'TASK-63', history: [],
    evidence: { rollback: ROLLBACK, pr: PR_B, reviewedHead: HEAD_B, checks: `pass (1 runs on ${HEAD_B}, synced from GitHub)` },
    gates: { reviewer: { verdict: 'PASS', sha: HEAD_B } },
  } });
  await store.writeTask(db, 'agent2', { op: 'patch', id: 'c1', ifVersion: ver(db), data: { ask: { kind: 'merge', pr: PR_B, sha: HEAD_B } } });
  const claimed = { id: 'att-c', pr: PR_B, sha: HEAD_B, at: '2026-10-26T06:00:00Z', by: 'agent' };
  await store.writeTask(db, 'agent', { op: 'patch', id: 'c1', ifVersion: ver(db), data: { evidence: { mergeAttempt: claimed } } }, { press: true });
  await assert.rejects(store.writeTask(db, 'agent', { op: 'patch', id: 'c1', ifVersion: ver(db), data: { evidence: { checks: 'pass (1 runs on ' + HEAD_A + ', synced from GitHub)' } } }, { sync: true }),
    /active merge attempt cannot be cleared or replaced/);
  // The press reconciles it read only; GitHub has not merged it, so nothing moves and nothing is merged.
  const { approveCard } = await import(src('approve.js'));
  const gh = github({ pulls: { 70: { state: 'open', merged: false, head: { sha: HEAD_B } } } });
  await assert.rejects(approveCard({ GITHUB_MERGE_TOKEN: 'tok' }, db, 'agent', 'c1', { decision: 'approve' }, gh), /unconfirmed/);
  assert.deepEqual(gh.calls.map((c) => c.method), ['GET']);
  assert.deepEqual(read(db).evidence.mergeAttempt, claimed);
  assert.equal(read(db).evidence.mergeAttempts, undefined);
});

test('a merged attempt for this same pull request and head is reconciled, not moved', async () => {
  const { db } = await seed(merged(PR_B, HEAD_B));
  const { approveCard } = await import(src('approve.js'));
  const gh = github({ pulls: { 70: { state: 'closed', merged: true, head: { sha: HEAD_B }, merge_commit_sha: MERGE_A } } });
  const out = await approveCard({ GITHUB_MERGE_TOKEN: 'tok' }, db, 'agent', 'c1', { decision: 'approve' }, gh);
  assert.equal(out.merged, MERGE_A);
  assert.deepEqual(gh.calls.map((c) => c.method), ['GET'], 'no second merge is sent');
  assert.equal(read(db).evidence.mergeAttempts, undefined);
  assert.equal(read(db).evidence.mergeAttempt.id, 'att-a');
});

test('Agent cannot rewrite the kept attempts', async () => {
  const { db, store } = await seed(merged(PR_A, HEAD_A));
  await assert.rejects(store.writeTask(db, 'agent', { op: 'patch', id: 'c1', ifVersion: ver(db), data: { evidence: { mergeAttempts: [] } } }), /evidence\.mergeAttempts/);
  await assert.rejects(store.writeTask(db, 'agent2', { op: 'patch', id: 'c1', ifVersion: ver(db), data: { evidence: { mergeAttempts: [] } } }), /read only for agent2/);
});

test('Agent cannot drop the kept attempts with evidence null, an evidence delete or a put without them', async () => {
  const { db, store } = await seed(merged(PR_A, HEAD_A));
  await store.writeTask(db, 'agent', { op: 'patch', id: 'c1', ifVersion: ver(db), data: SYNC_B }, { sync: true });
  const { approveCard } = await import(src('approve.js'));
  await approveCard({ GITHUB_MERGE_TOKEN: 'tok' }, db, 'agent', 'c1', { decision: 'approve' }, github());
  const kept = read(db).evidence.mergeAttempts;
  assert.equal(kept.length, 1);
  await assert.rejects(store.writeTask(db, 'agent', { op: 'patch', id: 'c1', ifVersion: ver(db), data: { evidence: null } }), /evidence\.(mergeAttempt|reviewedHead)/);
  await assert.rejects(store.writeTask(db, 'agent', { op: 'patch', id: 'c1', ifVersion: ver(db), data: { evidence: { __delete__: true } } }), /evidence\.(mergeAttempt|reviewedHead)/);
  const { mergeAttempts, mergeAttempt, ...rest } = read(db).evidence;
  await assert.rejects(store.writeTask(db, 'agent', { op: 'put', id: 'c1', ifVersion: ver(db), data: { ...read(db), evidence: { ...rest, mergeAttempt } } }), /evidence\.mergeAttempts/);
  assert.deepEqual(read(db).evidence.mergeAttempts, kept);
  // Her ordinary record writes still pass.
  await store.writeTask(db, 'agent', { op: 'patch', id: 'c1', ifVersion: ver(db), data: { note: 'PR 70 merged', evidence: { syncAudit: 'checked' } } });
  assert.equal(read(db).note, 'PR 70 merged');
});

test('every earlier attempt is kept, with no cap', async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ id: `old-${i}`, pr: `https://github.com/example-org/TASK-Workspace/pull/${i + 1}`, sha: String(i % 10).repeat(40), state: 'merged', mergeSha: MERGE_A }));
  const { db, store } = await seed(merged(PR_A, HEAD_A));
  await store.writeTask(db, 'owner', { op: 'patch', id: 'c1', ifVersion: ver(db), data: { evidence: { mergeAttempts: many } } });
  await store.writeTask(db, 'agent', { op: 'patch', id: 'c1', ifVersion: ver(db), data: SYNC_B }, { sync: true });
  const { approveCard } = await import(src('approve.js'));
  await approveCard({ GITHUB_MERGE_TOKEN: 'tok' }, db, 'agent', 'c1', { decision: 'approve' }, github());
  assert.deepEqual(read(db).evidence.mergeAttempts, [...many, merged(PR_A, HEAD_A)]);
});

// An attempt with no outcome (TASK-63, 06:44Z: PR 70's PUT got HTTP 405 for a conflict and the
// press left the attempt unconfirmed). GitHub fake: green checks, a merge PUT answering put(), and pulls.
const HEAD_C = 'c'.repeat(40);
function github405({ pulls = {}, put = () => ({ ok: false, status: 405, body: { message: 'Pull Request is not mergeable' } }) } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    if (url.includes('/actions/runs?')) {
      const sha = new URL(url).searchParams.get('head_sha');
      return { ok: true, status: 200, json: async () => ({ workflow_runs: [{ name: 'PR checks', workflow_id: 1, head_sha: sha, status: 'completed', conclusion: 'success', created_at: '2026-10-26T06:00:00Z' }] }) };
    }
    calls.push({ url, method: init.method || 'GET', sha: init.body ? JSON.parse(init.body).sha : undefined });
    if (/\/merge$/.test(url)) { const r = put(); return { ok: r.ok, status: r.status, json: async () => r.body }; }
    return { ok: true, status: 200, json: async () => pulls[url.match(/\/pulls\/(\d+)$/)[1]] };
  };
  fn.calls = calls;
  return fn;
}
const stuck = { id: 'att-b', pr: PR_B, sha: HEAD_B, at: '2026-10-26T06:44:02Z', by: 'agent' };
const openOn = (sha) => ({ state: 'open', merged: false, head: { sha }, merge_commit_sha: null });

test('a stuck attempt whose pull request moved to a new head is rejected, then the new head merges', async () => {
  const { db, store } = await seed(stuck);
  const { approveCard } = await import(src('approve.js'));
  const gh = github405({ pulls: { 70: openOn(HEAD_C) }, put: () => ({ ok: true, status: 200, body: { merged: true, sha: MERGE_B } }) });
  await assert.rejects(approveCard({ GITHUB_MERGE_TOKEN: 'tok' }, db, 'agent', 'c1', { decision: 'approve' }, gh),
    (e) => e.status === 409 && /head moved to c{40}/.test(e.message));
  assert.deepEqual(gh.calls.map((c) => c.method), ['GET'], 'no merge was sent');
  const r = read(db).evidence.mergeAttempt;
  assert.equal(r.state, 'rejected');
  assert.match(r.reason, /head moved to c{40}/);
  assert.deepEqual(Object.fromEntries(Object.entries(r).filter(([k]) => !['state', 'reason', 'rejectedAt'].includes(k))), stuck);
  assert.ok(read(db).history.some((h) => /merge attempt for bbbbbbb rejected: .*head ccccccc/.test(h.what)));
  // The card is free again: the record and a fresh ask for the new head, Sync, then the press merges it.
  await store.writeTask(db, 'agent2', { op: 'patch', id: 'c1', ifVersion: ver(db), data: { evidence: { reviewedHead: HEAD_C }, gates: { reviewer: { verdict: 'PASS', sha: HEAD_C } } } });
  // A same ask keeps its pinned head, so the old ask is cleared and raised again to pin the new head.
  await store.writeTask(db, 'agent2', { op: 'patch', id: 'c1', ifVersion: ver(db), data: { ask: null } });
  await store.writeTask(db, 'agent2', { op: 'patch', id: 'c1', ifVersion: ver(db), data: { ask: { kind: 'merge', pr: PR_B } } });
  assert.equal(read(db).ask.sha, HEAD_C);
  await store.writeTask(db, 'agent', { op: 'patch', id: 'c1', ifVersion: ver(db), data: { evidence: { checks: `pass (1 runs on ${HEAD_C}, synced from GitHub)` } } }, { sync: true });
  const out = await approveCard({ GITHUB_MERGE_TOKEN: 'tok' }, db, 'agent', 'c1', { decision: 'approve' }, gh);
  assert.equal(out.merged, MERGE_B);
  assert.equal(gh.calls[1].method, 'PUT');
  assert.equal(gh.calls[1].sha, HEAD_C);
  const c = read(db);
  assert.equal(c.evidence.mergeAttempts.length, 1);
  assert.equal(c.evidence.mergeAttempts[0].id, 'att-b');
  assert.equal(c.evidence.mergeAttempts[0].state, 'rejected');
  assert.equal(c.evidence.mergeAttempt.sha, HEAD_C);
  assert.equal(c.evidence.mergeAttempt.state, 'merged');
});

test('a stuck attempt whose pull request is still open on the same head stays unconfirmed and locked', async () => {
  const { db, store } = await seed(stuck);
  const { approveCard } = await import(src('approve.js'));
  const gh = github405({ pulls: { 70: openOn(HEAD_B) } });
  await assert.rejects(approveCard({ GITHUB_MERGE_TOKEN: 'tok' }, db, 'agent', 'c1', { decision: 'approve' }, gh),
    (e) => e.status === 409 && /unconfirmed/.test(e.message));
  assert.deepEqual(gh.calls.map((c) => c.method), ['GET']);
  assert.deepEqual(read(db).evidence.mergeAttempt, stuck);
  for (const data of [{ ask: null }, { evidence: { reviewedHead: HEAD_C } }]) {
    await assert.rejects(store.writeTask(db, 'agent2', { op: 'patch', id: 'c1', ifVersion: ver(db), data }),
      /active merge attempt cannot be cleared or replaced/);
  }
});

test('a stuck attempt on a closed unmerged or merged-elsewhere pull request stays unconfirmed', async () => {
  for (const pull of [{ state: 'closed', merged: false, head: { sha: HEAD_C }, merge_commit_sha: null },
    { state: 'closed', merged: true, head: { sha: HEAD_C }, merge_commit_sha: MERGE_B }]) {
    const { db } = await seed(stuck);
    const { approveCard } = await import(src('approve.js'));
    await assert.rejects(approveCard({ GITHUB_MERGE_TOKEN: 'tok' }, db, 'agent', 'c1', { decision: 'approve' }, github405({ pulls: { 70: pull } })),
      (e) => e.status === 409 && /unconfirmed/.test(e.message));
    assert.deepEqual(read(db).evidence.mergeAttempt, stuck);
  }
});

test('HTTP 405 with the pull request open on the attempted head records a rejection and never PUTs again', async () => {
  const { db, store } = await seed(merged(PR_A, HEAD_A));
  await store.writeTask(db, 'agent', { op: 'patch', id: 'c1', ifVersion: ver(db), data: SYNC_B }, { sync: true });
  const { approveCard } = await import(src('approve.js'));
  const gh = github405({ pulls: { 70: openOn(HEAD_B) } });
  await assert.rejects(approveCard({ GITHUB_MERGE_TOKEN: 'tok' }, db, 'agent', 'c1', { decision: 'approve' }, gh),
    (e) => e.status === 409 && /GitHub refused the merge: Pull Request is not mergeable; the attempt is recorded as rejected/.test(e.message));
  const a = read(db).evidence.mergeAttempt;
  assert.equal(a.state, 'rejected');
  assert.equal(a.githubStatus, 405);
  assert.equal(a.sha, HEAD_B);
  assert.deepEqual(read(db).evidence.mergeAttempts, [merged(PR_A, HEAD_A)]);
  assert.equal(read(db).ask.sha, HEAD_B, 'the ask stays for review');
  await assert.rejects(approveCard({ GITHUB_MERGE_TOKEN: 'tok' }, db, 'agent', 'c1', { decision: 'approve' }, gh),
    (e) => e.status === 409 && /unconfirmed/.test(e.message));
  assert.deepEqual(gh.calls.map((c) => c.method), ['PUT', 'GET', 'GET'], 'one PUT only');
});

test('nobody but the press can write a reason rejection onto a stuck attempt', async () => {
  const { db, store } = await seed(stuck);
  for (const who of ['agent', 'agent2']) {
    await assert.rejects(store.writeTask(db, who, { op: 'patch', id: 'c1', ifVersion: ver(db), data: { evidence: { mergeAttempt: { state: 'rejected', reason: 'x', rejectedAt: '2026-10-26T07:00:00Z' } } } }));
  }
  assert.deepEqual(read(db).evidence.mergeAttempt, stuck);
});
