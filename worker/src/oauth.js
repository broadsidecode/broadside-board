// OAuth 2.1 for the remote MCP endpoint, ported from tools/zoho-remote-mcp/src/auth.js: authorization
// server and protected resource metadata, dynamic client registration (public PKCE clients only),
// Claude client metadata documents, authorize gated by a bootstrap code with RFC 9207 iss on the
// redirect, token (authorization_code and refresh_token), revoke. State lives in D1, and codes and
// tokens are stored only as HMAC-SHA256 hashes. Each grant records the principal chosen on the consent
// form (agent2, agent, agent3 or owner), which then signs every history line the token writes.

import { MCP_PRINCIPALS } from './config.js';
export { MCP_PRINCIPALS };
export const SCOPE = 'board';
export const ALLOWED_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  // Cursor agents.
  'https://www.cursor.com/agents/mcp/oauth/callback',
  'https://cursor.com/agents/mcp/oauth/callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'https://platform.openai.com/apps-manage/oauth/callback',
  'https://grok.com/connectors-oauth-exchange-code/',
];
const CONFIDENTIAL_METHODS = ['client_secret_post', 'client_secret_basic'];
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 60 * 60 * 24 * 30;
const CODE_TTL_MS = 5 * 60 * 1000;

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomToken(prefix) {
  return `${prefix}_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

async function sha256Hex(value) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(key, value) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(String(value)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function constantEqual(a, b) {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

async function verifyPkce(verifier, challenge) {
  if (!verifier || !challenge) return false;
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(verifier)));
  return constantEqual(b64url(d), challenge);
}

function isAllowedLoopback(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { return false; }
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    && url.pathname === '/callback' && Boolean(url.port);
}

// ChatGPT callback-id redirects: https://chatgpt.com/connector/oauth/<callback_id>
function isChatGptCallbackId(value) {
  return /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(String(value || ''));
}

function isAllowedRedirect(value) {
  return ALLOWED_REDIRECT_URIS.includes(String(value || '')) || isChatGptCallbackId(value) || isAllowedLoopback(value);
}

function isClaudeCodeClientId(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { return false; }
  return url.protocol === 'https:' && ['claude.ai', 'claude.com'].includes(url.hostname) && url.pathname.startsWith('/oauth/claude-code');
}

const strings = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

export function createOAuth(env, fetchImpl = fetch) {
  const db = env.DB;
  const issuer = String(env.MCP_ISSUER || '').replace(/\/+$/, '');
  const signingKey = env.OAUTH_TOKEN_SIGNING_KEY || '';
  const bootstrapHash = env.OAUTH_BOOTSTRAP_CODE_HASH || '';
  const now = () => Date.now();

  function metadata() {
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', ...CONFIDENTIAL_METHODS],
      scopes_supported: [SCOPE],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      service: 'board-kit-mcp',
    };
  }

  function protectedResource() {
    return {
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: [SCOPE],
    };
  }

  async function validateBootstrap(code) {
    if (!bootstrapHash || !code) return false;
    return constantEqual(await sha256Hex(code), bootstrapHash);
  }

  async function fetchClientMetadataDocument(clientId) {
    let url;
    try { url = new URL(String(clientId || '')); } catch { return null; }
    const claudeHost = ['claude.ai', 'claude.com'].includes(url.hostname);
    const chatgptHost = url.hostname === 'chatgpt.com' && url.pathname.startsWith('/oauth/');
    if (url.protocol !== 'https:' || !(claudeHost || chatgptHost)) return null;
    try {
      const res = await fetchImpl(url.toString(), { headers: { accept: 'application/json' } });
      if (!res.ok) return null;
      const m = await res.json();
      if (m.client_id !== url.toString()) return null;
      const uris = strings(m.redirect_uris);
      if (!uris.length || uris.some((u) => !isAllowedRedirect(u))) return null;
      return { client_id: url.toString(), redirect_uris: uris, token_endpoint_auth_method: 'none', client_name: m.client_name || url.hostname };
    } catch {
      return null;
    }
  }

  async function resolveClient(clientId) {
    if (!clientId) return null;
    const row = await db.prepare('SELECT data FROM board_oauth_clients WHERE client_id = ?').bind(String(clientId)).first();
    if (row) return JSON.parse(row.data);
    const doc = await fetchClientMetadataDocument(clientId);
    if (doc) return doc;
    if (isClaudeCodeClientId(clientId)) {
      return { client_id: String(clientId), redirect_uris: [], token_endpoint_auth_method: 'none', client_name: 'Claude Code', allow_dynamic_redirect_uri: true };
    }
    // Desktop clients such as the Codex app send a built in public client id without registering.
    // They are accepted only for a loopback callback on the user's own machine; PKCE and the
    // bootstrap code on the consent page still gate every such sign in.
    return { client_id: String(clientId).slice(0, 200), redirect_uris: [], token_endpoint_auth_method: 'none', client_name: 'Desktop client', loopback_only: true };
  }

  async function register(params = {}) {
    const uris = strings(params.redirect_uris);
    if (!uris.length || uris.some((u) => !isAllowedRedirect(u))) {
      console.error('register refused redirect_uris', JSON.stringify(uris.slice(0, 5)), 'client', String(params.client_name || '').slice(0, 60));
      return { status: 400, body: { error: 'invalid_redirect_uri', error_description: 'Only Claude, ChatGPT or Grok hosted MCP callbacks or loopback callbacks are allowed' } };
    }
    const method = params.token_endpoint_auth_method || 'none';
    if (method !== 'none' && !CONFIDENTIAL_METHODS.includes(method)) {
      return { status: 400, body: { error: 'invalid_client_metadata', error_description: 'token_endpoint_auth_method must be none, client_secret_post or client_secret_basic' } };
    }
    const client = {
      client_id: randomToken('client'),
      client_name: String(params.client_name || 'Claude').slice(0, 100),
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
      scope: SCOPE,
      client_id_issued_at: Math.floor(now() / 1000),
    };
    const stored = { ...client };
    let secret = null;
    if (method !== 'none') {
      secret = randomToken('secret');
      stored.client_secret_hash = await sha256Hex(secret);
    }
    await db.prepare('INSERT INTO board_oauth_clients (client_id, data, created_at) VALUES (?, ?, ?)')
      .bind(client.client_id, JSON.stringify(stored), new Date().toISOString()).run();
    // The plain secret is returned once; only its SHA-256 is stored.
    return { status: 201, body: secret ? { ...client, client_secret: secret, client_secret_expires_at: 0 } : client };
  }

  // Returns { status, redirect } on success, { status, error, error_description } otherwise.
  async function authorize(q = {}) {
    if (q.response_type !== 'code') return { status: 400, error: 'unsupported_response_type', error_description: 'response_type must be code' };
    const client = await resolveClient(q.client_id);
    if (!client) return { status: 400, error: 'invalid_client', error_description: 'Unknown public client' };
    const redirectOk = client.loopback_only ? isAllowedLoopback(q.redirect_uri)
      : client.allow_dynamic_redirect_uri ? isAllowedRedirect(q.redirect_uri) : strings(client.redirect_uris).includes(q.redirect_uri);
    if (!redirectOk) return { status: 400, error: 'invalid_request', error_description: 'redirect_uri is not allowed' };
    if (q.code_challenge_method !== 'S256' || !q.code_challenge) return { status: 400, error: 'invalid_request', error_description: 'PKCE S256 code_challenge is required' };
    if (!(await validateBootstrap(q.bootstrap_code))) return { status: 403, error: 'access_denied', error_description: 'Owner bootstrap approval is required' };
    const allowed = MCP_PRINCIPALS;
    if (!allowed.includes(q.principal)) return { status: 400, error: 'invalid_request', error_description: `principal must be one of ${allowed.join(', ')}` };
    if (!signingKey) return { status: 500, error: 'server_error', error_description: 'signing key not configured' };
    const code = randomToken('code');
    const record = { clientId: client.client_id, redirectUri: q.redirect_uri, codeChallenge: q.code_challenge, principal: q.principal };
    await db.prepare('INSERT INTO board_oauth_codes (hash, data, expires_at, used) VALUES (?, ?, ?, 0)')
      .bind(await hmacHex(signingKey, code), JSON.stringify(record), now() + CODE_TTL_MS).run();
    const redirect = new URL(q.redirect_uri);
    redirect.searchParams.set('code', code);
    if (q.state) redirect.searchParams.set('state', q.state);
    redirect.searchParams.set('iss', issuer);
    return { status: 302, redirect: redirect.toString() };
  }

  async function issuePair(clientId, principal, existingRefresh = null) {
    const access = randomToken('access');
    const refresh = existingRefresh || randomToken('refresh');
    const data = JSON.stringify({ clientId, principal });
    const stmts = [
      db.prepare('INSERT INTO board_oauth_tokens (hash, kind, data, expires_at, revoked) VALUES (?, ?, ?, ?, 0)')
        .bind(await hmacHex(signingKey, access), 'access', data, now() + ACCESS_TTL_S * 1000),
    ];
    if (!existingRefresh) {
      stmts.push(db.prepare('INSERT INTO board_oauth_tokens (hash, kind, data, expires_at, revoked) VALUES (?, ?, ?, ?, 0)')
        .bind(await hmacHex(signingKey, refresh), 'refresh', data, now() + REFRESH_TTL_S * 1000));
    }
    await db.batch(stmts);
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: ACCESS_TTL_S, scope: SCOPE, principal };
  }

  // Confidential clients must present their secret on every token request. PKCE stays required.
  async function clientAuthOk(clientId, secret) {
    const row = await db.prepare('SELECT data FROM board_oauth_clients WHERE client_id = ?').bind(String(clientId || '')).first();
    if (!row) return true;
    const client = JSON.parse(row.data);
    if (!client.client_secret_hash) return true;
    if (!secret) return false;
    return constantEqual(await sha256Hex(secret), client.client_secret_hash);
  }

  async function token(p = {}) {
    if (!signingKey) return { status: 500, body: { error: 'server_error' } };
    if (p.grant_type === 'authorization_code' || p.grant_type === 'refresh_token') {
      if (!(await clientAuthOk(p.client_id, p.client_secret))) {
        return { status: 401, body: { error: 'invalid_client', error_description: 'Client authentication failed' } };
      }
    }
    if (p.grant_type === 'authorization_code') {
      const hash = await hmacHex(signingKey, p.code || '');
      // Single use: mark used only if not yet used and not expired.
      const res = await db.prepare('UPDATE board_oauth_codes SET used = 1 WHERE hash = ? AND used = 0 AND expires_at > ? RETURNING data')
        .bind(hash, now()).all();
      const row = res.results && res.results[0];
      if (!row) return { status: 400, body: { error: 'invalid_grant', error_description: 'Authorization code is invalid or expired' } };
      const rec = JSON.parse(row.data);
      if (rec.clientId !== p.client_id) return { status: 400, body: { error: 'invalid_client', error_description: 'client_id does not match authorization code' } };
      if (rec.redirectUri !== p.redirect_uri) return { status: 400, body: { error: 'invalid_grant', error_description: 'redirect_uri mismatch' } };
      if (!(await verifyPkce(p.code_verifier, rec.codeChallenge))) return { status: 400, body: { error: 'invalid_grant', error_description: 'PKCE verification failed' } };
      return { status: 200, body: await issuePair(rec.clientId, rec.principal) };
    }
    if (p.grant_type === 'refresh_token') {
      const row = await db.prepare("SELECT data, expires_at, revoked FROM board_oauth_tokens WHERE hash = ? AND kind = 'refresh'")
        .bind(await hmacHex(signingKey, p.refresh_token || '')).first();
      if (!row || row.revoked || row.expires_at <= now()) return { status: 400, body: { error: 'invalid_grant', error_description: 'Refresh token is invalid, expired, or revoked' } };
      const rec = JSON.parse(row.data);
      if (rec.clientId !== p.client_id) return { status: 400, body: { error: 'invalid_client', error_description: 'client_id does not match refresh token' } };
      return { status: 200, body: await issuePair(rec.clientId, rec.principal, p.refresh_token) };
    }
    return { status: 400, body: { error: 'unsupported_grant_type', error_description: 'Unsupported OAuth grant type' } };
  }

  async function revoke(p = {}) {
    if (signingKey && p.token) {
      await db.prepare('UPDATE board_oauth_tokens SET revoked = 1 WHERE hash = ?').bind(await hmacHex(signingKey, p.token)).run();
    }
    return { status: 200, body: { revoked: true } };
  }

  // Returns { principal, clientId } for a live access token, else null.
  async function authenticate(request) {
    const m = String(request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!m || !signingKey) return null;
    const row = await db.prepare("SELECT data, expires_at, revoked FROM board_oauth_tokens WHERE hash = ? AND kind = 'access'")
      .bind(await hmacHex(signingKey, m[1])).first();
    if (!row || row.revoked || row.expires_at <= now()) return null;
    const rec = JSON.parse(row.data);
    return { principal: rec.principal, clientId: rec.clientId };
  }

  return { metadata, protectedResource, register, authorize, token, revoke, authenticate };
}
