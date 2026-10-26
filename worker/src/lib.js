// Pure helpers shared by the API and the MCP endpoint. No I/O here, so tests can import it in Node.
import * as CFG from './config.js';

// design () sits between todo and doing: the card carries evidence.design, a canvas URL, and
// waits for the design ask before anyone builds.
export const STATUSES = ['todo', 'design', 'doing', 'review', 'approval', 'waiting', 'blocked', 'done'];
export const KINDS = ['human', 'agent', 'production'];

// Priority is stored as a number (lower is more urgent) but spoken in three words (). Every
// write path accepts the words through priorityNumber; the snapshot prints the word through priorityWord.
export function priorityWord(n) {
  if (n === undefined || n === null || !Number.isFinite(Number(n))) return 'normal';
  const v = Number(n);
  return v <= 75 ? 'urgent' : v >= 125 ? 'low' : 'normal';
}
const PRIORITY_WORDS = { urgent: 50, normal: 100, low: 150 };
const PROJECT_URL = /^https:\/\/claude\.ai\/code\/project\/[A-Za-z0-9_]+$/;
export function priorityNumber(v) {
  // Zero and negatives are not priorities; they fall back to normal like any other junk value.
  if (typeof v === 'number' && Number.isFinite(v)) return v > 0 ? v : 100;
  const w = String(v ?? '').trim().toLowerCase();
  if (w in PRIORITY_WORDS) return PRIORITY_WORDS[w];
  // A number sent as text (the generator model does this) is still a number.
  if (/^\d+(\.\d+)?$/.test(w) && Number(w) > 0) return Number(w);
  return 100;
}

// Principals that may write. Everyone with a valid Access assertion may read.
export const WRITERS = CFG.WRITERS;
// Principals that may delete a card or seed versions (migration).
export const ADMINS = CFG.ADMINS;
// The names Owner speaks through. Every button on the board page is theirs too (): approve,
// decline, production go, nudge, delete, production cards. The board signs each press with the real name.
// Service token workers (cloud-worker, github-actions, runner, lane1) keep the writer powers only.
export const OWNER_PROXIES = CFG.PROXIES;
export const isOwnerProxy = (principal) => OWNER_PROXIES.includes(principal);
// How a press is written into history: Owner himself, or a proxy acting for him.
export const actorLabel = (principal) => (principal === 'owner' ? 'Owner' : `${principal} for Owner`);

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Merge for PATCH: objects merge at every depth, so patching roles.deployer.state keeps the deployer's
// other fields (the old one level merge erased them). Arrays and plain values replace. A value
// of {"__delete__": true} removes the field at any depth; null sets the field to null.
export function mergeCard(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (isPlainObject(v) && v.__delete__ === true) { delete out[k]; continue; }
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeCard(out[k], v) : v;
  }
  return out;
}

// a service principal can be bound to one board as "<principal>@<board>" (SERVICE_PRINCIPALS or
// the board_principals table). The principal name stays as it was, so history, badges and the ask rule
// read the same; the board travels separately as the scope.
export function splitPrincipal(value) {
  // Board ids carry no dot, so an email (which always has one after the @) is never read as scoped.
  const m = String(value || '').match(/^([a-z][a-z0-9-]*)@([a-z0-9][a-z0-9_-]*)$/);
  return m ? { principal: m[1], scope: m[2] } : { principal: String(value || ''), scope: '' };
}
// Workers that live inside a customer project or repository. They must carry a board scope; an
// unscoped one is refused outright, so a shared token can never reach across customers again.
export const SCOPED_WORKERS = CFG.SCOPED_WORKERS;

