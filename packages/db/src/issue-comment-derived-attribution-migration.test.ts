import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  applyPendingMigrations,
  inspectMigrations,
} from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const DERIVED_ATTRIBUTION_MIGRATION = "0132_issue_comment_derived_attribution_fast.sql";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-derived-attribution-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function migrationHash(migrationFile: string): Promise<string> {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${migrationFile}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

async function makeDerivedAttributionMigrationPending(
  sql: ReturnType<typeof postgres>,
): Promise<void> {
  const hash = await migrationHash(DERIVED_ATTRIBUTION_MIGRATION);
  await sql`
    DELETE FROM "drizzle"."__drizzle_migrations"
    WHERE "hash" = ${hash}
  `;
}

async function dropDerivedAttributionSchema(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`ALTER TABLE "issue_comments" DROP CONSTRAINT IF EXISTS "issue_comments_derived_author_agent_id_agents_id_fk"`;
  await sql`ALTER TABLE "issue_comments" DROP CONSTRAINT IF EXISTS "issue_comments_derived_created_by_run_id_heartbeat_runs_id_fk"`;
  await sql`ALTER TABLE "issue_comments" DROP COLUMN IF EXISTS "derived_author_agent_id"`;
  await sql`ALTER TABLE "issue_comments" DROP COLUMN IF EXISTS "derived_created_by_run_id"`;
  await sql`ALTER TABLE "issue_comments" DROP COLUMN IF EXISTS "derived_author_source"`;
}

async function createSeedGraph(sql: ReturnType<typeof postgres>, label: string) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const runId = randomUUID();

  await sql`
    INSERT INTO "companies" ("id", "name", "issue_prefix")
    VALUES (${companyId}, ${`Company ${label}`}, ${`T${label}`})
  `;
  await sql`
    INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "adapter_config")
    VALUES (${agentId}, ${companyId}, ${`Agent ${label}`}, 'engineer', 'process', '{}'::jsonb)
  `;
  await sql`
    INSERT INTO "issues" ("id", "company_id", "title", "identifier")
    VALUES (${issueId}, ${companyId}, ${`Issue ${label}`}, ${`T${label}-1`})
  `;
  await sql`
    INSERT INTO "heartbeat_runs" ("id", "company_id", "agent_id", "status")
    VALUES (${runId}, ${companyId}, ${agentId}, 'succeeded')
  `;

  return { companyId, agentId, issueId, runId };
}

