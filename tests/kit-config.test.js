'use strict';

// The shipped default config (worker/src/config.js with no test override). The other tests run under a fuller
// config from setup.mjs, so this file evaluates everything in a child Node process that has no override at all.
//   node --import ./tests/setup.mjs --test tests/kit-config.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const src = (f) => pathToFileURL(path.join(__dirname, '..', 'worker', 'src', f)).href;

const CHILD = `
const config = await import(${JSON.stringify(src('config.js'))});
const lib = await import(${JSON.stringify(src('lib.js'))});
const mcp = await import(${JSON.stringify(src('mcp.js'))});
const OFF = JSON.stringify({ start: false, github: false, generate: false, tabs: false, production: false, pulse: false });
const ON = JSON.stringify({ start: true, github: true, generate: true, tabs: true, production: true, pulse: true });
const rpc = async (env, method, params) => (await mcp.handleRpc(env, 'owner', { jsonrpc: '2.0', id: 1, method, params })).json;
const listNames = async (env) => (await rpc(env, 'tools/list')).result.tools.map((t) => t.name);
const called = await rpc({ BOARD_MODULES: OFF }, 'tools/call', { name: 'nudge_card', arguments: {} });
const ask = lib.applyAskRule
  ? lib.applyAskRule(null, { ask: { kind: 'merge', to: 'owner', pr: 'https://github.com/example-org/repo/pull/5' } }, 'owner', new Date().toISOString())
  : null;
const out = {
  lists: {
    WRITERS: config.WRITERS, PROXIES: config.PROXIES, ADMINS: config.ADMINS, MCP_PRINCIPALS: config.MCP_PRINCIPALS,
    DEFAULT_LANE: config.DEFAULT_LANE, GITHUB_ORGS: config.GITHUB_ORGS, SCOPED_WORKERS: config.SCOPED_WORKERS,
  },
  parse: [
    lib.parsePrUrl('https://github.com/example-org/repo/pull/5'),
    lib.parsePrUrl('https://github.com/anyone/anything/pull/1'),
    lib.parsePrUrl(''),
  ],
  askProblem: ask && ask.problem ? String(ask.problem) : '',
  hiddenOff: config.hiddenTools({ BOARD_MODULES: OFF }),
  hiddenOn: config.hiddenTools({ BOARD_MODULES: ON }),
  hiddenNone: config.hiddenTools({}),
  hiddenNoEnv: config.hiddenTools(undefined),
  hiddenBad: config.hiddenTools({ BOARD_MODULES: 'not json' }),
  hiddenPartial: config.hiddenTools({ BOARD_MODULES: JSON.stringify({ github: true }) }),
  publicDefault: config.publicConfig({}),
  publicOn: config.publicConfig({ BOARD_MODULES: ON }),
  listOff: await listNames({ BOARD_MODULES: OFF }),
  listNone: await listNames({}),
  called,
};
console.log('RESULT:' + JSON.stringify(out));
`;

function runChild() {
  // No --import of setup.mjs here on purpose: globalThis.__BOARD_CONFIG__ stays unset, so config.js uses its own object.
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(r.status, 0, `child failed: ${r.stderr}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT:'));
  assert.ok(line, `no result line: ${r.stdout}`);
  return JSON.parse(line.slice('RESULT:'.length));
}

const result = runChild();
const HIDDEN = ['nudge_card', 'pause_board', 'sync_github', 'generate_card', 'add_board'];

test('the default config lists carry one owner and one agent and nothing else', () => {
  const l = result.lists;
  assert.deepEqual(l.WRITERS, ['owner', 'agent']);
  assert.deepEqual(l.PROXIES, ['owner', 'agent']);
  assert.deepEqual(l.ADMINS, ['owner']);
  assert.deepEqual(l.MCP_PRINCIPALS, ['agent', 'owner']);
  assert.equal(l.DEFAULT_LANE, 'main');
  assert.deepEqual(l.GITHUB_ORGS, []);
  assert.deepEqual(l.SCOPED_WORKERS, []);
});

test('with no GitHub organization configured no pull request URL parses', () => {
  assert.deepEqual(result.parse, [null, null, null]);
  assert.match(result.askProblem, /merge ask needs ask\.pr/);
});

test('hiddenTools hides the module tools when modules are off and nothing without BOARD_MODULES', () => {
  assert.deepEqual([...result.hiddenOff].sort(), [...HIDDEN].sort());
  assert.deepEqual(result.hiddenOn, []);
  assert.deepEqual(result.hiddenNone, []);
  assert.deepEqual(result.hiddenNoEnv, []);
  assert.deepEqual(result.hiddenBad, []);
  assert.deepEqual([...result.hiddenPartial].sort(), ['add_board', 'generate_card', 'nudge_card', 'pause_board']);
});

test('tools/list hides module tools and tools/call still runs a hidden one', () => {
  for (const name of HIDDEN) {
    assert.ok(!result.listOff.includes(name), `${name} is hidden`);
    assert.ok(result.listNone.includes(name), `${name} is listed when BOARD_MODULES is not set`);
  }
  assert.ok(result.listOff.includes('how_it_works'));
  assert.equal(result.called.error, undefined, 'a hidden tool is not an unknown tool');
  assert.ok(result.called.result, 'a hidden tool still answers');
});

test('publicConfig has labels and flags only', () => {
  const p = result.publicDefault;
  assert.deepEqual(Object.keys(p).sort(), ['agent', 'agents', 'lanes', 'mentionNames', 'modules', 'owner']);
  assert.deepEqual(p.owner, { name: 'Owner' });
  assert.deepEqual(p.agent, { label: 'Agent' });
  assert.deepEqual(p.agents, []);
  assert.deepEqual(p.lanes, ['main']);
  assert.deepEqual(p.mentionNames, ['agent']);
  assert.deepEqual(p.modules, { start: false, github: false, production: false, generate: false, tabs: false, pulse: false });
  assert.equal(result.publicOn.modules.github, true);
  assert.ok(!/@/.test(JSON.stringify(p)));
});
