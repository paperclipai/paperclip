import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { createPostgresWakeQueueAdapter } from "./postgres.js";
import type { WakeQueuePostgresAdapterDeps } from "./postgres.js";
import { createReleaseIssueExecution } from "../application/use-cases.js";

// The release drain promotes at most one deferred wake, oldest first. A wake
// of an agent that no longer owns the issue would be cancelled at dispatch as
// `issue_assignee_changed`, so the drain cancels it and promotes the current
// owner's wake behind it. Wakes with a dispatch ownership bypass keep their
// place. The adapter's other release behaviour is covered in `postgres.test.ts`.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wake-queue former owner drain tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("wake-queue drain of former owner wakes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const stubDeps: WakeQueuePostgresAdapterDeps = {
    resolveResponsibleUserId: async () => "responsible-user",
    getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
    resolveSessionBeforeForWakeup: async () => null,
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-queue-former-owner-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    // `heartbeat_runs.wakeup_request_id` references `agent_wakeup_requests.id`,
    // so the run row must go first.
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRecoveryActions);
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

  async function seedAgent(companyId: string, name: string): Promise<string> {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return agentId;
  }

  // The issue as a worker leaves it when it hands over to its review stage.
  async function seedIssueInReview(input: { companyId: string; workerId: string; reviewerId: string }) {
    const [issue] = await db.insert(issues).values({
      companyId: input.companyId,
      title: "Wake-queue former owner fixture issue",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: input.reviewerId,
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: input.reviewerId },
        returnAssignee: { type: "agent", agentId: input.workerId },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).returning();
    return issue!.id;
  }

  async function seedFinishedRun(companyId: string, agentId: string, issueId: string): Promise<string> {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "succeeded",
      contextSnapshot: { issueId },
    });
    return runId;
  }

  async function seedDeferredWake(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    reason: string;
    requestedAt: Date;
    payload?: Record<string, unknown>;
    context: Record<string, unknown>;
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "automation",
      reason: input.reason,
      status: "deferred_issue_execution",
      requestedByActorType: "agent",
      requestedByActorId: null,
      requestedAt: input.requestedAt,
      payload: {
        issueId: input.issueId,
        ...(input.payload ?? {}),
        _paperclipWakeContext: { issueId: input.issueId, taskId: input.issueId, ...input.context },
      },
    });
    return id;
  }

  function release(companyId: string, runId: string) {
    return createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, stubDeps),
      recovery: { escalateStrandedAssignedIssue: async () => {}, escalateStrandedRecoveryIssueInPlace: async () => {} },
    })({ companyId, runId, now: new Date() });
  }

  it("promotes the reviewer's wake past an older wake of the worker that handed the issue over", async () => {
    const companyId = await seedCompany();
    const workerId = await seedAgent(companyId, "Worker");
    const reviewerId = await seedAgent(companyId, "Reviewer");
    const issueId = await seedIssueInReview({ companyId, workerId, reviewerId });
    const runId = await seedFinishedRun(companyId, workerId, issueId);
    // A blocker finished while the worker was still running, so its wake was deferred first.
    const staleWakeId = await seedDeferredWake({
      companyId, agentId: workerId, issueId, reason: "issue_execution_promoted",
      requestedAt: new Date(Date.now() - 60_000),
      payload: { mutation: "blocker_done" },
      context: { wakeReason: "issue_blockers_resolved", source: "issue.blockers_resolved" },
    });
    const reviewWakeId = await seedDeferredWake({
      companyId, agentId: reviewerId, issueId, reason: "issue_execution_deferred",
      requestedAt: new Date(Date.now() - 1_000),
      payload: { mutation: "update" },
      context: { wakeReason: "execution_review_requested", source: "issue.execution_stage" },
    });

    const result = await release(companyId, runId);

    expect(result.outcome.kind).toBe("promoted");
    const [staleWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, staleWakeId));
    expect(staleWake).toMatchObject({ status: "cancelled", runId: null });
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const promoted = runs.find((candidate) => candidate.agentId === reviewerId);
    expect(promoted).toMatchObject({ status: "queued" });
    expect(runs.filter((candidate) => candidate.agentId === workerId)).toHaveLength(1);
    const [reviewWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, reviewWakeId));
    expect(reviewWake).toMatchObject({ status: "queued", runId: promoted!.id });
  });

  it.each([
    ["a mention", { wakeReason: "issue_comment_mentioned", source: "comment.mention", wakeCommentId: randomUUID() }],
    ["a source-scoped recovery", { wakeReason: "source_scoped_recovery_action", recoveryActionId: randomUUID() }],
  ])("keeps %s wake of a non-owner in its place", async (_name, context) => {
    const companyId = await seedCompany();
    const workerId = await seedAgent(companyId, "Worker");
    const reviewerId = await seedAgent(companyId, "Reviewer");
    const otherId = await seedAgent(companyId, "Other");
    const issueId = await seedIssueInReview({ companyId, workerId, reviewerId });
    const runId = await seedFinishedRun(companyId, workerId, issueId);
    const bypassWakeId = await seedDeferredWake({
      companyId, agentId: otherId, issueId, reason: "issue_execution_deferred",
      requestedAt: new Date(Date.now() - 60_000), context,
    });

    const result = await release(companyId, runId);

    expect(result.outcome.kind).toBe("promoted");
    const [bypassWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, bypassWakeId));
    expect(bypassWake.status).toBe("queued");
  });
});
