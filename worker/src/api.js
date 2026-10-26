// The JSON API under /api/v1/, split out of index.js so tests can
// reach every route in Node (index.js also bundles the handbook text, which Node cannot import).
import { verifyAccess } from './access.js';
import { kitPrincipal, kitRoutes, mintToken } from './kitauth.js';
import { publicConfig } from './config.js';
import { principalFromClaims, WRITERS, ADMINS, isOwnerProxy, splitPrincipal, SCOPED_WORKERS } from './lib.js';
import {
  HttpError, listBoards, listTasks, getTask, getBoard, writeTask, writeBatch, putBoard, nextNumber, listCounters, putCounter, historyFor, listActivity,
  principalForClient, putPrincipal,
} from './store.js';
import { generateCard } from './generate.js';
import { approveCard } from './approve.js';
import { rollbackCard } from './rollback.js';
import { startRun, mentionRun } from './run.js';
import { buildSnapshot } from './snapshot.js';
import { syncBoard } from './sync.js';

export const TEXT_HEADERS = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };

export const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

export function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

export function parseMap(text) {
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}

export async function readJson(request) {
  const text = await request.text();
  if (text.length > 1024 * 1024) throw new HttpError(413, 'body too large');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'body must be JSON'); }
}

// Verified Access assertion to {principal, scope}, or a 403 Response. A service token maps through
// SERVICE_PRINCIPALS first, then the board_principals table. "<name>@<board>" binds it to one board
//; a customer worker (cloud-worker, github-actions) without a board is refused outright.
async function resolvePrincipal(claims, env) {
  let raw = principalFromClaims(claims, parseMap(env.EMAIL_PRINCIPALS), parseMap(env.SERVICE_PRINCIPALS));
  if (!raw) return { denied: json(403, { error: 'no principal in the Access assertion' }) };
  if (raw.startsWith('service:')) { const row = await principalForClient(env.DB, String(claims.common_name || '')); if (row) raw = row; }
  if (raw.startsWith('service:')) return { denied: json(403, { error: 'this service token is not mapped to a principal on the board' }) };
  const { principal, scope } = splitPrincipal(raw);
  if (SCOPED_WORKERS.includes(principal) && !scope) {
    return { denied: json(403, { error: `${principal} token is not bound to a board; bind each worker token to one board as name@board` }) };
  }
  return { principal, scope };
}
export async function accessPrincipal(request, env) {
  if (env.AUTH_MODE === 'owner-password') return kitPrincipal(request, env);
  const claims = await verifyAccess(request.headers.get('cf-access-jwt-assertion'),
    { team: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD });
  if (!claims) return { denied: json(403, { error: 'a valid Cloudflare Access assertion is required' }) };
  return resolvePrincipal(claims, env);
}

export function textResponse(body, request) {
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers: TEXT_HEADERS });
}

