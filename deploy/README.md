# deploy/ — Vercel + MongoDB deployment kit

The full step-by-step guide lives in [`../VERCEL.md`](../VERCEL.md).

| File | Purpose |
|---|---|
| `apply-mongodb-patch.mjs` | Installs/wires the MongoDB adapter into `src/lib/db/driver.js` (idempotent, re-runnable after upstream syncs). The **only** code deviation from upstream, env-guarded by `MONGODB_URI`. |
| `mongoSqliteAdapter.js` | Canonical adapter source — the patch script copies it to `src/lib/db/adapters/`. Persists the SQLite image (gzip) to MongoDB on every write. |
| `verify-mongodb.mjs` | Pre-flight: pings MongoDB, runs a write/read/delete probe, reports any existing 9Router DB image. |
| `import-local-sqlite.mjs` | Uploads an existing local `~/.9router/db/data.sqlite` into MongoDB. |
| `env.vercel.example` | Reference sheet of the environment variables to set in the Vercel dashboard. |
