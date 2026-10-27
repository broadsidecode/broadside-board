// Board Pulse: the MCP call log, the four read panels (connections, stream, stuck, claims) and the claims
// checker. One table, board_mcp_calls, in the shared operations database. Both MCP Workers write it (the board
// here, the start webhook through its own tiny copy of logCall), the board Worker reads it, and a scheduled
// handler (every ten minutes) checks the evidence replies and comments cite. Pulse sees MCP traffic and board
// state only. Nothing here comments on a card: a false claim shows in Pulse and nowhere else.
import { lastTouch } from './lib.js';

// Module switch. The standalone kit turns Pulse off by default and rewrites this one line to read its config.
import { MODULES } from './config.js';
export function pulseEnabled(env) {
  let mods = MODULES;
  try { if (env && env.BOARD_MODULES) mods = JSON.parse(env.BOARD_MODULES); } catch { /* the compiled modules stay */ }
  return Boolean(mods && mods.pulse);
}
// Whether the claims checker may fetch any https URL. The kit limits it to GitHub and Pages.
export const CLAIM_ANY_URL = false;

export const RETENTION_DAYS = 30;
// First guess thresholds, agreed with the owner. Change them here and in the handbook together.
export const STUCK = { claimedMin: 20, cardHours: 2, deliveredGraceMin: 1, unpickedMin: 5, askHours: 24 };
export const DOT = { greenMin: 10, amberMin: 60 };
// Tools whose text carries a claim: a board comment and a project's reply over the line's project API.
export const CLAIM_TOOLS = ['add_comment', 'api.reply'];
export const STREAM_MAX = 200;
const WORDS_MAX = 1500;
const CLAIM_BATCH = 40;
const FETCH_BUDGET = 40;
const MIN = 60000;
const HOUR = 3600000;

const iso = (ms) => new Date(ms).toISOString();
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

// ------------------------------------------------------------------------------------------ the log

// The card key, project id, message id, board or session a tool call was about, as one short string.
export function callTarget(args) {
  const a = args && typeof args === 'object' ? args : {};
  for (const k of ['key', 'id', 'project', 'board', 'session']) {
    if (typeof a[k] === 'string' && a[k]) return clip(a[k], 80);
  }
  return '';
}

// One row per finished call. Never throws: a log failure must not break the call it describes.
// A call that carries words (a comment, a reply) keeps them in claim_detail, cut to 1500 characters, until the
// claims checker reads them and writes its one line verdict over them. The row then needs no join to find its words.
export async function logCall(env, row) {
  try {
    if (!env || !env.DB || !pulseEnabled(env)) return;
    const startedMs = Number(row.startedMs) || Date.now();
    const words = CLAIM_TOOLS.includes(row.tool) && row.outcome === 'ok' ? clip(row.words, WORDS_MAX) : '';
    await env.DB.prepare('INSERT INTO board_mcp_calls (worker, principal, tool, target, started_at, duration_ms, outcome, error, claim_detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(row.worker === 'line' ? 'line' : 'board', clip(row.principal, 80), clip(row.tool, 64), callTarget(row.args), iso(startedMs),
        Math.max(0, Date.now() - startedMs), row.outcome === 'ok' ? 'ok' : 'error', clip(row.error, 300), words).run();
  } catch (err) {
    console.error('pulse log failed', err && err.message ? err.message : String(err));
  }
}

// ------------------------------------------------------------------------------------------ helpers

function parseMap(text) {
  try { return JSON.parse(text || '{}') || {}; } catch { return {}; }
}

// A query against a table that may not exist (the kit has no line tables). Returns [] instead of throwing.
async function rows(db, sql, ...args) {
  try {
    const res = await db.prepare(sql).bind(...args).all();
    return res.results || [];
  } catch { return []; }
}

export function dotFor(lastMs, nowMs) {
  if (!lastMs) return 'grey';
  const age = nowMs - lastMs;
  if (age <= DOT.greenMin * MIN) return 'green';
  if (age <= DOT.amberMin * MIN) return 'amber';
  return 'grey';
}

// ------------------------------------------------------------------------------------------ panel 1

