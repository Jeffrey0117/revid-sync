// Merge rules + wire conversion for cloud sync (docs/SYNC-API.md §3–4).
// Pure functions shared by the client and the reference/mock server, so both
// sides always compute the same result.
//
// Local model: Folder { ...meta, courses: Course[] } (array order = song order)
// Wire model:  Folder { ...meta, courseOrder: id[] }, Course { ...meta, folderId }

export const MAX_INLINE_ASSET = 256 * 1024; // data: URI cap for cover / thumbnail

const FOLDER_FIELDS = ['id', 'name', 'platform', 'musicMode', 'cover', 'courseOrder', 'createdAt', 'updatedAt', 'deletedAt'];
const COURSE_FIELDS = ['id', 'folderId', 'url', 'title', 'thumbnail', 'platform', 'clickPath', 'addedAt', 'updatedAt', 'deletedAt', 'progress'];

const pick = (obj, fields) => {
  const out = {};
  for (const f of fields) if (obj[f] !== undefined) out[f] = obj[f];
  return out;
};

// Drop data: URIs over the cap — they stay local-only instead of failing the push.
const withoutOversizeAsset = (record, field) => {
  const v = record[field];
  if (typeof v === 'string' && v.startsWith('data:') && v.length > MAX_INLINE_ASSET) {
    const { [field]: _dropped, ...rest } = record;
    return rest;
  }
  return record;
};

// Stable JSON (sorted keys) for deterministic tie-breaking.
const stable = (v) => {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};

const watchedAt = (p) => (p && typeof p.lastWatched === 'number' ? p.lastWatched : 0);

// --- Record merge (§4) ----------------------------------------------------

// Last-write-wins on updatedAt; ties broken by comparing content so every
// machine picks the same winner. Fields the winner lacks (e.g. an oversized
// cover it never received) are kept from the loser.
const lww = (a, b, ignore) => {
  if (!a) return b;
  if (!b) return a;
  const ta = a.updatedAt || 0;
  const tb = b.updatedAt || 0;
  let winner;
  if (ta !== tb) {
    winner = ta > tb ? a : b;
  } else {
    const { [ignore]: _ia, ...ca } = a;
    const { [ignore]: _ib, ...cb } = b;
    winner = stable(ca) >= stable(cb) ? a : b;
  }
  const loser = winner === a ? b : a;
  return { ...loser, ...winner };
};

export const mergeProgress = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  return watchedAt(b) > watchedAt(a) ? b : a;
};

export const mergeFolder = (a, b) => lww(a, b);

// Content by updatedAt; progress independently by progress.lastWatched (§4.3).
export const mergeCourse = (a, b) => {
  const merged = lww(a, b, 'progress');
  if (!merged) return merged;
  const progress = mergeProgress(a?.progress, b?.progress);
  return progress === undefined ? merged : { ...merged, progress };
};

// --- Local <-> wire -------------------------------------------------------

export const folderToWire = (folder) =>
  withoutOversizeAsset(
    pick({ ...folder, courseOrder: (folder.courses || []).map((c) => c.id) }, FOLDER_FIELDS),
    'cover'
  );

export const courseToWire = (course, folderId) =>
  withoutOversizeAsset(pick({ ...course, folderId }, COURSE_FIELDS), 'thumbnail');

// Records changed after `since` (local clock). Content changes and progress
// changes are reported separately so callers can push progress less often.
export const collectDirty = (folders, since) => {
  const out = { folders: [], courses: [], contentDirty: false, progressDirty: false };
  for (const folder of folders) {
    if ((folder.updatedAt || 0) > since) {
      out.folders.push(folderToWire(folder));
      out.contentDirty = true;
    }
    for (const course of folder.courses || []) {
      const content = (course.updatedAt || 0) > since;
      const progress = watchedAt(course.progress) > since;
      if (content || progress) out.courses.push(courseToWire(course, folder.id));
      if (content) out.contentDirty = true;
      if (progress) out.progressDirty = true;
    }
  }
  return out;
};

const byAddedAt = (a, b) => (a.addedAt || 0) - (b.addedAt || 0);

// Order a folder's courses by courseOrder; unknown ids go last by addedAt.
const orderCourses = (courses, order) => {
  if (!Array.isArray(order)) return courses;
  const rank = new Map(order.map((id, i) => [id, i]));
  const known = courses.filter((c) => rank.has(c.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
  const unknown = courses.filter((c) => !rank.has(c.id)).sort(byAddedAt);
  return [...known, ...unknown];
};

const sameRecord = (a, b) => a === b || stable(a) === stable(b);

/**
 * Merge remote wire records into local folders.
 * Returns { folders, orphans, changed }. `orphans` are remote courses whose
 * folder is not known yet — keep them and pass them back in on the next call.
 * When nothing changes, `folders` is the same array instance (no re-render).
 */
export const applyRemote = (localFolders, remote) => {
  const remoteFolders = remote.folders || [];
  const remoteCourses = [...(remote.orphans || []), ...(remote.courses || [])];
  if (remoteFolders.length === 0 && remoteCourses.length === 0) {
    return { folders: localFolders, orphans: [], changed: false };
  }

  // Working copies keyed by id (preserving local folder order).
  const order = localFolders.map((f) => f.id);
  const meta = new Map();        // folderId -> wire-shaped meta (no courses)
  const courses = new Map();     // folderId -> Map(courseId -> course)
  const remoteOrderWon = new Set();
  for (const f of localFolders) {
    const { courses: list, ...m } = f;
    meta.set(f.id, m);
    courses.set(f.id, new Map((list || []).map((c) => [c.id, c])));
  }

  for (const rf of remoteFolders) {
    const local = meta.get(rf.id);
    const localWire = local && { ...local, courseOrder: [...courses.get(rf.id).keys()] };
    const merged = mergeFolder(localWire, rf);
    if (!local) {
      order.push(rf.id);
      courses.set(rf.id, new Map());
    }
    // lww spreads the winner last, so the winner's courseOrder array survives as-is.
    if (merged.courseOrder === rf.courseOrder) remoteOrderWon.add(rf.id);
    meta.set(rf.id, merged);
  }

  const orphans = [];
  for (const rc of remoteCourses) {
    let localCourse = null;
    let localFolderId = null;
    for (const [fid, map] of courses) {
      if (map.has(rc.id)) { localCourse = map.get(rc.id); localFolderId = fid; break; }
    }
    const merged = mergeCourse(localCourse && { ...localCourse, folderId: localFolderId }, rc);
    const targetId = merged.folderId;
    if (!courses.has(targetId)) { orphans.push(rc); continue; }
    if (localFolderId && localFolderId !== targetId) courses.get(localFolderId).delete(rc.id);
    const { folderId: _f, ...course } = merged;
    courses.get(targetId).set(rc.id, course);
  }

  let changed = false;
  const result = order.map((id) => {
    const { courseOrder, ...m } = meta.get(id);
    let list = [...courses.get(id).values()];
    if (remoteOrderWon.has(id)) list = orderCourses(list, courseOrder);
    const next = { ...m, courses: list };
    const prev = localFolders.find((f) => f.id === id);
    if (prev && sameRecord(prev, next)) return prev;
    changed = true;
    return next;
  });

  return { folders: changed ? result : localFolders, orphans, changed };
};
