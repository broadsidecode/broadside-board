'use strict';

// The installer, with every outside call faked. No network, no Cloudflare, no real wrangler.
//   node --import ./tests/setup.mjs --test tests/kit-setup.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const S = require('../setup.js');

const REAL_CONFIG_JS = fs.readFileSync(path.join(__dirname, '..', 'worker', 'src', 'config.js'), 'utf8');
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const DB_ID = '11111111-2222-3333-4444-555555555555';

function kitRoot(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-setup-'));
  fs.mkdirSync(path.join(root, 'worker', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'worker', 'src', 'config.js'), REAL_CONFIG_JS);
  fs.writeFileSync(path.join(root, 'worker', 'schema.sql'), 'CREATE TABLE IF NOT EXISTS t (id INTEGER);\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
  for (const [name, text] of Object.entries(extra)) fs.writeFileSync(path.join(root, name), text);
  return root;
}
const withWrangler = (root) => {
  fs.mkdirSync(path.join(root, 'node_modules', 'wrangler', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), '');
};
const snapshot = (root) => {
  const out = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out[path.relative(root, p).replace(/\\/g, '/')] = fs.readFileSync(p, 'utf8');
    }
  })(root);
  return out;
};

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

// One log for run and fetch calls, in the order they happened.
function fakes(root, opts = {}) {
  const log = [];
  const runs = [];
  const fetches = [];
  const wranglerJs = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const run = async (cmd, args, o = {}) => {
    runs.push({ cmd, args, o });
    if (cmd === 'npm') { fs.mkdirSync(path.dirname(wranglerJs), { recursive: true }); fs.writeFileSync(wranglerJs, ''); log.push('npm'); return { code: 0, stdout: '', stderr: '' }; }
    const sub = args.slice(1).filter((a) => !a.startsWith('--')).slice(0, 2).join(' ');
    if (sub.startsWith('d1 create')) { log.push('d1 create'); return { code: 0, stdout: `Successfully created DB\n{ "d1_databases": [ { "binding": "DB", "database_id": "${DB_ID}" } ] }`, stderr: '' }; }
    if (sub.startsWith('d1 execute')) { log.push('d1 execute'); return { code: 0, stdout: '', stderr: '' }; }
    if (sub.startsWith('deploy')) { log.push('deploy'); return { code: 0, stdout: 'Deployed board https://board.me.workers.dev', stderr: '' }; }
    if (sub.startsWith('secret put')) { log.push(`secret ${args[3]}`); return { code: 0, stdout: '', stderr: '' }; }
    return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
  };
  const boards = opts.boards || [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    fetches.push({ url, method, init });
    const u = new URL(url);
    if (u.host === 'api.cloudflare.com') {
      if (u.pathname.endsWith('/accounts')) return reply(200, { result: [{ id: 'acc1' }] });
      if (u.pathname.endsWith('/workers/subdomain')) return reply(200, { result: { subdomain: 'me' } });
    }
    const p = u.pathname;
    log.push(`${method} ${p}`.replace(/\/t-[^/]+$/, '/<card>'));
    if (p === '/api/v1/health') return reply(200, { ok: true });
    if (p === '/api/v1/config') return reply(200, { owner: { name: 'Alex' } });
    if (p === '/api/v1/login') return reply(JSON.parse(init.body).password ? 200 : 401, {});
    if (p === '/api/v1/boards' && method === 'GET') return reply(200, { boards });
    if (p === '/api/v1/boards/main') return reply(200, { id: 'main', version: 1 });
    if (p === '/api/v1/counters/TASK' && method === 'PUT') return reply(200, { id: 'TASK', next: 1, version: 1 });
    if (p === '/api/v1/counters/TASK/next') return reply(200, { prefix: 'TASK', number: 1, version: 2 });
    if (p.startsWith('/api/v1/tasks/')) return reply(200, { id: 'x', version: 1 });
    if (p === '/api/v1/tokens') return reply(200, { token: 'bk_abc', principal: JSON.parse(init.body).principal, board: '' });
    return reply(404, {});
  };
  return { run, fetchImpl, log, runs, fetches };
}

