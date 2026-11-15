import { randomUUID } from "node:crypto";
import { setImmediate as immediate } from "node:timers/promises";
import { setTimeout as realTimeout } from "node:timers";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, chatActions, chatConversations, chatDeliveries, chatEndpoints,
  chatExternalPrincipals, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issues,
  chatMessageLinks, chatPublications, toolApplications, toolConnections, type Db } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { notifyDeferredExecutionEligibility, notifyDeferredExecutionWork, notifyDeferredWakesForIssue } from "../services/deferred-execution-notifications.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createDurableChatWakeupRequest, resumeDeferredChatWake } from "../services/durable-chat-wakeup.js";
import { createInboundWakeups } from "../services/chat-channels/inbound/wakeups.js";
import { chatWakeAuthorityDenied } from "../services/chat-channels/inbound/wakeup-authorization-error.js";
import { createInboundWakeNotices } from "../services/chat-channels/inbound/wakeup-notices.js";
import { inboundWakePublicationKey } from "../services/chat-inbound-wakeup-publications.js";
import { projectSafeChatPublication } from "../services/chat-publication-projection.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../services/delivery-work-notifications.js";
import { logger } from "../middleware/logger.js";

vi.setConfig({ testTimeout: 120_000 });
const RESUME_FAILED = "saved chat source could not resume after recovery";
const HOUR_MS = 60 * 60_000;

