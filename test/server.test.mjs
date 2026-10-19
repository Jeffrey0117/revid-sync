// End-to-end over HTTP: auth wiring, rate limit, size limits, error hygiene.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createStore } from '../lib/store.js';
import { createVerifier } from '../lib/auth.js';
import { createApp } from '../lib/app.js';

let letmeuse;       // fake LetMeUse
let letmeuseMode = 'ok';
let server;
let base;

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

before(async () => {
  letmeuse = http.createServer((req, res) => {
    if (letmeuseMode === 'down') { res.destroy(); return; }
    if (letmeuseMode === '500') { res.writeHead(500); res.end('{}'); return; }
    const auth = req.headers.authorization || '';
    const m = /^Bearer tok-(\w+)$/.exec(auth);
    if (!m) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Missing or invalid authorization header' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { user: { id: `usr_${m[1]}`, email: 'x@y.z' } } }));
  });
  const lmPort = await listen(letmeuse);
  const store = createStore(':memory:');
  const { verifyToken } = createVerifier({ baseUrl: `http://127.0.0.1:${lmPort}` });
  server = createApp({ store, verifyToken, corsOrigin: '*' });
  const port = await listen(server);
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
  letmeuse.close();
});

const api = (path, { method = 'GET', token, body } = {}) =>
  fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

const folder = (over = {}) => ({
  id: 'f1', name: 'Folder', platform: 'custom', musicMode: false,
  courseOrder: [], createdAt: 1000, updatedAt: 1000, deletedAt: null, ...over
});

test('health needs no auth and reports version + time', async () => {
  const res = await api('/v1/health');
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('x-server-time'));
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.data.version, '1.0.0');
  assert.ok(Number.isInteger(body.data.time));
});

test('no token -> 401', async () => {
  const res = await api('/v1/me');
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'UNAUTHORIZED');
});

test('bad token -> 401 (LetMeUse rejected it)', async () => {
  const res = await api('/v1/me', { token: 'garbage' });
  assert.equal(res.status, 401);
});

test('valid token -> /v1/me returns the LetMeUse user id', async () => {
  const res = await api('/v1/me', { token: 'tok-alice' });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data, { userId: 'usr_alice' });
});

test('LetMeUse unreachable -> 503 SERVER_ERROR, not 401', async () => {
  letmeuseMode = 'down';
  const res = await api('/v1/me', { token: 'tok-fresh1' }); // uncached token
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'SERVER_ERROR');
  letmeuseMode = 'ok';
});

test('LetMeUse 5xx -> 503 SERVER_ERROR, not 401', async () => {
  letmeuseMode = '500';
  const res = await api('/v1/me', { token: 'tok-fresh2' });
  assert.equal(res.status, 503);
  letmeuseMode = 'ok';
});

test('push then pull round-trip, isolated per user', async () => {
  const push = await api('/v1/sync', { method: 'POST', token: 'tok-alice', body: { deviceId: 'd1', folders: [folder()] } });
  assert.equal(push.status, 200);
  const pushBody = await push.json();
  assert.equal(pushBody.data.accepted, 1);

  const pullAlice = await (await api('/v1/sync?since=0', { token: 'tok-alice' })).json();
  assert.equal(pullAlice.data.folders.length, 1);

  const pullBob = await (await api('/v1/sync?since=0', { token: 'tok-bob' })).json();
  assert.equal(pullBob.data.folders.length, 0);
});

test('invalid JSON -> 400 BAD_REQUEST', async () => {
  const res = await fetch(base + '/v1/sync', {
    method: 'POST',
    headers: { Authorization: 'Bearer tok-alice', 'Content-Type': 'application/json' },
    body: '{nope'
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'BAD_REQUEST');
});

test('single record over 512KB -> 413 TOO_LARGE', async () => {
  const res = await api('/v1/sync', {
    method: 'POST', token: 'tok-alice',
    body: { folders: [folder({ cover: 'data:x,' + 'A'.repeat(600 * 1024) })] }
  });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, 'TOO_LARGE');
});

test('body over 5MB -> 413', async () => {
  const res = await fetch(base + '/v1/sync', {
    method: 'POST',
    headers: { Authorization: 'Bearer tok-alice', 'Content-Type': 'application/json' },
    body: 'x'.repeat(5 * 1024 * 1024 + 10)
  }).catch(() => null);
  // server destroys the socket after responding; both a 413 response and a reset are acceptable client-side,
  // but we should normally get the 413.
  if (res) assert.equal(res.status, 413);
});

test('error responses leak no internals', async () => {
  const res = await api('/v1/sync', { method: 'POST', token: 'tok-alice', body: { folders: [{ id: 'x' }] } });
  assert.equal(res.status, 400);
  const text = JSON.stringify(await res.json());
  for (const needle of ['\\\\', 'SELECT', 'sqlite', 'Error:', 'at ', 'node:']) {
    assert.ok(!text.includes(needle), `leaked: ${needle} in ${text}`);
  }
});

test('unknown route -> 404 JSON', async () => {
  const res = await api('/v1/nope', { token: 'tok-alice' });
  assert.equal(res.status, 404);
});

test('rate limit: 61st request in a minute -> 429 with Retry-After', async () => {
  let last;
  for (let i = 0; i < 61; i += 1) last = await api('/v1/me', { token: 'tok-ratey' });
  assert.equal(last.status, 429);
  assert.equal((await last.json()).code, 'RATE_LIMITED');
  const retryAfter = Number(last.headers.get('retry-after'));
  assert.ok(retryAfter >= 1 && retryAfter <= 60);
  // other users unaffected
  const other = await api('/v1/me', { token: 'tok-calm' });
  assert.equal(other.status, 200);
});