// Read only (): the board is read only for every principal but Owner. The one write left to
// the others is the approval request: raise or clear an ask, with the record a merge ask needs (the pull
// request, the rollback, the reviewed head and Reviewer's gate). The press itself (approve.js, opts.press) and
// the GitHub mirror (sync.js, opts.sync) write what the server computes, never what a client sends. The
// repository workflow (github-actions) also keeps writing what GitHub says happened: the pull request
// state and the deploy record a go is spent by. store.js runs this first on every card write, and on every
// board, counter and pause write with w null, so no route and no tool can skip it.
const APPROVAL_FIELDS = { ask: true, evidence: ['pr', 'reviewedHead', 'rollback'], gates: ['reviewer'] };
const WORKFLOW_FIELDS = { ...APPROVAL_FIELDS, status: true, evidence: ['pr', 'reviewedHead', 'rollback', 'checks', 'merged', 'deployRun', 'deployedSha', 'deployedAt'] };
const BOOKKEEPING = ['updated', 'updatedBy', 'history'];
// What add_card builds for a new card; an approval card carries these, its ask and the merge record only.
const APPROVAL_CARD_IDENTITY = ['board', 'key', 'num', 'title', 'status', 'kind', 'lane', 'owner', 'note', 'link', 'needsOwner', 'waitingOn', 'created', 'risk', 'riskWhy'];
export const readOnlyRefusal = (who) => `the board is read only for ${who || 'this caller'}: raise or clear an ask (ask_owner, or add_card with an ask) and nothing else; Owner makes every other change`;
function approvalFieldsProblem(who, data, extra = []) {
  for (const [k, v] of Object.entries(data)) {
    if (extra.includes(k) || BOOKKEEPING.includes(k) || APPROVAL_FIELDS[k] === true) continue;
    if (Array.isArray(APPROVAL_FIELDS[k]) && isPlainObject(v) && Object.keys(v).every((f) => APPROVAL_FIELDS[k].includes(f))) continue;
    return readOnlyRefusal(who);
  }
  return null;
}
// A production card that arrives carrying its own go ask ("I should just be handed a card
// with a button"). Making it spends nothing: gates.ownerGo is set only by the press, so the card waits on
// Owner's Go button (or Agent's press on his word) like any other ask.
export const goCard = (d) => isPlainObject(d) && d.kind === 'production' && isPlainObject(d.ask) && d.ask.kind === 'go';
// Risk tiers ("only prompt me on things that are money, legal or something like that. I
// shouldn't have to approve a prod go on a new tab"). A production card names its tier from what the change
// touches, never from who asks: 1 flows on Reviewer's PASS, green checks and a rollback, with no press; 2 is
// Agent's press; 3 (money, legal, wide secrets, deletes, a customer's first launch, a production host) is
// Owner's press. A card with no tier is tier 3, so every card made before tiers, and Owner's own page cards,
// keep needing the go. riskWhy names the item from the handbook list that puts the card in its tier.
export const RISK_TIERS = [1, 2, 3];
export const RISK_WHY_MAX = 200;
export const riskOf = (c) => { const r = Number(c && c.risk); return RISK_TIERS.includes(r) ? r : 3; };
export const tierOneCard = (d) => isPlainObject(d) && d.kind === 'production' && Number(d.risk) === 1 && typeof d.riskWhy === 'string' && d.riskWhy.trim() !== '';
// A production card from anyone but Owner: handed over with its go ask (tier 2 or 3), or tier 1 with no ask.
export const handedCard = (d) => goCard(d) || tierOneCard(d);
export function riskProblem(before, card, who) {
  if (card.risk === undefined && card.riskWhy === undefined) return null;
  if (card.risk !== undefined && !RISK_TIERS.includes(Number(card.risk))) return 'risk is the tier 1, 2 or 3';
  if (card.risk !== undefined && (typeof card.riskWhy !== 'string' || card.riskWhy.trim() === '')) return 'riskWhy names the item from the handbook risk list that puts the card in its tier';
  if (typeof card.riskWhy === 'string' && card.riskWhy.length > RISK_WHY_MAX) return `riskWhy is one line, up to ${RISK_WHY_MAX} characters`;
  // Lowering a tier is lowering a gate: Owner's own, so an agent cannot talk a card out of his press.
  if (before && who !== 'owner' && riskOf(card) < riskOf(before)) return `risk only goes up after the card is made, except by Owner (was ${riskOf(before)})`;
  return null;
}
// The record itself is not the writer's to rewrite: history only grows, and updatedBy names the real writer.
function recordProblem(who, data, existing) {
  const h0 = existing && Array.isArray(existing.history) ? existing.history : [];
  const h1 = data.history;
  if (h1 !== undefined && (!Array.isArray(h1) || h1.length < h0.length || JSON.stringify(h1.slice(0, h0.length)) !== JSON.stringify(h0))) {
    return `history is append only for ${who}: add a line, never change or remove one`;
  }
  if (data.updatedBy !== undefined && data.updatedBy !== who) return `updatedBy is the writer's own name (${who})`;
  return null;
}

// Agent is the board's clerk ("she should be able to update it as an after effect of
// the work"). Every project report reaches her over the line, so she keeps the cards true: status, note,
// links, new cards, comments, done. What stays Owner's is what starts or stops work or spends a gate: Start
// (nudgedAt, pokedAt), hold, release (a card's kind), production cards, delete, pause, rollback, changing a tab (making a new one with add_board is hers), and
// every gate (the go, Reviewer's PASS, which the reviewer writes). The run's own Start record and the reviewed
// head are not hers either. w null is a counter (her add_card, opts.counter) or a board or pause write.
const CLERK_OWNER_FIELDS = ['nudgedAt', 'pokedAt', 'hold', 'gates'];
const CLERK_OWNER_EVIDENCE = ['start', 'run', 'relay', 'reviewedHead', 'mergeAttempt', 'mergeAttempts'];
export const CLERK = 'agent';
export const clerkRefusal = (what) => `the board is read only for ${CLERK} on ${what}, which stays Owner's: Agent keeps the cards true and presses Owner's approve, merge and go buttons, but never starts, holds, releases or deletes work, and a gate moves only through a press`;
function clerkProblem(who, w, opts, existing) {
  const owners = clerkRefusal;
  // opts.tab is add_board making a new tab with its counter; changing a tab stays Owner's.
  if (!w) return opts.counter || opts.tab ? null : owners('a tab, counter or pause change');
  if (w.op === 'delete') return owners('delete');
  if (!isPlainObject(w.data)) return readOnlyRefusal(who);
  const d = w.data;
  const rec = recordProblem(who, d, existing);
  if (rec) return rec;
  for (const k of CLERK_OWNER_FIELDS) if (d[k] !== undefined && JSON.stringify(d[k]) !== JSON.stringify(existing ? existing[k] : undefined)) return owners(k);
  // Compared on the card as it would stand after the write, so a put without them, evidence null or an
  // evidence __delete__ cannot drop them either.
  {
    const e0 = existing && isPlainObject(existing.evidence) ? existing.evidence : {};
    const after = w.op === 'put' ? d : mergeCard(existing || {}, d);
    const e1 = isPlainObject(after.evidence) ? after.evidence : {};
    for (const f of CLERK_OWNER_EVIDENCE) if (JSON.stringify(e1[f]) !== JSON.stringify(e0[f])) return owners(`evidence.${f}`);
  }
  if (existing ? d.kind !== undefined && d.kind !== (existing.kind || 'human') : d.kind === 'production' && !handedCard(d)) return owners(existing ? 'a card\'s kind (release)' : 'a production card without a go ask or a tier 1 risk');
  if (d.mention !== undefined && !opts.allowMention) return owners('a mention');
  // A mention from her wakes a run, which is Start by another name, so an @name in a new comment is refused.
  if (Array.isArray(d.comments)) {
    const before = existing && Array.isArray(existing.comments) ? existing.comments.length : 0;
    if (d.comments.slice(before).some((c) => mentionIn(c && c.text))) return owners('an @name in a comment, which wakes a run');
  }
  return null;
}

