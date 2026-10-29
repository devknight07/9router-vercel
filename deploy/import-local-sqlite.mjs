#!/usr/bin/env node
// Uploads an existing local 9Router SQLite database into MongoDB so a fresh
// Vercel deployment continues where your desktop install left off.
//
//   npm install --no-save mongodb@6
//   node deploy/import-local-sqlite.mjs [--file <path-to-data.sqlite>] [--force]
//
// Defaults to the standard local location: ~/.9router/db/data.sqlite
// (or $DATA_DIR/db/data.sqlite when DATA_DIR is set).
// Refuses to overwrite an existing MongoDB image unless --force is passed.

import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
const gzip = promisify(zlib.gzip);

const args = process.argv.slice(2);
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const has = (name) => args.includes(name);

const dataDir = process.env.DATA_DIR || path.join(os.homedir(), ".9router");
const file = argOf("--file") || path.join(dataDir, "db", "data.sqlite");

if (!existsSync(file)) {
  console.error(`[import] SQLite file not found: ${file}\nPass --file /path/to/data.sqlite`);
  process.exit(1);
}
if (!process.env.MONGODB_URI) {
  console.error("[import] MONGODB_URI is not set.");
  process.exit(1);
}

const raw = readFileSync(file);
const packed = await gzip(raw);
if (packed.length > 15 * 1048576) {
  console.error(`[import] gzipped image is ${(packed.length / 1048576).toFixed(1)} MB — exceeds MongoDB's 16 MB document limit. Prune usage history locally first.`);
  process.exit(1);
}

const { MongoClient } = await import("mongodb");
const dbName = process.env.MONGODB_DB || "9router";
const collectionName = process.env.MONGODB_DB_COLLECTION || "sqlite_store";
const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

try {
  await client.connect();
  const col = client.db(dbName).collection(collectionName);
  const existing = await col.findOne({ _id: "data.sqlite" });
  if (existing && !has("--force")) {
    console.error(`[import] MongoDB already holds a DB image (v${existing.version}, updated ${existing.updatedAt}). Re-run with --force to overwrite.`);
    process.exit(1);
  }
  const r = await col.updateOne(
    { _id: "data.sqlite" },
    {
      $set: { data: packed, rawSize: raw.length, updatedAt: new Date() },
      $inc: { version: existing ? 1 : 0 },
      $setOnInsert: { version: 1, createdAt: new Date() },
    },
    { upsert: true }
  );
  console.log(`[import] uploaded ${file}`);
  console.log(`[import]   raw ${(raw.length / 1048576).toFixed(2)} MB → gzipped ${(packed.length / 1048576).toFixed(2)} MB`);
  console.log(`[import]   → mongodb:${dbName}/${collectionName} (matched=${r.matchedCount}, upserted=${r.upsertedCount ?? "-"})`);
  console.log("[import] done — deploy (or redeploy) 9Router on Vercel and log in.");
} finally {
  try { await client.close(); } catch {}
}
