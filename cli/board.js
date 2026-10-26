#!/usr/bin/env node
'use strict';

// Board CLI for any agent that can run Node. It calls the board API with BOARD_TOKEN (the owner secret or an agent token).
//
//   node cli/board.js health
//   node cli/board.js list [--board x] [--status y] [--kind k] [--lane l] [--json]
//   node cli/board.js get <KEY>
//   node cli/board.js set <KEY> --file card.json [--id t-...] [--if-version n]
//   node cli/board.js patch <KEY> --file patch.json --if-version n
//   node cli/board.js next <PREFIX>
//
// set replaces the whole card; when the card exists, --if-version must be its current version.
// Environment: BOARD_URL (the board address, default http://127.0.0.1:8787) and BOARD_TOKEN.

const fs = require('node:fs');
const { call } = require('./client');

const USAGE = `usage:
  board.js health
  board.js list [--board x] [--status y] [--kind k] [--lane l] [--json]
  board.js get <KEY>
  board.js set <KEY> --file card.json [--id t-...] [--if-version n]
  board.js patch <KEY> --file patch.json --if-version n
  board.js next <PREFIX>`;

const VALUE_FLAGS = ['--board', '--status', '--kind', '--lane', '--file', '--id', '--if-version'];
const BOOL_FLAGS = ['--json'];

function parseArgs(argv) {
  const out = { cmd: argv[0], positional: [], flags: {} };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (VALUE_FLAGS.includes(a)) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${a} needs a value`);
      out.flags[a.slice(2)] = argv[i + 1];
      i += 1;
    } else if (BOOL_FLAGS.includes(a)) {
      out.flags[a.slice(2)] = true;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag ${a}`);
    } else {
      out.positional.push(a);
    }
  }
  if (out.flags['if-version'] !== undefined) {
    const n = Number(out.flags['if-version']);
    if (!Number.isInteger(n) || n < 1) throw new Error('--if-version must be a positive integer');
    out.flags['if-version'] = n;
  }
  return out;
}

const KEY_RE = /^[A-Z][A-Z0-9]{1,9}-\d+$/;

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '') || 'card';
}

function listQuery(flags) {
  const q = new URLSearchParams();
  for (const k of ['board', 'status', 'kind', 'lane']) if (flags[k]) q.set(k, flags[k]);
  const s = q.toString();
  return `/tasks${s ? `?${s}` : ''}`;
}

// Pure: the API call(s) a command needs, given the existing card (or null) for set/patch.
// Returns { method, path, body } or throws with a usage message.
function planWrite(cmd, key, flags, fileJson, existing, today = new Date()) {
  if (!KEY_RE.test(key || '')) throw new Error('a ticket key looks like TDN-5');
  if (cmd === 'patch') {
    if (!existing) throw new Error(`no card ${key}`);
    if (flags['if-version'] === undefined) throw new Error('patch needs --if-version');
    return { method: 'PATCH', path: `/tasks/${encodeURIComponent(existing.id)}`, body: { data: fileJson, ifVersion: flags['if-version'] } };
  }
  if (cmd === 'set') {
    const card = { ...fileJson, key };
    if (existing) {
      if (flags['if-version'] === undefined) throw new Error(`${key} exists at version ${existing.version}; pass --if-version`);
      return { method: 'PUT', path: `/tasks/${encodeURIComponent(existing.id)}`, body: { data: card, ifVersion: flags['if-version'] } };
    }
    const id = flags.id || `t-${today.toISOString().slice(0, 10).replace(/-/g, '')}-${slug(card.title || key)}`;
    return { method: 'PUT', path: `/tasks/${encodeURIComponent(id)}`, body: { data: card } };
  }
  throw new Error(`not a write: ${cmd}`);
}

function readFileJson(file) {
  if (!file) throw new Error('--file is required');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function findByKey(key, opts) {
  const r = await call('GET', `/tasks?key=${encodeURIComponent(key)}`, undefined, opts);
  if (r.status !== 200) throw Object.assign(new Error(`lookup failed: ${r.status} ${JSON.stringify(r.data)}`), { status: r.status });
  return (r.data.tasks || [])[0] || null;
}

function print(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

async function main(argv, opts = {}) {
  const a = parseArgs(argv);
  let r;
  switch (a.cmd) {
    case 'health':
      r = await call('GET', '/health', undefined, opts);
      break;
    case 'list': {
      r = await call('GET', listQuery(a.flags), undefined, opts);
      if (r.status === 200 && !a.flags.json) {
        for (const t of r.data.tasks) {
          const c = t.data;
          process.stdout.write(`${c.key || t.id}\t${c.status}\t${c.kind || ''}\t${c.board}\t${c.title}\n`);
        }
        return 0;
      }
      break;
    }
    case 'get': {
      if (!KEY_RE.test(a.positional[0] || '')) throw new Error('a ticket key looks like TDN-5');
      const t = await findByKey(a.positional[0], opts);
      if (!t) { print({ error: `no card ${a.positional[0]}` }); return 1; }
      print(t);
      return 0;
    }
    case 'set':
    case 'patch': {
      const key = a.positional[0];
      const fileJson = readFileJson(a.flags.file);
      const existing = KEY_RE.test(key || '') ? await findByKey(key, opts) : null;
      const plan = planWrite(a.cmd, key, a.flags, fileJson, existing);
      r = await call(plan.method, plan.path, plan.body, opts);
      break;
    }
    case 'next': {
      const prefix = a.positional[0];
      if (!/^[A-Z][A-Z0-9]{1,9}$/.test(prefix || '')) throw new Error('a prefix looks like TDN');
      r = await call('POST', `/counters/${prefix}/next`, undefined, opts);
      break;
    }
    default:
      process.stderr.write(`${USAGE}\n`);
      return 2;
  }
  print(r.data);
  return r.status >= 200 && r.status < 300 ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    process.stderr.write(`board: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { KEY_RE, listQuery, main, parseArgs, planWrite, slug };
