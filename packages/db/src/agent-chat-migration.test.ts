import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migrationFile = "0274_agent_chat.sql";
const migrationSql = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
const migrationHash = createHash("sha256").update(migrationSql).digest("hex");
const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function seed(sql: postgres.Sql) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const commentId = randomUUID();
  const userId = `chat-user-${randomUUID()}`;
  await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Chat migration', 'CHM')`;
  await sql`INSERT INTO agents (id, company_id, name, role, adapter_type) VALUES (${agentId}, ${companyId}, 'Chat agent', 'engineer', 'process')`;
  await sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES (${userId}, 'Chat user', ${`${userId}@example.test`}, true, now(), now())`;
  await sql`INSERT INTO issues (id, company_id, title, assignee_agent_id, status,
    conversation_agent_id, conversation_user_id, conversation_state, conversation_session_generation, conversation_boundary_comment_id)
    VALUES (${issueId}, ${companyId}, 'Preserved chat', ${agentId}, 'in_review',
      ${agentId}, ${userId}, 'waiting', 7, ${commentId})`;
  await sql`INSERT INTO issue_comments (id, company_id, issue_id, author_user_id, body, client_request_id, conversation_session_generation)
    VALUES (${commentId}, ${companyId}, ${issueId}, ${userId}, 'Preserved conversation history', 'first-message', 7)`;
  return { companyId, agentId, issueId, commentId, userId };
}

async function assertConstraints(sql: postgres.Sql, row: Awaited<ReturnType<typeof seed>>) {
  for (const update of [
    { conversation_state: null },
    { status: "done" },
    { status: "cancelled" },
    { assignee_agent_id: null },
    { conversation_user_id: null },
  ]) {
    await expect(sql`UPDATE issues SET ${sql(update)} WHERE id = ${row.issueId}`)
      .rejects.toMatchObject({ code: "23514", constraint_name: "issues_conversation_identity_check" });
  }
  await expect(sql`INSERT INTO issues (company_id, title, assignee_agent_id, status, conversation_agent_id, conversation_user_id, conversation_state)
    VALUES (${row.companyId}, 'Duplicate conversation', ${row.agentId}, 'in_review', ${row.agentId}, ${row.userId}, 'waiting')`)
    .rejects.toMatchObject({ code: "23505", constraint_name: "issues_conversation_identity_idx" });
  await expect(sql`INSERT INTO issue_comments (company_id, issue_id, author_user_id, body, client_request_id)
    VALUES (${row.companyId}, ${row.issueId}, ${row.userId}, 'Duplicate message', 'first-message')`)
    .rejects.toMatchObject({ code: "23505", constraint_name: "issue_comments_client_request_uq" });
  await sql`INSERT INTO issues (company_id, title, assignee_agent_id, status, conversation_agent_id, conversation_user_id, conversation_state)
    VALUES (${row.companyId}, 'Other person conversation', ${row.agentId}, 'in_review', ${row.agentId}, 'other-person', 'waiting')`;
  await sql`INSERT INTO issues (company_id, title, status) VALUES (${row.companyId}, 'Ordinary completed task', 'done')`;
}

describePostgres("persistent agent chat migration", () => {
  it("applies to a fresh database and enforces conversation identity and message retry uniqueness", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-chat-migration-fresh-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      await assertConstraints(sql, await seed(sql));
    } finally {
      await sql.end();
    }
  }, 30_000);

  it("replays over pre-release columns and constraints without losing history or weakening the state guard", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-chat-migration-replay-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const row = await seed(sql);
      const beforeIssue = await sql`SELECT * FROM issues WHERE id = ${row.issueId}`;
      const beforeComment = await sql`SELECT * FROM issue_comments WHERE id = ${row.commentId}`;
      // The original pre-release guard omitted the explicit state null check.
      // Keep every column, index and FK to model an already-upgraded development DB.
      await sql`ALTER TABLE issues DROP CONSTRAINT issues_conversation_identity_check`;
      const legacyGuard = migrationSql.slice(migrationSql.lastIndexOf('ALTER TABLE "issues" ADD CONSTRAINT'))
        .replace(' and "issues"."conversation_state" is not null', "");
      await sql.unsafe(legacyGuard);
      const legacyNullIds = [randomUUID(), randomUUID()];
      for (const [index, status] of ["in_review", "in_progress"].entries()) {
        await sql`INSERT INTO issues (id, company_id, title, assignee_agent_id, status, conversation_agent_id, conversation_user_id, conversation_state)
          VALUES (${legacyNullIds[index]!}, ${row.companyId}, 'Legacy null state', ${row.agentId}, ${status}, ${row.agentId}, ${`legacy-null-${index}`}, NULL)`;
      }

      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "needsMigrations", pendingMigrations: [migrationFile],
      });
      await applyPendingMigrations(database.connectionString);
      // Exercise the SQL itself a second time, even with every new object present.
      await sql.begin(async (tx) => {
        for (const statement of migrationSql.split("--> statement-breakpoint")) {
          if (statement.trim()) await tx.unsafe(statement);
        }
      });
      expect(await sql`SELECT * FROM issues WHERE id = ${row.issueId}`).toEqual(beforeIssue);
      expect(await sql`SELECT * FROM issue_comments WHERE id = ${row.commentId}`).toEqual(beforeComment);
      const repaired = await sql`SELECT id, conversation_state FROM issues WHERE id IN ${sql(legacyNullIds)}`;
      expect(repaired.find((item) => item.id === legacyNullIds[0])?.conversation_state).toBe("waiting");
      expect(repaired.find((item) => item.id === legacyNullIds[1])?.conversation_state).toBe("active");
      await assertConstraints(sql, row);
    } finally {
      await sql.end();
    }
  }, 30_000);
});
