// SQLite-backed sync store (SYNC-API.md §4–5, §7.1). Same push/pull semantics
// as ReVid's in-memory reference implementation (dev/mock-sync-server/core.mjs),
// with the merge rules imported verbatim from ReVid's src/utils/syncMerge.js.
import { DatabaseSync } from 'node:sqlite';
import { mergeFolder, mergeCourse } from './syncMerge.js';
import { validateRecord, stripUnknownFields } from './validate.js';

const DELETED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // Q4: purge tombstones after 90 days
const MIN_TS = 1_000_000_000_000; // 2001-09-09 — anything smaller is a bug, not a wall-clock ms timestamp
const MAX_PAGE_BYTES = 4 * 1024 * 1024;   // pull: byte budget so one response can't OOM the process
const MAX_RECORDS_PER_PUSH = 2000;        // 413 tells the client to split the batch (§5.1)
const MAX_USER_ROWS = 100_000;            // abuse backstops, far above any real theater library
const MAX_USER_BYTES = 256 * 1024 * 1024;

const KIND = { folders: 'folder', courses: 'course' }; // wire key -> stored kind

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function createStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS records (
      user_id     TEXT    NOT NULL,
      kind        TEXT    NOT NULL CHECK (kind IN ('folder', 'course')),
      id          TEXT    NOT NULL,
      data        TEXT    NOT NULL,
      updated_at  INTEGER NOT NULL,
      deleted_at  INTEGER,
      seq         INTEGER NOT NULL,
      PRIMARY KEY (user_id, kind, id)
    );
    CREATE INDEX IF NOT EXISTS idx_records_seq ON records (user_id, seq);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_records_user_seq ON records (user_id, seq);
    CREATE TABLE IF NOT EXISTS user_seq (
      user_id TEXT PRIMARY KEY,
      seq     INTEGER NOT NULL DEFAULT 0
    );
  `);

  const getRecord = db.prepare('SELECT data FROM records WHERE user_id = ? AND kind = ? AND id = ?');
  const upsertRecord = db.prepare(`
    INSERT INTO records (user_id, kind, id, data, updated_at, deleted_at, seq)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, kind, id)
    DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at,
                  deleted_at = excluded.deleted_at, seq = excluded.seq
  `);
  const getSeq = db.prepare('SELECT seq FROM user_seq WHERE user_id = ?');
  const setSeq = db.prepare(`
    INSERT INTO user_seq (user_id, seq) VALUES (?, ?)
    ON CONFLICT (user_id) DO UPDATE SET seq = excluded.seq
  `);
  const pullPage = db.prepare(`
    SELECT kind, data, seq FROM records
    WHERE user_id = ? AND seq > ?
    ORDER BY seq ASC LIMIT ?
  `);
  const purgeStmt = db.prepare('DELETE FROM records WHERE deleted_at IS NOT NULL AND deleted_at < ?');
  const usageStmt = db.prepare('SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM records WHERE user_id = ?');

  // POST /v1/sync — merge each record inside one transaction; return server
  // copies that differ from what the client sent.
  function push(userId, body) {
    const incoming = { folders: [], courses: [] };
    let total = 0;
    for (const key of ['folders', 'courses']) {
      const list = body?.[key];
      if (list !== undefined && !Array.isArray(list)) return { error: `${key} must be an array`, code: 'BAD_REQUEST' };
      total += list?.length || 0;
      if (total > MAX_RECORDS_PER_PUSH) return { error: 'too many records in one push, split the batch', code: 'TOO_LARGE' };
      for (const raw of list || []) {
        const rec = raw && typeof raw === 'object' ? stripUnknownFields(key, raw) : raw;
        const problem = validateRecord(key, rec);
        if (problem === 'TOO_LARGE') return { error: 'record too large', code: 'TOO_LARGE' };
        if (problem) return { error: `${key}/${raw?.id}: ${problem}`, code: 'BAD_REQUEST' };
        incoming[key].push(rec);
      }
    }

    const conflicts = { folders: [], courses: [] };
    let accepted = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      let seq = getSeq.get(userId)?.seq ?? 0;
      const usage = usageStmt.get(userId);
      let rows = Number(usage.rows);
      let bytes = Number(usage.bytes);
      for (const key of ['folders', 'courses']) {
        const merge = key === 'folders' ? mergeFolder : mergeCourse;
        const kind = KIND[key];
        for (const rec of incoming[key]) {
          const row = getRecord.get(userId, kind, rec.id);
          const existing = row ? JSON.parse(row.data) : undefined;
          const merged = merge(existing, rec);
          if (!existing || !same(merged, existing)) {
            const json = JSON.stringify(merged);
            const nextRows = rows + (existing ? 0 : 1);
            const nextBytes = bytes - (row ? row.data.length : 0) + json.length;
            // Abuse backstop: block growth past the quota, always allow shrinking
            // (so a user over quota can still tombstone their way back under it).
            if ((nextRows > MAX_USER_ROWS || nextBytes > MAX_USER_BYTES) && nextBytes > bytes) {
              db.exec('ROLLBACK');
              return { error: 'storage quota exceeded', code: 'BAD_REQUEST' };
            }
            rows = nextRows;
            bytes = nextBytes;
            seq += 1;
            // deleted_at column only gets real timestamps — a bogus tiny value
            // (e.g. deletedAt: 0, which the client treats as "alive") must never
            // make purge() destroy a record other devices still need.
            const del = Number.isInteger(merged.deletedAt) && merged.deletedAt >= MIN_TS ? merged.deletedAt : null;
            upsertRecord.run(userId, kind, rec.id, json, merged.updatedAt || 0, del, seq);
            accepted += 1;
          }
          if (!same(merged, rec)) conflicts[key].push(merged);
        }
      }
      setSeq.run(userId, seq);
      db.exec('COMMIT');
      // NOTE: this cursor is the server head for this user. Clients must only
      // advance their pull cursor from GET /v1/sync responses, or they would
      // skip records other devices pushed in between (the ReVid client does
      // this correctly).
      return { data: { accepted, conflicts, cursor: seq } };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // GET /v1/sync?since=&limit=
  function pull(userId, since = 0, limit = 500) {
    const from = Number.isFinite(since) ? since : 0;
    const cap = Math.min(Math.max(1, Number.isFinite(limit) ? limit : 500), 1000);
    const page = pullPage.all(userId, from, cap + 1); // one extra row just to detect hasMore
    // Budget by bytes as well as count — records can be 512 KB each, and one
    // response must never be big enough to OOM the process. Always include at
    // least one record so paging progresses.
    let hasMore = page.length > cap;
    let bytes = 0;
    const rows = [];
    for (const r of page) {
      if (rows.length >= cap || (rows.length && bytes + r.data.length > MAX_PAGE_BYTES)) { hasMore = true; break; }
      bytes += r.data.length;
      rows.push(r);
    }
    return {
      data: {
        folders: rows.filter((r) => r.kind === 'folder').map((r) => JSON.parse(r.data)),
        courses: rows.filter((r) => r.kind === 'course').map((r) => JSON.parse(r.data)),
        cursor: rows.length ? rows[rows.length - 1].seq : Math.max(from, 0),
        hasMore
      }
    };
  }

  // Q4: remove tombstones deleted more than 90 days ago.
  function purge(now = Date.now()) {
    return purgeStmt.run(now - DELETED_RETENTION_MS).changes;
  }

  return { push, pull, purge, close: () => db.close() };
}
