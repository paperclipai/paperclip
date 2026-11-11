import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  closeRegisteredClients,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { AgentDirectoryOperationBusyError } from "../services/agent-directory-working-copies.js";
import { AGENT_DIRECTORY_BUSY_ERROR_CODE, AGENT_DIRECTORY_BUSY_RETRY_REASON } from "../services/heartbeat/agent-directory-busy.js";
import { undeliveredLegacyUserCommentIds } from "../services/explicit-native-continuation.js";
import { isResolvedInteractionContinuationWakeContext } from "../modules/run-dispatch/index.js";

const busyPrepares = vi.hoisted(() => ({ remaining: 0, calls: 0, beforeBusy: null as null | (() => Promise<void>) }));
vi.mock("../services/agent-instruction-working-copies.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/agent-instruction-working-copies.js")>();
  return {
    ...actual,
    agentInstructionWorkingCopyService: (...args: Parameters<typeof actual.agentInstructionWorkingCopyService>) => {
      const service = actual.agentInstructionWorkingCopyService(...args);
      return {
        ...service,
        prepare: async (input: Parameters<typeof service.prepare>[0]) => {
          busyPrepares.calls++;
          if (busyPrepares.remaining > 0) {
            busyPrepares.remaining--;
            await busyPrepares.beforeBusy?.();
            throw new AgentDirectoryOperationBusyError();
          }
          return service.prepare(input);
        },
      };
    },
  };
});

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const support = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
const ADAPTER = "agent_directory_busy_test";

