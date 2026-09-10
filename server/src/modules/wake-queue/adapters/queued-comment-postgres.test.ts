import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { activityLog, agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { queuedCommentIdsFromWakePayload } from "../../../services/issue-queued-comment-queue.js";
import { createQueuedCommentIssueLockWriter } from "./queued-comment-postgres.js";
import type { QueuedCommentQueuePostgresAdapterDeps } from "./queued-comment-postgres.js";
import { QueuedCommentMutationError } from "../application/queued-comment-use-cases.js";

// The steering mutation delivers through the live native-runtime transport.
// This mock stands in for that transport, so the test proves the module's
// own read/write behavior without a live provider connection. The steering
// mutation also asks the same transport for the live steering state right
// after a successful steer, so it can answer with the authoritative
// disposition instead of the static "temporarily_unavailable" fallback.
const steerNativeSessionMock = vi.hoisted(() => vi.fn());
const getNativeSessionSteeringStateMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/native-runtime/native-session-executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/native-runtime/native-session-executor.js")>();
  steerNativeSessionMock.mockImplementation(actual.steerNativeSession);
  getNativeSessionSteeringStateMock.mockImplementation(actual.getNativeSessionSteeringState);
  return {
    ...actual,
    steerNativeSession: steerNativeSessionMock,
    getNativeSessionSteeringState: getNativeSessionSteeringStateMock,
  };
});

