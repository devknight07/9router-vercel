// 9Router on Vercel — MongoDB-backed persistence adapter.
//
// Deploy-only addition. NOT part of upstream 9Router. Loaded by the guarded
// branch in driver.js (see deploy/apply-mongodb-patch.mjs) when MONGODB_URI
// is set. When the env var is absent, upstream behavior is 100% unchanged.
//
// ─── Design ────────────────────────────────────────────────────────────────
// 9Router's whole data layer (repos, migrations, backup) speaks SQLite SQL.
// Re-translating every query to native MongoDB operations would mean forking
// the entire data layer. Instead, this adapter keeps sql.js (WASM SQLite —
// already an upstream dependency, byte-compatible SQL engine) as the query
// engine and stores the database IMAGE in MongoDB:
//
//   MongoDB (Atlas or self-hosted)
//   └── collection "sqlite_store"
//       └── doc { _id: "data.sqlite", data: <gzip'd SQLite image>, ... }
//
// Every acknowledged write schedules an image flush (debounced + serialized).
// Cold lambda start → image downloaded once → warm queries served from
// memory at native SQLite speed. Data survives cold starts, works across
// serverless instances, and needs zero upstream SQL changes.
//
// Trade-offs (documented in deploy/README.md):
//   • Image persistence: write cost scales with DB size (fine for a personal
//     router: typical image ≪ 5 MB gzipped; MongoDB doc cap is 16 MB).
//   • Multi-instance writes resolve last-write-wins per image (version field
//     detects conflicts and logs a warning). Single-admin usage is the
//     intended pattern, same as self-hosted 9Router.

import zlib from "node:zlib";
import { promisify } from "node:util";
import initSqlJs from "sql.js";
import { PRAGMA_SQL } from "../schema.js";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const DRIVER_NAME = "sql.js+mongodb";
const ADAPTER_BUILD = "noflush-v3";
// MongoDB document hard limit is 16 MiB (16 × 1048576 bytes).
const DOC_LIMIT_BYTES = 16 * 1048576;
const DOC_LIMIT_WARN_BYTES = Math.floor(DOC_LIMIT_BYTES * 0.8);

let SQL = null;
async function loadSql() {
  if (SQL) return SQL;
  SQL = await initSqlJs();
  return SQL;
}

