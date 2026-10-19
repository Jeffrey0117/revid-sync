# revid-sync

Sync backend for [ReVid](https://github.com/Jeffrey0117/ReVid) theater data (folders, courses/songs, playback progress) across machines. Implements `docs/SYNC-API.md` v1 from the ReVid repo.

- Zero dependencies — Node 22.5+ (`node:http` + `node:sqlite`).
- Merge rules (`lib/syncMerge.js`) are a verbatim copy of ReVid's `src/utils/syncMerge.js`, so client and server always compute the same result.
- Auth: Bearer tokens verified against LetMeUse `GET /api/auth/me`; results cached by `sha256(token)` for min(5 min, token life). LetMeUse unreachable → `503` (never `401`, so clients aren't logged out by an outage).
- Per-user data isolation, per-user `seq` cursor for incremental pull.
- Tombstone deletes, purged 90 days after `deletedAt`.
- Rate limit: 60 requests/user/minute.

## Run

```bash
npm start      # or: node server.js
npm test
```

## Env

| Var | Default | |
|-----|---------|---|
| `PORT` | `8788` | |
| `DB_PATH` | `./data/revid-sync.db` | SQLite file |
| `LETMEUSE_BASE_URL` | `https://letmeuse.isnowfriend.com` | auth upstream |
| `CORS_ORIGIN` | `*` | or comma-separated origin list |

## API

`/v1/health` (no auth), `/v1/me`, `GET /v1/sync?since=&limit=`, `POST /v1/sync` — see ReVid `docs/SYNC-API.md` for the full contract.
