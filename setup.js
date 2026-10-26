'use strict';
// Installer for the board kit. Run from the kit root with Node 20 or newer. No npm dependencies of its own.
//
//   node setup.js                                  ask a few questions, then install
//   node setup.js --config board.config.json --yes  no questions (for an agent doing the install)
//   node setup.js --dry-run                         print the plan, make no network call and write no file
//   node setup.js --apply-config                    rewrite worker/src/config.js and worker/wrangler.toml only
//   node setup.js add-agent <principal> [--board id] [--note text]   mint a bearer token (BOARD_OWNER_SECRET)
//   node setup.js status                            health check
//
// The Cloudflare API token is read from the environment only (CLOUDFLARE_API_TOKEN). Every outside call goes
// through run(cmd, args, opts) and fetchImpl, so tests can replace both.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const MODULE_NAMES = ['start', 'github', 'production', 'generate', 'tabs'];
const GENERATOR_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const COMPAT_DATE = '2026-07-01';
const FIRST_BOARD = 'main';
const FIRST_PREFIX = 'TASK';

const DEFAULTS = Object.freeze({
  ownerName: 'Owner',
  agentLabel: 'Agent',
  workerName: 'board',
  databaseName: 'board-db',
  databaseId: '',
  domain: { mode: 'workers-dev', hostname: '' },
  auth: { mode: 'owner-password', accessTeamDomain: '', accessAud: '', ownerEmail: '' },
  agents: [],
  workers: [],
  lanes: ['main'],
  mentionNames: ['agent'],
  githubOrgs: [],
  modules: { start: false, github: false, production: false, generate: false, tabs: false },
  runUrl: '',
});

const TOKEN_HELP = `CLOUDFLARE_API_TOKEN is not set.
Create an API token in the Cloudflare dashboard (My Profile, API Tokens, Create Token, Custom token) with these permissions:
  Account, D1, Edit
  Account, Workers Scripts, Edit
  Account, Account Settings, Read
  For a custom domain also: Zone, Zone, Read and Zone, Workers Routes, Edit (on the zone you will use)
Then put it in your environment yourself, never in chat or in a file:
  macOS or Linux:  export CLOUDFLARE_API_TOKEN=...
  PowerShell:      $env:CLOUDFLARE_API_TOKEN = "..."
If your login has more than one Cloudflare account, also set CLOUDFLARE_ACCOUNT_ID.
Run this command again when the token is set.`;

// ----------------------------------------------------------------------------------------------- helpers

const sha256Hex = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function base32(buf, length) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out.slice(0, length);
}

// Fresh secrets. Only the hashes (and the signing key, which the Worker needs as is) are ever sent to Cloudflare.
function generateSecrets(randomBytes = crypto.randomBytes) {
  const ownerSecret = b64url(randomBytes(24));
  const signingKey = Buffer.from(randomBytes(32)).toString('hex');
  const bootstrapCode = base32(randomBytes(10), 16);
  return { ownerSecret, ownerHash: sha256Hex(ownerSecret), signingKey, bootstrapCode, bootstrapHash: sha256Hex(bootstrapCode) };
}

function parseArgs(argv) {
  const out = { command: 'setup', config: '', yes: false, dryRun: false, applyConfig: false, rotate: false, board: '', note: '', principal: '', help: false, errors: [] };
  const args = Array.isArray(argv) ? argv : [];
  const need = (i, flag) => { if (i + 1 >= args.length || String(args[i + 1]).startsWith('--')) { out.errors.push(`${flag} needs a value`); return ''; } return args[i + 1]; };
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--config') { out.config = need(i, a); i++; }
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--apply-config') out.applyConfig = true;
    else if (a === '--rotate') out.rotate = true;
    else if (a === '--board') { out.board = need(i, a); i++; }
    else if (a === '--note') { out.note = need(i, a); i++; }
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) out.errors.push(`unknown option ${a}`);
    else if (a === 'add-agent' && out.command === 'setup') out.command = 'add-agent';
    else if (a === 'status' && out.command === 'setup') out.command = 'status';
    else if (out.command === 'add-agent' && !out.principal) out.principal = a;
    else out.errors.push(`unexpected argument ${a}`);
  }
  if (out.applyConfig && out.command === 'setup') out.command = 'apply-config';
  if (out.command === 'add-agent' && !out.principal) out.errors.push('add-agent needs a principal name, for example: node setup.js add-agent agent');
  return out;
}

const ID_RE = /^[a-z][a-z0-9-]{0,30}$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const ORG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? v.split(',') : []).map((x) => (typeof x === 'string' ? x.trim() : x)).filter((x) => x !== '');
const uniq = (a) => [...new Set(a)];