// ------------------------------------------------------------------------------------------ API
// testClaims is passed only by tests (tests/board-routes.test.js); index.js never passes it.
export async function handleApi(request, env, url, testClaims) {
  const path = url.pathname.replace(/^\/api\/v1/, '') || '/';
  if (path === '/health' && request.method === 'GET') {
    return json(200, { ok: true, service: 'board-kit', version: '1.0.0' });
  }
  if (path === '/config' && request.method === 'GET') return json(200, publicConfig(env));
  if (env.AUTH_MODE === 'owner-password') { const kr = await kitRoutes(request, env, path, readJson); if (kr) return kr; }
  const who = testClaims ? await resolvePrincipal(testClaims, env) : await accessPrincipal(request, env);
  if (who.denied) return who.denied;
  const { principal, scope } = who;
  const canWrite = WRITERS.includes(principal);
  const isAdmin = ADMINS.includes(principal);
  const db = env.DB;
  const m = request.method;
  const needWrite = () => { if (!canWrite) throw new HttpError(403, `${principal} may read but not write`); };
  // A board-bound token sees and touches its own board only. Asking for another board is refused.
  const boardFor = (asked) => {
    if (!scope) return asked || '';
    if (asked && asked !== scope) throw new HttpError(403, `this token is bound to board ${scope}`);
    return scope;
  };
  const ownCard = (t) => { if (scope && t && t.data && t.data.board !== scope) throw new HttpError(403, `this token is bound to board ${scope}`); return t; };
  let seg;

  if (path === '/snapshot' && m === 'GET') {
    // Everything in one plain text read for bots; see snapshot.js. ?board= limits it, ?github=0 skips the cross check.
    return textResponse(await buildSnapshot(env, principal, {
      board: boardFor(url.searchParams.get('board') || ''),
      github: url.searchParams.get('github') !== '0',
    }), request);
  }
  if (path === '/tokens' && m === 'POST' && env.AUTH_MODE === 'owner-password') {
    if (!isAdmin) throw new HttpError(403, 'minting a token is for the owner only');
    return json(200, await mintToken(env, principal, await readJson(request)));
  }
  if (path === '/whoami' && m === 'GET') return json(200, { principal, scope, canWrite, isAdmin });
  if (path === '/principals' && m === 'GET') {
    if (!isAdmin) throw new HttpError(403, 'principals are for worker and owner only');
    const { results } = await db.prepare('SELECT client_id, principal, board, note, created_at, created_by FROM board_principals ORDER BY created_at').all();
    return json(200, { principals: results });
  }
  if ((seg = path.match(/^\/principals\/([a-f0-9]{32}\.access)$/)) && m === 'PUT') {
    // Binds a service token to a principal and, for customer workers, one board. Admins only.
    if (!isAdmin) throw new HttpError(403, 'binding a token is for worker and owner only');
    return json(200, await putPrincipal(db, principal, seg[1], await readJson(request)));
  }
  if (path === '/sync' && m === 'POST') {
    // The Sync button: make every card with a pull request agree with GitHub. Body {board, dry}. Writers only.
    needWrite();
    const body = await readJson(request).catch(() => ({}));
    return json(200, await syncBoard(env, db, principal, { board: boardFor(body && body.board ? String(body.board) : ''), scope, dry: !!(body && body.dry) }));
  }
  if (path === '/activity' && m === 'GET') {
    // The feed of every write, newest first: ?since=<ISO> for what changed since you last looked, ?limit=, ?board=.
    const entries = await listActivity(db, { since: url.searchParams.get('since') || '', limit: url.searchParams.get('limit') || 100, board: boardFor(url.searchParams.get('board') || '') });
    return json(200, { count: entries.length, entries });
  }
  if (path === '/boards' && m === 'GET') return json(200, { boards: (await listBoards(db)).filter((b) => !scope || b.id === scope) });
  if ((seg = path.match(/^\/boards\/([A-Za-z0-9_.-]{1,80})$/)) && m === 'PUT') {
    needWrite();
    if (scope) throw new HttpError(403, 'a board-bound token cannot change boards');
    return json(200, await putBoard(db, principal, seg[1], await readJson(request), isAdmin));
  }
  if (path === '/tasks' && m === 'GET') {
    const f = Object.fromEntries(['board', 'status', 'kind', 'lane', 'key'].map((k) => [k, url.searchParams.get(k) || '']));
    f.board = boardFor(f.board);
    const tasks = await listTasks(db, f);
    return json(200, { count: tasks.length, tasks });
  }
  if ((seg = path.match(/^\/tasks\/([A-Za-z0-9_.:@+~-]{1,200})\/approve$/)) && m === 'POST') {
    // The one approval path (merge, go, answer, decide): Owner and the connectors that speak for him.
    return json(200, await approveCard(env, db, principal, seg[1], await readJson(request)));
  }
  if ((seg = path.match(/^\/tasks\/([A-Za-z0-9_.:@+~-]{1,200})\/rollback$/)) && m === 'POST') {
    // Undo a card: a new urgent card written from its evidence.rollback. Owner and the connectors that speak for him.
    return json(200, await rollbackCard(db, principal, seg[1]));
  }
  if (path === '/tasks/batch' && m === 'POST') {
    needWrite();
    const body = await readJson(request);
    return json(200, { results: await writeBatch(db, principal, body.writes, isAdmin || isOwnerProxy(principal), { scope }) });
  }
  if ((seg = path.match(/^\/tasks\/([A-Za-z0-9_.:@+~-]{1,200})(\/history)?$/))) {
    const id = seg[1];
    if (seg[2] && m === 'GET') {
      if (scope) { const t = ownCard(await getTask(db, id)); if (!t) return json(404, { error: `no task ${id}` }); }
      return json(200, { id, history: await historyFor(db, id) });
    }
    if (!seg[2] && m === 'GET') {
      const t = ownCard(await getTask(db, id));
      return t ? json(200, t) : json(404, { error: `no task ${id}` });
    }
    if (!seg[2] && m === 'PUT') {
      needWrite();
      const body = await readJson(request);
      if (body.seedVersion !== undefined && !isAdmin) throw new HttpError(403, 'seedVersion is for worker and owner only');
      return json(200, await writeTask(db, principal, { op: 'put', id, data: body.data, ifVersion: body.ifVersion },
        { seedVersion: body.seedVersion, importHistory: isAdmin && body.importHistory === true, scope }));
    }
    if (!seg[2] && m === 'PATCH') {
      needWrite();
      const body = await readJson(request);
      if (body.ifVersion === undefined) throw new HttpError(400, 'ifVersion is required');
      const r = await writeTask(db, principal, { op: 'patch', id, data: body.data, ifVersion: body.ifVersion }, { scope });
      // A nudge from the page starts the board's cloud run (run.js); the result rides along on the response.
      const started = body.data && body.data.nudgedAt ? await startRun(env, db, principal, id) : null;
      // A comment with an @name wakes that agent's project (run.js mentionRun).
      const woke = body.data && Array.isArray(body.data.comments) ? await mentionRun(env, db, principal, id) : null;
      return json(200, { ...r, ...(started || {}), ...(woke ? { mention: woke } : {}) });
    }
    if (!seg[2] && m === 'DELETE') {
      if (!isAdmin && !isOwnerProxy(principal)) throw new HttpError(403, 'delete is for Owner, the connectors that speak for him, and worker');
      const v = url.searchParams.get('ifVersion');
      return json(200, await writeTask(db, principal, { op: 'delete', id, ifVersion: v === null ? undefined : Number(v) }));
    }
  }
  if (path === '/generate' && m === 'POST') {
    needWrite();
    const gen = await readJson(request);
    if (scope) gen.board = boardFor(gen && gen.board ? String(gen.board) : '');
    return json(200, await generateCard(env, principal, gen));
  }
  const scopePrefix = async () => { const b = scope ? await getBoard(db, scope) : null; return b && b.data ? String(b.data.prefix || '') : ''; };
  if (path === '/counters' && m === 'GET') {
    const pre = await scopePrefix();
    return json(200, { counters: (await listCounters(db)).filter((c) => !scope || c.id === pre) });
  }
  if ((seg = path.match(/^\/counters\/([A-Z][A-Z0-9]{1,9})\/next$/)) && m === 'POST') {
    needWrite();
    if (scope && seg[1] !== await scopePrefix()) throw new HttpError(403, `this token is bound to board ${scope}`);
    // The repository workflow takes a number only for the main guard's approval card (lib.js readOnlyProblem).
    return json(200, await nextNumber(db, principal, seg[1], { approvalCard: principal === 'github-actions' }));
  }
  if ((seg = path.match(/^\/counters\/([A-Z][A-Z0-9]{1,9})$/)) && m === 'PUT') {
    if (!isAdmin) throw new HttpError(403, 'setting a counter is for worker and owner only');
    return json(200, await putCounter(db, principal, seg[1], await readJson(request)));
  }
  return json(404, { error: 'not found' });
}

