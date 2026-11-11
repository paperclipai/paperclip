import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentWakeupRequests, chatConversations, chatDeliveries, chatMessageLinks, createDb, heartbeatRuns,
  issueComments, issues, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { seedBoundChatAuthorization } from "../../../__tests__/helpers/bound-chat-authorization.js";
import { authorizeChatConversationForBoundRun } from "../../../services/native-runtime/chat-attachment-reuse.js";
import { mergeCoalescedContextSnapshot } from "../../../services/heartbeat/run-preparation.js";
import { saveUndeliveredUserComments } from "../../../services/work-intent-outbox.js";
import { queuedCommentIdsFromWakePayload } from "../../../services/issue-queued-comment-queue.js";
import { createAdmitWakeBehindIssueExecution, createReleaseIssueExecution } from "../application/use-cases.js";
import type { WakeAdmissionActiveExecutionRun } from "../application/ports.js";
import { createAdmissionTransactionScope, createPostgresWakeQueueAdapter, createWakeAdmissionReader,
  createWakeAdmissionWriter } from "./postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const CONTEXT_KEY = "_paperclipWakeContext";

// PAP-4244 on staging. The work-intent outbox saved two unanswered GitHub
// messages as a plain deferred wake: it records no chat conversation. A new
// message from another conversation then merged into that saved wake, because
// a wake with no recorded conversation matched every conversation. The
// promoted run held messages of two conversations, and the reviewed chat
// binding refused it: `reviewed_chat_execution_binding_not_authorized`
// (`binding_denied`). Each conversation must get its own run, in order.
describe.skipIf(!support.supported)("chat wake batches stay within one conversation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let f: Awaited<ReturnType<typeof seedBoundChatAuthorization>>;
  let otherConversationId: string;
  let deferOnly = true;

  const admit = createAdmitWakeBehindIssueExecution({
    reader: createWakeAdmissionReader(),
    writer: createWakeAdmissionWriter(),
    helpers: {
      filterZombieCoalesceTarget: (target) => target,
      mergeCoalescedContextSnapshot,
      shouldDeferFollowupWakeForSameIssue: () => deferOnly,
      shouldQueueFollowupForRunningIssueWake: () => false,
    },
  });

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("wake-chat-conversation-batch-");
    db = createDb(database.connectionString);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  beforeEach(async () => {
    deferOnly = true;
    // The fixture uses fixed identifiers; move earlier cases' rows aside.
    await db.execute(sql`update companies set issue_prefix = 'X' || upper(left(replace(id::text, '-', ''), 6))`);
    await db.execute(sql`update issues set identifier = id::text`);
    f = await seedBoundChatAuthorization(db);
    otherConversationId = randomUUID();
    await db.insert(chatConversations).values({ id: otherConversationId, companyId: f.companyId, endpointId: f.endpointId,
      resourceId: f.resourceId, issueId: f.issueId, externalConversationId: "channel-1", externalThreadId: "thread-2",
      externalLabel: "Second review thread", state: "active" });
    // The fixture's own message is not part of these cases.
    await db.delete(chatMessageLinks).where(eq(chatMessageLinks.commentId, f.commentId));
    await db.delete(issueComments).where(eq(issueComments.id, f.commentId));
    await db.insert(heartbeatRuns).values({ id: f.runId, companyId: f.companyId, agentId: f.agentId, status: "running",
      invocationSource: "assignment", triggerDetail: "system", startedAt: new Date(),
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId } });
    await db.update(issues).set({ executionRunId: f.runId, executionLockedAt: new Date() }).where(eq(issues.id, f.issueId));
  });

  let messageClock = Date.now() - 600_000;
  async function message(conversationId: string | null): Promise<string> {
    messageClock += 1_000;
    const at = new Date(messageClock);
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: f.userId, body: `Message ${messageClock}`, createdAt: at, updatedAt: at }).returning();
    if (conversationId) {
      const deliveryId = randomUUID();
      await db.insert(chatDeliveries).values({ id: deliveryId, companyId: f.companyId, endpointId: f.endpointId,
        conversationId, principalId: f.principalId, providerEventId: deliveryId, deduplicationKey: deliveryId,
        eventKind: "message", normalizedEvent: {}, state: "processed", attempts: 1, processedAt: at });
      await db.insert(chatMessageLinks).values({ companyId: f.companyId, endpointId: f.endpointId, conversationId,
        deliveryId, commentId: comment!.id, providerMessageId: deliveryId, direction: "inbound" });
    }
    return comment!.id;
  }

  function chatContext(conversationId: string, commentId: string) {
    return { issueId: f.issueId, taskId: f.issueId, source: "chat:slack", wakeReason: "External chat message received",
      wakeSource: "assignment", chatConversationId: conversationId, commentId, wakeCommentId: commentId,
      wakeCommentIds: [commentId] };
  }

  function commentContext(commentId: string) {
    return { issueId: f.issueId, taskId: f.issueId, source: "issue.comment", wakeReason: "issue_commented",
      commentId, wakeCommentId: commentId, wakeCommentIds: [commentId] };
  }

  async function admitWake(contextSnapshot: Record<string, unknown>, activeExecutionRun?: WakeAdmissionActiveExecutionRun) {
    const commentId = contextSnapshot.wakeCommentId as string;
    const chat = contextSnapshot.source === "chat:slack";
    return db.transaction(async (tx) => admit(createAdmissionTransactionScope(f.companyId, tx as unknown as Db), {
      companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, agentNameKey: "chat runner",
      issueExecutionAgentNameKey: null,
      activeExecutionRun: activeExecutionRun ?? { id: f.runId, agentId: f.agentId, status: "running",
        contextSnapshot: { issueId: f.issueId, taskId: f.issueId }, wakeupRequestId: null },
      allowRunCoalescing: true, liveRunExecutions: new Set([f.runId]), wakeCommentId: commentId,
      forceFreshSession: false, contextSnapshot, source: "assignment", triggerDetail: "system",
      reason: chat ? "External chat message received" : "issue_commented",
      payload: { issueId: f.issueId, mutation: chat ? "chat_message_received" : "comment", wakeCommentId: commentId },
      requestedByActorType: "user", requestedByActorId: f.userId, idempotencyKey: null,
    }));
  }

  async function deferredWakes() {
    const rows = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"))).orderBy(asc(agentWakeupRequests.requestedAt));
    return rows.map(row => ({ id: row.id, commentIds: queuedCommentIdsFromWakePayload(row.payload),
      context: (row.payload as Record<string, Record<string, unknown>>)[CONTEXT_KEY]! }));
  }

  async function attest(context: Record<string, unknown>) {
    return authorizeChatConversationForBoundRun(db, { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      runId: f.runId }, { ...context, paperclipHarnessCheckedOut: true }, "read");
  }

  async function saveUndelivered(commentIds: string[]) {
    const saved = await saveUndeliveredUserComments(db, { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      commentIds, allowedStatuses: ["in_review"] });
    expect(saved).toBeTruthy();
    return saved!;
  }

  it("keeps a message out of a saved wake that holds another conversation's messages", async () => {
    const earlier = await message(otherConversationId);
    const saved = await saveUndelivered([earlier]);
    const reply = await message(f.conversationId);

    expect(await admitWake(chatContext(f.conversationId, reply))).toEqual({ kind: "deferred" });

    const wakes = await deferredWakes();
    // The saved messages run first, then the new conversation, each on its own.
    expect(wakes.map(wake => wake.commentIds)).toEqual([[earlier], [reply]]);
    expect(wakes[0]!.id).toBe(saved);
    expect(wakes[0]!.context.chatConversationId).toBeUndefined();
    expect(wakes[0]!.context.source).toBe("issue.comment");
    await expect(attest(wakes[1]!.context)).resolves.toMatchObject({ conversationId: f.conversationId });
  });

  it("keeps two conversations apart when both arrive behind saved wakes", async () => {
    const first = await message(f.conversationId);
    const second = await message(otherConversationId);
    await saveUndelivered([first]);
    await saveUndelivered([second]);
    const replyToFirst = await message(f.conversationId);
    const replyToSecond = await message(otherConversationId);

    await admitWake(chatContext(otherConversationId, replyToSecond));
    await admitWake(chatContext(f.conversationId, replyToFirst));

    const wakes = await deferredWakes();
    expect(wakes.map(wake => wake.commentIds)).toEqual([[first, replyToFirst], [second, replyToSecond]]);
    expect(wakes.map(wake => wake.context.chatConversationId)).toEqual([f.conversationId, otherConversationId]);
    await expect(attest(wakes[0]!.context)).resolves.toMatchObject({ conversationId: f.conversationId });
    await expect(attest(wakes[1]!.context)).resolves.toMatchObject({ conversationId: otherConversationId });
  });

  describe("batching that stays the same", () => {
    it("merges comment wakes that have no conversation", async () => {
      const one = await message(null);
      const two = await message(null);
      await admitWake(commentContext(one));
      await admitWake(commentContext(two));
      expect((await deferredWakes()).map(wake => wake.commentIds)).toEqual([[one, two]]);
    });

    it("merges messages of one conversation", async () => {
      const one = await message(f.conversationId);
      const two = await message(f.conversationId);
      await admitWake(chatContext(f.conversationId, one));
      await admitWake(chatContext(f.conversationId, two));
      const wakes = await deferredWakes();
      expect(wakes.map(wake => wake.commentIds)).toEqual([[one, two]]);
      await expect(attest(wakes[0]!.context)).resolves.toMatchObject({ conversationId: f.conversationId });
    });

    it("merges a saved wake of the same conversation's messages", async () => {
      const earlier = await message(f.conversationId);
      await saveUndelivered([earlier]);
      const reply = await message(f.conversationId);
      await admitWake(chatContext(f.conversationId, reply));
      const wakes = await deferredWakes();
      expect(wakes.map(wake => wake.commentIds)).toEqual([[earlier, reply]]);
      await expect(attest(wakes[0]!.context)).resolves.toMatchObject({ conversationId: f.conversationId });
    });

    it("merges a chat message into a wake of plain comments, and a plain comment into a chat wake", async () => {
      const plain = await message(null);
      const chat = await message(f.conversationId);
      const laterPlain = await message(null);
      await admitWake(commentContext(plain));
      await admitWake(chatContext(f.conversationId, chat));
      await admitWake(commentContext(laterPlain));
      const wakes = await deferredWakes();
      expect(wakes.map(wake => wake.commentIds)).toEqual([[plain, chat, laterPlain]]);
      expect(wakes[0]!.context.chatConversationId).toBe(f.conversationId);
    });

    it("keeps messages of two recorded conversations apart", async () => {
      const one = await message(f.conversationId);
      const two = await message(otherConversationId);
      await admitWake(chatContext(f.conversationId, one));
      await admitWake(chatContext(otherConversationId, two));
      expect((await deferredWakes()).map(wake => wake.commentIds)).toEqual([[one], [two]]);
    });
  });

  it("does not fold a message into a queued run that holds another conversation's messages", async () => {
    deferOnly = false;
    const earlier = await message(otherConversationId);
    const savedId = await saveUndelivered([earlier]);
    // The saved wake was promoted: a queued run that the finished run left behind.
    const queuedRunId = randomUUID();
    const [savedWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, savedId));
    const runContext = (savedWake!.payload as Record<string, Record<string, unknown>>)[CONTEXT_KEY]!;
    await db.insert(heartbeatRuns).values({ id: queuedRunId, companyId: f.companyId, agentId: f.agentId, status: "queued",
      invocationSource: "automation", triggerDetail: "system", wakeupRequestId: savedId, contextSnapshot: runContext });
    await db.update(agentWakeupRequests).set({ status: "queued", runId: queuedRunId }).where(eq(agentWakeupRequests.id, savedId));
    await db.update(issues).set({ executionRunId: queuedRunId }).where(eq(issues.id, f.issueId));
    const reply = await message(f.conversationId);

    const result = await admitWake(chatContext(f.conversationId, reply), { id: queuedRunId, agentId: f.agentId,
      status: "queued", contextSnapshot: runContext, wakeupRequestId: savedId });

    expect(result).toEqual({ kind: "deferred" });
    const [queuedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queuedRunId));
    expect(queuedRun!.contextSnapshot).toMatchObject({ wakeCommentIds: [earlier], source: "issue.comment" });
    expect((await deferredWakes()).map(wake => wake.commentIds)).toEqual([[reply]]);
  });

  it("still folds a same-conversation message into a queued run", async () => {
    deferOnly = false;
    const earlier = await message(f.conversationId);
    const savedId = await saveUndelivered([earlier]);
    const queuedRunId = randomUUID();
    const [savedWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, savedId));
    const runContext = (savedWake!.payload as Record<string, Record<string, unknown>>)[CONTEXT_KEY]!;
    await db.insert(heartbeatRuns).values({ id: queuedRunId, companyId: f.companyId, agentId: f.agentId, status: "queued",
      invocationSource: "automation", triggerDetail: "system", wakeupRequestId: savedId, contextSnapshot: runContext });
    await db.update(agentWakeupRequests).set({ status: "queued", runId: queuedRunId }).where(eq(agentWakeupRequests.id, savedId));
    await db.update(issues).set({ executionRunId: queuedRunId }).where(eq(issues.id, f.issueId));
    const reply = await message(f.conversationId);

    const result = await admitWake(chatContext(f.conversationId, reply), { id: queuedRunId, agentId: f.agentId,
      status: "queued", contextSnapshot: runContext, wakeupRequestId: savedId });

    expect(result.kind).toBe("coalesced");
    const [queuedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queuedRunId));
    expect(queuedRun!.contextSnapshot).toMatchObject({ wakeCommentIds: [earlier, reply], chatConversationId: f.conversationId });
  });

  function releaseIssue() {
    return createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, {
        resolveResponsibleUserId: async () => f.userId,
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
        resolveSessionBeforeForWakeup: async () => null,
      } as never),
      recovery: { escalateStrandedAssignedIssue: async () => {}, escalateStrandedRecoveryIssueInPlace: async () => {} } as never,
    });
  }

  // An older merged wake can be left with only the other conversation's
  // messages (its own message was discarded). An interrupt names the wake by
  // id, so the wake keeps its id and runs as plain saved messages.
  it("keeps an interrupted wake's id when all of its messages belong to another conversation", async () => {
    const earlier = await message(otherConversationId);
    const savedId = await saveUndelivered([earlier]);
    const [savedWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, savedId));
    const payload = savedWake!.payload as Record<string, unknown>;
    await db.update(agentWakeupRequests).set({ payload: { ...payload, mutation: "chat_message_received",
      [CONTEXT_KEY]: { ...(payload[CONTEXT_KEY] as Record<string, unknown>), source: "chat:slack",
        wakeReason: "External chat message received", chatConversationId: f.conversationId } } })
      .where(eq(agentWakeupRequests.id, savedId));
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(),
      resultJson: { queuedCommentInterruptQueueId: savedId, executionCancellation: { state: "acknowledged" },
        conversationContinuation: "continue_conversation_v1" } })
      .where(eq(heartbeatRuns.id, f.runId));

    const result = await releaseIssue()({ companyId: f.companyId, runId: f.runId, now: new Date() });

    expect(result.outcome.kind).toBe("promoted");
    const promoted = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      eq(heartbeatRuns.status, "queued")));
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.wakeupRequestId).toBe(savedId);
    expect(promoted[0]!.contextSnapshot).toMatchObject({ wakeCommentIds: [earlier], source: "issue.comment" });
    expect(promoted[0]!.contextSnapshot?.chatConversationId).toBeUndefined();
    expect(await deferredWakes()).toEqual([]);
  });

  // A wake that older code already merged across two conversations. Release
  // splits it: the other conversation's messages run first as plain saved
  // messages, then the recorded conversation runs with its own messages.
  it("splits a saved wake that older code merged across two conversations", async () => {
    const earlier = await message(otherConversationId);
    const savedId = await saveUndelivered([earlier]);
    const reply = await message(f.conversationId);
    const [savedWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, savedId));
    const payload = savedWake!.payload as Record<string, unknown>;
    const merged = mergeCoalescedContextSnapshot(payload[CONTEXT_KEY], chatContext(f.conversationId, reply));
    await db.update(agentWakeupRequests).set({ payload: { ...payload, mutation: "chat_message_received",
      commentId: reply, wakeCommentId: reply, [CONTEXT_KEY]: merged } }).where(eq(agentWakeupRequests.id, savedId));
    expect(merged).toMatchObject({ wakeCommentIds: [earlier, reply], chatConversationId: f.conversationId });
    // This is the shape that failed on staging.
    await expect(attest(merged)).rejects.toThrow("paperclip_runner_chat_attachment_binding_denied");

    const release = releaseIssue();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    const first = await release({ companyId: f.companyId, runId: f.runId, now: new Date() });
    expect(first.outcome.kind).toBe("promoted");

    const promoted = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      eq(heartbeatRuns.status, "queued")));
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.contextSnapshot).toMatchObject({ wakeCommentIds: [earlier], source: "issue.comment" });
    expect(promoted[0]!.contextSnapshot?.chatConversationId).toBeUndefined();
    const waiting = await deferredWakes();
    expect(waiting).toEqual([expect.objectContaining({ id: savedId, commentIds: [reply] })]);
    await expect(attest(waiting[0]!.context)).resolves.toMatchObject({ conversationId: f.conversationId });
  });
});
