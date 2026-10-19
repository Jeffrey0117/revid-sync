// Store semantics (SYNC-API.md §4–5) — must match ReVid's reference
// implementation (dev/mock-sync-server/core.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';

const mkStore = () => createStore(':memory:');

const folder = (over = {}) => ({
  id: 'f1', name: 'Folder', platform: 'custom', musicMode: false,
  courseOrder: [], createdAt: 1000, updatedAt: 1000, deletedAt: null, ...over
});
const course = (over = {}) => ({
  id: 'c1', folderId: 'f1', url: 'https://example.com/v', title: 'Song',
  platform: 'youtube', addedAt: 1000, updatedAt: 1000, deletedAt: null, ...over
});

test('push stores records and pull returns them in seq order', () => {
  const s = mkStore();
  const r = s.push('u1', { folders: [folder()], courses: [course()] });
  assert.equal(r.data.accepted, 2);
  assert.deepEqual(r.data.conflicts, { folders: [], courses: [] });
  assert.equal(r.data.cursor, 2);

  const p = s.pull('u1', 0);
  assert.equal(p.data.folders.length, 1);
  assert.equal(p.data.courses.length, 1);
  assert.equal(p.data.cursor, 2);
  assert.equal(p.data.hasMore, false);
});

test('LWW: newer updatedAt wins, server returns its copy as conflict when it wins', () => {
  const s = mkStore();
  s.push('u1', { folders: [folder({ name: 'newer', updatedAt: 2000 })] });
  const r = s.push('u1', { folders: [folder({ name: 'older', updatedAt: 1500 })] });
  assert.equal(r.data.accepted, 0);
  assert.equal(r.data.conflicts.folders.length, 1);
  assert.equal(r.data.conflicts.folders[0].name, 'newer');
  const p = s.pull('u1', 0);
  assert.equal(p.data.folders[0].name, 'newer');
});

test('LWW tie: stable-content comparison picks the same winner deterministically', () => {
  const a = folder({ name: 'aaa', updatedAt: 2000 });
  const b = folder({ name: 'zzz', updatedAt: 2000 });
  const s1 = mkStore();
  s1.push('u1', { folders: [a] });
  s1.push('u1', { folders: [b] });
  const s2 = mkStore();
  s2.push('u1', { folders: [b] });
  s2.push('u1', { folders: [a] });
  assert.equal(s1.pull('u1', 0).data.folders[0].name, s2.pull('u1', 0).data.folders[0].name);
});

test('winner keeps fields it lacks from the loser (e.g. oversized cover kept local)', () => {
  const s = mkStore();
  s.push('u1', { folders: [folder({ cover: 'https://img/x.jpg', updatedAt: 1000 })] });
  const r = s.push('u1', { folders: [folder({ name: 'renamed', updatedAt: 2000 })] }); // no cover field
  assert.equal(r.data.accepted, 1);
  // server copy differs from what the client sent (cover filled in) -> conflict returned
  assert.equal(r.data.conflicts.folders.length, 1);
  const merged = r.data.conflicts.folders[0];
  assert.equal(merged.name, 'renamed');
  assert.equal(merged.cover, 'https://img/x.jpg');
});

test('delete is a tombstone merged by LWW and still syncs', () => {
  const s = mkStore();
  s.push('u1', { folders: [folder()] });
  s.push('u1', { folders: [folder({ deletedAt: 3000, updatedAt: 3000 })] });
  const p = s.pull('u1', 0);
  assert.equal(p.data.folders[0].deletedAt, 3000);
});

test('progress merges independently by lastWatched (§4.3)', () => {
  const s = mkStore();
  // Machine B listened further but has older content
  s.push('u1', { courses: [course({ title: 'old title', updatedAt: 1000, progress: { lastPosition: 100, duration: 200, lastWatched: 5000, completed: false } })] });
  // Machine A renamed (newer content) but watched earlier
  const r = s.push('u1', { courses: [course({ title: 'new title', updatedAt: 2000, progress: { lastPosition: 10, duration: 200, lastWatched: 4000, completed: false } })] });
  const merged = r.data.conflicts.courses[0];
  assert.equal(merged.title, 'new title');          // content: newer updatedAt wins
  assert.equal(merged.progress.lastPosition, 100);  // progress: later lastWatched wins
  assert.equal(s.pull('u1', 0).data.courses[0].progress.lastWatched, 5000);
});