export function readOnlyProblem(who, w, opts = {}, existing = null) {
  if (who === 'owner' || opts.press || opts.sync) return null;
  if (who === CLERK) return clerkProblem(who, w, opts, existing);
  // An approval card (opts.approvalCard, set only by add_card when it is given an ask): a new card the server
  // builds to carry an approval request, so work that came over the line has a card to wait on for the press.
  // w null here is its ticket number. The repository workflow's main guard (github-actions) opens the same
  // kind of card over the API when a change reaches main without a merged pull request; its card also carries
  // the priority and work type the guard sets, and its ticket number comes from the counter route.
  const guardCard = who === 'github-actions' && !!w && w.op === 'put' && !existing;
  if (opts.approvalCard || guardCard) {
    if (!w) return null;
    if (w.op !== 'put' || existing || !isPlainObject(w.data) || !(isPlainObject(w.data.ask) || tierOneCard(w.data)) || (w.data.kind === 'production' && !handedCard(w.data))) return readOnlyRefusal(who);
    return approvalFieldsProblem(who, w.data, guardCard ? [...APPROVAL_CARD_IDENTITY, 'priority', 'workType'] : APPROVAL_CARD_IDENTITY);
  }
  if (!w || w.op !== 'patch' || !isPlainObject(w.data)) return readOnlyRefusal(who);
  const allowed = who === 'github-actions' ? WORKFLOW_FIELDS : APPROVAL_FIELDS;
  const rec = recordProblem(who, w.data, existing);
  if (rec) return rec;
  for (const [k, v] of Object.entries(w.data)) {
    if (BOOKKEEPING.includes(k) || allowed[k] === true) continue;
    if (Array.isArray(allowed[k]) && isPlainObject(v) && Object.keys(v).every((f) => allowed[k].includes(f))) continue;
    return readOnlyRefusal(who);
  }
  return null;
}

