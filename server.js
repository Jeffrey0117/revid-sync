// revid-sync — sync backend for ReVid theater data.
// Spec: docs/SYNC-API.md in github.com/Jeffrey0117/ReVid
// Config via env: PORT, DB_PATH, LETMEUSE_BASE_URL, CORS_ORIGIN
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './lib/store.js';
import { createVerifier } from './lib/auth.js';
import { createApp } from './lib/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Zero-dep .env loader (insurance for process managers that start us with a stale env).
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf-8');
  for (const line of envFile.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env — fine */ }

const PORT = Number(process.env.PORT) || 8788;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'revid-sync.db');
const LETMEUSE_BASE_URL = (process.env.LETMEUSE_BASE_URL || 'https://letmeuse.isnowfriend.com').replace(/\/+$/, '');
const LETMEUSE_APP_ID = process.env.LETMEUSE_APP_ID || 'app_5qXx5Wtv'; // ReVid's app (shared with RePic) — foreign-app tokens are rejected
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const store = createStore(DB_PATH);
const { verifyToken } = createVerifier({ baseUrl: LETMEUSE_BASE_URL, appId: LETMEUSE_APP_ID });
const server = createApp({ store, verifyToken, corsOrigin: CORS_ORIGIN });

// Q4: purge 90-day-old tombstones at startup and daily.
const purged = store.purge();
if (purged) console.error(`[revid-sync] purged ${purged} expired tombstones`);
setInterval(() => store.purge(), 24 * 60 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.error(`[revid-sync] listening on :${PORT} (auth: ${LETMEUSE_BASE_URL})`);
});

const shutdown = () => {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

