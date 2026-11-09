import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0205_narrow_shiva.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash() {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describeEmbeddedPostgres("issue comment on-behalf attribution migration", () => {
  it("reapplies the migration and round-trips the nullable user attribution FK", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-comment-on-behalf-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const historicalCompanyId = randomUUID();
    const historicalAgentId = randomUUID();
    const historicalIssueId = randomUUID();
    const historicalRunId = randomUUID();
    const historicalCommentId = randomUUID();
    const historicalUserId = `historical-comment-user-${randomUUID()}`;

    try {
      await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
      await sql`ALTER TABLE "issue_comments" DROP CONSTRAINT IF EXISTS "issue_comments_on_behalf_of_user_id_user_id_fk"`;
      await sql`ALTER TABLE "issue_comments" DROP COLUMN IF EXISTS "on_behalf_of_user_id"`;
      await sql`
        INSERT INTO "companies" ("id", "name", "issue_prefix")
        VALUES (${historicalCompanyId}, 'Historical attribution company', 'HAC')
      `;
      await sql`
        INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "adapter_config")
        VALUES (${historicalAgentId}, ${historicalCompanyId}, 'Historical comment agent', 'engineer', 'process', '{}'::jsonb)
      `;
      await sql`
        INSERT INTO "issues" ("id", "company_id", "title", "identifier")
        VALUES (${historicalIssueId}, ${historicalCompanyId}, 'Historical comment issue', 'HAC-1')
      `;
      await sql`
        INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
        VALUES (${historicalUserId}, 'Historical Comment User', 'historical-comment-user@example.test', true, now(), now())
      `;
      await sql`
        INSERT INTO "heartbeat_runs" ("id", "company_id", "agent_id", "status", "responsible_user_id")
        VALUES (${historicalRunId}, ${historicalCompanyId}, ${historicalAgentId}, 'succeeded', ${historicalUserId})
      `;
      await sql`
        INSERT INTO "issue_comments" (
          "id", "company_id", "issue_id", "author_agent_id", "created_by_run_id", "body"
        ) VALUES (
          ${historicalCommentId}, ${historicalCompanyId}, ${historicalIssueId}, ${historicalAgentId},
          ${historicalRunId}, 'Historical attributed comment'
        )
      `;
    } finally {
      await sql.end();
    }

    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });
    await applyPendingMigrations(database.connectionString);

    const verify = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const columns = await verify<{ column_name: string; data_type: string; is_nullable: string }[]>`
        SELECT "column_name", "data_type", "is_nullable"
        FROM "information_schema"."columns"
        WHERE "table_schema" = 'public'
          AND "table_name" = 'issue_comments'
          AND "column_name" = 'on_behalf_of_user_id'
      `;
      expect(columns).toEqual([{
        column_name: "on_behalf_of_user_id",
        data_type: "text",
        is_nullable: "YES",
      }]);

      const constraints = await verify<{ constraint_name: string; delete_rule: string }[]>`
        SELECT tc."constraint_name", rc."delete_rule"
        FROM "information_schema"."table_constraints" tc
        JOIN "information_schema"."referential_constraints" rc
          ON rc."constraint_schema" = tc."constraint_schema"
         AND rc."constraint_name" = tc."constraint_name"
        WHERE tc."table_schema" = 'public'
          AND tc."table_name" = 'issue_comments'
          AND tc."constraint_name" = 'issue_comments_on_behalf_of_user_id_user_id_fk'
      `;
      expect(constraints).toEqual([{
        constraint_name: "issue_comments_on_behalf_of_user_id_user_id_fk",
        delete_rule: "SET NULL",
      }]);

      const historical = await verify<{ on_behalf_of_user_id: string | null }[]>`
        SELECT "on_behalf_of_user_id"
        FROM "issue_comments"
        WHERE "id" = ${historicalCommentId}
      `;
      expect(historical).toEqual([{ on_behalf_of_user_id: historicalUserId }]);

      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const commentId = randomUUID();
      const userId = `comment-user-${randomUUID()}`;
      await verify`
        INSERT INTO "companies" ("id", "name", "issue_prefix")
        VALUES (${companyId}, 'Comment attribution company', 'CAC')
      `;
      await verify`
        INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "adapter_config")
        VALUES (${agentId}, ${companyId}, 'Comment agent', 'engineer', 'process', '{}'::jsonb)
      `;
      await verify`
        INSERT INTO "issues" ("id", "company_id", "title", "identifier")
        VALUES (${issueId}, ${companyId}, 'Comment issue', 'CAC-1')
      `;
      await verify`
        INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
        VALUES (${userId}, 'Comment User', 'comment-user@example.test', true, now(), now())
      `;
      await verify`
        INSERT INTO "issue_comments" (
          "id", "company_id", "issue_id", "author_agent_id", "on_behalf_of_user_id", "body"
        ) VALUES (${commentId}, ${companyId}, ${issueId}, ${agentId}, ${userId}, 'Attributed comment')
      `;
      const inserted = await verify<{ on_behalf_of_user_id: string | null }[]>`
        SELECT "on_behalf_of_user_id" FROM "issue_comments" WHERE "id" = ${commentId}
      `;
      expect(inserted).toEqual([{ on_behalf_of_user_id: userId }]);

      await verify`DELETE FROM "user" WHERE "id" = ${userId}`;
      const afterDelete = await verify<{ on_behalf_of_user_id: string | null }[]>`
        SELECT "on_behalf_of_user_id" FROM "issue_comments" WHERE "id" = ${commentId}
      `;
      expect(afterDelete).toEqual([{ on_behalf_of_user_id: null }]);
    } finally {
      await verify.end();
    }
  }, 30_000);
});
