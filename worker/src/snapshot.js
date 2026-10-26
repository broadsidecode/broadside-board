// Plain text snapshot of the whole board plus a GitHub cross check, for bots to read in one go
// (GET /api/v1/snapshot, GET /llms.txt, MCP tool snapshot). ASCII, one fact per line, fixed labels,
// no markdown tables. Read only: it never writes to the board or to GitHub.
import { parsePrUrl, riskOf, staleHours, STALE_HOURS, STATUSES, priorityWord } from './lib.js';
import { listBoards, listTasks, listCounters, listActivity } from './store.js';

export const SNAPSHOT_VERSION = '1.0.0';
const STATUS_ORDER = STATUSES.filter((s) => s !== 'done');
const MAX_BYTES = 60 * 1024;
// Each pull request costs four GitHub calls, and the free Workers plan allows 50 outbound calls per request
// (D1 and the Access check are separate), so one request checks at most 11. Open cards come first.
const MAX_PRS = 11;
const GITHUB_BUDGET_MS = 6000;
const STALE_DOING_MS = 2 * 60 * 60 * 1000;
import { MCP_PRINCIPALS as CONNECTORS } from './config.js';

// Everything printed is forced to one ASCII line.
export function t(v, max = 300) {
  const s = String(v ?? '')
    .replace(new RegExp(String.fromCharCode(91,0x2018,0x2019,93),"g"), "'")
    .replace(new RegExp(String.fromCharCode(91,0x201c,0x201d,93),"g"), '"')
    .replace(new RegExp(String.fromCharCode(91,0x2013,0x2014,93),"g"), ",")
    .replace(/\s+/g, ' ').trim()
    .replace(/[^\x20-\x7E]/g, '?');
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

const list = (v) => (Array.isArray(v) ? v.map((x) => t(x, 80)).filter(Boolean).join(', ') : '');
const orNone = (s) => (s === '' || s === undefined || s === null ? 'none' : s);

// ------------------------------------------------------------------------------ GitHub facts
function ghHeaders(env) {
  return {
    authorization: `Bearer ${env.GITHUB_MERGE_TOKEN}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'board-kit',
  };
}

async function ghGet(env, path, fetchImpl, signal) {
  const res = await fetchImpl(`https://api.github.com${path}`, { headers: ghHeaders(env), signal });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

// The checks verdict from the workflow runs of one head commit. Only the latest run of each workflow counts,
// so a check that failed and then passed on a re-run (an edited description, a retry) reads as passed.
// The board sync workflow's own result is not a check on the site; a failed sync run must not read as failing.
const FAILED = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'];
export function workflowVerdict(wr) {
  if (!wr || !Array.isArray(wr.workflow_runs)) return { checks: 'unknown', checkCount: 0 };
  const notSync = (r) => !/^(board[ -_]?sync|sync)$/i.test(String(r && r.name || '').trim());
  const latest = new Map();
  for (const r of wr.workflow_runs.filter(notSync)) {
    const key = String(r.workflow_id || r.name || '');
    const at = Date.parse(r.created_at || '') || 0;
    const prev = latest.get(key);
    if (!prev || at > prev.at || (at === prev.at && (r.run_attempt || 0) > (prev.r.run_attempt || 0))) latest.set(key, { at, r });
  }
  const runs = [...latest.values()].map((x) => x.r);
  if (!runs.length) return { checks: 'none', checkCount: 0 };
  if (runs.some((r) => FAILED.includes(r.conclusion))) return { checks: 'failure', checkCount: runs.length };
  if (runs.some((r) => r.status === 'completed' && r.conclusion && r.conclusion !== 'success')) return { checks: 'failure', checkCount: runs.length };
  if (runs.some((r) => r.status !== 'completed')) return { checks: 'pending', checkCount: runs.length };
  if (runs.some((r) => r.conclusion !== 'success')) return { checks: 'unknown', checkCount: runs.length };
  return { checks: 'success', checkCount: runs.length };
}

// Read only facts for one pull request. Throws on the first failure of the core pull request call;
// the extras (checks, comments, files) degrade to unknown.
export async function fetchPrFacts(env, pr, fetchImpl, signal) {
  const base = `/repos/${pr.owner}/${pr.repo}`;
  const pull = await ghGet(env, `${base}/pulls/${pr.number}`, fetchImpl, signal);
  const head = String(pull.head && pull.head.sha || '');
  const soft = (p) => ghGet(env, p, fetchImpl, signal).catch(() => null);
  // Three calls after the pull request, no more: the free Workers plan allows 50 outbound calls per request,
  // and a snapshot covers many pull requests. The merge token cannot read check runs or commit statuses
  // (403 on this org token), so the verdict comes from the workflow runs for the head commit, which Actions
  // read covers; these repos run GitHub Actions only.
  const [wr, comments, files] = await Promise.all([
    head ? soft(`${base}/actions/runs?head_sha=${head}&per_page=50`) : null,
    soft(`${base}/issues/${pr.number}/comments?per_page=100`),
    soft(`${base}/pulls/${pr.number}/files?per_page=100`),
  ]);
  const { checks, checkCount } = workflowVerdict(wr);
  let reviewer = null;
  if (Array.isArray(comments)) {
    for (const c of comments) {
      const m = String(c.body || '').match(/^\s*Reviewer:?\s*(PASS|FAIL)\b/i);
      if (m) reviewer = { verdict: m[1].toUpperCase(), at: c.created_at || '' };
    }
  }
  const taskFiles = Array.isArray(files) ? files.map((f) => f.filename).filter((n) => /^tasks\/.+\.json$/.test(n)) : null;
  return {
    state: String(pull.state || ''),
    merged: pull.merged === true,
    mergeable: pull.mergeable === null || pull.mergeable === undefined ? 'unknown' : String(pull.mergeable),
    head: head.slice(0, 7),
    headFull: head,
    createdAt: pull.created_at || '',
    updatedAt: pull.updated_at || '',
    mergedSha: String(pull.merge_commit_sha || '').slice(0, 7),
    mergedShaFull: String(pull.merge_commit_sha || '').slice(0, 40),
    checks,
    checkCount,
    reviewer,
    taskFiles,
  };
}

const claimedChecks = (s) => {
  const v = String(s || '').toLowerCase();
  if (!v) return '';
  if (/pass|green|success|ok/.test(v)) return 'success';
  if (/fail|red|error/.test(v)) return 'failure';
  return v;
};

// The comparison. card is the stored card, gh is fetchPrFacts output, now is a Date.
export function crossCheck(card, gh, now = new Date()) {
  const out = [];
  const done = card.status === 'done';
  const claim = claimedChecks(card.evidence && card.evidence.checks);
  if (claim === 'success' && gh.checks === 'failure') out.push('card says checks pass but GitHub shows failing checks');
  if (claim === 'failure' && gh.checks === 'success') out.push('card says checks fail but GitHub shows passing checks');
  if (gh.merged && !done) out.push('GitHub says merged but the card is not done');
  if (done && !gh.merged && gh.state === 'open') out.push('card is done but the pull request is still open and not merged');
  if (!gh.merged && gh.state === 'closed' && !done) out.push('pull request is closed without a merge but the card is still open');
  const cardMerged = card.evidence && card.evidence.merged ? String(card.evidence.merged) : '';
  if (cardMerged && !gh.merged) out.push('card records a merge sha but GitHub says the pull request is not merged');
  const cardReviewer = card.gates && card.gates.reviewer && card.gates.reviewer.verdict ? String(card.gates.reviewer.verdict).toUpperCase() : '';
  if (gh.reviewer && !cardReviewer) out.push(`GitHub has a Reviewer ${gh.reviewer.verdict} comment but the card has no gates.reviewer`);
  if (!gh.reviewer && cardReviewer) out.push(`card says Reviewer ${cardReviewer} but GitHub has no "Reviewer: PASS" or "Reviewer: FAIL" comment`);
  if (gh.reviewer && cardReviewer && gh.reviewer.verdict !== cardReviewer) {
    out.push(`card says Reviewer ${cardReviewer} but the last Reviewer comment on GitHub is ${gh.reviewer.verdict}`);
  }
  if (card.status === 'doing' && !gh.merged && gh.createdAt) {
    const age = now - new Date(gh.createdAt);
    const idle = now - new Date(card.updated || card.created || now);
    if (age > STALE_DOING_MS && idle > STALE_DOING_MS) out.push('card is doing with a pull request older than 2 hours and no card update in 2 hours');
  }
  return out;
}

// Which cards the capped cross check reaches first: merge asks (newest first, the cards a merge decision
// hangs on), then other asks, then the rest of the open cards, then recently done ones.
const newestFirst = (a, b) => String(b.data.updated || b.updated_at || '').localeCompare(String(a.data.updated || a.updated_at || ''));
export function githubOrder(asks, open, doneAll) {
  const merge = asks.filter((d) => d.data.ask && d.data.ask.kind === 'merge').sort(newestFirst);
  const otherAsks = asks.filter((d) => !merge.includes(d)).sort(newestFirst);
  const rest = open.filter((d) => !asks.includes(d)).sort(newestFirst);
  return [...merge, ...otherAsks, ...rest, ...doneAll.slice(0, 20)];
}

// Fetches facts for the distinct pull requests, in parallel, inside one time budget.
export async function gatherGithub(env, cards, { fetchImpl = fetch, budgetMs = GITHUB_BUDGET_MS, max = MAX_PRS } = {}) {
  if (!env.GITHUB_MERGE_TOKEN) return { error: 'GitHub cross check skipped: the board has no GitHub token set', facts: new Map(), skipped: 0 };
  const prs = new Map();
  for (const c of cards) {
    const pr = parsePrUrl(c.evidence && c.evidence.pr);
    if (!pr) continue;
    const url = c.evidence.pr.trim().replace(/\/+$/, '');
    if (!prs.has(url)) prs.set(url, pr);
  }
  const urls = [...prs.keys()];
  const chosen = urls.slice(0, max);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), budgetMs);
  const facts = new Map();
  try {
    await Promise.all(chosen.map(async (url) => {
      try {
        facts.set(url, { ok: true, gh: await fetchPrFacts(env, prs.get(url), fetchImpl, ctl.signal) });
      } catch (err) {
        const aborted = ctl.signal.aborted || (err && err.name === 'AbortError');
        facts.set(url, { ok: false, error: aborted ? 'GitHub did not answer within 6 seconds' : `GitHub call failed (${t(err && err.message, 80)})` });
      }
    }));
  } finally {
    clearTimeout(timer);
  }
  return { error: '', facts, skipped: urls.length - chosen.length };
}

// ------------------------------------------------------------------------------ rendering
function cardBlock(d, hist, compact = false) {
  const c = d.data;
  const dc = (Array.isArray(c.doneCriteria) ? c.doneCriteria : []).filter((x) => !(x && x.heading));
  const doneN = dc.filter((x) => x && x.done).length;
  const ev = c.evidence || {};
  const g = c.gates || {};
  const L = [];
  L.push(`CARD ${t(c.key || d.id, 40)}`);
  L.push(`  board: ${t(c.board, 60)}`);
  L.push(`  title: ${t(c.title, 200)}`);
  L.push(`  status: ${t(c.status || 'todo', 20)}`);
  L.push(`  kind: ${t(c.kind, 20)}`);
  L.push(`  lane: ${orNone(t(c.lane, 40))}`);
  L.push(`  owner: ${orNone(t(c.owner, 40))}`);
  L.push(`  priority: ${priorityWord(c.priority)}`);
  L.push(`  created by: ${orNone(t(c.createdBy, 40))}`);
  L.push(`  touched by: ${orNone(list(c.touchedBy))}`);
  L.push(`  work type: ${orNone(t(c.workType, 40))}`);
  if (!compact) {
    L.push(`  skills required: ${orNone(list(c.skillsRequired))}`);
    L.push(`  skills used: ${orNone(list(c.skillsUsed))}`);
  }
  L.push(`  note: ${orNone(t(c.note, compact ? 100 : 300))}`);
  L.push(`  done criteria: ${doneN} of ${dc.length}`);
  for (const x of compact ? [] : dc) if (x && !x.done) L.push(`  unmet: ${t(x.text, 200)}`);
  L.push(`  evidence pr: ${orNone(t(ev.pr, 200))}`);
  L.push(`  evidence preview: ${orNone(t(ev.preview, 200))}`);
  L.push(`  evidence checks: ${orNone(t(ev.checks, 40))}`);
  L.push(`  evidence merged: ${orNone(t(ev.merged, 40))}`);
  L.push(`  evidence jiroItem: ${orNone(t(ev.jiroItem, 120))}`);
  if (!compact) {
    L.push(`  evidence design: ${orNone(t(ev.design, 200))}`);
    const rb = ev.rollback && typeof ev.rollback === 'object' ? ev.rollback : null;
    L.push(`  evidence rollback: ${rb ? `to ${orNone(t(rb.to, 120))}; how ${orNone(t(rb.how, 200))}; cannot ${orNone(t(rb.cannot, 120))}` : 'none'}`);
  }
  L.push(`  gate reviewer: ${g.reviewer && g.reviewer.verdict ? `${t(g.reviewer.verdict, 10)} at ${orNone(t(g.reviewer.at, 40))}` : 'none'}`);
  L.push(`  gate ownerGo: ${g.ownerGo ? `yes at ${orNone(t(g.ownerGoAt, 40))}` : 'no'}`);
  if ((c.kind || 'human') === 'production') L.push(`  risk tier: ${riskOf(c)}${c.riskWhy ? ` (${t(c.riskWhy, 80)})` : c.risk === undefined ? " (no tier named, so Owner's go)" : ''}`);
  const qs = (Array.isArray(c.questions) ? c.questions : []).filter((q) => q && !q.answer);
  L.push(`  questions open: ${qs.length}`);
  for (const q of compact ? [] : qs) L.push(`  question: ${t(q.q, 200)} (by ${orNone(t(q.by, 30))})`);
  const h = (Array.isArray(c.history) ? c.history : []).slice(hist ? -hist : 0, hist ? undefined : 0);
  for (const x of h) L.push(`  history: ${t(x.at, 30)} ${t(x.by, 30)}: ${t(x.what, 200)}`);
  return L.join('\n');
}

function askBlock(c) {
  const a = c.ask && typeof c.ask === 'object' ? c.ask : null;
  const L = [`ASK ${t(c.key, 40)}`];
  L.push(`  board: ${t(c.board, 60)}`);
  L.push(`  title: ${t(c.title, 200)}`);
  L.push(`  ask kind: ${a ? t(a.kind, 20) : 'none (needsOwner is set without an ask)'}`);
  L.push(`  ask text: ${a ? orNone(t(a.text, 300)) : 'none'}`);
  L.push(`  from: ${a ? orNone(t(a.by, 40)) : 'none'}`);
  L.push(`  to: ${a ? t(a.to || 'owner', 20) : 'owner'}`);
  L.push(`  since: ${a ? orNone(t(a.at, 40)) : 'none'}`);
  L.push(`  pr: ${a && a.pr ? t(a.pr, 200) : 'none'}`);
  return L.join('\n');
}

function crossBlock(cards, gather, now) {
  const L = ['== GITHUB CROSS CHECK =='];
  if (gather.error) {
    L.push(gather.error);
  }
  const noPr = cards.filter((c) => c.status === 'review' && !(c.evidence && c.evidence.pr));
  const seen = new Set();
  let mismatches = 0;
  for (const c of cards) {
    const url = c.evidence && c.evidence.pr ? c.evidence.pr.trim().replace(/\/+$/, '') : '';
    if (!url || seen.has(url) || gather.error) continue;
    seen.add(url);
    const pr = parsePrUrl(url);
    const sharing = cards.filter((x) => x.evidence && x.evidence.pr && x.evidence.pr.trim().replace(/\/+$/, '') === url);
    L.push('');
    L.push(`PR ${pr ? `${pr.owner}/${pr.repo}#${pr.number}` : t(url, 120)}`);
    for (const x of sharing) {
      const ev = x.evidence || {};
      const rv = x.gates && x.gates.reviewer && x.gates.reviewer.verdict ? String(x.gates.reviewer.verdict) : 'none';
      L.push(`  card: ${t(x.key, 40)} status ${t(x.status, 20)} checks ${orNone(t(ev.checks, 20))} merged ${orNone(t(ev.merged, 40).slice(0, 7))} reviewer ${rv}`);
    }
    const f = gather.facts.get(url);
    if (!f) { L.push(`  github: not fetched (over the ${MAX_PRS} pull request cap; ask again with the board filter)`); continue; }
    if (!f.ok) { L.push(`  github: ${f.error}`); continue; }
    const g = f.gh;
    L.push(`  github: state ${g.state}, merged ${g.merged ? 'yes' : 'no'}, mergeable ${g.mergeable}, head ${orNone(g.head)}`);
    L.push(`  github checks: ${g.checks} (${g.checkCount} runs)`);
    L.push(`  github reviewer comment: ${g.reviewer ? `${g.reviewer.verdict} at ${g.reviewer.at}` : 'none'}`);
    L.push(`  github task file: ${g.taskFiles === null ? 'unknown' : g.taskFiles.length ? g.taskFiles.join(', ') : 'none changed in this pull request'}`);
    L.push(`  github updated: ${g.updatedAt}`);
    let any = false;
    for (const x of sharing) {
      for (const p of crossCheck(x, g, now)) { L.push(`  MISMATCH ${t(x.key, 40)}: ${p}`); mismatches += 1; any = true; }
    }
    if (!any) L.push('  no mismatch');
  }
  for (const c of noPr) { L.push(''); L.push(`MISMATCH ${t(c.key, 40)}: card is in review but has no pull request in evidence`); mismatches += 1; }
  if (gather.skipped > 0) { L.push(''); L.push(`${gather.skipped} more pull requests were not checked (cap ${MAX_PRS})`); }
  L.push('');
  L.push(`mismatches: ${mismatches}`);
  return L.join('\n');
}

// opts: { board, github (default true), fetchImpl, now, version }
export async function buildSnapshot(env, principal, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const db = env.DB;
  const boards = (await listBoards(db)).sort((a, b) => (a.data.order ?? 99) - (b.data.order ?? 99));
  let docs = await listTasks(db, opts.board ? { board: opts.board } : {});
  const counters = await listCounters(db);
  const boardOrder = new Map(boards.map((b, i) => [b.id, i]));
  const byOrder = (a, b) => (boardOrder.get(a.data.board) ?? 99) - (boardOrder.get(b.data.board) ?? 99)
    || (a.data.num || 0) - (b.data.num || 0);
  docs = docs.sort(byOrder);
  const open = docs.filter((d) => d.data.status !== 'done');
  const doneAll = docs.filter((d) => d.data.status === 'done')
    .sort((a, b) => String(b.data.updated || b.updated_at).localeCompare(String(a.data.updated || a.updated_at)));
  // A question or merge ask sent to Agent (ask.to agent) is hers, so it is listed apart from Owner's asks.
  const toAgent = (d) => d.data.ask && typeof d.data.ask === 'object' && d.data.ask.to === 'agent';
  const asks = open.filter((d) => !toAgent(d) && (d.data.needsOwner === true || (d.data.ask && typeof d.data.ask === 'object')));
  const questions = open.filter(toAgent);
  const stale = open.filter((d) => staleHours(d.data, now) > 0);
  let activity = [];
  try { activity = await listActivity(db, { limit: 30, board: opts.board || '' }); } catch { activity = []; }
  const countOf = (s) => open.filter((d) => d.data.status === s).length;

  // GitHub facts: open cards first, then recently done cards, inside the cap.
  const gh = opts.github === false
    ? { error: 'GitHub cross check skipped: not requested', facts: new Map(), skipped: 0 }
    : await gatherGithub(env, githubOrder(asks, open, doneAll).map((d) => d.data), { fetchImpl: opts.fetchImpl || fetch });

  const render = (hist, doneN, compact = false) => {
    const P = [];
    P.push('BOARD SNAPSHOT');
    P.push(`generated at: ${now.toISOString()}`);
    P.push(`read by: ${t(principal, 40)}`);
    P.push(`scope: ${opts.board ? `board ${t(opts.board, 60)}` : 'all boards'}`);
    P.push(`open cards: ${open.length}`);
    P.push(`asks for Owner: ${asks.length}`);
    P.push(`asks for Agent (merges and questions): ${questions.length}`);
    P.push(`stale (in progress, nothing written for ${STALE_HOURS} h or more): ${stale.length}`);
    P.push(`in progress: ${countOf('doing')}`);
    P.push(`review: ${countOf('review')}`);
    P.push(`approval: ${countOf('approval')}`);
    P.push(`blocked: ${countOf('blocked')}`);
    P.push('rules: call how_it_works (the handbook, GET /handbook, or the top of /llms.txt) for how this system works and what each field means.');
    P.push('');
    P.push('== ASKS FOR OWNER ==');
    P.push(asks.length ? asks.map((d) => askBlock(d.data)).join('\n\n') : 'none');
    P.push('');
    P.push('== ASKS FOR AGENT (MERGES AND QUESTIONS) ==');
    P.push(questions.length ? questions.map((d) => askBlock(d.data)).join('\n\n') : 'none');
    P.push('');
    P.push('== STALE ==');
    P.push(stale.length ? stale.map((d) => `stale ${t(d.data.key, 40)} (${t(d.data.board, 60)}): ${t(d.data.title, 120)}; in progress, nothing written for ${staleHours(d.data, now)} h; lane ${orNone(t(d.data.lane, 40))}`).join('\n') : 'none');
    P.push('');
    P.push('== CARDS ==');
    for (const b of boards) {
      if (opts.board && b.id !== opts.board) continue;
      const mine = open.filter((d) => d.data.board === b.id);
      P.push('');
      P.push(`BOARD ${t(b.id, 60)} name ${t(b.data.name, 80)} prefix ${orNone(t(b.data.prefix, 12))}`);
      if (!mine.length) { P.push('no open cards'); continue; }
      for (const s of STATUS_ORDER) {
        for (const d of mine.filter((x) => (x.data.status || 'todo') === s)) { P.push(''); P.push(cardBlock(d, hist, compact)); }
      }
    }
    P.push('');
    P.push(`DONE (latest ${Math.min(doneN, doneAll.length)} of ${doneAll.length})`);
    for (const d of doneAll.slice(0, doneN)) {
      const c = d.data;
      const sha = c.evidence && c.evidence.merged ? ` merged ${t(c.evidence.merged, 40).slice(0, 7)}` : '';
      P.push(`done ${t(c.key, 40)}: ${t(c.title, 120)}${sha}`);
    }
    P.push('');
    P.push(crossBlock([...open, ...doneAll.slice(0, 20)].map((d) => d.data), gh, now));
    P.push('');
    P.push(`== RECENT ACTIVITY (latest ${activity.length}; the activity tool or GET /activity?since= gives more) ==`);
    P.push(activity.length ? activity.map((a) => `${t(a.at, 30)} ${t(a.who, 30)} ${orNone(t(a.key, 40))}: ${t(a.what, 200)}`).join('\n') : 'none');
    P.push('');
    P.push('== ENVIRONMENT ==');
    P.push(`board service version: ${SNAPSHOT_VERSION}`);
    P.push(`boards: ${boards.length}`);
    const ownPrefix = opts.board ? String((boards.find((b) => b.id === opts.board) || { data: {} }).data.prefix || '') : '';
    P.push(`counters next: ${counters.filter((c) => !opts.board || c.id === ownPrefix).map((c) => `${t(c.id, 12)} ${c.next}`).join(', ') || 'none'}`);
    P.push(`connector principals: ${CONNECTORS.join(', ')}`);
    P.push('api: /api/v1/ on the board address, and /mcp for connectors');
    P.push(`time: ${now.toISOString()}`);
    return P.join('\n') + '\n';
  };

  let text = '';
  for (const [hist, doneN, compact] of [[3, 20, false], [1, 20, false], [0, 20, false], [0, 10, false], [0, 0, false], [0, 0, true]]) {
    text = render(hist, doneN, compact);
    if (text.length <= MAX_BYTES) return text;
  }
  // Last resort: cut the cards, never the other sections' framing.
  return `${text.slice(0, MAX_BYTES - 200)}
TRUNCATED: the snapshot passed 60 KB; ask for one board (board id) to read the rest.
`;
}
