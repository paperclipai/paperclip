// check-pending-migrations.ts — deploy preflight that fails BEFORE a restart if a
// pending drizzle migration would collide with the live schema.
//
// Motivation (2026-08-10 incident): the server runs pending migrations on every boot.
// A schema change applied out-of-band by hand (e.g. `ALTER TABLE ... ADD COLUMN x`)
// makes the next restart re-run a pending migration whose `ADD COLUMN x` / `CREATE
// TABLE t` now conflicts (Postgres 42701 / 42P07) -> boot fails -> crash-loop. This
// catches that class up front: for each not-yet-applied migration it scans the
// conflict-prone, NON-idempotent DDL and checks whether the object already exists.
//
//   tsx scripts/check-pending-migrations.ts            # check live DB, exit 1 on conflict
//   tsx scripts/check-pending-migrations.ts --self-test # parser assertions, no DB
//   DATABASE_URL=postgres://... tsx scripts/check-pending-migrations.ts
//
// Read-only: information_schema / pg_catalog / drizzle bookkeeping SELECTs only.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "db", "src", "migrations");

export type DdlObject =
  | { kind: "table"; name: string; idempotent: boolean }
  | { kind: "column"; table: string; name: string; idempotent: boolean }
  | { kind: "index"; name: string; idempotent: boolean };

