// Token verification against LetMeUse (SYNC-API.md §2).
//   GET {LETMEUSE_BASE_URL}/api/auth/me  with  Authorization: Bearer <token>
//   200 { data: { user } } / { user } -> ok, userId = user.id (falls back to JWT sub)
//   4xx                               -> 401 UNAUTHORIZED
//   timeout (5s) / 5xx / unreachable  -> 503 SERVER_ERROR (NOT 401 — don't log the client out)
// Results are cached by sha256(token) for min(5 minutes, token's remaining life).
import { createHash } from 'node:crypto';

const CACHE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000; // cache 401 verdicts briefly so bad tokens don't hammer LetMeUse
const TIMEOUT_MS = 5000;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Decode the JWT payload (base64url, no signature check — LetMeUse is the
// verifier; we only read exp to bound the cache TTL and sub as an id fallback).
const tokenPayload = (token) => {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
};

const tokenExpMs = (token) => {
  const exp = tokenPayload(token)?.exp;
  return Number.isFinite(exp) ? exp * 1000 : null;
};

export function createVerifier({ baseUrl, fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map(); // sha256(token) -> { result, expiresAt }

  const remember = (key, result, ttl, token) => {
    let expiresAt = now() + ttl;
    const exp = tokenExpMs(token);
    if (exp !== null) expiresAt = Math.min(expiresAt, exp);
    if (expiresAt > now()) cache.set(key, { result, expiresAt });
    if (cache.size > 10000) {
      for (const [k, v] of cache) if (v.expiresAt <= now()) cache.delete(k);
    }
    return result;
  };

  // -> { ok: true, userId } | { ok: false, status: 401 | 503 }
  async function verifyToken(token) {
    if (typeof token !== 'string' || !token) return { ok: false, status: 401 };
    const key = sha256(token);
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) return hit.result;
    cache.delete(key);

    let res;
    try {
      res = await fetchImpl(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch {
      return { ok: false, status: 503 }; // timeout or network failure
    }

    if (res.status >= 500) return { ok: false, status: 503 };
    if (!res.ok) return remember(key, { ok: false, status: 401 }, NEGATIVE_TTL_MS, token);

    let user;
    try {
      const body = await res.json();
      user = body?.data?.user ?? body?.user;
    } catch {
      return { ok: false, status: 503 };
    }
    // Confirmed live 2026-10-19: /api/auth/me returns { success, data: { user: { id: "usr_…", … } } }.
    // Spec fallback: JWT sub. Never use email as the userId (emails can change).
    const sub = tokenPayload(token)?.sub;
    const userId =
      (typeof user?.id === 'string' && user.id) ||
      (typeof sub === 'string' && sub) ||
      null;
    if (!userId) return { ok: false, status: 503 }; // unexpected shape — treat as server trouble, not logout
    return remember(key, { ok: true, userId }, CACHE_TTL_MS, token);
  }

  return { verifyToken };
}