// the one write guard, run by store.js on every card write from every route (REST, batch, MCP,
// sync, approve). It compares the card before and after, so it cannot be dodged by the shape of the
// request. opts.allowGo is set only by approve.js; opts.scope is the caller's board when it has one.
const str = (v) => (v === undefined || v === null ? '' : String(v));
// Exact value comparison for the go fields: "true" and true differ, a missing value equals ''.
const same = (a, b) => JSON.stringify(a === undefined || a === null ? '' : a) === JSON.stringify(b === undefined || b === null ? '' : b);
// A relay ACK only proves that the run was accepted. The worker must also have
// claimed the run and explicitly recorded completion for this same Start.
function completedStart(card) {
  const start = card.evidence?.start;
  const result = card.evidence?.result;
  const claimed = Date.parse(start?.claimedAt);
  const completed = Date.parse(result?.completedAt);
  return card.status === 'todo' && start?.state === 'acknowledged' &&
    typeof card.evidence?.run === 'string' && !!card.evidence.run &&
    typeof result?.startId === 'string' && result.startId === start.id &&
    typeof result?.completedAt === 'string' && Number.isFinite(claimed) &&
    Number.isFinite(completed) && completed >= claimed;
}
// The deploy record on a production card: set once, by the repository's
// deploy workflow only, never changed or cleared, so one go can never drive a second deploy.
export const DEPLOY_FIELDS = ['deployRun', 'deployedSha', 'deployedAt'];
export function writeProblem(existing, card, who, opts = {}) {
  const before = existing || {};
  const g0 = isPlainObject(before.gates) ? before.gates : {};
  const g1 = isPlainObject(card.gates) ? card.gates : {};
  if (!opts.allowGo) {
    for (const f of ['ownerGo', 'ownerGoAt', 'ownerGoBy']) {
      if (!same(g0[f], g1[f])) return `gates.${f} is set only by an approved go (the board's go button or approve_card), never by a write`;
    }
    // The design approval is a record like the go: only approve writes it, so a patch or a put cannot forge it.
    if (JSON.stringify(g0.design ?? null) !== JSON.stringify(g1.design ?? null)) return "gates.design is set only by an approved design (the board's approve button or approve_card), never by a write";
    // The owner gate record names the head Owner's go ticked on the pull request; only that go writes it.
    if (JSON.stringify(g0.owner ?? null) !== JSON.stringify(g1.owner ?? null)) return "gates.owner is set only by an approved go that carries ask.gates, never by a write";
  }
  const e0 = isPlainObject(before.evidence) ? before.evidence : {};
  const e1 = isPlainObject(card.evidence) ? card.evidence : {};
  for (const f of DEPLOY_FIELDS) {
    if (same(e0[f], e1[f])) continue;
    if (str(e0[f]) !== '') return `evidence.${f} records a production deploy and never changes once set`;
    if (who !== 'github-actions') return `evidence.${f} is written only by the repository's deploy workflow`;
  }
  const k0 = Array.isArray(before.comments) ? before.comments : [];
  const k1 = card.comments === undefined ? [] : card.comments;
  if (!Array.isArray(k1) || k1.length < k0.length || JSON.stringify(k1.slice(0, k0.length)) !== JSON.stringify(k0)) {
    return 'comments are append only: add a comment, never change or remove one';
  }
  if (k1.length > COMMENTS_MAX) return `a card holds at most ${COMMENTS_MAX} comments`;
  if (k1.slice(k0.length).some((c) => c && c.answers === true && !c.answering)) {
    return 'answer must identify the current open question';
  }
  const proxy = isOwnerProxy(who);
  const risk = riskProblem(existing, card, who);
  if (risk) return risk;
  if ((before.kind === 'production') !== (card.kind === 'production') && !proxy) {
    return existing ? 'only Owner or a connector speaking for him moves a card to or from production' : 'only Owner or a connector speaking for him creates a production card';
  }
  if (str(before.nudgedAt) !== str(card.nudgedAt) && !proxy) return 'nudgedAt is set only by the Nudge button (Owner or nudge_card)';
  if (str(before.pokedAt) !== str(card.pokedAt) && !proxy && who !== 'runner') return 'pokedAt is set only by the pickup runner';
  const pendingMerge = before.ask && before.ask.kind === 'merge' && before.evidence && before.evidence.mergeAttempt;
  // A merged or rejected attempt has its outcome, so it no longer locks the card (TASK-63, a second
  // pull request on the same card); approve.js moves it to evidence.mergeAttempts before the next merge.
  if (pendingMerge && pendingMerge.state !== 'rejected' && pendingMerge.state !== 'merged' && !opts.allowMergeFinalize) {
    const currentAttempt = card.evidence && card.evidence.mergeAttempt;
    const rejected = opts.allowMergeReject && currentAttempt && currentAttempt.state === 'rejected' &&
      (Number.isInteger(currentAttempt.githubStatus) || (typeof currentAttempt.reason === 'string' && currentAttempt.reason !== '')) && typeof currentAttempt.rejectedAt === 'string' &&
      JSON.stringify(Object.fromEntries(Object.entries(currentAttempt).filter(([key]) => !['state', 'githubStatus', 'reason', 'rejectedAt'].includes(key)))) === JSON.stringify(pendingMerge);
    if (!card.ask || card.ask.kind !== 'merge' || card.ask.pr !== before.ask.pr || card.ask.sha !== before.ask.sha ||
      JSON.stringify(card.gates?.reviewer ?? null) !== JSON.stringify(before.gates?.reviewer ?? null) ||
      card.evidence?.reviewedHead !== before.evidence?.reviewedHead ||
      card.evidence?.checks !== before.evidence?.checks ||
      (!rejected && JSON.stringify(currentAttempt ?? null) !== JSON.stringify(pendingMerge))) {
      return 'an active merge attempt cannot be cleared or replaced before its outcome is reconciled';
    }
  }
  const priorStart = e0.start;
  // Imported/pre-claim cards may have a pickup marker but no operation ID.
  // That marker can represent a fired run; clearing it would mint a new ID
  // and fire again without any way to correlate the first run's completion.
  if (before.pokedAt &&
    (!isPlainObject(priorStart) || !priorStart.id || priorStart.state === 'rejected') &&
    (!card.pokedAt || !same(priorStart, e1.start))) {
    return 'a legacy Start claim without an active operation ID cannot be changed or cleared; reconcile it before another nudge';
  }
  if (isPlainObject(priorStart) && priorStart.id && priorStart.state !== 'rejected') {
    const nextStart = e1.start;
    const outcome = opts.allowStartOutcome === true && priorStart.state === 'firing' &&
      isPlainObject(nextStart) && nextStart.id === priorStart.id && nextStart.claimedAt === priorStart.claimedAt &&
      ['acknowledged', 'uncertain', 'rejected'].includes(nextStart.state);
    const completed = completedStart(before);
    const reclaim = opts.allowStartReclaim === true && completed && !before.pokedAt &&
      isPlainObject(nextStart) && nextStart.id && nextStart.id !== priorStart.id &&
      nextStart.state === 'firing' && typeof nextStart.claimedAt === 'string' &&
      card.pokedAt === nextStart.claimedAt && same(before.nudgedAt, card.nudgedAt) &&
      e1.result === null && e1.run === '' && e1.relay === '';
    if (!same(priorStart, nextStart) && !outcome && !reclaim) return 'an active or uncertain Start claim cannot be changed or removed';
    // Only a proxy's fresh Nudge on a completed, correlated run, or the
    // runner's definite pre-ACK rejection, can release pokedAt.
    if (before.pokedAt && !card.pokedAt &&
      !(outcome && nextStart.state === 'rejected' && opts.allowStartReset) &&
      !(proxy && completed && !same(before.nudgedAt, card.nudgedAt))) {
      return 'an active or uncertain Start claim cannot be cleared by another nudge';
    }
  }
  if (opts.scope) {
    if (existing && existing.board !== opts.scope) return `this token is bound to board ${opts.scope} and cannot change a card on ${existing.board}`;
    if (card.board !== opts.scope) return `this token is bound to board ${opts.scope} and cannot write a card to ${card.board}`;
  }
  // Rollback on every card (): nothing is merged and nothing is finished until the card says
  // how it is undone. The rule looks only at the two moments that matter, a merge ask and the move to done,
  // so cards that were already done are never re-checked. A seed by worker or owner (importHistory) is the one
  // exception, so old cards can be carried over as they were.
  if (!hasRollback(card)) {
    const seeding = opts.importHistory && ADMINS.includes(who);
    if (isPlainObject(card.ask) && card.ask.kind === 'merge') return ROLLBACK_MESSAGE('a merge ask');
    if (card.status === 'done' && before.status !== 'done' && !seeding) return ROLLBACK_MESSAGE('a move to done');
  }
  return null;
}