// Fills every default, checks every value, and returns a clean copy. Throws an Error with a plain message.
function normalizeConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const c = {
    ownerName: String(r.ownerName === undefined ? DEFAULTS.ownerName : r.ownerName).trim(),
    agentLabel: String(r.agentLabel === undefined ? DEFAULTS.agentLabel : r.agentLabel).trim(),
    workerName: String(r.workerName || DEFAULTS.workerName).trim(),
    databaseName: String(r.databaseName || DEFAULTS.databaseName).trim(),
    databaseId: String(r.databaseId || '').trim(),
    domain: { mode: (r.domain && r.domain.mode) || DEFAULTS.domain.mode, hostname: String((r.domain && r.domain.hostname) || '').trim().toLowerCase() },
    auth: {
      mode: (r.auth && r.auth.mode) || DEFAULTS.auth.mode,
      accessTeamDomain: String((r.auth && r.auth.accessTeamDomain) || '').trim(),
      accessAud: String((r.auth && r.auth.accessAud) || '').trim(),
      ownerEmail: String((r.auth && r.auth.ownerEmail) || '').trim().toLowerCase(),
    },
    agents: list(r.agents === undefined ? DEFAULTS.agents : r.agents).map((a) => (typeof a === 'string' ? { id: a, label: a } : { id: String(a && a.id || '').trim(), label: String(a && (a.label || a.id) || '').trim() })),
    workers: uniq(list(r.workers === undefined ? DEFAULTS.workers : r.workers).map((w) => (typeof w === 'string' ? w : String(w && w.id || '')))),
    lanes: uniq(list(r.lanes === undefined ? DEFAULTS.lanes : r.lanes).map(String)),
    mentionNames: uniq(list(r.mentionNames === undefined ? DEFAULTS.mentionNames : r.mentionNames).map(String)),
    githubOrgs: uniq(list(r.githubOrgs === undefined ? DEFAULTS.githubOrgs : r.githubOrgs).map(String)),
    modules: Object.fromEntries(MODULE_NAMES.map((m) => [m, Boolean(r.modules && r.modules[m])])),
    runUrl: String(r.runUrl || '').trim(),
    roles: uniq(list(r.roles === undefined ? ['reviewer'] : r.roles).map(String)),
    admins: uniq(list(r.admins).map(String)),
    scopedWorkers: uniq(list(r.scopedWorkers).map(String)),
  };
  if (r.url) c.url = String(r.url).trim().replace(/\/+$/, '');
  const bad = (msg) => { throw new Error(msg); };
  if (!c.ownerName || c.ownerName.length > 60 || /[\u0000-\u001f]/.test(c.ownerName)) bad('ownerName must be 1 to 60 plain characters');
  if (!c.agentLabel || c.agentLabel.length > 60 || /[\u0000-\u001f]/.test(c.agentLabel)) bad('agentLabel must be 1 to 60 plain characters');
  if (!NAME_RE.test(c.workerName)) bad('workerName may use lower case letters, digits and hyphens only');
  if (!NAME_RE.test(c.databaseName)) bad('databaseName may use lower case letters, digits and hyphens only');
  if (c.databaseId && !/^[0-9a-f-]{36}$/i.test(c.databaseId)) bad('databaseId must be the id Cloudflare printed when the database was created, or empty');
  if (!['workers-dev', 'custom'].includes(c.domain.mode)) bad('domain.mode must be workers-dev or custom');
  if (c.domain.mode === 'custom' && !HOST_RE.test(c.domain.hostname)) bad('domain.hostname must be a host name on a zone in your Cloudflare account, for example board.example.com');
  if (!['owner-password', 'access'].includes(c.auth.mode)) bad('auth.mode must be owner-password or access');
  if (c.auth.mode === 'access') {
    if (c.domain.mode !== 'custom') bad('auth.mode access needs a custom domain');
    if (!c.auth.accessTeamDomain || !c.auth.accessAud || !c.auth.ownerEmail) bad('auth.mode access needs accessTeamDomain, accessAud and ownerEmail');
    c.auth.accessTeamDomain = c.auth.accessTeamDomain.replace(/\/+$/, '');
    if (!/^https:\/\//.test(c.auth.accessTeamDomain)) c.auth.accessTeamDomain = `https://${c.auth.accessTeamDomain}`;
  }
  for (const a of c.agents) if (!ID_RE.test(a.id) || a.id === 'owner' || a.id === 'agent') bad(`agent id ${JSON.stringify(a.id)} must be lower case letters, digits and hyphens, and not owner or agent (those two always exist)`);
  for (const w of c.workers) if (!ID_RE.test(w) || w === 'owner' || w === 'agent') bad(`worker id ${JSON.stringify(w)} must be lower case letters, digits and hyphens, and not owner or agent`);
  for (const l of [...c.lanes, ...c.mentionNames, ...c.roles, ...c.admins, ...c.scopedWorkers]) if (!ID_RE.test(l)) bad(`${JSON.stringify(l)} must be lower case letters, digits and hyphens`);
  if (!c.lanes.length) c.lanes = ['main'];
  for (const o of c.githubOrgs) if (!ORG_RE.test(o)) bad(`githubOrgs entry ${JSON.stringify(o)} is not a GitHub organization or user name`);
  if (c.runUrl && !/^https:\/\/\S+$/.test(c.runUrl)) bad('runUrl must start with https://');
  return c;
}