describe("deferred chat wake sweep", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator>;
  let unregisterOwner: (() => void) | undefined;
  const statements: string[] = [];
  const errors: unknown[] = [];
  const passes = new Set<Promise<unknown>>();

  beforeAll(async () => {
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_DEFERRED_CHAT_WAKE_TEST_DATABASE_URL");
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("deferred-chat-wake-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    db.$client.options.onnotice = () => {};
    db.$client.options.debug = (_connection, query) => { statements.push(query); };
  });
  beforeEach(async () => {
    await db.execute(sql`truncate companies cascade`);
    errors.length = 0;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    heartbeat = heartbeatService(db);
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true,
      onError: error => { errors.push(error); } });
    const register = coordinator.register.bind(coordinator);
    coordinator.register = (queue, task) => register(queue, { ...task, run: signal => {
      const pass = Promise.resolve(task.run(signal)); passes.add(pass);
      void pass.then(() => passes.delete(pass), () => passes.delete(pass)); return pass;
    } });
    unregisterOwner = createInboundWakeups(db, {
      authorizeInboundWakeup: async () => { throw new Error("unused"); },
      authorizeInboundWorkStart: (tx, action) => authorize(tx as unknown as Db, action) as never,
      attachmentOmissionDetail: () => null, isExternalActionAuthorizationChange: () => false, redactError: String,
      fetchImpl: async () => { throw new Error("unused"); }, heartbeat,
    }).unregisterDeferredWakeOwner;
  });
  afterEach(async () => {
    unregisterOwner?.(); onAuthorize = undefined;
    await coordinator.stop(); await heartbeat.drainActiveRunExecutions();
    vi.useRealTimers(); vi.restoreAllMocks();
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  let onAuthorize: ((action: typeof chatActions.$inferSelect) => Promise<void>) | undefined;
  async function authorize(tx: Db, action: typeof chatActions.$inferSelect) {
    await onAuthorize?.(action);
    const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, action.companyId),
      eq(issues.id, String(action.payload.issueId)))).for("update");
    if (!issue || issue.assigneeAgentId !== action.payload.agentId || ["backlog", "done", "cancelled"].includes(issue.status))
      throw chatWakeAuthorityDenied("task_assignment");
    const [comment] = await tx.select().from(issueComments).where(eq(issueComments.id, String(action.payload.commentId)));
    if (!comment || comment.deletedAt) throw chatWakeAuthorityDenied("source_comment");
    const [endpoint] = await tx.select().from(chatEndpoints).where(eq(chatEndpoints.id, action.endpointId));
    if (endpoint.status === "paused") throw chatWakeAuthorityDenied("runtime_fence");
    const [conversation] = await tx.select().from(chatConversations).where(eq(chatConversations.id, action.conversationId!));
    const [delivery] = await tx.select().from(chatDeliveries).where(eq(chatDeliveries.id, action.deliveryId!));
    return { issue, endpoint, conversation, delivery };
  }

  async function company() {
    const companyId = randomUUID(), userId = `chat-user-${companyId.slice(0, 8)}`;
    await db.insert(authUsers).values({ id: userId, name: "Chat sender", email: `${userId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Deferred chat", issuePrefix: `DC${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: userId, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Chat agent", adapterType: "process", status: "idle",
      adapterConfig: { command: process.execPath, args: ["-e", "console.log('chat-proof')"], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0, wakeOnDemand: true } } }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId, name: "Chat", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application.id,
      uid: randomUUID(), name: "Chat", transport: "rest_api" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId, connectionId: connection.id, provider: "slack",
      publicId: randomUUID(), assignedAgentId: agent.id, status: "active" }).returning();
    const [principal] = await db.insert(chatExternalPrincipals).values({ companyId, provider: "slack",
      providerAccountId: "TWORKSPACE", externalId: `U${companyId.slice(0, 6)}`, kind: "user", isBot: false }).returning();
    return { companyId, userId, agent, endpoint, principal };
  }

  async function wake(c: Awaited<ReturnType<typeof company>>, input: { status: string; ageMs: number; runStatus?: string;
    on?: { issue: typeof issues.$inferSelect; conversation: typeof chatConversations.$inferSelect } }) {
    const createdAt = new Date(Date.now() - input.ageMs);
    const issue = input.on?.issue ?? (await db.insert(issues).values({ companyId: c.companyId, title: "Chat task", status: input.status,
      assigneeAgentId: c.agent.id }).returning())[0];
    const conversation = input.on?.conversation ?? (await db.insert(chatConversations).values({ companyId: c.companyId,
      endpointId: c.endpoint.id, issueId: issue.id, externalConversationId: "CCHANNEL",
      externalThreadId: `slack:CCHANNEL:${randomUUID()}`, externalLabel: "Thread", state: "active", isDirectMessage: false }).returning())[0];
    const [comment] = await db.insert(issueComments).values({ companyId: c.companyId, issueId: issue.id,
      authorUserId: c.userId, body: "A follow-up sent while the task was running" }).returning();
    const providerEventId = randomUUID();
    const [delivery] = await db.insert(chatDeliveries).values({ companyId: c.companyId, endpointId: c.endpoint.id,
      conversationId: conversation.id, principalId: c.principal.id, providerEventId, deduplicationKey: randomUUID(),
      eventKind: "message", state: "processed", attempts: 1, normalizedEvent: { providerEventId, kind: "message" } }).returning();
    const actionId = randomUUID();
    const payload = { version: 1, issueId: issue.id, agentId: c.agent.id, commentId: comment.id, sessionGeneration: 1,
      requestedByActorType: "user", requestedByActorId: c.userId };
    await db.insert(chatActions).values({ id: actionId, companyId: c.companyId, endpointId: c.endpoint.id, deliveryId: delivery.id,
      conversationId: conversation.id, principalId: c.principal.id, kind: "inbound_wakeup",
      providerActionId: `inbound_wakeup:${delivery.id}`, status: "processed", payload, createdAt });
    const request = createDurableChatWakeupRequest({ id: actionId, companyId: c.companyId, agentId: c.agent.id, issueId: issue.id,
      commentId: comment.id, requestedByActorType: "user", requestedByActorId: c.userId, requestedAt: createdAt,
      authorize: async () => {} });
    await db.insert(agentWakeupRequests).values({ id: actionId, companyId: c.companyId, agentId: c.agent.id,
      source: "assignment", triggerDetail: "system", reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: c.userId, idempotencyKey: request.idempotencyKey,
      requestedAt: createdAt, createdAt, updatedAt: createdAt,
      payload: { issueId: issue.id, mutation: "comment", _paperclipWakeContext: { issueId: issue.id, wakeReason: "issue_commented",
        wakeCommentId: comment.id, wakeCommentIds: [comment.id], commentId: comment.id } } });
    const [run] = await db.insert(heartbeatRuns).values({ companyId: c.companyId, agentId: c.agent.id,
      status: input.runStatus ?? "succeeded", startedAt: createdAt,
      finishedAt: input.runStatus === "running" ? null : new Date(createdAt.getTime() + 1000),
      contextSnapshot: { issueId: issue.id } }).returning();
    return { issue, requestId: actionId, run, conversation, payloadCommentId: comment.id };
  }

  async function settle() {
    for (let index = 0; index < 20; index++) {
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.allSettled([...passes]); await immediate();
    }
  }
  function resumeFailures(spy: { mock: { calls: unknown[][] } }): unknown[][] {
    return spy.mock.calls.filter(call => call[1] === RESUME_FAILED);
  }
  async function idle(minutes: number) {
    const before = statements.length;
    const updatesBefore = statements.filter(query => /^\s*update\s+"agent_wakeup_requests"/i.test(query)).length;
    for (let minute = 0; minute < minutes; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.allSettled([...passes]); await immediate();
    }
    return { statements: statements.length - before,
      wakeUpdates: statements.filter(query => /^\s*update\s+"agent_wakeup_requests"/i.test(query)).length - updatesBefore };
  }
  async function receipt(requestId: string) {
    return (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, requestId)))[0];
  }
  function waitForReal(assertion: () => Promise<unknown>, timeout = 10_000) {
    const started = performance.now();
    return new Promise<void>((resolve, reject) => {
      const attempt = async () => {
        try { await assertion(); resolve(); }
        catch (error) { if (performance.now() - started > timeout) reject(error); else realTimeout(attempt, 50); }
      };
      void attempt();
    });
  }

  it("settles stale wakes of finished tasks once and then stays idle for 30 minutes", async () => {
    const c = await company();
    const wakes = [];
    for (let index = 0; index < 12; index++) {
      wakes.push(await wake(c, { status: index % 3 === 0 ? "cancelled" : "done", ageMs: 7 * 24 * 60 * 60_000 }));
    }
    const warn = vi.spyOn(logger, "warn");
    await heartbeat.registerDeferredReceiptWork(coordinator, () => true).ready;
    await settle();
    const settledLogs = resumeFailures(warn).length;
    const quiet = await idle(30);
    const logs = resumeFailures(warn).length - settledLogs;
    console.info(`[deferred-chat-wake] 12 stale wakes, 30 idle minutes: statements=${quiet.statements} `
      + `wakeUpdates=${quiet.wakeUpdates} resumeFailureLogs=${logs} firstPassLogs=${settledLogs}`);
    for (const { requestId } of wakes) {
      expect(await receipt(requestId)).toMatchObject({ status: "skipped", error: "task_closed", runId: null });
    }
    expect(await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.wakeupRequestId} is not null`)).toHaveLength(0);
    expect((await db.select().from(issues).where(eq(issues.companyId, c.companyId))).map(row => row.status).sort())
      .toEqual(wakes.map((_, index) => index % 3 === 0 ? "cancelled" : "done").sort());
    expect(resumeFailures(warn).every(call => (call[0] as { reason?: string }).reason === "task_closed")).toBe(true);
    expect(quiet).toEqual({ statements: 0, wakeUpdates: 0 });
    expect(logs).toBe(0);
    expect(errors).toEqual([]);
  });

  it("settles a saved chat wake whose task no longer exists", async () => {
    const c = await company();
    const orphan = await wake(c, { status: "todo", ageMs: 60_000 });
    const before = await receipt(orphan.requestId);
    await db.update(agentWakeupRequests).set({ payload: { ...before.payload, issueId: randomUUID() } })
      .where(eq(agentWakeupRequests.id, orphan.requestId));
    await heartbeat.registerDeferredReceiptWork(coordinator, () => true).ready;
    await settle();
    expect(await receipt(orphan.requestId)).toMatchObject({ status: "skipped", error: "task_missing", runId: null });
    expect(await idle(30)).toEqual({ statements: 0, wakeUpdates: 0 });
    expect(errors).toEqual([]);
  });

  async function visibleQueuedNotice(c: Awaited<ReturnType<typeof company>>, saved: Awaited<ReturnType<typeof wake>>) {
    const [action] = await db.select().from(chatActions).where(eq(chatActions.id, saved.requestId));
    const providerMessageId = randomUUID();
    const [publication] = await db.insert(chatPublications).values({ companyId: c.companyId, endpointId: c.endpoint.id,
      conversationId: saved.conversation.id, issueId: saved.issue.id, commentId: saved.payloadCommentId,
      idempotencyKey: inboundWakePublicationKey(saved.requestId, "queued", c.endpoint.id, saved.conversation.id),
      payload: projectSafeChatPublication({ classification: "external", source: "safe_milestone",
        text: "Your follow-up is queued.", progressState: "queued" }),
      state: "published", providerMessageId }).returning();
    await db.insert(chatMessageLinks).values({ companyId: c.companyId, endpointId: c.endpoint.id,
      conversationId: saved.conversation.id, publicationId: publication.id, providerMessageId, direction: "outbound" });
    return action;
  }
  function noticeWorker() {
    return createInboundWakeNotices(db, {
      authorizeInboundWakeup: (async (tx: Db, action: typeof chatActions.$inferSelect) => {
        const [issue] = await tx.select().from(issues).where(eq(issues.id, String(action.payload.issueId)));
        const [endpoint] = await tx.select().from(chatEndpoints).where(eq(chatEndpoints.id, action.endpointId));
        const [conversation] = await tx.select().from(chatConversations).where(eq(chatConversations.id, action.conversationId!));
        const [delivery] = await tx.select().from(chatDeliveries).where(eq(chatDeliveries.id, action.deliveryId!));
        return { issue, endpoint, conversation, delivery, resource: null };
      }) as never,
      enqueueFailedChatRetryPublications: async () => 0,
      authorizeRetainedChatSourcePublication: async () => false,
      isExternalActionAuthorizationChange: () => false,
      isShuttingDown: () => false,
    });
  }
  async function notStartedNotices(companyId: string) {
    return (await db.select().from(chatPublications).where(eq(chatPublications.companyId, companyId)))
      .filter(row => row.idempotencyKey.includes(":not_started:"));
  }

  it("closes old saved messages silently and tells a recent watcher once, across passes and restarts", async () => {
    const c = await company();
    const old = await wake(c, { status: "done", ageMs: 72 * HOUR_MS });
    const recent = await wake(c, { status: "done", ageMs: 3 * HOUR_MS });
    await visibleQueuedNotice(c, old);
    await visibleQueuedNotice(c, recent);
    const noticeSignals: string[] = [];
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.chatInboundWakeNotices, () => { noticeSignals.push("signal"); });
    try {
      await heartbeat.registerDeferredReceiptWork(coordinator, () => true).ready;
      await settle();
    } finally { unsubscribe(); }
    expect(await receipt(old.requestId)).toMatchObject({ status: "skipped", error: "task_closed", runId: null,
      payload: { silentSettlement: true } });
    expect(await receipt(recent.requestId)).toMatchObject({ status: "skipped", error: "task_closed", runId: null });
    expect((await receipt(recent.requestId)).payload?.silentSettlement).toBeUndefined();
    expect(noticeSignals).toHaveLength(1);
    const deliveries = await db.select().from(chatDeliveries).where(eq(chatDeliveries.companyId, c.companyId));
    const deliveryOf = async (requestId: string) => {
      const [action] = await db.select().from(chatActions).where(eq(chatActions.id, requestId));
      return deliveries.find(row => row.id === action.deliveryId)!;
    };
    expect((await deliveryOf(old.requestId)).redactedError).toBeNull();
    expect((await deliveryOf(recent.requestId)).redactedError).toContain("Input saved.");
    const first = await noticeWorker().reconcileInboundWakeNotices({ scope: { companyId: c.companyId } });
    expect(first.inserted).toBe(1);
    expect((await notStartedNotices(c.companyId)).map(row => row.commentId)).toEqual([recent.payloadCommentId]);
    expect((await noticeWorker().reconcileInboundWakeNotices({ scope: { companyId: c.companyId } })).inserted).toBe(0);
    expect(await noticeWorker().loadInboundWakeNoticeScopes()).toEqual([]);
    expect((await notStartedNotices(c.companyId)).map(row => row.commentId)).toEqual([recent.payloadCommentId]);
  });

  it("reopens a finished task for a recent saved chat message, as a message on a finished task does", async () => {
    const c = await company();
    const recent = await wake(c, { status: "done", ageMs: 5 * 60_000 });
    await heartbeat.registerDeferredReceiptWork(coordinator, () => true).ready;
    await waitForReal(async () => {
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, recent.requestId));
      expect(runs).toHaveLength(1);
    });
    expect((await db.select().from(issues).where(eq(issues.id, recent.issue.id)))[0].status).not.toBe("done");
    expect((await receipt(recent.requestId)).status).not.toBe("skipped");
  });

  it("starts one follow-up run for two recent saved messages on the same finished task", async () => {
    const c = await company();
    const first = await wake(c, { status: "done", ageMs: 10 * 60_000 });
    const second = await wake(c, { status: "done", ageMs: 5 * 60_000, on: first });
    await heartbeat.registerDeferredReceiptWork(coordinator, () => true).ready;
    await waitForReal(async () => {
      const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, c.companyId),
        sql`${heartbeatRuns.wakeupRequestId} is not null`));
      expect(runs).toHaveLength(1);
      const receipts = await Promise.all([receipt(first.requestId), receipt(second.requestId)]);
      expect(receipts.map(row => row.runId)).toEqual([runs[0].id, runs[0].id]);
      expect(receipts[0]).toMatchObject({ status: "coalesced", payload: { coalescedIntoWakeupRequestId: second.requestId } });
      expect(runs[0].contextSnapshot?.wakeCommentIds).toEqual([
        first.payloadCommentId, second.payloadCommentId]);
    });
    await settle();
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, c.companyId),
      sql`${heartbeatRuns.wakeupRequestId} is not null`))).toHaveLength(1);
  });

  it("answers a recent saved message alone when a newer message of the same task lost its source", async () => {
    const c = await company();
    const valid = await wake(c, { status: "done", ageMs: 10 * 60_000 });
    const removed = await wake(c, { status: "done", ageMs: 5 * 60_000, on: valid });
    await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, removed.payloadCommentId));
    await heartbeat.registerDeferredReceiptWork(coordinator, () => true).ready;
    await waitForReal(async () => {
      const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, c.companyId),
        sql`${heartbeatRuns.wakeupRequestId} is not null`));
      expect(runs).toHaveLength(1);
      expect(runs[0].wakeupRequestId).toBe(valid.requestId);
      expect(runs[0].contextSnapshot?.wakeCommentIds ?? []).not.toContain(removed.payloadCommentId);
      const left = await receipt(removed.requestId);
      expect(left.runId).toBeNull();
      expect(["skipped", "deferred_issue_execution"]).toContain(left.status);
      if (left.status === "skipped") expect(left.error).toBe("authority_source_comment");
    });
  });

  it("refuses a batch that another run took a message from before admission, then answers the rest alone", async () => {
    const c = await company();
    const older = await wake(c, { status: "done", ageMs: 10 * 60_000 });
    const newer = await wake(c, { status: "done", ageMs: 5 * 60_000, on: older });
    const [other] = await db.insert(heartbeatRuns).values({ companyId: c.companyId, agentId: c.agent.id, status: "succeeded",
      startedAt: new Date(Date.now() - 2000), finishedAt: new Date(Date.now() - 1000),
      contextSnapshot: { issueId: randomUUID(), wakeCommentIds: [older.payloadCommentId] } }).returning();
    let newerChecks = 0;
    onAuthorize = async action => {
      if (action.id !== newer.requestId || ++newerChecks !== 2) return;
      await db.update(agentWakeupRequests).set({ status: "completed", runId: other.id }).where(eq(agentWakeupRequests.id, older.requestId));
    };
    const scope = { companyId: c.companyId, agentId: c.agent.id, issueId: older.issue.id, recoverySweep: true };
    await expect(resumeDeferredChatWake(db, { ...scope, requestId: older.requestId }))
      .rejects.toThrow("chat_inbound_wakeup_batch_changed");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, newer.requestId))).toHaveLength(0);
    expect(await receipt(newer.requestId)).toMatchObject({ status: "deferred_issue_execution", runId: null });
    await resumeDeferredChatWake(db, { ...scope, requestId: newer.requestId });
    const [alone] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, newer.requestId));
    expect(alone.contextSnapshot?.wakeCommentIds ?? [newer.payloadCommentId]).toEqual([newer.payloadCommentId]);
    expect(await receipt(older.requestId)).toMatchObject({ status: "completed", runId: other.id });
  });

  it("keeps a refused follow-up in the saved pause wait without retrying, then starts it when the pause lifts", async () => {
    const c = await company();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, c.agent.id));
    const refused = await wake(c, { status: "done", ageMs: 5 * 60_000 });
    await heartbeat.registerDeferredReceiptWork(coordinator, () => true).ready;
    await settle();
    const waiting = await receipt(refused.requestId);
    expect(waiting).toMatchObject({ status: "deferred_issue_execution", runId: null,
      payload: { executionWait: { reason: "agent.not_invokable" } } });
    expect(waiting.payload?.chatResume).toBeUndefined();
    expect(await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.wakeupRequestId} is not null`)).toHaveLength(0);
    await idle(1);
    expect(await idle(30)).toEqual({ statements: 0, wakeUpdates: 0 });
    expect(await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.wakeupRequestId} is not null`)).toHaveLength(0);
    await db.transaction(async tx => {
      await tx.update(agents).set({ status: "idle" }).where(eq(agents.id, c.agent.id));
      await notifyDeferredExecutionEligibility(tx, { companyId: c.companyId });
    });
    await waitForReal(async () => {
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, refused.requestId))).toHaveLength(1);
    }, 10_000);
  });

  it("spaces bounded attempts on a stored time and still resumes promptly on a real event", async () => {
    const c = await company();
    await db.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, c.endpoint.id));
    const paused = await wake(c, { status: "todo", ageMs: 60_000 });
    const warn = vi.spyOn(logger, "warn");
    await heartbeat.registerDeferredReceiptWork(coordinator, () => true).ready;
    await settle();
    const first = await receipt(paused.requestId);
    expect(first).toMatchObject({ status: "deferred_issue_execution", error: "authority_runtime_fence" });
    const nextAttemptAt = Date.parse(String((first.payload?.chatResume as Record<string, unknown>).nextAttemptAt));
    expect(nextAttemptAt).toBeGreaterThan(Date.now());
    const window = await idle(30);
    const attempts = resumeFailures(warn);
    console.info(`[deferred-chat-wake] paused endpoint, 30 idle minutes: attempts=${attempts.length} statements=${window.statements}`);
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts.length).toBeLessThanOrEqual(4);
    expect(attempts.every(call => (call[0] as { reason?: string }).reason === "authority_runtime_fence")).toBe(true);
    const later = await receipt(paused.requestId);
    expect(later.status).toBe("deferred_issue_execution");
    await db.transaction(async tx => {
      await tx.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, c.endpoint.id));
      await notifyDeferredExecutionWork(tx, { companyId: c.companyId, requestId: paused.requestId });
    });
    await waitForReal(async () => {
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, paused.requestId))).toHaveLength(1);
    }, 5_000);
  });

  it("waits for the run it was deferred behind and resumes as soon as that run finishes", async () => {
    const c = await company();
    const waiting = await wake(c, { status: "in_progress", ageMs: 30_000, runStatus: "running" });
    await heartbeat.registerDeferredReceiptWork(coordinator, () => true).ready;
    await settle();
    const window = await idle(10);
    expect(window).toEqual({ statements: 0, wakeUpdates: 0 });
    expect(await receipt(waiting.requestId)).toMatchObject({ status: "deferred_issue_execution", error: null });
    await db.transaction(async tx => {
      await tx.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, waiting.run.id));
      await notifyDeferredWakesForIssue(tx, { companyId: c.companyId, issueId: waiting.issue.id });
    });
    await waitForReal(async () => {
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, waiting.requestId))).toHaveLength(1);
    }, 5_000);
  });
});
