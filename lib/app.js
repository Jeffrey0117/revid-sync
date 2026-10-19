// HTTP layer for revid-sync (SYNC-API.md §5). Plain node:http, no framework.
// Error bodies never include internals (stack traces, SQL, file paths).
import http from 'node:http';

const VERSION = '1.0.0';
const MAX_BODY = 5 * 1024 * 1024;
const RATE_LIMIT = 60; // requests per user per minute (§5.6)
const RATE_WINDOW_MS = 60 * 1000;

export function createApp({ store, verifyToken, corsOrigin = '*' }) {
  const buckets = new Map(); // userId -> { count, resetAt }

  const rateLimit = (userId, now) => {
    let b = buckets.get(userId);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + RATE_WINDOW_MS };
      buckets.set(userId, b);
      if (buckets.size > 10000) {
        for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
      }
    }
    b.count += 1;
    return b.count <= RATE_LIMIT ? null : Math.ceil((b.resetAt - now) / 1000);
  };

  const baseHeaders = (req) => {
    const origin = corsOrigin === '*' ? '*' : (req.headers.origin && corsOrigin.split(',').map((s) => s.trim()).includes(req.headers.origin) ? req.headers.origin : '');
    const h = {
      'Content-Type': 'application/json',
      'X-Server-Time': String(Date.now()) // §4.4 clock-skew detection
    };
    if (origin) {
      h['Access-Control-Allow-Origin'] = origin;
      h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
      h['Access-Control-Max-Age'] = '86400';
      if (origin !== '*') h['Vary'] = 'Origin';
    }
    return h;
  };

  const send = (req, res, status, payload, extra) => {
    res.writeHead(status, { ...baseHeaders(req), ...extra });
    res.end(JSON.stringify(payload));
  };
  const fail = (req, res, status, code, error, extra) => send(req, res, status, { success: false, code, error }, extra);

  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { code: 'TOO_LARGE' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, baseHeaders(req));
        return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/v1/health') {
        return send(req, res, 200, { success: true, data: { version: VERSION, time: Date.now() } });
      }

      const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      if (!m) return fail(req, res, 401, 'UNAUTHORIZED', 'Missing or invalid authorization header');
      const auth = await verifyToken(m[1]);
      if (!auth.ok) {
        if (auth.status === 503) return fail(req, res, 503, 'SERVER_ERROR', 'Auth service unavailable, retry later');
        return fail(req, res, 401, 'UNAUTHORIZED', 'Invalid or expired token');
      }
      const { userId } = auth;

      const retryAfter = rateLimit(userId, Date.now());
      if (retryAfter !== null) {
        return fail(req, res, 429, 'RATE_LIMITED', 'Too many requests', { 'Retry-After': String(retryAfter) });
      }

      if (req.method === 'GET' && url.pathname === '/v1/me') {
        return send(req, res, 200, { success: true, data: { userId } });
      }
      if (req.method === 'GET' && url.pathname === '/v1/sync') {
        const since = Number(url.searchParams.get('since')) || 0;
        const limit = Number(url.searchParams.get('limit')) || 500;
        return send(req, res, 200, { success: true, ...store.pull(userId, since, limit) });
      }
      if (req.method === 'POST' && url.pathname === '/v1/sync') {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (e) {
          return e.code === 'TOO_LARGE'
            ? fail(req, res, 413, 'TOO_LARGE', 'Body too large')
            : fail(req, res, 400, 'BAD_REQUEST', 'Invalid JSON');
        }
        const result = store.push(userId, body);
        if (result.error) return fail(req, res, result.code === 'TOO_LARGE' ? 413 : 400, result.code, result.error);
        return send(req, res, 200, { success: true, ...result });
      }
      return fail(req, res, 404, 'NOT_FOUND', 'Not found');
    } catch (err) {
      console.error('[revid-sync] request failed:', err);
      if (!res.headersSent) return fail(req, res, 500, 'SERVER_ERROR', 'Internal error');
      res.end();
    }
  });

  return server;
}
