// The Sync button (): a manual fallback that makes the board agree with GitHub for every
// card that names a pull request. The repo workflows and the cloud threads normally keep cards current;
// when one of them misses, Owner presses Sync (or a bot calls sync_github) and the board catches up.
// The Claude projects have no inbound API, so the board cannot pull from them: GitHub is the one
// source it can read, and the pull request is what every thread leaves behind. Read only on GitHub.
import { gatherGithub } from './snapshot.js';
import { listTasks, getTaskByKey, writeTask, HttpError } from './store.js';

const nowIso = () => new Date().toISOString();
export const CRON = 'cron';
// Module switch. The standalone kit rewrites this one line to read its config.
import { MODULES } from './config.js';
export function syncCronEnabled(env) {
  let mods = MODULES;
  try { if (env && env.BOARD_MODULES) mods = JSON.parse(env.BOARD_MODULES); } catch { /* the compiled modules stay */ }
  return Boolean(mods && mods.github);
}
const checksWord = { success: 'pass', failure: 'fail', pending: 'pending' };

// A production card whose deploy the deploy workflow has not recorded yet: merging its source
// pull request is not the deploy, so Sync must not close it.
export const deployOpen = (card) => card.kind === 'production' && String((card.evidence || {}).deployedSha || '').trim() === '';

// What one card should change to match GitHub. Returns {patch, lines} or null when nothing differs.
// evidenceOnly: only the checks line and the reviewer comment claim, never status,
// ask, needsOwner or the merge sha.
export function planSync(card, gh, { evidenceOnly = false } = {}) {
  const patch = {};
  const lines = [];
  const ev = card.evidence || {};
  const status = card.status || 'todo';
  if (evidenceOnly) {
    // nothing about where the card sits
  } else if (gh.merged) {
    const open = deployOpen(card);
    if (status !== 'done' && !open) { patch.status = 'done'; patch.needsOwner = false; patch.ask = null; lines.push(`pull request merged on GitHub, status to done`); }
    const sha = gh.mergedShaFull || gh.mergedSha || '';
    if (sha && String(ev.merged || '') !== sha && !String(sha).startsWith(String(ev.merged || 'x'))) {
      patch.evidence = { ...(patch.evidence || {}), merged: sha };
      lines.push(`merge sha recorded ${sha.slice(0, 7)}${open && status !== 'done' ? '; production deploy still open, status kept' : ''}`);
    }
  } else if (gh.state === 'open' && (status === 'todo' || status === 'doing')) {
    patch.status = 'review'; lines.push('pull request is open on GitHub, status to review');
  }
  const want = checksWord[gh.checks];
  if (want && gh.checkCount > 0) {
    const have = String(ev.checks || '').toLowerCase();
    const head = gh.headFull || gh.head;
    const current = `${want} (${gh.checkCount} runs on ${head}, synced from GitHub)`;
    if (have !== current.toLowerCase()) { patch.evidence = { ...(patch.evidence || {}), checks: current }; lines.push(`checks ${want} on GitHub`); }
  }
  if (gh.reviewer) {
    // A shared GitHub login and a text prefix do not prove Reviewer performed an
    // independent review. Keep the observed claim informational, never a gate.
    const claim = `PR comment claims Reviewer ${gh.reviewer.verdict} at ${gh.reviewer.at || 'unknown time'}; reviewer identity unverified`;
    if (ev.reviewerComment !== claim) {
      patch.evidence = { ...(patch.evidence || {}), reviewerComment: claim };
      lines.push(`PR comment claims Reviewer ${gh.reviewer.verdict}; independent gate unchanged`);
    }
  }
  return lines.length ? { patch, lines } : null;
}

const hasPr = (d) => d.data.evidence && typeof d.data.evidence.pr === 'string' && /github\.com\//.test(d.data.evidence.pr);

