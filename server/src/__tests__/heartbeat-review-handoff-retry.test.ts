import { randomUUID } from "node:crypto";
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
    child: vi.fn(function child() {
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

import { heartbeatService } from "../services/heartbeat.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import {
  REVIEW_HANDOFF_COALESCED_REASON,
  buildReviewHandoffRetryIdempotencyKey,
  isReviewHandoffRetryIdempotencyConflict,
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

describeEmbeddedPostgres("review handoff retry after stale blocker clears", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-handoff-retry-");
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

  async function seedFixture(options?: { withBlocker?: boolean }) {
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

    let blockerIssueId: string | null = null;
    if (options?.withBlocker) {
      blockerIssueId = randomUUID();
      await db.insert(issues).values({
        id: blockerIssueId,
        companyId,
        title: "Blocker issue",
        status: "todo",
        priority: "high",
        assigneeAgentId: workerAgentId,
        responsibleUserId: "responsible-user",
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      });

      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerIssueId,
        relatedIssueId: issueId,
        type: "blocks",
      });
    }

    return {
      companyId,
      reviewerAgentId,
      workerAgentId,
      issueId,
      stageId,
      blockerIssueId,
    };
  }

  it("skips review handoff while a valid blocker exists", async () => {
    const { companyId, reviewerAgentId } = await seedFixture({ withBlocker: true });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.reviewParticipantRequeued).toBe(0);

    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, reviewerAgentId),
        ),
      );
    expect(wakes).toHaveLength(0);
    await heartbeat.drainActiveRunExecutions();
  });

  it("starts or schedules exactly one handoff after a stale dependency blocker clears", async () => {
    const { companyId, issueId, reviewerAgentId, stageId, blockerIssueId } = await seedFixture({
      withBlocker: true,
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.reconcileStrandedAssignedIssues();
    let wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, reviewerAgentId),
        ),
      );
    expect(wakes).toHaveLength(0);

    await db
      .update(issues)
      .set({ status: "done" })
      .where(eq(issues.id, blockerIssueId!));

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.reviewParticipantRequeued).toBe(1);
    expect(result.issueIds).toContain(issueId);

    wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, reviewerAgentId),
        ),
      );
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      agentId: reviewerAgentId,
      reason: "execution_review_requested",
      idempotencyKey: buildReviewHandoffRetryIdempotencyKey({ issueId, stageId, attempt: 1 }),
    });
    expect(wakes[0].payload).toMatchObject({
      issueId,
      reviewHandoffAttempt: 1,
      executionStage: {
        stageId,
        wakeRole: "reviewer",
      },
    });

    await heartbeat.drainActiveRunExecutions();
    const [completedRun] = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, reviewerAgentId),
          eq(heartbeatRuns.wakeupRequestId, wakes[0].id),
        ),
      );
    expect(completedRun).toBeDefined();
    expect(completedRun.status).toBe("succeeded");
  });

  it("rejects a second durable retry for the same issue, stage and attempt", async () => {
    const { companyId, issueId, reviewerAgentId, stageId } = await seedFixture();
    const idempotencyKey = buildReviewHandoffRetryIdempotencyKey({
      issueId,
      stageId,
      attempt: 1,
    });

    const insertWake = (status: string) =>
      db.insert(agentWakeupRequests).values({
        id: randomUUID(),
        companyId,
        agentId: reviewerAgentId,
        source: "automation",
        status,
        idempotencyKey,
        payload: { issueId, reviewHandoffAttempt: 1 },
      });

    await insertWake("queued");

    const conflict = await insertWake("queued").then(
      () => null,
      (error: unknown) => error,
    );
    expect(conflict).not.toBeNull();
    expect(isReviewHandoffRetryIdempotencyConflict(conflict)).toBe(true);

    await insertWake("skipped");

    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId: reviewerAgentId,
      source: "automation",
      status: "queued",
      idempotencyKey: buildReviewHandoffRetryIdempotencyKey({ issueId, stageId, attempt: 2 }),
      payload: { issueId, reviewHandoffAttempt: 2 },
    });

    const rows = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(rows).toHaveLength(3);
  });

  it("coalesces concurrent triggers into one durable retry", async () => {
    const { companyId, issueId, reviewerAgentId, stageId } = await seedFixture();
    const heartbeat = heartbeatService(db);

    const persistWake: Parameters<typeof reconcileReviewHandoffAfterBlockerClear>[1]["enqueueWakeup"] =
      async (agentId, request) => {
        const [row] = await db
          .insert(agentWakeupRequests)
          .values({
            id: randomUUID(),
            companyId,
            agentId,
            source: "automation",
            reason: request.reason,
            status: "queued",
            idempotencyKey: request.idempotencyKey ?? null,
            payload: request.payload ?? null,
          })
          .returning({ id: agentWakeupRequests.id });
        return row ?? null;
      };

    const results = await Promise.all([
      reconcileReviewHandoffAfterBlockerClear(db, { issueId, companyId, enqueueWakeup: persistWake }),
      reconcileReviewHandoffAfterBlockerClear(db, { issueId, companyId, enqueueWakeup: persistWake }),
      reconcileReviewHandoffAfterBlockerClear(db, { issueId, companyId, enqueueWakeup: persistWake }),
    ]);

    expect(results.filter((result) => result.action === "enqueued")).toHaveLength(1);

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

  it("reports a lost enqueue race as a coalesced skip", async () => {
    const { companyId, issueId, reviewerAgentId, stageId } = await seedFixture();

    const result = await reconcileReviewHandoffAfterBlockerClear(db, {
      issueId,
      companyId,
      enqueueWakeup: async (agentId, request) => {
        const values = {
          companyId,
          agentId,
          source: "automation" as const,
          status: "queued",
          idempotencyKey: request.idempotencyKey ?? null,
          payload: request.payload ?? null,
        };
        await db.insert(agentWakeupRequests).values({ id: randomUUID(), ...values });
        await db.insert(agentWakeupRequests).values({ id: randomUUID(), ...values });
        return null;
      },
    });

    expect(result).toEqual({
      action: "skipped",
      reason: REVIEW_HANDOFF_COALESCED_REASON,
    });

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
  });

  it("continues the durable retry ledger on a restarted instance", async () => {
    const { companyId, issueId, reviewerAgentId, stageId } = await seedFixture();

    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId: reviewerAgentId,
      source: "automation",
      reason: "execution_review_requested",
      status: "queued",
      idempotencyKey: buildReviewHandoffRetryIdempotencyKey({ issueId, stageId, attempt: 1 }),
      payload: { issueId, reviewHandoffAttempt: 1 },
    });

    const restarted = heartbeatService(db);
    const stillQueued = await restarted.reconcileStrandedAssignedIssues();
    expect(stillQueued.reviewParticipantRequeued).toBe(0);
    expect(
      await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId)),
    ).toHaveLength(1);

    await db
      .update(agentWakeupRequests)
      .set({ status: "completed", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.companyId, companyId));

    const resumed = await restarted.reconcileStrandedAssignedIssues();
    expect(resumed.reviewParticipantRequeued).toBe(1);
    expect(resumed.issueIds).toContain(issueId);

    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId))
      .orderBy(agentWakeupRequests.requestedAt);
    expect(wakes).toHaveLength(2);
    expect(wakes[1].idempotencyKey).toBe(
      buildReviewHandoffRetryIdempotencyKey({ issueId, stageId, attempt: 2 }),
    );
    expect(wakes[1].payload).toMatchObject({ issueId, reviewHandoffAttempt: 2 });

    await restarted.drainActiveRunExecutions();
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, reviewerAgentId),
          eq(heartbeatRuns.wakeupRequestId, wakes[1].id),
        ),
      );
    expect(run).toBeDefined();
    expect(run.status).toBe("succeeded");
    expect(run.contextSnapshot).toMatchObject({
      issueId,
      currentStageId: stageId,
      wakeReason: "execution_review_requested",
    });
  });

  it("escalates to board with one actionable blocker upon exhausting the review handoff budget", async () => {
    const { companyId, issueId, reviewerAgentId, stageId } = await seedFixture();
    const heartbeat = heartbeatService(db);

    for (const attempt of [1, 2, 3]) {
      await db.insert(agentWakeupRequests).values({
        id: randomUUID(),
        companyId,
        agentId: reviewerAgentId,
        source: "automation",
        status: "completed",
        idempotencyKey: buildReviewHandoffRetryIdempotencyKey({ issueId, stageId, attempt }),
        payload: { issueId, reviewHandoffAttempt: attempt },
      });
    }

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toContain(issueId);

    const recoveryActions = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
        ),
      );
    expect(recoveryActions).toHaveLength(1);
    expect(recoveryActions[0]).toMatchObject({
      kind: "stranded_assigned_issue",
      cause: "execution_recovery_budget_exhausted",
      status: "active",
      ownerType: "board",
      ownerAgentId: null,
      returnOwnerAgentId: reviewerAgentId,
      fingerprint: `review-handoff:${issueId}:${stageId}`,
      attemptCount: 3,
      maxAttempts: 3,
      wakePolicy: null,
      monitorPolicy: null,
    });

    const blocker = await getExecutionBlocker(db, companyId, issueId);
    expect(blocker).toMatchObject({
      cause: "execution_recovery_budget_exhausted",
      recoveryActionId: recoveryActions[0].id,
    });

    const nextResult = await heartbeat.reconcileStrandedAssignedIssues();
    expect(nextResult.reviewParticipantRequeued).toBe(0);
    expect(
      await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.companyId, companyId)),
    ).toHaveLength(1);
    await heartbeat.drainActiveRunExecutions();
  });

  it("starts a fresh retry budget after the board closes the exhaustion escalation", async () => {
    const { companyId, issueId, reviewerAgentId, stageId } = await seedFixture();
    const seedAttempts = async (attempts: number[]) => {
      for (const attempt of attempts) {
        await db.insert(agentWakeupRequests).values({
          id: randomUUID(),
          companyId,
          agentId: reviewerAgentId,
          source: "automation",
          status: "completed",
          idempotencyKey: buildReviewHandoffRetryIdempotencyKey({ issueId, stageId, attempt }),
          payload: { issueId, reviewHandoffAttempt: attempt },
        });
      }
    };
    const enqueued: Array<string | null | undefined> = [];
    const reconcile = () =>
      reconcileReviewHandoffAfterBlockerClear(db, {
        issueId,
        companyId,
        enqueueWakeup: async (agentId, opts) => {
          enqueued.push(opts.idempotencyKey);
          const [row] = await db
            .insert(agentWakeupRequests)
            .values({
              id: randomUUID(),
              companyId,
              agentId,
              source: "automation",
              reason: opts.reason,
              status: "completed",
              idempotencyKey: opts.idempotencyKey ?? null,
              payload: opts.payload ?? null,
            })
            .returning();
          return row as never;
        },
      });

    await seedAttempts([1, 2, 3]);
    const first = await reconcile();
    expect(first.action).toBe("exhausted");

    await db
      .update(issueRecoveryActions)
      .set({ status: "resolved", outcome: "resolved", resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(issueRecoveryActions.id, first.recoveryActionId!));

    const retried = await reconcile();
    expect(retried.action).toBe("enqueued");
    expect(enqueued).toEqual([buildReviewHandoffRetryIdempotencyKey({ issueId, stageId, attempt: 4 })]);

    await seedAttempts([5, 6]);
    const again = await reconcile();
    expect(again.action).toBe("exhausted");
    const activeActions = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.status, "active")));
    expect(activeActions).toHaveLength(1);
    expect(activeActions[0]!.id).not.toBe(first.recoveryActionId);
  });
});
