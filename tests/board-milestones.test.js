'use strict';

// Projects, milestones and the portfolio (): derived status and percent, who may write what, the
// template on a new customer tab, GET /portfolio, project_status and the page. Real SQLite behind a small D1 stand-in
// and the real schema; the page runs in a small DOM, no browser and no network.
//   node --test tests/board-milestones.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { /* older Node: the database tests below skip */ }
const skip = !sqlite && 'node:sqlite missing';
const src = (f) => pathToFileURL(path.join(__dirname, '..', 'worker', 'src', f)).href;
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'worker', 'schema.sql'), 'utf8');

function d1() {
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const exec = (sql, args) => {
    const st = db.prepare(sql);
    const reads = /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
    return reads ? { results: st.all(...args) } : { results: [], meta: { changes: Number(st.run(...args).changes) } };
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

const TODAY = '2026-11-01';
const MS = [
  { id: 'intake', name: 'Intake', start: '2026-10-01', end: '2026-10-10' },
  { id: 'build', name: 'Build', start: '2026-10-11', end: '2026-10-25' },
  { id: 'preview-approved', name: 'Preview approved', start: '2026-10-26', end: '2099-12-31' },
  { id: 'live', name: 'Live', start: '', end: '' },
];
const ROLLBACK = { to: 'the last release', how: 'redeploy it', cannot: 'nothing' };
const card = (n, status, milestone, over = {}) => ({ board: 'core', key: `COR-${n}`, title: `Card ${n}`, status, kind: 'human', ...(milestone ? { milestone } : {}), evidence: { rollback: ROLLBACK }, history: [], ...over });

// ------------------------------------------------------------------------------------------ derived numbers
test('milestone status is derived: not started, in progress, done and late', async () => {
  const P = await import(src('projects.js'));
  const board = { name: 'Acme Plumbing', target: '2026-11-03', milestones: MS };
  const cards = [
    card(1, 'done', 'intake'), card(2, 'done', 'intake'),            // intake: every card done
    card(3, 'doing', 'build'), card(4, 'blocked', 'build'), card(5, 'review', 'build'), // build: end passed, cards open
    card(6, 'todo', 'preview-approved'),                              // not started: nothing past todo
    card(7, 'done'),                                                  // no milestone
  ];
  const s = P.projectStats(board, cards, TODAY);
  const by = Object.fromEntries(s.milestones.map((m) => [m.id, m]));
  assert.equal(by.intake.status, 'done');
  assert.equal(by.build.status, 'late', 'end date passed with open cards');
  assert.equal(by['preview-approved'].status, 'notstarted');
  assert.equal(by.live.status, 'notstarted', 'a milestone with no cards is not started');
  assert.deepEqual([by.build.done, by.build.total, by.build.blocked], [0, 3, 1]);
  // In progress: a card past todo and the end date not yet passed.
  const mid = P.projectStats(board, [card(1, 'doing', 'preview-approved'), card(2, 'done', 'preview-approved')], TODAY);
  assert.equal(mid.milestones.find((m) => m.id === 'preview-approved').status, 'inprogress');
  // The end day itself is not late; the day after is.
  const edge = { milestones: [{ id: 'a', name: 'A', end: '2026-11-01' }] };
  assert.equal(P.projectStats(edge, [{ status: 'doing', milestone: 'a' }], '2026-11-01').milestones[0].status, 'inprogress');
  assert.equal(P.projectStats(edge, [{ status: 'doing', milestone: 'a' }], '2026-11-02').milestones[0].status, 'late');
  // Done wins over late: every card done after the end date is still done.
  assert.equal(P.projectStats(edge, [{ status: 'done', milestone: 'a' }], '2026-12-01').milestones[0].status, 'done');
});

test('project percent is cards done over cards on the tab, deleted cards excluded', async () => {
  const P = await import(src('projects.js'));
  const board = { name: 'X', target: '2026-10-01', milestones: MS };
  const cards = [card(1, 'done', 'intake'), card(2, 'done'), card(3, 'doing', 'build'), card(4, 'todo'), card(5, 'done', 'build', { deleted: true })];
  const s = P.projectStats(board, cards, TODAY);
  assert.equal(s.total, 4);
  assert.equal(s.done, 2);
  assert.equal(s.percent, 50);
  assert.equal(s.noMilestone, 2);
  assert.equal(s.late, true, 'target passed with open cards');
  assert.equal(P.projectStats(board, [], TODAY).percent, 0);
  assert.equal(P.projectStats(board, [card(1, 'done')], TODAY).late, false, 'nothing open, so not late');
  assert.equal(s.next.id, 'build', 'intake is done, so the next milestone is the first one that is not');
});

test('the project line says it in words', async () => {
  const P = await import(src('projects.js'));
  const board = { name: 'Acme Plumbing', kind: 'website', target: '2026-11-03', milestones: MS.map((m) => ({ ...m, end: m.id === 'build' ? '2026-11-30' : m.end })) };
  const cards = [];
  for (let i = 1; i <= 2; i++) cards.push(card(i, 'done', 'intake'));
  for (let i = 3; i <= 10; i++) cards.push(card(i, 'done', 'build'));
  cards.push(card(11, 'blocked', 'build'), card(12, 'doing', 'build'), card(13, 'todo', 'preview-approved'));
  for (let i = 14; i <= 16; i++) cards.push(card(i, 'todo'));
  const line = P.projectLine('Acme Plumbing', board, cards, TODAY);
  assert.equal(line, 'Acme Plumbing: 63 percent, Build 8 of 10 (1 blocked), Preview approved not started, target Nov 3, 3 cards with no milestone');
  const plain = P.projectLine('Plain', { name: 'Plain' }, [card(1, 'done'), card(2, 'todo')], TODAY);
  assert.equal(plain, 'Plain: 50 percent, 1 of 2 cards done');
  assert.match(P.projectLine('Late', { target: '2026-10-01', milestones: [] }, [card(1, 'todo')], TODAY), /target Oct 1 \(late\)$/);
  assert.match(P.projectLine('Done', { milestones: [{ id: 'a', name: 'A' }] }, [{ status: 'done', milestone: 'a' }], TODAY), /every milestone done/);
  const lines = P.milestoneLines(board, cards, TODAY);
  assert.equal(lines.length, 4);
  assert.match(lines[1], /^  Build: in progress, 8 of 10 cards done, 1 blocked, Oct 11 to Nov 30$/);
});

test('the website template', async () => {
  const P = await import(src('projects.js'));
  const tpl = P.templateFor('website');
  assert.deepEqual(tpl.map((m) => m.id), ['intake', 'design-chosen', 'content-in', 'build', 'preview-approved', 'live', 'handoff']);
  assert.deepEqual(tpl.map((m) => m.name), ['Intake', 'Design chosen', 'Content in', 'Build', 'Preview approved', 'Live', 'Handoff']);
  assert.ok(tpl.every((m) => m.start === '' && m.end === ''));
  assert.deepEqual(P.templateFor('product'), []);
  assert.deepEqual(P.templateFor('internal'), []);
  assert.equal(P.projectProblem({ name: 'x', kind: 'website', start: '2026-11-01', target: '', milestones: tpl }), null);
});

test('board project fields are validated', async () => {
  const P = await import(src('projects.js'));
  const bad = (over) => P.projectProblem({ name: 'x', ...over });
  assert.match(bad({ kind: 'blog' }), /kind must be one of/);
  assert.match(bad({ start: '11/01/2026' }), /start must be a date/);
  assert.match(bad({ target: '2026-02-31' }), /target must be a date/);
  assert.match(bad({ milestones: 'build' }), /must be a list/);
  assert.match(bad({ milestones: [{ id: 'Bad Id', name: 'x' }] }), /milestone id is lowercase/);
  assert.match(bad({ milestones: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] }), /appears twice/);
  assert.match(bad({ milestones: [{ id: 'a', name: '' }] }), /needs a name/);
  assert.match(bad({ milestones: [{ id: 'a', name: 'A', start: '2026-11-05', end: '2026-11-01' }] }), /ends before it starts/);
  assert.equal(bad({}), null, 'the fields are optional');
});

// ------------------------------------------------------------------------------------------ guard rules
async function world() {
  const store = await import(src('store.js'));
  const lib = await import(src('lib.js'));
  const db = d1();
  db.raw.prepare('INSERT INTO board_boards (id, data, version, updated_at) VALUES (?, ?, 1, ?)').run('core', JSON.stringify({ name: 'Acme Plumbing', prefix: 'COR', order: 1, kind: 'website', start: '2026-10-01', target: '2026-11-03', milestones: MS }), 'x');
  db.raw.prepare('INSERT INTO board_boards (id, data, version, updated_at) VALUES (?, ?, 1, ?)').run('other', JSON.stringify({ name: 'Other', prefix: 'OTH', order: 2 }), 'x');
  const put = (id, data, who = 'owner') => store.writeTask(db, who, { op: 'put', id, data });
  await put('c1', card(1, 'todo'));
  const ver = (id) => db.raw.prepare('SELECT version FROM board_tasks WHERE id = ?').get(id).version;
  const got = (id) => JSON.parse(db.raw.prepare('SELECT data FROM board_tasks WHERE id = ?').get(id).data);
  const board = () => ({ version: db.raw.prepare("SELECT version FROM board_boards WHERE id = 'core'").get().version, data: JSON.parse(db.raw.prepare("SELECT data FROM board_boards WHERE id = 'core'").get().data) });
  const patch = (who, data, opts = {}) => store.writeTask(db, who, { op: 'patch', id: 'c1', ifVersion: ver('c1'), data }, opts);
  return { store, lib, db, put, ver, got, board, patch };
}
const status = async (p) => { try { await p; return 200; } catch (e) { return e.status || 500; } };

test('a card names a milestone of its own tab; an unknown one is refused with a clear message', { skip }, async () => {
  const w = await world();
  await w.patch('owner', { milestone: 'build' });
  assert.equal(w.got('c1').milestone, 'build');
  await assert.rejects(w.patch('owner', { milestone: 'launch' }), (e) => e.status === 400 && /milestone launch is not a milestone of board core; its milestones are intake, build, preview-approved, live/.test(e.message));
  assert.equal(w.got('c1').milestone, 'build', 'a refused write changes nothing');
  await w.put('c2', { ...card(2, 'todo'), board: 'other', key: 'OTH-1' });
  await assert.rejects(w.store.writeTask(w.db, 'owner', { op: 'patch', id: 'c2', ifVersion: w.ver('c2'), data: { milestone: 'build' } }), (e) => e.status === 400 && /board other, which has none yet/.test(e.message));
  await assert.rejects(w.patch('owner', { milestone: 7 }), (e) => e.status === 400);
  // A card moved to another tab keeps no milestone that tab lacks.
  await assert.rejects(w.patch('owner', { board: 'other' }), (e) => e.status === 400 && /not a milestone of board other/.test(e.message));
  await w.patch('owner', { board: 'other', milestone: { __delete__: true } });
  assert.equal(w.got('c1').board, 'other');
  await w.patch('owner', { board: 'core', milestone: 'build' });
  // Clearing: a delete marker removes the field.
  await w.patch('owner', { milestone: { __delete__: true } });
  assert.equal(w.got('c1').milestone, undefined);
});

test('who may set a card milestone: owner, agent and worker; anyone else is refused; the sync path may', { skip }, async () => {
  const w = await world();
  await w.patch('agent', { milestone: 'intake' });
  assert.equal(w.got('c1').milestone, 'intake');
  await assert.rejects(w.patch('agent', { milestone: 'nope' }), (e) => e.status === 400);
  await w.patch('worker', { milestone: 'build' });
  assert.equal(w.got('c1').milestone, 'build', 'worker may set it');
  await assert.rejects(w.patch('worker', { milestone: 'nope' }), (e) => e.status === 400);
  await assert.rejects(w.patch('worker', { note: 'x' }), (e) => e.status === 403, 'but no other record field');
  await w.patch('agent', { milestone: 'intake' });
  for (const who of ['agent2', 'agent3', 'lane1', 'cloud-worker', 'github-actions', 'runner']) {
    await assert.rejects(w.patch(who, { milestone: 'build' }), (e) => e.status === 403 && /read only/.test(e.message), who);
  }
  assert.equal(w.got('c1').milestone, 'intake');
  // A new card from a name that may only carry an approval request cannot carry a milestone either.
  await assert.rejects(w.store.writeTask(w.db, 'worker', { op: 'put', id: 'c9', data: { ...card(9, 'todo', 'build'), ask: { kind: 'decide', text: 'Which?' } } }, { approvalCard: true }), (e) => e.status === 403);
  // The sync path (the GitHub mirror and the cron) is the one other writer, and it still checks the tab.
  await w.patch('cron', { milestone: 'build' }, { sync: true });
  assert.equal(w.got('c1').milestone, 'build');
  await assert.rejects(w.patch('cron', { milestone: 'zzz' }, { sync: true }), (e) => e.status === 400);
});

test('project fields on a tab: owner writes them, worker only them, nobody else', { skip }, async () => {
  const w = await world();
  const next = (over) => ({ ...w.board().data, ...over });
  const put = (who, data) => w.store.putBoard(w.db, who, 'core', { data, ifVersion: w.board().version }, who === 'owner' || who === 'worker');
  await put('owner', next({ target: '2026-12-01', milestones: [...MS, { id: 'handoff', name: 'Handoff', start: '', end: '' }] }));
  assert.equal(w.board().data.target, '2026-12-01');
  assert.equal(w.board().data.milestones.length, 5);
  // Worker may change the project fields...
  await put('worker', next({ kind: 'product', start: '2026-10-02' }));
  assert.equal(w.board().data.kind, 'product');
  await put('worker', next({ milestones: MS.map((m) => ({ ...m, end: m.id === 'live' ? '2026-12-15' : m.end })) }));
  assert.equal(w.board().data.milestones.find((m) => m.id === 'live').end, '2026-12-15');
  // ...and nothing else on the tab.
  assert.equal(await status(put('worker', next({ name: 'Renamed' }))), 403);
  assert.equal(await status(put('worker', next({ projects: { '*': { name: 'x', url: 'https://claude.ai/code/project/chan_x' } } }))), 403);
  assert.equal(await status(w.store.putBoard(w.db, 'worker', 'brand-new', { data: { name: 'New', prefix: 'NEW' } }, true)), 403, 'worker does not create tabs');
  // Agent and every other name never move a date.
  for (const who of ['agent', 'agent2', 'agent3', 'lane1', 'github-actions', 'cloud-worker']) {
    assert.equal(await status(put(who, next({ target: '2027-01-01' }))), 403, who);
  }
  assert.equal(w.board().data.name, 'Acme Plumbing');
  assert.equal(w.board().data.target, '2026-12-01');
  // Bad project fields are refused for Owner too.
  assert.equal(await status(put('owner', next({ target: 'soon' }))), 400);
  assert.equal(await status(put('owner', next({ milestones: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] }))), 400);
  // A stale version is a conflict, as before.
  assert.equal(await status(w.store.putBoard(w.db, 'owner', 'core', { data: next({}), ifVersion: 1 }, true)), 409);
});

