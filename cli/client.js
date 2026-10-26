'use strict';

// Shared HTTP client for the board API. Credentials come from, in order:
//   BOARD_TOKEN                                             the owner secret or an agent token (bearer)
//   BOARD_ACCESS_CLIENT_ID + BOARD_ACCESS_CLIENT_SECRET     Cloudflare Access service token (access mode only)
//   BOARD_ASSERTION                                         a raw Access assertion (local test harness only)
// BOARD_URL is the board address, for example https://board.example.com (default: a local wrangler dev server).
// Values are held in memory for the request headers and never printed.

const DEFAULT_URL = 'http://127.0.0.1:8787';

function baseUrl(env = process.env) {
  return String(env.BOARD_URL || DEFAULT_URL).replace(/\/+$/, '');
}

// Returns the auth headers, or throws when nothing is set.
function authHeaders(env = process.env) {
  if (env.BOARD_TOKEN) return { authorization: `Bearer ${env.BOARD_TOKEN}` };
  if (env.BOARD_ACCESS_CLIENT_ID && env.BOARD_ACCESS_CLIENT_SECRET) {
    return { 'CF-Access-Client-Id': env.BOARD_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.BOARD_ACCESS_CLIENT_SECRET };
  }
  if (env.BOARD_ASSERTION) return { 'Cf-Access-Jwt-Assertion': env.BOARD_ASSERTION };
  throw new Error('set BOARD_TOKEN to the owner secret or an agent token (and BOARD_URL to the board address)');
}

// Pure: the request a call would make, without auth.
function buildRequest(method, apiPath, body, env = process.env) {
  const url = `${baseUrl(env)}/api/v1${apiPath}`;
  const init = { method, headers: { accept: 'application/json' }, redirect: 'manual' };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return { url, init };
}

async function call(method, apiPath, body, { env = process.env, fetchImpl = fetch, headers } = {}) {
  const { url, init } = buildRequest(method, apiPath, body, env);
  Object.assign(init.headers, headers || authHeaders(env));
  const res = await fetchImpl(url, init);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
  if (res.status >= 300 && res.status < 400) {
    data = { error: `redirected (${res.status}); the credentials were not accepted` };
  }
  return { status: res.status, data };
}

module.exports = { DEFAULT_URL, authHeaders, baseUrl, buildRequest, call };
