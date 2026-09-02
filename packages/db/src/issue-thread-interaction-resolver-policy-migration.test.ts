import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function resolverPolicyMigrationStatements(): Promise<string[]> {
  const migrationSql = await readFile(
    fileURLToPath(new URL("./migrations/0218_mushy_jack_murdock.sql", import.meta.url)),
    "utf8",
  );
  return migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

d("issue interaction resolver policy migration", () => {
  it("replays safely and completes a partial prior run", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("resolver-policy-migration-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => {
      await sql.end();
    });

    const companyId = randomUUID();
    const issueId = randomUUID();
    const legacyInteractionId = randomUUID();
    const partialInteractionId = randomUUID();

    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Resolver migration test', 'RMT')
    `;
    await sql`
      INSERT INTO "issues" ("id", "company_id", "title", "identifier")
      VALUES (${issueId}, ${companyId}, 'Test migration replay', 'RMT-1')
    `;
    await sql.unsafe(
      'ALTER TABLE "issue_thread_interactions" ALTER COLUMN "resolver_policy_provenance" DROP NOT NULL',
    );
    await sql.unsafe(
      'ALTER TABLE "issue_thread_interactions" ALTER COLUMN "effective_resolver_policy_source" DROP NOT NULL',
    );
    await sql`
      INSERT INTO "issue_thread_interactions" (
        "id",
        "company_id",
        "issue_id",
        "kind",
        "requested_resolver_policy",
        "effective_resolver_policy",
        "resolver_policy_provenance",
        "effective_resolver_policy_source",
        "payload"
      )
      VALUES
        (
          ${legacyInteractionId},
          ${companyId},
          ${issueId},
          'request_confirmation',
          'board_or_agents',
          'board_only',
          NULL,
          NULL,
          '{}'::jsonb
        ),
        (
          ${partialInteractionId},
          ${companyId},
          ${issueId},
          'request_confirmation',
          'human_only',
          'human_only',
          'explicit',
          NULL,
          '{}'::jsonb
        )
    `;

    const statements = await resolverPolicyMigrationStatements();
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) await sql.unsafe(statement);

    const rowsAfterFirstRun = await sql<{
      id: string;
      requested_resolver_policy: string;
      effective_resolver_policy: string;
      resolver_policy_provenance: string;
      effective_resolver_policy_source: string;
    }[]>`
      SELECT
        "id",
        "requested_resolver_policy",
        "effective_resolver_policy",
        "resolver_policy_provenance",
        "effective_resolver_policy_source"
      FROM "issue_thread_interactions"
      WHERE "id" IN (${legacyInteractionId}, ${partialInteractionId})
      ORDER BY "id"
    `;
    expect(rowsAfterFirstRun).toEqual(
      [
        {
          id: legacyInteractionId,
          requested_resolver_policy: "not_creator",
          effective_resolver_policy: "human_only",
          resolver_policy_provenance: "legacy_inherited_restriction",
          effective_resolver_policy_source: "company_cap",
        },
        {
          id: partialInteractionId,
          requested_resolver_policy: "human_only",
          effective_resolver_policy: "human_only",
          resolver_policy_provenance: "explicit",
          effective_resolver_policy_source: "requested",
        },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );

    for (const statement of statements) await sql.unsafe(statement);
    const rowsAfterReplay = await sql`
      SELECT
        "id",
        "requested_resolver_policy",
        "effective_resolver_policy",
        "resolver_policy_provenance",
        "effective_resolver_policy_source"
      FROM "issue_thread_interactions"
      WHERE "id" IN (${legacyInteractionId}, ${partialInteractionId})
      ORDER BY "id"
    `;
    expect(rowsAfterReplay).toEqual(rowsAfterFirstRun);

    const columns = await sql<
      { column_name: string; is_nullable: string; column_default: string }[]
    >`
      SELECT "column_name", "is_nullable", "column_default"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'issue_thread_interactions'
        AND "column_name" IN ('resolver_policy_provenance', 'effective_resolver_policy_source')
      ORDER BY "column_name"
    `;
    expect(columns).toEqual([
      {
        column_name: "effective_resolver_policy_source",
        is_nullable: "NO",
        column_default: "'requested'::text",
      },
      {
        column_name: "resolver_policy_provenance",
        is_nullable: "NO",
        column_default: "'inherited'::text",
      },
    ]);
  }, 240_000);
});
