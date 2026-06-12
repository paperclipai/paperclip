import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS,
  CAPACITY_BLOCKED_HEARTBEAT_RETRY_MAX_ATTEMPTS,
  heartbeatService,
  shouldScheduleAutomaticRunRetry,
} from "../services/heartbeat.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: "Adapter failed",
    errorCode: "adapter_failed",
    summary: "failed",
    resultJson: {} as Record<string, unknown>,
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat retry scheduling tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat bounded retry scheduling", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-retry-scheduling-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  });

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Adapter failed",
      errorCode: "adapter_failed",
      summary: "failed",
      resultJson: {},
      provider: "test",
      model: "test-model",
    }));
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRetryFixture(input: {
    runId: string;
    companyId: string;
    agentId: string;
    now: Date;
    errorCode: string;
    errorFamily?: "transient_upstream" | null;
    retryNotBefore?: string | null;
    scheduledRetryAttempt?: number;
    resultJson?: Record<string, unknown> | null;
    adapterType?: "codex_local" | "claude_local";
    agentName?: string;
  }) {
    const adapterType = input.adapterType ?? "codex_local";
    const agentName = input.agentName ?? (adapterType === "claude_local" ? "ClaudeCoder" : "CodexCoder");
    await db.insert(companies).values({
      id: input.companyId,
      name: "Paperclip",
      issuePrefix: `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: input.agentId,
      companyId: input.companyId,
      name: agentName,
      role: "engineer",
      status: "active",
      adapterType,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "upstream overload",
      errorCode: input.errorCode,
      finishedAt: input.now,
      scheduledRetryAttempt: input.scheduledRetryAttempt ?? 0,
      scheduledRetryReason: input.scheduledRetryAttempt ? "transient_failure" : null,
      resultJson: input.resultJson ?? {
        ...(input.errorFamily ? { errorFamily: input.errorFamily } : {}),
        ...(input.retryNotBefore
          ? {
              retryNotBefore: input.retryNotBefore,
              transientRetryNotBefore: input.retryNotBefore,
            }
          : {}),
      },
      contextSnapshot: {
        issueId: randomUUID(),
        wakeReason: "issue_assigned",
      },
      updatedAt: input.now,
      createdAt: input.now,
    });
  }

  async function seedQueuedRunFixture(input: {
    companyId: string;
    agentId: string;
    runId: string;
    now: Date;
    contextSnapshot?: Record<string, unknown>;
  }) {
    await db.insert(companies).values({
      id: input.companyId,
      name: "Paperclip",
      issuePrefix: `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: input.agentId,
      companyId: input.companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: "queued",
      triggerDetail: "github_pr_review_requested",
      contextSnapshot: input.contextSnapshot ?? {},
      updatedAt: input.now,
      createdAt: input.now,
    });

    const issueId = typeof input.contextSnapshot?.issueId === "string" ? input.contextSnapshot.issueId : null;
    if (issueId) {
      await db.insert(issues).values({
        id: issueId,
        companyId: input.companyId,
        title: "Queued run retry fixture",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: input.agentId,
        executionRunId: input.runId,
        executionAgentNameKey: "codexcoder",
        executionLockedAt: input.now,
        issueNumber: 1,
        identifier: `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-1`,
      });
    }
  }

  async function getScheduledTransientRetryForRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, runId))
      .then((rows) => rows.find((row) => row.scheduledRetryReason === "transient_failure") ?? null);
  }

  async function expectPlainPrReviewFailureSchedulesRetry(errorCode: "adapter_failed" | "process_lost") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-05-25T08:00:00.000Z");

    await seedQueuedRunFixture({
      companyId,
      agentId,
      runId: sourceRunId,
      now,
      contextSnapshot: {
        issueId: randomUUID(),
        wakeReason: "github_pr_review_requested",
        reviewKind: "pr_review",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 7457,
      },
    });
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: errorCode === "process_lost" ? "Process lost" : "Adapter failed",
      errorCode,
      summary: "failed",
      resultJson: {},
      provider: "test",
      model: "test-model",
    });

    await heartbeat.__test_executeRunForTesting(sourceRunId);

    const sourceRun = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, sourceRunId))
      .then((rows) => rows[0] ?? null);
    expect(sourceRun).toMatchObject({
      status: "failed",
      errorCode,
    });
    expect(sourceRun?.contextSnapshot as Record<string, unknown>).toMatchObject({
      reviewKind: "pr_review",
    });

    const retryRun = await getScheduledTransientRetryForRun(sourceRunId);
    expect(retryRun).toMatchObject({
      status: "scheduled_retry",
      retryOfRunId: sourceRunId,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
    });
    expect(retryRun?.contextSnapshot as Record<string, unknown>).toMatchObject({
      wakeReason: "transient_failure_retry",
      retryReason: "transient_failure",
      reviewKind: "pr_review",
      githubPrNumber: 7457,
    });
  }

  it("schedules a bounded retry for PR-review adapter_failed without adapter recovery metadata", async () => {
    await expectPlainPrReviewFailureSchedulesRetry("adapter_failed");
  });

  it("schedules a bounded retry for PR-review process_lost without adapter recovery metadata", async () => {
    await expectPlainPrReviewFailureSchedulesRetry("process_lost");
  });

  it("does not schedule a bounded retry for non-PR adapter_failed without adapter recovery metadata", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-05-25T08:05:00.000Z");

    await seedQueuedRunFixture({
      companyId,
      agentId,
      runId: sourceRunId,
      now,
      contextSnapshot: {
        issueId: randomUUID(),
        wakeReason: "issue_assigned",
      },
    });

    await heartbeat.__test_executeRunForTesting(sourceRunId);

    expect(await getScheduledTransientRetryForRun(sourceRunId)).toBeNull();
  });

  it("schedules a retry with durable metadata and only promotes it when due", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T12:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        issueId: randomUUID(),
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const expectedDueAt = new Date(now.getTime() + BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS[0]);
    expect(scheduled.attempt).toBe(1);
    expect(scheduled.dueAt.toISOString()).toBe(expectedDueAt.toISOString());

    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun).toMatchObject({
      status: "scheduled_retry",
      retryOfRunId: sourceRunId,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
    });
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");
    expect(retryRun?.scheduledRetryAt?.toISOString()).toBe(expectedDueAt.toISOString());

    const earlyPromotion = await heartbeat.promoteDueScheduledRetries(new Date("2026-04-20T12:01:59.000Z"));
    expect(earlyPromotion).toEqual({ promoted: 0, runIds: [] });

    const stillScheduled = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(stillScheduled?.status).toBe("scheduled_retry");

    const duePromotion = await heartbeat.promoteDueScheduledRetries(expectedDueAt);
    expect(duePromotion).toEqual({ promoted: 1, runIds: [scheduled.run.id] });

    const promotedRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(promotedRun?.status).toBe("queued");
  });

  it("treats idempotent GitHub PR-review adapter failures as retry-eligible", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "adapter_failed",
        resultJson: {},
        contextSnapshot: {
          wakeReason: "github_pr_opened",
          reviewKind: "pr_review",
          githubPrNumber: 976,
        },
      }),
    ).toBe(true);

    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "process_lost",
        resultJson: {},
        contextSnapshot: {
          wakeReason: "github_pr_review_submitted",
          reviewKind: "pr_review",
          githubPrNumber: 976,
        },
      }),
    ).toBe(true);
  });

  it("BLO-8215: retries a pr_review_auth_expired run, including a taskKey-only persisted snapshot", () => {
    // The persisted run snapshot is trimmed to taskKey (no reviewKind /
    // githubPrNumber), so the gate must use the taskKey-aware pr-review check.
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "pr_review_auth_expired",
        resultJson: {},
        contextSnapshot: { taskKey: "pr_review:Blockcast/paperclip:230" },
      }),
    ).toBe(true);

    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "pr_review_auth_expired",
        resultJson: {},
        contextSnapshot: { wakeReason: "github_pr_review_submitted", reviewKind: "pr_review", githubPrNumber: 230 },
      }),
    ).toBe(true);
  });

  it("BLO-8215: does not retry a pr_review_auth_expired code outside a PR-review context", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "pr_review_auth_expired",
        resultJson: {},
        contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      }),
    ).toBe(false);
  });

  it("does not retry plain adapter failures when the wake is not an idempotent PR review", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "adapter_failed",
        resultJson: {},
        contextSnapshot: {
          issueId: randomUUID(),
          wakeReason: "issue_assigned",
        },
      }),
    ).toBe(false);

    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "process_lost",
        resultJson: {},
        contextSnapshot: {
          issueId: randomUUID(),
          wakeReason: "issue_assigned",
        },
      }),
    ).toBe(false);
  });

  // BLO-9147 AC1 — thin-snapshot adapter_failed retry gate
  it("BLO-9147 AC1: retries adapter_failed on pr_review run with thin snapshot (no githubPrNumber)", () => {
    // The persisted contextSnapshot only carries reviewKind (no githubPrNumber).
    // derivePaperclipPrReview would return null; isPrReviewRetryContext must match.
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "adapter_failed",
        resultJson: {},
        contextSnapshot: { wakeReason: "github_pr_opened", reviewKind: "pr_review" },
      }),
    ).toBe(true);

    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "process_lost",
        resultJson: {},
        contextSnapshot: { reviewKind: "pr_review" },
      }),
    ).toBe(true);

    // taskKey-only snapshot (trimmed to 3 keys, BLO-7457 form)
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "adapter_failed",
        resultJson: {},
        contextSnapshot: { taskKey: "pr_review:Blockcast/ally:888" },
      }),
    ).toBe(true);
  });

  it("BLO-9147 AC1: does not retry adapter_failed on non-PR wakes even with thin snapshot", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "adapter_failed",
        resultJson: {},
        contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      }),
    ).toBe(false);

    // taskKey that does not start with "pr_review:"
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "adapter_failed",
        resultJson: {},
        contextSnapshot: { taskKey: "issue:somecompany:123" },
      }),
    ).toBe(false);
  });

  // BLO-9147 AC2 — k8s_concurrent_run_blocked retry gate
  it("BLO-9147 AC2: retries k8s_concurrent_run_blocked on pr_review wake", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "k8s_concurrent_run_blocked",
        resultJson: {},
        contextSnapshot: { wakeReason: "github_pr_opened", reviewKind: "pr_review", githubPrNumber: 42 },
      }),
    ).toBe(true);

    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "k8s_concurrent_run_blocked",
        resultJson: {},
        contextSnapshot: { reviewKind: "pr_review" },
      }),
    ).toBe(true);

    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "k8s_concurrent_run_blocked",
        resultJson: {},
        contextSnapshot: { taskKey: "pr_review:Blockcast/ally:100" },
      }),
    ).toBe(true);
  });

  it("BLO-9147 AC2: does NOT retry k8s_concurrent_run_blocked on non-PR wakes (BLO-7913 guard)", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "k8s_concurrent_run_blocked",
        resultJson: {},
        contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      }),
    ).toBe(false);

    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "k8s_concurrent_run_blocked",
        resultJson: {},
        contextSnapshot: {},
      }),
    ).toBe(false);
  });

  it("BLO-9147 AC2: CAPACITY_BLOCKED_HEARTBEAT_RETRY_MAX_ATTEMPTS exceeds rate-limit cap (12)", () => {
    expect(CAPACITY_BLOCKED_HEARTBEAT_RETRY_MAX_ATTEMPTS).toBeGreaterThan(12);
  });

  it("does not defer a new assignee behind the previous assignee's scheduled retry", async () => {
    const companyId = randomUUID();
    const oldAgentId = randomUUID();
    const newAgentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T13:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: oldAgentId,
        companyId,
        name: "ClaudeCoder",
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
      {
        id: newAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: oldAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry reassignment",
      status: "todo",
      priority: "medium",
      assigneeAgentId: oldAgentId,
      executionRunId: sourceRunId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-1`,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    await db.update(issues).set({
      assigneeAgentId: newAgentId,
      updatedAt: now,
    }).where(eq(issues.id, issueId));

    // Keep the new agent's queue from auto-claiming/executing during this unit test.
    await db.insert(heartbeatRuns).values(
      Array.from({ length: 5 }, () => ({
        id: randomUUID(),
        companyId,
        agentId: newAgentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: {
          wakeReason: "test_busy_slot",
        },
        startedAt: now,
        updatedAt: now,
        createdAt: now,
      })),
    );

    const newAssigneeRun = await heartbeat.wakeup(newAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {
        issueId,
        mutation: "update",
      },
      contextSnapshot: {
        issueId,
        source: "issue.update",
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(newAssigneeRun).not.toBeNull();
    expect(newAssigneeRun?.agentId).toBe(newAgentId);
    expect(newAssigneeRun?.status).toBe("queued");

    const oldRetry = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(oldRetry).toEqual({
      status: "cancelled",
      errorCode: "issue_reassigned",
    });

    const deferredWakeups = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.status, "deferred_issue_execution"))
      .then((rows) => rows[0]?.count ?? 0);
    expect(deferredWakeups).toBe(0);
  });

  it("does not promote a scheduled retry after issue ownership changes", async () => {
    const companyId = randomUUID();
    const oldAgentId = randomUUID();
    const newAgentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T14:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: oldAgentId,
        companyId,
        name: "ClaudeCoder",
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
      {
        id: newAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: oldAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry promotion reassignment",
      status: "todo",
      priority: "medium",
      assigneeAgentId: oldAgentId,
      executionRunId: sourceRunId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-2`,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    await db.update(issues).set({
      assigneeAgentId: newAgentId,
      updatedAt: now,
    }).where(eq(issues.id, issueId));

    const promotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
    expect(promotion).toEqual({ promoted: 0, runIds: [] });

    const oldRetry = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(oldRetry).toEqual({
      status: "cancelled",
      errorCode: "issue_reassigned",
    });

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
  });

  it("does not promote a scheduled retry after the issue is handed to a human owner", async () => {
    const companyId = randomUUID();
    const oldAgentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T14:30:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: oldAgentId,
      companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: oldAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry human handoff",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: oldAgentId,
      executionRunId: sourceRunId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-3`,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    await db.update(issues).set({
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      updatedAt: now,
    }).where(eq(issues.id, issueId));

    const promotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
    expect(promotion).toEqual({ promoted: 0, runIds: [] });

    const oldRetry = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(oldRetry).toEqual({
      status: "cancelled",
      errorCode: "issue_reassigned",
    });

    const issue = await db
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toMatchObject({
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      executionRunId: null,
    });
  });

  it("does not promote a scheduled retry after the issue is cancelled", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T15:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry promotion cancellation",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: sourceRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-3`,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    await db.update(issues).set({
      status: "cancelled",
      updatedAt: now,
    }).where(eq(issues.id, issueId));

    const promotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
    expect(promotion).toEqual({ promoted: 0, runIds: [] });

    const oldRetry = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(oldRetry).toEqual({
      status: "cancelled",
      errorCode: "issue_cancelled",
    });

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
  });

  it("exhausts bounded retries after the hard cap", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const cappedRunId = randomUUID();
    const now = new Date("2026-04-20T18:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: cappedRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "failed",
      error: "still transient",
      errorCode: "adapter_failed",
      finishedAt: now,
      scheduledRetryAttempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: {
        wakeReason: "transient_failure_retry",
      },
      updatedAt: now,
      createdAt: now,
    });

    const exhausted = await heartbeat.scheduleBoundedRetry(cappedRunId, {
      now,
      random: () => 0.5,
    });

    expect(exhausted).toEqual({
      outcome: "retry_exhausted",
      attempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length + 1,
      maxAttempts: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
    });

    const runCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .then((rows) => rows[0]?.count ?? 0);
    expect(runCount).toBe(1);

    const exhaustionEvent = await db
      .select({
        message: heartbeatRunEvents.message,
        payload: heartbeatRunEvents.payload,
      })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, cappedRunId))
      .orderBy(sql`${heartbeatRunEvents.id} desc`)
      .then((rows) => rows[0] ?? null);

    expect(exhaustionEvent?.message).toContain("Bounded retry exhausted");
    expect(exhaustionEvent?.payload).toMatchObject({
      retryReason: "transient_failure",
      scheduledRetryAttempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
      maxAttempts: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
    });
  });

  it("advances codex transient fallback stages across bounded retry attempts", async () => {
    const fallbackModes = [
      "same_session",
      "safer_invocation",
      "fresh_session",
      "fresh_session_safer_invocation",
    ] as const;

    for (const [index, expectedMode] of fallbackModes.entries()) {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      const now = new Date(`2026-04-20T1${index}:00:00.000Z`);

      await seedRetryFixture({
        runId,
        companyId,
        agentId,
        now,
        errorCode: "adapter_failed",
        errorFamily: "transient_upstream",
        scheduledRetryAttempt: index,
      });

      const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
        now,
        random: () => 0.5,
      });

      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") continue;

      const retryRun = await db
        .select({
          contextSnapshot: heartbeatRuns.contextSnapshot,
          wakeupRequestId: heartbeatRuns.wakeupRequestId,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, scheduled.run.id))
        .then((rows) => rows[0] ?? null);
      expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.codexTransientFallbackMode).toBe(expectedMode);

      const wakeupRequest = await db
        .select({ payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
        .then((rows) => rows[0] ?? null);
      expect((wakeupRequest?.payload as Record<string, unknown> | null)?.codexTransientFallbackMode).toBe(expectedMode);

      await db.delete(heartbeatRunEvents);
      await db.delete(heartbeatRuns);
      await db.delete(agentWakeupRequests);
      await db.delete(agents);
      await db.delete(companies);
    }
  });

  it("honors codex retry-not-before timestamps when they exceed the default bounded backoff", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date(2026, 3, 22, 22, 29, 0);
    const retryNotBefore = new Date(2026, 3, 22, 23, 31, 0);

    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      retryNotBefore: retryNotBefore.toISOString(),
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.dueAt.getTime()).toBe(retryNotBefore.getTime());

    const retryRun = await db
      .select({
        contextSnapshot: heartbeatRuns.contextSnapshot,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun?.scheduledRetryAt?.getTime()).toBe(retryNotBefore.getTime());
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.transientRetryNotBefore).toBe(
      retryNotBefore.toISOString(),
    );

    const wakeupRequest = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);

    expect((wakeupRequest?.payload as Record<string, unknown> | null)?.transientRetryNotBefore).toBe(
      retryNotBefore.toISOString(),
    );
  });

  it("schedules bounded retries for claude_transient_upstream and honors its retry-not-before hint", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date(2026, 3, 22, 10, 0, 0);
    const retryNotBefore = new Date(2026, 3, 22, 16, 0, 0);

    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      adapterType: "claude_local",
      retryNotBefore: retryNotBefore.toISOString(),
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.dueAt.getTime()).toBe(retryNotBefore.getTime());

    const retryRun = await db
      .select({
        contextSnapshot: heartbeatRuns.contextSnapshot,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun?.scheduledRetryAt?.getTime()).toBe(retryNotBefore.getTime());
    const contextSnapshot = (retryRun?.contextSnapshot as Record<string, unknown> | null) ?? {};
    expect(contextSnapshot.transientRetryNotBefore).toBe(retryNotBefore.toISOString());
    // Claude does not participate in the Codex fallback-mode ladder.
    expect(contextSnapshot.codexTransientFallbackMode ?? null).toBeNull();

    const wakeupRequest = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);

    expect((wakeupRequest?.payload as Record<string, unknown> | null)?.transientRetryNotBefore).toBe(
      retryNotBefore.toISOString(),
    );
  });
});
