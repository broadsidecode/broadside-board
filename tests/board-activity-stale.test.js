'use strict';

// The activity feed (store listActivity, MCP tool activity) and the stale rule (lib, whats_waiting,
// snapshot). Fake D1, no network.
//   node --test tests/board-activity-stale.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const src = (f) => pathToFileURL(path.join(__dirname, '..', 'worker', 'src', f)).href;
const NOW = new Date('2026-10-23T12:00:00.000Z');

const row = (id, data, version = 1) => ({ id, version, updated_at: NOW.toISOString(), data: JSON.stringify(data) });
const quiet = { board: 'main', key: 'TASK-6', num: 6, title: 'Nightly backup', status: 'doing', kind: 'agent', lane: 'worker', updated: '2026-10-22T20:00:00.000Z', history: [{ at: '2026-10-22T20:30:00.000Z', by: 'worker', what: 'started' }] };
// Touched an hour ago on the real clock, so whats_waiting (which reads the real clock) never sees it as stale.
const fresh = { board: 'main', key: 'TASK-7', num: 7, title: 'Skill mirrors', status: 'doing', kind: 'agent', lane: 'worker', updated: new Date(Date.now() - 3600000).toISOString(), history: [] };
const todo = { board: 'main', key: 'TASK-8', num: 8, title: 'Old todo', status: 'todo', kind: 'agent', updated: '2026-10-01T00:00:00.000Z', history: [] };
const tasks = [row('c6', quiet), row('c7', fresh), row('c8', todo)];
const logRows = [
  { at: '2026-10-23T11:50:00.000Z', who: 'agent', task_id: 'c6', what: 'agent for Owner approved: Merge pull request 13', data: tasks[0].data },
  { at: '2026-10-23T11:40:00.000Z', who: 'cloud-worker', task_id: 'c7', what: 'mcp update_card: status', data: tasks[1].data },
  { at: '2026-10-23T11:30:00.000Z', who: 'agent3', task_id: 'gone', what: 'deleted by agent3 for Owner via mcp', data: null },
];

function fakeDb() {
  return {
    prepare(sql) {
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async all() {
          if (/FROM board_history_log l LEFT JOIN board_tasks/.test(sql)) {
            const since = args[0]; const limit = args[2];
            return { results: logRows.filter((r) => !since || r.at > since).slice(0, limit) };
          }
          if (/FROM board_boards/.test(sql)) return { results: [row('main', { name: 'Main', prefix: 'KIT', order: 0 })] };
          if (/FROM board_tasks/.test(sql)) return { results: tasks };
          if (/FROM board_counters/.test(sql)) return { results: [] };
          return { results: [] };
        },
        async first() { return null; },
      };
      return api;
    },
  };
}

test('lib: a doing card with nothing written for 6 hours is stale; fresh and todo cards are not', async () => {
  const lib = await import(src('lib.js'));
  assert.equal(lib.STALE_HOURS, 6);
  assert.equal(lib.staleHours(quiet, NOW), 15);
  assert.equal(lib.staleHours(fresh, NOW), 0);
  assert.equal(lib.staleHours(todo, NOW), 0);
  assert.equal(lib.isStale(quiet, NOW), true);
  assert.match(lib.waitingLine({ ...quiet }), /TASK-6 \[doing\] Nightly backup/);
});

test('store: listActivity joins the card key, keeps deleted cards, honours since and board', async () => {
  const store = await import(src('store.js'));
  const all = await store.listActivity(fakeDb(), { limit: 10 });
  assert.equal(all.length, 3);
  assert.deepEqual([all[0].who, all[0].key, all[0].board], ['agent', 'TASK-6', 'main']);
  assert.deepEqual([all[2].who, all[2].key, all[2].taskId], ['agent3', '', 'gone']);
  const since = await store.listActivity(fakeDb(), { since: '2026-10-23T11:45:00.000Z' });
  assert.equal(since.length, 1);
  const onMain = await store.listActivity(fakeDb(), { board: 'main' });
  assert.equal(onMain.length, 2, 'the deleted card has no board and drops out of a board filter');
});

test('mcp: activity is a tool with plain lines, and whats_waiting lists stale cards', async () => {
  const mcp = await import(src('mcp.js'));
  assert.ok(mcp.TOOLS.some((t) => t.name === 'activity'));
  assert.match(mcp.BOARD_INSTRUCTIONS, /call activity with since/);
  const env = { DB: fakeDb(), HANDBOOK: 'x' };
  const call = async (name, args) => {
    const r = await mcp.handleRpc(env, 'agent2', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    return r.json.result.content[0].text;
  };
  const feed = await call('activity', { limit: 10 });
  assert.match(feed, /^2026-10-23T11:50:00.000Z agent TASK-6: agent for Owner approved/m);
  assert.match(feed, /agent3 \(no card\): deleted by agent3/);
  assert.match(await call('activity', { since: '2026-10-23T11:55:00.000Z' }), /Nothing changed since/);
  const waiting = await call('whats_waiting', {});
  assert.match(waiting, /TASK-6 \[doing\] Nightly backup \[stale: in progress with nothing written for \d+ h\]/);
  assert.doesNotMatch(waiting, /TASK-7/);
});

test('snapshot: a STALE section and the recent activity', async () => {
  const snap = await import(src('snapshot.js'));
  const text = await snap.buildSnapshot({ DB: fakeDb() }, 'agent2', { github: false, now: NOW });
  assert.match(text, /^stale \(in progress, nothing written for 6 h or more\): 1$/m);
  assert.match(text, /== STALE ==\nstale TASK-6 \(main\): Nightly backup; in progress, nothing written for 15 h; lane worker/);
  assert.match(text, /== RECENT ACTIVITY \(latest 3;/);
  assert.match(text, /agent TASK-6: agent for Owner approved: Merge pull request 13/);
});
