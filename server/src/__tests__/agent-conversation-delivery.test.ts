import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { deliverConversationComments, heldConversationComments, undeliveredConversationComments } from "../services/agent-conversations.js";
import { heartbeatService } from "../services/heartbeat.js";
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

  // recovery.browser-reconnect: the fourth chat message after a failed-model
  // phase hit the agent's daily run limit; admission wrote a skipped receipt
  // under the outbox key, so the message counted as delivered and never ran.
  async function capReached(f: Awaited<ReturnType<typeof fixture>>, startedAt = new Date()) {
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxDailyRuns: 1 } } }).where(eq(agents.id, f.agentId));
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "succeeded", startedAt, finishedAt: startedAt }).returning();
    return run;
  }
  const nextUtcDay = () => { const now = new Date(); return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1); };

  it("holds a message at the agent's daily limit, shows why, and sends it once the limit resets", async () => {
    const f = await fixture("idle");
    const run = await capReached(f);
    const wake = enqueue(), deadlines: number[] = [];
    expect(await deliverConversationComments(db, f.chat, wake, { onDeferredDeadline: at => deadlines.push(at) })).toBe("deferred");
    expect(wake).not.toHaveBeenCalled();
    expect(deadlines).toEqual([nextUtcDay()]);
    expect((await f.pending()).map(row => row.id)).toEqual([f.comment.id]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId))).toEqual([]);
    const held = await heldConversationComments(db, f.chat);
    expect(held?.hold).toMatchObject({ reason: "heartbeat.daily_run_limit", retryAt: nextUtcDay() });
    expect(held?.hold.message).toContain("Your message is saved");
    expect(held?.comments.map(row => row.id)).toEqual([f.comment.id]);

    // The limit counts the current UTC day; yesterday's run no longer holds it.
    await db.update(heartbeatRuns).set({ startedAt: new Date(Date.now() - 86_400_000) }).where(eq(heartbeatRuns.id, run.id));
    expect(await heldConversationComments(db, f.chat)).toBeNull();
    expect(await deliverConversationComments(db, f.chat, wake)).toBe("delivered");
    expect(wake).toHaveBeenCalledTimes(1);
    expect(await f.pending()).toHaveLength(0);
  });

  it("schedules stranded-work recovery for the limit reset instead of consuming the message", async () => {
    const f = await fixture("idle");
    await capReached(f);
    const wake = enqueue(), deadlines: number[] = [];
    await recoveryService(db, { enqueueWakeup: wake }).reconcileStrandedAssignedIssues({
      companyId: f.companyId, issueId: f.chat.id, onDeferredDeadline: at => deadlines.push(at) });
    expect(wake).not.toHaveBeenCalled();
    expect(deadlines).toContain(nextUtcDay());
    expect(await f.pending()).toHaveLength(1);
  });

  it("keeps the message owed when the limit is reached while real queue admission runs", async () => {
    const f = await fixture("idle");
    const heartbeat = heartbeatService(db);
    const wake = vi.fn<Parameters<typeof deliverConversationComments>[2]>(async (agentId, options) => {
      await capReached(f);
      return heartbeat.wakeup(agentId, options);
    });
    expect(await deliverConversationComments(db, f.chat, wake)).toBe("deferred");
    expect(wake).toHaveBeenCalledTimes(1);
    expect((await f.pending()).map(row => row.id)).toEqual([f.comment.id]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId))).toEqual([]);
  });

  it("makes a message owed again when dispatch cancels its accepted run at the daily limit", async () => {
    const f = await fixture("idle");
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxDailyRuns: 1 } } }).where(eq(agents.id, f.agentId));
    const [receipt] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "on_demand", triggerDetail: "manual", reason: "issue_commented", status: "queued",
      idempotencyKey: `conversation-comment:${f.comment.id}`, requestedByActorType: "user", requestedByActorId: "local-board",
      payload: { issueId: f.chat.id, commentId: f.comment.id } }).returning();
    const [queued] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "queued",
      wakeupRequestId: receipt.id, invocationSource: "on_demand",
      contextSnapshot: { issueId: f.chat.id, wakeCommentId: f.comment.id, wakeCommentIds: [f.comment.id] } }).returning();
    await db.update(agentWakeupRequests).set({ runId: queued.id }).where(eq(agentWakeupRequests.id, receipt.id));
    expect(await f.pending()).toHaveLength(0);
    // Another turn reaches the limit after the message was accepted.
    await capReached(f);
    await heartbeatService(db).resumeQueuedRunsForAgent(f.companyId, f.agentId);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id)))[0])
      .toMatchObject({ status: "cancelled", errorCode: "heartbeat.daily_run_limit" });
    expect((await f.pending()).map(row => row.id)).toEqual([f.comment.id]);
    const wake = enqueue();
    expect(await deliverConversationComments(db, f.chat, wake)).toBe("deferred");
    expect(wake).not.toHaveBeenCalled();
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