// ------------------------------------------------------------------------------------------ routes and tools
const ENV = {
  SERVICE_PRINCIPALS: JSON.stringify({ 'cloudcore.access': 'cloud-worker@core', 'jarv.access': 'worker' }),
  EMAIL_PRINCIPALS: JSON.stringify({ 'owner@example.com': 'owner' }),
};

async function seeded() {
  const w = await world();
  const api = await import(src('api.js'));
  const mcp = await import(src('mcp.js'));
  const rows = [card(2, 'done', 'intake'), card(3, 'doing', 'build'), card(4, 'blocked', 'build'), card(5, 'todo', 'preview-approved'), card(6, 'todo')];
  for (const [i, c] of rows.entries()) await w.put(`s${i}`, c);
  await w.put('o1', { ...card(1, 'done'), board: 'other', key: 'OTH-1' });
  const env = { ...ENV, DB: w.db, HANDBOOK: 'x' };
  const route = async (claims, method, p, body) => {
    const req = new Request(`https://board.example.com/api/v1${p}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });
    let res;
    try { res = await api.handleApi(req, env, new URL(req.url), claims); } catch (err) { return { status: err.status || 500, body: { error: err.message } }; }
    return { status: res.status, body: await res.json() };
  };
  const tool = async (principal, name, args = {}) => {
    const r = await mcp.handleRpc(env, principal, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const res = r.json.result;
    return { isError: !!res.isError, text: res.content[0].text };
  };
  return { ...w, env, route, tool, mcp };
}
const OWNER = { email: 'owner@example.com' };

test('GET /portfolio returns one row per tab; a bound token sees its own tab only', { skip }, async () => {
  const w = await seeded();
  const r = await w.route(OWNER, 'GET', '/portfolio');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.projects.map((p) => p.board), ['core', 'other']);
  const core = r.body.projects[0];
  assert.deepEqual([core.name, core.kind, core.tracked, core.target, core.start], ['Acme Plumbing', 'website', true, '2026-11-03', '2026-10-01']);
  assert.equal(core.cards.total, 6);
  assert.equal(core.cards.done, 1);
  assert.equal(core.cards.open, 5);
  assert.equal(core.cards.blocked, 1);
  assert.equal(core.percent, 17);
  assert.deepEqual(core.milestones.map((m) => m.id), ['intake', 'build', 'preview-approved', 'live']);
  assert.equal(core.noMilestone, 2);
  assert.equal(core.next.id, 'build');
  assert.match(core.line, /^Acme Plumbing: 17 percent, Build 0 of 2 \(1 blocked\)/);
  const other = r.body.projects[1];
  assert.deepEqual([other.tracked, other.milestones.length, other.percent, other.next], [false, 0, 100, null]);
  const bound = await w.route({ common_name: 'cloudcore.access' }, 'GET', '/portfolio');
  assert.equal(bound.status, 200);
  assert.deepEqual(bound.body.projects.map((p) => p.board), ['core']);
});

test('project_status, whats_waiting and snapshot carry the project line; cards show their milestone', { skip }, async () => {
  const w = await seeded();
  const all = await w.tool('agent', 'project_status');
  assert.equal(all.isError, false, all.text);
  assert.match(all.text, /^Acme Plumbing: 17 percent, Build 0 of 2 \(1 blocked\) late, Preview approved not started, /m);
  assert.doesNotMatch(all.text, /^Other:/m, 'a tab with no kind, dates or milestones is not tracked');
  assert.match(all.text, /target Nov 3/);
  assert.match(all.text, /2 cards with no milestone/);
  const one = await w.tool('agent', 'project_status', { board: 'core' });
  assert.match(one.text, /^  Intake: done, 1 of 1 card done, Oct 1 to Oct 10$/m);
  assert.match(one.text, /^  Build: late, 0 of 2 cards done, 1 blocked, Oct 11 to Oct 25$/m);
  const untracked = await w.tool('agent', 'project_status', { board: 'other' });
  assert.equal(untracked.text, 'Other: 100 percent, 1 of 1 card done');
  assert.equal((await w.tool('agent', 'project_status', { board: 'nope' })).isError, true);
  const waiting = await w.tool('agent', 'whats_waiting');
  assert.match(waiting.text, /\n\nProjects:\nAcme Plumbing: 17 percent/);
  assert.match(waiting.text, /COR-4/, 'the blocked card is still listed first');
  const snap = await w.tool('agent', 'snapshot', { github: false });
  assert.match(snap.text, /^== PROJECTS ==\nAcme Plumbing: 17 percent/m);
  assert.match(snap.text, /^  milestone: build$/m);
  const boards = JSON.parse((await w.tool('agent', 'list_boards')).text);
  const core = boards.find((b) => b.id === 'core');
  assert.deepEqual([core.kind, core.start, core.target, core.milestones.length], ['website', '2026-10-01', '2026-11-03', 4]);
  const list = JSON.parse((await w.tool('agent', 'list_cards', { board: 'core' })).text);
  assert.equal(list.find((c) => c.key === 'COR-3').milestone, 'build');
  const got = JSON.parse((await w.tool('agent', 'get_card', { key: 'COR-3' })).text);
  assert.equal(got.card.milestone, 'build');
  const tools = w.mcp.TOOLS.map((t) => t.name);
  assert.ok(tools.includes('project_status'));
});

test('update_card takes a milestone from owner and agent, and refuses it from a read only name', { skip }, async () => {
  const w = await seeded();
  const doc = JSON.parse((await w.tool('owner', 'get_card', { key: 'COR-6' })).text);
  const ok = await w.tool('agent', 'update_card', { key: 'COR-6', patch: { milestone: 'preview-approved' }, ifVersion: doc.version });
  assert.equal(ok.isError, false, ok.text);
  const doc2 = JSON.parse((await w.tool('owner', 'get_card', { key: 'COR-6' })).text);
  assert.equal(doc2.card.milestone, 'preview-approved');
  for (const who of ['agent2', 'agent3']) {
    const refused = await w.tool(who, 'update_card', { key: 'COR-6', patch: { milestone: 'build' }, ifVersion: doc2.version });
    assert.equal(refused.isError, true, who);
    assert.match(refused.text, /read only/);
  }
  const jv = await w.tool('worker', 'update_card', { key: 'COR-6', patch: { milestone: 'build' }, ifVersion: doc2.version });
  assert.equal(jv.isError, false, jv.text);
  const doc3 = JSON.parse((await w.tool('owner', 'get_card', { key: 'COR-6' })).text);
  assert.equal(doc3.card.milestone, 'build');
  const unknown = await w.tool('owner', 'update_card', { key: 'COR-6', patch: { milestone: 'moon' }, ifVersion: doc3.version });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /not a milestone of board core/);
});

test('milestone and project dates are editable through the API by owner and worker only', { skip }, async () => {
  const w = await seeded();
  const b = w.board();
  const data = { ...b.data, target: '2026-12-24' };
  assert.equal((await w.route({ common_name: 'jarv.access' }, 'PUT', '/boards/core', { data, ifVersion: b.version })).status, 200);
  assert.equal(w.board().data.target, '2026-12-24');
  assert.equal((await w.route({ common_name: 'cloudcore.access' }, 'PUT', '/boards/core', { data: { ...data, target: '2027-01-01' }, ifVersion: w.board().version })).status, 403);
  assert.equal((await w.route(OWNER, 'PUT', '/boards/core', { data: { ...data, target: '2027-01-02' }, ifVersion: w.board().version })).status, 200);
  assert.equal(w.board().data.target, '2027-01-02');
});

// ------------------------------------------------------------------------------------------ the page
const html = fs.readFileSync(path.join(__dirname, '..', 'page', 'index.html'), 'utf8');

test('the page source has the milestone header, the editor and the portfolio view', () => {
  for (const marker of ['id="msHead"', 'data-ms=', 'class="mscard', 'class="msproj"', 'with no milestone', 'id="portBtn"', 'id="portfolio"', 'id="portList"', 'id="portSort"', 'id="projDlg"', 'data-milestone', '/portfolio', 'Edit dates', 'renderMilestones', 'renderPortfolio']) {
    assert.ok(html.includes(marker), `page has ${marker}`);
  }
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script));
});

function page(fetchImpl) {
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1].replace(
    /\n  start\(\);\s*\}\)\(\);\s*$/,
    '\n  globalThis.__page = { projectStats, renderMilestones, portRow, portRows, refresh, localToday, card, msName, msMatch, railHtml, setState: (b, t, c, f, who) => { boards = b; tasks = t; current = c; msFilter = f || ""; me = { principal: who || "owner", canWrite: true, isAdmin: true }; canWrite = true; }, getFilter: () => msFilter };\n})();',
  );
  const element = (tag = 'div') => ({
    tagName: tag.toUpperCase(), children: [], attributes: {}, hidden: false, textContent: '', innerHTML: '', dataset: {}, style: {},
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener() {}, setAttribute(k, v) { this.attributes[k] = v; }, appendChild(c) { this.children.push(c); },
    querySelector() { return null; }, querySelectorAll() { return []; }, remove() {}, focus() {},
  });
  const nodes = new Map();
  const document = {
    querySelector() { return null; }, querySelectorAll() { return []; },
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    createElement: element, addEventListener() {}, body: element('body'),
  };
  const context = { document, window: { addEventListener() {}, innerWidth: 1000, innerHeight: 800 }, location: { hash: '' },
    history: { replaceState() {} }, localStorage: { getItem() { return null; }, setItem() {} },
    setInterval() {}, setTimeout() {}, clearTimeout() {}, fetch: fetchImpl || (async () => { throw new Error('no API call expected'); }), URL, Date, AbortController };
  context.globalThis = context;
  vm.runInNewContext(script, context, { filename: 'board-page.js' });
  return { ui: context.__page, node: (id) => document.getElementById(id) };
}

const stripIds = (s) => JSON.parse(JSON.stringify(s));

test('the page works out the same numbers as the Worker', async () => {
  const P = await import(src('projects.js'));
  const { ui } = page();
  const board = { id: 'core', name: 'Acme Plumbing', target: '2026-11-03', milestones: MS };
  const cases = [
    [],
    [card(1, 'done', 'intake'), card(2, 'done', 'intake'), card(3, 'doing', 'build'), card(4, 'blocked', 'build'), card(5, 'todo', 'preview-approved'), card(6, 'done')],
    [card(1, 'doing', 'preview-approved'), card(2, 'todo', 'preview-approved'), card(3, 'todo', 'ghost')],
    [card(1, 'done', 'intake'), card(2, 'done', 'build', { deleted: true })],
  ];
  for (const cards of cases) {
    for (const today of ['2026-10-05', TODAY, '2026-12-31']) {
      assert.deepEqual(stripIds(ui.projectStats(board, cards, today)), stripIds(P.projectStats(board, cards, today)), `${cards.length} cards on ${today}`);
    }
  }
});

test('the tab header shows a bar per milestone, the project block and the no milestone pill; a tab with no project data shows nothing', () => {
  const { ui, node } = page();
  const board = { id: 'core', name: 'Acme Plumbing', order: 1, kind: 'website', start: '2026-10-01', target: '2099-11-03', milestones: [
    { id: 'intake', name: 'Intake', start: '2026-10-01', end: '2026-10-10' }, { id: 'build', name: 'Build', start: '', end: '' }, { id: 'live', name: 'Live', start: '', end: '' }] };
  const tasks = [card(1, 'done', 'intake'), card(2, 'done', 'build'), card(3, 'blocked', 'build'), card(4, 'doing', 'build'), card(5, 'todo')].map((c, i) => ({ ...c, id: `p${i}`, version: 1 }));
  ui.setState([{ id: 'main', name: 'Main', order: 0 }, board], tasks, 'core');
  ui.renderMilestones();
  const head = node('msHead');
  assert.equal(head.hidden, false);
  assert.equal((head.innerHTML.match(/class="mscard /g) || []).length, 3, 'one card per milestone');
  assert.match(head.innerHTML, /class="mscard done" data-ms="intake"/);
  assert.match(head.innerHTML, /class="mscard inprogress" data-ms="build"/);
  assert.match(head.innerHTML, /class="mscard notstarted" data-ms="live"/);
  assert.match(head.innerHTML, /1 of 3 done, 1 blocked/);
  assert.match(head.innerHTML, /Oct 1 to Oct 10/);
  assert.match(head.innerHTML, /<span class="msp">40%<\/span><span>2 of 5 cards done<\/span>/);
  assert.match(head.innerHTML, /Started Oct 1/);
  assert.match(head.innerHTML, /Target Nov 3/);
  assert.doesNotMatch(head.innerHTML, /class="late"/, 'a far future target is not late');
  assert.match(head.innerHTML, /Next: Build/);
  assert.match(head.innerHTML, /data-ms="__none"[^>]*>1 with no milestone</);
  assert.match(head.innerHTML, /data-msedit="1"/, 'Owner gets the editor');
  // Cards carry a small milestone pill, and the search and filter see the milestone.
  assert.match(ui.card(tasks[1], false).innerHTML, /<span class="mstag"[^>]*>Build<\/span>/);
  assert.doesNotMatch(ui.card(tasks[4], false).innerHTML, /mstag/);
  ui.setState([{ id: 'main', name: 'Main', order: 0 }, board], tasks, 'core', 'build');
  assert.deepEqual(tasks.filter((t) => ui.msMatch(t)).map((t) => t.key), ['COR-2', 'COR-3', 'COR-4']);
  ui.setState([{ id: 'main', name: 'Main', order: 0 }, board], tasks, 'core', '__none');
  assert.deepEqual(tasks.filter((t) => ui.msMatch(t)).map((t) => t.key), ['COR-5']);
  // The editor select of a card lists the tab's milestones.
  const rail = ui.railHtml(tasks[1], true);
  assert.match(rail, /data-milestone/);
  assert.match(rail, /<option value="build" selected>Build<\/option>/);
  assert.match(rail, /<option value="">None<\/option>/);
  assert.doesNotMatch(ui.railHtml({ ...tasks[1], board: 'main', milestone: undefined }, true), /data-milestone/, 'a tab with no milestones offers none');
  // A tab with no project data shows Owner the way in (so existing tabs can be set up from the page) and nobody else anything; the All tab shows none.
  ui.setState([{ id: 'main', name: 'Main', order: 0 }], [], 'main');
  ui.renderMilestones();
  assert.equal(node('msHead').hidden, false);
  assert.match(node('msHead').innerHTML, /data-msedit="1"[^>]*>Set up milestones</);
  assert.doesNotMatch(node('msHead').innerHTML, /mscard/);
  ui.setState([{ id: 'main', name: 'Main', order: 0 }], [], 'main', '', 'agent');
  ui.renderMilestones();
  assert.equal(node('msHead').hidden, true);
  assert.equal(node('msHead').innerHTML, '');
  ui.setState([{ id: 'main', name: 'Main', order: 0 }, board], tasks, 'core', '', 'agent');
  ui.renderMilestones();
  assert.doesNotMatch(node('msHead').innerHTML, /data-msedit/, 'only Owner gets the editor on a project tab');
  ui.setState([{ id: 'main', name: 'Main', order: 0 }, board], tasks, 'all');
  ui.renderMilestones();
  assert.equal(node('msHead').hidden, true);
  // A late milestone and a late target are marked.
  const late = { ...board, target: '2020-01-01', milestones: [{ id: 'intake', name: 'Intake', start: '', end: '2020-01-01' }, ...board.milestones.slice(1)] };
  ui.setState([{ id: 'main', name: 'Main', order: 0 }, late], [{ ...card(1, 'doing', 'intake'), id: 'z', version: 1 }], 'core');
  ui.renderMilestones();
  assert.match(node('msHead').innerHTML, /class="mscard late" data-ms="intake"/);
  assert.match(node('msHead').innerHTML, /Target Jan 1 <span class="late">late<\/span>/);
});

test('a portfolio row shows percent, a square per milestone, the dates and the next milestone', () => {
  const { ui } = page();
  const row = {
    board: 'core', name: 'Acme Plumbing', kind: 'website', percent: 62, late: true, start: '2026-10-12', target: '2026-11-03',
    cards: { total: 13, done: 8, open: 5, blocked: 1 }, next: { id: 'build', name: 'Build', status: 'late' },
    milestones: [{ id: 'intake', name: 'Intake', status: 'done', done: 2, total: 2 }, { id: 'build', name: 'Build', status: 'late', done: 3, total: 5 }, { id: 'live', name: 'Live', status: 'notstarted', done: 0, total: 0 }],
  };
  const html1 = ui.portRow(row);
  assert.match(html1, /data-board="core"/);
  assert.match(html1, /<b>62%<\/b>/);
  assert.match(html1, /class="pbar late"/);
  assert.equal((html1.match(/<i class="sq /g) || []).length, 3);
  assert.match(html1, /class="sq done"/);
  assert.match(html1, /class="sq late"/);
  assert.match(html1, /class="sq notstarted"/);
  assert.match(html1, /8 of 13 cards done, 5 open, 1 blocked/);
  assert.match(html1, /Start <\/span>Oct 12/);
  assert.match(html1, /Target <\/span>Nov 3 <span class="late">late<\/span>/);
  assert.match(html1, /Next <\/span>Build \(late\)/);
  const bare = ui.portRow({ ...row, kind: '', late: false, percent: 100, target: '', start: '', next: null, milestones: [] });
  assert.match(bare, /Target <\/span>none/);
  assert.match(bare, /class="pbar done"/);
  assert.match(bare, /No milestones/);
});

// ------------------------------------------------------------------------------------------ one time zone for "today"
test('today is worked out in the configured zone from a fixed clock', async () => {
  const P = await import(src('projects.js'));
  const clock = new Date('2026-11-01T03:00:00Z');
  assert.equal(P.todayIn('UTC', clock), '2026-11-01');
  assert.equal(P.todayIn('America/Phoenix', clock), '2026-10-31', 'Phoenix is seven hours behind UTC all year');
  assert.equal(P.todayIn('Pacific/Kiritimati', clock), '2026-11-01');
  assert.equal(P.todayIn(undefined, clock), '2026-11-01', 'no zone means UTC');
  assert.equal(P.todayIn('Not/AZone', clock), '2026-11-01', 'an unknown zone falls back to UTC');
  // The same milestone is late on one side of midnight and not on the other.
  const board = { milestones: [{ id: 'a', name: 'A', end: '2026-10-31' }] };
  const cards = [{ status: 'doing', milestone: 'a' }];
  assert.equal(P.projectStats(board, cards, P.todayIn('America/Phoenix', clock)).milestones[0].status, 'inprogress');
  assert.equal(P.projectStats(board, cards, P.todayIn('UTC', clock)).milestones[0].status, 'late');
});

test('the Worker sends its today with the boards and the portfolio, and the page uses it', { skip }, async () => {
  const P = await import(src('projects.js'));
  const w = await seeded();
  w.env.BOARD_TZ = 'America/Phoenix';
  const boards = await w.route(OWNER, 'GET', '/boards');
  assert.equal(boards.body.today, P.todayIn('America/Phoenix'));
  assert.equal((await w.route(OWNER, 'GET', '/portfolio')).body.today, boards.body.today);
  // The page takes that value instead of its own clock.
  const reply = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const board = { id: 'core', data: { name: 'Acme Plumbing', order: 1, milestones: [{ id: 'a', name: 'A', start: '', end: '2029-12-31' }] }, version: 1 };
  const task = { id: 't1', version: 1, data: { board: 'core', key: 'COR-1', title: 'x', status: 'doing', milestone: 'a', history: [] } };
  const { ui } = page(async (url) => (String(url).endsWith('/boards') ? reply({ today: '2030-01-05', boards: [board] }) : reply({ tasks: [task] })));
  await ui.refresh();
  assert.equal(ui.localToday(), '2030-01-05');
  const row = ui.portRows().find((r) => r.board === 'core');
  assert.equal(row.milestones[0].status, 'late', 'late is judged on the day the Worker sent');
});

test('the portfolio rows come from the boards and cards the page already has, and match the Worker rows', async () => {
  const P = await import(src('projects.js'));
  const { ui } = page();
  const boards = [{ id: 'main', name: 'Main', order: 0 }, { id: 'core', name: 'Acme Plumbing', order: 1, kind: 'website', start: '2026-10-01', target: '2099-01-01', milestones: MS }];
  const cards = [card(1, 'done', 'intake'), card(2, 'doing', 'build'), card(3, 'blocked', 'build'), card(4, 'todo')];
  const tasks = cards.map((c, i) => ({ ...c, id: 'k' + i, version: 1 }));
  ui.setState(boards, tasks, 'core');
  const mine = ui.portRows();
  const theirs = P.portfolioRows(boards.map((b) => ({ id: b.id, data: b })), cards, ui.localToday());
  assert.deepEqual(stripIds(mine.map((r) => r.board)), theirs.map((r) => r.board));
  for (const [a, b] of mine.map((r, i) => [r, theirs[i]])) {
    assert.deepEqual(stripIds({ p: a.percent, l: a.late, c: a.cards, n: a.next, s: a.start, t: a.target, k: a.kind, m: a.milestones.map((m) => [m.id, m.status, m.done, m.total]) }),
      stripIds({ p: b.percent, l: b.late, c: b.cards, n: b.next, s: b.start, t: b.target, k: b.kind, m: b.milestones.map((m) => [m.id, m.status, m.done, m.total]) }));
  }
});

test('the page no longer polls the portfolio route', () => {
  const body = html.slice(html.indexOf('function portRefresh'), html.indexOf('function openPortfolio'));
  assert.doesNotMatch(body, /api\(/);
  assert.doesNotMatch(html, /api\('GET', '\/portfolio'\)/);
});