// The write path shared by the Sync button and the cron: read GitHub for the cards given (already ordered, most
// wanted first), plan each with planSync and write the difference as a sync write. The cron passes touched, a Set
// that collects the id of every card it read (changed or not) for the rotation; nothing is written to a card for
// that alone. maxWrites caps card writes in one run (the cron's subrequest budget); a changed card past the cap is
// left for the next run, unstamped, so it stays at the front.
async function syncCards(env, db, principal, withPr, { evidenceOnly = false, key = '', scope = '', dry = false, fetchImpl = fetch, budgetMs = 25000, max, touched = null, maxWrites = Infinity } = {}) {
  const gather = await gatherGithub(env, withPr.map((d) => d.data), { fetchImpl, budgetMs, ...(max ? { max } : {}) });
  const report = { ok: true, dry, key: evidenceOnly ? String(key) : '', checked: 0, changed: [], unchanged: 0, unreadable: [], skipped: gather.skipped || 0, error: gather.error || '', writes: 0 };
  for (const d of withPr) {
    const url = String(d.data.evidence.pr).trim().replace(/\/+$/, '');
    const f = gather.facts.get(url);
    if (!f || !f.ok) {
      report.unreadable.push({ key: d.data.key, pr: url, why: f && f.error ? f.error : 'not read (budget or cap)' });
      // A pull request GitHub was asked about and could not answer for goes to the back too, so it cannot hold the front.
      if (touched && f) touched.add(d.id);
      continue;
    }
    report.checked++;
    const plan = planSync(d.data, f.gh, { evidenceOnly });
    if (!plan) {
      report.unchanged++;
      if (touched) touched.add(d.id);
      continue;
    }
    const what = plan.lines.join('; ');
    const entry = { key: d.data.key, board: d.data.board, title: d.data.title, what };
    if (dry) { report.changed.push(entry); continue; }
    if (report.writes >= maxWrites) { report.unreadable.push({ key: d.data.key, pr: url, why: 'change left for the next run (write budget)' }); continue; }
    report.writes++;
    const at = nowIso();
    const history = [...(Array.isArray(d.data.history) ? d.data.history : []), { at, by: principal, what: `synced from GitHub by ${principal}: ${what}` }].slice(-200);
    try {
      const r = await writeTask(db, principal, { op: 'patch', id: d.id, ifVersion: d.version, data: { ...plan.patch, history, updated: at, updatedBy: principal }, what: `sync from GitHub: ${what}` }, { scope, sync: true });
      report.changed.push({ ...entry, version: r.version });
      if (touched) touched.add(d.id);
    } catch (err) {
      report.unreadable.push({ key: d.data.key, pr: url, why: `write failed: ${err && err.message ? err.message : err}` });
      // A refused write still moves the card to the back, so a card that can never be written cannot hold the front.
      if (touched) touched.add(d.id);
    }
  }
  return report;
}

// key: sync one card only, and only its checks and reviewer comment evidence.
export async function syncBoard(env, db, principal, { board = '', key = '', scope = '', dry = false, fetchImpl = fetch } = {}) {
  if (!env.GITHUB_MERGE_TOKEN) throw new HttpError(503, 'merge token not set; the board cannot read GitHub');
  const evidenceOnly = Boolean(key);
  let docs;
  if (evidenceOnly) {
    const doc = await getTaskByKey(db, String(key));
    if (!doc) throw new HttpError(404, `no card ${key}`);
    if (board && doc.data.board !== board) throw new HttpError(400, `card ${key} is on board ${doc.data.board}, not ${board}`);
    if (scope && doc.data.board !== scope) throw new HttpError(403, `card ${key} is outside this token's board`);
    if (!hasPr(doc)) throw new HttpError(400, `card ${key} names no pull request in evidence.pr`);
    docs = [doc];
  } else {
    docs = await listTasks(db, board ? { board } : {});
  }
  // Open cards first, newest first: one press can read only 11 pull requests (four GitHub calls each inside
  // the free plan's 50 outbound calls per request), so the cards still moving are the ones it must reach.
  const withPr = docs.filter(hasPr)
    .sort((a, b) => (a.data.status === 'done') - (b.data.status === 'done') || String(b.data.updated || '').localeCompare(String(a.data.updated || '')));
  // Sync is a deliberate press, not a page load, so it gets a longer GitHub budget than the snapshot.
  return syncCards(env, db, principal, withPr, { evidenceOnly, key, scope, dry, fetchImpl, budgetMs: 25000 });
}