const baseConfig = (over = {}) => ({ ownerName: 'Alex', agentLabel: 'Helper', workerName: 'board', databaseName: 'board-db', ...over });
const noop = () => {};

test('parseArgs reads every command and flag', () => {
  assert.equal(S.parseArgs([]).command, 'setup');
  const a = S.parseArgs(['--config', 'x.json', '--yes', '--dry-run', '--rotate']);
  assert.equal(a.config, 'x.json');
  assert.ok(a.yes && a.dryRun && a.rotate);
  assert.equal(a.errors.length, 0);
  assert.equal(S.parseArgs(['--apply-config']).command, 'apply-config');
  assert.equal(S.parseArgs(['status']).command, 'status');
  const g = S.parseArgs(['add-agent', 'helper', '--board', 'main', '--note', 'for the laptop']);
  assert.deepEqual([g.command, g.principal, g.board, g.note], ['add-agent', 'helper', 'main', 'for the laptop']);
  assert.ok(S.parseArgs(['add-agent']).errors.length, 'principal is required');
  assert.ok(S.parseArgs(['--config']).errors.length, 'a flag with no value is an error');
  assert.ok(S.parseArgs(['--nope']).errors.length);
});

test('normalizeConfig fills defaults and refuses bad values', () => {
  const c = S.normalizeConfig({});
  assert.equal(c.ownerName, 'Owner');
  assert.deepEqual(c.lanes, ['main']);
  assert.deepEqual(c.mentionNames, ['agent']);
  assert.ok(Object.values(c.modules).every((v) => v === false));
  assert.throws(() => S.normalizeConfig({ workerName: 'Bad Name' }), /workerName/);
  assert.throws(() => S.normalizeConfig({ domain: { mode: 'custom', hostname: 'nope' } }), /hostname/);
  assert.throws(() => S.normalizeConfig({ auth: { mode: 'access' }, domain: { mode: 'custom', hostname: 'b.example.com' } }), /accessTeamDomain/);
  assert.throws(() => S.normalizeConfig({ agents: ['owner'] }), /not owner or agent/);
  assert.deepEqual(S.normalizeConfig({ agents: 'a1, a2' }).agents.map((a) => a.id), ['a1', 'a2']);
});

test('renderConfigJs replaces only the CONFIG block and is idempotent', () => {
  const cfg = S.normalizeConfig(baseConfig({ ownerName: 'Zoe } \"q\"', agents: [{ id: 'helper', label: 'Helper' }], modules: { generate: true } }));
  const once = S.renderConfigJs(REAL_CONFIG_JS, cfg);
  const start = REAL_CONFIG_JS.indexOf('const CONFIG = {');
  const tail = REAL_CONFIG_JS.slice(REAL_CONFIG_JS.indexOf('const cfg'));
  assert.ok(once.startsWith(REAL_CONFIG_JS.slice(0, start)), 'text before the block is untouched');
  assert.ok(once.endsWith(tail), 'text after the block is untouched');
  assert.match(once, /owner: \{ name: "Zoe \} \\"q\\"" \}/);
  assert.match(once, /"generate":true/);
  assert.equal(S.renderConfigJs(once, cfg), once, 'a second pass changes nothing');
  assert.match(S.renderConfigJs(once, S.normalizeConfig(baseConfig())), /"generate":false/, 'a different config replaces the block again');
  assert.ok(/^[\x00-\x7f]*$/.test(S.renderConfigJs(REAL_CONFIG_JS, S.normalizeConfig(baseConfig({ ownerName: 'Zo' + String.fromCharCode(233) })))), 'output stays ASCII');
  assert.throws(() => S.renderConfigJs('nothing here', cfg), /CONFIG/);
});