export async function createMongoSqliteAdapter(opts = {}) {
  const uri = opts.uri || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  const dbName = opts.dbName || process.env.MONGODB_DB || "9router";
  const collectionName = opts.collectionName || process.env.MONGODB_DB_COLLECTION || "sqlite_store";
  const fileName = "data.sqlite";

  // ── Connect ──────────────────────────────────────────────────────────────
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000,
    retryWrites: true,
    appName: "9router-vercel",
  });
  await client.connect();
  await client.db("admin").command({ ping: 1 });

  const collection = client.db(dbName).collection(collectionName);

  // ── Load image ───────────────────────────────────────────────────────────
  const SQLLib = await loadSql();
  const doc = await collection.findOne({ _id: fileName });
  let imageVersion = doc ? doc.version || 0 : 0;
  const initialBuf = doc && doc.data ? await gunzip(doc.data.buffer ? Buffer.from(doc.data.buffer) : Buffer.from(doc.data)) : null;
  const db = new SQLLib.Database(initialBuf);
  db.exec(PRAGMA_SQL);

  // ── Persistence ──────────────────────────────────────────────────────────
  // Timer-free coalescing: every write schedules a persist on a serialized
  // chain. The FIRST chained task runs on the next microtask — by then the
  // current synchronous burst (e.g. a multi-row transaction) has finished and
  // one persist captures all of it. Writes landing DURING an in-flight
  // persist leave `dirty` set and are picked up by the next chained task.
  // Durability window is therefore a single in-flight persist, not a timer —
  // the right shape for serverless, where the runtime may freeze the isolate
  // right after the response is returned.
  let dirty = false;
  let saveChain = Promise.resolve();
  let lastError = null;

  async function persist() {
    const raw = Buffer.from(db.export());
    const packed = await gzip(raw);
    if (packed.length > DOC_LIMIT_BYTES) {
      throw new Error(
        `[mongoSqlite] DB image too large for one MongoDB document (${(packed.length / 1048576).toFixed(1)} MB gzipped, limit 16 MB). ` +
        "Trim usage history (Dashboard → Usage → clear old records) or disable request logs (ENABLE_REQUEST_LOGS=false), then retry."
      );
    }
    if (packed.length > DOC_LIMIT_WARN_BYTES) {
      console.warn(`[mongoSqlite] DB image nearing MongoDB 16 MB doc limit: ${(packed.length / 1048576).toFixed(1)} MB gzipped`);
    }

    // Optimistic concurrency: only overwrite the version we loaded/last saw.
    // On conflict (another instance wrote), re-read the stored version and
    // force-write anyway (last-write-wins) with a loud warning.
    const res = await collection.updateOne(
      { _id: fileName, version: imageVersion },
      {
        $set: { data: packed, rawSize: raw.length, updatedAt: new Date() },
        $inc: { version: 1 },
      },
      { upsert: true }
    );

    if (!res.acknowledged || (res.matchedCount === 0 && res.upsertedCount === 0)) {
      const cur = await collection.findOne({ _id: fileName }, { projection: { version: 1 } });
      console.warn(
        `[mongoSqlite] write conflict (local v${imageVersion} vs stored v${cur?.version ?? "?"}) — applying last-write-wins`
      );
      imageVersion = (cur?.version || 0) + 1;
      await collection.updateOne(
        { _id: fileName },
        {
          $set: { data: packed, rawSize: raw.length, updatedAt: new Date(), version: imageVersion },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true }
      );
    } else {
      imageVersion += 1;
    }
  }

  function requestPersist() {
    dirty = true;
    saveChain = saveChain
      .then(() => {
        // Snapshot boundary: drop the flag BEFORE exporting so any write that
        // lands during the async persist re-dirties and gets its own follow-up
        // pass. Clearing at the END would swallow those writes (lost update).
        if (!dirty) return;
        dirty = false;
        return persist();
      })
      .then(() => { lastError = null; })
      .catch((e) => {
        lastError = e;
        console.error("[mongoSqlite] persist failed:", e?.message || e);
      });
  }

  async function flush() {
    await saveChain;
    if (dirty) {
      requestPersist();
      await saveChain;
    }
    if (lastError) throw lastError;
  }

  // ── SQL interface (mirrors sqljsAdapter.js exactly) ──────────────────────
  function paramsObj(params) {
    if (!params || (Array.isArray(params) && params.length === 0)) return undefined;
    return params;
  }

  function run(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      stmt.step();
      const changes = db.getRowsModified();
      const lastInsertRowid = db.exec("SELECT last_insert_rowid() as id")[0]?.values?.[0]?.[0] ?? null;
      requestPersist();
      return { changes, lastInsertRowid };
    } finally {
      stmt.free();
    }
  }

  function get(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      if (stmt.step()) return stmt.getAsObject();
      return undefined;
    } finally {
      stmt.free();
    }
  }

  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  function exec(sql) {
    db.exec(sql);
    requestPersist();
  }

  function transaction(fn) {
    const sp = `sp_${Math.random().toString(36).slice(2)}`;
    db.exec(`SAVEPOINT ${sp}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${sp}`);
      requestPersist();
      return result;
    } catch (e) {
      try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch {}
      throw e;
    }
  }

  async function close() {
    try { await flush(); } catch {}
    try { await client.close(); } catch {}
  }

  // Best-effort flush on shutdown (works for long-running hosts; serverless
  // freeze-loss window is bounded by the 50 ms debounce).
  const flushSyncish = () => { flush().catch(() => {}); };
  process.on("beforeExit", flushSyncish);
  process.on("SIGINT", flushSyncish);
  process.on("SIGTERM", flushSyncish);

  return {
    driver: DRIVER_NAME,
    build: ADAPTER_BUILD,
    run, get, all, exec, transaction, close, flush,
    raw: db,
    mongo: { client, collection, dbName, collectionName },
  };
}