// ----------------------------------------------------------------------------------------------- config.js

const asciiJson = (v) => JSON.stringify(v).replace(/[^\u0000-\u007e]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);

// Index of the "}" that closes the "{" at openIndex, skipping strings and comments. -1 when there is none.
function matchingBrace(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (ch === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); if (end < 0) return -1; i = end + 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function configBlock(config) {
  const j = asciiJson;
  const agents = config.agents.map((a) => ({ id: a.id, label: a.label || a.id }));
  return [
    'const CONFIG = {',
    '  // Written by setup.js from board.config.json. Change board.config.json, then run: node setup.js --apply-config',
    `  owner: { name: ${j(config.ownerName)} },`,
    `  agent: { label: ${j(config.agentLabel)} },`,
    `  agents: ${j(agents)},`,
    `  workers: ${j(config.workers)},`,
    `  scopedWorkers: ${j(config.scopedWorkers)},`,
    `  admins: ${j(config.admins)},`,
    `  mentionNames: ${j(config.mentionNames)},`,
    `  lanes: ${j(config.lanes)},`,
    `  roles: ${j(config.roles)},`,
    `  githubOrgs: ${j(config.githubOrgs)},`,
    `  modules: ${j(config.modules)},`,
    '};',
  ].join('\n');
}

// Pure. Replaces only the CONFIG block of worker/src/config.js and keeps every other byte. Same input, same output.
function renderConfigJs(existingText, config) {
  const text = String(existingText);
  const start = text.indexOf('const CONFIG = {');
  if (start < 0 || text.indexOf('const CONFIG = {', start + 1) >= 0) throw new Error('worker/src/config.js does not hold exactly one "const CONFIG = {" block');
  const close = matchingBrace(text, start + 'const CONFIG = '.length);
  if (close < 0 || text[close + 1] !== ';') throw new Error('could not find the end of the CONFIG block in worker/src/config.js');
  return text.slice(0, start) + configBlock(config) + text.slice(close + 2);
}

// ----------------------------------------------------------------------------------------------- wrangler.toml

const tomlStr = (s) => JSON.stringify(String(s)).replace(/[^\u0000-\u007e]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);

// host is the public host name of the board. Pure.
function buildWranglerToml(config, host) {
  const c = config;
  const lines = [
    '# Written by setup.js from board.config.json. Change the config and run: node setup.js --apply-config',
    `name = ${tomlStr(c.workerName)}`,
    'main = "src/index.js"',
    `compatibility_date = ${tomlStr(COMPAT_DATE)}`,
  ];
  if (c.domain.mode === 'workers-dev') lines.push('workers_dev = true');
  else lines.push('workers_dev = false', `routes = [{ pattern = ${tomlStr(c.domain.hostname)}, custom_domain = true }]`);
  lines.push(
    '',
    '[assets]',
    'directory = "../page"',
    'binding = "ASSETS"',
    'run_worker_first = true',
    '',
    '[[rules]]',
    'type = "Text"',
    'globs = ["**/*.md"]',
    'fallthrough = true',
    '',
    '[[d1_databases]]',
    'binding = "DB"',
    `database_name = ${tomlStr(c.databaseName)}`,
    `database_id = ${tomlStr(c.databaseId)}`,
  );
  if (c.modules.generate) lines.push('', '[ai]', 'binding = "AI"');
  const url = `https://${host}`;
  lines.push(
    '',
    '[vars]',
    `AUTH_MODE = ${tomlStr(c.auth.mode)}`,
    `API_HOST = ${tomlStr(host)}`,
    `MCP_HOST = ${tomlStr(host)}`,
    `MCP_ISSUER = ${tomlStr(url)}`,
    `BOARD_URL = ${tomlStr(url)}`,
    `BOARD_MODULES = '${JSON.stringify(c.modules)}'`,
  );
  if (c.modules.generate) lines.push(`GENERATOR_MODEL = ${tomlStr(GENERATOR_MODEL)}`);
  if (c.auth.mode === 'access') {
    lines.push(
      `ACCESS_TEAM_DOMAIN = ${tomlStr(c.auth.accessTeamDomain)}`,
      `ACCESS_AUD = ${tomlStr(c.auth.accessAud)}`,
      `EMAIL_PRINCIPALS = '${JSON.stringify({ [c.auth.ownerEmail]: 'owner' })}'`,
    );
  }
  if (c.runUrl) lines.push(`RUN_URL = ${tomlStr(c.runUrl)}`);
  return `${lines.join('\n')}\n`;
}

// ----------------------------------------------------------------------------------------------- plan

function buildPlan(config, opts = {}) {
  const c = config;
  const rotate = Boolean(opts.rotate);
  const first = !c.databaseId;
  const access = c.auth.mode === 'access';
  const secretNames = access ? ['OAUTH_TOKEN_SIGNING_KEY', 'OAUTH_BOOTSTRAP_CODE_HASH'] : ['OWNER_SECRET_HASH', 'OAUTH_TOKEN_SIGNING_KEY', 'OAUTH_BOOTSTRAP_CODE_HASH'];
  const newSecrets = first || rotate;
  const steps = [
    'Check that CLOUDFLARE_API_TOKEN is set in the environment (it is never asked for)',
    'Write board.config.json',
  ];
  if (newSecrets) steps.push(access ? 'Generate a signing key and a bootstrap code with node:crypto' : 'Generate an owner password, a signing key and a bootstrap code with node:crypto (shown once, stored only as hashes where possible)');
  steps.push(
    'Write worker/src/config.js (only the CONFIG block) and worker/wrangler.toml',
    'Install the pinned wrangler with npm if node_modules is missing',
    first ? `wrangler d1 create ${c.databaseName}` : `Skip d1 create (databaseId is already ${c.databaseId})`,
    `wrangler d1 execute ${c.databaseName} --remote --file schema.sql (safe to repeat)`,
    c.domain.mode === 'custom' ? `wrangler deploy to https://${c.domain.hostname}` : 'Look up the workers.dev address, then wrangler deploy',
  );
  steps.push(newSecrets ? `wrangler secret put ${secretNames.join(', ')} (value on stdin only)` : 'Keep the existing secrets (use --rotate to replace them)');
  steps.push('Smoke checks: GET /api/v1/health, GET /api/v1/config');
  if (!access && newSecrets) steps.push('Sign in with the owner password, create the first board, seed its counter, take a number, add a welcome card');
  steps.push('Print the board address, the owner password once, the MCP address, the bootstrap code once, and connector paste blocks');
  return steps;
}

// ----------------------------------------------------------------------------------------------- default I/O

function defaultRun(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const win = process.platform === 'win32' && cmd === 'npm';
    const child = spawn(win ? 'npm.cmd' : cmd, args, { cwd: opts.cwd, env: opts.env || process.env, shell: win, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: String(err && err.message) }));
    child.on('close', (code) => resolve({ code: code === null ? 1 : code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input === undefined ? '' : String(opts.input));
  });
}

