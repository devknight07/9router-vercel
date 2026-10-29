#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 9Router on Vercel + MongoDB — driver wiring patch
//
// This is the ONLY code deviation from upstream 9Router in this deployment
// folder, and it is applied by this script (so you can re-run it after
// pulling upstream updates):
//
//   node deploy/apply-mongodb-patch.mjs
//
// What it does
//   • Adds a new file  src/lib/db/adapters/mongoSqliteAdapter.js  (additive)
//   • Inserts a guarded branch at the top of initAdapter() in
//     src/lib/db/driver.js — active ONLY when MONGODB_URI is set.
//
// Without MONGODB_URI the app behaves exactly like upstream (local SQLite).
// With it, the whole database image is persisted to MongoDB, which is what
// makes 9Router stateless-safe for Vercel serverless hosting.
//
// Idempotent: safe to run any number of times.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const deployDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(deployDir, "..");

const DRIVER_FILE = join(projectRoot, "src", "lib", "db", "driver.js");
const ADAPTER_SRC = join(deployDir, "mongoSqliteAdapter.js");
const ADAPTER_DST = join(projectRoot, "src", "lib", "db", "adapters", "mongoSqliteAdapter.js");

const MARKER = "Vercel+MongoDB deploy hook";
const ANCHOR = `async function initAdapter() {\n  ensureDirs();`;

const PATCH_BLOCK = `
  // ── ${MARKER} (added by deploy/apply-mongodb-patch.mjs — not upstream) ──
  // Active ONLY when MONGODB_URI is set: persists the SQLite image to
  // MongoDB so 9Router can run statelessly (Vercel serverless). Without the
  // env var this branch is skipped and upstream SQLite behavior is unchanged.
  if (process.env.MONGODB_URI) {
    try {
      const { createMongoSqliteAdapter } = await import("./adapters/mongoSqliteAdapter.js");
      const mongoAdapter = withNullByteSafeParams(await createMongoSqliteAdapter());
      if (!state.logged) {
        console.log(\`[DB] Driver: \${mongoAdapter.driver} | store: mongodb | build \${mongoAdapter.build}\`);
        state.logged = true;
      }
      const migrateMod = await import("./migrate.js");
      await migrateMod.runMigrationOnce(mongoAdapter);
      return mongoAdapter;
    } catch (e) {
      console.warn(\`[DB] MongoDB adapter unavailable (\${e?.stack || e?.message || e}) → falling back to local SQLite\`);
    }
  }
  // ── End ${MARKER} ──
`;

// 1. Copy the adapter source into the app's adapter directory (additive).
if (!existsSync(ADAPTER_SRC)) {
  console.error(`[patch] missing ${ADAPTER_SRC} — this file ships with the deployment folder`);
  process.exit(1);
}
mkdirSync(dirname(ADAPTER_DST), { recursive: true });
copyFileSync(ADAPTER_SRC, ADAPTER_DST);
console.log(`[patch] adapter installed → ${join("src", "lib", "db", "adapters", "mongoSqliteAdapter.js")}`);

// 2. Wire it into the driver (guarded branch).
const src = readFileSync(DRIVER_FILE, "utf-8");

if (src.includes(MARKER)) {
  console.log("[patch] driver.js already patched — nothing to do");
  process.exit(0);
}

if (!src.includes(ANCHOR)) {
  console.error(
    "[patch] anchor not found in src/lib/db/driver.js — upstream file changed.\n" +
    "        Re-generate the patch against the new upstream driver.js (see deploy/README.md → 'Updating from upstream')."
  );
  process.exit(1);
}

const patched = src.replace(ANCHOR, `${ANCHOR}${PATCH_BLOCK}`);
writeFileSync(DRIVER_FILE, patched);
console.log("[patch] driver.js wired → MONGODB_URI branch installed");
console.log("[patch] done. Original clone at ../9router was never touched.");