export async function pulseConnections(env, nowMs = Date.now()) {
  const db = env.DB;
  const names = new Set();
  for (const v of Object.values(parseMap(env.SERVICE_PRINCIPALS))) names.add(String(v));
  for (const v of Object.values(parseMap(env.EMAIL_PRINCIPALS))) names.add(String(v));
  for (const r of await rows(db, 'SELECT principal, board FROM board_principals')) names.add(r.board ? `${r.principal}@${r.board}` : r.principal);

  const hourAgo = iso(nowMs - HOUR);
  const calls = await rows(db,
    'SELECT principal, MAX(started_at) AS last, SUM(CASE WHEN started_at > ? THEN 1 ELSE 0 END) AS hour, SUM(CASE WHEN started_at > ? AND outcome = \'error\' THEN 1 ELSE 0 END) AS errors, GROUP_CONCAT(DISTINCT worker) AS workers FROM board_mcp_calls GROUP BY principal',
    hourAgo, hourAgo);
  const byName = new Map();
  for (const c of calls) { names.add(c.principal); byName.set(c.principal, c); }

  // Connector sign ins: the newest live access and refresh token per principal, from both Workers' OAuth tables.
  const tokens = new Map();
  for (const table of ['board_oauth_tokens', 'line_oauth_tokens']) {
    for (const t of await rows(db, `SELECT kind, data, expires_at FROM ${table} WHERE revoked = 0 AND expires_at > ? ORDER BY expires_at DESC LIMIT 2000`, nowMs)) {
      let p = '';
      try { p = String(JSON.parse(t.data).principal || ''); } catch { p = ''; }
      if (!p) continue;
      names.add(p);
      const cur = tokens.get(p) || { access: 0, refresh: 0 };
      if (t.kind === 'refresh') cur.refresh = Math.max(cur.refresh, Number(t.expires_at));
      else cur.access = Math.max(cur.access, Number(t.expires_at));
      tokens.set(p, cur);
    }
  }

  const out = [...names].filter(Boolean).map((principal) => {
    const c = byName.get(principal);
    const lastMs = c && c.last ? Date.parse(c.last) : 0;
    const tk = tokens.get(principal);
    const expires = tk ? Math.max(tk.refresh, tk.access) : 0;
    return {
      principal,
      lastCall: c && c.last ? c.last : '',
      callsLastHour: c ? Number(c.hour) || 0 : 0,
      errorsLastHour: c ? Number(c.errors) || 0 : 0,
      via: c && c.workers ? String(c.workers).split(',').sort() : [],
      tokenExpires: expires ? iso(expires) : '',
      accessExpires: tk && tk.access ? iso(tk.access) : '',
      dot: dotFor(lastMs, nowMs),
    };
  });
  const rank = { green: 0, amber: 1, grey: 2 };
  out.sort((a, b) => rank[a.dot] - rank[b.dot] || String(b.lastCall).localeCompare(String(a.lastCall)) || a.principal.localeCompare(b.principal));
  return { now: iso(nowMs), connections: out };
}

// ------------------------------------------------------------------------------------------ panel 2

export async function pulseStream(env, { since = 0, principal = '', limit = STREAM_MAX } = {}) {
  const after = Math.max(0, Math.floor(Number(since) || 0));
  const n = Math.max(1, Math.min(STREAM_MAX, Math.floor(Number(limit) || STREAM_MAX)));
  const who = String(principal || '');
  const res = await env.DB.prepare(
    'SELECT id, worker, principal, tool, target, started_at, duration_ms, outcome, error, claim_status FROM board_mcp_calls WHERE id > ? AND (? = \'\' OR principal = ?) ORDER BY id DESC LIMIT ?')
    .bind(after, who, who, n).all();
  const list = (res.results || []).map((r) => ({
    id: Number(r.id), worker: r.worker, principal: r.principal, tool: r.tool, target: r.target || '', at: r.started_at,
    ms: Number(r.duration_ms) || 0, outcome: r.outcome, error: r.error || '', claim: r.claim_status || '',
  }));
  return { cursor: list.length ? list[0].id : after, calls: list };
}

// ------------------------------------------------------------------------------------------ panel 3

const ageMin = (fromMs, nowMs) => Math.max(0, Math.floor((nowMs - fromMs) / MIN));
export function ageText(min) {
  if (min < 60) return `${min} min`;
  if (min < 2880) return `${Math.floor(min / 60)} h ${min % 60} min`;
  const d = Math.floor(min / 1440);
  return `${d} days`;
}

