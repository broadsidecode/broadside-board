// D1 access for boards, tasks, counters and the history log. Every write bumps version, sets
// updated_at and appends a history_log row, in one D1 batch (one transaction).
import { actorLabel, applyAskRule, columns, isRollbackProblem, mergeCard, priorityNumber, readOnlyProblem, stampCard, validateCard, validateBoard, writeProblem } from './lib.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const nowIso = () => new Date().toISOString();

// The read only guard (). w null is a board, counter or pause write: Owner only.
function readOnly(who, w, opts = {}, existing = null) {
  const denied = readOnlyProblem(who, w, opts, existing);
  if (denied) throw new HttpError(403, denied, w && w.id ? { id: w.id } : {});
}

function rowToDoc(row) {
  if (!row) return null;
  return { id: row.id, version: row.version, updated_at: row.updated_at, data: JSON.parse(row.data) };
}

export async function listBoards(db) {
  const { results } = await db.prepare('SELECT * FROM board_boards ORDER BY id').all();
  return results.map(rowToDoc);
}

export async function getBoard(db, id) {
  return rowToDoc(await db.prepare('SELECT * FROM board_boards WHERE id = ?').bind(id).first());
}

export async function listTasks(db, f = {}) {
  const where = [];
  const args = [];
  for (const k of ['board', 'status', 'kind', 'lane', 'key']) {
    if (f[k]) { where.push(`${k} = ?`); args.push(f[k]); }
  }
  const sql = `SELECT * FROM board_tasks${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id`;
  const { results } = await db.prepare(sql).bind(...args).all();
  return results.map(rowToDoc);
}

export async function getTask(db, id) {
  return rowToDoc(await db.prepare('SELECT * FROM board_tasks WHERE id = ?').bind(id).first());
}

export async function getTaskByKey(db, key) {
  return rowToDoc(await db.prepare('SELECT * FROM board_tasks WHERE key = ? ORDER BY id LIMIT 1').bind(key).first());
}

function historyStmt(db, at, who, taskId, what) {
  return db.prepare('INSERT INTO board_history_log (at, who, task_id, what) VALUES (?, ?, ?, ?)').bind(at, who, taskId, what);
}

