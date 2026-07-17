#!/usr/bin/env node
// db-assert.mjs — sanctioned runtime-DB assertion helper for `db`-type content-verify probes
// (NEO-527, subtask 522b). It answers "did this migration/table/column/seed actually land?" by
// querying through the app's Drizzle client (@paperclipai/db), NEVER a raw psql client
// (Hard Rule #1). It targets the SAME database the running instance uses, derived from the
// instance config (PAPERCLIP_CONFIG), so a probe asserts the live schema, not some other DB.
//
// It prints `db-assert: OK …` and exits 0 when the assertion holds, or `db-assert: FAIL …` and
// exits 1 otherwise — so a release-probes/<ISSUE>.yaml db probe can grep for `db-assert: OK`.
//
// Usage (assertion is one of --regclass / --column / --sql):
//   node scripts/db-assert.mjs --regclass public.brand_kits
//   node scripts/db-assert.mjs --column brand_kits.design_md
//   node scripts/db-assert.mjs --sql "select 1 from brand_kits limit 1" --expect-nonempty
//
// Connection resolution (first match wins):
//   --connection <url>                  explicit postgres URL
//   --config <path> / $PAPERCLIP_CONFIG instance config; embedded-postgres → derived URL,
//                                       postgres → the configured connectionString

import { readFile } from "node:fs/promises";

function parseArgs(argv) {
  const o = { config: process.env.PAPERCLIP_CONFIG ?? "", connection: "", regclass: "", column: "", sql: "", expectNonEmpty: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case "--config": o.config = argv[++i] ?? ""; break;
      case "--connection": o.connection = argv[++i] ?? ""; break;
      case "--regclass": o.regclass = argv[++i] ?? ""; break;
      case "--column": o.column = argv[++i] ?? ""; break;
      case "--sql": o.sql = argv[++i] ?? ""; break;
      case "--expect-nonempty": o.expectNonEmpty = true; break;
      case "-h": case "--help": o.help = true; break;
      default: throw new Error(`unknown arg: ${a}`);
    }
  }
  return o;
}

async function resolveConnectionString(o) {
  if (o.connection) return o.connection;
  if (!o.config) throw new Error("no --connection and no --config/$PAPERCLIP_CONFIG to derive the DB from");
  const cfg = JSON.parse(await readFile(o.config, "utf8"));
  const db = cfg.database ?? {};
  if (db.mode === "postgres") {
    if (!db.connectionString) throw new Error("config database.mode=postgres but no connectionString");
    return db.connectionString;
  }
  if (db.mode === "embedded-postgres") {
    const port = db.embeddedPostgresPort;
    if (!port) throw new Error("config database.mode=embedded-postgres but no embeddedPostgresPort");
    // Mirrors packages/db/src/migration-runtime.ts embedded connection derivation.
    return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  }
  throw new Error(`unsupported database.mode: ${String(db.mode)}`);
}

function rowsOf(res) {
  return Array.isArray(res) ? res : (res?.rows ?? []);
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`db-assert: ${err.message}\n`);
    return 2;
  }
  if (o.help) {
    process.stdout.write("db-assert: --regclass <schema.table> | --column <table.column> | --sql <q> [--expect-nonempty]\n");
    return 0;
  }
  const assertions = [o.regclass, o.column, o.sql].filter(Boolean);
  if (assertions.length !== 1) {
    process.stderr.write("db-assert: exactly one of --regclass / --column / --sql is required\n");
    return 2;
  }

  let connectionString;
  try {
    connectionString = await resolveConnectionString(o);
  } catch (err) {
    process.stdout.write(`db-assert: FAIL could not resolve DB — ${err.message}\n`);
    return 1;
  }

  let createDb;
  try {
    ({ createDb } = await import("../packages/db/dist/index.js"));
  } catch (err) {
    process.stdout.write(`db-assert: FAIL cannot load @paperclipai/db runtime client — ${err.message}\n`);
    return 1;
  }

  const db = createDb(connectionString);
  try {
    if (o.regclass) {
      const res = await db.execute(`select to_regclass('${o.regclass.replace(/'/g, "''")}') as t`);
      const val = rowsOf(res)[0]?.t;
      if (val == null) {
        process.stdout.write(`db-assert: FAIL relation ${o.regclass} does not exist\n`);
        return 1;
      }
      process.stdout.write(`db-assert: OK relation ${o.regclass} exists\n`);
      return 0;
    }
    if (o.column) {
      const [table, column] = o.column.split(".");
      if (!table || !column) {
        process.stdout.write(`db-assert: FAIL --column must be <table.column>, got ${o.column}\n`);
        return 1;
      }
      const res = await db.execute(
        `select 1 from information_schema.columns where table_name='${table.replace(/'/g, "''")}' and column_name='${column.replace(/'/g, "''")}' limit 1`,
      );
      if (rowsOf(res).length === 0) {
        process.stdout.write(`db-assert: FAIL column ${o.column} does not exist\n`);
        return 1;
      }
      process.stdout.write(`db-assert: OK column ${o.column} exists\n`);
      return 0;
    }
    // --sql
    const res = await db.execute(o.sql);
    const rows = rowsOf(res);
    if (o.expectNonEmpty && rows.length === 0) {
      process.stdout.write(`db-assert: FAIL query returned no rows: ${o.sql}\n`);
      return 1;
    }
    process.stdout.write(`db-assert: OK query returned ${rows.length} row(s)\n`);
    return 0;
  } catch (err) {
    process.stdout.write(`db-assert: FAIL query error — ${err.message}\n`);
    return 1;
  } finally {
    // Best-effort close so the process can exit promptly.
    try { await db.$client?.end?.(); } catch { /* ignore */ }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stdout.write(`db-assert: FAIL unexpected — ${err?.stack || err}\n`);
    process.exit(1);
  });
