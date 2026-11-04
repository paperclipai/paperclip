import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Review handoff retry test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child(this: unknown) {
      return this;
    }),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
  httpLogger: vi.fn(),
}));

import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { recoveryService } from "../services/recovery/service.js";
import {
  REVIEW_HANDOFF_NO_RECEIPT_REASON,
  REVIEW_HANDOFF_REFUSED_REASON,
  buildReviewHandoffRetryIdempotencyKey,
  reconcileReviewHandoffAfterBlockerClear,
} from "../services/recovery/review-handoff-retry.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres review handoff retry tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("review handoff retry routes and refusal sweeps", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-handoff-retry-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    await db.delete(environmentLeases);
    await db.delete(issueRelations);
    await db.delete(issueRecoveryActions);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(agentTaskSessions);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    await db?.$client?.end?.();
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const reviewerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const issueId = randomUUID();
    const stageId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Test Co",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: reviewerAgentId,
        companyId,
        name: "ReviewerAgent",
        role: "reviewer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: workerAgentId,
        companyId,
        name: "WorkerAgent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Feature ready for review",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: workerAgentId,
      assigneeUserId: null,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: workerAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        changesRequestedCount: 0,
      },
    });

    return {
      companyId,
      reviewerAgentId,
      workerAgentId,
      issueId,
      stageId,
    };
  }

  it("retries the handoff once the previous run releases its environment lease", async () => {
    const { companyId, issueId, reviewerAgentId, workerAgentId, stageId } = await seedFixture();
    const heartbeat = heartbeatService(db);
    const workerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: workerRunId,
      companyId,
      agentId: workerAgentId,
      invocationSource: "assignment",
      status: "cancelled",
      runtimeMode: "legacy",
      contextSnapshot: { issueId },
      resultJson: { conversationContinuation: "continue_conversation_v1" },
      finishedAt: new Date(),
    });
    const leaseId = randomUUID();
    await db.insert(environmentLeases).values({
      id: leaseId,
      companyId,
      issueId,
      heartbeatRunId: workerRunId,
      status: "active",
    });

    const held = await heartbeat.reconcileStrandedAssignedIssues();
    expect(held.reviewParticipantRequeued).toBe(0);
    expect(
      await db
        .select()
        .from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, reviewerAgentId))),
    ).toHaveLength(0);

    await db
      .update(environmentLeases)
      .set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" })
      .where(eq(environmentLeases.id, leaseId));

    const released = await heartbeat.reconcileStrandedAssignedIssues();
    expect(released.reviewParticipantRequeued).toBe(1);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, reviewerAgentId)));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.idempotencyKey).toBe(buildReviewHandoffRetryIdempotencyKey({ issueId, stageId, attempt: 1 }));
    await heartbeat.drainActiveRunExecutions();
  });

  it("reconciles the owed handoff before the recovery-action resolve response returns", async () => {
    const { companyId, issueId, reviewerAgentId, stageId, workerAgentId } = await seedFixture();
    const heartbeat = heartbeatService(db);
    const actionId = randomUUID();
    await db.insert(issueRecoveryActions).values({
      id: actionId,
      companyId,
      sourceIssueId: issueId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "board",
      returnOwnerAgentId: workerAgentId,
      cause: "uncertain_provider_action",
      fingerprint: `stale-blocker:${issueId}`,
      evidence: {},
      nextAction: "Confirm whether the provider action completed.",
      attemptCount: 1,
    });

    expect(
      (await reconcileReviewHandoffAfterBlockerClear(db, {
        issueId,
        companyId,
        enqueueWakeup: (agentId, request) => heartbeat.wakeup(agentId, request),
      })).action,
    ).toBe("skipped");

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "local_implicit",
        userId: "responsible-user",
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "operator" }],
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use(errorHandler);

    const res = await request(app)
      .post(`/api/issues/${issueId}/recovery-actions/resolve`)
      .send({ actionId, outcome: "restored", sourceIssueStatus: "in_review" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, reviewerAgentId),
        ),
      );
    expect(wakes).toHaveLength(1);
    expect(wakes[0].idempotencyKey).toBe(
      buildReviewHandoffRetryIdempotencyKey({ issueId, stageId, attempt: 1 }),
    );

    await heartbeat.drainActiveRunExecutions();
  });

  it("counts a refused wake as a consumed attempt and escalates instead of retrying forever", async () => {
    const { companyId, issueId, reviewerAgentId, stageId } = await seedFixture();
    await db
      .update(agents)
      .set({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } })
      .where(eq(agents.id, reviewerAgentId));
    const heartbeat = heartbeatService(db);

    const results = [];
    for (let pass = 0; pass < 4; pass += 1) {
      results.push(
        await reconcileReviewHandoffAfterBlockerClear(db, {
          issueId,
          companyId,
          enqueueWakeup: (agentId, req) => heartbeat.wakeup(agentId, req),
        }),
      );
    }

    expect(results.slice(0, 3)).toEqual([
      { action: "skipped", reason: REVIEW_HANDOFF_NO_RECEIPT_REASON },
      { action: "skipped", reason: REVIEW_HANDOFF_NO_RECEIPT_REASON },
      { action: "skipped", reason: REVIEW_HANDOFF_NO_RECEIPT_REASON },
    ]);

    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(wakes.every((wake) => wake.status === "skipped")).toBe(true);
    expect(
      wakes
        .map((wake) => wake.idempotencyKey)
        .filter((key) => key?.startsWith("review-handoff:"))
        .sort(),
    ).toEqual(
      [1, 2, 3].map((attempt) =>
        buildReviewHandoffRetryIdempotencyKey({ issueId, stageId, attempt }),
      ),
    );
    expect(
      wakes.filter((wake) => !wake.idempotencyKey?.startsWith("review-handoff:")),
    ).toHaveLength(1);

    expect(results[3].action).toBe("exhausted");
    const recoveryActions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.companyId, companyId));
    expect(recoveryActions).toHaveLength(1);
    expect(recoveryActions[0]).toMatchObject({
      cause: "execution_recovery_budget_exhausted",
      ownerType: "board",
      attemptCount: 3,
      maxAttempts: 3,
    });
    await heartbeat.drainActiveRunExecutions();
  });

  it("counts an execution-wait receipt that keeps this attempt's key", async () => {
    const { companyId, issueId, stageId } = await seedFixture();

    const savedAsExecutionWait: Parameters<
      typeof reconcileReviewHandoffAfterBlockerClear
    >[1]["enqueueWakeup"] = async (agentId, request) => {
      await db.insert(agentWakeupRequests).values({
        id: randomUUID(),
        companyId,
        agentId,
        source: "automation",
        reason: request.reason,
        status: "skipped",
        idempotencyKey: request.idempotencyKey ?? null,
        payload: {
          ...(request.payload ?? {}),
          executionWait: { reason: "issue_execution_disabled" },
        },
        finishedAt: new Date(),
      });
      return null;
    };

    const first = await reconcileReviewHandoffAfterBlockerClear(db, {
      issueId,
      companyId,
      enqueueWakeup: savedAsExecutionWait,
    });
    expect(first).toEqual({ action: "skipped", reason: REVIEW_HANDOFF_REFUSED_REASON });

    const second = await reconcileReviewHandoffAfterBlockerClear(db, {
      issueId,
      companyId,
      enqueueWakeup: savedAsExecutionWait,
    });
    expect(second).toEqual({ action: "skipped", reason: REVIEW_HANDOFF_REFUSED_REASON });

    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect([...wakes.map((wake) => wake.idempotencyKey)].sort()).toEqual(
      [1, 2].map((attempt) =>
        buildReviewHandoffRetryIdempotencyKey({ issueId, stageId, attempt }),
      ),
    );
  });

  it("records the consumed attempt when the wake persisted no receipt under this key", async () => {
    const { companyId, issueId, reviewerAgentId, stageId } = await seedFixture();

    const coalescedElsewhere: Parameters<
      typeof reconcileReviewHandoffAfterBlockerClear
    >[1]["enqueueWakeup"] = async (agentId) => {
      await db.insert(agentWakeupRequests).values({
        id: randomUUID(),
        companyId,
        agentId,
        source: "automation",
        status: "skipped",
        idempotencyKey: `execution-wait:${issueId}`,
        payload: { issueId },
        finishedAt: new Date(),
      });
      return null;
    };

    const first = await reconcileReviewHandoffAfterBlockerClear(db, {
      issueId,
      companyId,
      enqueueWakeup: coalescedElsewhere,
    });
    expect(first).toEqual({
      action: "skipped",
      reason: REVIEW_HANDOFF_NO_RECEIPT_REASON,
    });

    const second = await reconcileReviewHandoffAfterBlockerClear(db, {
      issueId,
      companyId,
      enqueueWakeup: coalescedElsewhere,
    });
    expect(second).toEqual({
      action: "skipped",
      reason: REVIEW_HANDOFF_NO_RECEIPT_REASON,
    });

    const recorded = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, reviewerAgentId),
        ),
      );
    expect(
      recorded
        .map((wake) => wake.idempotencyKey)
        .filter((key) => key?.startsWith("review-handoff:"))
        .sort(),
    ).toEqual(
      [1, 2].map((attempt) =>
        buildReviewHandoffRetryIdempotencyKey({ issueId, stageId, attempt }),
      ),
    );
    expect(recorded.every((wake) => wake.status === "skipped")).toBe(true);
  });

  it("skips a hidden issue", async () => {
    const { companyId, issueId, reviewerAgentId } = await seedFixture();
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, issueId));
    const heartbeat = heartbeatService(db);

    const result = await reconcileReviewHandoffAfterBlockerClear(db, {
      issueId,
      companyId,
      enqueueWakeup: (agentId, req) => heartbeat.wakeup(agentId, req),
    });

    expect(result).toEqual({ action: "skipped", reason: "issue not in_review" });
    expect(
      await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.agentId, reviewerAgentId),
          ),
        ),
    ).toHaveLength(0);
    await heartbeat.drainActiveRunExecutions();
  });

  it("contains one issue's handoff failure and finishes the stranded sweep", async () => {
    const failing = await seedFixture();
    const healthy = await seedFixture();
    const wakeFailure = new Error("wake target rejected the handoff");

    const recovery = recoveryService(db, {
      enqueueWakeup: async (agentId, opts) => {
        if (agentId === failing.reviewerAgentId) throw wakeFailure;
        const [row] = await db
          .insert(agentWakeupRequests)
          .values({
            id: randomUUID(),
            companyId: healthy.companyId,
            agentId,
            source: "automation",
            reason: opts?.reason ?? null,
            status: "queued",
            idempotencyKey: opts?.idempotencyKey ?? null,
            payload: opts?.payload ?? null,
          })
          .returning();
        return row as never;
      },
    });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.reviewParticipantRequeued).toBe(1);
    expect(result.issueIds).toContain(healthy.issueId);
    expect(result.issueIds).not.toContain(failing.issueId);
    expect(
      await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, healthy.companyId)),
    ).toHaveLength(1);
    const failedCompanyWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, failing.companyId));
    expect(failedCompanyWakes).toHaveLength(1);
    expect(failedCompanyWakes[0].status).toBe("skipped");
  });

  it("consumes an attempt when the wake target rejects the handoff and escalates in the end", async () => {
    const { companyId, issueId, reviewerAgentId, stageId } = await seedFixture();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, reviewerAgentId));
    const heartbeat = heartbeatService(db);

    const rejections: string[] = [];
    for (let pass = 0; pass < 3; pass += 1) {
      await reconcileReviewHandoffAfterBlockerClear(db, {
        issueId,
        companyId,
        enqueueWakeup: (agentId, req) => heartbeat.wakeup(agentId, req),
      }).then(
        () => {
          throw new Error("expected the rejected wake to propagate");
        },
        (error: Error) => {
          rejections.push(error.message);
        },
      );
    }
    expect(rejections).toHaveLength(3);

    const recorded = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(
      recorded
        .map((wake) => wake.idempotencyKey)
        .filter((key) => key?.startsWith("review-handoff:"))
        .sort(),
    ).toEqual(
      [1, 2, 3].map((attempt) =>
        buildReviewHandoffRetryIdempotencyKey({ issueId, stageId, attempt }),
      ),
    );

    const exhausted = await reconcileReviewHandoffAfterBlockerClear(db, {
      issueId,
      companyId,
      enqueueWakeup: (agentId, req) => heartbeat.wakeup(agentId, req),
    });
    expect(exhausted.action).toBe("exhausted");
    const recoveryActions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.companyId, companyId));
    expect(recoveryActions).toHaveLength(1);
    expect(recoveryActions[0]).toMatchObject({
      cause: "execution_recovery_budget_exhausted",
      ownerType: "board",
      attemptCount: 3,
      maxAttempts: 3,
    });
    await heartbeat.drainActiveRunExecutions();
  });

  it("propagates the rejection when the consumed attempt cannot be recorded", async () => {
    const { companyId, issueId, reviewerAgentId } = await seedFixture();
    await db.delete(agents).where(eq(agents.id, reviewerAgentId));
    const heartbeat = heartbeatService(db);

    await expect(
      reconcileReviewHandoffAfterBlockerClear(db, {
        issueId,
        companyId,
        enqueueWakeup: (agentId, req) => heartbeat.wakeup(agentId, req),
      }),
    ).rejects.toThrow("Agent not found");

    expect(
      await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId)),
    ).toHaveLength(0);
    await heartbeat.drainActiveRunExecutions();
  });

  it("reconciles every in_review dependent of a cleared blocker even when one fails", async () => {
    const companyId = randomUUID();
    const workerAgentId = randomUUID();
    const blockerIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const [firstDependent, secondDependent] = [randomUUID(), randomUUID()].sort();
    const reviewerByIssue = new Map<string, string>([
      [firstDependent, randomUUID()],
      [secondDependent, randomUUID()],
    ]);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Test Co",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values(
      [workerAgentId, ...reviewerByIssue.values()].map((id) => ({
        id,
        companyId,
        name: `Agent ${id.slice(0, 8)}`,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })),
    );
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Blocker issue",
      status: "done",
      priority: "high",
      assigneeAgentId: workerAgentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    let issueNumber = 2;
    for (const [dependentId, reviewerId] of reviewerByIssue) {
      const stageId = randomUUID();
      await db.insert(issues).values({
        id: dependentId,
        companyId,
        title: `Dependent ${issueNumber}`,
        status: "in_review",
        priority: "medium",
        assigneeAgentId: workerAgentId,
        responsibleUserId: "responsible-user",
        issueNumber,
        identifier: `${issuePrefix}-${issueNumber}`,
        executionState: {
          status: "pending",
          currentStageId: stageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerId, userId: null },
          returnAssignee: { type: "agent", agentId: workerAgentId, userId: null },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          changesRequestedCount: 0,
        },
      });
      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerIssueId,
        relatedIssueId: dependentId,
        type: "blocks",
      });
      issueNumber += 1;
    }

    const failingReviewerId = reviewerByIssue.get(firstDependent)!;
    const healthyReviewerId = reviewerByIssue.get(secondDependent)!;
    const recovery = recoveryService(db, {
      enqueueWakeup: async (agentId, opts) => {
        if (agentId === failingReviewerId) throw new Error("wake target rejected the handoff");
        const [row] = await db
          .insert(agentWakeupRequests)
          .values({
            id: randomUUID(),
            companyId,
            agentId,
            source: "automation",
            reason: opts?.reason ?? null,
            status: "queued",
            idempotencyKey: opts?.idempotencyKey ?? null,
            payload: opts?.payload ?? null,
          })
          .returning();
        return row as never;
      },
    });

    await recovery.reconcileResolvedDependencyWakeBackstop({ companyId, blockerIssueId });

    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    const healthyWakes = wakes.filter((wake) => wake.agentId === healthyReviewerId);
    expect(healthyWakes).toHaveLength(1);
    expect(healthyWakes[0].status).toBe("queued");
    expect(healthyWakes[0].idempotencyKey).toContain(`review-handoff:${secondDependent}:`);
    const failingWakes = wakes.filter((wake) => wake.agentId === failingReviewerId);
    expect(failingWakes).toHaveLength(1);
    expect(failingWakes[0].status).toBe("skipped");
  });
});
