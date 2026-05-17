#!/usr/bin/env node

import pg from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(__dirname, "../packages/db/src/migrations/0088_crewbrief_last_active_date.sql");
const sql = readFileSync(migrationPath, "utf-8");

const connectionString = process.env.DATABASE_URL || process.argv[2];
if (!connectionString) {
  console.error("Usage: DATABASE_URL=postgres://... node scripts/apply-crewbrief-0088-migration.mjs");
  console.error("   or: node scripts/apply-crewbrief-0088-migration.mjs postgres://...");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString });
try {
  const client = await pool.connect();
  try {
    console.log("Connected to database. Running migration 0088...");
    await client.query(sql);
    console.log("Migration 0088 applied successfully.");
    console.log("Changes:");
    console.log("  - Added column 'last_active_date' to 'crewbrief_waitlist_entries'");
    console.log("  - Created index 'cb_waitlist_last_active_idx' on 'last_active_date'");
  } finally {
    client.release();
  }
} catch (err) {
  if (err.message?.includes("already exists")) {
    console.log("Migration already applied (idempotent).");
  } else {
    console.error("Migration failed:", err.message);
    process.exit(1);
  }
} finally {
  await pool.end();
}
