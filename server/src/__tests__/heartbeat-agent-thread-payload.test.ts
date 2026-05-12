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
    const firstMessageId = randomUUID();
    const secondMessageId = randomUUID();
    const thirdMessageId = randomUUID();
    const now = new Date("2026-05-04T09:00:00.000Z");

    await seedAgentThread({ db, companyId, agentId, threadId, now });

    await db.insert(agentThreadMessages).values({
      id: firstMessageId,
      threadId,
      companyId,
      role: "user",
      authorUserId: "user-1",
      authorAgentId: null,
      producingHeartbeatRunId: null,
      body: "first ask",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(agentThreadMessages).values({
      id: secondMessageId,
      threadId,
      companyId,
      role: "assistant",
      authorUserId: null,
      authorAgentId: agentId,
      producingHeartbeatRunId: null,
      body: "first reply",
      createdAt: new Date("2026-05-04T09:01:00.000Z"),
      updatedAt: new Date("2026-05-04T09:01:00.000Z"),
    });
    await db.insert(agentThreadMessages).values({
      id: thirdMessageId,
      threadId,
      companyId,
      role: "user",
      authorUserId: "user-1",
      authorAgentId: null,
      producingHeartbeatRunId: null,
      body: "make 3 follow-up issues",
      createdAt: new Date("2026-05-04T09:02:00.000Z"),
      updatedAt: new Date("2026-05-04T09:02:00.000Z"),
    });

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        wakeReason: "agent_thread_message",
        agentThreadId: threadId,
        agentThreadMessageId: thirdMessageId,
      },
    });

    expect(payload).toMatchObject({
      reason: "agent_thread_message",
      thread: {
        id: threadId,
        agentId,
        agentName: "CTO",
      },
      threadMessageIds: [firstMessageId, secondMessageId, thirdMessageId],
      latestThreadMessageId: thirdMessageId,
      threadMessages: [
        {
          id: firstMessageId,
          threadId,
          role: "user",
          body: "first ask",
        },
        {
          id: secondMessageId,
          threadId,
          role: "assistant",
          body: "first reply",
        },
        {
          id: thirdMessageId,
          threadId,
          role: "user",
          body: "make 3 follow-up issues",
        },
      ],
      threadMessageWindow: {
        totalCount: 3,
        includedCount: 3,
        missingCount: 0,
      },
      fallbackFetchNeeded: false,
    });
  });

  it("marks older thread messages missing when the inline window hits the message limit", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const threadId = randomUUID();
    const now = new Date("2026-05-04T09:00:00.000Z");

    await seedAgentThread({ db, companyId, agentId, threadId, now });

    const messageIds: string[] = [];
    for (let index = 0; index < 9; index += 1) {
      const messageId = randomUUID();
      messageIds.push(messageId);
      await db.insert(agentThreadMessages).values({
        id: messageId,
        threadId,
        companyId,
        role: index % 2 === 0 ? "user" : "assistant",
        authorUserId: index % 2 === 0 ? "user-1" : null,
        authorAgentId: index % 2 === 0 ? null : agentId,
        producingHeartbeatRunId: null,
        body: `message ${index + 1}`,
        createdAt: new Date(now.getTime() + index * 60_000),
        updatedAt: new Date(now.getTime() + index * 60_000),
      });
    }

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        wakeReason: "agent_thread_message",
        agentThreadId: threadId,
        agentThreadMessageId: messageIds[8],
      },
    });

    expect(payload?.threadMessageIds).toEqual(messageIds.slice(1));
    expect(payload?.threadMessageWindow).toMatchObject({
      totalCount: 9,
      includedCount: 8,
      missingCount: 1,
    });
    expect(payload?.fallbackFetchNeeded).toBe(true);
  });

  it("marks thread messages missing when the inline char budget is exhausted", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const threadId = randomUUID();
    const now = new Date("2026-05-04T09:00:00.000Z");

    await seedAgentThread({ db, companyId, agentId, threadId, now });

    const messageIds = Array.from({ length: 4 }, () => randomUUID());
    const budgetSizedBody = "a".repeat(4_000);

    for (const [index, messageId] of messageIds.entries()) {
      await db.insert(agentThreadMessages).values({
        id: messageId,
        threadId,
        companyId,
        role: index % 2 === 0 ? "user" : "assistant",
        authorUserId: index % 2 === 0 ? "user-1" : null,
        authorAgentId: index % 2 === 0 ? null : agentId,
        producingHeartbeatRunId: null,
        body: budgetSizedBody,
        createdAt: new Date(now.getTime() + index * 60_000),
        updatedAt: new Date(now.getTime() + index * 60_000),
      });
    }

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        wakeReason: "agent_thread_message",
        agentThreadId: threadId,
        agentThreadMessageId: messageIds[3],
      },
    });

    expect(payload?.threadMessages).toHaveLength(3);
    expect(payload?.threadMessages[0]).toMatchObject({
      id: messageIds[0],
      bodyTruncated: false,
    });
    expect(payload?.threadMessageWindow).toMatchObject({
      totalCount: 4,
      includedCount: 3,
      missingCount: 1,
    });
    expect(payload?.fallbackFetchNeeded).toBe(true);
  });
});

async function seedAgentThread(input: {
  db: ReturnType<typeof createDb>;
  companyId: string;
  agentId: string;
  threadId: string;
  now: Date;
}) {
  await input.db.insert(companies).values({
    id: input.companyId,
    name: "Paperclip",
    issuePrefix: `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });

  await input.db.insert(agents).values({
    id: input.agentId,
    companyId: input.companyId,
    name: "CTO",
    role: "cto",
    status: "active",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });

  await input.db.insert(agentThreads).values({
    id: input.threadId,
    companyId: input.companyId,
    agentId: input.agentId,
    status: "active",
    archivedAt: null,
    lastActivityAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

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