// Build the statements for one task write. Existing rows update only when the stored version still
// equals ifVersion: otherwise version becomes NULL, the NOT NULL constraint fails and the whole batch
// rolls back. New rows insert; a primary key clash also rolls the batch back.
async function taskWriteStatements(db, who, w, opts = {}) {
  const at = nowIso();
  const existing = await getTask(db, w.id);
  // Read only for everyone but Owner, except an approval request (lib.js readOnlyProblem). Runs before every other rule.
  readOnly(who, w, opts, existing ? existing.data : null);
  if (w.op === 'delete') {
    if (!existing) throw new HttpError(404, `no task ${w.id}`);
    if (opts.scope && existing.data.board !== opts.scope) throw new HttpError(403, `this token is bound to board ${opts.scope}`, { id: w.id });
    if (w.ifVersion === undefined || w.ifVersion === null || Number(w.ifVersion) !== existing.version) {
      throw new HttpError(409, 'version mismatch', { id: w.id, currentVersion: existing.version });
    }
    return {
      stmts: [
        // Guard: fails the batch if the row changed since it was read.
        db.prepare('UPDATE board_tasks SET version = CASE WHEN version = ? THEN version ELSE NULL END WHERE id = ?').bind(existing.version, w.id),
        db.prepare('DELETE FROM board_tasks WHERE id = ?').bind(w.id),
        historyStmt(db, at, who, w.id, `deleted (was version ${existing.version})`),
      ],
      result: { id: w.id, deleted: true },
    };
  }
  let card;
  if (w.op === 'patch') {
    if (!existing) throw new HttpError(404, `no task ${w.id}`);
    card = mergeCard(existing.data, w.data);
  } else {
    card = w.data;
  }
  // Imports at a seeded version keep the card exactly as exported; everything else is stamped. An import
  // only ever creates a card, and it passes the same guard as every other write (review finding 1).
  if (opts.seedVersion && existing) throw new HttpError(409, 'seedVersion only imports a card that does not exist yet', { id: w.id, currentVersion: existing.version });
  if (!opts.seedVersion) {
    const asked = applyAskRule(existing ? existing.data : null, card, who, at);
    if (asked.problem) throw new HttpError(400, asked.problem, { id: w.id });
    card = stampCard(existing ? existing.data : null, asked.card, who, opts);
    // Priority words (urgent, normal, low) are accepted on every route and stored as the number.
    if (card.priority !== undefined && card.priority !== null) card.priority = priorityNumber(card.priority);
  }
  // the one guard every route passes through (lib.js writeProblem).
  const denied = writeProblem(existing ? existing.data : null, card, who, opts);
  if (denied) throw new HttpError(isRollbackProblem(denied) ? 422 : 403, denied, { id: w.id });
  const problem = validateCard(card);
  if (problem) throw new HttpError(400, problem, { id: w.id });
  const c = columns(card);
  const json = JSON.stringify(card);
  if (existing) {
    if (w.ifVersion === undefined || w.ifVersion === null) {
      throw new HttpError(409, 'ifVersion is required for an existing task', { id: w.id, currentVersion: existing.version });
    }
    if (Number(w.ifVersion) !== existing.version) {
      throw new HttpError(409, 'version mismatch', { id: w.id, currentVersion: existing.version });
    }
    const next = existing.version + 1;
    return {
      stmts: [
        db.prepare(`UPDATE board_tasks SET board = ?, key = ?, status = ?, kind = ?, lane = ?, data = ?,
            version = CASE WHEN version = ? THEN version + 1 ELSE NULL END, updated_at = ? WHERE id = ?`)
          .bind(c.board, c.key, c.status, c.kind, c.lane, json, existing.version, at, w.id),
        historyStmt(db, at, who, w.id, w.what || `${w.op} to version ${next}`),
      ],
      result: { id: w.id, version: next, updated_at: at },
    };
  }
  if (w.op === 'patch') throw new HttpError(404, `no task ${w.id}`);
  const version = opts.seedVersion ? Number(opts.seedVersion) : 1;
  if (!Number.isInteger(version) || version < 1) throw new HttpError(400, 'seedVersion must be a positive integer');
  const stmts = [
    db.prepare('INSERT INTO board_tasks (id, board, key, status, kind, lane, data, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(w.id, c.board, c.key, c.status, c.kind, c.lane, json, version, at),
  ];
  if (opts.importHistory && Array.isArray(card.history)) {
    for (const h of card.history) {
      stmts.push(historyStmt(db, String((h && h.at) || at), String((h && h.by) || 'unknown'), w.id, String((h && h.what) || '').slice(0, 2000)));
    }
  }
  stmts.push(historyStmt(db, at, who, w.id, w.what || (opts.seedVersion ? `imported at version ${version}` : 'created at version 1')));
  return { stmts, result: { id: w.id, version, updated_at: at, created: true } };
}

async function runBatch(db, stmts, conflictIds) {
  try {
    await db.batch(stmts);
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (/NOT NULL constraint failed: board_tasks\.version|UNIQUE constraint failed|PRIMARY KEY/i.test(msg)) {
      const current = {};
      for (const id of conflictIds) {
        const t = await getTask(db, id);
        current[id] = t ? t.version : null;
      }
      throw new HttpError(409, 'a document changed during the write; nothing was written', { currentVersions: current });
    }
    throw err;
  }
}

export async function writeTask(db, who, w, opts = {}) {
  const { stmts, result } = await taskWriteStatements(db, who, w, opts);
  await runBatch(db, stmts, [w.id]);
  return result;
}

export async function writeBatch(db, who, writes, canDelete, opts = {}) {
  if (!Array.isArray(writes) || !writes.length) throw new HttpError(400, 'writes must be a non-empty array');
  if (writes.length > 50) throw new HttpError(400, 'at most 50 writes per batch');
  const ids = new Set();
  const all = [];
  const results = [];
  for (const w of writes) {
    if (!w || !['put', 'patch', 'delete'].includes(w.op) || !w.id) throw new HttpError(400, 'each write needs op put|patch|delete and id');
    if (ids.has(w.id)) throw new HttpError(400, `task ${w.id} appears twice in the batch`);
    ids.add(w.id);
    if (w.op === 'delete' && !canDelete) throw new HttpError(403, 'delete is for worker and owner only');
    if (w.op !== 'delete' && !w.data) throw new HttpError(400, `write for ${w.id} needs data`);
    const { stmts, result } = await taskWriteStatements(db, who, w, { scope: opts.scope || '' });
    all.push(...stmts);
    results.push(result);
  }
  await runBatch(db, all, [...ids]);
  return results;
}

// the pause switch lives on the board record and changes only through setBoardPaused (the pause_board
// tool, Owner and the connectors that speak for him). A board write keeps whatever pause state is stored.
const PAUSE_FIELDS = ['paused', 'pauseSetBy', 'pauseSetAt', 'pauseReason'];
const pauseOf = (doc) => Object.fromEntries(PAUSE_FIELDS.filter((k) => doc && doc.data && doc.data[k] !== undefined).map((k) => [k, doc.data[k]]));
export const isBoardPaused = (doc) => Boolean(doc && doc.data && doc.data.paused === true);
export async function boardPaused(db, id) {
  return isBoardPaused(await getBoard(db, id));
}

export async function setBoardPaused(db, who, id, paused, reason = '') {
  readOnly(who, null);
  if (typeof paused !== 'boolean') throw new HttpError(400, 'paused must be true or false');
  const existing = await getBoard(db, id);
  if (!existing) throw new HttpError(404, `no board ${id}`);
  const at = nowIso();
  const why = String(reason || '').trim().slice(0, 300);
  const data = { ...existing.data, paused, pauseSetBy: who, pauseSetAt: at, pauseReason: why };
  const what = `board ${paused ? 'paused' : 'resumed'} by ${actorLabel(who)}${why ? `: ${why}` : ''}`;
  const res = await db.batch([
    db.prepare('UPDATE board_boards SET data = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?')
      .bind(JSON.stringify(data), at, id, existing.version),
    // Logged only when the guarded update above took effect, so a lost race leaves no history line.
    db.prepare('INSERT INTO board_history_log (at, who, task_id, what) SELECT ?, ?, ?, ? WHERE changes() > 0').bind(at, who, `board:${id}`, what),
  ]);
  if (!res[0].meta.changes) throw new HttpError(409, 'version changed during the write', { id });
  return { board: id, paused, pauseSetBy: who, pauseSetAt: at, pauseReason: why, version: existing.version + 1 };
}

export async function putBoard(db, who, id, body, canSeed) {
  readOnly(who, null);
  const existing = await getBoard(db, id);
  const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data)
    ? { ...Object.fromEntries(Object.entries(body.data).filter(([k]) => !PAUSE_FIELDS.includes(k))), ...pauseOf(existing) }
    : body.data;
  const problem = validateBoard(data);
  if (problem) throw new HttpError(400, problem);
  const at = nowIso();
  if (existing) {
    if (body.ifVersion === undefined || Number(body.ifVersion) !== existing.version) {
      throw new HttpError(409, 'version mismatch', { id, currentVersion: existing.version });
    }
    const res = await db.batch([
      db.prepare('UPDATE board_boards SET data = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?')
        .bind(JSON.stringify(data), at, id, existing.version),
      historyStmt(db, at, who, `board:${id}`, `board set to version ${existing.version + 1}`),
    ]);
    if (!res[0].meta.changes) throw new HttpError(409, 'version changed during the write', { id });
    return { id, version: existing.version + 1, updated_at: at };
  }
  if (body.seedVersion !== undefined && !canSeed) throw new HttpError(403, 'seedVersion is for worker and owner only');
  const version = body.seedVersion !== undefined ? Number(body.seedVersion) : 1;
  await db.batch([
    db.prepare('INSERT INTO board_boards (id, data, version, updated_at) VALUES (?, ?, ?, ?)').bind(id, JSON.stringify(data), version, at),
    historyStmt(db, at, who, `board:${id}`, `board created at version ${version}`),
  ]);
  return { id, version, updated_at: at, created: true };
}

