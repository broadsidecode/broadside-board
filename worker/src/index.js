// Board service. One Worker serves the JSON API under /api/v1/, the page, and the remote MCP at /mcp with its OAuth routes.
// API_HOST and MCP_HOST may be the same hostname: connector routes are told apart by path.
// The API needs the owner password or a token (AUTH_MODE owner-password) or Cloudflare Access (AUTH_MODE access).
import { HttpError } from './store.js';
import { createOAuth, MCP_PRINCIPALS } from './oauth.js';
import { handleRpc } from './mcp.js';
import { buildSnapshot } from './snapshot.js';
import { json, readJson, accessPrincipal, textResponse, handleApi, JSON_HEADERS } from './api.js';
// One hostname can serve everything: the connector routes are told apart by path (the API lives under /api/v1).
const MCP_PATHS = /^\/(mcp|oauth\/|\.well-known\/oauth-)/;
const isMcpRequest = (url, env) => url.hostname === env.MCP_HOST && (env.MCP_HOST !== env.API_HOST || MCP_PATHS.test(url.pathname));
// Single source: handbook/HANDBOOK.md, bundled as text by the [[rules]] entry in wrangler.toml.
import HANDBOOK from '../../handbook/HANDBOOK.md';

// ------------------------------------------------------------------------------------------ MCP
function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function consentPage(params, error = '') {
  const hidden = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope']
    .filter((k) => params[k] != null)
    .map((k) => `<input type="hidden" name="${esc(k)}" value="${esc(params[k])}">`).join('\n');
  const options = MCP_PRINCIPALS.map((p) => `<option value="${p}">${p}</option>`).join('');
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Board connector</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem}label{display:block;margin-top:1rem}input,select,button{font-size:1rem;padding:.5rem;width:100%;box-sizing:border-box;margin-top:.25rem}button{margin-top:1.5rem}</style>
</head><body><main>
<h1>Connect to the Board</h1>
<p>Pick who this connector writes as. Every card change it makes is signed with that name.</p>
${error ? `<p role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/oauth/authorize">
${hidden}
<label for="principal">Connector name</label>
<select id="principal" name="principal" required>${options}</select>
<label for="bootstrap_code">Bootstrap code</label>
<input id="bootstrap_code" name="bootstrap_code" type="password" autocomplete="one-time-code" required>
<button type="submit">Connect</button>
</form></main></body></html>`;
  return new Response(body, { status: error ? 403 : 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

async function formOrJson(request) {
  const type = request.headers.get('content-type') || '';
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(await request.text()));
  return readJson(request);
}

async function handleMcpHost(request, env, url) {
  const oauth = createOAuth(env);
  const p = url.pathname;
  const m = request.method;
  const issuer = String(env.MCP_ISSUER || '').replace(/\/+$/, '');
  const resourceMeta = `${issuer}/.well-known/oauth-protected-resource/mcp`;

  if (p === '/health' && m === 'GET') return json(200, { ok: true, service: 'board-kit-mcp' });
  if (p === '/.well-known/oauth-authorization-server' && m === 'GET') return json(200, oauth.metadata());
  if ((p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp') && m === 'GET') {
    return json(200, oauth.protectedResource());
  }
  if (p === '/oauth/register' && m === 'POST') {
    const r = await oauth.register(await readJson(request));
    return json(r.status, r.body);
  }
  if (p === '/oauth/authorize' && (m === 'GET' || m === 'POST')) {
    const params = m === 'GET' ? Object.fromEntries(url.searchParams) : await formOrJson(request);
    const r = await oauth.authorize(params);
    if (r.redirect) return new Response(null, { status: 302, headers: { location: r.redirect, 'cache-control': 'no-store' } });
    if (r.error === 'access_denied') return consentPage(params, params.bootstrap_code ? 'That bootstrap code is not right.' : '');
    return json(r.status, { error: r.error, error_description: r.error_description });
  }
  if (p === '/oauth/token' && m === 'POST') {
    const body = await formOrJson(request);
    const basic = String(request.headers.get('authorization') || '').match(/^Basic\s+(.+)$/i);
    if (basic && !body.client_secret) {
      try {
        const [id, ...rest] = atob(basic[1]).split(':');
        body.client_id = body.client_id || decodeURIComponent(id);
        body.client_secret = decodeURIComponent(rest.join(':'));
      } catch { /* malformed header: treated as no secret */ }
    }
    const r = await oauth.token(body);
    return json(r.status, r.body, { pragma: 'no-cache' });
  }
  if (p === '/oauth/revoke' && m === 'POST') {
    const r = await oauth.revoke(await formOrJson(request));
    return json(r.status, r.body);
  }
  if (p === '/mcp') {
    if (m === 'GET' || m === 'HEAD') {
      return new Response(JSON.stringify({ error: 'method_not_allowed', hint: 'POST JSON-RPC to this endpoint' }),
        { status: 405, headers: { ...JSON_HEADERS, allow: 'POST' } });
    }
    if (m !== 'POST') return json(405, { error: 'method_not_allowed' }, { allow: 'POST' });
    const who = await oauth.authenticate(request);
    if (!who) {
      return json(401, { error: 'invalid_token', error_description: 'Authentication required' }, {
        'www-authenticate': `Bearer error="invalid_token", error_description="Authentication required", resource_metadata="${resourceMeta}"`,
      });
    }
    let body;
    try { body = await readJson(request); } catch { return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    if (Array.isArray(body)) return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch requests are not supported' } });
    const out = await handleRpc({ ...env, HANDBOOK }, who.principal, body);
    if (!out) return new Response(null, { status: 202 });
    return json(out.status, out.json);
  }
  return json(404, { error: 'not found' });
}


export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (isMcpRequest(url, env)) return await handleMcpHost(request, env, url);
      if (url.hostname === env.API_HOST && url.pathname.startsWith('/api/v1/')) return await handleApi(request, env, url);
      if (url.hostname === env.API_HOST && url.pathname === '/handbook' && (request.method === 'GET' || request.method === 'HEAD')) {
        const gate = await accessPrincipal(request, env);
        if (gate.denied) return gate.denied;
        return new Response(request.method === 'HEAD' ? null : HANDBOOK, {
          status: 200,
          headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
      if (url.hostname === env.API_HOST && url.pathname === '/llms.txt' && (request.method === 'GET' || request.method === 'HEAD')) {
        // The handbook, then the live snapshot: one address a bot or Owner can read. Same gate as the API.
        const who = await accessPrincipal(request, env);
        if (who.denied) return who.denied;
        const snap = await buildSnapshot(env, who.principal, { board: who.scope || '' });
        return textResponse(`${HANDBOOK.trimEnd()}

==========================================================
LIVE SNAPSHOT
==========================================================

${snap}`, request);
      }
      if (url.hostname === env.API_HOST && (url.pathname === '/' || url.pathname === '/index.html')) {
        // The hosted board page, from the Worker's static assets (the page folder).
        if (env.ASSETS) return await env.ASSETS.fetch(request);
        return json(200, { service: 'board-kit', api: '/api/v1/', docs: 'README.md in the kit' });
      }
      return json(404, { error: 'not found' });
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message, ...err.extra });
      console.error('board error', err && err.stack ? err.stack : String(err));
      return json(500, { error: 'internal error' });
    }
  },
};