describeEmbeddedPostgres("a new run that meets a busy agent directory", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const executedRunIds: string[] = [];
  const executedContexts = new Map<string, Record<string, unknown>>();

  beforeAll(async () => {
    if (externalTestDatabaseUrl) db = createDb(externalTestDatabaseUrl);
    else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-agent-directory-busy-");
      db = createDb(tempDb.connectionString);
    }
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: ADAPTER,
      supportsInstructionsBundle: true,
      execute: async input => {
        executedRunIds.push(input.runId);
        executedContexts.set(input.runId, input.context as Record<string, unknown>);
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType: ADAPTER, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 20_000);

  afterAll(async () => {
    unregisterServerAdapter(ADAPTER);
    if (externalTestDatabaseUrl) await closeRegisteredClients(externalTestDatabaseUrl);
    await db.$client.end();
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID(), agentId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "busy-directory-user" });
    await db.insert(authUsers).values({ id: "busy-directory-user", name: "Responsible user", email: "busy-directory@example.test",
      createdAt: now, updatedAt: now }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "busy-directory-user",
      status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "BusyCoder", role: "engineer", status: "idle", adapterType: ADAPTER,
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    return { companyId, agentId };
  }

  it("keeps a user's continuation when its run waits for a busy agent directory", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID(), runId = randomUUID(), wakeupRequestId = randomUUID(), sourceRunId = randomUUID(), commentId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, status: "failed",
      createdAt: new Date("2020-01-01T00:00:00Z"), finishedAt: new Date("2020-01-01T00:00:01Z"), contextSnapshot: { issueId } });
    await db.insert(agentWakeupRequests).values({ id: wakeupRequestId, companyId, agentId, source: "automation", triggerDetail: "system",
      reason: "issue_commented", payload: { issueId, commentId }, status: "queued", runId, requestedByActorType: "user",
      requestedByActorId: "busy-directory-user" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "automation", triggerDetail: "system",
      status: "queued", wakeupRequestId, contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented", wakeCommentId: commentId,
        previousRunId: sourceRunId, explicitUserContinuation: { previousRunId: sourceRunId, commentId } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue repair", status: "in_progress", priority: "medium",
      responsibleUserId: "busy-directory-user", assigneeAgentId: agentId, checkoutRunId: runId, executionRunId: runId, issueNumber: 2 });
    await db.update(heartbeatRuns).set({ scopeKind: "issue", issueId }).where(eq(heartbeatRuns.id, runId));
    const [comment] = await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorType: "user",
      authorUserId: "busy-directory-user", body: "Continue the task." }).returning();
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "legacy_execution_requires_reconciliation", fingerprint: sourceRunId, status: "resolved", outcome: "cancelled",
      nextAction: "User continued.", evidence: { explicitUserContinuation: { runId, previousRunId: sourceRunId, commentId,
        actorId: "busy-directory-user", recordedAt: new Date().toISOString(), commentUpdatedAt: comment!.updatedAt.toISOString(),
        commentBodyHash: createHash("sha256").update(comment!.body).digest("hex") } } });
    busyPrepares.remaining = 1;
    busyPrepares.calls = 0;

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect(await heartbeat.getRun(runId)).toMatchObject({ status: "cancelled", errorCode: AGENT_DIRECTORY_BUSY_ERROR_CODE });
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
    expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: AGENT_DIRECTORY_BUSY_RETRY_REASON,
      contextSnapshot: { wakeReason: "issue_commented", previousRunId: runId, wakeCommentId: commentId,
        explicitUserContinuation: { previousRunId: runId, commentId } } });
    const afterDue = new Date(new Date(retry!.scheduledRetryAt!).getTime() + 1_000);
    expect((await heartbeat.promoteDueScheduledRetries(afterDue)).runIds).toContain(retry!.id);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect((await heartbeat.getRun(retry!.id))?.status).toBe("succeeded");
    expect(executedContexts.get(retry!.id)).toMatchObject({ wakeCommentId: commentId,
      explicitUserContinuation: { previousRunId: runId, commentId } });
  });

  it("keeps a user comment undelivered when the run that carried it only waited for agent files", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID(), runId = randomUUID(), commentId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Message during a wait", status: "in_progress", priority: "medium",
      responsibleUserId: "busy-directory-user", assigneeAgentId: agentId, issueNumber: 3 });
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorType: "user",
      authorUserId: "busy-directory-user", body: "Please also check the logs." });
    const now = new Date();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "cancelled", runtimeMode: "legacy",
      startedAt: now, finishedAt: now, errorCode: AGENT_DIRECTORY_BUSY_ERROR_CODE,
      contextSnapshot: { issueId, wakeReason: "issue_commented", wakeCommentId: commentId },
      resultJson: { executionRecovery: { kind: "agent_directory_wait", providerWorkStarted: false },
        cancellation: { source: "control_plane", expected: true, initiator: { type: "system" },
          reason: "Waiting for another run of this agent to finish with its files", recordedAt: now.toISOString() } } });
    expect(await undeliveredLegacyUserCommentIds(db, companyId, issueId, agentId, [commentId])).toEqual([commentId]);
    await db.update(heartbeatRuns).set({ errorCode: "operator_cancelled",
      resultJson: { cancellation: { source: "operator", expected: true } } }).where(eq(heartbeatRuns.id, runId));
    expect(await undeliveredLegacyUserCommentIds(db, companyId, issueId, agentId, [commentId])).toEqual([]);
  });

  it.each(["parked", "reassigned"] as const)("keeps an accepted interaction continuation's gates across a directory wait: %s", async change => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId, name: "OtherCoder", role: "engineer", status: "idle", adapterType: ADAPTER,
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    const issueId = randomUUID(), runId = randomUUID(), wakeupRequestId = randomUUID(), interactionId = randomUUID();
    const context = { issueId, taskId: issueId, wakeReason: "issue_commented", mutation: "interaction", interactionId,
      interactionKind: "request_confirmation", interactionStatus: "accepted" };
    await db.insert(agentWakeupRequests).values({ id: wakeupRequestId, companyId, agentId, source: "automation", triggerDetail: "system",
      reason: "issue_commented", payload: { issueId }, status: "queued", runId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "automation", triggerDetail: "system",
      status: "queued", wakeupRequestId, contextSnapshot: context });
    await db.insert(issues).values({ id: issueId, companyId, title: "Approved plan", status: "in_progress", priority: "medium",
      responsibleUserId: "busy-directory-user", assigneeAgentId: agentId, executionRunId: runId, issueNumber: 4 });
    await db.update(heartbeatRuns).set({ scopeKind: "issue", issueId }).where(eq(heartbeatRuns.id, runId));
    busyPrepares.remaining = 1;
    busyPrepares.calls = 0;

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect(await heartbeat.getRun(runId)).toMatchObject({ status: "cancelled", errorCode: AGENT_DIRECTORY_BUSY_ERROR_CODE });
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
    expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: AGENT_DIRECTORY_BUSY_RETRY_REASON,
      contextSnapshot: { mutation: "interaction", interactionId, interactionKind: "request_confirmation", interactionStatus: "accepted" } });
    expect(isResolvedInteractionContinuationWakeContext(retry!.contextSnapshot)).toBe(true);

    if (change === "parked") await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
    else await db.update(issues).set({ assigneeAgentId: otherAgentId }).where(eq(issues.id, issueId));
    const afterDue = new Date(new Date(retry!.scheduledRetryAt!).getTime() + 1_000);
    await heartbeat.promoteDueScheduledRetries(afterDue);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect((await heartbeat.getRun(retry!.id))?.status).not.toBe("succeeded");
    expect(executedRunIds).not.toContain(retry!.id);
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(task!.status).toBe(change === "parked" ? "todo" : "in_progress");
    expect(task!.assigneeAgentId).toBe(change === "parked" ? agentId : otherAgentId);
  });

  it("keeps an accepted non-assignee mention through a directory wait and runs it once files are free", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const assigneeId = randomUUID(), issueId = randomUUID();
    await db.insert(agents).values({ id: assigneeId, companyId, name: "AssigneeCoder", role: "engineer", status: "idle", adapterType: ADAPTER,
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Shared review", status: "in_progress", priority: "medium",
      responsibleUserId: "busy-directory-user", assigneeAgentId: assigneeId, issueNumber: 5 });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "on_demand", status: "queued",
      responsibleUserId: "busy-directory-user",
      contextSnapshot: { issueId, wakeReason: "issue_comment_mentioned", commentId: randomUUID() } }).returning();
    busyPrepares.remaining = 1;
    busyPrepares.calls = 0;

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect(await heartbeat.getRun(run!.id)).toMatchObject({ status: "cancelled", errorCode: AGENT_DIRECTORY_BUSY_ERROR_CODE });
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id));
    expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: AGENT_DIRECTORY_BUSY_RETRY_REASON,
      contextSnapshot: { wakeReason: "issue_comment_mentioned", preparationWait: { kind: AGENT_DIRECTORY_BUSY_RETRY_REASON, attempt: 1 } } });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.assigneeAgentId).toBe(assigneeId);

    const afterDue = new Date(new Date(retry!.scheduledRetryAt!).getTime() + 1_000);
    expect((await heartbeat.promoteDueScheduledRetries(afterDue)).runIds).toContain(retry!.id);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect((await heartbeat.getRun(retry!.id))?.status).toBe("succeeded");
    expect(executedRunIds).toContain(retry!.id);
  });

  it("does not let the previous assignee restart after the task is reassigned during preparation", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const newOwnerId = randomUUID(), issueId = randomUUID();
    await db.insert(agents).values({ id: newOwnerId, companyId, name: "NewOwner", role: "engineer", status: "idle", adapterType: ADAPTER,
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: false, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Handed over", status: "in_progress", priority: "medium",
      responsibleUserId: "busy-directory-user", assigneeAgentId: agentId, issueNumber: 6 });
    busyPrepares.remaining = 1;
    busyPrepares.calls = 0;
    busyPrepares.beforeBusy = async () => {
      await db.update(issues).set({ assigneeAgentId: newOwnerId }).where(eq(issues.id, issueId));
    };
    try {
      const run = await heartbeat.invoke(agentId, "assignment", { issueId, wakeReason: "issue_assigned" }, "system");
      await heartbeat.drainActiveRunExecutions();
      expect(await heartbeat.getRun(run!.id)).toMatchObject({ status: "cancelled", errorCode: AGENT_DIRECTORY_BUSY_ERROR_CODE });
      const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id));
      if (retry) {
        expect(retry.contextSnapshot).toMatchObject({ wakeReason: "issue_assigned", preparationWait: { kind: AGENT_DIRECTORY_BUSY_RETRY_REASON } });
        const afterDue = new Date(new Date(retry.scheduledRetryAt!).getTime() + 1_000);
        await heartbeat.promoteDueScheduledRetries(afterDue);
        await heartbeat.resumeQueuedRuns();
        await heartbeat.drainActiveRunExecutions();
        expect((await heartbeat.getRun(retry.id))?.status).toBe("cancelled");
        expect(executedRunIds).not.toContain(retry.id);
      }
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.assigneeAgentId).toBe(newOwnerId);
    } finally {
      busyPrepares.beforeBusy = null;
    }
  });

  it("answers a plain comment on a dependency-blocked task after a directory wait, as it would without one", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const blockerId = randomUUID(), issueId = randomUUID(), commentId = randomUUID();
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Prerequisite", status: "todo", priority: "medium", responsibleUserId: "busy-directory-user", issueNumber: 7 },
      { id: issueId, companyId, title: "Waits on prerequisite", status: "todo", priority: "medium", responsibleUserId: "busy-directory-user",
        assigneeAgentId: agentId, issueNumber: 8 },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorType: "user", authorUserId: "busy-directory-user",
      body: "What is this waiting on?" });
    busyPrepares.remaining = 1;
    busyPrepares.calls = 0;

    const run = await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId, commentId }, contextSnapshot: { issueId, wakeReason: "issue_commented" } });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();

    expect(await heartbeat.getRun(run!.id)).toMatchObject({ status: "cancelled", errorCode: AGENT_DIRECTORY_BUSY_ERROR_CODE });
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id));
    expect(retry).toMatchObject({ status: "scheduled_retry", contextSnapshot: { wakeReason: "issue_commented",
      preparationWait: { kind: AGENT_DIRECTORY_BUSY_RETRY_REASON, attempt: 1 } } });
    const afterDue = new Date(new Date(retry!.scheduledRetryAt!).getTime() + 1_000);
    expect((await heartbeat.promoteDueScheduledRetries(afterDue)).runIds).toContain(retry!.id);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect(await heartbeat.getRun(retry!.id)).toMatchObject({ status: "succeeded",
      contextSnapshot: { dependencyBlockedInteraction: true, unresolvedBlockerIssueIds: [blockerId] } });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.status).toBe("todo");
  });

  it("defers the first run of a task instead of failing it, then runs it", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Daily repair", status: "in_progress", priority: "medium",
      responsibleUserId: "busy-directory-user", assigneeAgentId: agentId, issueNumber: 1 });
    busyPrepares.remaining = 1;
    busyPrepares.calls = 0;

    const run = await heartbeat.invoke(agentId, "assignment", { issueId, wakeReason: "issue_assigned" }, "system");
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();

    const first = await heartbeat.getRun(run!.id);
    expect(first).toMatchObject({ status: "cancelled", errorCode: AGENT_DIRECTORY_BUSY_ERROR_CODE });
    expect(busyPrepares.calls).toBe(1);
    expect(executedRunIds).not.toContain(run!.id);
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id));
    expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: AGENT_DIRECTORY_BUSY_RETRY_REASON, scheduledRetryAttempt: 1,
      contextSnapshot: { wakeReason: "issue_assigned", preparationWait: { kind: AGENT_DIRECTORY_BUSY_RETRY_REASON, attempt: 1 } } });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ status: "in_progress", executionRunId: retry!.id });

    const afterDue = new Date(new Date(retry!.scheduledRetryAt!).getTime() + 1_000);
    expect((await heartbeat.promoteDueScheduledRetries(afterDue)).runIds).toContain(retry!.id);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect((await heartbeat.getRun(retry!.id))?.status).toBe("succeeded");
    expect(executedRunIds).toContain(retry!.id);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issueId)))
      .filter(row => row.status === "failed")).toEqual([]);
  });
});
