// Cloudflare Access assertion check. The Worker trusts Cf-Access-Jwt-Assertion only after verifying
// its RS256 signature against the team's public keys, the issuer, the audience and the expiry.
// Keys are cached per isolate and refetched on an unknown kid or after an hour.

let cache = { at: 0, team: '', keys: new Map() };
const TTL_MS = 60 * 60 * 1000;

function b64urlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function decodePart(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

async function loadKeys(team, fetchImpl) {
  const res = await fetchImpl(`${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`certs fetch failed: ${res.status}`);
  const body = await res.json();
  const keys = new Map();
  for (const jwk of body.keys || []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    keys.set(jwk.kid, key);
  }
  cache = { at: Date.now(), team, keys };
}

async function keyFor(team, kid, fetchImpl) {
  if (cache.team !== team || Date.now() - cache.at > TTL_MS || !cache.keys.has(kid)) {
    await loadKeys(team, fetchImpl);
  }
  return cache.keys.get(kid) || null;
}

// Returns the verified claims, or null.
export async function verifyAccess(token, { team, aud }, fetchImpl = fetch) {
  if (!token || !team || !aud) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header;
  let claims;
  try {
    header = decodePart(parts[0]);
    claims = decodePart(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;
  const key = await keyFor(team, header.kid, fetchImpl);
  if (!key) return null;
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== team) return null;
  const audList = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audList.includes(aud)) return null;
  if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return null;
  return claims;
}
