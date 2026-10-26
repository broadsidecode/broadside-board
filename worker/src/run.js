// Start a cloud run when a card is nudged (): Nudge used to only set nudgedAt, and with every
// pickup paused nothing started, so Agent had to open the project in a browser. Now the board fires the
// board's Claude routine itself with the card key, records the run link on the card and sets pokedAt.
//
// Wiring per board: BOARD_RUNS (a plain var, JSON) maps board id to routine id, and the routine's fire token
// is the secret RUN_TOKEN_<BOARD> (board id upper cased, other characters as _). A board without both is
// skipped quietly, so nudges there behave as before.
import { actorLabel, MENTION_WAKES_PER_HOUR } from './lib.js';
import { HttpError, boardPaused, getTask, writeTask } from './store.js';

const nowIso = () => new Date().toISOString();
const FIRE = (id, env) => (env && env.RUN_URL ? String(env.RUN_URL).replace('{id}', id) : `https://api.anthropic.com/v1/claude_code/routines/${id}/fire`);

// A board can be wired per lane as "<board>:<lane>" (the main board runs only its worker lane in the Worker
// project); a plain "<board>" entry covers every lane. The token name follows the board either way.
export function runTarget(env, board, lane) {
  let map = {};
  try { map = JSON.parse(env.BOARD_RUNS || '{}'); } catch { map = {}; }
  const id = (lane && map[`${board}:${lane}`]) || map[board];
  const token = env[`RUN_TOKEN_${String(board || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  return id && token ? { id, token } : null;
}

// Start over the line (). When START_WEBHOOK_URL and the secret
// START_WEBHOOK_KEY are set, a Start is first sent to the start webhook, which posts the card into the project's
// coordinator as the presser typing; no relay routine, API key or RUN_TOKEN is needed for that tab. The line
// answers 404 for a tab it has no project for, and then the relay routine above is fired as before.
export const webhookStartWired = (env) => Boolean(env.START_WEBHOOK_URL && env.START_WEBHOOK_KEY);

async function webhookStart(env, principal, c) {
  const res = await (env.fetchImpl || fetch)(`${String(env.START_WEBHOOK_URL).replace(/\/+$/, '')}/start`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.START_WEBHOOK_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ board: c.board, lane: c.lane || '', key: c.key, title: c.title || '', by: principal, link: env.BOARD_URL ? `${String(env.BOARD_URL).replace(/\/+$/, '')}/#${c.key}` : '' }),
  });
  if (res.status === 404) return { unwired: true };
  if (!res.ok) return { error: `line HTTP ${res.status}`, definiteReject: [400, 401, 403, 422].includes(res.status) };
  const j = await res.json();
  return { run: String(j.relay || ''), messageId: j.id || '' };
}

// a paused tab starts no new project work. The Start or mention is not claimed, so it stays queued on
// the card exactly as it was; one history line says so. Nothing is fired later on its own: after resume the
// next Start (nudge) or comment on the card fires it as usual. Work fired before the pause is not held: the
// relay forwards it and the Board run finishes it, so nothing already claimed is stranded.
async function heldWhilePaused(db, principal, doc, board, what) {
  const at = nowIso();
  const history = [...(Array.isArray(doc.data.history) ? doc.data.history : []), { at, by: principal, what }];
  try {
    await writeTask(db, principal, { op: 'patch', id: doc.id, ifVersion: doc.version, data: { history, updated: at, updatedBy: principal }, what: 'held: board paused' });
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 409)) throw err;
  }
  return { heldPaused: true, board };
}

