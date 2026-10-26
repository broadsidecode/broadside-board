'use strict';

// The handbook tool and resource on the MCP, with HANDBOOK.md injected the way the Worker bundles it.
//   node --test tests/board-handbook.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const handbookPath = path.join(__dirname, '..', 'handbook', 'HANDBOOK.md');
const handbook = fs.readFileSync(handbookPath, 'utf8');
const mcpUrl = pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'mcp.js')).href;
const env = { HANDBOOK: handbook };
const firstHeading = handbook.split('\n').find((l) => l.startsWith('# '));
const headings = handbook.split('\n').filter((l) => /^## \d+\. /.test(l));

const rpc = async (method, params) => {
  const { handleRpc } = await import(mcpUrl);
  const out = await handleRpc(env, 'owner', { jsonrpc: '2.0', id: 1, method, params });
  return out.json;
};
const callText = async (args) => {
  const json = await rpc('tools/call', { name: 'how_it_works', arguments: args });
  return json.result;
};

test('how_it_works returns the whole handbook', async () => {
  const r = await callText({});
  assert.ok(!r.isError);
  assert.ok(r.content[0].text.includes(firstHeading), 'contains the first heading');
  assert.equal(r.content[0].text, handbook);
});

test('how_it_works section lookup by number and by words', async () => {
  const byNumber = (await callText({ section: '9' })).content[0].text;
  assert.match(byNumber, /^## 9\. Git and publishing/);
  assert.ok(!byNumber.includes('## 10.'), 'stops at the next heading');
  const byWords = (await callText({ section: 'secrets' })).content[0].text;
  assert.match(byWords, /^## 10\. Secrets and access/);
  const correct = (await callText({ section: 'section 11' })).content[0].text;
  assert.match(correct, /^## 11\. Correcting the owner and changing this handbook/);
});

test('how_it_works with an unknown section lists the headings', async () => {
  const r = await callText({ section: 'zzz-nothing' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /404/);
  assert.ok(r.content[0].text.includes('11. Correcting the owner and changing this handbook'), 'lists the last heading');
});

test('how_it_works is listed and the instructions open with it', async () => {
  const list = (await rpc('tools/list')).result.tools;
  assert.ok(list.some((t) => t.name === 'how_it_works'));
  const { BOARD_INSTRUCTIONS } = await import(mcpUrl);
  assert.match(BOARD_INSTRUCTIONS.split('\n')[0], /^At the start of every session call how_it_works once/);
  const init = (await rpc('initialize', { protocolVersion: '2025-06-18' })).result;
  assert.ok(init.capabilities.resources);
});

test('the handbook resource lists and reads', async () => {
  const list = (await rpc('resources/list')).result.resources;
  assert.equal(list.length, 1);
  assert.equal(list[0].uri, 'board://handbook');
  const read = (await rpc('resources/read', { uri: 'board://handbook' })).result.contents[0];
  assert.equal(read.mimeType, 'text/markdown');
  assert.ok(read.text.includes(firstHeading));
  const bad = await rpc('resources/read', { uri: 'board://nope' });
  assert.ok(bad.error);
});

test('the handbook is ASCII with the eleven sections and no dashes', () => {
  assert.ok(!/[^\x00-\x7F]/.test(handbook), 'ASCII only');
  assert.equal(headings.length, 11);
  headings.forEach((h, i) => assert.ok(h.startsWith(`## ${i + 1}. `), `heading ${i + 1} is in order`));
  assert.ok(!/[\u2013\u2014]/.test(handbook), 'no en or em dashes');
});

test('the instructions are ASCII and keep the phrases the tools rely on', async () => {
  const { BOARD_INSTRUCTIONS } = await import(mcpUrl);
  assert.equal(typeof BOARD_INSTRUCTIONS, 'string');
  assert.ok(!/[^\x00-\x7F]/.test(BOARD_INSTRUCTIONS), 'ASCII only');
  assert.ok(!/[\u2013\u2014]/.test(BOARD_INSTRUCTIONS), 'no en or em dashes');
  for (const phrase of [
    'call activity with since',
    'set ask {kind, text, pr, by}',
    'add_comment',
    'call snapshot; it includes a GitHub cross check with MISMATCH lines',
    'call sync_github',
    'todo, design (',
    'evidence.rollback {to, how, cannot}',
    'go to the agent, not the owner',
    'Bots raise asks with ask_owner (key, kind, text, pr, by)',
  ]) {
    assert.ok(BOARD_INSTRUCTIONS.includes(phrase), `instructions contain: ${phrase}`);
  }
  assert.ok(!BOARD_INSTRUCTIONS.includes('vault_names'), 'no vault_names in the kit');
  assert.ok(!BOARD_INSTRUCTIONS.includes('ask_kyle'), 'ask_kyle is ask_owner in the kit');
});

test('neither the handbook nor the instructions name the company or its people', async () => {
  const { BOARD_INSTRUCTIONS } = await import(mcpUrl);
  for (const word of ['Broadside', 'Kyle', 'Scarlett', 'Jarvis', 'Morgan', 'Reese', 'oddsmap']) {
    const re = new RegExp(word, 'i');
    assert.ok(!re.test(handbook), `handbook mentions ${word}`);
    assert.ok(!re.test(BOARD_INSTRUCTIONS), `instructions mention ${word}`);
  }
});