function makeAsker() {
  const readline = require('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question, def) => new Promise((resolve) => {
    rl.question(def === undefined || def === '' ? `${question}: ` : `${question} [${def}]: `, (ans) => resolve(ans.trim() === '' ? def : ans.trim()));
  });
  ask.close = () => rl.close();
  return ask;
}

async function askForConfig(ask, base) {
  const yn = async (q, def) => /^y/i.test(String(await ask(`${q} (y/n)`, def ? 'y' : 'n')));
  const b = normalizeConfig(base);
  const ownerName = await ask('Your name, shown on the board', b.ownerName);
  const agentLabel = await ask('What do you call your AI agent', b.agentLabel);
  const workerName = await ask('Worker name (lower case, unique in your Cloudflare account)', b.workerName);
  const databaseName = await ask('D1 database name', b.databaseName);
  const mode = await ask('Address: workers-dev (free *.workers.dev) or custom (your own domain)', b.domain.mode);
  const hostname = mode === 'custom' ? await ask('Host name on your zone, for example board.example.com', b.domain.hostname) : '';
  const authMode = await ask('Sign in with owner-password or access (Cloudflare Access)', b.auth.mode);
  let auth = { ...b.auth, mode: authMode };
  if (authMode === 'access') {
    auth = {
      mode: authMode,
      accessTeamDomain: await ask('Access team domain, for example https://myteam.cloudflareaccess.com', b.auth.accessTeamDomain),
      accessAud: await ask('Access application AUD tag', b.auth.accessAud),
      ownerEmail: await ask('Your Access email', b.auth.ownerEmail),
    };
  }
  const agents = (await ask('Extra agent connector names, comma separated (blank for none)', b.agents.map((a) => a.id).join(','))) || '';
  const lanes = await ask('Lanes agent cards can sit in, comma separated', b.lanes.join(','));
  const modules = {};
  modules.start = await yn('Turn on the Start module (wakes an agent runner through a webhook)', b.modules.start);
  modules.github = await yn('Turn on the GitHub module (pull request links and merge checks)', b.modules.github);
  modules.production = await yn('Turn on the Production module (deploy approvals)', b.modules.production);
  modules.generate = await yn('Turn on the Generate module (needs Workers AI)', b.modules.generate);
  modules.tabs = await yn('Turn on the Tabs module (more than one board)', b.modules.tabs);
  const githubOrgs = modules.github ? await ask('GitHub organizations or users, comma separated', b.githubOrgs.join(',')) : '';
  const runUrl = modules.start ? await ask('Run webhook address (https://..., blank to skip)', b.runUrl) : '';
  return normalizeConfig({ ...base, ownerName, agentLabel, workerName, databaseName, domain: { mode, hostname }, auth, agents, lanes, modules, githubOrgs, runUrl });
}

