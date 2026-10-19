// Record validation + unknown-field stripping (SYNC-API.md §5.5).
// Validation rules mirror ReVid's dev/mock-sync-server/core.mjs so both
// implementations accept/reject the same inputs.

const MAX_ID = 64;
const MAX_TEXT = 500;
const MAX_RECORD_BYTES = 512 * 1024;

// Wire-model whitelists (SYNC-API.md §3). Unknown fields are dropped, not stored.
const FOLDER_FIELDS = ['id', 'name', 'platform', 'musicMode', 'cover', 'courseOrder', 'createdAt', 'updatedAt', 'deletedAt'];
const COURSE_FIELDS = ['id', 'folderId', 'url', 'title', 'thumbnail', 'platform', 'clickPath', 'addedAt', 'updatedAt', 'deletedAt', 'progress'];

const isTime = (v) => v === null || v === undefined || (Number.isInteger(v) && v >= 0);
const isText = (v) => v === undefined || v === null || (typeof v === 'string' && v.length <= MAX_TEXT);
const isHttpUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v);

export function validateRecord(kind, rec) {
  if (!rec || typeof rec !== 'object') return 'record must be an object';
  if (typeof rec.id !== 'string' || !rec.id || rec.id.length > MAX_ID) return 'invalid id';
  if (!Number.isInteger(rec.updatedAt) || rec.updatedAt < 0) return 'invalid updatedAt';
  if (!isTime(rec.deletedAt)) return 'invalid deletedAt';
  if (JSON.stringify(rec).length > MAX_RECORD_BYTES) return 'TOO_LARGE';
  if (kind === 'folders') {
    if (!isText(rec.name)) return 'invalid name';
    if (rec.courseOrder !== undefined && !(Array.isArray(rec.courseOrder) && rec.courseOrder.every((id) => typeof id === 'string'))) return 'invalid courseOrder';
  } else {
    if (typeof rec.folderId !== 'string' || !rec.folderId) return 'invalid folderId';
    if (!isHttpUrl(rec.url)) return 'invalid url';
    if (!isText(rec.title)) return 'invalid title';
  }
  return null;
}

export function stripUnknownFields(kind, rec) {
  const fields = kind === 'folders' ? FOLDER_FIELDS : COURSE_FIELDS;
  const out = {};
  for (const f of fields) if (rec[f] !== undefined) out[f] = rec[f];
  return out;
}