// add_board: a new tab and its ticket counter, made together in one batch.
// It never changes an existing tab or counter, and a prefix already used by a tab or a counter is refused, so
// a new tab can never share or reset another tab's ticket numbers. Owner and Agent only (opts.tab).
export async function createBoard(db, who, id, data) {
  readOnly(who, null, { tab: true });
  const problem = validateBoard(data);
  if (problem) throw new HttpError(400, problem);
  const prefix = String(data.prefix || '');
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(prefix)) throw new HttpError(400, 'prefix must be 2 to 10 capital letters or digits, starting with a letter');
  if (await getBoard(db, id)) throw new HttpError(409, `board ${id} already exists`);
  if (await db.prepare('SELECT id FROM board_counters WHERE id = ?').bind(prefix).first()) throw new HttpError(409, `ticket prefix ${prefix} already has a counter`);
  const clash = (await listBoards(db)).find((b) => b.data && b.data.prefix === prefix);
  if (clash) throw new HttpError(409, `ticket prefix ${prefix} is already used by board ${clash.id}`);
  const at = nowIso();
  // A plain INSERT on both primary keys: a racing create fails the whole batch instead of overwriting.
  await db.batch([
    db.prepare('INSERT INTO board_boards (id, data, version, updated_at) VALUES (?, ?, ?, ?)').bind(id, JSON.stringify(data), 1, at),
    db.prepare('INSERT INTO board_counters (id, next, version) VALUES (?, ?, ?)').bind(prefix, 1, 1),
    historyStmt(db, at, who, `board:${id}`, `board created by ${actorLabel(who)} with prefix ${prefix}`),
    historyStmt(db, at, who, `counter:${prefix}`, 'counter created at 1, version 1'),
  ]);
  return { id, prefix, version: 1, counter: { id: prefix, next: 1 }, created: true, by: who };
}

