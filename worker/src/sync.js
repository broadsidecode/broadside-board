// The Sync button (): a manual fallback that makes the board agree with GitHub for every
// card that names a pull request. The repo workflows and the cloud threads normally keep cards current;
// when one of them misses, Owner presses Sync (or a bot calls sync_github) and the board catches up.
// The Claude projects have no inbound API, so the board cannot pull from them: GitHub is the one
// source it can read, and the pull request is what every thread leaves behind. Read only on GitHub.
import { gatherGithub } from './snapshot.js';
import { listTasks, getTaskByKey, writeTask, HttpError } from './store.js';

const nowIso = () => new Date().toISOString();
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
    if (!(doc.data.evidence && typeof doc.data.evidence.pr === 'string' && /github\.com\//.test(doc.data.evidence.pr))) throw new HttpError(400, `card ${key} names no pull request in evidence.pr`);
    docs = [doc];
  } else {
    docs = await listTasks(db, board ? { board } : {});
  }
  // Open cards first, newest first: one press can read only 11 pull requests (four GitHub calls each inside
  // the free plan's 50 outbound calls per request), so the cards still moving are the ones it must reach.
  const withPr = docs.filter((d) => d.data.evidence && typeof d.data.evidence.pr === 'string' && /github\.com\//.test(d.data.evidence.pr))
    .sort((a, b) => (a.data.status === 'done') - (b.data.status === 'done') || String(b.data.updated || '').localeCompare(String(a.data.updated || '')));
  // Sync is a deliberate press, not a page load, so it gets a longer GitHub budget than the snapshot.
  const gather = await gatherGithub(env, withPr.map((d) => d.data), { fetchImpl, budgetMs: 25000 });
  const report = { ok: true, dry, key: evidenceOnly ? String(key) : '', checked: 0, changed: [], unchanged: 0, unreadable: [], skipped: gather.skipped || 0, error: gather.error || '' };
  for (const d of withPr) {
    const url = String(d.data.evidence.pr).trim().replace(/\/+$/, '');
    const f = gather.facts.get(url);
    if (!f || !f.ok) { report.unreadable.push({ key: d.data.key, pr: url, why: f && f.error ? f.error : 'not read (budget or cap)' }); continue; }
    report.checked++;
    const plan = planSync(d.data, f.gh, { evidenceOnly });
    if (!plan) { report.unchanged++; continue; }
    const what = plan.lines.join('; ');
    const entry = { key: d.data.key, board: d.data.board, title: d.data.title, what };
    if (dry) { report.changed.push(entry); continue; }
    const at = nowIso();
    const history = [...(Array.isArray(d.data.history) ? d.data.history : []), { at, by: principal, what: `synced from GitHub by ${principal}: ${what}` }].slice(-200);
    try {
      const r = await writeTask(db, principal, { op: 'patch', id: d.id, ifVersion: d.version, data: { ...plan.patch, history, updated: at, updatedBy: principal }, what: `sync from GitHub: ${what}` }, { scope, sync: true });
      report.changed.push({ ...entry, version: r.version });
    } catch (err) {
      report.unreadable.push({ key: d.data.key, pr: url, why: `write failed: ${err && err.message ? err.message : err}` });
    }
  }
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