// Pure: extract the conflict-prone DDL (CREATE TABLE / ADD COLUMN / CREATE INDEX) a
// migration would run, tagging each with whether it is guarded by IF NOT EXISTS.
export function extractDdl(sql: string): DdlObject[] {
  const out: DdlObject[] = [];
  const tableRe = /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi;
  const columnRe = /ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+COLUMN\s+(IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi;
  const indexRe = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi;
  for (let m; (m = tableRe.exec(sql)); ) out.push({ kind: "table", name: m[2], idempotent: Boolean(m[1]) });
  for (let m; (m = columnRe.exec(sql)); ) out.push({ kind: "column", table: m[1], name: m[3], idempotent: Boolean(m[2]) });
  for (let m; (m = indexRe.exec(sql)); ) out.push({ kind: "index", name: m[2], idempotent: Boolean(m[1]) });
  return out;
}

function describeDdl(tag: string, ddl: DdlObject): string {
  if (ddl.kind === "table") return `${tag}: CREATE TABLE "${ddl.name}" — table already exists`;
  if (ddl.kind === "column") return `${tag}: ADD COLUMN "${ddl.table}"."${ddl.name}" — column already exists`;
  return `${tag}: CREATE INDEX "${ddl.name}" — index already exists`;
}

// Pure over the schema: a non-idempotent create/add collides only when the object it
// would create already exists. Idempotent (IF NOT EXISTS) statements never collide.
export async function findConflicts(
  pending: Array<{ tag: string; sql: string }>,
  exists: (ddl: DdlObject) => Promise<boolean>,
): Promise<string[]> {
  const conflicts: string[] = [];
  for (const { tag, sql } of pending) {
    for (const ddl of extractDdl(sql)) {
      if (ddl.idempotent) continue;
      if (await exists(ddl)) conflicts.push(describeDdl(tag, ddl));
    }
  }
  return conflicts;
}

async function selfTest() {
  const assert = (cond: boolean, msg: string) => { if (!cond) { console.error("SELF-TEST FAIL:", msg); process.exit(1); } };
  const ddl = extractDdl(`
    CREATE TABLE "cloud_upstream_connections" ("id" uuid PRIMARY KEY);--> statement-breakpoint
    ALTER TABLE "heartbeat_runs" ADD COLUMN "actionability" text;--> statement-breakpoint
    ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "already" text;--> statement-breakpoint
    CREATE INDEX "company_memories_company_created_idx" ON "company_memories" USING btree ("company_id");
    CREATE TABLE IF NOT EXISTS "safe_table" ("id" uuid);
  `);
  assert(ddl.some((d) => d.kind === "table" && d.name === "cloud_upstream_connections" && !d.idempotent), "plain CREATE TABLE not detected");
  assert(ddl.some((d) => d.kind === "table" && d.name === "safe_table" && d.idempotent), "idempotent CREATE TABLE flag missing");
  assert(ddl.some((d) => d.kind === "column" && d.table === "heartbeat_runs" && d.name === "actionability" && !d.idempotent), "plain ADD COLUMN not detected");
  assert(ddl.some((d) => d.kind === "column" && d.name === "already" && d.idempotent), "idempotent ADD COLUMN flag missing");
  assert(ddl.some((d) => d.kind === "index" && d.name === "company_memories_company_created_idx" && !d.idempotent), "CREATE INDEX not detected");
  assert(extractDdl("SELECT 1;").length === 0, "non-DDL should yield nothing");

  // End-to-end conflict logic with a mocked schema: only heartbeat_runs.actionability
  // "exists" — mirrors the 2026-08-10 incident. The plain ADD COLUMN must be flagged;
  // the IF NOT EXISTS variant and the not-yet-existing table must not.
  const mockExists = async (d: DdlObject) => d.kind === "column" && d.table === "heartbeat_runs" && d.name === "actionability";
  const conflicts = await findConflicts([
    { tag: "0212_lean_dreadnoughts", sql: `CREATE TABLE "cloud_upstream_connections" ("id" uuid);--> statement-breakpoint\nALTER TABLE "heartbeat_runs" ADD COLUMN "actionability" text;` },
    { tag: "0212_idempotent", sql: `ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "actionability" text;` },
  ], mockExists);
  assert(conflicts.length === 1, `expected exactly 1 conflict, got ${conflicts.length}: ${conflicts.join(" | ")}`);
  assert(conflicts[0].includes("actionability"), "conflict should name the actionability column");
  console.log("SELF-TEST OK — extractDdl + findConflicts (incident replay) pass");
}

type Row = Record<string, unknown>;

async function main() {
  if (process.argv.includes("--self-test")) { await selfTest(); return; }

  const { createDb } = await import("../packages/db/src/index.js");
  const { loadConfig } = await import("../server/src/config.js");
  const config = loadConfig() as { databaseUrl?: string; embeddedPostgresPort?: number };
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort ?? 54329}/paperclip`;
  const db = createDb(dbUrl) as unknown as { $client?: { unsafe: (t: string, p?: unknown[]) => Promise<Row[]>; end?: () => Promise<void> } };
  const client = db.$client;
  if (typeof client?.unsafe !== "function") throw new Error("could not access postgres-js client (.$client.unsafe)");
  const q = async (text: string, params: unknown[] = []): Promise<Row[]> => [...(await client.unsafe(text, params))];

  // Ordered migration tags from the journal.
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  const tags = journal.entries.map((e) => e.tag);

  // Pending = migrations whose sha256 (drizzle's own hash) is not yet recorded in
  // __drizzle_migrations. Hash membership is exact — robust to any count drift between
  // the journal and the bookkeeping table.
  const tagSql = new Map<string, string>();
  for (const tag of tags) {
    try { tagSql.set(tag, readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")); } catch { /* journal tag with no file */ }
  }
  const appliedHashes = new Set<string>();
  for (const rel of ['drizzle."__drizzle_migrations"', '"__drizzle_migrations"']) {
    try { for (const r of await q(`select hash from ${rel}`)) appliedHashes.add(String(r.hash)); break; } catch { /* try next / fresh db */ }
  }
  const pending = tags.filter((tag) => {
    const sql = tagSql.get(tag);
    return sql !== undefined && !appliedHashes.has(createHash("sha256").update(sql).digest("hex"));
  });

  const objectExists = async (ddl: DdlObject): Promise<boolean> => {
    if (ddl.kind === "table") return Boolean((await q(`select to_regclass($1) is not null as e`, [`public."${ddl.name}"`]))[0]?.e);
    if (ddl.kind === "column") return (await q(`select 1 from information_schema.columns where table_name=$1 and column_name=$2 limit 1`, [ddl.table, ddl.name])).length > 0;
    return (await q(`select 1 from pg_class where relkind='i' and relname=$1 limit 1`, [ddl.name])).length > 0;
  };
  const conflicts = await findConflicts(pending.map((tag) => ({ tag, sql: tagSql.get(tag)! })), objectExists);

  await client.end?.();

  console.log(`Migrations: ${tags.length} in journal, ${appliedHashes.size} applied, ${pending.length} pending${pending.length ? ` (${pending.join(", ")})` : ""}.`);
  if (conflicts.length) {
    console.error(`\nDEPLOY BLOCKED — ${conflicts.length} pending migration(s) would collide with the live schema:`);
    for (const c of conflicts) console.error(`  • ${c}`);
    console.error(`\nFix: make the conflicting statement idempotent (ADD COLUMN/CREATE TABLE IF NOT EXISTS) or reconcile the migration history, then retry the restart.`);
    process.exit(1);
  }
  console.log("No schema collisions — safe to restart.");
}

main().catch((err) => { console.error(err); process.exit(1); });