test('idempotent re-push accepts nothing and assigns no new seq', () => {
  const s = mkStore();
  const f = folder();
  s.push('u1', { folders: [f] });
  const r = s.push('u1', { folders: [f] });
  assert.equal(r.data.accepted, 0);
  assert.deepEqual(r.data.conflicts, { folders: [], courses: [] });
  assert.equal(r.data.cursor, 1);
});

test('users are fully isolated', () => {
  const s = mkStore();
  s.push('u1', { folders: [folder({ name: 'mine' })] });
  s.push('u2', { folders: [folder({ id: 'f2', name: 'theirs' })] });
  const p1 = s.pull('u1', 0);
  const p2 = s.pull('u2', 0);
  assert.equal(p1.data.folders.length, 1);
  assert.equal(p1.data.folders[0].name, 'mine');
  assert.equal(p2.data.folders.length, 1);
  assert.equal(p2.data.folders[0].name, 'theirs');
  assert.equal(p2.data.cursor, 1); // per-user seq, not global
});

test('since pagination with hasMore', () => {
  const s = mkStore();
  const folders = Array.from({ length: 5 }, (_, i) => folder({ id: `f${i}`, updatedAt: 1000 + i }));
  s.push('u1', { folders });
  const page1 = s.pull('u1', 0, 2).data;
  assert.equal(page1.folders.length, 2);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.cursor, 2);
  const page2 = s.pull('u1', page1.cursor, 2).data;
  assert.equal(page2.folders.length, 2);
  assert.equal(page2.hasMore, true);
  const page3 = s.pull('u1', page2.cursor, 2).data;
  assert.equal(page3.folders.length, 1);
  assert.equal(page3.hasMore, false);
  assert.equal(page3.cursor, 5);
  const empty = s.pull('u1', page3.cursor, 2).data;
  assert.equal(empty.folders.length, 0);
  assert.equal(empty.cursor, 5); // cursor sticks at since when nothing new
  assert.equal(empty.hasMore, false);
});

test('limit is capped at 1000 and floors at 1', () => {
  const s = mkStore();
  s.push('u1', { folders: [folder({ id: 'fa' }), folder({ id: 'fb' })] });
  assert.equal(s.pull('u1', 0, -5).data.folders.length, 1);
  assert.equal(s.pull('u1', 0, 99999).data.folders.length, 2);
});

test('validation: bad records rejected, whole batch fails', () => {
  const s = mkStore();
  assert.equal(s.push('u1', { folders: [{ id: '', updatedAt: 1 }] }).code, 'BAD_REQUEST');
  assert.equal(s.push('u1', { folders: 'nope' }).code, 'BAD_REQUEST');
  assert.equal(s.push('u1', { courses: [course({ url: 'ftp://nope' })] }).code, 'BAD_REQUEST');
  assert.equal(s.push('u1', { courses: [course({ folderId: '' })] }).code, 'BAD_REQUEST');
  assert.equal(s.push('u1', { folders: [folder({ updatedAt: -1 })] }).code, 'BAD_REQUEST');
  assert.equal(s.push('u1', { folders: [folder({ name: 'x'.repeat(501) })] }).code, 'BAD_REQUEST');
  // batch with one bad record stores nothing
  const r = s.push('u1', { folders: [folder(), { id: 'bad' }] });
  assert.equal(r.code, 'BAD_REQUEST');
  assert.equal(s.pull('u1', 0).data.folders.length, 0);
});