// evidence.rollback is {to, how, cannot}: where the undo lands, how it is done, what cannot be undone
// (cannot may be "nothing"). to and how must be written; cannot may be left for the reader.
export function hasRollback(card) {
  const e = isPlainObject(card && card.evidence) ? card.evidence : {};
  const r = isPlainObject(e.rollback) ? e.rollback : null;
  return !!(r && typeof r.to === 'string' && r.to.trim() && typeof r.how === 'string' && r.how.trim());
}
const ROLLBACK_TAIL = ' needs evidence.rollback (to, how, cannot) written first; every card says how it is undone';
const ROLLBACK_MESSAGE = (what) => `${what}${ROLLBACK_TAIL}`;
// The rollback rule refuses a card for a missing record, not a missing permission, so the store answers it
// with 422 and the page does not mistake it for a read only token (which is 403).
export const isRollbackProblem = (msg) => typeof msg === 'string' && msg.endsWith(ROLLBACK_TAIL);

// Server stamp of who made and who touched a card. Called for every create and change from the one
// place that writes cards (store.js), so no route and no bot can skip it. A card's createdBy never
// changes once set; touchedBy is a unique list in first touch order that only grows.
export function stampCard(existing, card, who, opts = {}) {
  if (!isPlainObject(card)) return card;
  const out = { ...card };
  const prior = existing && Array.isArray(existing.touchedBy) ? existing.touchedBy.map(String) : [];
  if (existing) {
    if (existing.createdBy) out.createdBy = existing.createdBy;
    else delete out.createdBy;
    out.touchedBy = [...new Set([...prior, who])];
  } else {
    if (!out.createdBy || typeof out.createdBy !== 'string') out.createdBy = who;
    const given = Array.isArray(out.touchedBy) ? out.touchedBy.map(String) : [];
    out.touchedBy = [...new Set([out.createdBy, ...given, who])];
  }
  // Comments (): a thread on the card for Owner, Agent and the agents. Old comments come
  // through as stored; each new one is stamped with the writer and the time, so a comment cannot be signed
  // as someone else. writeProblem keeps the thread append only.
  //
  // Mentions (): "@worker" (or lane1, lane2, lane3, agent) in a comment from Owner or a
  // connector that speaks for him opens card.mention, and the board wakes that agent's project (run.js
  // mentionRun). An answer identifies its question before closing it. Only the board writes mention: whatever a
  // client sends is replaced by the stored one, except on the board's own fire write (opts.allowMention).
  const c0 = existing && Array.isArray(existing.comments) ? existing.comments : [];
  if (!opts.allowMention) {
    if (existing && existing.mention) out.mention = existing.mention;
    else delete out.mention;
  }
  if (Array.isArray(out.comments) && out.comments.length > c0.length) {
    const at = new Date().toISOString();
    const fresh = out.comments.slice(c0.length)
      .map((c) => ({ at, by: who, text: String((c && c.text) || '').trim().slice(0, COMMENT_MAX), ...(c && c.answers === true ? { answers: true, ...(c.answerId !== undefined ? { answerId: String(c.answerId).trim() } : {}) } : {}) }))
      .filter((c) => c.text);
    out.comments = [...out.comments.slice(0, c0.length), ...fresh];
    for (const c of fresh) {
      const open = openMention(out);
      if (c.answers) {
        if (!canAnswerMention(out, c.answerId)) continue;
        c.answerId = mentionQuestionId(open);
        // The Claude projects all sign in through Owner's claude.ai connector (agent2), so the answer also says
        // who was asked; the page shows "Worker, via Agent2". by stays the real signer.
        c.answering = open.to;
        // An answer closes the open mention; a question that came in while it was open is next in line.
        const next = Array.isArray(open.next) ? open.next : [];
        out.mention = next.length ? { ...next[0], ...(!next[0].questionId ? { questionId: crypto.randomUUID() } : {}), firedAt: '', relay: '', answeredAt: '', ...(next.length > 1 ? { next: next.slice(1) } : {}) }
          : { ...open, answeredAt: at, answeredBy: who };
        continue;
      }
      const to = mentionIn(c.text);
      if (!to || !isOwnerProxy(who)) continue;
      const asked = { to, by: who, at, questionId: crypto.randomUUID(), text: c.text.slice(0, 200) };
      // A second question while one is open waits its turn instead of replacing it (),
      // so one answer never closes a question the agent has not seen.
      // One that never woke anyone (failed, not wired, paused) is replaced instead, so asking again retries it.
      if (open && (open.firedAt || open.state === 'firing' || open.state === 'uncertain')) out.mention = { ...open, next: [...(Array.isArray(open.next) ? open.next : []), asked].slice(0, MENTION_QUEUE_MAX) };
      else out.mention = { ...asked, firedAt: '', relay: '', answeredAt: '', ...(open && Array.isArray(open.next) && open.next.length ? { next: open.next } : {}) };
    }
  }
  return out;
}
export const MENTION_NAMES = CFG.MENTION_NAMES;
// The first @name in a comment, lower case, or ''. An email address (owner@worker.com) is not a mention.
export function mentionIn(text) {
  const m = String(text || '').match(new RegExp('(?:^|[^\\w@.])@(' + MENTION_NAMES.join('|') + ')\\b', 'i'));
  return m ? m[1].toLowerCase() : '';
}
// The card's open mention, or null once it is answered.
export function openMention(card) {
  const m = card && isPlainObject(card.mention) ? card.mention : null;
  return m && m.to && !m.answeredAt ? m : null;
}
// Older cards identify a question by its stored time; new questions use a UUID so same-tick asks differ.
export function mentionQuestionId(mention) {
  return String(mention && (mention.questionId || mention.at) || '');
}
export function canAnswerMention(card, answerId) {
  const open = openMention(card);
  if (!open) return false;
  const id = mentionQuestionId(open);
  if (!id) return false;
  const supplied = answerId !== undefined && answerId !== null ? String(answerId).trim() : '';
  if (open.questionId) return supplied === id;
  // Timestamp IDs on old cards are safe only when that time belongs to one recorded question.
  const questions = Array.isArray(card.comments) ? card.comments.filter((c) => c && !c.answers && isOwnerProxy(c.by) && mentionIn(c.text)) : [];
  if (questions.filter((c) => c.at === open.at).length !== 1) return false;
  if (supplied) return supplied === id;
  // Legacy clients may answer the first, sole question without an ID.
  const answeredBefore = Array.isArray(card.comments) && card.comments.some((c) => c && c.answers === true && c.answering);
  return questions.length === 1 && !answeredBefore && !(Array.isArray(open.next) && open.next.length);
}
export const COMMENT_MAX = 2000;
export const MENTION_QUEUE_MAX = 10;
// A card wakes an agent at most this many times an hour, so a comment loop or a flood cannot run up cloud runs.
export const MENTION_WAKES_PER_HOUR = 6;
export const COMMENTS_MAX = 200;

