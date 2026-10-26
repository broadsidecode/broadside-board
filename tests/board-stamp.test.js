'use strict';

// Server stamp tests: createdBy and touchedBy. In-memory D1 stand-in, no network.
//   node --test tests/board-stamp.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const src = (f) => pathToFileURL(path.join(__dirname, '..', 'worker', 'src', f)).href;

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
          rows.set(id, { ...r, data: args[5], version: r.version + 1, updated_at: args[args.length - 2] });
        }
        return {};
      },
    };
    return api;
  };
  return { rows, prepare: stmt, batch: async (list) => { for (const s of list) await s.run(); return []; } };
}

const card = (extra = {}) => ({ title: 'T', status: 'todo', kind: 'agent', ...extra });
const read = (db, id) => JSON.parse(db.rows.get(id).data);

test('stampCard: create sets createdBy and touchedBy from the principal', async () => {
  const lib = await import(src('lib.js'));
  const out = lib.stampCard(null, card(), 'agent');
  assert.equal(out.createdBy, 'agent');
  assert.deepEqual(out.touchedBy, ['agent']);
  const kept = lib.stampCard(null, card({ createdBy: 'agent2' }), 'worker');
  assert.equal(kept.createdBy, 'agent2');
  assert.deepEqual(kept.touchedBy, ['agent2', 'worker']);
});

test('store: put create, then patches keep createdBy and grow touchedBy in first touch order', async () => {
  const store = await import(src('store.js'));
  const db = fakeDb();
  await store.writeTask(db, 'owner', { op: 'put', id: 'a', data: card() });
  assert.equal(read(db, 'a').createdBy, 'owner');
  // The board is read only for everyone but Owner; an ask is the write the others keep.
  await store.writeTask(db, 'worker', { op: 'patch', id: 'a', ifVersion: 1, data: { ask: { kind: 'decide', text: 'x' } } });
  await store.writeTask(db, 'owner', { op: 'patch', id: 'a', ifVersion: 2, data: { note: 'y' } });
  await store.writeTask(db, 'agent3', { op: 'patch', id: 'a', ifVersion: 3, data: { ask: null } });
  const c = read(db, 'a');
  assert.deepEqual(c.touchedBy, ['owner', 'worker', 'agent3']);
  assert.equal(c.createdBy, 'owner');
});

test('store: a patch or put cannot change createdBy or replace touchedBy', async () => {
  const store = await import(src('store.js'));
  const db = fakeDb();
  await store.writeTask(db, 'owner', { op: 'put', id: 'a', data: card() });
  await store.writeTask(db, 'agent3', { op: 'patch', id: 'a', ifVersion: 1, data: { ask: { kind: 'decide', text: 'x' } } });
  await assert.rejects(store.writeTask(db, 'agent3', { op: 'patch', id: 'a', ifVersion: 2, data: { createdBy: 'agent', touchedBy: ['agent'] } }), (e) => e.status === 403 && /read only for agent3/.test(e.message));
  await store.writeTask(db, 'owner', { op: 'patch', id: 'a', ifVersion: 2, data: { createdBy: 'agent', touchedBy: ['agent'] } });
  let c = read(db, 'a');
  assert.equal(c.createdBy, 'owner');
  assert.deepEqual(c.touchedBy, ['owner', 'agent3']);
  await store.writeTask(db, 'owner', { op: 'put', id: 'a', ifVersion: 3, data: card({ createdBy: 'agent', touchedBy: [] }) });
  c = read(db, 'a');
  assert.equal(c.createdBy, 'owner');
  assert.deepEqual(c.touchedBy, ['owner', 'agent3']);
});

test('store: batch creates and patches are stamped too, and compactCard exposes both fields', async () => {
  const store = await import(src('store.js'));
  const lib = await import(src('lib.js'));
  const db = fakeDb();
  await assert.rejects(store.writeBatch(db, 'lane1', [{ op: 'put', id: 'b', data: card() }], false), (e) => e.status === 403 && /read only for lane1/.test(e.message));
  await store.writeBatch(db, 'owner', [{ op: 'put', id: 'b', data: card() }], true);
  assert.equal(read(db, 'b').createdBy, 'owner');
  await store.writeBatch(db, 'worker', [{ op: 'patch', id: 'b', ifVersion: 1, data: { ask: { kind: 'decide', text: 'n' } } }], true);
  const c = read(db, 'b');
  assert.deepEqual(c.touchedBy, ['owner', 'worker']);
  const compact = lib.compactCard(c);
  assert.equal(compact.createdBy, 'owner');
  assert.deepEqual(compact.touchedBy, ['owner', 'worker']);
  assert.match(lib.mcpPatchProblem({}, { createdBy: 'x' }), /createdBy/);
});
