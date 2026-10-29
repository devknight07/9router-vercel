# ▲ 9Router on Vercel + MongoDB

Deploy this folder to [Vercel](https://vercel.com) with the database hosted on
[MongoDB](https://www.mongodb.com/atlas). The upstream 9Router repository is
untouched — every deployment-specific change here is **additive**, except one
small env-guarded hook in `src/lib/db/driver.js` (see
[What differs from upstream](#-what-differs-from-upstream)).

> **TL;DR** — Create a MongoDB Atlas cluster → push this folder to a GitHub
> repo → import it in Vercel → set `MONGODB_URI`, `JWT_SECRET`,
> `INITIAL_PASSWORD` → Deploy. Done.

---

## 🧠 How it works (read this first)

9Router's entire data layer (repos, migrations, backups) speaks **SQLite
SQL** through a swappable adapter
(`src/lib/db/driver.js` → `bun:sqlite / better-sqlite3 / node:sqlite / sql.js`).
Rewriting every query into native MongoDB queries would mean forking the whole
data layer — exactly what we must not do.

So this deployment keeps **sql.js** (WASM SQLite, already an upstream
dependency, byte-compatible SQL engine) as the query engine and stores the
**database image in MongoDB**:

```
Vercel Functions (stateless)                MongoDB Atlas (the database)
┌──────────────────────────┐   gzip image   ┌────────────────────────────┐
│  9Router (Next.js)       │ ─────────────► │ db "9router"               │
│  sql.js in-memory engine │ ◄───────────── │ collection "sqlite_store"  │
│  full SQL compatibility  │  load on boot  │  doc _id:"data.sqlite"     │
└──────────────────────────┘                └────────────────────────────┘
```

- Cold start → image downloaded once (~a few MB) → queries run at in-memory
  SQLite speed.
- Every write is flushed back to MongoDB through a serialized, version-checked
  persistence chain (coalesced per event-loop turn — the durability window is
  a single in-flight write, ~10–100 ms for typical image sizes).
- Data survives cold starts and is shared by all instances — MongoDB **is**
  the database; Vercel holds no state (`/tmp` only holds transient files).

### What lives where

| Data | Location |
|---|---|
| Provider connections, API keys, combos, aliases, pricing, settings | MongoDB (inside the SQLite image) |
| Usage history / request details | MongoDB (inside the SQLite image) |
| Model-catalog cache, schema-change backups, logs | Vercel `/tmp` (transient, disposable by design) |

### Serverless caveats (honest notes)

- **SSE streaming works**, but each stream is bounded by the function
  duration (default 300 s on Hobby with Fluid Compute, 800 s on Pro —
  configurable per-route with Next.js `maxDuration` if you ever need more).
- **Background token refresh** runs per warm instance (upstream's
  `initializeApp` starts it on boot). On serverless this is best-effort —
  tokens still refresh on demand when a request needs them.
- **Local-only features don't apply on Vercel**: MITM proxying, Tailscale /
  Cloudflare tunnels, and the desktop tray are single-machine features. The
  hosted deployment serves the dashboard + `/v1`, `/v1beta`, `/responses`,
  `/codex` API endpoints exactly like any remote 9Router — point Claude Code,
  Cursor, Cline, etc. at your `*.vercel.app` URL.
- **Concurrency model**: image persistence is last-write-wins (conflicts are
  detected and logged). This matches 9Router's single-admin design. Don't run
  a write-heavy multi-admin operation on one project.
- **Size guard**: MongoDB documents cap at 16 MB. The gzipped image stays a
  few MB in normal use; if you enable request logs and route huge traffic,
  prune usage history from the dashboard (or keep `ENABLE_REQUEST_LOGS=false`,
  the default).

---

## 🚀 Deploy in 5 steps

### Step 1 — Create the MongoDB database (Atlas free tier is fine)

1. Create a free **M0 cluster** at <https://www.mongodb.com/cloud/atlas>
   (pick the region closest to your Vercel region, e.g. `us-east-1` for
   Vercel's default `iad1`).
2. **Database Access** → create a user (password auth). Save the password.
3. **Network Access** → add IP `0.0.0.0/0` (Vercel functions egress from
   dynamic IPs — a fixed allowlist won't work).
4. **Connect → Drivers → Node.js** → copy the URI. It looks like:
   ```
   mongodb+srv://myuser:<db_password>@mycluster.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```

> Self-hosted MongoDB (Docker, VPS, MongoDB Atlas Dedicated) works identically
> — any server reachable from Vercel is fine.

Optional pre-flight check from your machine:

```bash
cd 9router-vercel
npm install --no-save mongodb@6
export MONGODB_URI="mongodb+srv://…"
node deploy/verify-mongodb.mjs     # pings + write/read/delete probe
```

### Step 2 — Push this folder to a new GitHub repo

```bash
cd 9router-vercel
git init
git add .
git commit -m "9Router on Vercel + MongoDB"
git remote add origin git@github.com:<you>/9router-vercel.git
git push -u origin master
```

### Step 3 — Import into Vercel

1. <https://vercel.com/new> → pick the repo you just pushed.
2. Framework auto-detects **Next.js**. Build settings are read from
   `vercel.json` (install command adds the MongoDB driver at build time —
   `package.json` stays upstream-pristine).

### Step 4 — Set environment variables

Project → **Settings → Environment Variables** (all environments):

| Variable | Required | Value |
|---|---|---|
| `MONGODB_URI` | ✅ | your Atlas connection string |
| `JWT_SECRET` | ✅ | `openssl rand -base64 32` |
| `INITIAL_PASSWORD` | ✅ | dashboard login password (**never** ship the default `123456` publicly) |
| `MONGODB_DB` | — | database name (default `9router`) |
| `DATA_DIR` | — | already defaulted to `/tmp/9router` in `vercel.json` |
| `ENABLE_REQUEST_LOGS` | — | `false` (already defaulted in `vercel.json`) |

Full reference: [`deploy/env.vercel.example`](deploy/env.vercel.example).

### Step 5 — Deploy and verify

Click **Deploy**. After it finishes:

1. Open `https://<your-app>.vercel.app` → log in with `INITIAL_PASSWORD`.
2. Vercel → Project → **Logs** → you should see:
   `[DB] Driver: sql.js+mongodb | store: mongodb | build noflush-v3`
3. Add a provider connection in the dashboard → refresh the page. If it
   persists, MongoDB round-trips are working.

You can also re-run `node deploy/verify-mongodb.mjs` — it now reports the
stored image size/version.

---

## 📦 Bringing existing local data

Used 9Router on your desktop and want the same providers/keys/usage online?

```bash
cd 9router-vercel
npm install --no-save mongodb@6
export MONGODB_URI="mongodb+srv://…"
node deploy/import-local-sqlite.mjs                 # uses ~/.9router/db/data.sqlite
# or: node deploy/import-local-sqlite.mjs --file /path/to/data.sqlite --force
```

Then redeploy (or just wait for the next cold start — the new image is
picked up automatically).

---

## 🔧 What differs from upstream

Everything is additive except **one file**, patched by a re-runnable script:

| Path | Status |
|---|---|
| `src/lib/db/adapters/mongoSqliteAdapter.js` | **added** — MongoDB image-persistence adapter |
| `src/lib/db/driver.js` | **patched** — 20-line `MONGODB_URI`-guarded branch at the top of `initAdapter()` |
| `vercel.json` | **added** — Vercel build config |
| `deploy/*` | **added** — patch tool, verify/import scripts, env template |
| `VERCEL.md` | **added** — this guide |
| everything else | identical to upstream `decolua/9router@master` |

The patch is idempotent and mechanical:

```bash
node deploy/apply-mongodb-patch.mjs     # run any time; no-op if already applied
```

Without `MONGODB_URI` set, the hook is inert and the app behaves exactly like
upstream (local SQLite). With it, the MongoDB adapter takes over.

### Updating from upstream

```bash
# from inside 9router-vercel (this folder is its own git repo after Step 2)
git remote add upstream https://github.com/decolua/9router.git   # once
git fetch upstream
git merge upstream/master         # resolve conflicts if driver.js moved
node deploy/apply-mongodb-patch.mjs
git add -A && git commit -m "sync upstream" && git push   # Vercel redeploys
```

If the patch script reports the anchor is missing (upstream refactored
`driver.js`), port the guarded block from `deploy/apply-mongodb-patch.mjs`
into the new `initAdapter()` — it is self-contained by design.

### Leaving MongoDB mode

Remove the `MONGODB_URI` environment variable in Vercel and redeploy — the
app falls back to upstream local-SQLite behavior (stateless, resets on cold
start). Nothing in MongoDB is deleted.
