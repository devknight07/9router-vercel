#!/usr/bin/env node
// Verifies MongoDB connectivity and write permissions before/after deploy.
//
//   node deploy/verify-mongodb.mjs
//
// Reads MONGODB_URI (and optional MONGODB_DB / MONGODB_DB_COLLECTION) from
// the environment. Locally, install the driver first (it is NOT a repo
// dependency by design — see vercel.json installCommand):
//
//   npm install --no-save mongodb@6

import { existsSync, readFileSync } from "node:fs";

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadDotEnv(new URL("../.env", import.meta.url).pathname);

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set. Example:\n  export MONGODB_URI='mongodb+srv://user:pass@cluster.mongodb.net/'");
  process.exit(1);
}

const dbName = process.env.MONGODB_DB || "9router";
const collectionName = process.env.MONGODB_DB_COLLECTION || "sqlite_store";

let client;
try {
  const { MongoClient } = await import("mongodb");
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  console.log(`[verify] connecting…`);
  await client.connect();
  await client.db("admin").command({ ping: 1 });
  console.log(`[verify] ping OK`);

  const col = client.db(dbName).collection(collectionName);
  // Write/read/delete probe — catches read-only users and IP-denied writes.
  const probeId = "__9router_probe__";
  await col.updateOne({ _id: probeId }, { $set: { t: new Date() } }, { upsert: true });
  const got = await col.findOne({ _id: probeId });
  if (!got) throw new Error("probe write not readable back");
  await col.deleteOne({ _id: probeId });
  console.log(`[verify] write/read/delete probe OK (db: ${dbName}, collection: ${collectionName})`);

  const image = await col.findOne({ _id: "data.sqlite" }, { projection: { rawSize: 1, version: 1, updatedAt: 1 } });
  if (image) {
    const mb = ((image.rawSize || 0) / 1048576).toFixed(2);
    console.log(`[verify] existing 9Router DB image: v${image.version}, ~${mb} MB raw, updated ${image.updatedAt?.toISOString?.() || image.updatedAt}`);
  } else {
    console.log("[verify] no existing 9Router DB image — first boot will create it");
  }
  console.log("[verify] MongoDB is ready for 9Router ✔");
} catch (e) {
  console.error(`[verify] FAILED: ${e?.message || e}`);
  console.error("Hints: check Atlas → Network Access (allow 0.0.0.0/0 for Vercel), database user password, and URI scheme (mongodb+srv://).");
  process.exitCode = 1;
} finally {
  try { await client?.close(); } catch {}
}