// Proves the same two properties the release-half adapter test proves for
// this module's other transaction: the one company the caller names in
// `issue.companyId` binds every read and write for the whole transaction, so
// a caller-supplied `issue`/`wake` for the wrong company sees nothing, and a
// guarded write that affects no row rolls the transaction back instead of
// leaving a partial write. The decision branching itself is proven against
// plain facts in `domain/policy.test.ts`; the use-case orchestration is
// proven against a mocked port in `application/queued-comment-use-cases.test.ts`.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres queued-comment adapter tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("queued-comment postgres adapter", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const noopDeps: QueuedCommentQueuePostgresAdapterDeps = {
    syncCommentReferences: async () => {},
    deleteCommentReferenceSource: async () => {},
    syncCommentExternalObjectsSafely: async () => {},
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-queued-comment-postgres-adapter-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // Deleted first: activity_log rows reference companies, agents, and
    // heartbeat_runs, and none of those foreign keys cascade.
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  async function seedAgent(input: { companyId: string; adapterType?: string }): Promise<string> {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: input.companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: input.adapterType ?? "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return agentId;
  }

  async function seedIssue(input: { companyId: string; assigneeAgentId: string | null }): Promise<string> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Queued-comment adapter fixture issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId,
    });
    return issueId;
  }

  async function seedComment(input: { companyId: string; issueId: string; authorUserId: string }): Promise<string> {
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId,
      companyId: input.companyId,
      issueId: input.issueId,
      authorUserId: input.authorUserId,
      body: "queued message",
    });
    return commentId;
  }

  async function seedDeferredWake(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    commentIds: string[];
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "automation",
      reason: "issue_commented",
      status: "deferred_issue_execution",
      requestedByActorType: "user",
      payload: {
        issueId: input.issueId,
        _paperclipWakeContext: { wakeCommentIds: input.commentIds },
      },
    });
    return id;
  }

  async function seedRunningNativeRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    resultJson?: Record<string, unknown>;
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      status: "running",
      runtimeMode: "native",
      contextSnapshot: { issueId: input.issueId },
      resultJson: input.resultJson ?? {},
    });
    return id;
  }

  it("scopes the wake lookup to its own company: a foreign-company issue context resolves not_pending and deletes nothing", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const commentId = await seedComment({ companyId, issueId, authorUserId: "user-1" });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId, commentIds: [commentId] });

    const issueLock = createQueuedCommentIssueLockWriter(db, noopDeps);
    await expect(
      issueLock.withLockedQueue(
        {
          // The caller mistakenly names the *other* company on the issue
          // context; that single value binds every read and write for the
          // whole transaction, so it alone must decide what is visible.
          issue: { id: issueId, companyId: otherCompanyId, assigneeAgentId: agentId, executionRunId: null },
          actor: { actorType: "user", actorId: "user-1", agentId: null, runId: null, agentApiKeyId: null },
          queueId: wakeId,
        },
        async () => {
          throw new Error("fn must not run when the wake is invisible to the caller's company");
        },
      ),
    ).rejects.toMatchObject({ code: "queued_comment_not_pending" });

    const commentRow = (await db.select().from(issueComments).where(eq(issueComments.id, commentId)))[0];
    expect(commentRow?.deletedAt ?? null).toBeNull();
    const wakeRow = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0];
    expect(wakeRow?.status).toBe("deferred_issue_execution");
  });

  it("rolls back a discard when the comment id given belongs to a different issue than the one this transaction locked", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const otherIssueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const commentId = await seedComment({ companyId, issueId: otherIssueId, authorUserId: "user-1" });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId, commentIds: [commentId] });

    const issueLock = createQueuedCommentIssueLockWriter(db, noopDeps);
    await expect(
      issueLock.withLockedQueue(
        {
          issue: { id: issueId, companyId, assigneeAgentId: agentId, executionRunId: null },
          actor: { actorType: "user", actorId: "user-1", agentId: null, runId: null, agentApiKeyId: null },
          queueId: wakeId,
        },
        async (_locked, transaction) => {
          // The comment belongs to a different issue than the one this
          // transaction locked. The write's own `issueId` predicate, not
          // just the bound company, must decide what is visible.
          const deleted = await transaction.deleteComment({ issueId, commentId });
          if (!deleted) {
            throw new QueuedCommentMutationError("queued_comment_not_pending", "The queued message is no longer pending");
          }
          return deleted;
        },
      ),
    ).rejects.toMatchObject({ code: "queued_comment_not_pending" });

    const commentRow = (await db.select().from(issueComments).where(eq(issueComments.id, commentId)))[0];
    expect(commentRow).toBeDefined();
    expect(commentRow?.deletedAt ?? null).toBeNull();
  });

  it("edits the comment body, syncs references, and rebuilds the queue snapshot inside one company-scoped transaction", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const commentId = await seedComment({ companyId, issueId, authorUserId: "user-1" });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId, commentIds: [commentId] });

    let syncedCommentId: string | null = null;
    const deps: QueuedCommentQueuePostgresAdapterDeps = {
      ...noopDeps,
      syncCommentReferences: async (id) => {
        syncedCommentId = id;
      },
    };
    const issueLock = createQueuedCommentIssueLockWriter(db, deps);

    const queue = await issueLock.withLockedQueue(
      {
        issue: { id: issueId, companyId, assigneeAgentId: agentId, executionRunId: null },
        actor: { actorType: "user", actorId: "user-1", agentId: null, runId: null, agentApiKeyId: null },
        queueId: wakeId,
      },
      async (locked, transaction) => {
        expect(locked.state).toBe("deferred");
        const updated = await transaction.updateCommentBody({
          issueId,
          commentId,
          body: "edited body",
          updatedAt: new Date(),
        });
        expect(updated).toBe(true);
        await transaction.syncCommentReferences(commentId);
        return transaction.buildQueueSnapshot({
          issue: { id: issueId, companyId, assigneeAgentId: agentId, executionRunId: null },
          actor: { actorType: "user", actorId: "user-1", agentId: null, runId: null, agentApiKeyId: null },
          wake: locked.wake,
          state: locked.state,
          queueRun: locked.queueRun,
          activeRun: locked.activeRun,
        });
      },
    );

    expect(syncedCommentId).toBe(commentId);
    expect(queue.entries).toHaveLength(1);
    expect((queue.entries[0]!.comment as { body: string }).body).toBe("edited body");
    const commentRow = (await db.select().from(issueComments).where(eq(issueComments.id, commentId)))[0];
    expect(commentRow?.body).toBe("edited body");
  });

  it("rolls back an already-applied comment edit when its own activity insert fails", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const commentId = await seedComment({ companyId, issueId, authorUserId: "user-1" });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId, commentIds: [commentId] });

    const issueLock = createQueuedCommentIssueLockWriter(db, noopDeps);
    const missingAgentId = randomUUID();

    await expect(
      issueLock.withLockedQueue(
        {
          issue: { id: issueId, companyId, assigneeAgentId: agentId, executionRunId: null },
          actor: { actorType: "user", actorId: "user-1", agentId: null, runId: null, agentApiKeyId: null },
          queueId: wakeId,
        },
        async (_locked, transaction) => {
          await transaction.updateCommentBody({
            issueId,
            commentId,
            body: "edited body",
            updatedAt: new Date(),
          });
          // `agentId` carries a foreign key to `agents.id`; naming an agent
          // that was never seeded forces the activity insert to fail, which
          // must roll back the comment edit issued moments earlier on the
          // same transaction.
          await transaction.logActivity({
            actorType: "agent",
            actorId: missingAgentId,
            agentId: missingAgentId,
            runId: null,
            agentApiKeyId: null,
            action: "issue.queued_comment_edited",
            entityId: issueId,
            details: {},
          });
        },
      ),
    ).rejects.toMatchObject({ cause: { code: "23503" } });

    const commentRow = (await db.select().from(issueComments).where(eq(issueComments.id, commentId)))[0];
    expect(commentRow?.body).toBe("queued message");
    const activityRows = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(activityRows).toHaveLength(0);
  });

  // Pins a fact the database itself cannot persist today: `runtime_mode` is
  // a NOT NULL column, so a real active run's own field is never null. The
  // port type allows it (`runtimeMode: string | null`), so this test builds
  // the fact directly instead of through a database row, to keep this
  // branch of the shared steering rule under a regression test.
  it("answers the steering question for a deferred paperclip_runner queue whose active run has no persisted runtime mode yet", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId, adapterType: "paperclip_runner" });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const commentId = await seedComment({ companyId, issueId, authorUserId: "user-1" });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId, commentIds: [commentId] });

    const issueLock = createQueuedCommentIssueLockWriter(db, noopDeps);
    const queue = await issueLock.withLockedQueue(
      {
        issue: { id: issueId, companyId, assigneeAgentId: agentId, executionRunId: null },
        actor: { actorType: "user", actorId: "user-1", agentId: null, runId: null, agentApiKeyId: null },
        queueId: wakeId,
      },
      async (locked, transaction) => {
        expect(locked.state).toBe("deferred");
        return transaction.buildQueueSnapshot({
          issue: { id: issueId, companyId, assigneeAgentId: agentId, executionRunId: null },
          actor: { actorType: "user", actorId: "user-1", agentId: null, runId: null, agentApiKeyId: null },
          wake: locked.wake,
          state: "deferred",
          queueRun: null,
          activeRun: { id: randomUUID(), status: "running", runtimeMode: null, contextSnapshot: {} },
        });
      },
    );

    expect(queue.protocol).toBe("paperclip_runner_v1");
    expect(queue.steeringDisposition).toBe("temporarily_unavailable");
  });

  it("scopes the steering mutation to its own company: a foreign-company issue context resolves not_pending and writes nothing", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const commentId = await seedComment({ companyId, issueId, authorUserId: "user-1" });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId, commentIds: [commentId] });
    const targetRunId = await seedRunningNativeRun({ companyId, agentId, issueId, resultJson: { seeded: true } });

    const issueLock = createQueuedCommentIssueLockWriter(db, noopDeps);
    await expect(
      issueLock.steerQueuedWakeComment({
        // The caller mistakenly names the *other* company on the issue
        // context; that single value binds every read and write for the
        // whole transaction, so it alone must decide what is visible.
        issue: { id: issueId, companyId: otherCompanyId, assigneeAgentId: agentId, executionRunId: null },
        actor: { actorType: "user", actorId: "user-1", agentId: null, runId: null, agentApiKeyId: null },
        commentId,
        queueId: wakeId,
        targetRunId,
        revision: "unused-the-company-scope-rejects-before-any-revision-check",
      }),
    ).rejects.toMatchObject({ code: "queued_comment_not_pending" });

    const wakeRow = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0];
    expect(wakeRow?.status).toBe("deferred_issue_execution");
    expect(queuedCommentIdsFromWakePayload(wakeRow?.payload)).toEqual([commentId]);

    const runRow = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, targetRunId)))[0];
    expect(runRow?.resultJson).toEqual({ seeded: true });
  });

  it("answers a queue mutation's own steering question with temporarily_unavailable, matching the shared rule for a caller that never probes the live provider", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const commentId = await seedComment({ companyId, issueId, authorUserId: "user-1" });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId, commentIds: [commentId] });

    const issueLock = createQueuedCommentIssueLockWriter(db, noopDeps);
    const queue = await issueLock.withLockedQueue(
      {
        issue: { id: issueId, companyId, assigneeAgentId: agentId, executionRunId: null },
        actor: { actorType: "user", actorId: "user-1", agentId: null, runId: null, agentApiKeyId: null },
        queueId: wakeId,
      },
      async (locked, transaction) => {
        // An edit never delivers same-turn steering itself, so it must never
        // probe the live provider for the answer, unlike the steer mutation
        // below.
        return transaction.buildQueueSnapshot({
          issue: { id: issueId, companyId, assigneeAgentId: agentId, executionRunId: null },
          actor: { actorType: "user", actorId: "user-1", agentId: null, runId: null, agentApiKeyId: null },
          wake: locked.wake,
          state: locked.state,
          queueRun: locked.queueRun,
          activeRun: { id: randomUUID(), status: "running", runtimeMode: "native", contextSnapshot: {} },
        });
      },
    );

    expect(queue.protocol).toBe("paperclip_runner_v1");
    expect(queue.steeringDisposition).toBe("temporarily_unavailable");
    expect(getNativeSessionSteeringStateMock).not.toHaveBeenCalled();
  });

  it("reports the live steering disposition after a successful steer leaves more messages queued", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId, adapterType: "paperclip_runner" });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const firstCommentId = await seedComment({ companyId, issueId, authorUserId: "user-1" });
    const secondCommentId = await seedComment({ companyId, issueId, authorUserId: "user-1" });
    const wakeId = await seedDeferredWake({
      companyId,
      agentId,
      issueId,
      commentIds: [firstCommentId, secondCommentId],
    });
    const targetRunId = await seedRunningNativeRun({ companyId, agentId, issueId });

    steerNativeSessionMock.mockResolvedValueOnce({ turnId: "turn-1" });
    // The live provider still has an active turn to steer, since the second
    // queued message has not been delivered yet.
    getNativeSessionSteeringStateMock.mockResolvedValueOnce({ disposition: "available", activeTurnId: "turn-1" });

    const issueLock = createQueuedCommentIssueLockWriter(db, noopDeps);
    const peeked = await issueLock.withLockedQueue(
      {
        issue: { id: issueId, companyId, assigneeAgentId: agentId, executionRunId: null },
        actor: { actorType: "user", actorId: "user-1", agentId: null, runId: null, agentApiKeyId: null },
        queueId: wakeId,
      },
      async (locked) => locked.queue,
    );

    const result = await issueLock.steerQueuedWakeComment({
      issue: { id: issueId, companyId, assigneeAgentId: agentId, executionRunId: null },
      actor: { actorType: "user", actorId: "user-1", agentId: null, runId: null, agentApiKeyId: null },
      commentId: firstCommentId,
      queueId: wakeId,
      targetRunId,
      revision: peeked.revision,
    });

    expect(result.queue.entries).toHaveLength(1);
    expect(result.queue.entries[0]!.comment.id).toBe(secondCommentId);
    // The steer just delivered a message, so it must ask the live provider
    // for the real answer instead of falling back to
    // "temporarily_unavailable" and leaving the next steering action
    // disabled until an unrelated read refreshes the state.
    expect(result.queue.steeringDisposition).toBe("available");
    expect(getNativeSessionSteeringStateMock).toHaveBeenCalledWith(targetRunId);

    // A second, consecutive steer on the same run must keep reporting the
    // live disposition, not the stale value from the first steer.
    getNativeSessionSteeringStateMock.mockResolvedValueOnce({ disposition: "temporarily_unavailable", activeTurnId: null });
    steerNativeSessionMock.mockResolvedValueOnce({ turnId: "turn-2" });
    const second = await issueLock.steerQueuedWakeComment({
      issue: { id: issueId, companyId, assigneeAgentId: agentId, executionRunId: null },
      actor: { actorType: "user", actorId: "user-1", agentId: null, runId: null, agentApiKeyId: null },
      commentId: secondCommentId,
      queueId: wakeId,
      targetRunId,
      revision: result.queue.revision,
    });

    // The queue is now empty, so the wake is cancelled and no run remains to
    // probe -- the shared rule answers "temporarily_unavailable" directly,
    // without a live call.
    expect(second.queue.entries).toHaveLength(0);
    expect(second.queue.steeringDisposition).toBe("temporarily_unavailable");
  });
});
