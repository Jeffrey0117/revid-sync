// verifyToken paths (SYNC-API.md §2): pass / 401 / LetMeUse down -> 503, plus caching.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerifier } from '../lib/auth.js';

const jwt = (payload) =>
  `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

const okResponse = (user) => ({
  ok: true, status: 200,
  json: async () => ({ success: true, data: { user } })
});

test('200 with data.user.id -> ok', async () => {
  const v = createVerifier({ baseUrl: 'http://x', fetchImpl: async () => okResponse({ id: 'usr_1', email: 'a@b.c' }) });
  assert.deepEqual(await v.verifyToken(jwt({ sub: 'usr_1' })), { ok: true, userId: 'usr_1' });
});

test('200 with flat { user } shape also accepted', async () => {
  const v = createVerifier({
    baseUrl: 'http://x',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ user: { id: 'usr_2' } }) })
  });
  assert.deepEqual(await v.verifyToken(jwt({})), { ok: true, userId: 'usr_2' });
});

test('user without id falls back to JWT sub, never email', async () => {
  const v = createVerifier({ baseUrl: 'http://x', fetchImpl: async () => okResponse({ email: 'a@b.c', displayName: 'A' }) });
  assert.deepEqual(await v.verifyToken(jwt({ sub: 'usr_sub' })), { ok: true, userId: 'usr_sub' });
});

test('401 from LetMeUse -> 401', async () => {
  const v = createVerifier({ baseUrl: 'http://x', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  assert.deepEqual(await v.verifyToken(jwt({})), { ok: false, status: 401 });
});

test('5xx from LetMeUse -> 503, not 401', async () => {
  const v = createVerifier({ baseUrl: 'http://x', fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }) });
  assert.deepEqual(await v.verifyToken(jwt({})), { ok: false, status: 503 });
});

test('network failure / timeout -> 503, not 401', async () => {
  const v = createVerifier({ baseUrl: 'http://x', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.deepEqual(await v.verifyToken(jwt({})), { ok: false, status: 503 });
});

test('missing token -> 401 without calling LetMeUse', async () => {
  let called = 0;
  const v = createVerifier({ baseUrl: 'http://x', fetchImpl: async () => { called += 1; } });
  assert.deepEqual(await v.verifyToken(''), { ok: false, status: 401 });
  assert.equal(called, 0);
});

test('successful result is cached by token hash', async () => {
  let calls = 0;
  const v = createVerifier({ baseUrl: 'http://x', fetchImpl: async () => { calls += 1; return okResponse({ id: 'usr_1' }); } });
  const t = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  await v.verifyToken(t);
  await v.verifyToken(t);
  assert.equal(calls, 1);
  await v.verifyToken(jwt({ exp: Math.floor(Date.now() / 1000) + 7200 })); // different token -> new call
  assert.equal(calls, 2);
});

test('cache TTL is bounded by token exp', async () => {
  let calls = 0;
  let clock = 1_000_000_000_000;
  const v = createVerifier({
    baseUrl: 'http://x',
    fetchImpl: async () => { calls += 1; return okResponse({ id: 'usr_1' }); },
    now: () => clock
  });
  const t = jwt({ exp: Math.floor(clock / 1000) + 10 }); // expires in 10s < 5min cap
  await v.verifyToken(t);
  clock += 5_000;
  await v.verifyToken(t);
  assert.equal(calls, 1); // still cached
  clock += 6_000; // past exp
  await v.verifyToken(t);
  assert.equal(calls, 2); // cache expired with the token
});

test('503 results are NOT cached — next request retries LetMeUse', async () => {
  let fail = true;
  let calls = 0;
  const v = createVerifier({
    baseUrl: 'http://x',
    fetchImpl: async () => { calls += 1; if (fail) throw new Error('down'); return okResponse({ id: 'usr_1' }); }
  });
  const t = jwt({});
  assert.deepEqual(await v.verifyToken(t), { ok: false, status: 503 });
  fail = false;
  assert.deepEqual(await v.verifyToken(t), { ok: true, userId: 'usr_1' });
  assert.equal(calls, 2);
});
