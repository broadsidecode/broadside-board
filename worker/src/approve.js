// POST /api/v1/tasks/:id/approve: the one approval path. The card's ask says what is being approved;
// the button does the thing (merges the pull request, records the go, records the answer) and clears
// the ask in the same request. Owner, or a connector that speaks for him (OWNER_PROXIES); every line it
// writes names the real presser. The caller (index.js) passes the verified principal.
import { parsePrUrl, isOwnerProxy, actorLabel, OWNER_PROXIES, GATE_ID } from './lib.js';
import { HttpError, getTask, writeTask } from './store.js';
import { workflowVerdict } from './snapshot.js';

const nowIso = () => new Date().toISOString();
const clip = (s, n = 300) => String(s ?? '').trim().slice(0, n);

async function verifyCurrentChecks(env, pr, reviewedHead, fetchImpl) {
  const url = `https://api.github.com/repos/${pr.owner}/${pr.repo}/actions/runs?head_sha=${reviewedHead}&per_page=50`;
  let res;
  try {
    res = await fetchImpl(url, { headers: {
      authorization: `Bearer ${env.GITHUB_MERGE_TOKEN}`, accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28', 'user-agent': 'board-kit',
    } });
  } catch (err) {
    throw new HttpError(502, `current GitHub checks could not be read: ${clip(err && err.message, 200)}`);
  }
  let body = null;
  try { body = await res.json(); } catch { /* fail closed below */ }
  if (!res.ok || !body || !Array.isArray(body.workflow_runs)) throw new HttpError(502, 'current GitHub checks could not be read');
  const exactRuns = body.workflow_runs.filter((run) => run && run.head_sha === reviewedHead);
  const verdict = workflowVerdict({ workflow_runs: exactRuns });
  if (verdict.checks !== 'success' || verdict.checkCount < 1) throw new HttpError(409, 'current GitHub checks are not green on the reviewed head SHA');
}

// Squash merge through the GitHub REST API. fetchImpl is injected so tests never touch the network.
export async function mergePullRequest(env, prUrl, fetchImpl = fetch, note = '', reviewedHead = '') {
  const pr = parsePrUrl(prUrl);
  if (!pr) throw new HttpError(400, 'ask.pr is not a GitHub pull request URL in a configured GitHub organization');
  if (!env.GITHUB_MERGE_TOKEN) throw new HttpError(503, 'merge token not set');
  if (!/^[0-9a-f]{40}$/i.test(reviewedHead)) throw new HttpError(409, 'merge ask needs the full reviewed head SHA');
  let res;
  try {
    res = await fetchImpl(`https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/merge`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${env.GITHUB_MERGE_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'board-kit',
        'content-type': 'application/json',
      },
      body: JSON.stringify(note ? { merge_method: 'squash', commit_message: note, sha: reviewedHead } : { merge_method: 'squash', sha: reviewedHead }),
    });
  } catch (err) {
    throw new HttpError(502, `GitHub could not be reached: ${clip(err && err.message, 200)}`);
  }
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  if (!res.ok || !body || body.merged !== true || !/^[0-9a-f]{40}$/i.test(String(body.sha || ''))) {
    throw new HttpError(res.status === 409 ? 409 : 502, `GitHub refused the merge: ${clip((body && body.message) || `http ${res.status}`, 300)}`, { githubStatus: res.status });
  }
  return { sha: String(body.sha || '').slice(0, 40), pr };
}

// A durable attempt may have succeeded even when its card write was lost. Confirm
// the exact PR and attempted head read-only before recording the merge. When the read shows the pull
// request still open and unmerged, the error carries it (err.extra.open) so the press can tell a refusal
// that is certain from one that is not.
async function reconcileMerge(env, attempt, fetchImpl) {
  const pr = parsePrUrl(attempt.pr);
  if (!pr || !env.GITHUB_MERGE_TOKEN) throw new HttpError(409, 'merge outcome unconfirmed: attempt lacks a readable pull request');
  let res;
  try {
    res = await fetchImpl(`https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, {
      headers: { authorization: `Bearer ${env.GITHUB_MERGE_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'board-kit' },
    });
  } catch (err) {
    throw new HttpError(502, `merge outcome unconfirmed: GitHub read failed (${clip(err && err.message, 200)})`);
  }
  let body = null;
  try { body = await res.json(); } catch { /* unreadable result */ }
  const sha = body && String(body.merge_commit_sha || '');
  if (!res.ok || !body || body.state !== 'closed' || body.merged !== true || body.head?.sha !== attempt.sha || !/^[0-9a-f]{40}$/i.test(sha)) {
    const head = body && body.head && String(body.head.sha || '');
    const open = res.ok && body && body.state === 'open' && body.merged === false && /^[0-9a-f]{40}$/i.test(head) ? { head } : null;
    throw new HttpError(409, 'merge outcome unconfirmed: exact pull request, reviewed head and merge SHA were not verified', { open });
  }
  return { sha, pr };
}

