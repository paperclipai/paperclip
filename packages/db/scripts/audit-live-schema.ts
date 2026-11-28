// One-time (and repeatable) audit of a live PostgreSQL database against the
// drizzle schema the deployed code selects against. This is the standalone
// companion to the boot-time schema-drift gate (`verifyLiveSchema`, wired into
// server startup): it lets an operator point the same conservative diff at the
// control-plane database on demand without starting the server.
//
// Closes the AGE-759 blind spot "journal says applied, but the DDL isn't
// physically there": the drizzle migration journal (`__drizzle_migrations`)
// only records which migration files ran, never whether the resulting columns
// and tables actually exist. This script reports code-expected schema that is
// missing in the live database and ignores extra/unknown objects (additive
// drift is safe).
//
// It first classifies the database with `inspectMigrations` so a database that
// is merely *behind on migrations* (the ordinary "pending migrations" case the
// deploy gate auto-applies on boot) is not mistaken for the AGE-759 blind spot.
// The blind spot is specifically: the journal reports `upToDate` **and yet**
// code-expected tables/columns are physically missing.
//
//   DATABASE_URL=postgres://... tsx scripts/audit-live-schema.ts
//   tsx scripts/audit-live-schema.ts postgres://...
//   DATABASE_URL=postgres://... tsx scripts/audit-live-schema.ts --json
//
// Exit codes:
//   0  clean — journal is up to date AND every code-expected object is present
//   1  schema drift (the AGE-759 blind spot) — journal up to date but DDL missing
//   2  usage / connection error
//   3  pending migrations — database is simply behind; apply migrations, then
//      re-run to audit for drift (this is NOT the blind spot)
import { formatSchemaDrift, inspectMigrations, verifyLiveSchema } from "../src/client.js";

function parseArgs(argv: string[]): { url: string | undefined; json: boolean; help: boolean } {
  let url: string | undefined;
  let json = false;
  let help = false;
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (!arg.startsWith("-")) url = arg;
  }
  return { url: url ?? process.env.DATABASE_URL, json, help };
}

const USAGE =
  "Usage: DATABASE_URL=postgres://... tsx scripts/audit-live-schema.ts [--json]\n" +
  "   or: tsx scripts/audit-live-schema.ts postgres://... [--json]";

async function main(): Promise<number> {
  const { url, json, help } = parseArgs(process.argv.slice(2));
  if (help || !url) {
    console.error(USAGE);
    return help ? 0 : 2;
  }

  let migrationState;
  let schema;
  try {
    // Classify migration lineage first so "behind on migrations" is not
    // reported as drift, then diff the physical schema regardless.
    migrationState = await inspectMigrations(url);
    schema = await verifyLiveSchema(url);
  } catch (err) {
    console.error(`Schema audit failed to query the database: ${(err as Error).message}`);
    return 2;
  }

  const pendingCount =
    migrationState.status === "upToDate" ? 0 : migrationState.pendingMigrations.length;
  const journalUpToDate = migrationState.status === "upToDate";

  if (json) {
    console.log(
      JSON.stringify(
        {
          journal: { status: migrationState.status, pendingMigrations: pendingCount },
          schema,
          blindSpotDrift: journalUpToDate && schema.status === "drift",
        },
        null,
        2,
      ),
    );
  }

  // Case 1: journal up to date AND schema present → clean.
  if (journalUpToDate && schema.status === "ok") {
    if (!json) {
      console.log(
        `OK: journal is up to date and the live schema matches the drizzle schema ` +
          `(${schema.checkedTables} tables checked). No drift.`,
      );
    }
    return 0;
  }

  // Case 2: journal up to date BUT code-expected DDL is missing → the AGE-759
  // blind spot. This is the condition the boot-time gate refuses to serve on.
  if (journalUpToDate && schema.status === "drift") {
    if (!json) {
      console.error(
        `SCHEMA DRIFT (AGE-759 blind spot): the migration journal reports "upToDate", ` +
          `but the live database is missing code-expected objects ` +
          `(${schema.checkedTables} tables checked).\n  ${formatSchemaDrift(schema)}\n` +
          `Reconcile the migration history / re-apply the missing migrations.`,
      );
    }
    return 1;
  }

  // Case 3: journal is behind (pending migrations). This is the ordinary case
  // the deploy gate auto-applies on boot — not the blind spot. We still surface
  // the physical gap for context, but exit distinctly so it is not conflated
  // with real drift.
  if (!json) {
    const detail = schema.status === "drift" ? `\n  ${formatSchemaDrift(schema)}` : "";
    console.error(
      `PENDING MIGRATIONS: the database is ${pendingCount} migration(s) behind the committed ` +
        `files (journal status: ${migrationState.status}). This is the ordinary "not yet migrated" ` +
        `case the deploy gate applies on boot — NOT the AGE-759 blind spot.\n` +
        `Apply the pending migrations, then re-run this audit to check for genuine drift.` +
        detail,
    );
  }
  return 3;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