// ---- ask: what the card needs from Owner (approvals live on the card, one place).
// {kind, text, pr, by, at}. kind merge (pr is a pull request URL), go (production go), answer (a question
// Owner answers in words) or decide (anything else). Setting ask forces needsOwner true; clearing it clears
// needsOwner unless the card is in approval. store.js applies this to every write, so the REST routes and
// the MCP behave the same.
// design asks for the design on evidence.design before building; approving it sets gates.design and
// moves the card to doing. Only a human or agent card carries one.
export const ASK_KINDS = ['merge', 'go', 'answer', 'decide', 'design'];
// Where a question lands: a bot's answer or decide ask goes to Agent, who answers it or brings
// Owner a recommendation. An answer or decide ask written by one of Owner's proxies is that recommendation and
// goes to Owner. A merge ask is Agent's from anyone (merge approval passes from him to her).
// Every other kind is Owner's.
export function askTo(kind, who) {
  if (kind === 'merge') return 'agent';
  if ((kind === 'answer' || kind === 'decide') && !isOwnerProxy(who)) return 'agent';
  return 'owner';
}
const ORG_RE = CFG.GITHUB_ORGS.length ? CFG.GITHUB_ORGS.map((o) => o.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')).join('|') : '(?!)';
const PR_URL = new RegExp('^https://github\\.com/(' + ORG_RE + ')/([A-Za-z0-9._-]{1,100})/pull/(\\d{1,7})/?$');

export function parsePrUrl(url) {
  const m = String(url || '').trim().match(PR_URL);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

// Gate ids as the task gate reads them (tools/ci/task-gate.js GATE_COMMENT).
export const GATE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const GATE_IDS_MAX = 10;

const ASK_DEFAULT_TEXT = { go: 'Go for production', answer: 'Answer', decide: 'Decide', design: 'Approve design' };

// Returns { card, problem }. existing is the stored card (or null). now is an ISO time.
export function applyAskRule(existing, card, who, now) {
  const out = { ...card };
  const had = existing && isPlainObject(existing.ask) ? existing.ask : null;
  const a = out.ask;
  if (isPlainObject(a) && out.status !== 'done') {
    if (!ASK_KINDS.includes(a.kind)) return { card: out, problem: `ask.kind must be one of ${ASK_KINDS.join('|')}` };
    const pr = typeof a.pr === 'string' ? a.pr.trim() : '';
    if (a.kind === 'merge' && !parsePrUrl(pr)) return { card: out, problem: 'a merge ask needs ask.pr, a GitHub pull request URL in a configured GitHub organization' };
    if (a.kind === 'design' && out.kind === 'production') return { card: out, problem: 'a design ask belongs on a human or agent card; a production card takes a go' };
    if (a.kind === 'go' && out.kind === 'production' && riskOf(out) === 1) return { card: out, problem: 'a tier 1 production card needs no go: it deploys on Reviewer\'s PASS, green checks and the rollback on the card' };
    // A go may also carry the pull request's owner gates: {gates: [ids], pr, sha}. Owner's press then
    // posts "Gate <id>: PASS" pinned to that head on the pull request, so he never types the comment himself.
    const gates = a.kind === 'go' && Array.isArray(a.gates) && a.gates.length ? a.gates.map((g) => String(g).trim()) : [];
    const sha = gates.length ? String(a.sha || '').trim().toLowerCase() : '';
    if (gates.length) {
      if (gates.length > GATE_IDS_MAX || gates.some((g) => !GATE_ID.test(g)) || new Set(gates).size !== gates.length) return { card: out, problem: `ask.gates holds up to ${GATE_IDS_MAX} distinct task file gate ids` };
      if (!parsePrUrl(pr)) return { card: out, problem: 'a go with gates needs ask.pr, the gated pull request URL in a configured GitHub organization' };
      if (!/^[0-9a-f]{40}$/.test(sha)) return { card: out, problem: 'a go with gates needs ask.sha, the full head SHA the live run tests' };
      // A deploy go never carries a gate rider: Owner pressing Go to deploy must not also attest a pull request.
      if (out.kind === 'production') return { card: out, problem: 'a production go never carries gates; raise the gated go on the agent card for the pull request' };
    }
    let text = typeof a.text === 'string' ? a.text.trim().slice(0, 300) : '';
    if (!text) text = a.kind === 'merge' ? `Merge pull request ${parsePrUrl(pr).number}` : gates.length ? 'Go for the live run' : ASK_DEFAULT_TEXT[a.kind];
    // The button shows the ask text, so a gated go always says what the press attests (Reviewer, PR 67).
    if (gates.length) {
      const rider = ` (ticks gate${gates.length > 1 ? 's' : ''} ${gates.join(', ')} on PR #${parsePrUrl(pr).number} at ${sha.slice(0, 7)})`;
      if (rider.length > 200) return { card: out, problem: 'ask.gates names too much to show on the button; raise fewer gates per go' };
      if (!text.endsWith(rider)) text = `${text.slice(0, 300 - rider.length).trim()}${rider}`;
    }
    const same = had && had.kind === a.kind && had.text === text && (had.pr || '') === pr &&
      (a.kind !== 'go' || ((had.sha || '') === sha && JSON.stringify(had.gates || []) === JSON.stringify(gates)));
    const next = { kind: a.kind, text };
    if (pr) next.pr = pr;
    if (gates.length) { next.gates = gates; next.sha = sha; }
    // Freeze the head only when the card has a PASS for that exact commit. An
    // older unpinned ask stays unpinned until it is cleared and raised again.
    if (a.kind === 'merge') {
      const reviewed = out.evidence && out.evidence.reviewedHead;
      const reviewer = out.gates && out.gates.reviewer;
      if (same && had.sha) next.sha = had.sha;
      else if (!same && reviewer && reviewer.verdict === 'PASS' && reviewer.sha === reviewed && /^[0-9a-f]{40}$/i.test(String(reviewed || ''))) next.sha = String(reviewed).toLowerCase();
    }
    // A thread may sign the ask with the role that raised it (Reviewer, Cody, Lane1); the connector that wrote it is kept in via.
    const ROLE_BY = CFG.ROLE_BY;
    const signer = typeof a.by === 'string' && ROLE_BY.includes(a.by.trim().toLowerCase()) ? a.by.trim().toLowerCase() : who;
    next.by = same && had.by ? had.by : signer;
    next.via = same && had.via ? had.via : who;
    next.at = same && had.at ? had.at : now;
    // The same ask keeps where it was sent, so a proxy touching the note on a card that asks Agent does
    // not pull the question back to Owner.
    next.to = same && had.to ? had.to : askTo(a.kind, who);
    out.ask = next;
    if (next.to === 'agent') {
      out.needsOwner = false;
      // A merge ask keeps its column (review or approval): the card waits on Agent's press, not on new work.
      if (!same && next.kind === 'merge') out.waitingOn = 'agent';
      else if (!same) { out.status = 'waiting'; out.waitingOn = 'agent'; }
    } else {
      out.needsOwner = true;
    }
    return { card: out, problem: null };
  }
  delete out.ask;
  if (had && out.status !== 'approval') out.needsOwner = false;
  // Agent answers by writing questions[i].answer and clearing the ask: the card goes back to work.
  if (had && had.to === 'agent' && had.kind === 'merge') { if (out.waitingOn === 'agent') out.waitingOn = ''; }
  else if (had && had.to === 'agent' && out.status === 'waiting') { out.status = 'doing'; out.waitingOn = ''; }
  return { card: out, problem: null };
}

export function validateCard(card) {
  if (!isPlainObject(card)) return 'card must be a JSON object';
  if (typeof card.title !== 'string' || !card.title.trim()) return 'card needs a title';
  if (card.status !== undefined && !STATUSES.includes(card.status)) return `status must be one of ${STATUSES.join('|')}`;
  if (card.kind !== undefined && !KINDS.includes(card.kind)) return `kind must be one of ${KINDS.join('|')}`;
  return null;
}

export function validateBoard(board) {
  if (!isPlainObject(board)) return 'board must be a JSON object';
  if (typeof board.name !== 'string' || !board.name.trim()) return 'board needs a name';
  if (board.paused !== undefined && typeof board.paused !== 'boolean') return 'board paused must be true or false';
  // projects (): the Claude project that works the tab's cards, by lane, "*" for every lane.
  if (board.projects !== undefined) {
    if (!isPlainObject(board.projects)) return 'board projects must map a lane (or *) to {name, url}';
    for (const [lane, p] of Object.entries(board.projects)) {
      if (!isPlainObject(p) || typeof p.name !== 'string' || !p.name.trim() || !PROJECT_URL.test(String(p.url || ''))) {
        return `board project ${lane} needs a name and a https://claude.ai/code/project/ link`;
      }
    }
  }
  return null;
}

// The indexed copies of a card.
export function columns(card) {
  const s = (v) => (v === undefined || v === null ? null : String(v));
  return { board: s(card.board), key: s(card.key), status: s(card.status), kind: s(card.kind), lane: s(card.lane) };
}

// Map a verified Access token to a principal. Emails map through emailMap (else the email itself);
// service tokens carry common_name = the service token's client id, mapped through serviceMap.
export function principalFromClaims(claims, emailMap = {}, serviceMap = {}) {
  if (claims.email) {
    const email = String(claims.email).toLowerCase();
    return emailMap[email] || email;
  }
  const cn = claims.common_name ? String(claims.common_name) : '';
  if (cn && serviceMap[cn]) return serviceMap[cn];
  return cn ? `service:${cn}` : null;
}

export function compactCard(card) {
  const pick = ['key', 'title', 'status', 'kind', 'lane', 'owner', 'note', 'needsOwner', 'ask', 'waitingOn', 'link', 'board', 'createdBy', 'touchedBy', 'risk', 'riskWhy'];
  const out = {};
  for (const k of pick) if (card[k] !== undefined) out[k] = card[k];
  return out;
}

// Red strip: needsOwner or blocked or approval, and not done.
export function isWaiting(card) {
  if (card.status === 'done') return false;
  return card.needsOwner === true || card.status === 'blocked' || card.status === 'approval';
}

// Stale (): a card In progress with no history line and no update for STALE_HOURS.
// It surfaces the same way an ask does (bell, drawer, whats_waiting, snapshot) so nothing rots quietly.
export const STALE_HOURS = 6;
export function lastTouch(card) {
  const h = Array.isArray(card.history) ? card.history : [];
  const last = h.length ? h[h.length - 1] : null;
  const a = last && last.at ? String(last.at) : '';
  const b = card.updated ? String(card.updated) : '';
  return a > b ? a : b;
}
export function staleHours(card, now = new Date()) {
  if ((card.status || 'todo') !== 'doing') return 0;
  const at = Date.parse(lastTouch(card));
  if (!at) return 0;
  const hours = (now.getTime() - at) / 3600000;
  return hours >= STALE_HOURS ? Math.floor(hours) : 0;
}
export function isStale(card, now = new Date()) { return staleHours(card, now) > 0; }

export function waitingLine(card) {
  const bits = [`${card.key || '(no key)'}`, `[${card.status || 'todo'}]`, card.title];
  if (card.needsOwner) bits.push('(needs Owner)');
  else if (card.ask && card.ask.to === 'agent') bits.push('(needs Agent)');
  if (card.ask && card.ask.text) bits.push('[ask: ' + card.ask.text + ']');
  const m = openMention(card);
  if (m) bits.push(`[asked @${m.to}: ${String(m.text || '').slice(0, 120)}]`);
  const stale = staleHours(card);
  if (stale) bits.push(`[stale: in progress with nothing written for ${stale} h]`);
  let line = bits.join(' ');
  if (card.note) line += `. ${String(card.note).split('\n')[0].slice(0, 200)}`;
  return line;
}

// MCP write guard. gates.ownerGo is never patched directly by anyone (Owner's page cannot either; the only
// path is approve with a go). kind production is set by Owner and the names that speak for him; other
// writers may not set it or move a production card to another kind.
export function mcpPatchProblem(existing, patch, principal = '') {
  if (!isPlainObject(patch)) return 'patch must be an object';
  const proxy = isOwnerProxy(principal);
  if (patch.kind === 'production' && !proxy) return 'kind production is set only by Owner or a connector speaking for him';
  if (!proxy && existing && existing.kind === 'production' && patch.kind !== undefined && patch.kind !== 'production') {
    return 'a production card keeps its kind';
  }
  if (patch.gates !== undefined) {
    if (!isPlainObject(patch.gates) || Object.prototype.hasOwnProperty.call(patch.gates, 'ownerGo')) {
      return 'gates.ownerGo is set only through an approved go (approve_card), never patched';
    }
    if (Object.prototype.hasOwnProperty.call(patch.gates, 'design')) return 'gates.design is set only through an approved design (approve_card), never patched';
  }
  for (const k of ['key', 'num', 'history', 'createdBy', 'touchedBy']) if (patch[k] !== undefined) return `${k} cannot be changed through MCP`;
  for (const k of ['nudgedAt', 'pokedAt']) if (patch[k] !== undefined) return `${k} is set with nudge_card, not update_card`;
  if (patch.comments !== undefined) return 'comments are added with add_comment, not update_card';
  if (patch.mention !== undefined) return 'mention is written by the board from an @name in a comment, never patched';
  return null;
}

export function slug(text, max = 32) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '') || 'card';
}