// Fires only for a card that is nudged and not yet picked up; returns { run } or { error }, or null when the
// card does not qualify or its board has no routine. A failed fire leaves the nudge in place and says why.
export async function startRun(env, db, principal, id) {
  const doc = await getTask(db, id);
  if (!doc) return null;
  const c = doc.data;
  if (!c.nudgedAt || (c.kind || 'human') !== 'agent' || (c.status || 'todo') !== 'todo' || c.hold) return null;
  if (c.pokedAt && c.evidence?.start?.id) {
    const prior = c.evidence.start;
    return prior.state === 'acknowledged' && c.evidence.relay
      ? { run: c.evidence.relay, operationId: prior.id, resumed: true }
      : { pending: true, operationId: prior.id, state: prior.state || 'unconfirmed', error: 'Start outcome is unconfirmed; reconcile the claimed operation before another fire' };
  }
  if (c.pokedAt) return null;
  const target = runTarget(env, c.board, c.lane);
  if (!target && !webhookStartWired(env)) return null;
  if (await boardPaused(db, c.board)) {
    return heldWhilePaused(db, principal, doc, c.board, `run not started: board ${c.board} is paused; the Start stays queued for after resume`);
  }
  const claimedAt = nowIso();
  const operationId = crypto.randomUUID();
  const claimHistory = [...(Array.isArray(c.history) ? c.history : []), { at: claimedAt, by: principal, what: `run claimed by ${actorLabel(principal)} (${operationId})` }];
  try {
    await writeTask(db, principal, { op: 'patch', id: doc.id, ifVersion: doc.version, data: {
      pokedAt: claimedAt,
      evidence: { ...(c.evidence || {}), start: { id: operationId, state: 'firing', claimedAt }, relay: '', run: '', result: null },
      history: claimHistory, updated: claimedAt, updatedBy: principal,
    }, what: 'run claimed before fire' }, { allowStartReclaim: true });
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) return null;
    throw err;
  }
  let run = '';
  let error = '';
  let definiteReject = false;
  let viaLine = false;
  try {
    let useRelay = Boolean(target);
    if (webhookStartWired(env)) {
      const line = await webhookStart(env, principal, c);
      if (line.run) { run = line.run; viaLine = true; useRelay = false; }
      else if (line.unwired) { if (!target) { error = 'no line project and no routine for this tab'; definiteReject = true; useRelay = false; } }
      else { error = line.error; definiteReject = Boolean(line.definiteReject); useRelay = false; }
    }
    if (useRelay) {
      const res = await (env.fetchImpl || fetch)(FIRE(target.id, env), {
        method: 'POST',
        headers: { authorization: `Bearer ${target.token}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ text: `card: ${c.key}` }),
      });
      if (res.ok) run = String((await res.json()).claude_code_session_url || '');
      else { error = `HTTP ${res.status}`; definiteReject = [400, 401, 403, 404, 422].includes(res.status); }
    }
  } catch (e) {
    error = String(e && e.message || e).slice(0, 120);
  }
  const at = nowIso();
  const what = run ? `run started by ${actorLabel(principal)}${viaLine ? ' over the start webhook, coordinator' : ''}: ${run}`
    : definiteReject ? `run did not start (${error}); the nudge stays`
      : `run outcome uncertain (${error || 'no run link'}); Start claim held for reconciliation`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await getTask(db, id);
    if (!current || current.data.evidence?.start?.id !== operationId) throw new HttpError(409, 'Start claim changed before the run outcome could be recorded');
    const history = [...(Array.isArray(current.data.history) ? current.data.history : []), { at, by: principal, what }];
    const data = {
      ...(definiteReject ? { pokedAt: '' } : {}),
      evidence: { start: { id: operationId, state: run ? 'acknowledged' : definiteReject ? 'rejected' : 'uncertain', claimedAt, ...(run ? { relay: run } : {}) }, ...(run ? { relay: run } : {}) },
      history, updated: at, updatedBy: principal,
    };
    try {
      await writeTask(db, principal, { op: 'patch', id: current.id, ifVersion: current.version, data, what: run ? 'run started' : 'run not started' }, { allowStartOutcome: true, allowStartReset: definiteReject });
      break;
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 409 && attempt === 0)) throw err;
    }
  }
  return run ? { run } : { error: error || 'no run link' };
}

// An @name in a comment wakes that agent's project (). Fires the same relay as Start, keyed by
// the mentioned name as the lane ("main:worker", else the board), on a card in any status but done, and never
// touches status, pokedAt or evidence.run: the project run answers in a comment (its step 0) and closes the
// mention. @agent never fires; she finds open mentions in whats_waiting. Returns { run }, { error },
// { unwired } or null when there is nothing to fire.
export async function mentionRun(env, db, principal, id) {
  const doc = await getTask(db, id);
  if (!doc) return null;
  const c = doc.data;
  const m = c.mention && typeof c.mention === 'object' ? c.mention : null;
  // One try per mention: a new @name comment opens a new mention and tries again.
  if (!m || !m.to || m.answeredAt || m.to === 'agent' || c.status === 'done') return null;
  if (m.triedAt) return m.operationId && (m.state === 'firing' || m.state === 'uncertain')
    ? { pending: true, operationId: m.operationId, state: m.state, error: 'Mention wake outcome is unconfirmed; reconcile before another fire' }
    : null;
  // @worker on any board wakes the one Worker project (); other names wake the card's own project.
  const targetBoard = m.to === 'worker' ? 'main' : c.board;
  const target = runTarget(env, targetBoard, m.to);
  if (target && await boardPaused(db, targetBoard)) {
    return heldWhilePaused(db, principal, doc, targetBoard, `@${m.to} not woken: board ${targetBoard} is paused; the question stays open and wakes on the next comment after resume`);
  }
  const hourAgo = new Date(Date.now() - 3600e3).toISOString();
  const wakes = (Array.isArray(c.history) ? c.history : []).filter((h) => h && String(h.at) > hourAgo && / woken by /.test(String(h.what || ''))).length;
  if (target && wakes >= MENTION_WAKES_PER_HOUR) {
    const at = nowIso();
    const history = [...(Array.isArray(c.history) ? c.history : []), { at, by: principal, what: `@${m.to} not woken: this card already woke an agent ${wakes} times in the last hour; the question waits for the next run` }];
    await writeTask(db, principal, { op: 'patch', id: doc.id, ifVersion: doc.version, data: { mention: { ...m, triedAt: at, paused: true }, history, updated: at, updatedBy: principal }, what: 'mention paused' }, { allowMention: true });
    return { paused: true };
  }
  let run = '';
  let error = '';
  let claimAt = '';
  let operationId = '';
  let definiteReject = false;
  if (target) {
    claimAt = nowIso();
    operationId = crypto.randomUUID();
    try {
      await writeTask(db, principal, { op: 'patch', id: doc.id, ifVersion: doc.version, data: {
        mention: { ...m, triedAt: claimAt, operationId, state: 'firing' }, updated: claimAt, updatedBy: principal,
      }, what: 'mention claimed before wake' }, { allowMention: true });
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) return null;
      throw err;
    }
    try {
      const res = await (env.fetchImpl || fetch)(FIRE(target.id, env), {
        method: 'POST',
        headers: { authorization: `Bearer ${target.token}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ text: `mention: ${c.key}` }),
      });
      if (res.ok) run = String((await res.json()).claude_code_session_url || '');
      else { error = `HTTP ${res.status}`; definiteReject = [400, 401, 403, 404, 422].includes(res.status); }
    } catch (e) {
      error = String(e && e.message || e).slice(0, 120);
    }
  }
  const at = nowIso();
  const what = !target ? `@${m.to} asked, but no cloud run is wired for ${c.board} and ${m.to}; the mention waits for someone to open the card`
    : run ? `@${m.to} woken by ${actorLabel(principal)}: ${run}`
      : definiteReject ? `@${m.to} could not be woken (${error})`
        : `@${m.to} wake outcome uncertain (${error || 'no run link'}); claim held for reconciliation`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = target ? await getTask(db, id) : doc;
    if (!current || (target && current.data.mention?.operationId !== operationId)) throw new HttpError(409, 'mention claim changed before the wake outcome could be recorded');
    const history = [...(Array.isArray(current.data.history) ? current.data.history : []), { at, by: principal, what }];
    const mention = { ...current.data.mention, triedAt: claimAt || at, firedAt: run ? at : '', relay: run,
      ...(target ? { state: run ? 'acknowledged' : definiteReject ? 'rejected' : 'uncertain' } : { unwired: true }) };
    try {
      await writeTask(db, principal, { op: 'patch', id: current.id, ifVersion: current.version, data: { mention, history, updated: at, updatedBy: principal }, what: run ? 'mention woke a run' : 'mention not woken' }, { allowMention: true });
      break;
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 409 && target && attempt === 0)) throw err;
    }
  }
  return run ? { run } : target ? { error: error || 'no run link' } : { unwired: true };
}
