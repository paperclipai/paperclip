import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDb, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { externalConversationStateSql } from "../services/slack-conversation-state.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("external conversation state query plan", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-conversation-state-plan-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  it("probes unfinished runs and pending wakes through their issue-key indexes", async () => {
    const query = db.select({ state: externalConversationStateSql() }).from(issues)
      .where(eq(issues.companyId, randomUUID()));
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      return tx.execute(sql`explain ${query}`);
    });
    const text = plan.map((row) => Object.values(row)[0]).join("\n");
    expect(text).toContain("heartbeat_runs_company_unfinished_issue_key_idx");
    expect(text).toContain("agent_wakeup_requests_company_pending_issue_key_idx");
  });
});