// The five rules. Each row: rule, owner, key or id, link, age in minutes, text. Nothing is guessed from wording.
export async function pulseStuck(env, nowMs = Date.now()) {
  const db = env.DB;
  const out = [];
  const channels = new Map();
  for (const p of await rows(db, 'SELECT id, channel FROM line_projects')) if (p.channel) channels.set(p.id, `https://claude.ai/code/project/${p.channel}`);
  const projLink = (id) => channels.get(id) || '';

  // 1. A message a run claimed and never answered.
  for (const m of await rows(db, 'SELECT id, project, claimed_at, text FROM line_messages WHERE state = \'working\' AND claimed_at IS NOT NULL AND claimed_at < ? ORDER BY claimed_at LIMIT 50', iso(nowMs - STUCK.claimedMin * MIN))) {
    out.push({ rule: 'claimed_no_reply', owner: m.project, id: m.id, key: '', board: '', link: projLink(m.project), since: m.claimed_at, minutes: ageMin(Date.parse(m.claimed_at), nowMs), text: `Claimed with no reply: ${clip(m.text, 90)}` });
  }
  // 3. A message delivered to a coordinator whose delivery has no session bound.
  for (const m of await rows(db,
    'SELECT m.id, m.project, d.delivered_at, m.text FROM line_messages m JOIN line_deliveries d ON d.message_id = m.id WHERE m.state = \'delivered\' AND (d.session IS NULL OR d.session = \'\') AND d.delivered_at < ? ORDER BY d.delivered_at LIMIT 50',
    iso(nowMs - STUCK.deliveredGraceMin * MIN))) {
    out.push({ rule: 'no_session', owner: m.project, id: m.id, key: '', board: '', link: projLink(m.project), since: m.delivered_at, minutes: ageMin(Date.parse(m.delivered_at), nowMs), text: `Delivered, no coordinator session bound: ${clip(m.text, 90)}` });
  }
  // 4. A message fired and never picked up.
  for (const m of await rows(db, 'SELECT id, project, created_at, text, fire_error FROM line_messages WHERE state = \'sent\' AND created_at < ? ORDER BY created_at LIMIT 50', iso(nowMs - STUCK.unpickedMin * MIN))) {
    out.push({ rule: 'not_picked_up', owner: m.project, id: m.id, key: '', board: '', link: projLink(m.project), since: m.created_at, minutes: ageMin(Date.parse(m.created_at), nowMs), text: `Not picked up${m.fire_error ? ` (${clip(m.fire_error, 60)})` : ''}: ${clip(m.text, 80)}` });
  }
  // 2 and 5. Cards: working with no word for two hours, and an ask waiting on a person for a day.
  for (const t of await rows(db, 'SELECT id, data FROM board_tasks WHERE status != \'done\' LIMIT 2000')) {
    let c;
    try { c = JSON.parse(t.data); } catch { continue; }
    if (!c) continue;
    if (c.status === 'doing' && c.kind !== 'human') {
      const comments = Array.isArray(c.comments) ? c.comments : [];
      const lastComment = comments.length ? String(comments[comments.length - 1].at || '') : '';
      const ref = lastComment > lastTouch(c) ? lastComment : lastTouch(c);
      const refMs = Date.parse(ref);
      if (refMs && nowMs - refMs >= STUCK.cardHours * HOUR) {
        out.push({ rule: 'card_silent', owner: c.owner || c.lane || '', id: t.id, key: c.key || '', board: c.board || '', link: `/#${c.board || ''}`, since: ref, minutes: ageMin(refMs, nowMs), text: `${c.key || t.id} is in progress with no comment or change: ${clip(c.title, 80)}` });
      }
    }
    if (c.ask && c.ask.at) {
      const atMs = Date.parse(c.ask.at);
      if (atMs && nowMs - atMs >= STUCK.askHours * HOUR) {
        out.push({ rule: 'ask_waiting', owner: c.ask.to || (c.needsOwner ? 'owner' : ''), id: t.id, key: c.key || '', board: c.board || '', link: `/#${c.board || ''}`, since: c.ask.at, minutes: ageMin(atMs, nowMs), text: `${c.key || t.id} ask waiting: ${clip(c.ask.text, 90)}` });
      }
    }
  }
  out.sort((a, b) => b.minutes - a.minutes);
  return { now: iso(nowMs), thresholds: STUCK, stuck: out.slice(0, 100).map((r) => ({ ...r, age: ageText(r.minutes) })) };
}

// ------------------------------------------------------------------------------------------ panel 4

export async function pulseClaims(env) {
  const res = await env.DB.prepare(
    'SELECT id, worker, principal, tool, target, started_at, claim_status, claim_detail FROM board_mcp_calls WHERE claim_status IN (\'checked_true\', \'checked_false\', \'not_checkable\') ORDER BY id DESC LIMIT 100').all();
  return {
    claims: (res.results || []).map((r) => ({ id: Number(r.id), worker: r.worker, principal: r.principal, tool: r.tool, target: r.target || '', at: r.started_at, verdict: r.claim_status, detail: r.claim_detail || '' })),
  };
}

