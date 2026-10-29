#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 9Router MongoDB Sync UI — local web UI server
//
// Run from the repo root:
//   node deploy/ui-server.mjs
//
// Opens http://localhost:9737 in your browser.
// Reads MONGODB_URI from .env automatically if present.
//
// This is a STANDALONE tool in deploy/ — it does NOT touch src/ or any other
// folder. All serving, API, and UI code lives here in deploy/.
// ─────────────────────────────────────────────────────────────────────────────

import http from "node:http";
import { existsSync, readFileSync, createReadStream } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "..");

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const PORT = process.env.MONGO_UI_PORT || 9737;

// ── .env loader ──────────────────────────────────────────────────────────────
function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
loadDotEnv(join(ROOT, ".env"));

// ── MongoDB helpers ───────────────────────────────────────────────────────────
async function getMongoClient(uri) {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    retryWrites: true,
    appName: "9router-mongo-ui",
  });
  await client.connect();
  return client;
}

function getCollection(client, dbName, collName) {
  return client.db(dbName).collection(collName);
}

// ── API handlers ──────────────────────────────────────────────────────────────
async function apiVerify(body) {
  const uri = body.uri || process.env.MONGODB_URI || "";
  if (!uri) throw new Error("MONGODB_URI not provided");

  const dbName = body.db || process.env.MONGODB_DB || "9router";
  const collName = body.collection || process.env.MONGODB_DB_COLLECTION || "sqlite_store";

  const client = await getMongoClient(uri);
  try {
    await client.db("admin").command({ ping: 1 });
    const col = getCollection(client, dbName, collName);

    // Probe write / read / delete
    const probeId = "__9router_probe__";
    await col.updateOne({ _id: probeId }, { $set: { t: new Date() } }, { upsert: true });
    const got = await col.findOne({ _id: probeId });
    if (!got) throw new Error("Probe write not readable back");
    await col.deleteOne({ _id: probeId });

    // Image info
    const image = await col.findOne({ _id: "data.sqlite" }, {
      projection: { rawSize: 1, version: 1, updatedAt: 1 },
    });

    return {
      ok: true,
      ping: "OK",
      probe: "OK",
      dbName,
      collectionName: collName,
      image: image ? {
        version: image.version,
        rawSizeMB: ((image.rawSize || 0) / 1048576).toFixed(2),
        updatedAt: image.updatedAt?.toISOString?.() || image.updatedAt || null,
      } : null,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function apiStatus(body) {
  const uri = body.uri || process.env.MONGODB_URI || "";
  if (!uri) throw new Error("MONGODB_URI not provided");

  const dbName = body.db || process.env.MONGODB_DB || "9router";
  const collName = body.collection || process.env.MONGODB_DB_COLLECTION || "sqlite_store";

  const client = await getMongoClient(uri);
  try {
    const col = getCollection(client, dbName, collName);
    const image = await col.findOne({ _id: "data.sqlite" }, {
      projection: { rawSize: 1, version: 1, updatedAt: 1, createdAt: 1 },
    });
    return {
      ok: true,
      image: image ? {
        version: image.version,
        rawSizeMB: ((image.rawSize || 0) / 1048576).toFixed(2),
        updatedAt: image.updatedAt?.toISOString?.() || null,
        createdAt: image.createdAt?.toISOString?.() || null,
      } : null,
      dbName,
      collectionName: collName,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function apiImport(body) {
  const uri = body.uri || process.env.MONGODB_URI || "";
  if (!uri) throw new Error("MONGODB_URI not provided");

  const dbName = body.db || process.env.MONGODB_DB || "9router";
  const collName = body.collection || process.env.MONGODB_DB_COLLECTION || "sqlite_store";
  const force = !!body.force;

  // Resolve sqlite path
  const dataDir = process.env.DATA_DIR && !/^\//.test(process.env.DATA_DIR)
    ? process.env.DATA_DIR
    : (process.platform === "win32"
        ? join(process.env.APPDATA || join(os.homedir(), "AppData", "Roaming"), "9router")
        : join(os.homedir(), ".9router"));
  const sqliteFile = body.file || join(dataDir, "db", "data.sqlite");

  if (!existsSync(sqliteFile)) {
    throw new Error(`SQLite file not found: ${sqliteFile}`);
  }

  const raw = readFileSync(sqliteFile);
  const packed = await gzip(raw);

  if (packed.length > 15 * 1048576) {
    throw new Error(
      `Gzipped image is ${(packed.length / 1048576).toFixed(1)} MB — exceeds MongoDB 16 MB document limit. ` +
      "Prune usage history locally first."
    );
  }

  const client = await getMongoClient(uri);
  try {
    const col = getCollection(client, dbName, collName);
    const existing = await col.findOne({ _id: "data.sqlite" });

    if (existing && !force) {
      throw new Error(
        `MongoDB already has a DB image (v${existing.version}, updated ${existing.updatedAt?.toISOString?.() || existing.updatedAt}). ` +
        "Enable 'Force overwrite' to replace it."
      );
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

    return {
      ok: true,
      file: sqliteFile,
      rawSizeMB: (raw.length / 1048576).toFixed(2),
      gzippedSizeMB: (packed.length / 1048576).toFixed(2),
      matched: r.matchedCount,
      upserted: r.upsertedCount ?? 0,
      dbName,
      collectionName: collName,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function apiDownload(body) {
  const uri = body.uri || process.env.MONGODB_URI || "";
  if (!uri) throw new Error("MONGODB_URI not provided");

  const dbName = body.db || process.env.MONGODB_DB || "9router";
  const collName = body.collection || process.env.MONGODB_DB_COLLECTION || "sqlite_store";

  const client = await getMongoClient(uri);
  try {
    const col = getCollection(client, dbName, collName);
    const doc = await col.findOne({ _id: "data.sqlite" });
    if (!doc || !doc.data) throw new Error("No DB image found in MongoDB");

    const packed = doc.data.buffer ? Buffer.from(doc.data.buffer) : Buffer.from(doc.data);
    const raw = await gunzip(packed);

    return {
      ok: true,
      version: doc.version,
      rawSizeMB: (raw.length / 1048576).toFixed(2),
      gzippedSizeMB: (packed.length / 1048576).toFixed(2),
      // Return base64 so UI can offer a download
      base64: raw.toString("base64"),
    };
  } finally {
    await client.close().catch(() => {});
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", rej);
  });
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function jsonError(res, e, status = 500) {
  json(res, { ok: false, error: e?.message || String(e) }, status);
}

const UI_HTML_PATH = join(__dir, "ui.html");

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);

  // Serve the main UI
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    if (existsSync(UI_HTML_PATH)) {
      const content = readFileSync(UI_HTML_PATH);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": content.length });
      res.end(content);
    } else {
      res.writeHead(404); res.end("ui.html not found");
    }
    return;
  }

  // Expose current env config to pre-fill the form
  if (req.method === "GET" && pathname === "/api/config") {
    const dataDir = process.env.DATA_DIR && process.platform === "win32" && /^\//.test(process.env.DATA_DIR)
      ? join(process.env.APPDATA || join(os.homedir(), "AppData", "Roaming"), "9router")
      : (process.env.DATA_DIR || (process.platform === "win32"
          ? join(process.env.APPDATA || join(os.homedir(), "AppData", "Roaming"), "9router")
          : join(os.homedir(), ".9router")));
    const defaultSqlitePath = join(dataDir, "db", "data.sqlite");

    json(res, {
      uri: process.env.MONGODB_URI || "",
      db: process.env.MONGODB_DB || "9router",
      collection: process.env.MONGODB_DB_COLLECTION || "sqlite_store",
      defaultSqlitePath,
      mongodbInstalled: await import("mongodb").then(() => true).catch(() => false),
    });
    return;
  }

  // API endpoints (POST + JSON body)
  if (req.method === "POST") {
    let body;
    try {
      body = JSON.parse(await readBody(req) || "{}");
    } catch {
      jsonError(res, new Error("Invalid JSON body"), 400); return;
    }

    try {
      if (pathname === "/api/verify")   { json(res, await apiVerify(body)); return; }
      if (pathname === "/api/status")   { json(res, await apiStatus(body)); return; }
      if (pathname === "/api/import")   { json(res, await apiImport(body)); return; }
      if (pathname === "/api/download") { json(res, await apiDownload(body)); return; }
    } catch (e) {
      jsonError(res, e); return;
    }
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n🍃 9Router MongoDB Sync UI`);
  console.log(`   → ${url}\n`);

  // Best-effort browser open
  import("node:child_process").then(({ exec }) => {
    const cmd = process.platform === "win32" ? `start "" "${url}"` :
                process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd);
  }).catch(() => {});
});