test('rendered config.js is a loadable module that matches the config', async () => {
  const cfg = S.normalizeConfig(baseConfig({ agents: ['helper'], lanes: 'a,b', modules: { tabs: true } }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-cfg-'));
  const file = path.join(dir, 'config.mjs');
  fs.writeFileSync(file, S.renderConfigJs(REAL_CONFIG_JS, cfg));
  const saved = globalThis.__BOARD_CONFIG__;
  delete globalThis.__BOARD_CONFIG__;
  try {
    const mod = await import(`file://${file.replace(/\\/g, '/')}`);
    assert.equal(mod.cfg.owner.name, 'Alex');
    assert.deepEqual(mod.LANES, ['a', 'b']);
    assert.ok(mod.MODULES.tabs);
    assert.ok(mod.PROXIES.includes('helper'));
  } finally { globalThis.__BOARD_CONFIG__ = saved; }
});

test('buildWranglerToml for workers-dev, custom, access and generate', () => {
  const dev = S.buildWranglerToml(S.normalizeConfig(baseConfig({ databaseId: DB_ID })), 'board.me.workers.dev');
  assert.match(dev, /^name = "board"$/m);
  assert.match(dev, /main = "src\/index.js"/);
  assert.match(dev, /compatibility_date = "2026-07-01"/);
  assert.match(dev, /workers_dev = true/);
  assert.doesNotMatch(dev, /routes =/);
  assert.match(dev, /\[assets\]\ndirectory = "\.\.\/page"\nbinding = "ASSETS"\nrun_worker_first = true/);
  assert.match(dev, /\[\[rules\]\]\ntype = "Text"\nglobs = \["\*\*\/\*\.md"\]\nfallthrough = true/);
  assert.match(dev, new RegExp(`\\[\\[d1_databases\\]\\]\\nbinding = "DB"\\ndatabase_name = "board-db"\\ndatabase_id = "${DB_ID}"`));
  assert.doesNotMatch(dev, /\[ai\]/);
  for (const k of ['AUTH_MODE = "owner-password"', 'API_HOST = "board.me.workers.dev"', 'MCP_HOST = "board.me.workers.dev"', 'MCP_ISSUER = "https://board.me.workers.dev"', 'BOARD_URL = "https://board.me.workers.dev"']) assert.ok(dev.includes(k), k);
  const mods = dev.match(/^BOARD_MODULES = '(.*)'$/m);
  assert.deepEqual(JSON.parse(mods[1]), { start: false, github: false, production: false, generate: false, tabs: false, pulse: false });
  assert.doesNotMatch(dev, /RUN_URL|ACCESS_|GENERATOR_MODEL/);

  const custom = S.buildWranglerToml(S.normalizeConfig(baseConfig({ domain: { mode: 'custom', hostname: 'Board.Example.com' }, runUrl: 'https://hooks.example.com/run/{id}' })), 'board.example.com');
  assert.match(custom, /workers_dev = false/);
  assert.match(custom, /routes = \[\{ pattern = "board\.example\.com", custom_domain = true \}\]/);
  assert.match(custom, /RUN_URL = "https:\/\/hooks\.example\.com\/run\/\{id\}"/);
  assert.ok(custom.indexOf('routes =') < custom.indexOf('[assets]'), 'routes stay above the first table');

  const access = S.buildWranglerToml(S.normalizeConfig(baseConfig({ domain: { mode: 'custom', hostname: 'board.example.com' }, auth: { mode: 'access', accessTeamDomain: 'team.cloudflareaccess.com', accessAud: 'abc', ownerEmail: 'Me@Example.com' } })), 'board.example.com');
  assert.match(access, /AUTH_MODE = "access"/);
  assert.match(access, /ACCESS_TEAM_DOMAIN = "https:\/\/team\.cloudflareaccess\.com"/);
  assert.match(access, /ACCESS_AUD = "abc"/);
  assert.match(access, /EMAIL_PRINCIPALS = '\{"me@example\.com":"owner"\}'/);

  const gen = S.buildWranglerToml(S.normalizeConfig(baseConfig({ modules: { generate: true } })), 'h.workers.dev');
  assert.match(gen, /\[ai\]\nbinding = "AI"/);
  assert.match(gen, /GENERATOR_MODEL = "@cf\//);
  assert.match(gen, /"generate":true/);
});

test('generateSecrets shapes and hashes', () => {
  const s = S.generateSecrets();
  assert.match(s.ownerSecret, /^[A-Za-z0-9_-]{32}$/);
  assert.match(s.signingKey, /^[0-9a-f]{64}$/);
  assert.match(s.bootstrapCode, /^[A-Z2-7]{16}$/);
  assert.equal(s.ownerHash, sha(s.ownerSecret));
  assert.equal(s.bootstrapHash, sha(s.bootstrapCode));
  assert.notEqual(S.generateSecrets().ownerSecret, s.ownerSecret, 'every call is fresh');
  const seen = [];
  S.generateSecrets((n) => { seen.push(n); return Buffer.alloc(n, 1); });
  assert.deepEqual(seen, [24, 32, 10], 'owner secret 24 bytes, key 32 bytes, code 10 bytes (16 base32 chars)');
});

test('missing CLOUDFLARE_API_TOKEN exits 2 with the guidance and touches nothing', async () => {
  const root = kitRoot();
  const before = snapshot(root);
  const f = fakes(root);
  const errs = [];
  const r = await S.runSetup({ root, env: {}, args: S.parseArgs(['--yes']), run: f.run, fetchImpl: f.fetchImpl, log: noop, error: (l) => errs.push(l) });
  assert.equal(r.exitCode, 2);
  const text = errs.join('\n');
  for (const w of ['CLOUDFLARE_API_TOKEN', 'D1', 'Workers Scripts', 'Account Settings', 'Workers Routes']) assert.ok(text.includes(w), w);
  assert.equal(f.runs.length + f.fetches.length, 0);
  assert.deepEqual(snapshot(root), before);
});

test('dry run makes no run or fetch calls and writes no file', async () => {
  const root = kitRoot();
  const before = snapshot(root);
  const f = fakes(root);
  const lines = [];
  const r = await S.runSetup({ root, env: {}, args: S.parseArgs(['--yes', '--dry-run']), run: f.run, fetchImpl: f.fetchImpl, log: (l) => lines.push(l), error: noop });
  assert.equal(r.exitCode, 0);
  assert.equal(f.runs.length, 0);
  assert.equal(f.fetches.length, 0);
  assert.deepEqual(snapshot(root), before);
  const plan = lines.join('\n');
  for (const w of ['CLOUDFLARE_API_TOKEN', 'd1 create', 'd1 execute', 'deploy', 'secret put', 'OWNER_SECRET_HASH', 'first board']) assert.ok(plan.includes(w), w);
  assert.ok(plan.indexOf('d1 create') < plan.indexOf('d1 execute'));
  assert.ok(plan.indexOf('d1 execute') < plan.indexOf('wrangler deploy') || plan.indexOf('d1 execute') < plan.indexOf('Look up'));
  assert.ok(plan.indexOf('Look up') < plan.indexOf('secret put'));
});

test('happy path runs in the documented order and only hashes reach the secret calls', async () => {
  const root = kitRoot({ 'board.config.json': JSON.stringify(baseConfig({ agents: ['helper'] })) });
  const f = fakes(root);
  const lines = [];
  const r = await S.runSetup({
    root, env: { CLOUDFLARE_API_TOKEN: 'cf-token-value' }, args: S.parseArgs(['--config', 'board.config.json', '--yes']),
    run: f.run, fetchImpl: f.fetchImpl, sleep: async () => {}, log: (l) => lines.push(l), error: (l) => lines.push(`ERR ${l}`),
  });
  const text = lines.join('\n');
  assert.equal(r.exitCode, 0, text);

  const printed = text.match(/Owner password \(shown once[^)]*\): (\S+)/);
  assert.ok(printed, 'owner password is printed');
  const ownerSecret = printed[1];
  const code = text.match(/Bootstrap code \(shown once[^)]*\): ([A-Z2-7]{16})/)[1];
  assert.equal(text.split(ownerSecret).length - 1, 1, 'owner password appears once');
  assert.ok(text.includes('https://board.me.workers.dev/mcp'));
  for (const w of ['Claude', 'ChatGPT', 'Cursor', 'Grok', '"agent"']) assert.ok(text.includes(w), w);

  assert.deepEqual(f.log, [
    'npm', 'd1 create', 'd1 execute', 'deploy',
    'secret OWNER_SECRET_HASH', 'secret OAUTH_TOKEN_SIGNING_KEY', 'secret OAUTH_BOOTSTRAP_CODE_HASH',
    'GET /api/v1/health', 'GET /api/v1/config', 'POST /api/v1/login',
    'GET /api/v1/boards', 'PUT /api/v1/boards/main', 'PUT /api/v1/counters/TASK', 'POST /api/v1/counters/TASK/next', 'PUT /api/v1/tasks/<card>',
  ]);

  const puts = f.runs.filter((x) => x.args.includes('secret'));
  const byName = Object.fromEntries(puts.map((x) => [x.args[3], x.o.input]));
  assert.equal(byName.OWNER_SECRET_HASH, sha(ownerSecret));
  assert.equal(byName.OAUTH_BOOTSTRAP_CODE_HASH, sha(code));
  assert.match(byName.OAUTH_TOKEN_SIGNING_KEY, /^[0-9a-f]{64}$/);
  for (const v of Object.values(byName)) { assert.notEqual(v, ownerSecret); assert.notEqual(v, code); }

  const secretsAll = [ownerSecret, code, byName.OAUTH_TOKEN_SIGNING_KEY];
  for (const x of f.runs) {
    const argv = [x.cmd, ...x.args].join(' ');
    for (const s of secretsAll) assert.ok(!argv.includes(s), 'secret in argv');
    for (const s of secretsAll) assert.ok(!JSON.stringify(x.o.env || {}).includes(s), 'secret in env');
    if (!x.args.includes('secret')) assert.equal(x.o.input, undefined, 'only secret put gets stdin');
  }
  for (const x of f.runs.filter((y) => y.cmd !== 'npm')) assert.equal(x.o.cwd, path.join(root, 'worker'));
  const files = snapshot(root);
  for (const [name, body] of Object.entries(files)) for (const s of secretsAll) assert.ok(!body.includes(s), `secret in ${name}`);
  for (const x of f.fetches) if (!x.url.startsWith('https://api.cloudflare.com')) assert.ok(!JSON.stringify(x.init).includes('cf-token-value'), 'the Cloudflare token goes only to the Cloudflare API');

  const put = f.fetches.find((x) => x.url.includes('/api/v1/tasks/'));
  const card = JSON.parse(put.init.body).data;
  assert.equal(card.title, 'Welcome to your board');
  assert.equal(card.kind, 'human');
  assert.equal(card.status, 'todo');
  assert.equal(card.key, 'TASK-1');
  assert.ok(card.note);
  assert.equal(put.init.headers.authorization, `Bearer ${ownerSecret}`);
  const mainBoard = JSON.parse(f.fetches.find((x) => x.url.endsWith('/boards/main')).init.body).data;
  assert.deepEqual([mainBoard.name, mainBoard.prefix, mainBoard.kind, mainBoard.target], ['Main', 'TASK', 'internal', '']);
  assert.match(mainBoard.start, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(mainBoard.milestones.map((m) => m.id), ['plan', 'build', 'review', 'launch']);
  assert.deepEqual(JSON.parse(f.fetches.find((x) => x.url.endsWith('/counters/TASK') && x.method === 'PUT').init.body), { next: 1 });

  const saved = JSON.parse(files['board.config.json']);
  assert.equal(saved.databaseId, DB_ID);
  assert.equal(saved.url, 'https://board.me.workers.dev');
  assert.match(files['worker/wrangler.toml'], new RegExp(DB_ID));
  assert.match(files['worker/wrangler.toml'], /API_HOST = "board\.me\.workers\.dev"/);
  assert.match(files['worker/src/config.js'], /"id":"helper"/);
  assert.ok(f.runs[0].args.includes('--ignore-scripts'));
  assert.ok(f.runs.find((x) => x.args.includes('execute')).args.includes('--remote'));
  assert.equal(f.runs[0].o.env.CLOUDFLARE_ACCOUNT_ID, 'acc1');
});

test('running again keeps the database and the secrets, and rotates only with --rotate', async () => {
  const root = kitRoot({ 'board.config.json': JSON.stringify(baseConfig({ databaseId: DB_ID, url: 'https://board.me.workers.dev' })) });
  withWrangler(root);
  const env = { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'acc1' };
  const f = fakes(root, { boards: [{ id: 'main' }] });
  const lines = [];
  let r = await S.runSetup({ root, env, args: S.parseArgs(['--yes']), run: f.run, fetchImpl: f.fetchImpl, sleep: async () => {}, log: (l) => lines.push(l), error: (l) => lines.push(l) });
  assert.equal(r.exitCode, 0, lines.join('\n'));
  assert.deepEqual(f.log, ['d1 execute', 'deploy', 'GET /api/v1/health', 'GET /api/v1/config']);
  assert.ok(lines.join('\n').includes('Owner password: unchanged'));

  const g = fakes(root, { boards: [{ id: 'main' }] });
  const more = [];
  r = await S.runSetup({ root, env, args: S.parseArgs(['--yes', '--rotate']), run: g.run, fetchImpl: g.fetchImpl, sleep: async () => {}, log: (l) => more.push(l), error: (l) => more.push(l) });
  assert.equal(r.exitCode, 0, more.join('\n'));
  assert.equal(g.log.filter((x) => x.startsWith('secret ')).length, 3);
  assert.ok(!g.log.includes('d1 create'));
  assert.ok(!g.log.includes('PUT /api/v1/boards/main'), 'an existing board is left alone');
});

test('applyConfig rewrites only config.js and wrangler.toml', async () => {
  const root = kitRoot({ 'board.config.json': JSON.stringify(baseConfig({ databaseId: DB_ID, url: 'https://board.me.workers.dev', modules: { tabs: true } })) });
  const before = snapshot(root);
  const r = await S.applyConfig({ root, args: S.parseArgs(['--apply-config']), log: noop, error: noop });
  assert.equal(r.exitCode, 0);
  const after = snapshot(root);
  const changed = Object.keys(after).filter((k) => before[k] !== after[k]).sort();
  assert.deepEqual(changed, ['worker/src/config.js', 'worker/wrangler.toml']);
  assert.match(after['worker/src/config.js'], /"tabs":true/);
});

test('add-agent posts to /tokens with the owner secret and prints the token once', async () => {
  const root = kitRoot({ 'board.config.json': JSON.stringify(baseConfig({ url: 'https://board.me.workers.dev' })) });
  const f = fakes(root);
  const lines = [];
  const r = await S.addAgent({ root, env: { BOARD_OWNER_SECRET: 'the-owner-secret' }, args: S.parseArgs(['add-agent', 'helper', '--board', 'main', '--note', 'laptop']), fetchImpl: f.fetchImpl, log: (l) => lines.push(l), error: (l) => lines.push(l) });
  assert.equal(r.exitCode, 0);
  const call = f.fetches[0];
  assert.equal(call.url, 'https://board.me.workers.dev/api/v1/tokens');
  assert.equal(call.init.headers.authorization, 'Bearer the-owner-secret');
  assert.deepEqual(JSON.parse(call.init.body), { principal: 'helper', board: 'main', note: 'laptop' });
  assert.equal(lines.filter((l) => l === 'bk_abc').length, 1);
  const none = await S.addAgent({ root, env: {}, args: S.parseArgs(['add-agent', 'helper']), fetchImpl: f.fetchImpl, log: noop, error: noop });
  assert.equal(none.exitCode, 2);
});

test('status checks health and config', async () => {
  const root = kitRoot({ 'board.config.json': JSON.stringify(baseConfig({ url: 'https://board.me.workers.dev' })) });
  const f = fakes(root);
  const r = await S.status({ root, env: {}, fetchImpl: f.fetchImpl, log: noop, error: noop });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(f.log, ['GET /api/v1/health', 'GET /api/v1/config']);
});

test('parseDatabaseId reads wrangler output in either form', () => {
  assert.equal(S.parseDatabaseId(`database_id = "${DB_ID}"`), DB_ID);
  assert.equal(S.parseDatabaseId(`"database_id": "${DB_ID.toUpperCase()}"`), DB_ID);
  assert.equal(S.parseDatabaseId('nothing'), '');
});