// Read dispatcher for the four endpoints. params is a URLSearchParams.
export async function pulseRead(env, name, params) {
  if (name === 'connections') return pulseConnections(env);
  if (name === 'stream') return pulseStream(env, { since: params.get('since'), principal: params.get('principal') || '' });
  if (name === 'stuck') return pulseStuck(env);
  return pulseClaims(env);
}

// ------------------------------------------------------------------------------------------ claims checker

// Internal names are never fetched: .internal, .local and .localhost suffixes, and the cloud metadata host.
const BLOCKED_HOST = /(^|\.)(internal|local|localhost)$|^metadata\.google\.internal$/;
const URL_RE = /https:\/\/[^\s<>"'`\])}]+/g;
const trimUrl = (u) => u.replace(/[.,;:!?]+$/, '');

// Evidence a text cites: pull requests, commits, Actions runs, Pages deployments, any other https URL.
// GitHub links of any other shape (files, issues) are not evidence and are left out.
export function extractEvidence(text, { skipHosts = [] } = {}) {
  const seen = new Set();
  const found = [];
  for (const raw of String(text || '').match(URL_RE) || []) {
    const url = trimUrl(raw);
    if (seen.has(url)) continue;
    seen.add(url);
    let u;
    try { u = new URL(url); } catch { continue; }
    if (u.protocol !== 'https:' || u.username || u.password) continue;
    const host = u.hostname.toLowerCase();
    if (skipHosts.includes(host) || BLOCKED_HOST.test(host) || /^(localhost|127\.|10\.|192\.168\.|0\.|\[)/.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host)) continue;
    let m;
    if (host === 'github.com' || host === 'www.github.com') {
      if ((m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/))) found.push({ kind: 'pr', url, owner: m[1], repo: m[2], number: Number(m[3]) });
      else if ((m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/commit\/([0-9a-fA-F]{7,40})\/?$/))) found.push({ kind: 'commit', url, owner: m[1], repo: m[2], sha: m[3] });
      else if ((m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/.*)?$/))) found.push({ kind: 'run', url, owner: m[1], repo: m[2], run: m[3] });
      continue;
    }
    if (host.endsWith('.pages.dev')) found.push({ kind: 'pages', url });
    else found.push({ kind: 'url', url });
  }
  return found.slice(0, 5);
}