async function expectDerivedAttributionSchema(sql: ReturnType<typeof postgres>): Promise<void> {
  const columns = await sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
    SELECT "column_name", "data_type", "is_nullable"
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public'
      AND "table_name" = 'issue_comments'
      AND "column_name" IN (
        'derived_author_agent_id',
        'derived_created_by_run_id',
        'derived_author_source'
      )
    ORDER BY "column_name"
  `;
  expect(columns).toEqual([
    { column_name: "derived_author_agent_id", data_type: "uuid", is_nullable: "YES" },
    { column_name: "derived_author_source", data_type: "text", is_nullable: "YES" },
    { column_name: "derived_created_by_run_id", data_type: "uuid", is_nullable: "YES" },
  ]);

  const constraints = await sql<{ conname: string; delete_rule: string }[]>`
    SELECT tc."constraint_name" AS "conname", rc."delete_rule"
    FROM "information_schema"."table_constraints" tc
    JOIN "information_schema"."referential_constraints" rc
      ON rc."constraint_schema" = tc."constraint_schema"
     AND rc."constraint_name" = tc."constraint_name"
    WHERE tc."table_schema" = 'public'
      AND tc."table_name" = 'issue_comments'
      AND tc."constraint_name" IN (
        'issue_comments_derived_author_agent_id_agents_id_fk',
        'issue_comments_derived_created_by_run_id_heartbeat_runs_id_fk'
      )
    ORDER BY tc."constraint_name"
  `;
  expect(constraints).toEqual([
    {
      conname: "issue_comments_derived_author_agent_id_agents_id_fk",
      delete_rule: "SET NULL",
    },
    {
      conname: "issue_comments_derived_created_by_run_id_heartbeat_runs_id_fk",
      delete_rule: "SET NULL",
    },
  ]);
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres derived attribution migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue comment derived attribution migration", () => {
  it(
    "fresh installs include the relocated schema and no deleted 0126 migration",
    async () => {
      const connectionString = await createTempDatabase();
      const state = await inspectMigrations(connectionString);

      expect(state.status).toBe("upToDate");
      expect(state.availableMigrations).not.toContain("0126_issue_comment_derived_attribution.sql");
      expect(state.availableMigrations).toContain(DERIVED_ATTRIBUTION_MIGRATION);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await expectDerivedAttributionSchema(sql);
        const supportIndexes = await sql<{ indexname: string }[]>`
          SELECT "indexname"
          FROM "pg_indexes"
          WHERE "schemaname" = 'public'
            AND "indexname" = 'issue_comments_derived_attribution_backfill_idx'
        `;
        expect(supportIndexes).toEqual([]);
      } finally {
        await sql.end();
      }
    },
    20_000,
  );

  it(
    "is idempotent for a database that already has 0126 schema and data",
    async () => {
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      const alreadyBackfilledCommentId = randomUUID();
      const timingTierCommentId = randomUUID();
      const realUserCommentId = randomUUID();

      try {
        await makeDerivedAttributionMigrationPending(sql);
        const { companyId, agentId, issueId, runId } = await createSeedGraph(sql, "OLD126");
        await sql`
          INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
          VALUES ('real-user', 'Real User', 'real-user@example.test', true, now(), now())
          ON CONFLICT ("id") DO NOTHING
        `;
        await sql`
          INSERT INTO "issue_comments" (
            "id",
            "company_id",
            "issue_id",
            "author_user_id",
            "created_by_run_id",
            "derived_author_agent_id",
            "derived_created_by_run_id",
            "derived_author_source",
            "body"
          )
          VALUES
            (${alreadyBackfilledCommentId}, ${companyId}, ${issueId}, 'local-board', ${runId}, ${agentId}, ${runId}, 'run_id', 'already attributed'),
            (${timingTierCommentId}, ${companyId}, ${issueId}, 'local-board', NULL, ${agentId}, ${runId}, 'run_window_unique', 'timing tier'),
            (${realUserCommentId}, ${companyId}, ${issueId}, 'real-user', ${runId}, NULL, NULL, NULL, 'human comment')
        `;
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [DERIVED_ATTRIBUTION_MIGRATION],
        reason: "pending-migrations",
      });

      await applyPendingMigrations(connectionString);

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const rows = await verifySql<{
          id: string;
          derived_author_agent_id: string | null;
          derived_created_by_run_id: string | null;
          derived_author_source: string | null;
        }[]>`
          SELECT
            "id",
            "derived_author_agent_id",
            "derived_created_by_run_id",
            "derived_author_source"
          FROM "issue_comments"
          WHERE "id" IN (${alreadyBackfilledCommentId}, ${timingTierCommentId}, ${realUserCommentId})
          ORDER BY "body"
        `;

        expect(rows).toEqual([
          expect.objectContaining({
            id: alreadyBackfilledCommentId,
            derived_author_source: "run_id",
          }),
          {
            id: realUserCommentId,
            derived_author_agent_id: null,
            derived_created_by_run_id: null,
            derived_author_source: null,
          },
          {
            id: timingTierCommentId,
            derived_author_agent_id: null,
            derived_created_by_run_id: null,
            derived_author_source: null,
          },
        ]);
      } finally {
        await verifySql.end();
      }

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");
    },
    20_000,
  );

  it(
    "completes a partially backfilled pre-0131 database",
    async () => {
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      const eligibleCommentId = randomUUID();
      const deletedUserCommentId = randomUUID();
      const agentAuthoredCommentId = randomUUID();

      try {
        await dropDerivedAttributionSchema(sql);
        await makeDerivedAttributionMigrationPending(sql);
        const { companyId, agentId, issueId, runId } = await createSeedGraph(sql, "PARTIAL");
        await sql`
          INSERT INTO "issue_comments" (
            "id",
            "company_id",
            "issue_id",
            "author_user_id",
            "created_by_run_id",
            "body"
          )
          VALUES
            (${eligibleCommentId}, ${companyId}, ${issueId}, 'local-board', ${runId}, 'eligible local-board'),
            (${deletedUserCommentId}, ${companyId}, ${issueId}, 'deleted-user', ${runId}, 'eligible deleted user')
        `;
        await sql`
          INSERT INTO "issue_comments" (
            "id",
            "company_id",
            "issue_id",
            "author_agent_id",
            "author_user_id",
            "created_by_run_id",
            "body"
          )
          VALUES (${agentAuthoredCommentId}, ${companyId}, ${issueId}, ${agentId}, 'local-board', ${runId}, 'already agent-authored')
        `;
      } finally {
        await sql.end();
      }

      await applyPendingMigrations(connectionString);

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await expectDerivedAttributionSchema(verifySql);
        const rows = await verifySql<{
          id: string;
          derived_author_agent_id: string | null;
          derived_created_by_run_id: string | null;
          derived_author_source: string | null;
        }[]>`
          SELECT
            "id",
            "derived_author_agent_id",
            "derived_created_by_run_id",
            "derived_author_source"
          FROM "issue_comments"
          WHERE "id" IN (${eligibleCommentId}, ${deletedUserCommentId}, ${agentAuthoredCommentId})
          ORDER BY "body"
        `;

        expect(rows).toEqual([
          {
            id: agentAuthoredCommentId,
            derived_author_agent_id: null,
            derived_created_by_run_id: null,
            derived_author_source: null,
          },
          expect.objectContaining({
            id: deletedUserCommentId,
            derived_author_source: "run_id",
          }),
          expect.objectContaining({
            id: eligibleCommentId,
            derived_author_source: "run_id",
          }),
        ]);
      } finally {
        await verifySql.end();
      }

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");
    },
    20_000,
  );
});
