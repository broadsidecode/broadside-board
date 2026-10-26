// Owner password and token sign in for the board kit. Used when AUTH_MODE is owner-password; with AUTH_MODE
// access the Cloudflare Access path in api.js is used instead and none of this runs.
//
//   Owner:  one secret. Its SHA-256 is the Worker secret OWNER_SECRET_HASH. The same secret is the page
//           password (POST /api/v1/login sets a signed HttpOnly cookie) and a bearer token for scripts.
//   Agents: extra bearer tokens, minted by the owner (POST /api/v1/tokens). Only the SHA-256 is stored, in
//           board_principals under the client id tok_<sha256>, so a token can be bound to one board.
//   Cookie: owner.<expiry>.<hmac>, signed with OAUTH_TOKEN_SIGNING_KEY. Cookie writes also need a same origin
//           Origin header, on top of SameSite Strict.
import { HttpError, principalForClient, putPrincipal } from './store.js';
import { splitPrincipal } from './lib.js';
import { SCOPED_WORKERS, WRITERS } from './config.js';

const enc = new TextEncoder();
const COOKIE = 'board_session';
const SESSION_S = 30 * 24 * 3600;
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(text) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(String(text))));
}
async function hmacHex(key, text) {
  const k = await crypto.subtle.importKey('raw', enc.encode(String(key)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(String(text))));
}
export function constantEqual(a, b) {
  const x = String(a);
  const y = String(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return d === 0;
}

const jsonRes = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});

function cookieValue(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

async function makeCookie(env) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_S;
  const sig = await hmacHex(env.OAUTH_TOKEN_SIGNING_KEY, `session|owner|${exp}`);
  return `${COOKIE}=owner.${exp}.${sig}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_S}`;
}
async function cookiePrincipal(request, env) {
  const v = cookieValue(request, COOKIE);
  const m = v.match(/^owner\.(\d{9,12})\.([0-9a-f]{64})$/);
  if (!m || !env.OAUTH_TOKEN_SIGNING_KEY) return '';
  if (Number(m[1]) < Math.floor(Date.now() / 1000)) return '';
  return constantEqual(await hmacHex(env.OAUTH_TOKEN_SIGNING_KEY, `session|owner|${m[1]}`), m[2]) ? 'owner' : '';
}

// Wrong passwords: at most 10 a minute per address in one Worker isolate. A real brute force would hit many
// isolates, so the secret must be long; setup.js generates one and says so.
const failures = new Map();
function throttled(ip) {
  const now = Date.now();
  const list = (failures.get(ip) || []).filter((t) => now - t < 60000);
  failures.set(ip, list);
  return list.length >= 10;
}

// {principal, scope} or {denied: Response}.
export async function kitPrincipal(request, env) {
  const deny = (msg) => ({ denied: jsonRes(401, { error: msg }) });
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.match(/^Bearer\s+(\S+)$/i);
  if (bearer) {
    const h = await sha256Hex(bearer[1]);
    if (env.OWNER_SECRET_HASH && constantEqual(h, env.OWNER_SECRET_HASH)) return { principal: 'owner', scope: '' };
    const raw = await principalForClient(env.DB, `tok_${h}`);
    if (raw) {
      const { principal, scope } = splitPrincipal(raw);
      if (SCOPED_WORKERS.includes(principal) && !scope) return { denied: jsonRes(403, { error: `${principal} token is not bound to a board` }) };
      return { principal, scope };
    }
    return deny('that token is not valid');
  }
  const who = await cookiePrincipal(request, env);
  if (who) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      const origin = request.headers.get('origin');
      if (origin && new URL(origin).host !== new URL(request.url).host) return { denied: jsonRes(403, { error: 'cross site writes are not allowed' }) };
    }
    return { principal: who, scope: '' };
  }
  return deny('sign in with the owner password or send a bearer token');
}

// Routes that exist only in the kit. Returns a Response, or null when the path is not one of them.
// path is the part after /api/v1.
export async function kitRoutes(request, env, path, readJson) {
  const m = request.method;
  if (path === '/login' && m === 'POST') {
    const ip = request.headers.get('cf-connecting-ip') || 'local';
    if (throttled(ip)) return jsonRes(429, { error: 'too many wrong passwords, wait a minute' });
    const body = await readJson(request);
    const ok = env.OWNER_SECRET_HASH && env.OAUTH_TOKEN_SIGNING_KEY && typeof body.password === 'string'
      && constantEqual(await sha256Hex(body.password), env.OWNER_SECRET_HASH);
    if (!ok) { failures.set(ip, [...(failures.get(ip) || []), Date.now()]); return jsonRes(401, { error: 'that password is not right' }); }
    return jsonRes(200, { ok: true, principal: 'owner' }, { 'set-cookie': await makeCookie(env) });
  }
  if (path === '/logout' && m === 'POST') {
    return jsonRes(200, { ok: true }, { 'set-cookie': `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0` });
  }
  return null;
}

// POST /tokens: the owner mints a bearer token for an agent or worker. The token is shown once.
export async function mintToken(env, principal, body) {
  const name = String(body.principal || '');
  if (!WRITERS.includes(name) || name === 'owner') throw new HttpError(400, `principal must be one of the configured agents or workers: ${WRITERS.filter((w) => w !== 'owner').join(', ') || '(none configured)'}`);
  const board = body.board ? String(body.board) : '';
  if (SCOPED_WORKERS.includes(name) && !board) throw new HttpError(400, `${name} must be bound to a board`);
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = `bk_${hex(bytes)}`;
  const clientId = `tok_${await sha256Hex(token)}`;
  await putPrincipal(env.DB, principal, clientId, { principal: name, board, note: String(body.note || '') });
  return { token, principal: name, board, clientId, note: 'Store this token now. It is not shown again.' };
}
