import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

// Exact SQL from PR #14325 before master assigned 0285/0286 to API response storage.
// Exercise real preview tables/receipts, not a second application of the new schema.
const previewMigrations = [
  { when: 1790474441205, sql: `CREATE TABLE "agent_instruction_heads" (
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"entry_file" text NOT NULL,
	"revision_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_instruction_heads_identity_uq" UNIQUE("company_id","agent_id","entry_file")
);
--> statement-breakpoint
CREATE TABLE "agent_instruction_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"entry_file" text NOT NULL,
	"content_base64" text NOT NULL,
	"content_hash" text NOT NULL,
	"byte_length" integer NOT NULL,
	"parent_revision_id" uuid,
	"base_revision_id" uuid,
	"restored_from_revision_id" uuid,
	"actor_agent_id" uuid,
	"actor_user_id" text,
	"responsible_user_id" text,
	"source_run_id" uuid,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_instruction_revisions_identity_uq" UNIQUE("company_id","agent_id","entry_file","id")
);
--> statement-breakpoint
ALTER TABLE "agent_instruction_heads" ADD CONSTRAINT "agent_instruction_heads_company_id_agent_id_entry_file_revision_id_agent_instruction_revisions_company_id_agent_id_entry_file_id_fk" FOREIGN KEY ("company_id","agent_id","entry_file","revision_id") REFERENCES "public"."agent_instruction_revisions"("company_id","agent_id","entry_file","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_instruction_revisions" ADD CONSTRAINT "agent_instruction_revisions_company_id_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_instruction_revisions_history_idx" ON "agent_instruction_revisions" USING btree ("company_id","agent_id","entry_file","created_at","id");` },
  { when: 1790543348340, sql: `CREATE TABLE "agent_instruction_working_copies" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"responsible_user_id" text NOT NULL,
	"entry_file" text NOT NULL,
	"base_revision_id" uuid,
	"base_hash" text NOT NULL,
	"local_root" text NOT NULL,
	"execution_root" text NOT NULL,
	"location" text NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"candidate_base64" text,
	"candidate_hash" text,
	"error_code" text,
	"error_message" text,
	"receipt" jsonb,
	"process_stopped_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_instruction_working_copies" ADD CONSTRAINT "agent_instruction_working_copies_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_instruction_working_copies" ADD CONSTRAINT "agent_instruction_working_copies_company_id_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_instruction_copies_pending_idx" ON "agent_instruction_working_copies" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "agent_instruction_copies_agent_idx" ON "agent_instruction_working_copies" USING btree ("company_id","agent_id","created_at");` },
];
const migration = await readFile(new URL("./migrations/0287_serious_tinkerer.sql", import.meta.url), "utf8");
const migrationHash = createHash("sha256").update(migration).digest("hex");

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("instruction revision migrations", () => {
  it("keeps applied migration receipts, revisions, and pending copies intact on repeated upgrades", async () => {
    const database = await startEmbeddedPostgresTestDatabase("instruction-migration-upgrade-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      await sql`DROP TABLE agent_instruction_heads, agent_instruction_working_copies, agent_instruction_revisions`;
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
      for (const preview of previewMigrations) {
        for (const statement of preview.sql.split("--> statement-breakpoint")) await sql.unsafe(statement);
        await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES (${createHash("sha256").update(preview.sql).digest("hex")}, ${preview.when})`;
      }
      const companyId = randomUUID(), otherCompanyId = randomUUID(), agentId = randomUUID();
      const runId = randomUUID(), revisionId = randomUUID();
      const bytes = Buffer.from("\uFEFF# Saved\r\nExact bytes ☃\n");
      const contentBase64 = bytes.toString("base64");
      const contentHash = createHash("sha256").update(bytes).digest("hex");
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES
        (${companyId}, 'Instructions', 'INS'), (${otherCompanyId}, 'Other', 'OTH')`;
      await sql`INSERT INTO agents (id, company_id, name) VALUES (${agentId}, ${companyId}, 'Writer')`;
      await sql`INSERT INTO heartbeat_runs (id, company_id, agent_id) VALUES (${runId}, ${companyId}, ${agentId})`;
      await sql`INSERT INTO agent_instruction_revisions
        (id, company_id, agent_id, entry_file, content_base64, content_hash, byte_length, source, source_run_id)
        VALUES (${revisionId}, ${companyId}, ${agentId}, 'AGENTS.md', ${contentBase64}, ${contentHash}, ${bytes.length}, 'cleanup', ${runId})`;
      await sql`INSERT INTO agent_instruction_heads (company_id, agent_id, entry_file, revision_id)
        VALUES (${companyId}, ${agentId}, 'AGENTS.md', ${revisionId})`;
      await sql`INSERT INTO agent_instruction_working_copies
        (run_id, company_id, agent_id, responsible_user_id, entry_file, base_revision_id, base_hash, local_root, execution_root, location, state, candidate_base64, candidate_hash)
        VALUES (${runId}, ${companyId}, ${agentId}, 'editor', 'AGENTS.md', ${revisionId}, ${contentHash}, '/private/copy', '/private/copy', 'local', 'pending_commit', ${contentBase64}, ${contentHash})`;
      const snapshot = async () => ({
        journal: await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`,
        relations: await sql`SELECT oid::text, relname FROM pg_class WHERE relname IN
          ('agent_instruction_revisions', 'agent_instruction_heads', 'agent_instruction_working_copies') ORDER BY relname`,
        constraints: await sql`SELECT oid::text, conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conrelid IN ('agent_instruction_revisions'::regclass, 'agent_instruction_heads'::regclass,
            'agent_instruction_working_copies'::regclass) ORDER BY conname`,
        revisions: await sql`SELECT * FROM agent_instruction_revisions`,
        heads: await sql`SELECT * FROM agent_instruction_heads`,
        copies: await sql`SELECT * FROM agent_instruction_working_copies`,
      });
      const before = await snapshot();
      expect(before.relations).toHaveLength(3);
      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "needsMigrations", pendingMigrations: ["0287_serious_tinkerer.sql"],
      });
      await applyPendingMigrations(database.connectionString);
      const upgraded = await snapshot();
      expect(upgraded).toEqual({ ...before, journal: expect.arrayContaining(before.journal) });
      expect(upgraded.journal).toHaveLength(before.journal.length + 1);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(await inspectMigrations(database.connectionString)).toMatchObject({ status: "upToDate" });
        await applyPendingMigrations(database.connectionString);
        expect(await snapshot()).toEqual(upgraded);
      }
      await expect(sql`UPDATE agent_instruction_heads SET company_id = ${otherCompanyId} WHERE revision_id = ${revisionId}`)
        .rejects.toMatchObject({ code: "23503" });
      await expect(sql`UPDATE agent_instruction_working_copies SET company_id = ${otherCompanyId} WHERE run_id = ${runId}`)
        .rejects.toMatchObject({ code: "23503" });
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