// Records a merge attempt's definite refusal: state rejected with the GitHub status or a reason, and a history
// line, in one version guarded write. lib.js accepts it only when nothing else on the attempt changed.
async function rejectAttempt(db, principal, id, ifVersion, card, mergeAttempt, why, line) {
  const rejectedAt = nowIso();
  await writeTask(db, principal, { op: 'patch', id, ifVersion, data: {
    evidence: { mergeAttempt: { ...mergeAttempt, state: 'rejected', ...why, rejectedAt } },
    history: [...(Array.isArray(card.history) ? card.history : []), { at: rejectedAt, by: principal, what: line }].slice(-200),
  }, what: line }, { allowMergeReject: true, press: true });
}

const ghHeaders = (env, extra = {}) => ({
  authorization: `Bearer ${env.GITHUB_MERGE_TOKEN}`, accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28', 'user-agent': 'board-kit', ...extra,
});

// Owner's go satisfies the pull request's owner gates (): a go ask carrying {gates, pr, sha}
// posts one "Gate <id>: PASS" comment pinned to that head, so the task gate (tools/ci/task-gate.js) counts it
// on that exact head only. Refused unless the pull request is open on that head. Worker runs the work, so a
// worker press never ticks a gate. Gates already ticked for this head, on the card or in a PASS comment already
// on the pull request (a press whose card write was lost), are not posted again. Returns null when the ask
// carries no gates, else the gates.owner record to write, a history suffix, and the ask it was computed for.
export const gateAskKey = (ask) => JSON.stringify([ask.pr || '', String(ask.sha || '').toLowerCase(), Array.isArray(ask.gates) ? ask.gates : []]);
const pinnedPass = (body, id, sha) => {
  const lines = String(body || '').split(/\r?\n/).map((l) => l.trim());
  return lines.includes(`Gate ${id}: PASS`) && lines.includes(`Head: ${sha}`);
};
async function tickOwnerGates(env, card, ask, principal, who, at, fetchImpl) {
  const ids = Array.isArray(ask.gates) ? ask.gates : [];
  if (!ids.length) return null;
  // Re-checked here as well as in the ask rule: an imported card skips the rule, and an id is copied into the comment.
  if (ids.length > 10 || ids.some((id) => typeof id !== 'string' || !GATE_ID.test(id))) throw new HttpError(409, 'ask.gates holds an id the task gate cannot read');
  if (principal === 'worker') throw new HttpError(403, 'an owner gate is ticked by Owner or a connector speaking for him, never by worker, which runs the work');
  const pr = parsePrUrl(ask.pr);
  const sha = String(ask.sha || '').toLowerCase();
  if (!pr || !/^[0-9a-f]{40}$/.test(sha)) throw new HttpError(409, 'a go with gates needs its pull request and full head SHA');
  const owner = (card.gates && card.gates.owner) || {};
  const todo = ids.filter((id) => !(owner[id] && owner[id].sha === sha && owner[id].pr === ask.pr));
  const key = gateAskKey(ask);
  if (!todo.length) return { key, record: {}, line: `; gates ${ids.join(', ')} already ticked on ${sha.slice(0, 7)}` };
  if (!env.GITHUB_MERGE_TOKEN) throw new HttpError(503, 'merge token not set; the gate comment cannot be posted');
  const base = `https://api.github.com/repos/${pr.owner}/${pr.repo}`;
  let res;
  let body = null;
  try {
    res = await fetchImpl(`${base}/pulls/${pr.number}`, { headers: ghHeaders(env) });
    body = await res.json();
  } catch (err) {
    throw new HttpError(502, `the pull request could not be read: ${clip(err && err.message, 200)}`);
  }
  if (!res.ok || !body || body.state !== 'open') throw new HttpError(409, 'the gated pull request is not open');
  if (String(body.head?.sha || '').toLowerCase() !== sha) throw new HttpError(409, `the pull request head moved from ${sha.slice(0, 7)}; raise the go again on the head being tested`);
  // A PASS for this head already on the pull request (an earlier press whose card write was lost) is reused, but
  // only one the board itself wrote: the token's own account and the board's line (Reviewer, PR 67). When the
  // account cannot be read, nothing is reused and a fresh PASS is posted.
  const found = {};
  let self = '';
  try {
    res = await fetchImpl('https://api.github.com/user', { headers: ghHeaders(env) });
    const me = await res.json();
    if (res.ok && me && me.login) self = String(me.login).toLowerCase();
  } catch { /* reuse nothing */ }
  const ours = (c) => self && String(c?.user?.login || '').toLowerCase() === self && String(c.body || '').includes('Recorded by the Board:');
  for (let page = 1; self && page <= 10 && Object.keys(found).length < todo.length; page += 1) {
    let list = null;
    try {
      res = await fetchImpl(`${base}/issues/${pr.number}/comments?per_page=100&page=${page}`, { headers: ghHeaders(env) });
      list = await res.json();
    } catch (err) {
      throw new HttpError(502, `the pull request comments could not be read: ${clip(err && err.message, 200)}`);
    }
    if (!res.ok || !Array.isArray(list)) throw new HttpError(502, 'the pull request comments could not be read');
    for (const c of list) for (const id of todo) if (!found[id] && c && ours(c) && pinnedPass(c.body, id, sha)) found[id] = String(c.html_url || '');
    if (list.length < 100) break;
  }
  const missing = todo.filter((id) => !(id in found));
  const record = Object.fromEntries(todo.filter((id) => id in found).map((id) => [id, { pr: ask.pr, sha, by: principal, at, comment: found[id] }]));
  if (!missing.length) return { key, record, line: `; gates ${todo.join(', ')} found already posted on ${sha.slice(0, 7)}${await rerunChecks(env, base, sha, fetchImpl)}` };
  const text = [
    ...missing.map((id) => `Gate ${id}: PASS`),
    `Head: ${sha}`,
    '',
    `Recorded by the Board: ${who} gave the go on ${card.key || card.id || 'the card'} at ${at}. This PASS counts on head ${sha.slice(0, 7)} only; a new push needs a new go.`,
  ].join('\n');
  let posted = null;
  try {
    res = await fetchImpl(`${base}/issues/${pr.number}/comments`, { method: 'POST', headers: ghHeaders(env, { 'content-type': 'application/json' }), body: JSON.stringify({ body: text }) });
    posted = await res.json();
  } catch (err) {
    throw new HttpError(502, `the gate comment could not be posted: ${clip(err && err.message, 200)}`);
  }
  if (!res.ok || !posted) throw new HttpError(502, `GitHub refused the gate comment: ${clip((posted && posted.message) || `http ${res.status}`, 200)}`);
  for (const id of missing) record[id] = { pr: ask.pr, sha, by: principal, at, comment: String(posted.html_url || '') };
  return { key, record, line: `; gates ${todo.join(', ')} ticked on ${sha.slice(0, 7)}${await rerunChecks(env, base, sha, fetchImpl)}` };
}