// The cron's rotation lives in board_cron_state, one row per card named "synced:<card id>" holding the time the
// card was last read, never on the card (a stamp on the card would bump its version and log a history row on
// every read). Open cards come before done ones, and within each the card read longest ago first (never read
// first), so over a few runs every open card is covered however small the per run budget is.
export const SYNCED_PREFIX = 'synced:';
export function cronOrder(docs, stamps = new Map()) {
  const at = (d) => String(stamps.get(d.id) || '');
  return docs.filter(hasPr).sort((a, b) =>
    (a.data.status === 'done') - (b.data.status === 'done')
    || at(a).localeCompare(at(b))
    || String(a.id).localeCompare(String(b.id)));
}

// The scheduled GitHub sync (every ten minutes): the Sync button's rules across every board, as principal cron.
// opts.max is how many pull requests this run may read (four GitHub calls each); opts.maxWrites caps card writes.
// One batched read of the stamps at the start and one batched write at the end; a read that changes nothing writes
// nothing to the card.
export async function runSyncCron(env, opts = {}) {
  if (!env.DB) return { skipped: true };
  if (!env.GITHUB_MERGE_TOKEN) throw new HttpError(503, 'merge token not set; the board cannot read GitHub');
  const db = env.DB;
  const stamps = new Map();
  let stateError = '';
  try {
    const res = await db.prepare('SELECT name, value FROM board_cron_state WHERE name LIKE ?').bind(`${SYNCED_PREFIX}%`).all();
    for (const r of res.results || []) stamps.set(String(r.name).slice(SYNCED_PREFIX.length), String(r.value));
  } catch (err) { stateError = `rotation state not read (${err && err.message ? err.message : err})`; }
  const docs = cronOrder(await listTasks(db), stamps);
  const touched = new Set();
  const report = await syncCards(env, db, CRON, docs, { fetchImpl: opts.fetchImpl || fetch, budgetMs: opts.budgetMs || 20000, max: opts.max, touched, maxWrites: opts.maxWrites === undefined ? Infinity : opts.maxWrites });
  report.stamped = 0;
  // One batched write: the stamps, and a prune of state whose card is gone (a synced row for a deleted card, a
  // skip row last touched over 30 days ago). The delete statements ride in the same batch, so the call count is
  // the same; the budget in scheduled.js counts the batch once.
  const at = nowIso();
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  try {
    await db.batch([
      ...[...touched].map((id) => db.prepare('INSERT INTO board_cron_state (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').bind(SYNCED_PREFIX + id, at)),
      db.prepare("DELETE FROM board_cron_state WHERE name LIKE 'synced:%' AND substr(name, 8) NOT IN (SELECT id FROM board_tasks)"),
      db.prepare("DELETE FROM board_cron_state WHERE name LIKE 'skip:%' AND instr(value, '@') > 0 AND substr(value, instr(value, '@') + 1) < ?").bind(cutoff),
    ]);
    report.stamped = touched.size;
  } catch (err) { stateError = stateError || `rotation state not written (${err && err.message ? err.message : err})`; }
  report.stateError = stateError;
  return report;
}

export function syncText(r) {
  const L = [];
  if (r.key) L.push(`Key sync of ${r.key}: checks and reviewer comment only; status, ask and needsOwner are never changed.`);
  L.push(`${r.dry ? 'Sync preview' : 'Synced'}: ${r.checked} card${r.checked === 1 ? '' : 's'} with a pull request checked, ${r.changed.length} ${r.dry ? 'would change' : 'changed'}, ${r.unchanged} already matched GitHub.`);
  for (const c of r.changed) L.push(`${c.key}: ${c.what}`);
  for (const u of r.unreadable) L.push(`${u.key}: could not sync (${u.why})`);
  if (r.error) L.push(r.error);
  return L.join('\n');
}
