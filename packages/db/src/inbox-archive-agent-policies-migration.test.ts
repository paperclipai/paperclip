import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const INBOX_ARCHIVE_AGENT_POLICIES_MIGRATION = "0172_inbox_archive_agent_policies.sql";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-inbox-archive-policies-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function migrationHash(): Promise<string> {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${INBOX_ARCHIVE_AGENT_POLICIES_MIGRATION}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres inbox archive policy migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("inbox archive agent policy migration", () => {
  it(
    "upgrades legacy archives and round-trips attribution and unique policies",
    async () => {
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      const companyId = randomUUID();
      const agentId = randomUUID();
      const deletedAgentId = randomUUID();
      const issueId = randomUUID();
      const runId = randomUUID();
      const legacyArchiveId = randomUUID();
      const agentArchiveId = randomUUID();

      try {
        const hash = await migrationHash();
        await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${hash}`;
        await sql`DROP TABLE IF EXISTS "user_inbox_agent_policies"`;
        await sql`ALTER TABLE "issue_inbox_archives" DROP CONSTRAINT IF EXISTS "issue_inbox_archives_archived_by_agent_id_agents_id_fk"`;
        await sql`ALTER TABLE "issue_inbox_archives" DROP CONSTRAINT IF EXISTS "issue_inbox_archives_archived_by_run_id_heartbeat_runs_id_fk"`;
        await sql`ALTER TABLE "issue_inbox_archives" DROP CONSTRAINT IF EXISTS "issue_inbox_archives_archived_by_actor_type_check"`;
        await sql`ALTER TABLE "issue_inbox_archives" DROP COLUMN IF EXISTS "archived_by_agent_id"`;
        await sql`ALTER TABLE "issue_inbox_archives" DROP COLUMN IF EXISTS "archived_by_run_id"`;
        await sql`ALTER TABLE "issue_inbox_archives" DROP COLUMN IF EXISTS "archived_by_actor_type"`;

        await sql`
          INSERT INTO "companies" ("id", "name", "issue_prefix")
          VALUES (${companyId}, 'Inbox migration company', 'IAM')
        `;
        await sql`
          INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "adapter_config")
          VALUES (${agentId}, ${companyId}, 'Inbox agent', 'engineer', 'process', '{}'::jsonb)
        `;
        await sql`
          INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "adapter_config")
          VALUES (${deletedAgentId}, ${companyId}, 'Deleted inbox agent', 'engineer', 'process', '{}'::jsonb)
        `;
        await sql`
          INSERT INTO "issues" ("id", "company_id", "title", "identifier")
          VALUES (${issueId}, ${companyId}, 'Legacy inbox issue', 'IAM-1')
        `;
        await sql`
          INSERT INTO "heartbeat_runs" ("id", "company_id", "agent_id", "status")
          VALUES (${runId}, ${companyId}, ${agentId}, 'succeeded')
        `;
        await sql`
          INSERT INTO "issue_inbox_archives" ("id", "company_id", "issue_id", "user_id")
          VALUES (${legacyArchiveId}, ${companyId}, ${issueId}, 'legacy-user')
        `;
      } finally {
        await sql.end();
      }

      expect(await inspectMigrations(connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [INBOX_ARCHIVE_AGENT_POLICIES_MIGRATION],
      });

      await applyPendingMigrations(connectionString);

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const legacyRows = await verifySql<{
          archived_by_actor_type: string;
          archived_by_agent_id: string | null;
          archived_by_run_id: string | null;
        }[]>`
          SELECT "archived_by_actor_type", "archived_by_agent_id", "archived_by_run_id"
          FROM "issue_inbox_archives"
          WHERE "id" = ${legacyArchiveId}
        `;
        expect(legacyRows).toEqual([{
          archived_by_actor_type: "user",
          archived_by_agent_id: null,
          archived_by_run_id: null,
        }]);

        await verifySql`
          INSERT INTO "issue_inbox_archives" (
            "id",
            "company_id",
            "issue_id",
            "user_id",
            "archived_by_actor_type",
            "archived_by_agent_id",
            "archived_by_run_id"
          )
          VALUES (${agentArchiveId}, ${companyId}, ${issueId}, 'agent-managed-user', 'agent', ${agentId}, ${runId})
        `;
        const agentRows = await verifySql<{
          archived_by_actor_type: string;
          archived_by_agent_id: string;
          archived_by_run_id: string;
        }[]>`
          SELECT "archived_by_actor_type", "archived_by_agent_id", "archived_by_run_id"
          FROM "issue_inbox_archives"
          WHERE "id" = ${agentArchiveId}
        `;
        expect(agentRows).toEqual([{
          archived_by_actor_type: "agent",
          archived_by_agent_id: agentId,
          archived_by_run_id: runId,
        }]);

        await verifySql`
          INSERT INTO "user_inbox_agent_policies" (
            "company_id",
            "user_id",
            "mode",
            "allowed_agent_ids"
          )
          VALUES (${companyId}, 'agent-managed-user', 'allowlist', ${verifySql.json([agentId, deletedAgentId])})
        `;
        const policies = await verifySql<{
          mode: string;
          allowed_agent_ids: string[];
        }[]>`
          SELECT "mode", "allowed_agent_ids"
          FROM "user_inbox_agent_policies"
          WHERE "company_id" = ${companyId}
            AND "user_id" = 'agent-managed-user'
        `;
        expect(policies).toEqual([{
          mode: "allowlist",
          allowed_agent_ids: [agentId, deletedAgentId],
        }]);

        await verifySql`DELETE FROM "agents" WHERE "id" = ${deletedAgentId}`;
        const policiesAfterAgentDeletion = await verifySql<{
          allowed_agent_ids: string[];
        }[]>`
          SELECT "allowed_agent_ids"
          FROM "user_inbox_agent_policies"
          WHERE "company_id" = ${companyId}
            AND "user_id" = 'agent-managed-user'
        `;
        expect(policiesAfterAgentDeletion).toEqual([{ allowed_agent_ids: [agentId] }]);

        await expect(verifySql`
          INSERT INTO "user_inbox_agent_policies" ("company_id", "user_id", "mode")
          VALUES (${companyId}, 'agent-managed-user', 'disabled')
        `).rejects.toMatchObject({ code: "23505" });
      } finally {
        await verifySql.end();
      }

      expect((await inspectMigrations(connectionString)).status).toBe("upToDate");
    },
    30_000,
  );
});
