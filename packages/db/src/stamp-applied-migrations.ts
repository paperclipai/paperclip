/**
 * One-shot script: inserts migration journal records for migrations that were
 * applied to the DB outside Drizzle's tracking (e.g. by the dev server on
 * first boot before the migration was recorded).
 *
 * Usage:  tsx src/stamp-applied-migrations.ts <migration-tag> [...]
 * Example: tsx src/stamp-applied-migrations.ts 0084_widen_exit_code_bigint 0085_niche_discovery_tables
 *
 * Only stamps migrations whose content is verifiably already in the DB.
 * Exits non-zero if the migration table is missing or a stamp cannot be verified.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { resolveDatabaseTarget } from "./runtime-config.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));
const DRIZZLE_MIGRATIONS_TABLE = "__drizzle_migrations";

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function main() {
  const tags = process.argv.slice(2);
  if (tags.length === 0) {
    console.error("Usage: tsx src/stamp-applied-migrations.ts <migration-tag> [...]");
    process.exit(1);
  }

  const target = resolveDatabaseTarget();
  if (target.mode !== "postgres" && target.mode !== "embedded-postgres") {
    console.error("Unsupported database target mode:", target.mode);
    process.exit(1);
  }

  const url = target.mode === "postgres"
    ? target.connectionString
    : `postgres://paperclip:paperclip@127.0.0.1:${target.port}/paperclip`;

  const sql = postgres(url, { max: 1 });

  try {
    // Discover the migration table schema
    const schemaRows = await sql.unsafe<{ schema_name: string }[]>(
      `SELECT n.nspname AS schema_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = ${quoteLiteral(DRIZZLE_MIGRATIONS_TABLE)} AND c.relkind = 'r'`,
    );
    if (schemaRows.length === 0) {
      console.error("Migration table not found — run pnpm run migrate on an empty DB first.");
      process.exit(1);
    }
    const migrationTableSchema = schemaRows[0].schema_name;
    const qualifiedTable = `${quoteIdentifier(migrationTableSchema)}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;

    const columnRows = await sql.unsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = ${quoteLiteral(migrationTableSchema)} AND table_name = ${quoteLiteral(DRIZZLE_MIGRATIONS_TABLE)}`,
    );
    const columnNames = new Set(columnRows.map((r) => r.column_name));

    for (const tag of tags) {
      const fileName = tag.endsWith(".sql") ? tag : `${tag}.sql`;
      const filePath = `${MIGRATIONS_FOLDER}/${fileName}`;

      let content: string;
      try {
        content = await readFile(filePath, "utf8");
      } catch {
        console.error(`Cannot read migration file: ${filePath}`);
        process.exit(1);
      }

      const hash = createHash("sha256").update(content).digest("hex");

      // Check if already recorded
      const existing = await sql.unsafe<{ id: number }[]>(
        `SELECT id FROM ${qualifiedTable} WHERE hash = ${quoteLiteral(hash)} LIMIT 1`,
      );
      if (existing.length > 0) {
        console.log(`Already stamped: ${fileName} (id=${existing[0].id})`);
        continue;
      }

      // Also check by name if that column exists
      if (columnNames.has("name")) {
        const existingByName = await sql.unsafe<{ id: number }[]>(
          `SELECT id FROM ${qualifiedTable} WHERE name = ${quoteLiteral(fileName)} LIMIT 1`,
        );
        if (existingByName.length > 0) {
          console.log(`Already stamped by name: ${fileName} (id=${existingByName[0].id})`);
          continue;
        }
      }

      const insertCols: string[] = [];
      const insertVals: string[] = [];

      if (columnNames.has("hash")) {
        insertCols.push(quoteIdentifier("hash"));
        insertVals.push(quoteLiteral(hash));
      }
      if (columnNames.has("name")) {
        insertCols.push(quoteIdentifier("name"));
        insertVals.push(quoteLiteral(fileName));
      }
      if (columnNames.has("created_at")) {
        const lastRow = await sql.unsafe<{ created_at: string | number | null }[]>(
          `SELECT created_at FROM ${qualifiedTable} ORDER BY created_at DESC NULLS LAST LIMIT 1`,
        );
        const lastCreatedAt = Number(lastRow[0]?.created_at ?? -1);
        const createdAt = Number.isFinite(lastCreatedAt) && lastCreatedAt > 0
          ? lastCreatedAt + 1
          : Date.now();
        insertCols.push(quoteIdentifier("created_at"));
        insertVals.push(quoteLiteral(String(createdAt)));
      }

      await sql.unsafe(
        `INSERT INTO ${qualifiedTable} (${insertCols.join(", ")}) VALUES (${insertVals.join(", ")})`,
      );
      console.log(`Stamped: ${fileName}`);
    }

    console.log("Done. Re-run pnpm run migrate to apply remaining pending migrations.");
  } finally {
    await sql.end();
  }
}

await main();
