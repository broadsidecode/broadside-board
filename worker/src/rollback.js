// POST /api/v1/tasks/:id/rollback and the MCP tool rollback_card (). Every card carries
// evidence.rollback, so undoing one is a card of its own: the board writes it from the source card's
// rollback text, urgent, depending on the source, and links the two in history. Owner, or a connector
// that speaks for him; a production source makes a production rollback that still needs his go.
import { isOwnerProxy, actorLabel, OWNER_PROXIES, hasRollback } from './lib.js';
import { HttpError, getTask, writeTask, nextNumber, getBoard } from './store.js';

const nowIso = () => new Date().toISOString();
const str = (v) => String(v ?? '').trim();

export async function rollbackCard(db, principal, id) {
  if (!isOwnerProxy(principal)) throw new HttpError(403, `rollback is for Owner and the connectors that speak for him (${OWNER_PROXIES.join(', ')})`);
  const doc = await getTask(db, id);
  if (!doc) throw new HttpError(404, `no task ${id}`);
  const c = doc.data;
  if (!hasRollback(c)) throw new HttpError(409, `${c.key || id} has no evidence.rollback (to, how, cannot); write how it is undone first`);
  const board = await getBoard(db, String(c.board || ''));
  if (!board) throw new HttpError(404, `no board ${c.board}`);
  const prefix = board.data.prefix;
  if (!prefix) throw new HttpError(400, `board ${board.id} has no ticket prefix`);
  // One source card has one rollback request. The fixed task id is the idempotency key:
  // if the response or source history write is lost, a retry returns the same card.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${board.id}\u0000${id}`));
  const newId = `t-rb-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  const existing = await getTask(db, newId);
  if (existing) {
    if (existing.data.board !== board.id || existing.data.evidence?.rollbackOf !== c.key) throw new HttpError(409, 'rollback id belongs to another card');
    return { key: existing.data.key, id: newId, version: existing.version };
  }
  const who = actorLabel(principal);
  const rb = c.evidence.rollback;
  const { number } = await nextNumber(db, principal, prefix);
  const at = nowIso();
  const key = `${prefix}-${number}`;
  const title = `Roll back ${c.key}: ${str(c.title)}`;
  const production = c.kind === 'production';
  // A nudge starts a lane's thread. A source card with no lane (a human card) has none to start, so the new
  // card is left un-nudged for Owner to place rather than carrying an empty lane and a nudge nobody can act on.
  const lane = c.lane || '';
  const card = {
    board: board.id, key, num: number, title, status: 'todo', kind: production ? 'production' : 'agent',
    lane, owner: '', note: '', link: '', needsOwner: false, waitingOn: '', priority: 50,
    dependsOn: [c.key],
    brief: { objective: `Undo ${c.key}. Goes back to: ${str(rb.to)}`, spec: str(rb.how), outOfScope: str(rb.cannot) },
    evidence: { rollbackOf: c.key },
    created: at, updated: at, updatedBy: principal,
    history: [{ at, by: principal, what: `rollback requested by ${who} for ${c.key}` }],
  };
  if (lane) card.nudgedAt = at;
  if (production) card.ask = { kind: 'go', text: 'Go to roll back production' };
  let made;
  try {
    made = await writeTask(db, principal, { op: 'put', id: newId, data: card, what: `rollback of ${c.key} requested by ${who}` });
  } catch (err) {
    // A concurrent request may have won the same primary key. Never replace its card.
    if (!(err instanceof HttpError) || err.status !== 409) throw err;
    const winner = await getTask(db, newId);
    if (!winner || winner.data.board !== board.id || winner.data.evidence?.rollbackOf !== c.key) throw err;
    return { key: winner.data.key, id: newId, version: winner.version };
  }
  const history = [...(Array.isArray(c.history) ? c.history : []), { at, by: principal, what: `rollback requested: ${key}` }].slice(-200);
  // The new card already exists, so a lost race on the source card's history must not read as a failed rollback.
  try {
    await writeTask(db, principal, { op: 'patch', id, ifVersion: doc.version, data: { history, updated: at, updatedBy: principal }, what: `rollback requested: ${key}` });
  } catch (err) {
    return { key, id: newId, version: made.version, note: `${key} was created, but ${c.key} did not get its history line (${str(err && err.message).slice(0, 120)})` };
  }
  return { key, id: newId, version: made.version };
}
