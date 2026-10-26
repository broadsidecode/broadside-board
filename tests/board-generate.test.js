'use strict';

// Generator route tests with a fake Workers AI binding and a fake board lookup.
//   node --test tests/board-generate.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const url = pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'generate.js')).href;

const CARD = {
  title: 'Add Saturday hours',
  brief: { objective: 'Show Saturday hours.', spec: 'Update footer.', scope: 'Footer.', outOfScope: 'Menu.', requirements: ['Footer shows hours'], files: [], constraints: [], context: [] },
  workType: 'copyChange',
  doneCriteria: [{ text: 'Footer shows Saturday hours' }, { text: 'Contact page matches' }],
  testSteps: ['Open the footer'],
  expected: 'Hours visible',
  priority: 100,
  roles: { coordinator: 'lane1', builder: 'builder', reviewer: 'reviewer', deployer: 'deployer' },
};

function env(reply, extra = {}) {
  const calls = [];
  return {
    calls,
    AI: { async run(model, input) { calls.push({ model, input }); if (reply instanceof Error) throw reply; return { response: reply }; } },
    DB: { prepare() { return { bind() { return { async first() { return { id: 'x', version: 1, updated_at: '', data: JSON.stringify({ name: 'Franks BBQ', prefix: 'FBQ' }) }; } }; } }; } },
    GENERATOR_MODEL: '@cf/test/model',
    ...extra,
  };
}

test('plain JSON reply returns a card', async () => {
  const { generateCard } = await import(url);
  const e = env(JSON.stringify(CARD));
  const out = await generateCard(e, 'tp-plain', { board: 'franks', kind: 'agent', text: 'Add Saturday hours' });
  assert.equal(out.card.title, 'Add Saturday hours');
  assert.equal(out.card.doneCriteria.length, 2);
  assert.equal(e.calls[0].model, '@cf/test/model');
  assert.match(e.calls[0].input.messages[1].content, /FBQ/);
  assert.equal(out.card.note, 'Show Saturday hours.');
  assert.deepEqual(out.card.skillsRequired, []);
});

test('fenced reply with a leading explanation still parses', async () => {
  const { generateCard } = await import(url);
  const e = env('Here is the card:\n```json\n' + JSON.stringify(CARD) + '\n```\nDone.');
  const out = await generateCard(e, 'tp-fence', { board: 'franks', kind: 'production', text: 'Add Saturday hours' });
  assert.equal(out.card.workType, 'copyChange');
});

test('invalid reply is a 502', async () => {
  const { generateCard } = await import(url);
  await assert.rejects(generateCard(env('sorry, no card'), 'tp-bad', { text: 'x' }), (err) => err.status === 502);
  await assert.rejects(generateCard(env(JSON.stringify({ title: 'No criteria' })), 'tp-bad', { text: 'x' }), (err) => err.status === 502);
  await assert.rejects(generateCard(env(new Error('boom')), 'tp-bad', { text: 'x' }), (err) => err.status === 502);
});

test('empty and oversize text are rejected before the model runs', async () => {
  const { generateCard } = await import(url);
  const e = env(JSON.stringify(CARD));
  await assert.rejects(generateCard(e, 'tp-len', { text: '  ' }), (err) => err.status === 400);
  await assert.rejects(generateCard(e, 'tp-len', { text: 'a'.repeat(4001) }), (err) => err.status === 413);
  assert.equal(e.calls.length, 0);
});

test('rate limit trips after 12 a minute per principal', async () => {
  const { rateLimited } = await import(url);
  const now = Date.now();
  for (let i = 0; i < 12; i++) assert.equal(rateLimited('tp-rate', now), false);
  assert.equal(rateLimited('tp-rate', now), true);
  assert.equal(rateLimited('tp-rate', now + 61000), false);
});

test('generate_card on the MCP returns the draft and writes nothing', async () => {
  const mcpUrl = pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'mcp.js')).href;
  const { handleRpc } = await import(mcpUrl);
  const e = env(JSON.stringify(CARD));
  let writes = 0;
  const prep = e.DB.prepare;
  e.DB.prepare = (sql) => { if (/INSERT|UPDATE/i.test(sql)) writes++; return prep(sql); };
  const out = await handleRpc(e, 'agent', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'generate_card', arguments: { board: 'franks', text: 'Add Saturday hours to the footer', kind: 'agent' } } });
  const body = out.json.result;
  const payload = body.structuredContent || JSON.parse(body.content[0].text);
  assert.equal(payload.card.title, 'Add Saturday hours');
  assert.equal(e.calls.length, 1);
  assert.equal(writes, 0);
  const denied = await handleRpc(e, 'nobody', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'generate_card', arguments: { text: 'x' } } });
  assert.ok(denied.json.error || (denied.json.result && denied.json.result.isError));
  const listed = await handleRpc(e, 'agent', { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
  assert.ok(listed.json.result.tools.some((t) => t.name === 'generate_card'));
});
