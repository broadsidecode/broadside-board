'use strict';

// Pulse in the kit: off by default, so no log rows, no endpoints and no scheduled work until the owner turns the
// module on; and when it is on, the claims checker looks at GitHub and Pages links only. Evaluated in a child Node
// process with no config override, like kit-config.test.js.
//   node --import ./tests/setup.mjs --test tests/kit-pulse.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const src = (f) => pathToFileURL(path.join(__dirname, '..', 'worker', 'src', f)).href;

const CHILD = `
const pulse = await import(${JSON.stringify(src('pulse.js'))});
const api = await import(${JSON.stringify(src('api.js'))});
const ON = JSON.stringify({ pulse: true });
const OFF = JSON.stringify({ pulse: false });
const statements = [];
const db = { prepare(sql) { statements.push(sql); const s = { bind() { return s; }, async run() { return { meta: { changes: 0 } }; }, async all() { return { results: [] }; }, async first() { return null; } }; return s; } };
const get = async (env, p) => {
  const req = new Request('https://board.example.test/api/v1' + p);
  const res = await api.handleApi(req, { ...env, DB: db, EMAIL_PRINCIPALS: JSON.stringify({ 'o@example.test': 'owner' }) }, new URL(req.url), { email: 'o@example.test' });
  return res.status;
};
await pulse.logCall({ DB: db }, { principal: 'owner', tool: 'list_boards', outcome: 'ok' });
const offLogs = statements.length;
await pulse.logCall({ DB: db, BOARD_MODULES: ON }, { principal: 'owner', tool: 'list_boards', outcome: 'ok' });
const onLogs = statements.length - offLogs;
const cronOff = await pulse.runPulseCron({ DB: db });
const before = statements.length;
const cronOn = await pulse.runPulseCron({ DB: db, BOARD_MODULES: ON });
const seen = [];
const fetchImpl = async (url) => { seen.push(String(url)); return { ok: true, status: 200, json: async () => ({ merged: true }) }; };
const other = await pulse.checkEvidence({ kind: 'url', url: 'https://example.com/x' }, { GITHUB_MERGE_TOKEN: 't' }, fetchImpl);
const pages = await pulse.checkEvidence({ kind: 'pages', url: 'https://a.pages.dev/' }, {}, fetchImpl);
const pr = await pulse.checkEvidence({ kind: 'pr', owner: 'o', repo: 'r', number: 1, url: 'x' }, { GITHUB_MERGE_TOKEN: 't' }, fetchImpl);
console.log('RESULT:' + JSON.stringify({
  enabled: [pulse.pulseEnabled({}), pulse.pulseEnabled(undefined), pulse.pulseEnabled({ BOARD_MODULES: ON }), pulse.pulseEnabled({ BOARD_MODULES: OFF }), pulse.pulseEnabled({ BOARD_MODULES: 'not json' })],
  anyUrl: pulse.CLAIM_ANY_URL,
  offLogs, onLogs, cronOff, cronOnRan: statements.length > before && !cronOn.skipped,
  offStatus: await get({}, '/pulse/stuck'), onStatus: await get({ BOARD_MODULES: ON }, '/pulse/stuck'),
  other, pages, pr, seen,
}));
`;

const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
assert.equal(r.status, 0, `child failed: ${r.stderr}`);
const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT:'));
assert.ok(line, `no result line: ${r.stdout}`);
const result = JSON.parse(line.slice('RESULT:'.length));

test('Pulse is off unless the pulse module is on', () => {
  assert.deepEqual(result.enabled, [false, false, true, false, false]);
});

test('with the module off nothing is logged, no endpoint answers and the scheduled run does nothing', () => {
  assert.equal(result.offLogs, 0);
  assert.equal(result.offStatus, 404);
  assert.deepEqual(result.cronOff, { skipped: true });
});

test('with the module on a call is logged, the endpoints answer the owner and the scheduled run works', () => {
  assert.equal(result.onLogs, 1);
  assert.equal(result.onStatus, 200);
  assert.equal(result.cronOnRan, true);
});

test('the claims checker looks at GitHub and Pages links only', () => {
  assert.equal(result.anyUrl, false);
  assert.equal(result.other.verdict, null);
  assert.equal(result.pages.verdict, true);
  assert.equal(result.pr.verdict, true);
  assert.deepEqual(result.seen, ['https://a.pages.dev/', 'https://api.github.com/repos/o/r/pulls/1']);
});