export async function listCounters(db) {
  const { results } = await db.prepare('SELECT * FROM board_counters ORDER BY id').all();
  return results;
}

// Atomic: one UPDATE ... RETURNING takes the number and bumps the counter.
export async function nextNumber(db, who, prefix, opts = {}) {
  readOnly(who, null, opts);
  const at = nowIso();
  const exists = await db.prepare('SELECT id FROM board_counters WHERE id = ?').bind(prefix).first();
  if (!exists) throw new HttpError(404, `no counter ${prefix}`);
  const res = await db.batch([
    db.prepare('UPDATE board_counters SET next = next + 1, version = version + 1 WHERE id = ? RETURNING next - 1 AS number, version')
      .bind(prefix),
    historyStmt(db, at, who, `counter:${prefix}`, 'took the next number'),
  ]);
  const row = res[0].results && res[0].results[0];
  if (!row) throw new HttpError(404, `no counter ${prefix}`);
  return { prefix, number: row.number, version: row.version };
}

export async function putCounter(db, who, prefix, body) {
  readOnly(who, null);
  const next = Number(body.next);
  if (!Number.isInteger(next) || next < 1) throw new HttpError(400, 'next must be a positive integer');
  const at = nowIso();
  const existing = await db.prepare('SELECT * FROM board_counters WHERE id = ?').bind(prefix).first();
  if (existing) {
    if (body.ifVersion === undefined || Number(body.ifVersion) !== existing.version) {
      throw new HttpError(409, 'version mismatch', { id: prefix, currentVersion: existing.version });
    }
    if (next < existing.next) throw new HttpError(400, 'a counter never moves backwards');
    await db.batch([
      db.prepare('UPDATE board_counters SET next = ?, version = version + 1 WHERE id = ? AND version = ?').bind(next, prefix, existing.version),
      historyStmt(db, at, who, `counter:${prefix}`, `counter set to ${next}`),
    ]);
    return { id: prefix, next, version: existing.version + 1 };
  }
  const version = body.seedVersion !== undefined ? Number(body.seedVersion) : 1;
  await db.batch([
    db.prepare('INSERT INTO board_counters (id, next, version) VALUES (?, ?, ?)').bind(prefix, next, version),
    historyStmt(db, at, who, `counter:${prefix}`, `counter created at ${next}, version ${version}`),
  ]);
  return { id: prefix, next, version, created: true };
}