// ----------------------------------------------------------------------------------------------- connectors

function pasteBlocks(url, code) {
  const mcp = `${url}/mcp`;
  const pick = `On the page that opens, pick the connector name "agent" and enter the bootstrap code ${code}.`;
  return [
    '',
    'Connector paste blocks. Give the right one to the person.',
    '',
    'Claude (claude.ai or the desktop app)',
    '  Settings, Connectors, Add custom connector.',
    `  Name: Board.  Remote MCP server URL: ${mcp}`,
    `  ${pick}`,
    '',
    'ChatGPT',
    '  Settings, Apps and Connectors, Advanced, turn on developer mode, then Create.',
    `  Name: Board.  MCP server URL: ${mcp}.  Authentication: OAuth.`,
    `  ${pick}`,
    '',
    'Cursor (mcp.json)',
    `  { "mcpServers": { "board": { "url": "${mcp}" } } }`,
    `  Cursor opens the same consent page. ${pick}`,
    '',
    'Grok',
    '  Connectors, add a custom connector.',
    `  MCP server URL: ${mcp}`,
    `  ${pick}`,
  ];
}

// ----------------------------------------------------------------------------------------------- the run

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSetup(options = {}) {
  const o = options;
  const root = o.root || __dirname;
  const env = o.env || process.env;
  const run = o.run || defaultRun;
  const fetchImpl = o.fetchImpl || ((...a) => fetch(...a));
  const sleep = o.sleep || delay;
  const randomBytes = o.randomBytes || crypto.randomBytes;
  const outLines = [];
  const out = (line = '') => { outLines.push(String(line)); (o.log || console.log)(String(line)); };
  const err = (line = '') => { outLines.push(String(line)); (o.error || console.error)(String(line)); };
  const args = o.args || parseArgs([]);
  const configPath = path.join(root, args.config || 'board.config.json');
  const workerDir = path.join(root, 'worker');
  const configJsPath = path.join(workerDir, 'src', 'config.js');
  const tomlPath = path.join(workerDir, 'wrangler.toml');
  const wranglerJs = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const result = (exitCode) => ({ exitCode, output: outLines.join('\n') });
  const writeJson = (file, obj) => fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
  const readConfigFile = () => (fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : null);

  try {
    // 1. Settings.
    let config;
    const stored = readConfigFile();
    if (args.config && !stored) { err(`Config file not found: ${args.config}`); return result(1); }
    if (args.config || args.yes || (args.dryRun && stored)) config = normalizeConfig(stored || {});
    else config = null;

    // The token comes before any question so a missing token fails fast. A dry run needs none.
    const token = env.CLOUDFLARE_API_TOKEN;
    if (!args.dryRun && !token) { err(TOKEN_HELP); return result(2); }

    if (!config) {
      const ask = o.ask || makeAsker();
      try { config = await askForConfig(ask, stored || {}); } finally { if (ask.close) ask.close(); }
    }

    // 2. The plan.
    const plan = buildPlan(config, { rotate: args.rotate });
    if (args.dryRun) {
      out('Plan (dry run, nothing was written or called):');
      plan.forEach((s, i) => out(`  ${i + 1}. ${s}`));
      return result(0);
    }

    const first = !config.databaseId;
    const newSecrets = first || args.rotate;
    const access = config.auth.mode === 'access';
    const childEnv = { ...env };

    out('Step 1: write board.config.json');
    writeJson(configPath, config);

    const secrets = newSecrets ? generateSecrets(randomBytes) : null;
    if (secrets) out('Step 2: secrets generated');

    // 3. Local files.
    out('Step 3: write worker/src/config.js and worker/wrangler.toml');
    fs.writeFileSync(configJsPath, renderConfigJs(fs.readFileSync(configJsPath, 'utf8'), config));

    // Account id: from the environment, else the one account the token can see.
    const cf = async (urlPath) => {
      const res = await fetchImpl(`https://api.cloudflare.com/client/v4${urlPath}`, { headers: { authorization: `Bearer ${token}` } });
      if (!res || !res.ok) return null;
      return res.json();
    };
    let accountId = env.CLOUDFLARE_ACCOUNT_ID || '';
    if (!accountId) {
      const accounts = await cf('/accounts');
      const found = accounts && Array.isArray(accounts.result) ? accounts.result : [];
      if (found.length === 1) accountId = found[0].id;
      else if (found.length > 1) { err('This token can see more than one Cloudflare account. Set CLOUDFLARE_ACCOUNT_ID to the one to use and run this again.'); return result(1); }
    }
    if (accountId) childEnv.CLOUDFLARE_ACCOUNT_ID = accountId;

    // The public host name.
    let host = '';
    if (config.domain.mode === 'custom') host = config.domain.hostname;
    else if (accountId) {
      const sub = await cf(`/accounts/${accountId}/workers/subdomain`);
      const name = sub && sub.result && sub.result.subdomain;
      if (name) host = `${config.workerName}.${name}.workers.dev`;
    }
    let discover = false;
    if (!host) { host = `${config.workerName}.workers.dev`; discover = true; }
    fs.writeFileSync(tomlPath, buildWranglerToml(config, host));

    // 4. wrangler.
    const hasBin = () => fs.existsSync(wranglerJs);
    if (!hasBin()) {
      out('Step 4: install the pinned wrangler (npm, scripts off)');
      const hasLock = fs.existsSync(path.join(root, 'package-lock.json'));
      const r = await run('npm', hasLock ? ['ci', '--ignore-scripts'] : ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, env: childEnv });
      if (r.code !== 0 || !hasBin()) { err(`npm could not install wrangler (exit ${r.code}). ${String(r.stderr || '').trim().slice(0, 400)}`); return result(1); }
    }
    const wr = (wargs, extra = {}) => run(process.execPath, [wranglerJs, ...wargs], { cwd: workerDir, env: childEnv, ...extra });
    const fail = (what, r) => { err(`${what} failed (exit ${r.code}).`); const tail = `${r.stderr || ''}\n${r.stdout || ''}`.trim().split('\n').slice(-12).join('\n'); if (tail) err(tail); return result(1); };

    if (first) {
      out(`Step 5: create the D1 database ${config.databaseName}`);
      const r = await wr(['d1', 'create', config.databaseName]);
      const text = `${r.stdout || ''}\n${r.stderr || ''}`;
      if (r.code !== 0) {
        if (/already exists/i.test(text)) { err(`A D1 database named ${config.databaseName} already exists in this account. Pick another databaseName in board.config.json, or set databaseId to the existing database's id if it is yours and empty, then run again.`); return result(1); }
        return fail('wrangler d1 create', r);
      }
      const id = parseDatabaseId(text);
      if (!id) { err('wrangler created the database but its id could not be read from the output. Set databaseId in board.config.json and run again.'); return result(1); }
      config.databaseId = id;
      writeJson(configPath, config);
      fs.writeFileSync(tomlPath, buildWranglerToml(config, host));
    } else out(`Step 5: keep the D1 database ${config.databaseName} (${config.databaseId})`);

    out('Step 6: apply the schema');
    let r = await wr(['d1', 'execute', config.databaseName, '--remote', '--file', 'schema.sql']);
    if (r.code !== 0) return fail('wrangler d1 execute', r);

    out('Step 7: deploy the Worker');
    r = await wr(['deploy']);
    if (r.code !== 0) return fail('wrangler deploy', r);
    if (discover) {
      const m = `${r.stdout || ''}\n${r.stderr || ''}`.match(/https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev)/i);
      if (!m) { err('The Worker deployed, but its workers.dev address could not be read from the output. Set domain to custom, or read the address in the dashboard and ask for help.'); return result(1); }
      host = m[1].toLowerCase();
      fs.writeFileSync(tomlPath, buildWranglerToml(config, host));
      out('Step 7b: deploy again with the real address');
      r = await wr(['deploy']);
      if (r.code !== 0) return fail('wrangler deploy', r);
    }
    const url = `https://${host}`;
    config.url = url;
    writeJson(configPath, config);

    // 5. Secrets, value on stdin only.
    if (secrets) {
      out('Step 8: store the secrets');
      const toPut = access
        ? [['OAUTH_TOKEN_SIGNING_KEY', secrets.signingKey], ['OAUTH_BOOTSTRAP_CODE_HASH', secrets.bootstrapHash]]
        : [['OWNER_SECRET_HASH', secrets.ownerHash], ['OAUTH_TOKEN_SIGNING_KEY', secrets.signingKey], ['OAUTH_BOOTSTRAP_CODE_HASH', secrets.bootstrapHash]];
      for (const [name, value] of toPut) {
        r = await wr(['secret', 'put', name], { input: value });
        if (r.code !== 0) return fail(`wrangler secret put ${name}`, r);
      }
    } else out('Step 8: secrets kept as they are');

    // 6. Smoke checks.
    out('Step 9: check the board is answering');
    let healthy = false;
    for (let i = 0; i < 12 && !healthy; i++) {
      try { const res = await fetchImpl(`${url}/api/v1/health`); healthy = Boolean(res && res.status === 200); } catch { healthy = false; }
      if (!healthy) await sleep(5000);
    }
    if (!healthy) { err(`${url}/api/v1/health did not answer 200. A new custom domain can take a few minutes. Run: node setup.js status`); return result(1); }
    const cfgRes = await fetchImpl(`${url}/api/v1/config`);
    if (!cfgRes || cfgRes.status !== 200) { err(`${url}/api/v1/config did not answer 200.`); return result(1); }

    let seeded = false;
    if (secrets && !access) {
      const login = await fetchImpl(`${url}/api/v1/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: secrets.ownerSecret }) });
      if (!login || login.status !== 200) { err('Signing in with the new owner password failed. The secrets may not have reached the Worker yet. Run this again with --rotate.'); return result(1); }
      const authHeaders = { authorization: `Bearer ${secrets.ownerSecret}`, 'content-type': 'application/json' };
      const call = async (method, p, body) => {
        const res = await fetchImpl(`${url}/api/v1${p}`, { method, headers: authHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = res && res.text ? await res.text() : '';
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        return { status: res ? res.status : 0, json };
      };
      const boards = await call('GET', '/boards');
      const have = boards.json && Array.isArray(boards.json.boards) && boards.json.boards.some((b) => b.id === FIRST_BOARD);
      if (have) out('Step 10: the first board already exists, left as it is');
      else {
        out('Step 10: create the first board and a welcome card');
        let x = await call('PUT', `/boards/${FIRST_BOARD}`, { data: { name: 'Main', prefix: FIRST_PREFIX } });
        if (x.status !== 200) { err(`Creating the board failed (HTTP ${x.status}).`); return result(1); }
        x = await call('PUT', `/counters/${FIRST_PREFIX}`, { next: 1 });
        if (x.status !== 200) { err(`Seeding the counter failed (HTTP ${x.status}).`); return result(1); }
        x = await call('POST', `/counters/${FIRST_PREFIX}/next`);
        const number = x.json && x.json.number;
        if (x.status !== 200 || !Number.isInteger(number)) { err(`Taking a ticket number failed (HTTP ${x.status}).`); return result(1); }
        const at = new Date().toISOString();
        const key = `${FIRST_PREFIX}-${number}`;
        const card = {
          board: FIRST_BOARD, key, num: number, title: 'Welcome to your board', status: 'todo', kind: 'human', lane: '', owner: 'owner',
          note: 'This is your first card. Ask your agent to read the handbook, then add a card of its own.',
          link: '', needsOwner: false, waitingOn: '', created: at, updated: at, updatedBy: 'owner',
          history: [{ at, by: 'owner', what: 'created by setup' }],
        };
        const id = `t-${at.slice(0, 10).replace(/-/g, '')}-${FIRST_PREFIX.toLowerCase()}-${number}-welcome-to-your-board`;
        x = await call('PUT', `/tasks/${id}`, { data: card });
        if (x.status !== 200) { err(`Creating the welcome card failed (HTTP ${x.status}).`); return result(1); }
        seeded = true;
      }
    }

    // 7. Hand over.
    out('');
    out('Your board is ready.');
    out(`Board address: ${url}`);
    if (secrets && !access) {
      out(`Owner password (shown once, write it down now): ${secrets.ownerSecret}`);
    } else if (access) out('Sign in: through Cloudflare Access with your own email. There is no owner password in this mode.');
    else out('Owner password: unchanged. It is not stored anywhere readable. Run with --rotate to make a new one.');
    out(`MCP address: ${url}/mcp`);
    if (secrets) {
      out(`Bootstrap code (shown once, for the connector consent page): ${secrets.bootstrapCode}`);
      pasteBlocks(url, secrets.bootstrapCode).forEach((l) => out(l));
    } else out('Bootstrap code: unchanged. Run with --rotate to make a new one.');
    if (access) out('\nAccess needs bypass rules for /mcp, /oauth/ and /.well-known/ on this host, and a first board made from the page. See SETUP.md.');
    if (seeded) out('\nThe first board, the TASK counter and a welcome card were created.');
    return result(0);
  } catch (e) {
    err(`setup stopped: ${e && e.message ? e.message : e}`);
    return result(1);
  }
}

function parseDatabaseId(text) {
  const named = String(text).match(/database_id["'\s:=]+["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (named) return named[1].toLowerCase();
  const any = String(text).match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
  return any ? any[1].toLowerCase() : '';
}

// Rewrites worker/src/config.js and worker/wrangler.toml from board.config.json. Nothing else.
async function applyConfig(options = {}) {
  const root = options.root || __dirname;
  const out = options.log || console.log;
  const err = options.error || console.error;
  const file = path.join(root, options.args && options.args.config ? options.args.config : 'board.config.json');
  try {
    if (!fs.existsSync(file)) { err('board.config.json not found. Run node setup.js first.'); return { exitCode: 1 }; }
    const config = normalizeConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    const host = config.domain.mode === 'custom' ? config.domain.hostname : (config.url ? new URL(config.url).host : '');
    if (!host) { err('The board address is not known yet. Run node setup.js once so it can be recorded.'); return { exitCode: 1 }; }
    if (!config.databaseId) { err('databaseId is empty. Run node setup.js first.'); return { exitCode: 1 }; }
    const configJs = path.join(root, 'worker', 'src', 'config.js');
    fs.writeFileSync(configJs, renderConfigJs(fs.readFileSync(configJs, 'utf8'), config));
    fs.writeFileSync(path.join(root, 'worker', 'wrangler.toml'), buildWranglerToml(config, host));
    out('Rewrote worker/src/config.js and worker/wrangler.toml. Deploy with: cd worker && ../node_modules/.bin/wrangler deploy');
    return { exitCode: 0 };
  } catch (e) {
    err(`apply-config stopped: ${e && e.message ? e.message : e}`);
    return { exitCode: 1 };
  }
}

function boardUrl(root, env) {
  if (env.BOARD_URL) return String(env.BOARD_URL).replace(/\/+$/, '');
  const file = path.join(root, 'board.config.json');
  if (fs.existsSync(file)) {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c.url) return String(c.url).replace(/\/+$/, '');
    if (c.domain && c.domain.mode === 'custom' && c.domain.hostname) return `https://${c.domain.hostname}`;
  }
  return '';
}

