import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentThreadMessages,
  agentThreads,
  companies,
  createDb,
} from "@paperclipai/db";
import { sql } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildPaperclipWakePayload } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat agent-thread payload tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("buildPaperclipWakePayload agent thread", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-agent-thread-payload-");
    db = createDb(tempDb.connectionString);
    await ensureAgentThreadTables(db);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql.raw(`delete from agent_thread_messages`));
    await db.execute(sql.raw(`delete from agent_threads`));
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("builds inline wake payload for direct agent-thread conversation", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const threadId = randomUUID();
    const messageId = randomUUID();
    const now = new Date("2026-05-04T09:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentThreads).values({
      id: threadId,
      companyId,
      agentId,
      status: "active",
      archivedAt: null,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(agentThreadMessages).values({
      id: messageId,
      threadId,
      companyId,
      role: "user",
      authorUserId: "user-1",
      authorAgentId: null,
      producingHeartbeatRunId: null,
      body: "make 3 follow-up issues",
      createdAt: now,
      updatedAt: now,
    });

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        wakeReason: "agent_thread_message",
        agentThreadId: threadId,
        agentThreadMessageId: messageId,
      },
    });

    expect(payload).toMatchObject({
      reason: "agent_thread_message",
      thread: {
        id: threadId,
        agentId,
        agentName: "CTO",
      },
      threadMessageIds: [messageId],
      latestThreadMessageId: messageId,
      threadMessages: [
        {
          id: messageId,
          threadId,
          role: "user",
          body: "make 3 follow-up issues",
        },
      ],
      fallbackFetchNeeded: false,
    });
  });
});

async function ensureAgentThreadTables(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "agent_threads" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL REFERENCES "companies"("id"),
      "agent_id" uuid NOT NULL REFERENCES "agents"("id"),
      "status" text NOT NULL DEFAULT 'active',
      "archived_at" timestamptz,
      "last_activity_at" timestamptz NOT NULL DEFAULT now(),
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
  await db.execute(sql.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS "agent_threads_company_agent_active_uq"
    ON "agent_threads" ("company_id", "agent_id")
    WHERE "status" = 'active';
  `));
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "agent_thread_messages" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "thread_id" uuid NOT NULL REFERENCES "agent_threads"("id"),
      "company_id" uuid NOT NULL REFERENCES "companies"("id"),
      "role" text NOT NULL,
      "author_user_id" text,
      "author_agent_id" uuid REFERENCES "agents"("id"),
      "producing_heartbeat_run_id" uuid REFERENCES "heartbeat_runs"("id") ON DELETE SET NULL,
      "body" text NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}
