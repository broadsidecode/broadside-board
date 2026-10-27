'use strict';

// The per milestone Dates button in the tab header and what its dialog saves ().
// Runs the shipped page script with a small DOM; no browser or network.
//   node --test tests/board-page-milestone-dates.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'page', 'index.html'), 'utf8');

function page(fetchImpl) {
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1].replace(
    /\n  start\(\);\s*\}\)\(\);\s*$/,
    '\n  globalThis.__page = { renderMilestones, openMilestoneDates, saveMilestoneDates, milestoneDatesData, setState: (b, c, who) => { boards = b; tasks = []; current = c; msFilter = ""; me = { principal: who || "owner", canWrite: true, isAdmin: true }; canWrite = true; } };\n})();',
  );
  const element = (tag = 'div') => ({
    tagName: tag.toUpperCase(), children: [], attributes: {}, hidden: false, textContent: '', innerHTML: '', value: '', dataset: {}, style: {}, open: false,
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener() {}, setAttribute(k, v) { this.attributes[k] = v; }, appendChild(c) { this.children.push(c); },
    querySelector() { return null; }, querySelectorAll() { return []; }, remove() {}, focus() {},
    showModal() { this.open = true; }, close() { this.open = false; },
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

const BOARD = { id: 'core', name: 'Acme Plumbing', order: 1, kind: 'website', start: '2026-10-01', target: '2099-11-03', version: 7, owner: 'lane1', milestones: [
  { id: 'intake', name: 'Intake', start: '2026-10-01', end: '2026-10-10' }, { id: 'build', name: 'Build', start: '', end: '' }, { id: 'live', name: 'Live', start: '2026-11-01', end: '2026-11-03' }] };
const MAIN = { id: 'main', name: 'Main', order: 0 };

test('each milestone box carries its own Dates button, for Owner only, beside the card button', () => {
  const { ui, node } = page();
  ui.setState([MAIN, BOARD], 'core');
  ui.renderMilestones();
  const h = node('msHead').innerHTML;
  assert.equal((h.match(/class="msbox"/g) || []).length, 3);
  assert.equal((h.match(/data-msdate="/g) || []).length, 3, 'one Dates button per milestone');
  for (const id of ['intake', 'build', 'live']) assert.match(h, new RegExp('<button type="button" class="quiet msdate" data-msdate="' + id + '"[^>]*>Dates</button>'));
  assert.match(h, /data-msedit="1"[^>]*>Edit dates</, 'the whole project editor stays');
  assert.equal((h.match(/<\/button><button type="button" class="quiet msdate"/g) || []).length, 3, 'the Dates button follows the card button as a sibling, not inside it');
  ui.setState([MAIN, BOARD], 'core', 'agent');
  ui.renderMilestones();
  assert.doesNotMatch(node('msHead').innerHTML, /data-msdate/, 'only Owner gets the Dates buttons');
  assert.match(html, /\.msh \.msbox \.msdate, \.msh \.msedit \{ min-height: 44px; \}/, 'phone touch target');
});

test('Dates opens a dialog for that milestone and Save changes only its dates', async () => {
  const calls = [];
  const { ui, node } = page(async (url, opt) => { calls.push({ url, opt }); return { ok: true, json: async () => ({}) }; });
  ui.setState([MAIN, BOARD], 'core');
  ui.openMilestoneDates(BOARD, 'build');
  assert.equal(node('msDlg').open, true);
  assert.equal(node('mdName').value, 'Build');
  node('mdStart').value = '2026-10-12'; node('mdEnd').value = '2026-10-20';
  await ui.saveMilestoneDates();
  const put = calls.find((c) => c.opt.method === 'PUT');
  assert.ok(put, 'a PUT was sent');
  assert.match(put.url, /\/boards\/core$/);
  const sent = JSON.parse(put.opt.body);
  assert.equal(sent.ifVersion, 7);
  const want = { ...BOARD }; delete want.id; delete want.version;
  want.milestones = BOARD.milestones.map((m) => (m.id === 'build' ? { ...m, start: '2026-10-12', end: '2026-10-20' } : m));
  assert.deepEqual(sent.data, want, 'every other field and milestone is unchanged');
  assert.equal(node('msDlg').open, false, 'the dialog closes on success');
});

test('an end before the start is refused and a conflict shows the project editor message', async () => {
  const { ui, node } = page(async () => ({ ok: false, status: 409, json: async () => ({ error: 'conflict' }) }));
  ui.setState([MAIN, BOARD], 'core');
  ui.openMilestoneDates(BOARD, 'intake');
  node('mdStart').value = '2026-10-20'; node('mdEnd').value = '2026-10-10';
  await ui.saveMilestoneDates();
  assert.equal(node('mdErr').hidden, false);
  assert.match(node('mdErr').textContent, /before the start/);
  node('mdEnd').value = '2026-10-25';
  await ui.saveMilestoneDates();
  assert.match(node('mdErr').textContent, /changed while you were editing/);
  assert.equal(node('msDlg').open, true, 'the dialog stays open on error');
});