// The PR checks workflow runs on push, not on a comment, so the newest finished run on the head is re-run
// to read the new gate comment. Best effort, and it needs Actions read and write on the repository, which the
// merge token may not carry: the gate stands either way, and the line says what happened so the executor can
// re-run the PR checks run by hand (no push).
async function rerunChecks(env, base, sha, fetchImpl) {
  try {
    const res = await fetchImpl(`${base}/actions/runs?head_sha=${sha}&per_page=50`, { headers: ghHeaders(env) });
    const body = await res.json();
    if (!res.ok || !body || !Array.isArray(body.workflow_runs)) return `; PR checks runs could not be read (HTTP ${res.status}), re-run them by hand`;
    const runs = body.workflow_runs
      .filter((r) => r && r.head_sha === sha && /(^|\/)pr-checks\.yml$/.test(String(r.path || '')))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const run = runs[0];
    if (!run) return '; no PR checks run found to re-run';
    if (run.status !== 'completed') return '; PR checks still running, re-run them by hand when they end';
    const again = await fetchImpl(`${base}/actions/runs/${run.id}/rerun`, { method: 'POST', headers: ghHeaders(env) });
    return again.ok ? '; PR checks re-run' : `; PR checks re-run refused (HTTP ${again.status}), re-run them by hand`;
  } catch (err) {
    return `; PR checks re-run failed (${clip(err && err.message, 80)}), re-run them by hand`;
  }
}