async function addAgent(options = {}) {
  const root = options.root || __dirname;
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || ((...a) => fetch(...a));
  const out = options.log || console.log;
  const err = options.error || console.error;
  const args = options.args;
  const secret = env.BOARD_OWNER_SECRET;
  if (!secret) { err('Set BOARD_OWNER_SECRET to the owner password in your environment, then run this again.'); return { exitCode: 2 }; }
  const url = boardUrl(root, env);
  if (!url) { err('The board address is not known. Run node setup.js first, or set BOARD_URL.'); return { exitCode: 1 }; }
  const body = { principal: args.principal };
  if (args.board) body.board = args.board;
  if (args.note) body.note = args.note;
  const res = await fetchImpl(`${url}/api/v1/tokens`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = res && res.text ? await res.text() : '';
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res || res.status !== 200 || !json || !json.token) { err(`The board refused: HTTP ${res ? res.status : 0} ${json && json.error ? json.error : ''}`.trim()); return { exitCode: 1 }; }
  out(`Token for ${json.principal}${json.board ? ` on board ${json.board}` : ''} (shown once, copy it now):`);
  out(json.token);
  out('Send it as the header Authorization: Bearer <token>. Agents that use the MCP connector do not need it.');
  return { exitCode: 0 };
}

async function status(options = {}) {
  const root = options.root || __dirname;
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || ((...a) => fetch(...a));
  const out = options.log || console.log;
  const err = options.error || console.error;
  const url = boardUrl(root, env);
  if (!url) { err('The board address is not known. Run node setup.js first, or set BOARD_URL.'); return { exitCode: 1 }; }
  let ok = true;
  for (const p of ['/api/v1/health', '/api/v1/config']) {
    try { const res = await fetchImpl(`${url}${p}`); out(`${p}: ${res.status}`); if (res.status !== 200) ok = false; } catch (e) { out(`${p}: no answer (${e && e.message})`); ok = false; }
  }
  out(ok ? `The board at ${url} is answering.` : `The board at ${url} is not answering as expected.`);
  return { exitCode: ok ? 0 : 1 };
}

async function main(argv, options = {}) {
  const args = parseArgs(argv);
  const err = options.error || console.error;
  if (args.help) {
    (options.log || console.log)('Usage: node setup.js [--config file] [--yes] [--dry-run] [--rotate] | --apply-config | add-agent <principal> [--board id] [--note text] | status');
    return 0;
  }
  if (args.errors.length) { args.errors.forEach((e) => err(e)); return 1; }
  const base = { ...options, args };
  if (args.command === 'apply-config') return (await applyConfig(base)).exitCode;
  if (args.command === 'add-agent') return (await addAgent(base)).exitCode;
  if (args.command === 'status') return (await status(base)).exitCode;
  return (await runSetup(base)).exitCode;
}

module.exports = {
  DEFAULTS, MODULE_NAMES, TOKEN_HELP,
  parseArgs, normalizeConfig, renderConfigJs, buildWranglerToml, buildPlan, generateSecrets, sha256Hex, base32, parseDatabaseId,
  matchingBrace, pasteBlocks, runSetup, applyConfig, addAgent, status, main,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
