// SQLite-backed sync store (SYNC-API.md §4–5, §7.1). Same push/pull semantics
// as ReVid's in-memory reference implementation (dev/mock-sync-server/core.mjs),
// with the merge rules imported verbatim from ReVid's src/utils/syncMerge.js.
import { DatabaseSync } from 'node:sqlite';
import { mergeFolder, mergeCourse } from './syncMerge.js';
import { validateRecord, stripUnknownFields } from './validate.js';

const DELETED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // Q4: purge tombstones after 90 days

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

  // POST /v1/sync — merge each record inside one transaction; return server
  // copies that differ from what the client sent.
  function push(userId, body) {
    const incoming = { folders: [], courses: [] };
    for (const key of ['folders', 'courses']) {
      const list = body?.[key];
      if (list !== undefined && !Array.isArray(list)) return { error: `${key} must be an array`, code: 'BAD_REQUEST' };
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
      for (const key of ['folders', 'courses']) {
        const merge = key === 'folders' ? mergeFolder : mergeCourse;
        const kind = KIND[key];
        for (const rec of incoming[key]) {
          const row = getRecord.get(userId, kind, rec.id);
          const existing = row ? JSON.parse(row.data) : undefined;
          const merged = merge(existing, rec);
          if (!existing || !same(merged, existing)) {
            seq += 1;
            upsertRecord.run(userId, kind, rec.id, JSON.stringify(merged), merged.updatedAt || 0, merged.deletedAt ?? null, seq);
            accepted += 1;
          }
          if (!same(merged, rec)) conflicts[key].push(merged);
        }
      }
      setSeq.run(userId, seq);
      db.exec('COMMIT');
      return { data: { accepted, conflicts, cursor: seq } };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // GET /v1/sync?since=&limit=
  function pull(userId, since = 0, limit = 500) {
    const cap = Math.min(Math.max(1, limit), 1000);
    const page = pullPage.all(userId, since, cap + 1); // one extra row just to detect hasMore
    const hasMore = page.length > cap;
    const rows = hasMore ? page.slice(0, cap) : page;
    return {
      data: {
        folders: rows.filter((r) => r.kind === 'folder').map((r) => JSON.parse(r.data)),
        courses: rows.filter((r) => r.kind === 'course').map((r) => JSON.parse(r.data)),
        cursor: rows.length ? rows[rows.length - 1].seq : Math.max(since, 0),
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
