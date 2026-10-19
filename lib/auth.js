// Token verification against LetMeUse (SYNC-API.md §2).
//   GET {LETMEUSE_BASE_URL}/api/auth/me  with  Authorization: Bearer <token>
//   200 { data: { user } } / { user } -> ok, userId = user.id (falls back to JWT sub)
//   401                               -> 401 UNAUTHORIZED
//   timeout (5s) / 5xx / any other non-ok (403 WAF, 404, 429…) -> 503 SERVER_ERROR
//   (only a real 401 may log the client out; anything else is OUR problem, not theirs)
// Results are cached by sha256(token) for min(5 minutes, token's remaining life).
import { createHash } from 'node:crypto';

const CACHE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000; // cache 401 verdicts briefly so bad tokens don't hammer LetMeUse
const TIMEOUT_MS = 5000;
const MAX_CACHE = 10000;

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

export function createVerifier({ baseUrl, appId, fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map(); // sha256(token) -> { result, expiresAt }

  const remember = (key, result, ttl, token) => {
    let expiresAt = now() + ttl;
    if (result.ok) {
      // Only positive verdicts are bounded by token exp — an already-expired
      // token must still get its negative TTL, or it is re-verified upstream
      // on every single request (unauthenticated amplification against LetMeUse).
      const exp = tokenExpMs(token);
      if (exp !== null) expiresAt = Math.min(expiresAt, exp);
    }
    if (expiresAt > now()) cache.set(key, { result, expiresAt });
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value); // FIFO, O(1)
    return result;
  };

  // -> { ok: true, userId } | { ok: false, status: 401 | 503 }
  async function verifyToken(token) {
    if (typeof token !== 'string' || !token) return { ok: false, status: 401 };
    // Self-evidently dead token: reject locally, zero upstream cost. A forged
    // (earlier) exp only makes us reject sooner than LetMeUse would.
    const exp = tokenExpMs(token);
    if (exp !== null && exp <= now()) return { ok: false, status: 401 };

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

    if (res.status === 401) return remember(key, { ok: false, status: 401 }, NEGATIVE_TTL_MS, token);
    if (!res.ok) return { ok: false, status: 503 }; // 403/404/429/5xx: don't log the user out over an upstream hiccup

    let user;
    try {
      const body = await res.json();
      user = body?.data?.user ?? body?.user;
    } catch {
      return { ok: false, status: 503 };
    }
    // LetMeUse users are per-app: a token for any other ecosystem app would
    // verify fine upstream, so reject foreign apps here.
    if (appId && typeof user?.appId === 'string' && user.appId !== appId) {
      return remember(key, { ok: false, status: 401 }, NEGATIVE_TTL_MS, token);
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