// The activity feed: every write the service took, newest first, across every board, with the card's
// key, board and title joined in (blank when the card was deleted). since is an ISO time; limit caps rows.
export async function listActivity(db, { since = '', limit = 100, board = '' } = {}) {
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  const { results } = await db.prepare(
    'SELECT l.at, l.who, l.task_id, l.what, t.data FROM board_history_log l LEFT JOIN board_tasks t ON t.id = l.task_id'
    + ' WHERE (? = \'\' OR l.at > ?) ORDER BY l.id DESC LIMIT ?').bind(since, since, n).all();
  const out = [];
  for (const r of results || []) {
    let c = null;
    try { c = r.data ? JSON.parse(r.data) : null; } catch { c = null; }
    if (board && (!c || c.board !== board)) continue;
    out.push({ at: r.at, who: r.who, taskId: r.task_id || '', key: c ? c.key || '' : '', board: c ? c.board || '' : '', title: c ? c.title || '' : '', what: r.what });
  }
  return out;
}

// service tokens bound to one board, added without a Worker redeploy (the new customer command
// writes a row through PUT /principals/:clientId). SERVICE_PRINCIPALS in wrangler.toml is read first.
export async function principalForClient(db, clientId) {
  if (!clientId) return '';
  try {
    const row = await db.prepare('SELECT principal, board FROM board_principals WHERE client_id = ?').bind(clientId).first();
    return row ? (row.board ? `${row.principal}@${row.board}` : row.principal) : '';
  } catch { return ''; }
}
export async function putPrincipal(db, who, clientId, { principal, board, note }) {
  if (!/^(?:[a-f0-9]{32}\.access|tok_[a-f0-9]{64})$/.test(String(clientId))) throw new HttpError(400, 'client id must look like <32 hex>.access or tok_<64 hex>');
  if (!/^[a-z][a-z0-9-]*$/.test(String(principal || ''))) throw new HttpError(400, 'principal must be a plain name such as cloud-worker');
  // The tab may not exist yet while a new customer is set up; a binding can name it in advance.
  if (board && !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(String(board))) throw new HttpError(400, 'board must be a board id such as harbor-cafe');
  const at = nowIso();
  await db.prepare('INSERT INTO board_principals (client_id, principal, board, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET principal = excluded.principal, board = excluded.board, note = excluded.note, created_at = excluded.created_at, created_by = excluded.created_by')
    .bind(clientId, principal, board || '', String(note || '').slice(0, 300), at, who).run();
  return { clientId, principal, board: board || '', at };
}

export async function historyFor(db, taskId, limit = 200) {
  const { results } = await db.prepare('SELECT at, who, task_id, what FROM board_history_log WHERE task_id = ? ORDER BY id DESC LIMIT ?')
    .bind(taskId, limit).all();
  return results;
}
