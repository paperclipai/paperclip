import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const indexName = "issue_comments_agent_client_request_uq";
const migrationFile = "0419_slippery_impossible_man.sql";

(support.supported ? describe : describe.skip)("agent chat message migration", () => {
  it("repairs an interrupted index build and backfills old chat owners only once", async () => {
    const database = await startEmbeddedPostgresTestDatabase("agent-chat-message-migration-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const content = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
      const hash = createHash("sha256").update(content).digest("hex");
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash=${hash}`;
      await sql.unsafe(`ALTER TABLE issue_comments DROP CONSTRAINT ${indexName}`);
      const companies = await sql`INSERT INTO companies (name,issue_prefix) VALUES ('Chat migration','CMI1'),('Other company','CMI2') RETURNING id`;
      const companyId = companies[0]!.id;
      const [agent] = await sql`INSERT INTO agents (company_id,name,adapter_type) VALUES (${companyId},'Kodi','process') RETURNING id`;
      const chats = await sql`INSERT INTO issues (company_id,title,conversation_agent_id,conversation_user_id,conversation_state,assignee_agent_id)
        VALUES (${companyId},'Missing read state',${agent!.id},'legacy-owner','waiting',${agent!.id}),
          (${companyId},'Existing read state',${agent!.id},'existing-owner','waiting',${agent!.id}) RETURNING id,conversation_user_id`;
      for (const chat of chats) {
        await sql`INSERT INTO issue_comments (company_id,issue_id,author_agent_id,body,created_at)
          VALUES (${companyId},${chat.id},${agent!.id},'Existing message','2026-01-02T00:00:00Z')`;
      }
      await sql`INSERT INTO issue_read_states (company_id,issue_id,user_id,last_read_at)
        VALUES (${companyId},${chats[1]!.id},'existing-owner','2026-01-01T00:00:00Z')`;
      await expect(sql.unsafe(`CREATE UNIQUE INDEX CONCURRENTLY ${indexName} ON companies ((true))`)).rejects.toThrow();
      await Promise.all([applyPendingMigrations(database.connectionString), applyPendingMigrations(database.connectionString)]);
      const [index] = await sql`SELECT indisvalid,indisunique FROM pg_index WHERE indexrelid=${indexName}::regclass`;
      expect(index).toEqual({ indisvalid: true, indisunique: true });
      const [constraint] = await sql`SELECT count(*)::int count FROM pg_constraint WHERE conname=${indexName} AND conrelid='issue_comments'::regclass`;
      expect(constraint!.count).toBe(1);
      const readStates = await sql`SELECT user_id,last_read_at FROM issue_read_states WHERE company_id=${companyId} ORDER BY user_id`;
      expect(readStates.map(row => [row.user_id, row.last_read_at.toISOString()])).toEqual([
        ["existing-owner", "2026-01-01T00:00:00.000Z"],
        ["legacy-owner", "2026-01-02T00:00:00.000Z"],
      ]);
      const [newChat] = await sql`INSERT INTO issues (company_id,title,conversation_agent_id,conversation_user_id,conversation_state,assignee_agent_id)
        VALUES (${companyId},'New unread chat',${agent!.id},'new-owner','waiting',${agent!.id}) RETURNING id`;
      await sql`INSERT INTO issue_comments (company_id,issue_id,author_agent_id,body)
        VALUES (${companyId},${newChat!.id},${agent!.id},'New digest')`;
      for (let replay = 0; replay < 2; replay++) {
        for (const statement of content.split("--> statement-breakpoint").filter(statement => statement.trim())) {
          await sql.unsafe(statement);
        }
      }
      expect(await sql`SELECT id FROM issue_read_states WHERE issue_id=${newChat!.id}`).toEqual([]);
      const afterReplay = await sql`SELECT user_id,last_read_at FROM issue_read_states WHERE company_id=${companyId} ORDER BY user_id`;
      expect(afterReplay).toEqual(readStates);
      const [history] = await sql`SELECT count(*)::int count FROM drizzle.__drizzle_migrations WHERE hash=${hash}`;
      expect(history!.count).toBe(1);
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, 120_000);
});