const UA = 'board-pulse';
function ghHeaders(token) {
  return { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': UA };
}

// Check one cited thing. Returns { verdict: true | false | null, detail, pending? }. null means not checkable now.
export async function checkEvidence(ev, env, fetchImpl) {
  const token = env.GITHUB_MERGE_TOKEN;
  const repo = ev.owner ? `${ev.owner}/${ev.repo}` : '';
  try {
    if (ev.kind === 'pr' || ev.kind === 'commit' || ev.kind === 'run') {
      if (!token) return { verdict: null, detail: 'no GitHub read token on the Worker' };
      const path = ev.kind === 'pr' ? `pulls/${ev.number}` : ev.kind === 'commit' ? `commits/${ev.sha}` : `actions/runs/${ev.run}`;
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/${path}`, { headers: ghHeaders(token), signal: AbortSignal.timeout(6000) });
      const label = ev.kind === 'pr' ? `pull request ${ev.number}` : ev.kind === 'commit' ? `commit ${ev.sha.slice(0, 7)}` : `run ${ev.run}`;
      if (res.status === 404) return { verdict: false, detail: `${label} on ${repo} not found` };
      if (!res.ok) return { verdict: null, detail: `${label} not readable (HTTP ${res.status})` };
      const j = await res.json();
      if (ev.kind === 'pr') {
        return j.merged || j.merged_at ? { verdict: true, detail: `${label} merged` } : { verdict: false, detail: `${label} not merged (${j.state === 'closed' ? 'closed' : 'open'})` };
      }
      if (ev.kind === 'commit') return { verdict: true, detail: `${label} exists` };
      if (j.status && j.status !== 'completed') return { verdict: null, pending: true, detail: `${label} still ${j.status}` };
      return j.conclusion === 'success' ? { verdict: true, detail: `${label} green` } : { verdict: false, detail: `${label} ended ${j.conclusion || 'without a result'}` };
    }
    if (ev.kind === 'url' && !CLAIM_ANY_URL) return { verdict: null, detail: 'this kind of link is not checked' };
    const host = new URL(ev.url).hostname;
    // A redirect is never followed: any 3xx counts as an answer, so a public address that redirects to http or an internal one is never fetched.
    let res = await fetchImpl(ev.url, { method: 'HEAD', redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(6000) });
    if (res.status === 405 || res.status === 501) res = await fetchImpl(ev.url, { method: 'GET', redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(6000) });
    const label = ev.kind === 'pages' ? `deployment ${host}` : host;
    const bad = res.status === 404 || res.status === 410 || res.status >= 500;
    return bad ? { verdict: false, detail: `${label} answered HTTP ${res.status}` } : { verdict: true, detail: `${label} answers (HTTP ${res.status})` };
  } catch (err) {
    if (ev.kind === 'pr' || ev.kind === 'commit' || ev.kind === 'run') return { verdict: null, detail: `${ev.kind} check failed: ${clip(err && err.message, 60)}` };
    return { verdict: false, detail: `${new URL(ev.url).hostname} gave no answer` };
  }
}

// Verdicts for one text. status is checked_true, checked_false, not_checkable, no_evidence, or '' to retry later.
export function summarize(results) {
  if (!results.length) return { status: 'no_evidence', detail: 'no evidence cited' };
  const bad = results.filter((r) => r.verdict === false);
  const good = results.filter((r) => r.verdict === true);
  if (bad.length) return { status: 'checked_false', detail: clip(`${bad.slice(0, 2).map((r) => r.detail).join('; ')}${bad.length > 2 ? `; ${bad.length - 2} more false` : ''}${good.length ? `; ${good.length} held` : ''}`, 240) };
  if (good.length) return { status: 'checked_true', detail: clip(`${good.length} cited, all hold: ${good.slice(0, 2).map((r) => r.detail).join('; ')}`, 240) };
  return { status: 'not_checkable', detail: clip(results.map((r) => r.detail).slice(0, 2).join('; '), 240) };
}

export async function checkClaims(env, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const todo = await rows(env.DB,
    `SELECT id, principal, tool, target, started_at, claim_detail FROM board_mcp_calls WHERE claim_status IS NULL AND outcome = 'ok' AND tool IN (${CLAIM_TOOLS.map(() => '?').join(', ')}) AND started_at > ? ORDER BY id LIMIT ${CLAIM_BATCH}`,
    ...CLAIM_TOOLS, iso(nowMs - 24 * HOUR));
  const skipHosts = [env.API_HOST, env.MCP_HOST].filter(Boolean).map((h) => String(h).toLowerCase());
  // The budget is in worst case calls: a pages or url item makes a HEAD and may fall back to a GET (two calls), a
  // pull request, commit or run makes one. report.fetches counts the calls actually made, report.calls adds the
  // database queries, so the scheduled handler can size the rest of the run (scheduled.js).
  let budget = FETCH_BUDGET;
  const report = { looked: todo.length, written: 0, fetches: 0, calls: 1 };
  const counted = (url, init) => { report.fetches += 1; report.calls += 1; return fetchImpl(url, init); };
  for (const row of todo) {
    const ev = extractEvidence(row.claim_detail, { skipHosts });
    const cost = ev.reduce((n, e) => n + (e.kind === 'pr' || e.kind === 'commit' || e.kind === 'run' ? 1 : 2), 0);
    if (cost > budget) break;
    budget -= cost;
    const results = [];
    for (const e of ev) results.push(await checkEvidence(e, env, counted));
    // A run still going is looked at again on the next pass, for up to half an hour.
    if (results.some((r) => r.pending) && nowMs - Date.parse(row.started_at) < 30 * MIN) continue;
    const sum = summarize(results);
    await env.DB.prepare('UPDATE board_mcp_calls SET claim_status = ?, claim_detail = ? WHERE id = ? AND claim_status IS NULL').bind(sum.status, sum.detail, row.id).run();
    report.written += 1;
    report.calls += 1;
  }
  return report;
}

// The scheduled handler: claims, then the thirty day retention delete.
export async function runPulseCron(env, opts = {}) {
  if (!pulseEnabled(env) || !env.DB) return { skipped: true };
  const nowMs = opts.nowMs || Date.now();
  // If the checker throws, how many calls it made before that is unknown (calls null): the scheduled handler then
  // sizes the sync for the worst case.
  let claims = { looked: 0, written: 0, fetches: null, calls: null };
  try { claims = await checkClaims(env, { fetchImpl: opts.fetchImpl || fetch, nowMs }); } catch (err) { console.error('pulse claims failed', err && err.message ? err.message : String(err)); }
  let deleted = 0;
  try {
    const r = await env.DB.prepare('DELETE FROM board_mcp_calls WHERE started_at < ?').bind(iso(nowMs - RETENTION_DAYS * 24 * HOUR)).run();
    deleted = (r && r.meta && r.meta.changes) || 0;
  } catch (err) { console.error('pulse retention failed', err && err.message ? err.message : String(err)); }
  return { claims, deleted, calls: claims.calls === null ? null : claims.calls + 1 };
}