function plan(card, decision, as) {
  // The card's own ask, or a virtual one for the two buttons that predate asks.
  let ask = card.ask && typeof card.ask === 'object' ? card.ask : null;
  if (!ask && decision === 'approve' && as === 'go' && card.kind === 'production') ask = { kind: 'go', text: 'Go for production' };
  if (!ask && card.status === 'approval') ask = { kind: 'approval', text: 'Approval' };
  if (!ask) throw new HttpError(409, 'this card is not asking Owner for anything');
  return ask;
}

export async function approveCard(env, db, principal, id, body = {}, fetchImpl = fetch) {
  if (!isOwnerProxy(principal)) throw new HttpError(403, `approve is for Owner and the connectors that speak for him (${OWNER_PROXIES.join(', ')})`);
  const who = actorLabel(principal);
  const decision = body.decision;
  if (decision !== 'approve' && decision !== 'decline') throw new HttpError(400, 'decision must be approve or decline');
  const note = clip(body.note, 1000);

  let ticked = null;
  // retired is 1 once a finished attempt was moved aside, so the one retry on a version race still applies.
  let retired = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const doc = await getTask(db, id);
    if (!doc) throw new HttpError(404, `no task ${id}`);
    const card = doc.data;
    const ask = plan(card, decision, body.as);
    const text = clip(ask.text || ask.kind, 300);
    const at = nowIso();
    const patch = { ask: null, needsOwner: false, updated: at, updatedBy: principal };
    let writeVersion = doc.version;
    let line;
    let merged = null;

    if (decision === 'decline') {
      line = `${who} declined: ${text}${note ? ` (${note})` : ''}`;
      if (card.status === 'approval') patch.status = 'waiting';
    } else if (ask.kind === 'merge') {
      let mergeAttempt = card.evidence && card.evidence.mergeAttempt;
      // Sequential pull requests on one card: an attempt that already has its outcome
      // (merged or rejected) for another pull request or head is finished. It moves to evidence.mergeAttempts
      // with a history line, in its own version guarded write, and the press goes on as a fresh merge with
      // every gate below. A claimed attempt with no outcome, or one for this same pull request and head, stays.
      if (mergeAttempt && ['merged', 'rejected'].includes(mergeAttempt.state) && (mergeAttempt.pr !== ask.pr || mergeAttempt.sha !== ask.sha)) {
        const earlier = Array.isArray(card.evidence.mergeAttempts) ? card.evidence.mergeAttempts : [];
        const moved = `${who}: earlier merge attempt for ${mergeAttempt.pr} (${mergeAttempt.state}${mergeAttempt.mergeSha ? ' ' + String(mergeAttempt.mergeSha).slice(0, 7) : ''}) kept in evidence.mergeAttempts before a new merge`;
        try {
          await writeTask(db, principal, { op: 'patch', id, ifVersion: doc.version, data: {
            evidence: { mergeAttempts: [...earlier, mergeAttempt], mergeAttempt: { __delete__: true } },
            history: [...(Array.isArray(card.history) ? card.history : []), { at, by: principal, what: moved }].slice(-200),
          }, what: moved }, { press: true });
        } catch (err) {
          if (!(err instanceof HttpError && err.status === 409)) throw err;
        }
        retired = 1;
        continue;
      }
      const reviewer = card.gates && card.gates.reviewer;
      if (!mergeAttempt && (!/^[0-9a-f]{40}$/i.test(String(ask.sha || '')) || !reviewer || reviewer.verdict !== 'PASS' || reviewer.sha !== ask.sha || !card.evidence || card.evidence.reviewedHead !== ask.sha)) {
        throw new HttpError(409, 'merge ask needs a PASS for its stored reviewed head SHA; clear and reissue an unpinned ask');
      }
      // A new provider PUT needs a green check record for the same reviewed head.
      // An existing attempt is reconciled read-only because GitHub may already have merged it.
      if (!mergeAttempt && !new RegExp(`^pass \\([1-9]\\d* runs? on ${ask.sha}, synced from GitHub\\)$`, 'i').test(String(card.evidence.checks || ''))) {
        throw new HttpError(409, 'merge ask needs passing checks on its stored reviewed head SHA');
      }
      if (!parsePrUrl(ask.pr)) throw new HttpError(400, 'ask.pr is not a GitHub pull request URL in a configured GitHub organization');
      if (!env.GITHUB_MERGE_TOKEN) throw new HttpError(503, 'merge token not set');
      if (mergeAttempt && (mergeAttempt.pr !== ask.pr || mergeAttempt.sha !== ask.sha)) throw new HttpError(409, 'merge attempt belongs to another pull request or head');
      if (!mergeAttempt) {
        await verifyCurrentChecks(env, parsePrUrl(ask.pr), ask.sha, fetchImpl);
        mergeAttempt = { id: crypto.randomUUID(), pr: ask.pr, sha: ask.sha, at, by: principal };
        try {
          const claim = await writeTask(db, principal, { op: 'patch', id, ifVersion: doc.version, data: { evidence: { mergeAttempt } }, what: 'merge attempt claimed before GitHub PUT' }, { press: true });
          writeVersion = claim.version;
        } catch (err) {
          if (err instanceof HttpError && err.status === 409 && attempt === retired) continue;
          throw err;
        }
        // GitHub records the merge under the token owner's account; the commit body names the presser.
        try {
          merged = await mergePullRequest(env, ask.pr, fetchImpl,
            `Merged from the Board by ${who} (card ${card.key || id}). The board's history for ${card.key || id} is the record.`,
            ask.sha);
        } catch (err) {
          if (err instanceof HttpError && err.extra.githubStatus === 405) {
            try {
              merged = await reconcileMerge(env, mergeAttempt, fetchImpl);
            } catch (rerr) {
              // GitHub said 405 and the read shows the pull request still open and unmerged on the attempted
              // head: GitHub refused this PUT, so the attempt is
              // rejected rather than left with no outcome. A press on the same ask still never PUTs again.
              const open = rerr instanceof HttpError && rerr.extra && rerr.extra.open;
              if (open && open.head === mergeAttempt.sha) {
                await rejectAttempt(db, principal, id, writeVersion, card, mergeAttempt, { githubStatus: 405 },
                  `${who} merge refused by GitHub (HTTP 405: ${clip(err.message.replace(/^GitHub refused the merge: /, ''), 120)}); fix the pull request and reissue the ask`);
                throw new HttpError(409, `GitHub refused the merge: ${clip(err.message.replace(/^GitHub refused the merge: /, ''), 300)}; the attempt is recorded as rejected`);
              }
              throw rerr;
            }
          } else {
            // These HTTP responses definitively refused the PUT. Record that outcome so the stale ask
            // and claim can be cleared through an ordinary version-guarded card write for fresh review.
            const status = err instanceof HttpError && err.extra.githubStatus;
            if (Number.isInteger(status) && status >= 400 && status < 500 && ![405, 408, 429].includes(status)) {
              await rejectAttempt(db, principal, id, writeVersion, card, mergeAttempt, { githubStatus: status },
                `${who} merge refused by GitHub (HTTP ${status}); review and reissue the ask`);
            }
            throw err;
          }
        }
      } else {
        try {
          merged = await reconcileMerge(env, mergeAttempt, fetchImpl);
        } catch (err) {
          // An attempt with no outcome whose pull request now reads open and unmerged on a different head can
          // never merge: its PUT was pinned to the attempted head. It is recorded as
          // rejected so the card can take a fresh ask for the new head. The same head open stays unconfirmed.
          const open = err instanceof HttpError && err.extra && err.extra.open;
          if (!mergeAttempt.state && open && open.head !== mergeAttempt.sha) {
            await rejectAttempt(db, principal, id, doc.version, card, mergeAttempt,
              { reason: `pull request open and unmerged; head moved to ${open.head}` },
              `${who} merge attempt for ${String(mergeAttempt.sha).slice(0, 7)} rejected: the pull request is open and unmerged on head ${open.head.slice(0, 7)}; review and reissue the ask`);
            throw new HttpError(409, `merge attempt rejected: the pull request head moved to ${open.head}; record the review for that head and reissue the ask`);
          }
          throw err;
        }
      }
      line = `${who} approved: ${text}; pull request merged ${merged.sha.slice(0, 7)}`;
      patch.evidence = { merged: merged.sha, mergeAttempt: { ...mergeAttempt, state: 'merged', mergeSha: merged.sha } };
    } else if (ask.kind === 'go') {
      const g = card.gates || {};
      // Posted once per press: a retry after a version race reuses the first post, but only for the same ask.
      if (ticked && ticked.key !== gateAskKey(ask)) ticked = null;
      ticked = ticked || await tickOwnerGates(env, card, ask, principal, who, at, fetchImpl);
      if (g.ownerGo === true || g.ownerGo === 'true') {
        // A second press keeps the first go time, so the record never shows the go after the deploy it allowed.
        line = `${who} pressed go again; the go stands from ${g.ownerGoAt || 'earlier'}${g.ownerGoBy ? ` by ${g.ownerGoBy}` : ''}`;
      } else {
        line = `${who} gave the go: ${text}`;
        patch.gates = { ownerGo: true, ownerGoAt: at, ownerGoBy: principal };
      }
      if (ticked) {
        line += ticked.line;
        if (Object.keys(ticked.record).length) patch.gates = { ...(patch.gates || {}), owner: { ...(g.owner || {}), ...ticked.record } };
      }
      if (card.status === 'approval') patch.status = 'doing';
    } else if (ask.kind === 'design') {
      // Only a card that is in design and carries its canvas can have its design approved; the gate is a record.
      const canvas = card.evidence && typeof card.evidence.design === 'string' ? card.evidence.design.trim() : '';
      if (card.status !== 'design' || !canvas) throw new HttpError(409, 'a design is approved only on a card in the design column that carries evidence.design');
      // The design on evidence.design is approved: the gate is recorded and the card moves on to building.
      line = `${who} approved the design: ${text}`;
      patch.gates = { design: { approvedAt: at, approvedBy: principal } };
      patch.status = 'doing';
    } else if (ask.kind === 'answer' || ask.kind === 'decide') {
      // An ask sent to Owner by one of his proxies is Agent's recommendation: approving it with
      // no note takes the recommendation as the decision. A question still open to Agent needs words.
      // An ask with no `to` predates the redesign and is a plain ask, not a recommendation.
      const recommendation = ask.to === 'owner';
      if (!note && !recommendation) throw new HttpError(400, 'a note is required to answer or decide');
      const decision = note || text;
      const qs = Array.isArray(card.questions) ? card.questions : [];
      const i = qs.findIndex((q) => q && !q.answer && String(q.q || '').trim() === String(ask.text || '').trim());
      if (i >= 0) {
        patch.questions = qs.map((q, j) => (j === i ? { ...q, answer: decision, answeredBy: principal, answeredAt: at } : q));
        line = `${who} answered: ${text} (${decision})`;
      } else if (note) {
        line = `${who} decided: ${note}`;
      } else {
        line = `${who} approved Agent's recommendation: ${text}`;
      }
      if (card.status === 'approval' || card.status === 'waiting') patch.status = 'doing';
      if (card.status === 'waiting') patch.waitingOn = '';
    } else {
      // Plain approval column card with no ask.
      line = `${who} approved`;
      patch.status = 'doing';
    }

    const history = [...(Array.isArray(card.history) ? card.history : []), { at, by: principal, what: line }].slice(-200);
    patch.history = history;
    try {
      const res = await writeTask(db, principal, { op: 'patch', id, data: patch, ifVersion: writeVersion, what: line }, { allowGo: true, allowMergeFinalize: !!merged, press: true });
      return { ok: true, id, version: res.version, decision, kind: ask.kind, ...(merged ? { merged: merged.sha } : {}) };
    } catch (err) {
      if (err instanceof HttpError && err.status === 409 && attempt === retired) continue;
      if (merged && err instanceof HttpError) {
        throw new HttpError(err.status, `${err.message} (the pull request was merged ${merged.sha.slice(0, 7)}; the card was not updated)`, err.extra);
      }
      throw err;
    }
  }
  throw new HttpError(409, 'the card kept changing; try again');
}
