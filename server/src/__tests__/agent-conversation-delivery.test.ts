import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, issueComments, issues } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { deliverConversationComments, undeliveredConversationComments } from "../services/agent-conversations.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { recoveryService } from "../services/recovery/service.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("conversation outbox eligibility", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("conversation-delivery-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });

  async function fixture(status = "paused") {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Delivery", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coordinator", status, adapterType: "process" });
    const [chat] = await db.insert(issues).values({ companyId, title: "Standing chat", status: "in_review",
      conversationAgentId: agentId, conversationUserId: "local-board", conversationState: "waiting", assigneeAgentId: agentId }).returning();
    const [comment] = await db.insert(issueComments).values({ companyId, issueId: chat.id, authorUserId: "local-board",
      body: "Keep this request until the agent resumes.", clientRequestId: randomUUID() }).returning();
    const pending = () => undeliveredConversationComments(db, companyId, chat.id);
    return { companyId, agentId, chat, comment, pending };
  }

  // Queue persistence only: these tests never start an agent or provider.
  const enqueue = () => vi.fn<Parameters<typeof recoveryService>[1]["enqueueWakeup"]>(async (agentId, options) => {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    await db.insert(agentWakeupRequests).values({ companyId: agent.companyId, agentId,
      source: options?.source ?? "on_demand", status: "queued", idempotencyKey: options?.idempotencyKey,
      payload: options?.payload, requestedByActorType: options?.requestedByActorType,
      requestedByActorId: options?.requestedByActorId });
    return null;
  });

  it.each(["paused", "terminated", "pending_approval"])("defers %s agents without consuming their comment", async (status) => {
    const f = await fixture(status);
    const wake = enqueue();
    expect(await deliverConversationComments(db, f.chat, wake)).toBe("deferred");
    expect(wake).not.toHaveBeenCalled();
    expect((await f.pending()).map(row => row.id)).toEqual([f.comment.id]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId))).toEqual([]);
  });

  it("reconciles other chats while paused comments remain pending, then delivers once after unpause", async () => {
    const paused = await fixture(), ready = await fixture("idle");
    const wake = enqueue();
    const recovery = recoveryService(db, { enqueueWakeup: wake });
    await expect(recovery.reconcileStrandedAssignedIssues()).resolves.toBeDefined();
    expect(wake.mock.calls.map(([agentId]) => agentId)).toEqual([ready.agentId]);
    expect(await paused.pending()).toHaveLength(1);
    expect(await ready.pending()).toHaveLength(0);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, paused.agentId));
    await recovery.reconcileStrandedAssignedIssues();
    await recovery.reconcileStrandedAssignedIssues();
    expect(wake.mock.calls.map(([agentId]) => agentId)).toEqual([ready.agentId, paused.agentId]);
    expect(await paused.pending()).toHaveLength(0);
  });

  it("defers a pause racing queue admission without losing the pending comment", async () => {
    const f = await fixture("idle");
    const wake = vi.fn(async () => {
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
      throw conflict("Agent is not invokable in its current state", { reason: "paused" });
    });
    expect(await deliverConversationComments(db, f.chat, wake)).toBe("deferred");
    expect(wake).toHaveBeenCalledTimes(1);
    expect(await f.pending()).toHaveLength(1);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    expect(await deliverConversationComments(db, f.chat, enqueue())).toBe("delivered");
    expect(await f.pending()).toHaveLength(0);
  });

  it("keeps unrelated admission errors visible and comments pending", async () => {
    const f = await fixture("idle");
    await expect(deliverConversationComments(db, f.chat, async () => {
      throw conflict("Budget exhausted", { scopeType: "company" });
    })).rejects.toThrow("Budget exhausted");
    expect(await f.pending()).toHaveLength(1);
  });

  it("preserves the queue's setup exception for retaining accepted work", async () => {
    const f = await fixture();
    await db.update(agents).set({ lifecycleState: "preparing", lifecycleHolds: [] }).where(eq(agents.id, f.agentId));
    const wake = enqueue();
    expect(await deliverConversationComments(db, f.chat, wake)).toBe("delivered");
    expect(wake).toHaveBeenCalledTimes(1);
    expect(await f.pending()).toHaveLength(0);
  });
});
