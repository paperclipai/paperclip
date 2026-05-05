import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentThreadMessages,
  agentThreadReads,
  agentThreads,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentThreadService } from "../services/agent-threads.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent thread service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agentThreadService.postUserMessage", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof agentThreadService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-threads-service-");
    db = createDb(tempDb.connectionString);
    svc = agentThreadService(db);
    await ensureAgentThreadTables(db);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql.raw(`delete from agent_thread_reads`));
    await db.execute(sql.raw(`delete from agent_thread_messages`));
    await db.execute(sql.raw(`delete from agent_threads`));
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("creates a new active thread and first human message when none exists", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const userId = "user-1";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const result = await svc.postUserMessage({
      companyId,
      agentId,
      authorUserId: userId,
      body: "hello from board",
      now: new Date("2026-05-04T09:00:00.000Z"),
    });

    expect(result.thread).toMatchObject({
      companyId,
      agentId,
      status: "active",
      archivedAt: null,
    });
    expect(result.message).toMatchObject({
      threadId: result.thread.id,
      companyId,
      role: "user",
      authorUserId: userId,
      authorAgentId: null,
      body: "hello from board",
      producingHeartbeatRunId: null,
    });
    expect(result.thread.lastActivityAt.toISOString()).toBe("2026-05-04T09:00:00.000Z");
  });

  it("archives a stale active thread on send and writes the message into a fresh active thread", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const userId = "user-2";
    const staleThreadId = randomUUID();
    const staleAt = new Date("2026-05-03T00:00:00.000Z");
    const now = new Date("2026-05-04T13:30:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentThreads).values({
      id: staleThreadId,
      companyId,
      agentId,
      status: "active",
      archivedAt: null,
      lastActivityAt: staleAt,
      createdAt: staleAt,
      updatedAt: staleAt,
    });
    await db.insert(agentThreadMessages).values({
      threadId: staleThreadId,
      companyId,
      role: "user",
      authorUserId: "older-user",
      authorAgentId: null,
      producingHeartbeatRunId: null,
      body: "old message",
      createdAt: staleAt,
      updatedAt: staleAt,
    });

    const result = await svc.postUserMessage({
      companyId,
      agentId,
      authorUserId: userId,
      body: "fresh message",
      now,
    });

    expect(result.thread.id).not.toBe(staleThreadId);
    expect(result.thread.status).toBe("active");
    expect(result.message.threadId).toBe(result.thread.id);
    expect(result.message.body).toBe("fresh message");

    const archivedThreads = await db
      .select()
      .from(agentThreads)
      .where(eq(agentThreads.id, staleThreadId));
    expect(archivedThreads[0]).toMatchObject({
      id: staleThreadId,
      status: "archived",
    });
    expect(archivedThreads[0]?.archivedAt?.toISOString()).toBe(now.toISOString());
  });

  it("keeps prior archived threads when a later active thread also goes stale", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const first = await svc.postUserMessage({
      companyId,
      agentId,
      authorUserId: "user-1",
      body: "first",
      now: new Date("2026-05-01T00:00:00.000Z"),
    });

    const second = await svc.postUserMessage({
      companyId,
      agentId,
      authorUserId: "user-2",
      body: "second",
      now: new Date("2026-05-01T13:00:00.000Z"),
    });

    const third = await svc.postUserMessage({
      companyId,
      agentId,
      authorUserId: "user-3",
      body: "third",
      now: new Date("2026-05-02T02:00:00.000Z"),
    });

    expect(second.thread.id).not.toBe(first.thread.id);
    expect(third.thread.id).not.toBe(second.thread.id);

    const threads = await db
      .select()
      .from(agentThreads)
      .where(eq(agentThreads.companyId, companyId));

    expect(threads.filter((thread) => thread.status === "archived")).toHaveLength(2);
    expect(threads.filter((thread) => thread.status === "active")).toHaveLength(1);
  });

  it("stores assistant-visible replies as thread messages linked to producing runs", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const firstMessage = await svc.postUserMessage({
      companyId,
      agentId,
      authorUserId: "user-1",
      body: "hello from board",
      now: new Date("2026-05-04T09:00:00.000Z"),
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "succeeded",
    });

    const assistantMessage = await svc.postAssistantMessage({
      companyId,
      threadId: firstMessage.thread.id,
      authorAgentId: agentId,
      body: "created 3 issues",
      producingHeartbeatRunId: runId,
      now: new Date("2026-05-04T09:05:00.000Z"),
    });

    expect(assistantMessage).toMatchObject({
      threadId: firstMessage.thread.id,
      companyId,
      role: "assistant",
      authorUserId: null,
      authorAgentId: agentId,
      body: "created 3 issues",
      producingHeartbeatRunId: runId,
    });

    const storedMessages = await db
      .select()
      .from(agentThreadMessages)
      .where(eq(agentThreadMessages.threadId, firstMessage.thread.id));

    expect(storedMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("stores independent per-user read state on the active thread", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const firstMessage = await svc.postUserMessage({
      companyId,
      agentId,
      authorUserId: "user-1",
      body: "hello from board",
      now: new Date("2026-05-04T09:00:00.000Z"),
    });

    const firstRead = await svc.markRead({
      companyId,
      agentId,
      userId: "user-1",
      lastReadMessageId: firstMessage.message.id,
      now: new Date("2026-05-04T09:05:00.000Z"),
    });
    const secondRead = await svc.markRead({
      companyId,
      agentId,
      userId: "user-2",
      lastReadMessageId: null,
      now: new Date("2026-05-04T09:06:00.000Z"),
    });

    expect(firstRead.readState.userId).toBe("user-1");
    expect(firstRead.readState.lastReadMessageId).toBe(firstMessage.message.id);
    expect(secondRead.readState.userId).toBe("user-2");
    expect(secondRead.readState.lastReadMessageId).toBeNull();

    const storedReadStates = await db
      .select()
      .from(agentThreadReads)
      .where(eq(agentThreadReads.threadId, firstMessage.thread.id));
    expect(storedReadStates).toHaveLength(2);
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
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "agent_thread_reads" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "thread_id" uuid NOT NULL REFERENCES "agent_threads"("id"),
      "company_id" uuid NOT NULL REFERENCES "companies"("id"),
      "user_id" text NOT NULL,
      "last_read_message_id" uuid REFERENCES "agent_thread_messages"("id") ON DELETE SET NULL,
      "last_read_at" timestamptz NOT NULL DEFAULT now(),
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
  await db.execute(sql.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS "agent_thread_reads_company_thread_user_uq"
    ON "agent_thread_reads" ("company_id", "thread_id", "user_id");
  `));
}