test('oversized single record -> TOO_LARGE', () => {
  const s = mkStore();
  const r = s.push('u1', { folders: [folder({ cover: 'data:image/png;base64,' + 'A'.repeat(600 * 1024) })] });
  assert.equal(r.code, 'TOO_LARGE');
});

test('unknown fields are dropped before storing (§5.5)', () => {
  const s = mkStore();
  s.push('u1', { folders: [{ ...folder(), evil: 'x', __proto__pollute: 1 }] });
  const stored = s.pull('u1', 0).data.folders[0];
  assert.equal('evil' in stored, false);
});

test('orphan course (folderId not on server) is stored anyway', () => {
  const s = mkStore();
  const r = s.push('u1', { courses: [course({ folderId: 'missing-folder' })] });
  assert.equal(r.data.accepted, 1);
  assert.equal(s.pull('u1', 0).data.courses[0].folderId, 'missing-folder');
});

test('more than 2000 records in one push -> TOO_LARGE (split the batch)', () => {
  const s = mkStore();
  const many = Array.from({ length: 2001 }, (_, i) => folder({ id: `m${i}` }));
  assert.equal(s.push('u1', { folders: many }).code, 'TOO_LARGE');
  assert.equal(s.pull('u1', 0).data.folders.length, 0); // nothing stored
});

test('pull is byte-budgeted: huge records page in small chunks instead of one giant response', () => {
  const s = mkStore();
  const big = 'data:image/png;base64,' + 'A'.repeat(400 * 1024); // ~400KB each, under the 512KB record cap
  for (let i = 0; i < 15; i += 1) {
    s.push('u1', { folders: [folder({ id: `big${i}`, cover: big, updatedAt: 1000 + i })] });
  }
  let cursor = 0;
  let total = 0;
  let pages = 0;
  for (;;) {
    const page = s.pull('u1', cursor, 1000).data;
    assert.ok(JSON.stringify(page).length < 6 * 1024 * 1024, 'single page too large');
    total += page.folders.length;
    pages += 1;
    cursor = page.cursor;
    if (!page.hasMore) break;
    assert.ok(pages < 50, 'paging did not converge');
  }
  assert.equal(total, 15); // nothing lost across the byte-budgeted pages
  assert.ok(pages > 1, 'expected multiple pages');
});

test('bogus deletedAt: 0 is stored as data but never eaten by purge', () => {
  const s = mkStore();
  s.push('u1', { folders: [folder({ id: 'zero', deletedAt: 0, updatedAt: 2000 })] });
  assert.equal(s.purge(Date.now()), 0);
  const f = s.pull('u1', 0).data.folders[0];
  assert.equal(f.id, 'zero');
  assert.equal(f.deletedAt, 0); // record itself round-trips untouched
});

test('malformed nested values rejected (progress must be an object, clickPath an array)', () => {
  const s = mkStore();
  assert.equal(s.push('u1', { courses: [course({ progress: 'x' })] }).code, 'BAD_REQUEST');
  assert.equal(s.push('u1', { courses: [course({ progress: [1] })] }).code, 'BAD_REQUEST');
  assert.equal(s.push('u1', { courses: [course({ clickPath: 'nope' })] }).code, 'BAD_REQUEST');
  assert.equal(s.push('u1', { courses: [course({ progress: null })] }).data.accepted, 1);
});

test('purge removes tombstones older than 90 days only', () => {
  const s = mkStore();
  const now = Date.now();
  const old = now - 91 * 24 * 60 * 60 * 1000;
  const recent = now - 1 * 24 * 60 * 60 * 1000;
  s.push('u1', {
    folders: [
      folder({ id: 'gone', deletedAt: old, updatedAt: old }),
      folder({ id: 'kept-tombstone', deletedAt: recent, updatedAt: recent }),
      folder({ id: 'alive', updatedAt: now })
    ]
  });
  assert.equal(s.purge(now), 1);
  const ids = s.pull('u1', 0).data.folders.map((f) => f.id).sort();
  assert.deepEqual(ids, ['alive', 'kept-tombstone']);
});
